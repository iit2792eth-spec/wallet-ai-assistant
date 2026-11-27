// Every limit the access layer enforces, in one place.

export const LIMITS = {
  /** QuickJS heap. */
  memoryBytes: 32 * 1024 * 1024,
  /**
   * QuickJS stack, which bounds recursion depth. Must stay well below the host's
   * own stack: at 512 KB, deep recursion overflowed Node's stack before QuickJS's.
   */
  stackBytes: 128 * 1024,
  /** Time spent executing the program, not counting waits for the user or the network. */
  cpuMs: 2_000,
  /** Total time for one plan, including approval and unlock waits. */
  wallClockMs: 10 * 60 * 1000,
  /** Calls to wallet.*, ui.show and propose together. */
  maxHostCalls: 2_500,
  maxShowCalls: 20,
  /** ui.step lines in the activity stream. */
  maxStepCalls: 15,
  maxStepChars: 100,
  maxProposeCalls: 5,
  /**
   * Actions across the whole program. Not a product limit: the user reviews any
   * number of actions in batches of reviewBatchSize. This ceiling only stops a
   * runaway program (a loop proposing without end).
   */
  maxTotalActions: 1_000,
  /** Actions shown on one approval card; each batch is approved or trimmed on its own. */
  reviewBatchSize: 20,
  /** Extra time the real run gets per action, on top of wallClockMs, for sending and confirmation. */
  wallClockPerActionMs: 15_000,
  /** ui.show content. */
  maxTitleChars: 200,
  maxTextChars: 2_000,
  maxListItems: 50,
  maxListItemChars: 200,
  /** wallet.getHistory. */
  maxHistoryLimit: 50,
  /** Uniswap: warn above this price impact, block above the next one (basis points). */
  swapImpactWarnBps: 200,
  swapImpactBlockBps: 1_000,
  /** Uniswap: how long the router accepts a swap after it is built. */
  swapDeadlineSeconds: 600,
  /** Uniswap: slippage when the setting is missing (basis points). */
  swapDefaultSlippageBps: 50,
  /**
   * Gas limit used when a swap's gas cannot be estimated yet (a token permit is
   * signed only after approval) or for a step that depends on an earlier swap.
   * The real estimate is taken just before sending and must stay within it.
   */
  swapFallbackGas: 350_000,
  transferFallbackGas: 100_000,
  /** A typed-data JSON file. */
  maxTypedDataFileBytes: 256 * 1024,
} as const;
