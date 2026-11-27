import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { formatUnits } from "viem";
import { ENCODING_PRELUDE, UNIT_DECIMALS, UTIL_PRELUDE, bigintReplacer, bigintReviver, nowPrelude, tablesPrelude, type SandboxTable } from "@/lib/sandbox-prelude";

// Runs generated code in QuickJS against fake wallet functions and sample data.
// No chain, no network, no real data: the spec allows this for the Code Verifier.
// It catches errors that only show up when the code runs (for example mixing
// BigInt and Number), and records what the code would show and propose, so the
// model reviewer can judge behaviour instead of guessing from the source.

export type FakeHistoryEntry = { to: string; toLabel?: string | null; token: string; amount: bigint };

export type Fakes = {
  history?: FakeHistoryEntry[];
  balances?: Record<string, bigint>;
  /** What propose() returns. */
  approve?: boolean;
};

export type DryRun = {
  /** Every ui.show() call, in order. */
  shown: unknown[];
  /** One entry per propose() call, plus returned actions if the code returned any. */
  proposals: unknown[][];
  /** Set if the code threw, timed out or did not finish. */
  error: string | null;
  /** ui.show and propose calls in the order they happened. */
  events: ({ kind: "show"; content: unknown } | { kind: "propose"; actions: unknown[] })[];
};

const DECIMALS = UNIT_DECIMALS;

/** Sample data used by the Code Verifier. Labelled so nobody mistakes it for the user's data. */
export const SAMPLE_FAKES: Fakes = {
  balances: {
    ETH: BigInt("1000000000000000000"), // 1 ETH
    USDC: BigInt(100_000_000), // 100 USDC
    EURC: BigInt(100_000_000), // 100 EURC
  },
  history: [
    { to: "sample-recipient-1", toLabel: null, token: "ETH", amount: BigInt("10000000000000000") }, // 0.01 ETH
    { to: "sample-recipient-2", toLabel: null, token: "USDC", amount: BigInt(5_000_000) }, // 5 USDC
    { to: "sample-recipient-1", toLabel: null, token: "ETH", amount: BigInt("20000000000000000") }, // 0.02 ETH
  ],
  approve: true,
};

/** Sample prices for the dry run: 1 ETH = 2,000 USDC = 2,000 EURC (not real prices). */
const SAMPLE_PRICE: Record<string, number> = { ETH: 2000, USDC: 1, EURC: 1 };

function sampleQuote(options: Record<string, unknown> | undefined): { amountIn: bigint; amountOut: bigint; priceImpact: number } {
  const tokenIn = String(options?.tokenIn ?? "").toUpperCase();
  const tokenOut = String(options?.tokenOut ?? "").toUpperCase();
  const din = DECIMALS[tokenIn];
  const dout = DECIMALS[tokenOut];
  if (din === undefined || dout === undefined || !SAMPLE_PRICE[tokenIn] || !SAMPLE_PRICE[tokenOut] || tokenIn === tokenOut) throw new Error("wallet.quoteSwap: unsupported pair");
  // Exchange rate as a fraction in base units: out = in * priceIn * 10^dout / (priceOut * 10^din).
  const num = BigInt(SAMPLE_PRICE[tokenIn]) * BigInt(10) ** BigInt(dout);
  const den = BigInt(SAMPLE_PRICE[tokenOut]) * BigInt(10) ** BigInt(din);
  if (typeof options?.amountIn === "bigint") return { amountIn: options.amountIn, amountOut: (options.amountIn * num) / den, priceImpact: 0.1 };
  if (typeof options?.amountOut === "bigint") return { amountIn: (options.amountOut * den + num - BigInt(1)) / num, amountOut: options.amountOut, priceImpact: 0.1 };
  throw new Error("wallet.quoteSwap: give amountIn or amountOut");
}

/** Sample network fee: 21,000 gas at 2 gwei. */
const SAMPLE_FEE_WEI = BigInt(42_000_000_000_000);

const RUN_TIMEOUT_MS = 2000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const MAX_RECORDED_CALLS = 50;


// Runs inside QuickJS. Values cross the boundary as JSON strings, with BigInt tagged.
// The helpers mirror the manifest's util functions.
const prelude = (tables: SandboxTable[] = []) => `${ENCODING_PRELUDE}
const __call = (name, ...args) => __dec(__host(name, __enc(args)));
const wallet = {
  getBalance: async (options) => __call("wallet.getBalance", options),
  estimateFee: async (options) => __call("wallet.estimateFee", options),
  quoteSwap: async (options) => __call("wallet.quoteSwap", options),
  getHistory: async (options) => __call("wallet.getHistory", options),
  resolveEns: async (name) => __call("wallet.resolveEns", name),
  lookupEns: async (address) => __call("wallet.lookupEns", address),
};
const ui = { show: (content) => { __call("ui.show", content); }, step: (text) => { __call("ui.step", text); } };
const propose = async (actions) => __call("propose", actions);
${UTIL_PRELUDE}
${nowPrelude(Date.now() / 1000)}
${tablesPrelude(tables)}
globalThis.__done = "";
`;

/** `tables`: the request's document tables (placeholders for addresses), for external.rows(). */
export async function dryRun(code: string, fakes: Fakes = SAMPLE_FAKES, tables: SandboxTable[] = []): Promise<DryRun> {
  const run: DryRun = { shown: [], proposals: [], error: null, events: [] };
  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  vm.runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + RUN_TIMEOUT_MS));

  const host = (name: string, args: unknown[]): unknown => {
    const first = args[0] as Record<string, unknown> | undefined;
    switch (name) {
      case "wallet.getBalance":
        return fakes.balances?.[String(first?.token).toUpperCase()] ?? BigInt(0);
      case "wallet.getHistory": {
        const all = fakes.history ?? [];
        return typeof first?.limit === "number" ? all.slice(0, Math.max(0, first.limit)) : all;
      }
      case "wallet.estimateFee":
        return SAMPLE_FEE_WEI;
      case "wallet.quoteSwap":
        return sampleQuote(first);
      case "wallet.resolveEns":
        return `sample-address-of-${String(args[0])}`;
      case "wallet.lookupEns":
        return null;
      case "ui.step":
        return null;
      case "ui.show":
        if (run.shown.length < MAX_RECORDED_CALLS) {
          run.shown.push(first);
          run.events.push({ kind: "show", content: first });
        }
        return null;
      case "propose": {
        if (run.proposals.length < MAX_RECORDED_CALLS) {
          const actions = Array.isArray(args[0]) ? args[0] : [args[0]];
          run.proposals.push(actions);
          run.events.push({ kind: "propose", actions });
        }
        const approved = fakes.approve ?? true;
        return { approved, status: approved ? "approved" : "rejected" };
      }
      default:
        throw new Error(`Unknown function ${name}`);
    }
  };

  const hostHandle = vm.newFunction("__host", (nameHandle, argsHandle) => {
    const name = vm.getString(nameHandle);
    const args = JSON.parse(vm.getString(argsHandle), bigintReviver) as unknown[];
    return vm.newString(JSON.stringify(host(name, args) ?? null, bigintReplacer));
  });
  vm.setProp(vm.global, "__host", hostHandle);
  hostHandle.dispose();

  const source = `${prelude(tables)}
(async () => {
${code}
})().then(
  (value) => { globalThis.__done = __enc({ ok: true, value }); },
  (error) => { globalThis.__done = __enc({ ok: false, error: String(error) }); },
);`;

  const describe = (handle: Parameters<typeof vm.dump>[0]) => {
    const value = vm.dump(handle) as { name?: string; message?: string } | string;
    return typeof value === "object" && value ? `${value.name ?? "Error"}: ${value.message ?? ""}` : String(value);
  };

  try {
    const evaluated = vm.evalCode(source);
    if (evaluated.error) {
      run.error = describe(evaluated.error);
      evaluated.error.dispose();
      return run;
    }
    evaluated.value.dispose();
    const jobs = vm.runtime.executePendingJobs();
    if (jobs.error) {
      run.error = describe(jobs.error);
      jobs.error.dispose();
      return run;
    }
    const doneHandle = vm.getProp(vm.global, "__done");
    const done = vm.getString(doneHandle);
    doneHandle.dispose();
    if (!done) {
      run.error = "The code did not finish";
      return run;
    }
    const outcome = JSON.parse(done, bigintReviver) as { ok: boolean; value?: unknown; error?: string };
    if (!outcome.ok) run.error = outcome.error ?? "Error";
    // Returned actions count as one final propose().
    else if (Array.isArray(outcome.value)) {
      run.proposals.push(outcome.value);
      run.events.push({ kind: "propose", actions: outcome.value });
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    vm.dispose();
  }
  return run;
}

/** Plain-text account of a dry run, for the model reviewer. Amounts are shown in base units and as decimals. */
export function describeDryRun(run: DryRun): string {
  const show = (value: unknown) => JSON.stringify(value, bigintReplacer);
  const action = (raw: unknown): string => {
    const a = (raw ?? {}) as Record<string, unknown>;
    if (a.action === "transfer" && typeof a.amount === "bigint" && typeof a.token === "string") {
      const decimals = DECIMALS[a.token.toUpperCase()];
      const pretty = decimals === undefined ? "" : ` = ${formatUnits(a.amount, decimals)} ${a.token}`;
      return `transfer ${a.amount.toString()} base units of ${a.token}${pretty} to ${String(a.to)}`;
    }
    if (a.action === "swap" && typeof a.tokenIn === "string" && typeof a.tokenOut === "string") {
      const exact = typeof a.amountIn === "bigint" ? a.amountIn : typeof a.amountOut === "bigint" ? a.amountOut : null;
      const token = typeof a.amountIn === "bigint" ? a.tokenIn : a.tokenOut;
      const decimals = DECIMALS[token.toUpperCase()];
      const pretty = exact !== null && decimals !== undefined ? `${formatUnits(exact, decimals)} ${token}` : String(exact);
      const slippage = a.slippage !== undefined ? `, slippage ${String(a.slippage)}%` : "";
      return typeof a.amountIn === "bigint"
        ? `swap exactly ${pretty} for ${a.tokenOut}${slippage}`
        : `swap ${a.tokenIn} for exactly ${pretty}${slippage}`;
    }
    return show(a);
  };
  const lines = [
    "Sample data given to the code (not the user's real data):",
    "- wallet.getBalance: ETH = 1 ETH, USDC = 100 USDC, EURC = 100 EURC",
    "- wallet.getHistory (newest first): 0.01 ETH to sample-recipient-1, 5 USDC to sample-recipient-2, 0.02 ETH to sample-recipient-1",
    "- wallet.estimateFee: 0.000042 ETH",
    "- wallet.quoteSwap: 1 ETH = 2,000 USDC = 2,000 EURC",
    "- propose: the user approves",
    "",
    "What the code did:",
  ];
  if (run.events.length === 0) lines.push("- nothing was shown and nothing was proposed");
  let batch = 0;
  for (const event of run.events) {
    if (event.kind === "show") {
      lines.push(`- ui.show ${show(event.content)}`);
    } else {
      lines.push(`- propose batch ${++batch}: ${event.actions.length} action${event.actions.length === 1 ? "" : "s"}`);
      // A long batch (a document table) is summed up: the first rows, the last, and totals per token.
      const shown = event.actions.length > 12 ? [...event.actions.slice(0, 8), null, ...event.actions.slice(-2)] : event.actions;
      for (const item of shown) lines.push(item === null ? `    ... ${event.actions.length - 10} more ...` : `    ${action(item)}`);
      if (event.actions.length > 12) {
        const totals = new Map<string, bigint>();
        for (const raw of event.actions) {
          const a = (raw ?? {}) as Record<string, unknown>;
          if (a.action === "transfer" && typeof a.amount === "bigint" && typeof a.token === "string") totals.set(a.token, (totals.get(a.token) ?? BigInt(0)) + a.amount);
        }
        const sums = [...totals].map(([token, sum]) => {
          const decimals = DECIMALS[token.toUpperCase()];
          return decimals === undefined ? `${sum} base units of ${token}` : `${formatUnits(sum, decimals)} ${token}`;
        });
        if (sums.length) lines.push(`    total: ${sums.join(", ")}`);
      }
    }
  }
  if (run.error) lines.push(`- stopped with an error: ${run.error}`);
  return lines.join("\n");
}
