import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { getBrowserWork } from "./browser.js";

export async function refreshBrowserRun(pool: Pool, stored: any) {
  const live = await getBrowserWork(stored.run_id, stored.session_id || undefined);

  await pool.query(
    `UPDATE browser_runs
     SET session_id = $1,
         status = $2,
         live_view_url = $3,
         result = $4::jsonb,
         cause = $5::jsonb,
         updated_at = NOW()
     WHERE run_id = $6`,
    [
      live.sessionId || stored.session_id || null,
      live.status,
      live.liveViewUrl || stored.live_view_url || null,
      JSON.stringify(live.result ?? null),
      JSON.stringify(live.cause ?? null),
      stored.run_id
    ]
  );

  if (live.status === "COMPLETED" && live.result) {
    const completionEvent = await pool.query(
      `INSERT INTO events (id, concern_id, type, summary, metadata)
       SELECT $1, $2, 'browser_completed', $3, $4::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM events
         WHERE concern_id = $2
           AND type = 'browser_completed'
           AND metadata->>'runId' = $5
       )
       RETURNING id`,
      [
        randomUUID(),
        stored.concern_id,
        "research desk finished its work",
        JSON.stringify({ runId: live.runId, result: live.result }),
        live.runId
      ]
    );

    if (completionEvent.rowCount) {
      const result: any = live.result;
      const findings = Array.isArray(result?.findings) ? result.findings : [];
      const lines = [
        `# Research — ${new Date().toISOString().slice(0, 10)}`,
        "",
        result?.summary ? String(result.summary) : "Research session completed.",
        "",
        "## Findings",
        ...findings.flatMap((f: any) => [
          "",
          `### ${String(f?.title || "Finding")}`,
          f?.url ? String(f.url) : "",
          String(f?.note || "")
        ]),
        "",
        "## Suggested next step",
        String(result?.suggestedNextStep || "Review the findings and choose the next piece of work."),
        ""
      ];

      const filePath = `research/run-${live.runId}.md`;
      await pool.query(
        `INSERT INTO files (id, concern_id, path, mime_type, created_by, content, source_url)
         VALUES ($1, $2, $3, 'text/markdown', 'research desk', $4, $5)
         ON CONFLICT (concern_id, path)
         DO UPDATE SET content = EXCLUDED.content, source_url = EXCLUDED.source_url`,
        [
          randomUUID(),
          stored.concern_id,
          filePath,
          lines.join("\n"),
          findings[0]?.url || null
        ]
      );

      if (result?.summary) {
        await pool.query(
          `INSERT INTO memories (id, concern_id, kind, content, importance)
           VALUES ($1, $2, 'research', $3, 7)`,
          [randomUUID(), stored.concern_id, String(result.summary).slice(0, 8000)]
        );
      }

      await pool.query(
        `INSERT INTO tasks (id, concern_id, title, status, desk, priority, result_summary, completed_at)
         VALUES ($1, $2, $3, 'completed', 'research', 5, $4, NOW())`,
        [
          randomUUID(),
          stored.concern_id,
          String(stored.task || "research").slice(0, 500),
          String(result?.summary || "research completed").slice(0, 4000)
        ]
      );

      await pool.query(
        `UPDATE concerns
         SET current_task = $1,
             status = 'waiting',
             updated_at = NOW()
         WHERE id = $2`,
        [
          String(result?.suggestedNextStep || "review research and choose the next task").slice(0, 1000),
          stored.concern_id
        ]
      );
    }
  }

  return live;
}

export function startBrowserPoller(pool: Pool, intervalMs = 15000) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await pool.query(
        `SELECT * FROM browser_runs
         WHERE status IN ('PENDING', 'RUNNING', 'PAUSED')
         ORDER BY updated_at ASC
         LIMIT 10`
      );

      for (const row of result.rows) {
        try {
          await refreshBrowserRun(pool, row);
        } catch (error) {
          console.error("browser poll failed", row.run_id, error);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
