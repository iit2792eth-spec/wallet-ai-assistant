export type AppSettings = {
  activeModelId: number | null;
  network: { chainId: number; name: string; rpcUrl: string };
  /** Refuse http:// model endpoints and web pages. */
  httpsOnly: boolean;
  /** Uniswap slippage in percent, e.g. 0.5. The user's typed words may ask for more, with an extra confirmation. */
  swapSlippage: number;
};
