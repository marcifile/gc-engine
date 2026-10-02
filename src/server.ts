import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { initDb, pool, toConcern } from "./db.js";

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
  const concern = !pool
    ? memoryConcerns.get(concernId)
    : (await pool.query("SELECT * FROM concerns WHERE id = $1", [concernId])).rows[0];

  if (!concern) return res.status(404).json({ error: "concern_not_found" });
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "openrouter_not_configured" });
  }

  const company = !pool ? concern : toConcern(concern);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://gc-engine-production.up.railway.app",
      "X-Title": "GC"
    },
    body: JSON.stringify({
      model: process.env.FOUNDER_MODEL || "anthropic/claude-sonnet-4",
      messages: [
        {
          role: "system",
          content:
            "You are the persistent founder of a small company inside GC. Be practical, specific, and useful. Decide the single best next piece of work. Return strict JSON with keys currentTask, desk, reasoning, nextAction."
        },
        {
          role: "user",
          content: JSON.stringify(company)
        }
      ],
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    return res.status(502).json({ error: "founder_model_failed", detail: body.slice(0, 500) });
  }

  const data: any = await response.json();
  const raw = data?.choices?.[0]?.message?.content || "{}";
  let result: any;
  try {
    result = JSON.parse(raw);
  } catch {
    result = { currentTask: company.currentTask, desk: "founder", reasoning: raw, nextAction: raw };
  }

  if (!pool) {
    const item = memoryConcerns.get(concernId)!;
    item.currentTask = result.currentTask || item.currentTask;
    item.status = "working";
  } else {
    await pool.query(
      "UPDATE concerns SET current_task = $1, status = 'working', updated_at = NOW() WHERE id = $2",
      [result.currentTask || company.currentTask, concernId]
    );
    await pool.query(
      `INSERT INTO events (id, concern_id, type, summary, metadata)
       VALUES ($1, $2, 'founder_decision', $3, $4::jsonb)`,
      [crypto.randomUUID(), concernId, result.nextAction || result.currentTask || "founder chose next work", JSON.stringify(result)]
    );
  }

  res.json({ run: result });
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
