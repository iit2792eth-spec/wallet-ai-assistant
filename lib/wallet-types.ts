// Shapes the wallet API returns to the browser.

export type WalletStatus = { exists: boolean; address: string | null; unlocked: boolean };

export type TokenBalance =
  | { token: string; formatted: string; error?: undefined }
  | { token: string; formatted?: undefined; error: string };

/** Fired on window after a wallet change, so every component showing wallet status refreshes. */
export const WALLET_CHANGED_EVENT = "wallet-changed";

/** Fired on window when a plan needs the wallet unlocked; the wallet badge opens the unlock dialog. */
export const WALLET_UNLOCK_REQUESTED_EVENT = "wallet-unlock-requested";
