import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { initDb, pool, toConcern } from "./db.js";
import { startBrowserWork, getBrowserWork } from "./browser.js";
import { decideNextWork, produceWorkArtifact } from "./founder.js";
import { getTokenMarket } from "./market.js";
import { getAsset, getSignatureStatus } from "./solana.js";
import { preparePumpCreate } from "./pump.js";
import { refreshBrowserRun, startBrowserPoller } from "./browserPoller.js";
import { uploadTokenMetadata } from "./pinata.js";
import { startFounderScheduler } from "./founderScheduler.js";
import { buildGoogleAuthUrl, createCalendarEvent, exchangeGoogleCode, googleConfigured, saveGoogleIntegration, sendGmail, uploadFileToDrive } from "./google.js";
import { queueOrExecuteExternalAction } from "./externalExecutor.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
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

app.get("/capabilities", (_req, res) => {
  res.json({
    capabilities: {
      founder: Boolean(process.env.OPENROUTER_API_KEY),
      browser: Boolean(process.env.BROWSERBASE_API_KEY),
      solana: Boolean(process.env.HELIUS_API_KEY),
      marketData: Boolean(process.env.BIRDEYE_API_KEY),
      database: Boolean(pool),
      files: true,
      calendar: true,
      outbox: true,
      googleDrive: googleConfigured(),
      gmail: googleConfigured(),
      googleCalendar: googleConfigured(),
      tokenLaunch: true,
      metadataStorage: Boolean(process.env.PINATA_JWT)
    }
  });
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
  ticker: z.string().min(1).max(12).optional(),
  category: z.string().min(1).max(120).optional(),
  summary: z.string().min(1).max(280).optional(),
  brief: z.string().min(1).max(1000).optional(),
  extra: z.string().max(4000).optional(),
  staffing: z.enum(["automatic", "manual"]).optional(),
  externalActions: z.enum(["automatic", "ask"]).optional(),
  initialBuySol: z.number().nonnegative().optional()
}).transform((data) => {
  const fallbackTicker = data.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "GC";
  const category = (data.category || data.brief || "new company").slice(0, 120);
  const summary = (data.summary || data.extra || data.brief || "a company finding where to begin").slice(0, 280);
  return {
    ...data,
    ticker: (data.ticker || fallbackTicker).replace(/^\$/, "").toUpperCase(),
    category,
    summary
  };
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
      `INSERT INTO concerns (id, name, ticker, category, summary, staffing_mode, external_actions_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        parsed.data.id,
        parsed.data.name,
        parsed.data.ticker.toUpperCase(),
        parsed.data.category,
        parsed.data.summary,
        parsed.data.staffing || "automatic",
        parsed.data.externalActions || "automatic"
      ]
    );

    await pool.query(
      `INSERT INTO events (id, concern_id, type, summary)
       VALUES ($1, $2, 'concern_created', $3)`,
      [randomUUID(), parsed.data.id, `${parsed.data.name} started`]
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
    const note = { id: randomUUID(), text: parsed.data.text, createdAt: new Date().toISOString() };
    concern.notes.unshift(note);
    return res.status(201).json({ note });
  }

  const concern = await pool.query("SELECT id FROM concerns WHERE id = $1", [req.params.id]);
  if (!concern.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO notes (id, concern_id, text)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [id, req.params.id, parsed.data.text]
  );

  await pool.query(
    `INSERT INTO events (id, concern_id, type, summary, metadata)
     VALUES ($1, $2, 'note_received', 'new note left on the desk', $3::jsonb)`,
    [randomUUID(), req.params.id, JSON.stringify({ noteId: id })]
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
      const [notesResult, memoriesResult, tasksResult, filesResult, integrationsResult] = await Promise.all([
        pool.query(
          "SELECT * FROM notes WHERE concern_id = $1 ORDER BY created_at DESC LIMIT 25",
          [concernId]
        ),
        pool.query(
          "SELECT kind, content, importance, created_at FROM memories WHERE concern_id = $1 ORDER BY importance DESC, created_at DESC LIMIT 30",
          [concernId]
        ),
        pool.query(
          "SELECT title, status, desk, result_summary, created_at, completed_at FROM tasks WHERE concern_id = $1 ORDER BY created_at DESC LIMIT 20",
          [concernId]
        ),
        pool.query(
          "SELECT id, path, mime_type, created_by, created_at FROM files WHERE concern_id = $1 ORDER BY created_at DESC LIMIT 30",
          [concernId]
        ),
        pool.query(
          "SELECT provider, scopes, updated_at FROM integrations WHERE concern_id = $1",
          [concernId]
        )
      ]);
      company = {
        ...toConcern(concernResult.rows[0], notesResult.rows),
        currentTime: new Date().toISOString(),
        memories: memoriesResult.rows,
        recentTasks: tasksResult.rows,
        recentFiles: filesResult.rows,
        connectedIntegrations: integrationsResult.rows.map((row) => ({
          provider: row.provider,
          scopes: row.scopes,
          updatedAt: row.updated_at
        }))
      };
    }
  }

  if (!company) return res.status(404).json({ error: "concern_not_found" });

  if (pool) {
    const active = await pool.query(
      `SELECT run_id FROM browser_runs
       WHERE concern_id = $1 AND status IN ('PENDING', 'RUNNING', 'PAUSED')
       LIMIT 1`,
      [concernId]
    );
    if (active.rowCount) {
      return res.status(409).json({ error: "work_already_running", runId: active.rows[0].run_id });
    }

    await pool.query(
      "UPDATE concerns SET last_work_at = NOW(), updated_at = NOW() WHERE id = $1",
      [concernId]
    );
  }

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
          randomUUID(),
          concernId,
          decision.nextAction || decision.currentTask || "founder chose next work",
          JSON.stringify(decision)
        ]
      );

      if (Number(decision.costUsd || 0) > 0) {
        const cost = Number(decision.costUsd);
        await pool.query(
          `INSERT INTO ledger_entries (id, concern_id, kind, amount_usd, description)
           VALUES ($1, $2, 'compute', $3, 'founder inference')`,
          [randomUUID(), concernId, -cost]
        );
        await pool.query(
          `UPDATE concerns
           SET operating_balance_usd = GREATEST(0, operating_balance_usd - $1),
               updated_at = NOW()
           WHERE id = $2`,
          [cost, concernId]
        );
      }
    }

    let browserWork: any = null;
    let artifact: any = null;

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
    } else if (
      pool &&
      (decision.needsFiles || ["writing", "numbers", "build", "operations"].includes(decision.desk))
    ) {
      artifact = await produceWorkArtifact(company, decision);

      await pool.query(
        `INSERT INTO files (id, concern_id, path, mime_type, created_by, content)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (concern_id, path)
         DO UPDATE SET mime_type = EXCLUDED.mime_type,
                       created_by = EXCLUDED.created_by,
                       content = EXCLUDED.content`,
        [
          randomUUID(),
          concernId,
          artifact.path,
          artifact.mimeType,
          `${decision.desk} desk`,
          artifact.content
        ]
      );

      await pool.query(
        `INSERT INTO tasks (id, concern_id, title, status, desk, priority, result_summary, completed_at)
         VALUES ($1, $2, $3, 'completed', $4, 5, $5, NOW())`,
        [
          randomUUID(),
          concernId,
          decision.currentTask.slice(0, 500),
          decision.desk,
          artifact.summary
        ]
      );

      await pool.query(
        `INSERT INTO memories (id, concern_id, kind, content, importance)
         VALUES ($1, $2, 'work', $3, 6)`,
        [randomUUID(), concernId, artifact.summary]
      );

      await pool.query(
        `INSERT INTO events (id, concern_id, type, summary, metadata)
         VALUES ($1, $2, 'file_created', $3, $4::jsonb)`,
        [
          randomUUID(),
          concernId,
          `${decision.desk} desk created ${artifact.path}`,
          JSON.stringify({ path: artifact.path, nextStep: artifact.nextStep })
        ]
      );

      if (Number(artifact.costUsd || 0) > 0) {
        const artifactCost = Number(artifact.costUsd);
        await pool.query(
          `INSERT INTO ledger_entries (id, concern_id, kind, amount_usd, description)
           VALUES ($1, $2, 'compute', $3, $4)`,
          [randomUUID(), concernId, -artifactCost, `${decision.desk} desk inference`]
        );
        await pool.query(
          `UPDATE concerns
           SET operating_balance_usd = GREATEST(0, operating_balance_usd - $1)
           WHERE id = $2`,
          [artifactCost, concernId]
        );
      }

      await pool.query(
        "UPDATE concerns SET current_task = $1, status = 'waiting', updated_at = NOW() WHERE id = $2",
        [artifact.nextStep, concernId]
      );
    }

    let externalAction: any = null;
    if (pool && decision.externalAction) {
      externalAction = await queueOrExecuteExternalAction(
        pool,
        concernId,
        company.externalActionsMode === "ask" ? "ask" : "automatic",
        decision.externalAction
      );
    }

    res.json({ run: decision, browserWork, artifact, externalAction });
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
    const live = await refreshBrowserRun(pool, stored);
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

app.post("/launch/metadata", upload.single("image"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  if (!process.env.PINATA_JWT) return res.status(503).json({ error: "metadata_storage_not_configured" });
  if (!req.file) return res.status(400).json({ error: "image_required" });

  const concernId = String(req.body?.concernId || "");
  if (!concernId) return res.status(400).json({ error: "concern_id_required" });

  const result = await pool.query("SELECT * FROM concerns WHERE id = $1", [concernId]);
  if (!result.rowCount) return res.status(404).json({ error: "concern_not_found" });
  const concern = result.rows[0];

  try {
    const uploaded = await uploadTokenMetadata({
      image: {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname || "token-image"
      },
      name: concern.name,
      symbol: concern.ticker,
      description: String(req.body?.description || concern.summary || "").slice(0, 1000),
      twitter: req.body?.twitter ? String(req.body.twitter) : undefined,
      telegram: req.body?.telegram ? String(req.body.telegram) : undefined,
      website: req.body?.website ? String(req.body.website) : undefined
    });

    await pool.query(
      `INSERT INTO events (id, concern_id, type, summary, metadata)
       VALUES ($1, $2, 'metadata_uploaded', 'token metadata uploaded to IPFS', $3::jsonb)`,
      [randomUUID(), concernId, JSON.stringify({ imageUri: uploaded.imageUri, metadataUri: uploaded.metadataUri })]
    );

    res.json({
      imageUri: uploaded.imageUri,
      metadataUri: uploaded.metadataUri
    });
  } catch (error: any) {
    console.error(error);
    res.status(502).json({ error: "metadata_upload_failed", detail: String(error?.message || error).slice(0, 1000) });
  }
});

const prepareLaunchSchema = z.object({
  concernId: z.string().min(1),
  publicKey: z.string().min(32).max(64),
  mint: z.string().min(32).max(64),
  metadataUri: z.string().url(),
  initialBuySol: z.number().min(0).max(100),
  slippage: z.number().min(0.1).max(100).optional(),
  priorityFee: z.number().min(0).max(1).optional()
});

app.post("/launch/prepare", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const parsed = prepareLaunchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_launch", details: parsed.error.flatten() });

  const concernResult = await pool.query("SELECT * FROM concerns WHERE id = $1", [parsed.data.concernId]);
  if (!concernResult.rowCount) return res.status(404).json({ error: "concern_not_found" });
  const concern = concernResult.rows[0];

  try {
    const txBytes = await preparePumpCreate({
      publicKey: parsed.data.publicKey,
      mint: parsed.data.mint,
      name: concern.name,
      symbol: concern.ticker,
      metadataUri: parsed.data.metadataUri,
      initialBuySol: parsed.data.initialBuySol,
      slippage: parsed.data.slippage,
      priorityFee: parsed.data.priorityFee
    });

    await pool.query(
      `INSERT INTO events (id, concern_id, type, summary, metadata)
       VALUES ($1, $2, 'launch_prepared', 'pump launch transaction prepared', $3::jsonb)`,
      [
        randomUUID(),
        parsed.data.concernId,
        JSON.stringify({ mint: parsed.data.mint, publicKey: parsed.data.publicKey, initialBuySol: parsed.data.initialBuySol })
      ]
    );

    res.json({
      transactionBase64: Buffer.from(txBytes).toString("base64"),
      mint: parsed.data.mint,
      concernId: parsed.data.concernId
    });
  } catch (error: any) {
    res.status(502).json({ error: "launch_prepare_failed", detail: String(error?.message || error).slice(0, 1000) });
  }
});

const confirmLaunchSchema = z.object({
  mintAddress: z.string().min(32).max(64),
  signature: z.string().min(32).max(128)
});

app.post("/concerns/:id/launch/confirm", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const parsed = confirmLaunchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_confirmation" });

  const concern = await pool.query("SELECT * FROM concerns WHERE id = $1", [req.params.id]);
  if (!concern.rowCount) return res.status(404).json({ error: "concern_not_found" });

  try {
    let chainStatus = await getSignatureStatus(parsed.data.signature);

    for (let i = 0; i < 8 && !chainStatus.confirmationStatus && !chainStatus.err; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      chainStatus = await getSignatureStatus(parsed.data.signature);
    }

    if (chainStatus.err) {
      return res.status(409).json({ error: "launch_transaction_failed", chainError: chainStatus.err });
    }

    if (!chainStatus.confirmationStatus) {
      return res.status(202).json({
        pending: true,
        signature: parsed.data.signature,
        mintAddress: parsed.data.mintAddress
      });
    }

    const updated = await pool.query(
      "UPDATE concerns SET mint_address = $1, status = 'working', updated_at = NOW() WHERE id = $2 RETURNING *",
      [parsed.data.mintAddress, req.params.id]
    );

    await pool.query(
      `INSERT INTO events (id, concern_id, type, summary, metadata)
       SELECT $1, $2, 'token_launched', $3, $4::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM events
         WHERE concern_id = $2
           AND type = 'token_launched'
           AND metadata->>'signature' = $5
       )`,
      [
        randomUUID(),
        req.params.id,
        `${updated.rows[0].ticker} launched on pump`,
        JSON.stringify({
          mintAddress: parsed.data.mintAddress,
          signature: parsed.data.signature,
          confirmationStatus: chainStatus.confirmationStatus
        }),
        parsed.data.signature
      ]
    );

    res.json({
      pending: false,
      concern: toConcern(updated.rows[0]),
      signature: parsed.data.signature,
      confirmationStatus: chainStatus.confirmationStatus
    });
  } catch (error: any) {
    console.error(error);
    res.status(502).json({ error: "launch_confirmation_failed", detail: String(error?.message || error).slice(0, 1000) });
  }
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

const autonomySchema = z.object({
  autoWork: z.boolean().optional(),
  minWorkBalanceUsd: z.number().min(0).max(10000).optional(),
  externalActionsMode: z.enum(["automatic", "ask"]).optional(),
  staffingMode: z.enum(["automatic", "manual"]).optional()
});

app.patch("/concerns/:id/autonomy", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const parsed = autonomySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_autonomy_settings" });

  const existing = await pool.query("SELECT * FROM concerns WHERE id = $1", [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const current = existing.rows[0];
  const updated = await pool.query(
    `UPDATE concerns
     SET auto_work = $1,
         min_work_balance_usd = $2,
         external_actions_mode = $3,
         staffing_mode = $4,
         updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [
      parsed.data.autoWork ?? current.auto_work,
      parsed.data.minWorkBalanceUsd ?? Number(current.min_work_balance_usd),
      parsed.data.externalActionsMode ?? current.external_actions_mode,
      parsed.data.staffingMode ?? current.staffing_mode,
      req.params.id
    ]
  );

  res.json({ concern: toConcern(updated.rows[0]) });
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
    "SELECT id, concern_id, path, mime_type, storage_url, source_url, created_by, created_at FROM files WHERE concern_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json({ files: result.rows });
});

app.get("/concerns/:id/files/:fileId", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const result = await pool.query(
    "SELECT * FROM files WHERE id = $1 AND concern_id = $2",
    [req.params.fileId, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "file_not_found" });
  res.json({ file: result.rows[0] });
});

app.get("/concerns/:id/integrations", async (req, res) => {
  if (!pool) return res.json({ integrations: {} });

  const result = await pool.query(
    "SELECT provider, scopes, expires_at, created_at, updated_at FROM integrations WHERE concern_id = $1",
    [req.params.id]
  );

  const integrations: Record<string, any> = {};
  for (const row of result.rows) {
    integrations[row.provider] = {
      connected: true,
      scopes: row.scopes || [],
      expiresAt: row.expires_at,
      updatedAt: row.updated_at
    };
  }

  res.json({
    integrations,
    available: {
      google: googleConfigured()
    }
  });
});

app.get("/integrations/google/start", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  if (!googleConfigured()) return res.status(503).json({ error: "google_not_configured" });

  const concernId = String(req.query.concernId || "");
  if (!concernId) return res.status(400).json({ error: "concern_id_required" });

  const concern = await pool.query("SELECT id FROM concerns WHERE id = $1", [concernId]);
  if (!concern.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const state = randomUUID();
  await pool.query(
    `INSERT INTO oauth_states (state, concern_id)
     VALUES ($1, $2)`,
    [state, concernId]
  );

  res.json({ authUrl: buildGoogleAuthUrl(state) });
});

app.get("/integrations/google/callback", async (req, res) => {
  if (!pool) return res.status(503).send("database unavailable");

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  if (!code || !state) return res.status(400).send("missing OAuth code or state");

  const stateResult = await pool.query(
    `DELETE FROM oauth_states
     WHERE state = $1 AND expires_at > NOW()
     RETURNING concern_id`,
    [state]
  );

  if (!stateResult.rowCount) return res.status(400).send("expired or invalid OAuth state");

  try {
    const token = await exchangeGoogleCode(code);
    await saveGoogleIntegration(pool, stateResult.rows[0].concern_id, token);
    res
      .status(200)
      .type("html")
      .send(`<!doctype html><html><body style="font-family:monospace;padding:32px">google connected to gc.<br><br>you can close this window.<script>setTimeout(()=>window.close(),1200)</script></body></html>`);
  } catch (error: any) {
    console.error(error);
    res.status(502).send("google connection failed");
  }
});

app.delete("/concerns/:id/integrations/google", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  await pool.query(
    "DELETE FROM integrations WHERE concern_id = $1 AND provider = 'google'",
    [req.params.id]
  );
  res.json({ disconnected: true });
});

app.post("/concerns/:id/google/drive/:fileId", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const fileResult = await pool.query(
    "SELECT * FROM files WHERE concern_id = $1 AND id = $2",
    [req.params.id, req.params.fileId]
  );
  if (!fileResult.rowCount) return res.status(404).json({ error: "file_not_found" });

  try {
    const result: any = await uploadFileToDrive(pool, req.params.id, fileResult.rows[0]);
    await pool.query(
      `INSERT INTO external_actions
       (id, concern_id, action_type, title, status, payload, result, completed_at)
       VALUES ($1, $2, 'drive', $3, 'completed', $4::jsonb, $5::jsonb, NOW())`,
      [
        randomUUID(),
        req.params.id,
        `sent ${fileResult.rows[0].path} to Google Drive`,
        JSON.stringify({ fileId: req.params.fileId }),
        JSON.stringify(result)
      ]
    );
    res.json({ file: result });
  } catch (error: any) {
    res.status(502).json({ error: "drive_upload_failed", detail: String(error?.message || error).slice(0, 1000) });
  }
});

const googleCalendarSchema = z.object({
  summary: z.string().min(1).max(300),
  description: z.string().max(4000).optional(),
  start: z.string().datetime(),
  end: z.string().datetime()
});

app.post("/concerns/:id/google/calendar", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const parsed = googleCalendarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_calendar_event" });

  try {
    const result: any = await createCalendarEvent(pool, req.params.id, parsed.data);
    await pool.query(
      `INSERT INTO external_actions
       (id, concern_id, action_type, title, status, payload, result, completed_at)
       VALUES ($1, $2, 'calendar', $3, 'completed', $4::jsonb, $5::jsonb, NOW())`,
      [randomUUID(), req.params.id, parsed.data.summary, JSON.stringify(parsed.data), JSON.stringify(result)]
    );
    res.json({ event: result });
  } catch (error: any) {
    res.status(502).json({ error: "calendar_create_failed", detail: String(error?.message || error).slice(0, 1000) });
  }
});

const googleEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(50000)
});

app.post("/concerns/:id/google/email", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const parsed = googleEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_email" });

  try {
    const result: any = await sendGmail(pool, req.params.id, parsed.data);
    await pool.query(
      `INSERT INTO external_actions
       (id, concern_id, action_type, title, status, payload, result, completed_at)
       VALUES ($1, $2, 'email', $3, 'completed', $4::jsonb, $5::jsonb, NOW())`,
      [
        randomUUID(),
        req.params.id,
        parsed.data.subject,
        JSON.stringify({ to: parsed.data.to, subject: parsed.data.subject }),
        JSON.stringify(result)
      ]
    );
    res.json({ message: result });
  } catch (error: any) {
    res.status(502).json({ error: "email_send_failed", detail: String(error?.message || error).slice(0, 1000) });
  }
});

app.get("/concerns/:id/calendar", async (req, res) => {
  if (!pool) return res.json({ items: [] });
  const result = await pool.query(
    `SELECT id, title, status, desk, priority, assigned_to, scheduled_at, created_at, completed_at
     FROM tasks
     WHERE concern_id = $1 AND scheduled_at IS NOT NULL
     ORDER BY scheduled_at ASC`,
    [req.params.id]
  );
  res.json({ items: result.rows });
});

app.get("/concerns/:id/outbox", async (req, res) => {
  if (!pool) return res.json({ actions: [] });
  const result = await pool.query(
    `SELECT id, action_type, title, status, payload, result, created_at, completed_at
     FROM external_actions
     WHERE concern_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.params.id]
  );
  res.json({ actions: result.rows });
});

const actionSchema = z.object({
  actionType: z.enum(["email", "publish", "form", "calendar", "drive", "purchase"]),
  title: z.string().min(1).max(300),
  payload: z.record(z.any()).default({})
});

app.post("/concerns/:id/outbox", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_action", details: parsed.error.flatten() });

  const concern = await pool.query("SELECT id FROM concerns WHERE id = $1", [req.params.id]);
  if (!concern.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO external_actions (id, concern_id, action_type, title, status, payload)
     VALUES ($1, $2, $3, $4, 'queued', $5::jsonb)
     RETURNING *`,
    [id, req.params.id, parsed.data.actionType, parsed.data.title, JSON.stringify(parsed.data.payload)]
  );
  res.status(201).json({ action: result.rows[0] });
});

const calendarSchema = z.object({
  title: z.string().min(1).max(300),
  scheduledAt: z.string().datetime(),
  assignedTo: z.enum(["company", "human"]).default("company"),
  desk: z.string().max(80).optional(),
  priority: z.number().int().min(1).max(10).default(5)
});

app.post("/concerns/:id/calendar", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "database_required" });
  const parsed = calendarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_calendar_item", details: parsed.error.flatten() });

  const concern = await pool.query("SELECT id FROM concerns WHERE id = $1", [req.params.id]);
  if (!concern.rowCount) return res.status(404).json({ error: "concern_not_found" });

  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO tasks (id, concern_id, title, status, desk, priority, assigned_to, scheduled_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
     RETURNING *`,
    [
      id,
      req.params.id,
      parsed.data.title,
      parsed.data.desk || null,
      parsed.data.priority,
      parsed.data.assignedTo,
      parsed.data.scheduledAt
    ]
  );
  res.status(201).json({ item: result.rows[0] });
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
    if (pool) {
      startBrowserPoller(pool);
      startFounderScheduler(pool, port);
    }

    app.listen(port, "0.0.0.0", () => {
      console.log(`gc-engine listening on :${port}`);

      const bootTestConcern = process.env.GC_BOOT_TEST_CONCERN;
      if (bootTestConcern) {
        setTimeout(async () => {
          try {
            const response = await fetch(
              `http://127.0.0.1:${port}/concerns/${encodeURIComponent(bootTestConcern)}/run`,
              { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
            );
            const body = await response.text();
            console.log("GC_BOOT_TEST", response.status, body.slice(0, 2000));
          } catch (error) {
            console.error("GC_BOOT_TEST failed", error);
          }
        }, 1500);
      }
    });
  })
  .catch((error) => {
    console.error("database initialization failed", error);
    process.exit(1);
  });
