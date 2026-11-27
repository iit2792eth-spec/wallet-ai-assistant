// JavaScript that runs inside QuickJS, shared by the AI layer's dry run and the
// access layer's sandbox, so generated code sees identical helpers in both.

/** Decimals for each unit the helpers accept. WEI and GWEI are units of ETH. */
export const UNIT_DECIMALS: Record<string, number> = { ETH: 18, USDC: 6, EURC: 6, WEI: 0, GWEI: 9 };

/** Values cross the sandbox boundary as JSON, with BigInt tagged as { $bigint: "123" }. */
export const ENCODING_PRELUDE = `
const __enc = (v) => JSON.stringify(v === undefined ? null : v, (k, x) => typeof x === "bigint" ? { $bigint: x.toString() } : x);
const __dec = (s) => JSON.parse(s, (k, x) => x && typeof x === "object" && typeof x.$bigint === "string" ? BigInt(x.$bigint) : x);
`;

/** The manifest's util functions. Pure, and matching viem's parseUnits/formatUnits for these inputs. */
export const UTIL_PRELUDE = `
const unique = (items) => [...new Set(items)];
const __decimals = ${JSON.stringify(UNIT_DECIMALS)};
const parseUnits = (decimal, unit) => {
  if (typeof decimal !== "string" || !/^\\d+(\\.\\d+)?$/.test(decimal)) throw new TypeError("parseUnits needs a decimal string");
  const places = __decimals[String(unit).toUpperCase()];
  if (places === undefined) throw new TypeError("Unsupported unit " + unit);
  const [whole, fraction = ""] = decimal.split(".");
  if (fraction.length > places) throw new RangeError("Too many decimal places for " + unit);
  return BigInt(whole + fraction.padEnd(places, "0"));
};
const parseEther = (decimal) => parseUnits(decimal, "ETH");
const formatUnits = (amount, unit) => {
  if (typeof amount !== "bigint") throw new TypeError("formatUnits needs a BigInt amount");
  const places = __decimals[String(unit).toUpperCase()];
  if (places === undefined) throw new TypeError("Unsupported unit " + unit);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(places + 1, "0");
  const fraction = places ? digits.slice(-places).replace(/0+$/, "") : "";
  return (negative ? "-" : "") + digits.slice(0, digits.length - places) + (fraction ? "." + fraction : "");
};
`;

/** now(): a fixed current time (unix seconds), so every run of a program sees the same value. */
export const nowPrelude = (seconds: number) => `const now = () => ${Math.floor(seconds)};\n`;

export const bigintReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? { $bigint: value.toString() } : value;

export const bigintReviver = (_key: string, value: unknown) =>
  value && typeof value === "object" && typeof (value as { $bigint?: unknown }).$bigint === "string"
    ? BigInt((value as { $bigint: string }).$bigint)
    : value;

/** A list or table from a document, as the program sees it through external.rows(name). */
export type SandboxTable = { name: string; columns: string[]; rows: string[][] };

/**
 * external.rows(name): the rows of a document's table as fresh objects keyed by
 * column. The data is embedded as a JSON string literal, so it is data only.
 */
export const tablesPrelude = (tables: SandboxTable[] = []) => `
const __tables = JSON.parse(${JSON.stringify(JSON.stringify(tables.map(({ name, columns, rows }) => ({ name, columns, rows }))))});
const external = Object.freeze({
  rows: (name) => {
    const table = __tables.find((t) => t.name === name);
    if (!table) throw new Error("There is no external table named " + String(name));
    return table.rows.map((row) => {
      const item = {};
      table.columns.forEach((column, i) => { item[column] = row[i]; });
      return item;
    });
  },
});
`;
