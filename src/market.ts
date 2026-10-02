export type TokenMarket = {
  address: string;
  price: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidity: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
  symbol?: string | null;
  name?: string | null;
  logoURI?: string | null;
};

export async function getTokenMarket(address: string): Promise<TokenMarket> {
  if (!process.env.BIRDEYE_API_KEY) throw new Error("BIRDEYE_API_KEY is not configured");

  const url = new URL("https://public-api.birdeye.so/defi/token_overview");
  url.searchParams.set("address", address);

  const response = await fetch(url, {
    headers: {
      "X-API-KEY": process.env.BIRDEYE_API_KEY,
      "x-chain": "solana",
      accept: "application/json"
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Birdeye failed: ${response.status} ${detail.slice(0, 500)}`);
  }

  const json: any = await response.json();
  const data = json?.data || {};

  return {
    address,
    price: numberOrNull(data.price),
    marketCap: numberOrNull(data.mc ?? data.marketCap),
    fdv: numberOrNull(data.fdv),
    liquidity: numberOrNull(data.liquidity),
    volume24h: numberOrNull(data.v24hUSD ?? data.volume24h),
    priceChange24h: numberOrNull(data.priceChange24hPercent ?? data.priceChange24h),
    symbol: data.symbol ?? null,
    name: data.name ?? null,
    logoURI: data.logoURI ?? data.logo_uri ?? null
  };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
