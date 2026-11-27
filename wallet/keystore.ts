import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bytesToHex, type Hex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { WalletError } from "./errors";
import { shortAddress, walletLog } from "./log";

// The local keystore: one private key, encrypted with the user's password,
// in data/keystore.json. scrypt derives the key from the password; AES-256-GCM
// encrypts and authenticates the private key. The password is never stored.
// While unlocked, the account lives in server memory only, and is dropped on
// lock, after an idle timeout, or when the server stops.

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

/**
 * data/keystore.json, or WALLET_KEYSTORE_PATH (used by tests so they never touch the real keystore).
 * The file calls below carry turbopackIgnore because the path is chosen at run time; without it the
 * build would trace the whole project into the server output.
 */
const keystorePath = () => process.env.WALLET_KEYSTORE_PATH || path.join(process.cwd(), "data", "keystore.json");
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, dklen: 32 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;
/** Locks the wallet after this long without being used. */
export const AUTO_LOCK_MS = 15 * 60 * 1000;

type KeystoreFile = {
  version: 1;
  address: string;
  kdf: "scrypt";
  kdfparams: { N: number; r: number; p: number; dklen: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
};

type Unlocked = { account: PrivateKeyAccount; timer: NodeJS.Timeout };
const globalForWallet = globalThis as unknown as { __unlockedWallet?: Unlocked | null };

async function deriveKey(password: string, salt: Buffer, params: KeystoreFile["kdfparams"]): Promise<Buffer> {
  return scrypt(password, salt, params.dklen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
}

async function readKeystore(): Promise<KeystoreFile | null> {
  let raw: string;
  try {
    raw = await readFile(/*turbopackIgnore: true*/ keystorePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WalletError("KEYSTORE_CORRUPT", { cause: error });
  }
  try {
    const file = JSON.parse(raw) as KeystoreFile;
    if (file.version !== 1 || file.kdf !== "scrypt" || file.cipher !== "aes-256-gcm") throw new Error("unsupported format");
    return file;
  } catch (error) {
    throw new WalletError("KEYSTORE_CORRUPT", { cause: error });
  }
}

async function writeKeystore(privateKey: Hex, password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new WalletError("WEAK_PASSWORD");
  if (await readKeystore()) throw new WalletError("WALLET_EXISTS");

  const address = privateKeyToAccount(privateKey).address;
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const kdfparams = { ...SCRYPT, salt: salt.toString("hex") };
  const key = await deriveKey(password, salt, kdfparams);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);

  const file: KeystoreFile = {
    version: 1,
    address,
    kdf: "scrypt",
    kdfparams,
    cipher: "aes-256-gcm",
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    createdAt: new Date().toISOString(),
  };
  key.fill(0);

  // Write to a temporary file, then rename, so a crash never leaves half a keystore.
  const target = keystorePath();
  await mkdir(/*turbopackIgnore: true*/ path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(/*turbopackIgnore: true*/ temporary, JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" });
  await rename(/*turbopackIgnore: true*/ temporary, target);
  await chmod(/*turbopackIgnore: true*/ target, 0o600);
  return address;
}

function scheduleAutoLock(): NodeJS.Timeout {
  const timer = setTimeout(() => lockWallet("idle"), AUTO_LOCK_MS);
  timer.unref?.();
  return timer;
}

// ---------------------------------------------------------------------------
// Keystore management: one function each.
// ---------------------------------------------------------------------------

export type WalletStatus = {
  /** True once a wallet has been created or imported. */
  exists: boolean;
  /** The wallet's public address, or null if none exists. */
  address: string | null;
  unlocked: boolean;
};

/** Whether a wallet exists and is unlocked. Never fails because the wallet is locked. */
export async function getWalletStatus(): Promise<WalletStatus> {
  const file = await readKeystore();
  return { exists: file !== null, address: file?.address ?? null, unlocked: Boolean(globalForWallet.__unlockedWallet) };
}

/**
 * Creates a new random private key and stores it encrypted with `password`.
 * Requires: no existing wallet; a password of at least 8 characters.
 * Returns the new address. The wallet starts locked.
 * Throws WALLET_EXISTS, WEAK_PASSWORD.
 */
export async function createWallet(input: { password: string }): Promise<{ address: string }> {
  const address = await writeKeystore(generatePrivateKey(), input.password);
  walletLog("created", { address: shortAddress(address) });
  return { address };
}

/**
 * Imports an existing private key (0x + 64 hex) or BIP-39 seed phrase (first
 * account, path m/44'/60'/0'/0/0) and stores it encrypted with `password`.
 * Requires: no existing wallet; a password of at least 8 characters.
 * Returns the address. The wallet starts locked.
 * Throws WALLET_EXISTS, INVALID_SECRET, WEAK_PASSWORD.
 */
export async function importWallet(
  input: { privateKey: string; password: string } | { mnemonic: string; password: string },
): Promise<{ address: string }> {
  let privateKey: Hex;
  try {
    if ("privateKey" in input) {
      const hex = input.privateKey.trim();
      privateKey = (hex.startsWith("0x") ? hex : `0x${hex}`) as Hex;
      privateKeyToAccount(privateKey); // throws if malformed
    } else {
      const key = mnemonicToAccount(input.mnemonic.trim().toLowerCase().split(/\s+/).join(" ")).getHdKey().privateKey;
      if (!key) throw new Error("no key");
      privateKey = bytesToHex(key);
    }
  } catch (error) {
    // No cause attached: viem's error message can contain the secret itself.
    void error;
    throw new WalletError("INVALID_SECRET");
  }
  const address = await writeKeystore(privateKey, input.password);
  walletLog("imported", { address: shortAddress(address), from: "privateKey" in input ? "private key" : "seed phrase" });
  return { address };
}

/**
 * Decrypts the keystore with `password` and keeps the account in memory until
 * lockWallet() is called, the wallet is idle for 15 minutes, or the server stops.
 * Throws WALLET_NOT_FOUND, WRONG_PASSWORD, KEYSTORE_CORRUPT.
 */
/** Decrypts the keystore with the password. Throws WALLET_NOT_FOUND, WRONG_PASSWORD, KEYSTORE_CORRUPT. */
async function decryptAccount(password: string): Promise<PrivateKeyAccount> {
  const file = await readKeystore();
  if (!file) throw new WalletError("WALLET_NOT_FOUND");

  let privateKey: Buffer;
  try {
    const key = await deriveKey(password, Buffer.from(file.kdfparams.salt, "hex"), file.kdfparams);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
    decipher.setAuthTag(Buffer.from(file.tag, "hex"));
    privateKey = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "hex")), decipher.final()]);
    key.fill(0);
  } catch {
    // GCM authentication fails for a wrong password (or a tampered file).
    walletLog("unlock_failed", { reason: "wrong password" });
    throw new WalletError("WRONG_PASSWORD");
  }

  const account = privateKeyToAccount(bytesToHex(privateKey));
  privateKey.fill(0);
  const expected = Buffer.from(file.address.toLowerCase());
  const actual = Buffer.from(account.address.toLowerCase());
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new WalletError("KEYSTORE_CORRUPT");
  return account;
}

/**
 * Decrypts the keystore with `password` and keeps the account in memory until
 * lockWallet() is called, the wallet is idle for 15 minutes, or the server stops.
 * Throws WALLET_NOT_FOUND, WRONG_PASSWORD, KEYSTORE_CORRUPT.
 */
export async function unlockWallet(input: { password: string }): Promise<{ address: string }> {
  const account = await decryptAccount(input.password);
  lockWallet("replaced");
  globalForWallet.__unlockedWallet = { account, timer: scheduleAutoLock() };
  walletLog("unlocked", { address: shortAddress(account.address) });
  return { address: account.address };
}

/**
 * Removes the wallet from this computer: locks it and deletes the keystore file.
 * The key cannot be recovered afterwards unless the user has it elsewhere.
 * Requires the password, so a wallet is never removed by accident or by someone else.
 * Throws WALLET_NOT_FOUND, WRONG_PASSWORD, KEYSTORE_CORRUPT.
 */
export async function removeWallet(input: { password: string }): Promise<{ address: string }> {
  const account = await decryptAccount(input.password);
  lockWallet("replaced");
  await rm(/*turbopackIgnore: true*/ keystorePath(), { force: true });
  walletLog("removed", { address: shortAddress(account.address) });
  return { address: account.address };
}

/** Drops the decrypted account from memory. Safe to call when already locked. */
export function lockWallet(reason: "user" | "idle" | "replaced" = "user"): void {
  const unlocked = globalForWallet.__unlockedWallet;
  if (!unlocked) return;
  clearTimeout(unlocked.timer);
  globalForWallet.__unlockedWallet = null;
  if (reason !== "replaced") walletLog("locked", { reason });
}

/** The unlocked account, for signing inside the wallet layer. Resets the idle timer. Throws WALLET_LOCKED. */
export function requireUnlockedAccount(): PrivateKeyAccount {
  const unlocked = globalForWallet.__unlockedWallet;
  if (!unlocked) throw new WalletError("WALLET_LOCKED");
  clearTimeout(unlocked.timer);
  unlocked.timer = scheduleAutoLock();
  return unlocked.account;
}

/** The wallet's address without unlocking it. Throws WALLET_NOT_FOUND. */
export async function walletAddress(): Promise<`0x${string}`> {
  const file = await readKeystore();
  if (!file) throw new WalletError("WALLET_NOT_FOUND");
  return file.address as `0x${string}`;
}
