import type { Pool } from "pg";
import { getSolanaBalance } from "./solana.js";
import { getSolPriceUsd } from "./market.js";

export async function refreshOperatingBalance(pool: Pool, concernId: string) {
  const result = await pool.query(
    "SELECT operating_wallet FROM concerns WHERE id = $1",
    [concernId]
  );
  if (!result.rowCount) throw new Error("concern_not_found");
  const wallet = result.rows[0].operating_wallet;
  if (!wallet) return { wallet: null, sol: 0, usd: 0 };

  const [sol, solUsd] = await Promise.all([getSolanaBalance(wallet), getSolPriceUsd()]);
  const usd = sol * solUsd;

  await pool.query(
    `UPDATE concerns
     SET operating_balance_usd = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [usd, concernId]
  );

  return { wallet, sol, solUsd, usd };
}

export function startBalancePoller(pool: Pool, intervalMs = 60_000) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await pool.query(
        "SELECT id FROM concerns WHERE operating_wallet IS NOT NULL ORDER BY updated_at ASC LIMIT 50"
      );
      if (!result.rowCount) return;

      const solUsd = await getSolPriceUsd();
      for (const row of result.rows) {
        try {
          const walletResult = await pool.query(
            "SELECT operating_wallet FROM concerns WHERE id = $1",
            [row.id]
          );
          const wallet = walletResult.rows[0]?.operating_wallet;
          if (!wallet) continue;
          const sol = await getSolanaBalance(wallet);
          await pool.query(
            "UPDATE concerns SET operating_balance_usd = $1 WHERE id = $2",
            [sol * solUsd, row.id]
          );
        } catch (error) {
          console.error("operating balance refresh failed", row.id, error);
        }
      }
    } catch (error) {
      console.error("balance poller tick failed", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
