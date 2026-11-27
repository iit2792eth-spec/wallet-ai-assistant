import { getQuickJS, type QuickJSDeferredPromise } from "quickjs-emscripten";
import { redact } from "@/lib/logger";
import { ENCODING_PRELUDE, UTIL_PRELUDE, bigintReplacer, bigintReviver, nowPrelude, tablesPrelude, type SandboxTable } from "@/lib/sandbox-prelude";
import { LIMITS } from "./config";

// Runs a program in QuickJS: no network, no file system, no timers, no host
// objects. The program reaches the outside only through the functions the host
// provides, and every value crosses the boundary as JSON (BigInt tagged), so
// the host always works on its own copies.
//
// Host functions return QuickJS promises that the host settles later. That is
// how `await propose(...)` pauses the program while the user decides: the
// program simply has nothing to run until the host resolves the promise.

export type SandboxHost = {
  /** wallet.*, propose: may take any time (network, user approval). */
  call(name: string, args: unknown[]): Promise<unknown>;
  /** ui.show: synchronous. Throw to reject the content. */
  show(content: unknown): void;
  /** ui.step: synchronous. Throw to reject the text. */
  step?(text: unknown): void;
};

export type SandboxResult =
  | { status: "completed"; value: unknown }
  | { status: "failed"; reason: string; limit: boolean };

/** Frozen deep copy: nothing that leaves the sandbox can be changed afterwards. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

class SandboxStopped extends Error {}

const parseFromSandbox = (json: string): unknown => deepFreeze(JSON.parse(json, bigintReviver));

export async function runSandbox(
  code: string,
  host: SandboxHost,
  signal: AbortSignal,
  options: {
    nowSeconds?: number;
    /** Default LIMITS.wallClockMs. The real run gets more per approved action. */
    wallClockMs?: number;
    /** Tables from documents, for external.rows(). Addresses already restored. */
    tables?: SandboxTable[];
  } = {},
): Promise<SandboxResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(LIMITS.memoryBytes);
  runtime.setMaxStackSize(LIMITS.stackBytes);
  const vm = runtime.newContext();

  const wallClockMs = options.wallClockMs ?? LIMITS.wallClockMs;
  const deadline = Date.now() + wallClockMs;
  let cpuUsed = 0;
  let segmentStart: number | null = null;
  let stopReason: string | null = null; // set when a limit is hit or the plan is cancelled
  let hostCalls = 0;
  let showCalls = 0;
  let stepCalls = 0;
  let proposeCalls = 0;
  let pendingOps = 0;
  let disposed = false;
  let wake: () => void = () => {};
  const deferreds = new Set<QuickJSDeferredPromise>();

  const stop = (reason: string) => {
    stopReason ??= reason;
    wake();
  };
  const onAbort = () => stop("The plan was cancelled.");
  signal.addEventListener("abort", onAbort, { once: true });

  // Only execution time counts towards the CPU limit; waits happen outside these segments.
  runtime.setInterruptHandler(() => {
    if (segmentStart !== null && cpuUsed + (performance.now() - segmentStart) > LIMITS.cpuMs) {
      stopReason ??= `The program ran longer than ${LIMITS.cpuMs / 1000} seconds of processing time.`;
    }
    return stopReason !== null;
  });
  const segment = <T>(run: () => T): T => {
    segmentStart = performance.now();
    try {
      return run();
    } catch (error) {
      // The host's own stack overflowed inside QuickJS: treat it as the program nesting too deeply.
      if (error instanceof RangeError) {
        stopReason ??= "The program nested too deeply.";
        throw new SandboxStopped();
      }
      throw error;
    } finally {
      cpuUsed += performance.now() - segmentStart;
      segmentStart = null;
    }
  };

  const countCall = (name: string) => {
    hostCalls += 1;
    if (name === "ui.show") showCalls += 1;
    if (name === "ui.step") stepCalls += 1;
    if (name === "propose") proposeCalls += 1;
    if (hostCalls > LIMITS.maxHostCalls) stop(`The program made more than ${LIMITS.maxHostCalls} calls.`);
    else if (showCalls > LIMITS.maxShowCalls) stop(`The program showed output more than ${LIMITS.maxShowCalls} times.`);
    else if (stepCalls > LIMITS.maxStepCalls) stop(`The program reported more than ${LIMITS.maxStepCalls} activity steps.`);
    else if (proposeCalls > LIMITS.maxProposeCalls) stop(`The program proposed actions more than ${LIMITS.maxProposeCalls} times.`);
    return stopReason === null;
  };

  const safeMessage = (error: unknown) =>
    redact(error instanceof Error ? error.message : String(error)).slice(0, 300);

  const hostFn = vm.newFunction("__host", (nameHandle, argsHandle) => {
    const name = vm.getString(nameHandle);
    const deferred = vm.newPromise();
    deferreds.add(deferred);
    if (!countCall(name)) {
      const error = vm.newError(stopReason ?? "Limit reached");
      deferred.reject(error);
      error.dispose();
      return deferred.handle;
    }
    let args: unknown[];
    try {
      args = parseFromSandbox(vm.getString(argsHandle)) as unknown[];
    } catch {
      args = [];
    }
    pendingOps += 1;
    host
      .call(name, args)
      .then(
        (value) => {
          if (disposed) return;
          const result = vm.newString(JSON.stringify(value ?? null, bigintReplacer));
          deferred.resolve(result);
          result.dispose();
        },
        (error) => {
          if (disposed) return;
          const result = vm.newError(safeMessage(error));
          deferred.reject(result);
          result.dispose();
        },
      )
      .finally(() => {
        pendingOps -= 1;
        wake();
      });
    return deferred.handle;
  });
  vm.setProp(vm.global, "__host", hostFn);
  hostFn.dispose();

  const showFn = vm.newFunction("__show", (contentHandle) => {
    if (!countCall("ui.show")) throw new Error(stopReason ?? "Limit reached");
    host.show(parseFromSandbox(vm.getString(contentHandle)));
  });
  vm.setProp(vm.global, "__show", showFn);
  showFn.dispose();

  const stepFn = vm.newFunction("__step", (textHandle) => {
    if (!countCall("ui.step")) throw new Error(stopReason ?? "Limit reached");
    host.step?.(parseFromSandbox(vm.getString(textHandle)));
  });
  vm.setProp(vm.global, "__step", stepFn);
  stepFn.dispose();

  // The program sees only the manifest's functions, passed in as parameters.
  const source = `${ENCODING_PRELUDE}
const __hostFn = globalThis.__host;
const __showFn = globalThis.__show;
const __stepFn = globalThis.__step;
delete globalThis.__host;
delete globalThis.__show;
delete globalThis.__step;
const __call = async (name, ...args) => __dec(await __hostFn(name, __enc(args)));
const __wallet = Object.freeze({
  getBalance: (options) => __call("wallet.getBalance", options),
  estimateFee: (options) => __call("wallet.estimateFee", options),
  quoteSwap: (options) => __call("wallet.quoteSwap", options),
  getHistory: (options) => __call("wallet.getHistory", options),
  resolveEns: (name) => __call("wallet.resolveEns", name),
  lookupEns: (address) => __call("wallet.lookupEns", address),
});
const __ui = Object.freeze({
  show: (content) => { __showFn(__enc(content)); },
  step: (text) => { __stepFn(__enc(text)); },
});
const __propose = (actions) => __call("propose", actions);
${UTIL_PRELUDE}
${nowPrelude(options.nowSeconds ?? Date.now() / 1000)}
${tablesPrelude(options.tables)}
globalThis.__done = "";
(async (wallet, ui, propose, unique, parseEther, parseUnits, formatUnits, now) => {
${code}
})(__wallet, __ui, __propose, unique, parseEther, parseUnits, formatUnits, now).then(
  (value) => { globalThis.__done = __enc({ ok: true, value }); },
  (error) => { globalThis.__done = __enc({ ok: false, error: String((error && error.message) || error) }); },
);`;

  const describe = (handle: Parameters<typeof vm.dump>[0]) => {
    const value = vm.dump(handle) as { name?: string; message?: string } | string;
    return typeof value === "object" && value ? `${value.name ?? "Error"}: ${value.message ?? ""}` : String(value);
  };
  const failure = (reason: string): SandboxResult => {
    const limit = stopReason !== null || /out of memory|string too long|invalid array length|stack overflow|interrupted/i.test(reason);
    const message = stopReason ?? (/out of memory|string too long|invalid array length/i.test(reason)
      ? `The program used more than ${LIMITS.memoryBytes / 1024 / 1024} MB of memory.`
      : /stack overflow/i.test(reason)
        ? "The program nested too deeply."
        : `The program stopped with an error: ${redact(reason).slice(0, 300)}`);
    return { status: "failed", reason: message, limit };
  };

  try {
    const evaluated = segment(() => vm.evalCode(source, "plan.js"));
    if (evaluated.error) {
      const reason = describe(evaluated.error);
      evaluated.error.dispose();
      return failure(reason);
    }
    evaluated.value.dispose();

    for (;;) {
      const jobs = segment(() => runtime.executePendingJobs());
      if (jobs.error) {
        const reason = describe(jobs.error);
        jobs.error.dispose();
        return failure(reason);
      }
      if (stopReason) return failure(stopReason);

      const doneHandle = vm.getProp(vm.global, "__done");
      const done = vm.getString(doneHandle);
      doneHandle.dispose();
      if (done) {
        const outcome = JSON.parse(done, bigintReviver) as { ok: boolean; value?: unknown; error?: string };
        return outcome.ok
          ? { status: "completed", value: deepFreeze(outcome.value ?? null) }
          : failure(outcome.error ?? "Error");
      }
      if (pendingOps === 0) return failure("The program stopped without finishing.");

      // Nothing to run until a host call settles, the plan is cancelled, or time runs out.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failure(`The plan took longer than ${Math.round(wallClockMs / 60000)} minutes.`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = () => {};
      if (Date.now() >= deadline) stop(`The plan took longer than ${Math.round(wallClockMs / 60000)} minutes.`);
    }
  } catch (error) {
    if (error instanceof SandboxStopped) return failure(stopReason ?? "The program was stopped.");
    throw error;
  } finally {
    disposed = true;
    signal.removeEventListener("abort", onAbort);
    for (const deferred of deferreds) {
      try {
        if (deferred.alive) deferred.dispose();
      } catch {}
    }
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // A handle still owned by an unsettled promise; the runtime is discarded either way.
    }
  }
}
