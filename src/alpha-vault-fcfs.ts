import "dotenv/config";

import BN from "bn.js";
import bs58 from "bs58";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey, clusterApiUrl, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import AlphaVault, {
  PoolType,
  PROGRAM_ID,
  WhitelistMode,
  deriveAlphaVault,
} from "@meteora-ag/alpha-vault";

type QuoteMintType = "WSOL" | "USDC";
type ClusterType = "devnet" | "mainnet-beta";
type WhitelistModeName = "permissionless" | "permission_with_merkle_proof" | "permission_with_authority";

const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const MAINNET_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DEFAULT_TOKEN_MINT_OUTPUT_PATH = "data/latest-token-mint.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";
const DEFAULT_ALPHA_VAULT_OUTPUT_PATH = "data/latest-alpha-vault.json";

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key]?.trim() || defaultValue;
}

function getRequiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function parseWalletSecret(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) return Uint8Array.from(JSON.parse(trimmed) as number[]);
  if (trimmed.includes(",")) return Uint8Array.from(trimmed.split(",").map((x) => Number(x.trim())));
  return bs58.decode(trimmed);
}

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return raw.toLowerCase() === "true";
}

function parseWhitelistMode(value: string): WhitelistMode {
  const normalized = value.toLowerCase() as WhitelistModeName;
  if (normalized === "permission_with_merkle_proof") return WhitelistMode.PermissionWithMerkleProof;
  if (normalized === "permission_with_authority") return WhitelistMode.PermissionWithAuthority;
  return WhitelistMode.Permissionless;
}

function getQuoteMint(cluster: ClusterType, quoteMintType: QuoteMintType): PublicKey {
  if (quoteMintType === "WSOL") return NATIVE_MINT;
  return cluster === "mainnet-beta" ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;
}

function inferCluster(rpcUrl: string): ClusterType {
  const input = rpcUrl.toLowerCase();
  if (input.includes("mainnet")) return "mainnet-beta";
  return "devnet";
}

async function getTokenMintFromOutputFile(pathValue: string): Promise<PublicKey> {
  const absPath = resolve(pathValue);
  const raw = await readFile(absPath, "utf8");
  const parsed = JSON.parse(raw) as { tokenMint?: string };
  if (!parsed.tokenMint) throw new Error(`tokenMint missing in output file: ${absPath}`);
  return new PublicKey(parsed.tokenMint);
}

async function getPoolAddressFromOutputFile(pathValue: string): Promise<PublicKey> {
  const absPath = resolve(pathValue);
  const raw = await readFile(absPath, "utf8");
  const parsed = JSON.parse(raw) as { poolAddress?: string };
  if (!parsed.poolAddress) throw new Error(`poolAddress missing in output file: ${absPath}`);
  return new PublicKey(parsed.poolAddress);
}

async function getPoolTimingFromOutputFile(pathValue: string): Promise<{ poolActivationPointTs: BN | null }> {
  const absPath = resolve(pathValue);
  const raw = await readFile(absPath, "utf8");
  const parsed = JSON.parse(raw) as { poolActivationPointTs?: string | null };
  if (!parsed.poolActivationPointTs) return { poolActivationPointTs: null };
  return { poolActivationPointTs: new BN(parsed.poolActivationPointTs, 10) };
}

async function writeAlphaVaultOutput(params: {
  outputPath: string;
  alphaVaultAddress: PublicKey;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  quoteMintType: QuoteMintType;
  depositingPoint: string;
  startVestingPoint: string;
  endVestingPoint: string;
  maxDepositingCap: string;
  individualDepositingCap: string;
  whitelistMode: string;
  txSignature: string | null;
  dryRun: boolean;
}): Promise<void> {
  const absPath = resolve(params.outputPath);
  await mkdir(resolve(absPath, ".."), { recursive: true });
  await writeFile(
    absPath,
    JSON.stringify(
      {
        alphaVaultAddress: params.alphaVaultAddress.toBase58(),
        poolAddress: params.poolAddress.toBase58(),
        baseMint: params.baseMint.toBase58(),
        quoteMint: params.quoteMint.toBase58(),
        quoteMintType: params.quoteMintType,
        depositingPoint: params.depositingPoint,
        startVestingPoint: params.startVestingPoint,
        endVestingPoint: params.endVestingPoint,
        maxDepositingCap: params.maxDepositingCap,
        individualDepositingCap: params.individualDepositingCap,
        whitelistMode: params.whitelistMode,
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
  const rpcUrl = process.env.RPC_URL?.trim() || clusterApiUrl("devnet");
  const cluster = (process.env.CLUSTER?.trim() as ClusterType | undefined) || inferCluster(rpcUrl);
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));

  const quoteMintType = (getEnvOrDefault("QUOTE_MINT_TYPE", "WSOL").toUpperCase() as QuoteMintType);
  if (!["WSOL", "USDC"].includes(quoteMintType)) throw new Error("QUOTE_MINT_TYPE must be WSOL or USDC");

  const tokenMintOutputPath =
    process.env.TOKEN_MINT_OUTPUT_PATH?.trim() || DEFAULT_TOKEN_MINT_OUTPUT_PATH;
  const poolOutputPath = process.env.POOL_OUTPUT_PATH?.trim() || DEFAULT_POOL_OUTPUT_PATH;
  const alphaVaultOutputPath =
    process.env.ALPHA_VAULT_OUTPUT_PATH?.trim() || DEFAULT_ALPHA_VAULT_OUTPUT_PATH;

  const baseMint = await getTokenMintFromOutputFile(tokenMintOutputPath);
  const quoteMint = getQuoteMint(cluster, quoteMintType);
  const poolAddress = process.env.POOL_ADDRESS?.trim()
    ? new PublicKey(process.env.POOL_ADDRESS.trim())
    : await getPoolAddressFromOutputFile(poolOutputPath);
  const { poolActivationPointTs } = await getPoolTimingFromOutputFile(poolOutputPath);

  const now = Math.floor(Date.now() / 1000);
  const defaultDepositingPoint = (() => {
    if (!poolActivationPointTs) return now + 5 * 60;
    // For DAMM v2 timestamp mode: lastJoinPoint ~= activationPoint - 3900.
    const latestSafeJoin = Number(poolActivationPointTs.sub(new BN(3900)).toString());
    const candidate = Math.min(now + 60, latestSafeJoin - 60);
    return candidate;
  })();
  if (poolActivationPointTs && defaultDepositingPoint <= now) {
    throw new Error(
      "Pool activation is too close/past for FCFS depositing window. Recreate pool with later activation point."
    );
  }
  const defaultStartVestingPoint = poolActivationPointTs
    ? Number(poolActivationPointTs.add(new BN(60)).toString())
    : now + 70 * 60;
  const defaultEndVestingPoint = defaultStartVestingPoint + 24 * 60 * 60;

  const depositingPoint = new BN(
    getEnvOrDefault("ALPHA_FCFS_DEPOSITING_POINT", String(defaultDepositingPoint)),
    10
  );
  const startVestingPoint = new BN(
    getEnvOrDefault("ALPHA_FCFS_START_VESTING_POINT", String(defaultStartVestingPoint)),
    10
  );
  const endVestingPoint = new BN(
    getEnvOrDefault("ALPHA_FCFS_END_VESTING_POINT", String(defaultEndVestingPoint)),
    10
  );
  const maxDepositingCap = new BN(getRequiredEnv("ALPHA_FCFS_MAX_DEPOSITING_CAP_RAW"), 10);
  const individualDepositingCap = new BN(
    getEnvOrDefault("ALPHA_FCFS_INDIVIDUAL_CAP_RAW", maxDepositingCap.toString()),
    10
  );
  const escrowFee = new BN(getEnvOrDefault("ALPHA_FCFS_ESCROW_FEE_RAW", "0"), 10);
  const whitelistModeRaw = getEnvOrDefault("ALPHA_FCFS_WHITELIST_MODE", "permissionless");
  const whitelistMode = parseWhitelistMode(whitelistModeRaw);
  const dryRun = parseBool(process.env.DRY_RUN, true);

  const alphaVaultProgramId = new PublicKey(PROGRAM_ID[cluster]);
  const [alphaVaultAddress] = deriveAlphaVault(wallet.publicKey, poolAddress, alphaVaultProgramId);
  const connection = new Connection(rpcUrl, "confirmed");

  const existing = await connection.getAccountInfo(alphaVaultAddress);
  if (existing) {
    console.log(`Alpha Vault already exists: ${alphaVaultAddress.toBase58()}`);
    await writeAlphaVaultOutput({
      outputPath: alphaVaultOutputPath,
      alphaVaultAddress,
      poolAddress,
      baseMint,
      quoteMint,
      quoteMintType,
      depositingPoint: depositingPoint.toString(),
      startVestingPoint: startVestingPoint.toString(),
      endVestingPoint: endVestingPoint.toString(),
      maxDepositingCap: maxDepositingCap.toString(),
      individualDepositingCap: individualDepositingCap.toString(),
      whitelistMode: whitelistModeRaw,
      txSignature: null,
      dryRun,
    });
    console.log(`Saved: ${resolve(alphaVaultOutputPath)}`);
    return;
  }

  const tx = await AlphaVault.createCustomizableFcfsVault(
    connection,
    {
      quoteMint,
      baseMint,
      poolAddress,
      poolType: PoolType.DAMMV2,
      depositingPoint,
      startVestingPoint,
      endVestingPoint,
      maxDepositingCap,
      individualDepositingCap,
      escrowFee,
      whitelistMode,
    },
    wallet.publicKey,
    { cluster }
  );

  console.log("Prepared FCFS Alpha Vault creation transaction");
  console.log(`Alpha Vault (derived): ${alphaVaultAddress.toBase58()}`);
  console.log(`Pool address: ${poolAddress.toBase58()}`);
  console.log(`Base mint: ${baseMint.toBase58()}`);
  console.log(`Quote mint (${quoteMintType}): ${quoteMint.toBase58()}`);
  console.log(`Dry run: ${dryRun}`);

  if (dryRun) {
    await writeAlphaVaultOutput({
      outputPath: alphaVaultOutputPath,
      alphaVaultAddress,
      poolAddress,
      baseMint,
      quoteMint,
      quoteMintType,
      depositingPoint: depositingPoint.toString(),
      startVestingPoint: startVestingPoint.toString(),
      endVestingPoint: endVestingPoint.toString(),
      maxDepositingCap: maxDepositingCap.toString(),
      individualDepositingCap: individualDepositingCap.toString(),
      whitelistMode: whitelistModeRaw,
      txSignature: null,
      dryRun,
    });
    console.log("DRY_RUN=true so transaction is not sent.");
    console.log(`Saved: ${resolve(alphaVaultOutputPath)}`);
    return;
  }

  const signature = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: "confirmed",
    skipPreflight: false,
  });

  await writeAlphaVaultOutput({
    outputPath: alphaVaultOutputPath,
    alphaVaultAddress,
    poolAddress,
    baseMint,
    quoteMint,
    quoteMintType,
    depositingPoint: depositingPoint.toString(),
    startVestingPoint: startVestingPoint.toString(),
    endVestingPoint: endVestingPoint.toString(),
    maxDepositingCap: maxDepositingCap.toString(),
    individualDepositingCap: individualDepositingCap.toString(),
    whitelistMode: whitelistModeRaw,
    txSignature: signature,
    dryRun,
  });

  console.log(`Alpha Vault tx: ${signature}`);
  console.log(`Explorer: https://solscan.io/tx/${signature}${cluster === "devnet" ? "?cluster=devnet" : ""}`);
  console.log(`Saved: ${resolve(alphaVaultOutputPath)}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Alpha Vault FCFS creation failed: ${message}`);
  process.exit(1);
});
