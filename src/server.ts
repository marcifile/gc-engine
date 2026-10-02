import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json());

type Concern = {
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

const concerns = new Map<string, Concern>();

concerns.set("mesa", {
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gc-engine", time: new Date().toISOString() });
});

app.get("/concerns", (_req, res) => {
  res.json({ concerns: Array.from(concerns.values()) });
});

app.get("/concerns/:id", (req, res) => {
  const concern = concerns.get(req.params.id);
  if (!concern) return res.status(404).json({ error: "concern_not_found" });
  res.json({ concern });
});

const createConcernSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(64),
  ticker: z.string().min(1).max(12),
  category: z.string().min(1).max(120),
  summary: z.string().min(1).max(280)
});

app.post("/concerns", (req, res) => {
  const parsed = createConcernSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_concern", details: parsed.error.flatten() });
  if (concerns.has(parsed.data.id)) return res.status(409).json({ error: "concern_exists" });

  const concern: Concern = {
    ...parsed.data,
    status: "waiting",
    currentTask: "decide where to begin",
    creatorRewardsUsd: 0,
    operatingBalanceUsd: 0,
    externalRevenueUsd: 0,
    marketCapUsd: 0,
    day: 1,
    notes: []
  };
  concerns.set(concern.id, concern);
  res.status(201).json({ concern });
});

const noteSchema = z.object({ text: z.string().min(1).max(4000) });

app.post("/concerns/:id/notes", (req, res) => {
  const concern = concerns.get(req.params.id);
  if (!concern) return res.status(404).json({ error: "concern_not_found" });

  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_note" });

  const note = {
    id: crypto.randomUUID(),
    text: parsed.data.text,
    createdAt: new Date().toISOString()
  };
  concern.notes.unshift(note);
  res.status(201).json({ note });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`gc-engine listening on :${port}`);
});
