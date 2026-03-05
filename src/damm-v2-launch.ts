import "dotenv/config";

import BN from "bn.js";
import bs58 from "bs58";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CpAmm,
  ActivationType,
  BaseFeeMode,
  derivePoolAddress,
  getBaseFeeParams,
  getDynamicFeeParams,
  getSqrtPriceFromPrice,
  getTokenDecimals,
} from "@meteora-ag/cp-amm-sdk";

type QuoteMintType = "WSOL" | "USDC";
type ClusterType = "devnet" | "mainnet-beta";

type RequiredEnvKey =
  | "RPC_URL"
  | "WALLET_SECRET_KEY"
  | "CONFIG_ADDRESS"
  | "TOKEN_A_INPUT_AMOUNT_RAW";

const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const MAINNET_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DEFAULT_TOKEN_MINT_OUTPUT_PATH = "data/latest-token-mint.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";

function getRequiredEnv(key: RequiredEnvKey): string {
  const value = process.env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value.trim();
}

function parseWalletSecret(raw: string): Uint8Array {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }

  // Support comma-separated bytes as a convenience format.
  if (trimmed.includes(",")) {
    return Uint8Array.from(trimmed.split(",").map((x) => Number(x.trim())));
  }

  // Support base58 private keys (common Solana wallet export format).
  return bs58.decode(trimmed);
}

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return raw.toLowerCase() === "true";
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key]?.trim() || defaultValue;
}

function computePriceFromRawAmounts(
  tokenAAmountRaw: BN,
  tokenBAmountRaw: BN,
  tokenADecimals: number,
  tokenBDecimals: number
): string {
  const aRaw = BigInt(tokenAAmountRaw.toString());
  const bRaw = BigInt(tokenBAmountRaw.toString());
  if (aRaw <= 0n || bRaw <= 0n) {
    throw new Error("TOKEN_A_INPUT_AMOUNT_RAW and TOKEN_B_INPUT_AMOUNT_RAW must be > 0");
  }

  let numerator = bRaw;
  let denominator = aRaw;
  const decimalDiff = tokenADecimals - tokenBDecimals;
  if (decimalDiff > 0) numerator *= 10n ** BigInt(decimalDiff);
  if (decimalDiff < 0) denominator *= 10n ** BigInt(-decimalDiff);

  const precision = 12n;
  const scale = 10n ** precision;
  const scaled = (numerator * scale) / denominator;
  const intPart = scaled / scale;
  const fracPart = scaled % scale;
  const fracPadded = fracPart.toString().padStart(Number(precision), "0");
  const fracTrimmed = fracPadded.replace(/0+$/, "");
  return fracTrimmed.length > 0 ? `${intPart.toString()}.${fracTrimmed}` : intPart.toString();
}

async function getTokenMintFromOutputFile(pathValue: string): Promise<PublicKey> {
  const absPath = resolve(pathValue);
  const raw = await readFile(absPath, "utf8");
  const parsed = JSON.parse(raw) as { tokenMint?: string };

  if (!parsed.tokenMint) {
    throw new Error(`tokenMint missing in output file: ${absPath}`);
  }
  return new PublicKey(parsed.tokenMint);
}

function inferCluster(rpcUrl: string): ClusterType {
  const input = rpcUrl.toLowerCase();
  if (input.includes("mainnet")) return "mainnet-beta";
  return "devnet";
}

function getQuoteMintByType(type: QuoteMintType, cluster: ClusterType): PublicKey {
  if (type === "WSOL") return NATIVE_MINT;
  return cluster === "mainnet-beta" ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;
}

async function getTokenProgramForMint(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const mintAccount = await connection.getAccountInfo(mint);
  if (!mintAccount) {
    throw new Error(`Mint account not found: ${mint.toBase58()}`);
  }

  if (mintAccount.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;

  throw new Error(
    `Unsupported token program for mint ${mint.toBase58()}: ${mintAccount.owner.toBase58()}`
  );
}

async function writePoolOutput(params: {
  outputPath: string;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  quoteMintType: QuoteMintType;
  tokenMintOutputPath: string;
  isAlphaVaultConnected: boolean;
  poolActivationPointTs: string | null;
  txSignature: string | null;
  dryRun: boolean;
}): Promise<void> {
  const absPath = resolve(params.outputPath);
  await mkdir(resolve(absPath, ".."), { recursive: true });
  await writeFile(
    absPath,
    JSON.stringify(
      {
        poolAddress: params.poolAddress.toBase58(),
        baseMint: params.baseMint.toBase58(),
        quoteMint: params.quoteMint.toBase58(),
        quoteMintType: params.quoteMintType,
        tokenMintOutputPath: resolve(params.tokenMintOutputPath),
        isAlphaVaultConnected: params.isAlphaVaultConnected,
        poolActivationPointTs: params.poolActivationPointTs,
        txSignature: params.txSignature,
        dryRun: params.dryRun,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL?.trim() || clusterApiUrl("mainnet-beta");
  const cluster = (process.env.CLUSTER?.trim() as ClusterType | undefined) || inferCluster(rpcUrl);
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));

  const config = new PublicKey(getRequiredEnv("CONFIG_ADDRESS"));
  const quoteMintType = (process.env.QUOTE_MINT_TYPE?.trim().toUpperCase() || "WSOL") as QuoteMintType;
  if (!["WSOL", "USDC"].includes(quoteMintType)) {
    throw new Error("QUOTE_MINT_TYPE must be WSOL or USDC");
  }
  const tokenMintOutputPath =
    process.env.TOKEN_MINT_OUTPUT_PATH?.trim() || DEFAULT_TOKEN_MINT_OUTPUT_PATH;
  const tokenAMint = await getTokenMintFromOutputFile(tokenMintOutputPath);
  const tokenBMint = getQuoteMintByType(quoteMintType, cluster);
  const configuredInitialPrice = process.env.INITIAL_PRICE?.trim();
  const tokenBInputAmountRawEnv = process.env.TOKEN_B_INPUT_AMOUNT_RAW?.trim();
  const tokenAInputAmountRaw = new BN(getRequiredEnv("TOKEN_A_INPUT_AMOUNT_RAW"), 10);

  const dryRun = parseBool(process.env.DRY_RUN, true);
  const isLockLiquidity = parseBool(process.env.IS_LOCK_LIQUIDITY, false);
  const connectAlphaVaultPool = parseBool(process.env.CONNECT_ALPHA_VAULT_POOL, true);
  const poolOutputPath = process.env.POOL_OUTPUT_PATH?.trim() || DEFAULT_POOL_OUTPUT_PATH;

  const connection = new Connection(rpcUrl, "confirmed");
  const cpAmm = new CpAmm(connection);

  const [tokenAProgram, tokenBProgram, configState] = await Promise.all([
    getTokenProgramForMint(connection, tokenAMint),
    getTokenProgramForMint(connection, tokenBMint),
    cpAmm.fetchConfigState(config),
  ]);

  const [tokenADecimals, tokenBDecimals] = await Promise.all([
    getTokenDecimals(connection, tokenAMint, tokenAProgram),
    getTokenDecimals(connection, tokenBMint, tokenBProgram),
  ]);

  let initialPrice = configuredInitialPrice;
  if (!initialPrice) {
    if (!tokenBInputAmountRawEnv) {
      throw new Error("Set INITIAL_PRICE or TOKEN_B_INPUT_AMOUNT_RAW in .env");
    }
    const tokenBInputAmountRaw = new BN(tokenBInputAmountRawEnv, 10);
    initialPrice = computePriceFromRawAmounts(
      tokenAInputAmountRaw,
      tokenBInputAmountRaw,
      tokenADecimals,
      tokenBDecimals
    );
    console.log(`Auto-computed INITIAL_PRICE=${initialPrice} from raw amounts.`);
  }

  const initSqrtPrice = getSqrtPriceFromPrice(initialPrice, tokenADecimals, tokenBDecimals);

  const depositQuote = cpAmm.getDepositQuote({
    inAmount: tokenAInputAmountRaw,
    isTokenA: true,
    minSqrtPrice: configState.sqrtMinPrice,
    maxSqrtPrice: configState.sqrtMaxPrice,
    sqrtPrice: initSqrtPrice,
  });

  const positionNft = Keypair.generate();
  let tx: import("@solana/web3.js").Transaction;
  let pool: PublicKey;
  let poolActivationPointTs: string | null = null;

  if (connectAlphaVaultPool) {
    const now = Math.floor(Date.now() / 1000);
    const activationPointTs = new BN(
      getEnvOrDefault("POOL_ACTIVATION_POINT_TS", String(now + 90 * 60)),
      10
    );
    const startingFeeBps = Number(getEnvOrDefault("POOL_STARTING_FEE_BPS", "5000"));
    const endingFeeBps = Number(getEnvOrDefault("POOL_ENDING_FEE_BPS", "25"));
    const numberOfPeriod = Number(getEnvOrDefault("POOL_FEE_NUMBER_OF_PERIOD", "50"));
    const totalDuration = Number(getEnvOrDefault("POOL_FEE_TOTAL_DURATION_SEC", "300"));
    const useDynamicFee = parseBool(process.env.POOL_ENABLE_DYNAMIC_FEE, true);
    const dynamicBaseFeeBps = Number(getEnvOrDefault("POOL_DYNAMIC_BASE_FEE_BPS", "25"));
    const collectFeeMode = Number(getEnvOrDefault("POOL_COLLECT_FEE_MODE", "0"));

    const baseFeeParams = getBaseFeeParams(
      {
        baseFeeMode: BaseFeeMode.FeeTimeSchedulerExponential,
        feeTimeSchedulerParam: {
          startingFeeBps,
          endingFeeBps,
          numberOfPeriod,
          totalDuration,
        },
      },
      tokenBDecimals,
      ActivationType.Timestamp
    );
    const dynamicFeeParams = useDynamicFee ? getDynamicFeeParams(dynamicBaseFeeBps) : null;
    const poolFees = {
      baseFee: baseFeeParams,
      padding: [],
      dynamicFee: dynamicFeeParams,
    };

    const customPoolTx = await cpAmm.createCustomPool({
      payer: wallet.publicKey,
      creator: wallet.publicKey,
      positionNft: positionNft.publicKey,
      tokenAMint,
      tokenBMint,
      tokenAAmount: depositQuote.consumedInputAmount,
      tokenBAmount: depositQuote.outputAmount,
      sqrtMinPrice: configState.sqrtMinPrice,
      sqrtMaxPrice: configState.sqrtMaxPrice,
      initSqrtPrice,
      liquidityDelta: depositQuote.liquidityDelta,
      poolFees,
      hasAlphaVault: true,
      collectFeeMode,
      activationPoint: activationPointTs,
      activationType: ActivationType.Timestamp,
      tokenAProgram,
      tokenBProgram,
      isLockLiquidity,
    });

    tx = customPoolTx.tx;
    pool = customPoolTx.pool;
    poolActivationPointTs = activationPointTs.toString();
  } else {
    pool = derivePoolAddress(config, tokenAMint, tokenBMint);
    try {
      await cpAmm.fetchPoolState(pool);
      console.log(`Pool already exists: ${pool.toBase58()}`);
      console.log("Skip createPool. Use different token mints if you want a new launch.");
      await writePoolOutput({
        outputPath: poolOutputPath,
        poolAddress: pool,
        baseMint: tokenAMint,
        quoteMint: tokenBMint,
        quoteMintType,
        tokenMintOutputPath,
        isAlphaVaultConnected: false,
        poolActivationPointTs: null,
        txSignature: null,
        dryRun: true,
      });
      return;
    } catch {
      // continue
    }

    tx = await cpAmm.createPool({
      payer: wallet.publicKey,
      creator: wallet.publicKey,
      config,
      positionNft: positionNft.publicKey,
      tokenAMint,
      tokenBMint,
      activationPoint: null,
      tokenAAmount: depositQuote.consumedInputAmount,
      tokenBAmount: depositQuote.outputAmount,
      initSqrtPrice,
      liquidityDelta: depositQuote.liquidityDelta,
      tokenAProgram,
      tokenBProgram,
      isLockLiquidity,
    });
  }

  console.log("Prepared DAMM v2 launch transaction");
  console.log(`Pool (derived): ${pool.toBase58()}`);
  console.log(`Token A mint (from output): ${tokenAMint.toBase58()}`);
  console.log(`Quote mint type: ${quoteMintType}`);
  console.log(`Token mint output file: ${resolve(tokenMintOutputPath)}`);
  console.log(`Alpha-vault connected pool: ${connectAlphaVaultPool}`);
  console.log(`Position NFT mint: ${positionNft.publicKey.toBase58()}`);
  console.log(`Token A amount (raw): ${depositQuote.consumedInputAmount.toString()}`);
  console.log(`Token B amount (raw): ${depositQuote.outputAmount.toString()}`);
  console.log(`Liquidity delta: ${depositQuote.liquidityDelta.toString()}`);
  console.log(`Init sqrt price: ${initSqrtPrice.toString()}`);
  console.log(`Dry run: ${dryRun}`);

  if (dryRun) {
    await writePoolOutput({
      outputPath: poolOutputPath,
      poolAddress: pool,
      baseMint: tokenAMint,
      quoteMint: tokenBMint,
      quoteMintType,
      tokenMintOutputPath,
      isAlphaVaultConnected: connectAlphaVaultPool,
      poolActivationPointTs,
      txSignature: null,
      dryRun,
    });
    console.log("DRY_RUN=true so transaction is not sent.");
    console.log(`Saved pool output: ${resolve(poolOutputPath)}`);
    return;
  }

  const signature = await sendAndConfirmTransaction(connection, tx, [wallet, positionNft], {
    commitment: "confirmed",
    skipPreflight: false,
  });

  console.log(`Launch transaction signature: ${signature}`);
  console.log(`Explorer: https://solscan.io/tx/${signature}`);
  console.log(`Pool address: ${pool.toBase58()}`);
  await writePoolOutput({
    outputPath: poolOutputPath,
    poolAddress: pool,
    baseMint: tokenAMint,
    quoteMint: tokenBMint,
    quoteMintType,
    tokenMintOutputPath,
    isAlphaVaultConnected: connectAlphaVaultPool,
    poolActivationPointTs,
    txSignature: signature,
    dryRun,
  });
  console.log(`Saved pool output: ${resolve(poolOutputPath)}`);
}

main().catch((err: unknown) => {
  const error = err instanceof Error ? err.message : String(err);
  console.error("Launch failed:", error);
  process.exit(1);
});
