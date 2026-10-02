import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.send"
];

function clientId() {
  if (!process.env.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID is not configured");
  return process.env.GOOGLE_CLIENT_ID;
}

function clientSecret() {
  if (!process.env.GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_SECRET is not configured");
  return process.env.GOOGLE_CLIENT_SECRET;
}

function redirectUri() {
  return (
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.PUBLIC_APP_URL || "https://gc-engine-production.up.railway.app"}/integrations/google/callback`
  );
}

function encryptionKey() {
  return createHash("sha256")
    .update(process.env.INTEGRATION_TOKEN_SECRET || clientSecret())
    .digest();
}

export function encryptToken(value?: string | null) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptToken(value?: string | null) {
  if (!value) return null;
  const bytes = Buffer.from(value, "base64");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const encrypted = bytes.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function buildGoogleAuthUrl(state: string) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoogleCode(code: string) {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json: any = await response.json().catch(() => null);
  if (!response.ok || !json?.access_token) {
    throw new Error(`Google token exchange failed: ${response.status} ${JSON.stringify(json).slice(0, 700)}`);
  }

  return json;
}

async function refreshGoogleToken(refreshToken: string) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: "refresh_token"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json: any = await response.json().catch(() => null);
  if (!response.ok || !json?.access_token) {
    throw new Error(`Google refresh failed: ${response.status} ${JSON.stringify(json).slice(0, 700)}`);
  }
  return json;
}

export async function saveGoogleIntegration(
  pool: Pool,
  concernId: string,
  token: any
) {
  const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000);
  const scopes = String(token.scope || GOOGLE_SCOPES.join(" ")).split(/\s+/).filter(Boolean);

  const existing = await pool.query(
    "SELECT refresh_token_enc FROM integrations WHERE concern_id = $1 AND provider = 'google'",
    [concernId]
  );

  const refreshTokenEnc = token.refresh_token
    ? encryptToken(token.refresh_token)
    : existing.rows[0]?.refresh_token_enc || null;

  await pool.query(
    `INSERT INTO integrations
      (id, concern_id, provider, access_token_enc, refresh_token_enc, expires_at, scopes, updated_at)
     VALUES ($1, $2, 'google', $3, $4, $5, $6, NOW())
     ON CONFLICT (concern_id, provider)
     DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc,
                   refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, integrations.refresh_token_enc),
                   expires_at = EXCLUDED.expires_at,
                   scopes = EXCLUDED.scopes,
                   updated_at = NOW()`,
    [randomUUID(), concernId, encryptToken(token.access_token), refreshTokenEnc, expiresAt, scopes]
  );
}

export async function getGoogleAccessToken(pool: Pool, concernId: string) {
  const result = await pool.query(
    "SELECT * FROM integrations WHERE concern_id = $1 AND provider = 'google'",
    [concernId]
  );
  if (!result.rowCount) throw new Error("google_not_connected");

  const integration = result.rows[0];
  const expiresAt = integration.expires_at ? new Date(integration.expires_at).getTime() : 0;
  let access = decryptToken(integration.access_token_enc);

  if (!access || expiresAt < Date.now() + 60_000) {
    const refresh = decryptToken(integration.refresh_token_enc);
    if (!refresh) throw new Error("google_refresh_token_missing");
    const refreshed = await refreshGoogleToken(refresh);
    access = refreshed.access_token;

    await pool.query(
      `UPDATE integrations
       SET access_token_enc = $1,
           expires_at = $2,
           updated_at = NOW()
       WHERE concern_id = $3 AND provider = 'google'`,
      [
        encryptToken(access),
        new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000),
        concernId
      ]
    );
  }

  return access;
}

async function googleFetch(
  pool: Pool,
  concernId: string,
  url: string,
  init: RequestInit
) {
  const accessToken = await getGoogleAccessToken(pool, concernId);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google API failed: ${response.status} ${detail.slice(0, 700)}`);
  }

  return response;
}

export async function uploadFileToDrive(
  pool: Pool,
  concernId: string,
  file: { path: string; mime_type?: string | null; content?: string | null }
) {
  const boundary = `gc-${randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: file.path.split("/").pop() || file.path
  });
  const mime = file.mime_type || "text/plain";
  const content = file.content || "";

  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n`,
    `--${boundary}--`
  ].join("");

  const response = await googleFetch(
    pool,
    concernId,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    }
  );

  return response.json();
}

export async function createCalendarEvent(
  pool: Pool,
  concernId: string,
  event: {
    summary: string;
    description?: string;
    start: string;
    end: string;
  }
) {
  const response = await googleFetch(
    pool,
    concernId,
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: event.summary,
        description: event.description || "",
        start: { dateTime: event.start },
        end: { dateTime: event.end }
      })
    }
  );
  return response.json();
}

function base64url(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function sendGmail(
  pool: Pool,
  concernId: string,
  email: { to: string; subject: string; body: string }
) {
  const raw = [
    `To: ${email.to}`,
    `Subject: ${email.subject.replace(/[\r\n]/g, " ")}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    email.body
  ].join("\r\n");

  const response = await googleFetch(
    pool,
    concernId,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: base64url(raw) })
    }
  );
  return response.json();
}
