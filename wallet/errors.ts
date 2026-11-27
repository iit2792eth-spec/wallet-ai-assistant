import {
  BaseError,
  ContractFunctionRevertedError,
  FeeCapTooLowError,
  HttpRequestError,
  InsufficientFundsError,
  IntrinsicGasTooLowError,
  NonceTooHighError,
  NonceTooLowError,
  RpcRequestError,
  TimeoutError,
} from "viem";

// Every failure in the wallet layer is thrown as a WalletError. The access
// layer can switch on `code`, show `message` to the user, and use `retryable`
// to decide whether to offer a retry. Messages never contain private data.

export type WalletErrorCode =
  | "WALLET_NOT_FOUND" // no keystore yet: create or import a wallet first
  | "WALLET_EXISTS" // a keystore already exists; it is never overwritten
  | "WALLET_LOCKED" // signing needs the wallet to be unlocked
  | "WRONG_PASSWORD"
  | "WEAK_PASSWORD" // shorter than 8 characters
  | "KEYSTORE_CORRUPT" // the keystore file cannot be read
  | "INVALID_SECRET" // an imported private key or seed phrase is malformed
  | "TOKEN_NOT_CONFIGURED" // no contract address for this token on the active network
  | "PERMIT_NOT_SUPPORTED" // the token contract has no EIP-2612 permit
  | "NETWORK_NOT_CONFIGURED"
  | "HTTPS_REQUIRED" // HTTPS only is on and the RPC URL is not https
  | "DEX_NOT_CONFIGURED" // no Uniswap contracts for this network
  | "NO_SWAP_ROUTE" // no Uniswap pool can quote this swap
  | "INSUFFICIENT_FUNDS" // not enough ETH for the amount plus gas
  | "TRANSFER_REVERTED" // the token contract refused the transfer, e.g. not enough tokens
  | "NONCE_CONFLICT" // another transaction from this account is in flight
  | "FEE_TOO_LOW"
  | "RPC_UNAVAILABLE" // the node could not be reached or timed out
  | "RPC_ERROR" // the node answered with an error
  | "UNKNOWN";

const MESSAGES: Record<WalletErrorCode, string> = {
  WALLET_NOT_FOUND: "No wallet is set up yet. Create or import one in Settings.",
  WALLET_EXISTS: "A wallet is already set up on this computer.",
  WALLET_LOCKED: "The wallet is locked. Unlock it with your password and try again.",
  WRONG_PASSWORD: "The password is not correct.",
  WEAK_PASSWORD: "The password must be at least 8 characters.",
  KEYSTORE_CORRUPT: "The wallet file could not be read. It may be damaged.",
  INVALID_SECRET: "That private key or seed phrase is not valid.",
  TOKEN_NOT_CONFIGURED: "This token is not available on the current network.",
  PERMIT_NOT_SUPPORTED: "This token does not support signed permits (EIP-2612).",
  NETWORK_NOT_CONFIGURED: "The current network is not configured.",
  DEX_NOT_CONFIGURED: "Swaps are not available on the current network.",
  NO_SWAP_ROUTE: "No Uniswap pool on this network can quote this swap. The pair may have no pool, or not enough liquidity for this amount.",
  HTTPS_REQUIRED: "The RPC URL is not https, and HTTPS only is on. Use an https:// RPC URL, or turn HTTPS only off in Settings.",
  INSUFFICIENT_FUNDS: "There is not enough ETH to cover the amount and the network fee.",
  TRANSFER_REVERTED: "The token contract rejected the transfer. The balance may be too low.",
  NONCE_CONFLICT: "Another transaction from this wallet is still being processed. Try again shortly.",
  FEE_TOO_LOW: "The network fee was too low for the network to accept the transaction. Try again.",
  RPC_UNAVAILABLE: "The network could not be reached. Check the RPC URL in Settings or try again.",
  RPC_ERROR: "The network returned an error.",
  UNKNOWN: "Something went wrong in the wallet.",
};

const RETRYABLE = new Set<WalletErrorCode>(["NONCE_CONFLICT", "FEE_TOO_LOW", "RPC_UNAVAILABLE", "RPC_ERROR"]);

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly retryable: boolean;

  /** `message` replaces the standard text for this code when the caller knows more (e.g. ETH sent to a contract). */
  constructor(code: WalletErrorCode, options?: { cause?: unknown; message?: string }) {
    super(options?.message ?? MESSAGES[code], options);
    this.name = "WalletError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }

  /** Safe to pass on to the access layer, the sandbox and the user. */
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** Turns any error from viem or the RPC into a WalletError with a safe message. */
export function toWalletError(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  if (error instanceof BaseError) {
    const match = (type: new (...args: never[]) => Error) => error.walk((e) => e instanceof type);
    if (match(InsufficientFundsError)) return new WalletError("INSUFFICIENT_FUNDS", { cause: error });
    if (match(ContractFunctionRevertedError)) return new WalletError("TRANSFER_REVERTED", { cause: error });
    if (match(NonceTooLowError) || match(NonceTooHighError)) return new WalletError("NONCE_CONFLICT", { cause: error });
    if (match(FeeCapTooLowError) || match(IntrinsicGasTooLowError)) return new WalletError("FEE_TOO_LOW", { cause: error });
    if (match(HttpRequestError) || match(TimeoutError)) return new WalletError("RPC_UNAVAILABLE", { cause: error });
    // Some nodes report these as plain RPC errors with only a message.
    const details = error.details?.toLowerCase() ?? "";
    if (details.includes("insufficient funds")) return new WalletError("INSUFFICIENT_FUNDS", { cause: error });
    if (details.includes("execution reverted")) return new WalletError("TRANSFER_REVERTED", { cause: error });
    if (details.includes("nonce")) return new WalletError("NONCE_CONFLICT", { cause: error });
    if (match(RpcRequestError)) return new WalletError("RPC_ERROR", { cause: error });
  }
  return new WalletError("UNKNOWN", { cause: error });
}
