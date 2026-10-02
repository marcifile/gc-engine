import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createCalendarEvent, sendGmail, uploadFileToDrive } from "./google.js";

export type FounderExternalAction = {
  type: "email" | "calendar" | "drive";
  title: string;
  payload: Record<string, unknown>;
};

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function performAction(
  pool: Pool,
  concernId: string,
  action: FounderExternalAction
) {
  if (action.type === "email") {
    const to = stringValue(action.payload.to);
    const subject = stringValue(action.payload.subject) || action.title;
    const body = stringValue(action.payload.body);
    if (!to || !to.includes("@") || !subject || !body) throw new Error("invalid_email_action");

    const sentToday = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM external_actions
       WHERE concern_id = $1
         AND action_type = 'email'
         AND status = 'completed'
         AND completed_at > NOW() - INTERVAL '24 hours'`,
      [concernId]
    );
    if (Number(sentToday.rows[0]?.count || 0) >= 5) {
      throw new Error("automatic_email_daily_limit_reached");
    }

    return sendGmail(pool, concernId, { to, subject, body });
  }

  if (action.type === "calendar") {
    const summary = stringValue(action.payload.summary) || action.title;
    const description = stringValue(action.payload.description);
    const start = stringValue(action.payload.start);
    const end = stringValue(action.payload.end);
    if (!summary || !start || !end) throw new Error("invalid_calendar_action");
    return createCalendarEvent(pool, concernId, { summary, description, start, end });
  }

  if (action.type === "drive") {
    const fileId = stringValue(action.payload.fileId);
    if (!fileId) throw new Error("invalid_drive_action");
    const fileResult = await pool.query(
      "SELECT * FROM files WHERE concern_id = $1 AND id = $2",
      [concernId, fileId]
    );
    if (!fileResult.rowCount) throw new Error("file_not_found");
    return uploadFileToDrive(pool, concernId, fileResult.rows[0]);
  }

  throw new Error("unsupported_external_action");
}

export async function executeExternalActionById(
  pool: Pool,
  concernId: string,
  actionId: string
) {
  const rowResult = await pool.query(
    `SELECT * FROM external_actions
     WHERE id = $1 AND concern_id = $2
     LIMIT 1`,
    [actionId, concernId]
  );
  if (!rowResult.rowCount) throw new Error("external_action_not_found");

  const row = rowResult.rows[0];
  if (row.status === "completed") return { id: actionId, status: "completed", result: row.result };

  const action: FounderExternalAction = {
    type: row.action_type,
    title: row.title,
    payload: row.payload || {}
  };

  await pool.query("UPDATE external_actions SET status = 'running' WHERE id = $1", [actionId]);

  try {
    const result: any = await performAction(pool, concernId, action);

    await pool.query(
      `UPDATE external_actions
       SET status = 'completed',
           result = $1::jsonb,
           completed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(result ?? {}), actionId]
    );

    await pool.query(
      `INSERT INTO events (id, concern_id, type, summary, metadata)
       VALUES ($1, $2, 'external_action_completed', $3, $4::jsonb)`,
      [randomUUID(), concernId, action.title.slice(0, 500), JSON.stringify({ actionId, type: action.type })]
    );

    return { id: actionId, status: "completed", result };
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 1000);
    await pool.query(
      `UPDATE external_actions
       SET status = 'failed',
           result = $1::jsonb,
           completed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify({ error: message }), actionId]
    );
    return { id: actionId, status: "failed", error: message };
  }
}

export async function queueOrExecuteExternalAction(
  pool: Pool,
  concernId: string,
  mode: "automatic" | "ask",
  action: FounderExternalAction
) {
  const id = randomUUID();
  const initialStatus = mode === "automatic" ? "queued" : "waiting";

  await pool.query(
    `INSERT INTO external_actions
      (id, concern_id, action_type, title, status, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, concernId, action.type, action.title.slice(0, 300), initialStatus, JSON.stringify(action.payload || {})]
  );

  if (mode !== "automatic") return { id, status: "waiting" };
  return executeExternalActionById(pool, concernId, id);
}
