import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

function connection() {
  if (!process.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is not configured");
  return new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
    "confirmed"
  );
}

export async function prepareFeeSharingTransaction(input: {
  creator: string;
  mint: string;
  operatingWallet: string;
}) {
  const creator = new PublicKey(input.creator);
  const mint = new PublicKey(input.mint);
  const operatingWallet = new PublicKey(input.operatingWallet);

  const createIx = await PUMP_SDK.createFeeSharingConfig({
    creator,
    mint,
    pool: null
  });

  const updateIx = await PUMP_SDK.updateFeeSharesV2({
    authority: creator,
    mint,
    currentShareholders: [creator],
    newShareholders: [{ address: operatingWallet, shareBps: 10_000 }],
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID
  });

  const rpc = connection();
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: creator,
    recentBlockhash: blockhash
  }).add(createIx, updateIx);

  return {
    transactionBase64: tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    }).toString("base64"),
    blockhash,
    lastValidBlockHeight,
    operatingWallet: operatingWallet.toBase58()
  };
}
