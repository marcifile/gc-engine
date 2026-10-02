import pg from "pg";

const { Pool } = pg;

export const hasDatabase = Boolean(process.env.DATABASE_URL);
export const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

export async function initDb() {
  if (!pool) {
    console.warn("DATABASE_URL not set; running in temporary memory mode");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS concerns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ticker TEXT NOT NULL,
      mint_address TEXT,
      category TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      current_task TEXT NOT NULL DEFAULT 'decide where to begin',
      creator_rewards_usd NUMERIC NOT NULL DEFAULT 0,
      operating_balance_usd NUMERIC NOT NULL DEFAULT 0,
      external_revenue_usd NUMERIC NOT NULL DEFAULT 0,
      market_cap_usd NUMERIC NOT NULL DEFAULT 0,
      day INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notes (
      id UUID PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS events (
      id UUID PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS memories (
      id UUID PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      desk TEXT,
      priority INTEGER NOT NULL DEFAULT 5,
      result_summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS files (
      id UUID PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      mime_type TEXT,
      storage_url TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(concern_id, path)
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id UUID PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount_usd NUMERIC NOT NULL,
      description TEXT NOT NULL,
      tx_signature TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS external_actions (
      id UUID PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS mint_address TEXT;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS content TEXT;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to TEXT DEFAULT 'company';
    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS auto_work BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS last_work_at TIMESTAMPTZ;
    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS min_work_balance_usd NUMERIC NOT NULL DEFAULT 0.05;
    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS external_actions_mode TEXT NOT NULL DEFAULT 'automatic';
    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS staffing_mode TEXT NOT NULL DEFAULT 'automatic';
    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS creator_rewards_configured BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS creator_wallet TEXT;
    ALTER TABLE concerns ADD COLUMN IF NOT EXISTS operating_wallet TEXT;


    CREATE TABLE IF NOT EXISTS concern_wallets (
      concern_id TEXT PRIMARY KEY REFERENCES concerns(id) ON DELETE CASCADE,
      public_key TEXT NOT NULL UNIQUE,
      secret_key_enc TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'operating',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id UUID PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      expires_at TIMESTAMPTZ,
      scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(concern_id, provider)
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      return_to TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes'
    );

    CREATE TABLE IF NOT EXISTS browser_runs (
      run_id TEXT PRIMARY KEY,
      concern_id TEXT NOT NULL REFERENCES concerns(id) ON DELETE CASCADE,
      session_id TEXT,
      status TEXT NOT NULL,
      task TEXT NOT NULL,
      live_view_url TEXT,
      result JSONB,
      cause JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO concerns (id, name, ticker, category, summary, status, current_task)
    VALUES (
      'mesa',
      'MESA',
      'MESA',
      'restaurant software',
      'finding a better inventory workflow for small restaurants',
      'working',
      'research inventory problems for independent restaurants'
    )
    ON CONFLICT (id) DO NOTHING;
  `);
}

export function toConcern(row: any, notes: any[] = []) {
  return {
    id: row.id,
    name: row.name,
    ticker: row.ticker,
    mintAddress: row.mint_address ?? null,
    category: row.category,
    summary: row.summary,
    status: row.status,
    currentTask: row.current_task,
    creatorRewardsUsd: Number(row.creator_rewards_usd),
    operatingBalanceUsd: Number(row.operating_balance_usd),
    externalRevenueUsd: Number(row.external_revenue_usd),
    marketCapUsd: Number(row.market_cap_usd),
    day: row.day,
    autoWork: row.auto_work ?? true,
    lastWorkAt: row.last_work_at ?? null,
    minWorkBalanceUsd: Number(row.min_work_balance_usd ?? 0.05),
    externalActionsMode: row.external_actions_mode ?? "automatic",
    staffingMode: row.staffing_mode ?? "automatic",
    creatorRewardsConfigured: Boolean(row.creator_rewards_configured),
    creatorWallet: row.creator_wallet ?? null,
    operatingWallet: row.operating_wallet ?? null,
    notes: notes.map((n) => ({
      id: n.id,
      text: n.text,
      createdAt: n.created_at
    }))
  };
}
