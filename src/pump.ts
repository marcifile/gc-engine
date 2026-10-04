import { Keypair, VersionedTransaction } from "@solana/web3.js";

export type PreparePumpCreateInput = {
  publicKey: string;
  mint?: string;
  name: string;
  symbol: string;
  metadataUri: string;
  initialBuySol: number;
  slippage?: number;
  priorityFee?: number;
};

export type PreparedPumpCreate = {
  bytes: Uint8Array;
  mint: string;
};

export async function preparePumpCreate(input: PreparePumpCreateInput): Promise<PreparedPumpCreate> {
  if (input.mint) {
    throw new Error("client-provided mint is no longer supported");
  }

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey.toBase58();

  const response = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: input.publicKey,
      action: "create",
      tokenMetadata: {
        name: input.name,
        symbol: input.symbol,
        uri: input.metadataUri
      },
      mint,
      denominatedInSol: "true",
      amount: input.initialBuySol,
      slippage: input.slippage ?? 10,
      priorityFee: input.priorityFee ?? 0.00001,
      pool: "pump"
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`PumpPortal create failed: ${response.status} ${detail.slice(0, 700)}`);
  }

  const raw = new Uint8Array(await response.arrayBuffer());
  const transaction = VersionedTransaction.deserialize(raw);
  transaction.sign([mintKeypair]);

  return {
    bytes: transaction.serialize(),
    mint
  };
}
