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
  source?: "birdeye" | "dexscreener";
};

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getBirdeyeTokenMarket(address: string): Promise<TokenMarket> {
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
    logoURI: data.logoURI ?? data.logo_uri ?? null,
    source: "birdeye"
  };
}

async function getDexScreenerTokenMarket(address: string): Promise<TokenMarket> {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DexScreener failed: ${response.status} ${detail.slice(0, 500)}`);
  }

  const json: any = await response.json();
  const pairs = Array.isArray(json?.pairs)
    ? json.pairs.filter((pair: any) => pair?.chainId === "solana")
    : [];

  if (!pairs.length) {
    return {
      address,
      price: null,
      marketCap: null,
      fdv: null,
      liquidity: null,
      volume24h: null,
      priceChange24h: null,
      source: "dexscreener"
    };
  }

  pairs.sort((a: any, b: any) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
  const pair = pairs[0];
  const isBase = String(pair?.baseToken?.address || "") === address;
  const token = isBase ? pair?.baseToken : pair?.quoteToken;

  return {
    address,
    price: numberOrNull(pair?.priceUsd),
    marketCap: numberOrNull(pair?.marketCap ?? pair?.fdv),
    fdv: numberOrNull(pair?.fdv),
    liquidity: numberOrNull(pair?.liquidity?.usd),
    volume24h: numberOrNull(pair?.volume?.h24),
    priceChange24h: numberOrNull(pair?.priceChange?.h24),
    symbol: token?.symbol ?? null,
    name: token?.name ?? null,
    logoURI: pair?.info?.imageUrl ?? null,
    source: "dexscreener"
  };
}

export async function getTokenMarket(address: string): Promise<TokenMarket> {
  if (process.env.BIRDEYE_API_KEY) {
    try {
      const market = await getBirdeyeTokenMarket(address);
      if (market.price !== null || market.marketCap !== null) return market;
    } catch (error) {
      console.warn("Birdeye market lookup failed; falling back to DexScreener", String((error as any)?.message || error));
    }
  }

  return getDexScreenerTokenMarket(address);
}

export async function getSolPriceUsd(): Promise<number> {
  const data = await getTokenMarket("So11111111111111111111111111111111111111112");
  if (data.price === null || data.price <= 0) throw new Error("SOL price unavailable");
  return data.price;
}
