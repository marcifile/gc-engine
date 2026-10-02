import { Keypair } from "@solana/web3.js";
import type { Pool } from "pg";
import { encryptSecret } from "./secrets.js";

function encodeSecret(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

export async function ensureOperatingWallet(pool: Pool, concernId: string) {
  const existing = await pool.query(
    "SELECT public_key FROM concern_wallets WHERE concern_id = $1",
    [concernId]
  );
  if (existing.rowCount) return String(existing.rows[0].public_key);

  const wallet = Keypair.generate();
  const publicKey = wallet.publicKey.toBase58();
  const secret = encryptSecret(encodeSecret(wallet.secretKey));

  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO concern_wallets (concern_id, public_key, secret_key_enc, purpose)
       VALUES ($1, $2, $3, 'operating')
       ON CONFLICT (concern_id) DO NOTHING`,
      [concernId, publicKey, secret]
    );
    await pool.query(
      `UPDATE concerns
       SET operating_wallet = COALESCE(operating_wallet, $1),
           updated_at = NOW()
       WHERE id = $2`,
      [publicKey, concernId]
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }

  const final = await pool.query(
    "SELECT public_key FROM concern_wallets WHERE concern_id = $1",
    [concernId]
  );
  return String(final.rows[0].public_key);
}
