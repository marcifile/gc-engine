import type { Pool } from "pg";

export function startFounderScheduler(pool: Pool, port: number, intervalMs = 60_000) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const showcaseConcern = process.env.GC_SHOWCASE_CONCERN || null;
      const eligible = await pool.query(
        `SELECT c.id
         FROM concerns c
         WHERE c.auto_work = TRUE
           AND c.launch_state = 'launched'
           AND (c.mint_address IS NOT NULL OR c.id = $1)
           AND (c.operating_balance_usd >= c.min_work_balance_usd OR c.id = $1)
           AND (
             c.last_work_at IS NULL
             OR (c.id = $1 AND c.last_work_at < NOW() - INTERVAL '2 minutes')
             OR (c.id <> $1 AND c.last_work_at < NOW() - INTERVAL '10 minutes')
           )
           AND NOT EXISTS (
             SELECT 1 FROM browser_runs br
             WHERE br.concern_id = c.id
               AND br.status IN ('PENDING', 'RUNNING', 'PAUSED')
           )
         ORDER BY c.last_work_at ASC NULLS FIRST
         LIMIT 3`,
        [showcaseConcern]
      );

      for (const row of eligible.rows) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${port}/concerns/${encodeURIComponent(row.id)}/run`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-GC-Automation": "founder-scheduler"
              },
              body: "{}"
            }
          );

          if (!response.ok) {
            console.error("founder scheduler run failed", row.id, response.status, (await response.text()).slice(0, 500));
          }
        } catch (error) {
          console.error("founder scheduler request failed", row.id, error);
        }
      }
    } catch (error) {
      console.error("founder scheduler tick failed", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
