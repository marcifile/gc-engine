const HELIUS_RPC = () => {
  if (!process.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is not configured");
  return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
};

export async function getSolanaBalance(address: string): Promise<number> {
  const response = await fetch(HELIUS_RPC(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "gc",
      method: "getBalance",
      params: [address]
    })
  });

  const json: any = await response.json();
  if (json.error) throw new Error(json.error.message || "Helius RPC error");
  return Number(json.result?.value || 0) / 1_000_000_000;
}

export async function getAsset(address: string): Promise<any> {
  const response = await fetch(HELIUS_RPC(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "gc",
      method: "getAsset",
      params: { id: address }
    })
  });

  const json: any = await response.json();
  if (json.error) throw new Error(json.error.message || "Helius DAS error");
  return json.result;
}


export async function getSignatureStatus(signature: string): Promise<{
  confirmationStatus: string | null;
  err: unknown;
}> {
  const response = await fetch(HELIUS_RPC(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "gc",
      method: "getSignatureStatuses",
      params: [[signature], { searchTransactionHistory: true }]
    })
  });

  const json: any = await response.json();
  if (json.error) throw new Error(json.error.message || "Helius RPC error");
  const status = json.result?.value?.[0] || null;
  return {
    confirmationStatus: status?.confirmationStatus ?? null,
    err: status?.err ?? null
  };
}
