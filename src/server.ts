import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { initDb, pool, toConcern } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "gc-engine", database: "ok", time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, service: "gc-engine", database: "unavailable" });
  }
});

app.get("/concerns", async (_req, res) => {
  const result = await pool.query("SELECT * FROM concerns ORDER BY created_at DESC");
  res.json({ concerns: result.rows.map((row) => toConcern(row)) });
});

app.get("/concerns/:id", async (req, res) => {
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

app.get("/concerns/:id/events", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM events WHERE concern_id = $1 ORDER BY created_at DESC LIMIT 100",
    [req.params.id]
  );
  res.json({ events: result.rows });
});

app.get("/concerns/:id/files", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM files WHERE concern_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json({ files: result.rows });
});

app.get("/concerns/:id/ledger", async (req, res) => {
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
