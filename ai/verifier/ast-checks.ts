import { parse, type AnyNode } from "acorn";
import { ancestor } from "acorn-walk";
import { SUPPORTED_UNITS, TOKENS } from "../config";
import { PLACEHOLDER_POSITION_HELP, isPlaceholderPosition } from "@/lib/placeholder-positions";
import type { Manifest } from "../manifest";
import {
  CODE_PLACEHOLDER_TYPES,
  SECRET_PLACEHOLDER_TYPES,
  placeholderFragmentPattern,
  placeholderPattern,
  placeholderType,
} from "@/lib/placeholders";

// Stage (a) of the Code Verifier: deterministic checks on the syntax tree.
// The generated code is untrusted. These checks are deliberately stricter than
// JavaScript needs to be: anything the verifier cannot reason about is rejected.

/** Names that are never allowed, whether declared in the code or not. */
const FORBIDDEN_IDENTIFIERS = new Set([
  "eval", "Function", "AsyncFunction", "GeneratorFunction", "require", "module", "exports", "process",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "globalThis", "window", "self", "global",
  "Proxy", "Reflect", "Symbol", "WebAssembly", "Atomics", "SharedArrayBuffer",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "arguments", "constructor", "console",
]);

/** Property names that reach prototypes, constructors or indirect calls. */
const FORBIDDEN_PROPERTIES = new Set([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__", "caller", "callee", "call", "apply", "bind",
]);

const GLOBAL_VALUES = new Set(["undefined", "NaN", "Infinity"]);
/** Built-ins that may be called directly or passed as a callback, e.g. items.map(String). */
const GLOBAL_CALLABLES = new Set(["BigInt", "String", "Number", "Boolean", "parseInt", "isNaN", "isFinite"]);
const GLOBAL_CONSTRUCTORS = new Set(["Map", "Set", "Error", "Date"]);

/** Built-in namespaces and the only methods that may be called on them. */
const NAMESPACE_METHODS: Record<string, ReadonlySet<string>> = {
  // Date.now() is not allowed: the current time comes from now(), the same in every run.
  Date: new Set(["UTC"]),
  Math: new Set(["abs", "ceil", "floor", "max", "min", "round", "sign", "trunc", "pow"]),
  Object: new Set(["keys", "values", "entries", "fromEntries", "assign", "freeze"]),
  JSON: new Set(["stringify", "parse"]),
  Array: new Set(["isArray", "from", "of"]),
  Number: new Set(["isInteger", "isSafeInteger", "isFinite", "isNaN", "parseInt"]),
  String: new Set([]),
  BigInt: new Set(["asIntN", "asUintN"]),
  Promise: new Set(["all", "resolve"]),
};

/** Methods that may be called on any value: array, string, number, bigint, Map and Set methods. */
const SAFE_METHODS = new Set([
  // Date
  "getTime", "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds",
  "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours", "getUTCMinutes", "getTimezoneOffset",
  "setHours", "setMinutes", "setSeconds", "setMilliseconds", "setDate", "setUTCHours", "setUTCDate",
  "toISOString", "toLocaleDateString", "toLocaleTimeString", "toDateString", "toTimeString",
  "map", "filter", "reduce", "reduceRight", "forEach", "find", "findIndex", "findLast", "findLastIndex",
  "some", "every", "includes", "indexOf", "lastIndexOf", "slice", "concat", "join", "flat", "flatMap",
  "sort", "reverse", "push", "pop", "shift", "unshift", "at", "fill", "keys", "values", "entries",
  "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd", "startsWith", "endsWith", "split",
  "padStart", "padEnd", "replaceAll", "substring", "charAt", "repeat", "localeCompare",
  "toString", "toFixed", "toLocaleString", "get", "set", "has", "add", "delete", "clear",
]);

const FORBIDDEN_NODES: Record<string, string> = {
  WithStatement: "with is not allowed",
  ImportDeclaration: "import is not allowed",
  ImportExpression: "import() is not allowed",
  ExportNamedDeclaration: "export is not allowed",
  ExportDefaultDeclaration: "export is not allowed",
  ExportAllDeclaration: "export is not allowed",
  ThisExpression: "this is not allowed",
  WhileStatement: "while loops are not allowed; use for...of over an array or an array method",
  DoWhileStatement: "do...while loops are not allowed; use for...of over an array or an array method",
  ForStatement: "for(;;) loops are not allowed; use for...of over an array or an array method",
  ForInStatement: "for...in loops are not allowed; use for...of over Object.keys(...)",
  ClassDeclaration: "classes are not allowed",
  ClassExpression: "classes are not allowed",
  TaggedTemplateExpression: "tagged templates are not allowed",
  YieldExpression: "generators are not allowed",
  MetaProperty: "import.meta and new.target are not allowed",
  Super: "super is not allowed",
  PrivateIdentifier: "private names are not allowed",
  DebuggerStatement: "debugger is not allowed",
  LabeledStatement: "labels are not allowed",
};

const DECIMAL = /^\d+(\.\d+)?$/;
const RAW_ADDRESS_OR_KEY = /(0x)?[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40}/;
const RAW_KEY = /(?<![0-9A-Za-z])(0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])/;
const PATTERN_NODES = new Set(["ObjectPattern", "ArrayPattern", "Property", "RestElement", "AssignmentPattern"]);
const DECLARING_NODES = new Set([
  "VariableDeclarator", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "CatchClause",
]);

/** Tells the Coder how to show an address, the usual reason a placeholder ends up inside text. */
const showHint = (placeholder: string) =>
  `To show it to the user, pass it on its own in a list: ui.show({ text: "Sending 1 ETH to:", list: ["${placeholder}"] }).`;

export type AstCheckOptions = {
  manifest: Manifest;
  /** Asks the encoder whether a placeholder exists. */
  isKnownPlaceholder: (placeholder: string) => boolean;
  /**
   * "encoded" (default): code from the Coder, which holds placeholders and no raw addresses.
   * "decoded": code after the Text Decoder, which holds real addresses and no placeholders.
   */
  stage?: "encoded" | "decoded";
};

export type AstCheckResult = {
  errors: string[];
  /** Manifest functions the code calls. */
  functionsCalled: string[];
};

type Ancestors = AnyNode[];

const isString = (node: AnyNode | null | undefined): node is AnyNode & { type: "Literal"; value: string } =>
  node?.type === "Literal" && typeof node.value === "string";

function propertyName(node: AnyNode): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  return null;
}

/** Checks code written by the Coder. An empty error list means stage (a) passed. */
export function checkCode(code: string, options: AstCheckOptions): AstCheckResult {
  const { manifest } = options;
  const decoded = options.stage === "decoded";
  const errors = new Set<string>();
  const fail = (message: string, node?: { loc?: { start: { line: number } } | null }) =>
    errors.add(node?.loc ? `Line ${node.loc.start.line}: ${message}` : message);

  // ---- Parse as the body of an async function ----
  let program: AnyNode;
  try {
    program = parse(code, {
      ecmaVersion: 2020,
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    }) as AnyNode;
  } catch (error) {
    return { errors: [`Syntax error: ${error instanceof Error ? error.message : "cannot parse"}`], functionsCalled: [] };
  }

  const reserved = new Set([
    ...manifest.plainFunctions, ...manifest.namespaces, ...GLOBAL_VALUES, ...GLOBAL_CALLABLES,
    ...GLOBAL_CONSTRUCTORS, ...Object.keys(NAMESPACE_METHODS),
  ]);
  const declared = new Set<string>();
  const references: { node: AnyNode & { type: "Identifier" }; parent?: AnyNode; grandparent?: AnyNode }[] = [];
  const calls: { node: AnyNode & { type: "CallExpression" } }[] = [];
  /** Source ranges of string literals that are exactly one placeholder. */
  const placeholderLiterals = new Map<number, number>();

  const declare = (name: string, node: AnyNode) => {
    if (FORBIDDEN_IDENTIFIERS.has(name)) fail(`"${name}" is not allowed`, node);
    else if (reserved.has(name)) fail(`"${name}" is provided by the sandbox and must not be redeclared`, node);
    declared.add(name);
  };

  const visitors: Record<string, (node: AnyNode, state: unknown, ancestors: Ancestors) => void> = {
    Identifier(node, _state, ancestors) {
      if (node.type !== "Identifier") return;
      references.push({ node, parent: ancestors.at(-2), grandparent: ancestors.at(-3) });
    },

    // An identifier in a binding or assignment position.
    VariablePattern(node, _state, ancestors) {
      if (node.type !== "Identifier") return;
      let index = ancestors.length - 2;
      while (index >= 0 && PATTERN_NODES.has(ancestors[index].type)) index--;
      const owner = ancestors[index];
      if (owner && DECLARING_NODES.has(owner.type)) declare(node.name, node);
      else references.push({ node, parent: ancestors.at(-2), grandparent: ancestors.at(-3) });
    },

    MemberExpression(node) {
      if (node.type !== "MemberExpression") return;
      if (node.computed) {
        const key = node.property;
        const literal = key.type === "Literal" && (typeof key.value === "number" || typeof key.value === "string");
        if (!literal) fail("Computed property access is not allowed; use .at(index), Map.get(key) or a literal key", node);
        else if (FORBIDDEN_PROPERTIES.has(String((key as { value: unknown }).value))) {
          fail(`Access to "${String((key as { value: unknown }).value)}" is not allowed`, node);
        }
      } else {
        const name = propertyName(node.property);
        if (name === null || FORBIDDEN_PROPERTIES.has(name)) fail(`Access to "${name}" is not allowed`, node);
      }
    },

    Property(node, _state, ancestors) {
      if (node.type !== "Property") return;
      if (node.computed) return fail("Computed property keys are not allowed", node);
      if (node.kind !== "init") return fail("Getters and setters are not allowed", node);
      const key = propertyName(node.key);
      if (key === null || FORBIDDEN_PROPERTIES.has(key)) return fail(`Property "${key}" is not allowed`, node);

      const owner = ancestors.at(-2);
      if (owner?.type !== "ObjectExpression") return;
      const value = node.value as AnyNode;

      if (key === "token") {
        const isAction = owner.properties.some((p) => p.type === "Property" && propertyName(p.key) === "action");
        const allowed: readonly string[] = isAction ? TOKENS : SUPPORTED_UNITS;
        if (isString(value) && !allowed.includes(value.value)) {
          fail(`Token "${value.value}" is not supported; use one of ${allowed.join(", ")}`, node);
        }
        if (value.type === "TemplateLiteral") fail("A token must be a plain string or a value from a function result", node);
      }
      if (key === "amount" && (value.type === "Literal" || value.type === "TemplateLiteral")) {
        if (!(value.type === "Literal" && typeof value.bigint === "string")) {
          fail("An amount must be a BigInt: use parseEther/parseUnits with a decimal string, or a BigInt literal", node);
        }
      }
      if (key === "action") {
        if (!isString(value)) fail("An action type must be a string literal", node);
        else if (!manifest.actionNames.has(value.value)) fail(`Action "${value.value}" is not in the manifest`, node);
      }
    },

    // Destructuring can read any property, so its keys get the same rules as member access.
    ObjectPattern(node) {
      if (node.type !== "ObjectPattern") return;
      for (const property of node.properties) {
        if (property.type !== "Property") continue;
        const key = property.computed ? null : propertyName(property.key);
        if (key === null || FORBIDDEN_PROPERTIES.has(key)) fail("This destructuring key is not allowed", property);
      }
    },

    CallExpression(node) {
      if (node.type === "CallExpression") calls.push({ node });
    },

    NewExpression(node) {
      if (node.type !== "NewExpression") return;
      if (!(node.callee.type === "Identifier" && GLOBAL_CONSTRUCTORS.has(node.callee.name))) {
        fail("new is only allowed for Map, Set, Error and Date", node);
      } else if (node.callee.name === "Date" && node.arguments.length === 0) {
        fail("new Date() without arguments is not allowed: for the current time use new Date(now() * 1000)", node);
      }
    },

    Literal(node, _state, ancestors) {
      if (node.type !== "Literal") return;
      if (node.regex) return fail("Regular expressions are not allowed", node);
      if (typeof node.value === "number" && (!Number.isInteger(node.value) || /[.eE]/.test(node.raw ?? ""))) {
        if (!/^0[xXbBoO]/.test(node.raw ?? "")) {
          fail("Decimal number literals are not allowed; write amounts as decimal strings passed to parseEther/parseUnits", node);
        }
      }
      if (typeof node.value !== "string") return;

      const type = placeholderType(node.value);
      if (!type) return;
      placeholderLiterals.set(node.start + 1, node.end - 1);
      if (decoded) return fail(`Placeholder ${node.value} was not restored by the decoder`, node);
      if (!CODE_PLACEHOLDER_TYPES.includes(type)) return fail(`A ${type} placeholder must not appear in code`, node);
      if (!options.isKnownPlaceholder(node.value)) fail(`Placeholder ${node.value} was never given to you`, node);

      // Same rule as the Text Decoder, so verified code can always be restored.
      if (!isPlaceholderPosition(node, ancestors.at(-2), ancestors)) {
        fail(`Placeholder ${node.value} must be used whole, in a position where it can be restored. ${PLACEHOLDER_POSITION_HELP} ${showHint(node.value)}`, node);
      }
    },

    Function(node) {
      if ("generator" in node && node.generator) fail("Generators are not allowed", node);
    },

    ForOfStatement(node) {
      if (node.type === "ForOfStatement" && node.await) fail("for await is not allowed", node);
    },
  };
  for (const [type, message] of Object.entries(FORBIDDEN_NODES)) {
    visitors[type] = (node) => fail(message, node);
  }
  for (const type of ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]) {
    visitors[type] = visitors.Function;
  }
  delete visitors.Function;

  ancestor(program, visitors as never);

  // ---- Functions that call themselves are unbounded loops in disguise ----
  ancestor(program, {
    VariableDeclarator(node: AnyNode) {
      if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || !node.init) return;
      if (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression") {
        checkRecursion(node.id.name, node.init.body as AnyNode, node);
      }
    },
    FunctionDeclaration(node: AnyNode) {
      if (node.type === "FunctionDeclaration" && node.id) checkRecursion(node.id.name, node.body as AnyNode, node);
    },
  } as never);

  function checkRecursion(name: string, body: AnyNode, at: AnyNode) {
    ancestor(body, {
      Identifier(inner: AnyNode) {
        if (inner.type === "Identifier" && inner.name === name) fail(`Function "${name}" must not call itself`, at);
      },
    } as never);
  }

  // ---- Identifiers: everything used must be declared, injected, or an allowed built-in ----
  for (const { node, parent, grandparent } of references) {
    const { name } = node;
    const isCallee = parent?.type === "CallExpression" && parent.callee === node;
    const isMemberObject = parent?.type === "MemberExpression" && parent.object === node && !parent.computed;

    if (FORBIDDEN_IDENTIFIERS.has(name)) {
      fail(`"${name}" is not allowed`, node);
    } else if (manifest.namespaces.has(name)) {
      const isMethodCall = isMemberObject && grandparent?.type === "CallExpression" && grandparent.callee === parent;
      if (!isMethodCall) fail(`"${name}" may only be used to call its functions, e.g. ${name}.someFunction(...)`, node);
    } else if (manifest.plainFunctions.has(name)) {
      if (!isCallee) fail(`"${name}" may only be called directly`, node);
    } else if (declared.has(name) || GLOBAL_VALUES.has(name) || GLOBAL_CALLABLES.has(name)) {
      // allowed
    } else if (GLOBAL_CONSTRUCTORS.has(name)) {
      const isNew = parent?.type === "NewExpression" && parent.callee === node;
      const isNamespace = isMemberObject && Object.hasOwn(NAMESPACE_METHODS, name);
      if (!isNew && !isNamespace) fail(`"${name}" may only be used with new`, node);
    } else if (Object.hasOwn(NAMESPACE_METHODS, name)) {
      if (!isMemberObject) fail(`"${name}" may only be used as ${name}.method(...)`, node);
    } else {
      fail(`"${name}" is not defined. Only manifest functions and declared variables may be used`, node);
    }
  }

  // ---- Calls: manifest functions, allowlisted built-ins, and functions declared in the code ----
  const functionsCalled = new Set<string>();
  for (const { node } of calls) {
    const callee = node.callee as AnyNode;
    if (callee.type === "Identifier") {
      if (manifest.plainFunctions.has(callee.name)) {
        functionsCalled.add(callee.name);
        checkUtilArguments(callee.name, node.arguments as AnyNode[], node);
      } else if (!declared.has(callee.name) && !GLOBAL_CALLABLES.has(callee.name)) {
        fail(`Call to "${callee.name}" is not allowed: it is not in the manifest`, node);
      }
    } else if (callee.type === "MemberExpression") {
      if (callee.computed) {
        fail("Calls through computed member access are not allowed", node);
        continue;
      }
      const method = propertyName(callee.property) ?? "";
      const object = callee.object as AnyNode;
      const root = object.type === "Identifier" && !declared.has(object.name) ? object.name : null;
      if (root !== null && manifest.namespaces.has(root)) {
        const full = `${root}.${method}`;
        if (manifest.functionNames.has(full)) functionsCalled.add(full);
        else fail(`Function "${full}" is not in the manifest`, node);
      } else if (root !== null && Object.hasOwn(NAMESPACE_METHODS, root)) {
        if (!NAMESPACE_METHODS[root].has(method)) {
          fail(root === "Date" && method === "now" ? '"Date.now" is not allowed: use now(), which returns the current time in seconds' : `"${root}.${method}" is not allowed`, node);
        }
      } else if (!SAFE_METHODS.has(method)) {
        fail(`Method "${method}" is not allowed`, node);
      }
    } else if (callee.type !== "ArrowFunctionExpression" && callee.type !== "FunctionExpression") {
      fail("Only named functions and methods may be called", node);
    }
  }

  function checkUtilArguments(name: string, args: AnyNode[], node: AnyNode) {
    if (name !== "parseEther" && name !== "parseUnits" && name !== "formatUnits") return;
    const [first, second] = args;
    const unit = name === "parseEther" ? "ETH" : isString(second) ? second.value : null;
    if (name !== "parseEther" && second?.type === "Literal") {
      if (unit === null || !(SUPPORTED_UNITS as readonly string[]).includes(unit)) {
        fail(`Unit ${String((second as { raw?: string }).raw)} is not supported; use one of ${SUPPORTED_UNITS.join(", ")}`, node);
      }
    }
    if (name === "formatUnits" || first?.type !== "Literal") return;
    if (!isString(first) || !DECIMAL.test(first.value)) {
      fail(`${name} needs a decimal string such as "0.5", not a number`, node);
    } else if (unit === "WEI" && first.value.includes(".")) {
      fail("WEI amounts must be whole numbers", node);
    }
  }

  // ---- Placeholders: only as complete string literals, never in comments, templates or pieces ----
  let remainder = code;
  const stepCallRanges: [number, number][] = calls
    .map(({ node }) => node)
    .filter((node) => {
      const callee = node.callee as AnyNode;
      return callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" &&
        callee.object.name === "ui" && callee.property.type === "Identifier" && callee.property.name === "step";
    })
    .map((node) => [node.start, node.end]);
  for (const match of code.matchAll(placeholderPattern())) {
    const start = match.index;
    const end = start + match[0].length;
    const type = match[1];
    if ((SECRET_PLACEHOLDER_TYPES as readonly string[]).includes(type)) {
      fail("Private key and seed phrase placeholders must never appear in code");
    } else if (placeholderLiterals.get(start) !== end) {
      // Inside ui.step(...) the ui.show advice does not apply: narration lines carry no addresses at all.
      const inStep = stepCallRanges.some(([from, to]) => start >= from && end <= to);
      fail(
        inStep
          ? `Placeholder ${match[0]} must not appear in ui.step: activity lines never contain addresses or names. Write the step without it, e.g. ui.step("Preparing the transfer"), and show the recipient with ui.show({ text: "Sending to:", list: ["${match[0]}"] }) if needed.`
          : `Placeholder ${match[0]} must be a complete string literal on its own, not in a comment, template or longer string. ${showHint(match[0])}`,
      );
    }
    remainder = remainder.replace(match[0], "");
  }
  if (placeholderFragmentPattern().test(remainder)) {
    fail("Placeholders must not be split, altered or built from pieces");
  }
  if (decoded) {
    // Decoded code holds real addresses, restored by the decoder, but never a private key.
    if (RAW_KEY.test(code)) fail("A private key or other 64-character hex value is not allowed in code");
  } else if (RAW_ADDRESS_OR_KEY.test(code)) {
    // The model only ever receives placeholders, so a raw address or key in its output was invented.
    fail("Raw addresses and keys are not allowed anywhere in the code; use the placeholder you were given");
  }

  return { errors: [...errors], functionsCalled: [...functionsCalled].sort() };
}

/** functions_used must list exactly the manifest functions the code calls. */
export function checkFunctionsUsed(declaredList: string[], called: string[]): string[] {
  const declaredSet = new Set(declaredList);
  const calledSet = new Set(called);
  const missing = called.filter((name) => !declaredSet.has(name));
  const extra = [...declaredSet].filter((name) => !calledSet.has(name));
  const errors: string[] = [];
  if (missing.length) errors.push(`functions_used is missing: ${missing.join(", ")}`);
  if (extra.length) errors.push(`functions_used lists functions the code does not call: ${extra.join(", ")}`);
  return errors;
}
