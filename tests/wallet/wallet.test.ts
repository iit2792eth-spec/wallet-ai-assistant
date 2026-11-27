import "./setup";
import { rmSync, writeFileSync } from "node:fs";
import { custom, type EIP1193RequestFn } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { redact } from "@/lib/logger";
import { setTransportFactoryForTests } from "@/wallet/clients";
import { toWalletError } from "@/wallet/errors";
import {
  WalletError,
  createWallet,
  estimateTransfer,
  getActivity,
  getBalance,
  getWalletStatus,
  importWallet,
  lockWallet,
  removeWallet,
  signTypedData,
  transfer,
  unlockWallet,
} from "@/wallet";

// Wallet layer tests. A fake RPC stands in for the network: no request leaves the machine.

// Hardhat's well-known first test key. Never use it with real funds.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_SEED = "test test test test test test test test test test test junk";
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PASSWORD = "correct horse battery";
const TX_HASH = `0x${"ab".repeat(32)}` as const;

type Handler = (method: string, params: unknown[]) => unknown;
const rpcCalls: string[] = [];

/** A fake JSON-RPC node. `overrides` replace individual methods. */
function fakeRpc(overrides: Record<string, Handler> = {}) {
  const defaults: Record<string, Handler> = {
    eth_chainId: () => "0xaa36a7", // Sepolia
    eth_blockNumber: () => "0x10",
    eth_getBalance: () => "0xde0b6b3a7640000", // 1 ETH
    eth_call: () => `0x${(25_000_000).toString(16).padStart(64, "0")}`, // 25 USDC
    eth_getTransactionCount: () => "0x0",
    eth_estimateGas: () => "0x5208",
    eth_maxPriorityFeePerGas: () => "0x3b9aca00",
    eth_gasPrice: () => "0x3b9aca00",
    eth_getBlockByNumber: () => ({ number: "0x10", baseFeePerGas: "0x3b9aca00", hash: TX_HASH, timestamp: "0x1", transactions: [] }),
    eth_sendRawTransaction: () => TX_HASH,
    eth_getTransactionReceipt: () => ({
      status: "0x1", blockNumber: "0x11", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00",
      transactionHash: TX_HASH, blockHash: TX_HASH, transactionIndex: "0x0", from: TEST_ADDRESS, to: RECIPIENT,
      cumulativeGasUsed: "0x5208", logs: [], logsBloom: `0x${"0".repeat(512)}`, type: "0x2", contractAddress: null,
    }),
  };
  const handlers = { ...defaults, ...overrides };
  const request = (async ({ method, params }: { method: string; params?: unknown[] }) => {
    rpcCalls.push(method);
    const handler = handlers[method];
    if (!handler) throw new Error(`fake RPC: no handler for ${method}`);
    return handler(method, params ?? []);
  }) as EIP1193RequestFn;
  setTransportFactoryForTests(() => custom({ request }, { retryCount: 0 }));
}

const rpcError = (message: string) => () => {
  throw Object.assign(new Error(message), { code: -32000 });
};

beforeEach(() => {
  rpcCalls.length = 0;
  lockWallet();
  rmSync(process.env.WALLET_KEYSTORE_PATH!, { force: true });
  fakeRpc();
});
afterEach(() => setTransportFactoryForTests(null));

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(WalletError);
  expect((error as WalletError).code).toBe(code);
};

describe("keystore", () => {
  it("reports no wallet before one is created", async () => {
    expect(await getWalletStatus()).toEqual({ exists: false, address: null, unlocked: false });
  });

  it("creates a wallet that starts locked", async () => {
    const { address } = await createWallet({ password: PASSWORD });
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(await getWalletStatus()).toEqual({ exists: true, address, unlocked: false });
  });

  it("imports a private key and unlocks it with the right password", async () => {
    expect((await importWallet({ privateKey: TEST_KEY, password: PASSWORD })).address).toBe(TEST_ADDRESS);
    expect((await unlockWallet({ password: PASSWORD })).address).toBe(TEST_ADDRESS);
    expect((await getWalletStatus()).unlocked).toBe(true);
  });

  it("imports a seed phrase (first account)", async () => {
    expect((await importWallet({ mnemonic: TEST_SEED, password: PASSWORD })).address).toBe(TEST_ADDRESS);
  });

  it("rejects a wrong password", async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    await expectCode(unlockWallet({ password: "wrong password" }), "WRONG_PASSWORD");
    expect((await getWalletStatus()).unlocked).toBe(false);
  });

  it("never overwrites an existing wallet", async () => {
    await createWallet({ password: PASSWORD });
    await expectCode(importWallet({ privateKey: TEST_KEY, password: PASSWORD }), "WALLET_EXISTS");
  });

  it("rejects a short password", async () => {
    await expectCode(createWallet({ password: "short" }), "WEAK_PASSWORD");
  });

  it("rejects a malformed private key without echoing it", async () => {
    const error = await importWallet({ privateKey: "0x1234", password: PASSWORD }).catch((e: WalletError) => e);
    expect((error as WalletError).code).toBe("INVALID_SECRET");
    expect(JSON.stringify(error)).not.toContain("0x1234");
  });

  it("reports a damaged keystore file", async () => {
    writeFileSync(process.env.WALLET_KEYSTORE_PATH!, "{ not json");
    await expectCode(unlockWallet({ password: PASSWORD }), "KEYSTORE_CORRUPT");
  });

  it("does not store the private key or password in the file", async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    const { readFileSync } = await import("node:fs");
    const file = readFileSync(process.env.WALLET_KEYSTORE_PATH!, "utf8");
    expect(file).not.toContain(TEST_KEY.slice(2));
    expect(file).not.toContain(PASSWORD);
  });

  it("removes the wallet with the right password", async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    await unlockWallet({ password: PASSWORD });
    expect((await removeWallet({ password: PASSWORD })).address).toBe(TEST_ADDRESS);
    expect(await getWalletStatus()).toEqual({ exists: false, address: null, unlocked: false });
    await expectCode(signTypedData({ typedData: PERMIT }), "WALLET_LOCKED");
  });

  it("keeps the wallet when the removal password is wrong", async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    await expectCode(removeWallet({ password: "wrong password" }), "WRONG_PASSWORD");
    expect((await getWalletStatus()).exists).toBe(true);
  });

  it("allows a new wallet after removal", async () => {
    await createWallet({ password: PASSWORD });
    await removeWallet({ password: PASSWORD });
    expect((await importWallet({ privateKey: TEST_KEY, password: PASSWORD })).address).toBe(TEST_ADDRESS);
  });

  it("forgets the key when locked", async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    await unlockWallet({ password: PASSWORD });
    lockWallet();
    await expectCode(signTypedData({ typedData: PERMIT }), "WALLET_LOCKED");
  });
});

describe("getBalance", () => {
  it("reads the user's ETH balance", async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    const result = await getBalance({ token: "ETH" });
    expect(result).toMatchObject({ token: "ETH", address: TEST_ADDRESS, amount: BigInt("1000000000000000000"), formatted: "1", chainId: 11155111 });
    expect(rpcCalls).toContain("eth_getBalance");
  });

  it("reads a USDC balance through the token contract", async () => {
    const result = await getBalance({ token: "USDC", address: RECIPIENT });
    expect(result).toMatchObject({ token: "USDC", amount: BigInt(25_000_000), formatted: "25", decimals: 6 });
    expect(rpcCalls).toContain("eth_call");
  });

  it("does not need the wallet to be unlocked", async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    await expect(getBalance({ token: "ETH" })).resolves.toBeTruthy();
  });

  it("reports a token with no contract on this network", async () => {
    // EURC is configured on Sepolia; take its row out of the in-memory test database to simulate a network without it.
    const row = getDb().prepare("SELECT * FROM tokens WHERE symbol = 'EURC'").get() as Record<string, unknown>;
    getDb().prepare("DELETE FROM tokens WHERE symbol = 'EURC'").run();
    try {
      await expectCode(getBalance({ token: "EURC", address: RECIPIENT }), "TOKEN_NOT_CONFIGURED");
    } finally {
      getDb().prepare("INSERT INTO tokens (chain_id, symbol, address, decimals) VALUES (@chain_id, @symbol, @address, @decimals)").run(row);
    }
  });

  it("reads an EURC balance from Circle's Sepolia contract", async () => {
    let target = "";
    fakeRpc({
      eth_call: (_method, params) => {
        target = (params[0] as { to: string }).to.toLowerCase();
        return `0x${(7_500_000).toString(16).padStart(64, "0")}`;
      },
    });
    const balance = await getBalance({ token: "EURC", address: RECIPIENT });
    expect(target).toBe("0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4");
    expect(balance).toMatchObject({ token: "EURC", decimals: 6, formatted: "7.5" });
  });

  it("reports an unreachable network", async () => {
    fakeRpc({ eth_blockNumber: () => { throw new Error("connect ECONNREFUSED"); } });
    const error = await getBalance({ token: "ETH", address: RECIPIENT }).catch((e: WalletError) => e);
    expect(error).toBeInstanceOf(WalletError);
  });
});

describe("transfer", () => {
  beforeEach(async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    await unlockWallet({ password: PASSWORD });
  });

  it("sends ETH and returns the confirmed result", async () => {
    const result = await transfer({ token: "ETH", to: RECIPIENT, amount: BigInt("10000000000000000") });
    expect(result).toMatchObject({
      status: "confirmed", hash: TX_HASH, from: TEST_ADDRESS, to: RECIPIENT, formatted: "0.01",
      blockNumber: BigInt(17), feeWei: BigInt(21000) * BigInt(1_000_000_000),
      explorerUrl: `https://sepolia.etherscan.io/tx/${TX_HASH}`,
    });
    expect(rpcCalls).toContain("eth_sendRawTransaction");
  });

  it("sends USDC through the token contract", async () => {
    const result = await transfer({ token: "USDC", to: RECIPIENT, amount: BigInt(5_000_000) });
    expect(result).toMatchObject({ status: "confirmed", token: "USDC", formatted: "5" });
  });

  it("returns a mined but failed transaction as reverted", async () => {
    fakeRpc({
      eth_getTransactionReceipt: () => ({
        status: "0x0", blockNumber: "0x11", gasUsed: "0x5208", effectiveGasPrice: "0x1", transactionHash: TX_HASH,
        blockHash: TX_HASH, transactionIndex: "0x0", from: TEST_ADDRESS, to: RECIPIENT, cumulativeGasUsed: "0x5208",
        logs: [], logsBloom: `0x${"0".repeat(512)}`, type: "0x2", contractAddress: null,
      }),
    });
    expect((await transfer({ token: "ETH", to: RECIPIENT, amount: BigInt(1) })).status).toBe("reverted");
  });

  it("returns pending when the transaction is not mined in time", async () => {
    fakeRpc({ eth_getTransactionReceipt: () => null });
    const result = await transfer({ token: "ETH", to: RECIPIENT, amount: BigInt(1), waitMs: 300 });
    expect(result).toMatchObject({ status: "pending", hash: TX_HASH, blockNumber: null });
  });

  it("never sends below the intrinsic gas minimum when the node under-estimates a zero-value probe", async () => {
    // Some nodes return 15000 gas for a 0-value probe; a real transfer needs 21000.
    fakeRpc({ eth_estimateGas: (params) => (BigInt((params[0] as { value?: string }).value ?? "0x0") === BigInt(0) ? "0x3a98" : "0x5208") });
    const { gas, maxFeePerGas, maxFeeWei } = await estimateTransfer({ token: "ETH", to: RECIPIENT, amount: BigInt(0) });
    expect(gas).toBe(BigInt(21000));
    expect(maxFeeWei).toBe(BigInt(21000) * maxFeePerGas);
    // And a transfer sent with that floored estimate broadcasts (the node no longer rejects it).
    const result = await transfer({ token: "ETH", to: RECIPIENT, amount: BigInt("10000000000000000"), fees: { gas, maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas } });
    expect(result.status).toBe("confirmed");
  });

  it("needs the wallet to be unlocked", async () => {
    lockWallet();
    await expectCode(transfer({ token: "ETH", to: RECIPIENT, amount: BigInt(1) }), "WALLET_LOCKED");
    expect(rpcCalls).not.toContain("eth_sendRawTransaction");
  });

  it("reports insufficient funds", async () => {
    fakeRpc({ eth_estimateGas: rpcError("insufficient funds for gas * price + value") });
    await expectCode(transfer({ token: "ETH", to: RECIPIENT, amount: BigInt(1) }), "INSUFFICIENT_FUNDS");
  });

  it("reports a token transfer the contract rejects", async () => {
    fakeRpc({ eth_estimateGas: rpcError("execution reverted: ERC20: transfer amount exceeds balance") });
    await expectCode(transfer({ token: "USDC", to: RECIPIENT, amount: BigInt(1) }), "TRANSFER_REVERTED");
  });

  it("reports a nonce conflict as retryable", async () => {
    fakeRpc({ eth_sendRawTransaction: rpcError("nonce too low") });
    const error = await transfer({ token: "ETH", to: RECIPIENT, amount: BigInt(1) }).catch((e: WalletError) => e);
    expect(error).toMatchObject({ code: "NONCE_CONFLICT", retryable: true });
  });
});

const PERMIT = {
  domain: { name: "USD Coin", version: "2", chainId: 11155111, verifyingContract: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const },
  types: {
    Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit" as const,
  message: { owner: TEST_ADDRESS, spender: RECIPIENT, value: BigInt(25_000_000), nonce: BigInt(0), deadline: BigInt(1_800_000_000) },
};

describe("signTypedData", () => {
  it("signs EIP-712 data and returns a verifiable signature", async () => {
    await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
    await unlockWallet({ password: PASSWORD });
    const result = await signTypedData({ typedData: PERMIT });
    const { verifyTypedData } = await import("viem");
    expect(result.signer).toBe(TEST_ADDRESS);
    expect(result.primaryType).toBe("Permit");
    expect(await verifyTypedData({ ...PERMIT, address: TEST_ADDRESS, signature: result.signature })).toBe(true);
    expect(rpcCalls).toEqual([]); // off-chain: no network
  });
});

describe("getActivity", () => {
  beforeEach(() => {
    const db = getDb();
    db.exec("DROP TRIGGER IF EXISTS actions_no_delete; DELETE FROM actions;");
    const insert = db.prepare(
      `INSERT INTO actions (session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id, to_address, to_label,
         to_provenance, amount, td_primary_type, td_domain, td_hash, status, tx_hash, created_at)
       VALUES (?, ?, 0, ?, 11155111, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("s", "p1", "transfer", TEST_ADDRESS, 1, RECIPIENT, "Darshan", "contact", "10000000000000000", null, null, null, "confirmed", TX_HASH, 100);
    insert.run("s", "p2", "transfer", TEST_ADDRESS, 2, RECIPIENT, null, "user", "5000000", null, null, null, "failed", null, 200);
    insert.run("s", "p3", "sign_typed_data", TEST_ADDRESS, null, null, null, null, null, "Permit", "{}", TX_HASH, "signed", null, 300);
  });

  it("returns this app's activity, newest first, with amounts formatted", async () => {
    const entries = await getActivity();
    expect(entries.map((e) => e.kind)).toEqual(["sign_typed_data", "transfer", "transfer"]);
    expect(entries[2]).toMatchObject({ to: RECIPIENT, toLabel: "Darshan", token: "ETH", amount: BigInt("10000000000000000"), formatted: "0.01", txHash: TX_HASH, status: "confirmed" });
    expect(entries[1]).toMatchObject({ token: "USDC", formatted: "5", status: "failed" });
  });

  it("filters by kind and limits the count", async () => {
    expect((await getActivity({ kind: "transfer", limit: 1 })).map((e) => e.timestamp)).toEqual([200]);
  });
});

describe("errors and logging", () => {
  it("never puts private data in an error shown to the user", () => {
    const error = toWalletError(new Error(`boom ${TEST_KEY}`));
    expect(JSON.stringify(error)).not.toContain(TEST_KEY);
    expect(error.toJSON()).toEqual({ code: "UNKNOWN", message: "Something went wrong in the wallet.", retryable: false });
  });

  it("shortens addresses and removes keys in log lines", () => {
    const line = redact(`to ${RECIPIENT} with ${TEST_KEY}`);
    expect(line).toBe("to 0x7099…79C8 with [redacted-hex]");
  });
});
