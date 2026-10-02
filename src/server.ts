import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { initDb, pool, toConcern } from "./db.js";
import { startBrowserWork, getBrowserWork } from "./browser.js";
import { decideNextWork } from "./founder.js";
import { getTokenMarket } from "./market.js";
import { getAsset } from "./solana.js";

const app = express();
app.use(cors());
app.use(express.json());

type MemoryConcern = {
  id: string;
  name: string;
  ticker: string;
  category: string;
  summary: string;
  status: "working" | "waiting";
  currentTask: string;
  creatorRewardsUsd: number;
  operatingBalanceUsd: number;
  externalRevenueUsd: number;
  marketCapUsd: number;
  day: number;
  notes: { id: string; text: string; createdAt: string }[];
};

const memoryConcerns = new Map<string, MemoryConcern>();
memoryConcerns.set("mesa", {
  id: "mesa",
  name: "MESA",
  ticker: "MESA",
  category: "restaurant software",
  summary: "finding a better inventory workflow for small restaurants",
  status: "working",
  currentTask: "research inventory problems for independent restaurants",
  creatorRewardsUsd: 0,
  operatingBalanceUsd: 0,
  externalRevenueUsd: 0,
  marketCapUsd: 0,
  day: 1,
  notes: []
});

app.get("/health", async (_req, res) => {
  if (!pool) {
    return res.json({
      ok: true,
      service: "gc-engine",
      database: "memory",
      time: new Date().toISOString()
    });
  }
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "gc-engine", database: "ok", time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, service: "gc-engine", database: "unavailable" });
  }
});

app.get("/concerns", async (_req, res) => {
  if (!pool) return res.json({ concerns: Array.from(memoryConcerns.values()) });
  const result = await pool.query("SELECT * FROM concerns ORDER BY created_at DESC");
  res.json({ concerns: result.rows.map((row) => toConcern(row)) });
});

app.get("/concerns/:id", async (req, res) => {
  if (!pool) {
    const concern = memoryConcerns.get(req.params.id);
    if (!concern) return res.status(404).json({ error: "concern_not_found" });
    return res.json({ concern });
  }

  const concernResult = await pool.query("SELECT * FROM concerns WHERE id = $1", [req.params.id]);
  if (!concernResult.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const notesResult = await pool.query(
    "SELECT * FROM notes WHERE concern_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json({ concern: toConcern(concernResult.rows[0], notesResult.rows) });
});

const createConcernSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(64),
  ticker: z.string().min(1).max(12),
  category: z.string().min(1).max(120),
  summary: z.string().min(1).max(280)
});

app.post("/concerns", async (req, res) => {
  const parsed = createConcernSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_concern", details: parsed.error.flatten() });

  if (!pool) {
    if (memoryConcerns.has(parsed.data.id)) return res.status(409).json({ error: "concern_exists" });
    const concern: MemoryConcern = {
      ...parsed.data,
      ticker: parsed.data.ticker.toUpperCase(),
      status: "waiting",
      currentTask: "decide where to begin",
      creatorRewardsUsd: 0,
      operatingBalanceUsd: 0,
      externalRevenueUsd: 0,
      marketCapUsd: 0,
      day: 1,
      notes: []
    };
    memoryConcerns.set(concern.id, concern);
    return res.status(201).json({ concern });
  }

  try {
    const result = await pool.query(
      `INSERT INTO concerns (id, name, ticker, category, summary)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [parsed.data.id, parsed.data.name, parsed.data.ticker.toUpperCase(), parsed.data.category, parsed.data.summary]
    );

    await pool.query(
      `INSERT INTO events (id, concern_id, type, summary)
       VALUES ($1, $2, 'concern_created', $3)`,
      [crypto.randomUUID(), parsed.data.id, `${parsed.data.name} started`]
    );

    res.status(201).json({ concern: toConcern(result.rows[0]) });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ error: "concern_exists" });
    throw error;
  }
});

const noteSchema = z.object({ text: z.string().min(1).max(4000) });

app.post("/concerns/:id/notes", async (req, res) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_note" });

  if (!pool) {
    const concern = memoryConcerns.get(req.params.id);
    if (!concern) return res.status(404).json({ error: "concern_not_found" });
    const note = { id: crypto.randomUUID(), text: parsed.data.text, createdAt: new Date().toISOString() };
    concern.notes.unshift(note);
    return res.status(201).json({ note });
  }

  const concern = await pool.query("SELECT id FROM concerns WHERE id = $1", [req.params.id]);
  if (!concern.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO notes (id, concern_id, text)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [id, req.params.id, parsed.data.text]
  );

  await pool.query(
    `INSERT INTO events (id, concern_id, type, summary, metadata)
     VALUES ($1, $2, 'note_received', 'new note left on the desk', $3::jsonb)`,
    [crypto.randomUUID(), req.params.id, JSON.stringify({ noteId: id })]
  );

  res.status(201).json({
    note: {
      id: result.rows[0].id,
      text: result.rows[0].text,
      createdAt: result.rows[0].created_at
    }
  });
});

app.post("/concerns/:id/run", async (req, res) => {
  const concernId = req.params.id;
  let company: any;

  if (!pool) {
    company = memoryConcerns.get(concernId);
  } else {
    const concernResult = await pool.query("SELECT * FROM concerns WHERE id = $1", [concernId]);
    if (concernResult.rowCount) {
      const notesResult = await pool.query(
        "SELECT * FROM notes WHERE concern_id = $1 ORDER BY created_at DESC LIMIT 25",
        [concernId]
      );
      company = toConcern(concernResult.rows[0], notesResult.rows);
    }
  }

  if (!company) return res.status(404).json({ error: "concern_not_found" });

  try {
    const decision = await decideNextWork(company);

    if (!pool) {
      const item = memoryConcerns.get(concernId)!;
      item.currentTask = decision.currentTask || item.currentTask;
      item.status = "working";
    } else {
      await pool.query(
        "UPDATE concerns SET current_task = $1, status = 'working', updated_at = NOW() WHERE id = $2",
        [decision.currentTask || company.currentTask, concernId]
      );
      await pool.query(
        `INSERT INTO events (id, concern_id, type, summary, metadata)
         VALUES ($1, $2, 'founder_decision', $3, $4::jsonb)`,
        [
          crypto.randomUUID(),
          concernId,
          decision.nextAction || decision.currentTask || "founder chose next work",
          JSON.stringify(decision)
        ]
      );
    }

    let browserWork: any = null;

    if (decision.needsBrowser && process.env.BROWSERBASE_API_KEY) {
      const browserTask = [
        `You are the research desk for ${company.name}, a company in ${company.category}.`,
        `Current objective: ${decision.currentTask}.`,
        `Specific next action: ${decision.nextAction}.`,
        "Research this on the public web. Prefer primary sources and real user evidence.",
        "Return concise findings with source URLs and one practical suggested next step.",
        "Do not purchase anything, sign contracts, or submit sensitive personal information."
      ].join("\n");

      browserWork = await startBrowserWork(browserTask);

      if (pool) {
        await pool.query(
          `INSERT INTO browser_runs
           (run_id, concern_id, session_id, status, task, live_view_url)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (run_id) DO UPDATE
           SET session_id = EXCLUDED.session_id,
               status = EXCLUDED.status,
               live_view_url = EXCLUDED.live_view_url,
               updated_at = NOW()`,
          [
            browserWork.runId,
            concernId,
            browserWork.sessionId || null,
            browserWork.status,
            browserWork.task,
            browserWork.liveViewUrl || null
          ]
        );
      }
    }

    res.json({ run: decision, browserWork });
  } catch (error: any) {
    console.error(error);
    res.status(502).json({ error: "founder_run_failed", detail: String(error?.message || error).slice(0, 1000) });
  }
});

app.get("/concerns/:id/live", async (req, res) => {
  if (!pool) return res.json({ live: null });

  const latest = await pool.query(
    "SELECT * FROM browser_runs WHERE concern_id = $1 ORDER BY created_at DESC LIMIT 1",
    [req.params.id]
  );

  if (!latest.rowCount) return res.json({ live: null });

  const stored = latest.rows[0];

  try {
    const live = await getBrowserWork(stored.run_id);

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
        live.sessionId || null,
        live.status,
        live.liveViewUrl || stored.live_view_url || null,
        JSON.stringify(live.result ?? null),
        JSON.stringify(live.cause ?? null),
        stored.run_id
      ]
    );

    if (live.status === "COMPLETED" && live.result) {
      await pool.query(
        `INSERT INTO events (id, concern_id, type, summary, metadata)
         SELECT $1, $2, 'browser_completed', $3, $4::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM events
           WHERE concern_id = $2
             AND type = 'browser_completed'
             AND metadata->>'runId' = $5
         )`,
        [
          crypto.randomUUID(),
          req.params.id,
          "research desk finished its work",
          JSON.stringify({ runId: live.runId, result: live.result }),
          live.runId
        ]
      );
    }

    res.json({ live });
  } catch (error: any) {
    res.json({
      live: {
        runId: stored.run_id,
        sessionId: stored.session_id,
        status: stored.status,
        liveViewUrl: stored.live_view_url,
        task: stored.task,
        result: stored.result,
        cause: stored.cause
      },
      refreshError: String(error?.message || error)
    });
  }
});

app.get("/concerns/:id/browser-runs", async (req, res) => {
  if (!pool) return res.json({ runs: [] });
  const result = await pool.query(
    "SELECT * FROM browser_runs WHERE concern_id = $1 ORDER BY created_at DESC LIMIT 50",
    [req.params.id]
  );
  res.json({ runs: result.rows });
});

app.patch("/concerns/:id/token", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });

  const parsed = z.object({ mintAddress: z.string().min(32).max(64) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_mint" });

  const updated = await pool.query(
    "UPDATE concerns SET mint_address = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [parsed.data.mintAddress, req.params.id]
  );

  if (!updated.rowCount) return res.status(404).json({ error: "concern_not_found" });

  res.json({ concern: toConcern(updated.rows[0]) });
});

app.get("/concerns/:id/market", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });

  const result = await pool.query("SELECT mint_address FROM concerns WHERE id = $1", [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const mint = result.rows[0].mint_address;
  if (!mint) return res.json({ market: null });

  try {
    const market = await getTokenMarket(mint);
    if (market.marketCap !== null) {
      await pool.query(
        "UPDATE concerns SET market_cap_usd = $1, updated_at = NOW() WHERE id = $2",
        [market.marketCap, req.params.id]
      );
    }
    res.json({ market });
  } catch (error: any) {
    res.status(502).json({ error: "market_data_failed", detail: String(error?.message || error) });
  }
});

app.get("/concerns/:id/token-metadata", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });

  const result = await pool.query("SELECT mint_address FROM concerns WHERE id = $1", [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const mint = result.rows[0].mint_address;
  if (!mint) return res.json({ asset: null });

  try {
    const asset = await getAsset(mint);
    res.json({ asset });
  } catch (error: any) {
    res.status(502).json({ error: "solana_data_failed", detail: String(error?.message || error) });
  }
});

app.get("/concerns/:id/events", async (req, res) => {
  if (!pool) return res.json({ events: [] });
  const result = await pool.query(
    "SELECT * FROM events WHERE concern_id = $1 ORDER BY created_at DESC LIMIT 100",
    [req.params.id]
  );
  res.json({ events: result.rows });
});

app.get("/concerns/:id/files", async (req, res) => {
  if (!pool) return res.json({ files: [] });
  const result = await pool.query(
    "SELECT * FROM files WHERE concern_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json({ files: result.rows });
});

app.get("/concerns/:id/ledger", async (req, res) => {
  if (!pool) return res.json({ entries: [] });
  const result = await pool.query(
    "SELECT * FROM ledger_entries WHERE concern_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json({ entries: result.rows });
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT || 3000);

initDb()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`gc-engine listening on :${port}`);
    });
  })
  .catch((error) => {
    console.error("database initialization failed", error);
    process.exit(1);
  });
