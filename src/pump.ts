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

export async function preparePumpCreate(input: PreparePumpCreateInput): Promise<Uint8Array> {
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
      mint: input.mint,
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

  return new Uint8Array(await response.arrayBuffer());
}
