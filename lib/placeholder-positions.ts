import type { AnyNode } from "acorn";

// Where in generated code a placeholder may stand. Shared by the AI layer's
// Code Verifier and the Text Decoder, so code the verifier accepts is code the
// decoder can restore. This is the code form of the decoder's "eligible fields":
// a placeholder may sit where an address or ENS name is used as a value, never
// where it would become part of text, a key, an amount, or an expression.

/** Object properties whose value is an address or name. */
const ADDRESS_PROPERTIES = new Set(["to", "address"]);
/** Manifest functions whose first argument is an address or name. */
const ADDRESS_ARGUMENT_FUNCTIONS = new Set(["wallet.lookupEns", "wallet.resolveEns"]);
const EQUALITY = new Set(["===", "!=="]);

function calleeName(node: AnyNode): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier" && node.property.type === "Identifier") {
    return `${node.object.name}.${node.property.name}`;
  }
  return null;
}

function keyName(node: AnyNode): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

/**
 * True if the string literal `node`, whose parent is `parent`, is in a position
 * where a placeholder can be restored:
 * - the value of a `to` or `address` property, e.g. { action: "transfer", to: "[WALLET_ADDRESS_1]" }
 * - the first argument of wallet.lookupEns or wallet.resolveEns
 * - an element of an array literal, e.g. list: ["[WALLET_ADDRESS_1]"]
 * - the initial value of a variable, e.g. const to = "[WALLET_ADDRESS_1]"
 * - one side of an === or !== comparison, e.g. tx.to === "[WALLET_ADDRESS_1]"
 * - any value inside typedData: {...} or params: {...} of a signing action
 */
/** Properties whose whole value is data to be signed: typed data, or a signing template's parameters. */
const SIGNING_DATA_KEYS = new Set(["typedData", "params"]);

/**
 * True if `node` is a value (never a key) somewhere inside the object or array
 * given as `typedData: {...}` or `params: {...}`, or stored in a variable of that name. Addresses inside EIP-712 data
 * (owner, spender, verifyingContract...) can then be restored, as the decoder
 * spec allows for signing parameters "at any depth".
 */
function insideSigningData(node: AnyNode, ancestors: AnyNode[]): boolean {
  let child = node;
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (ancestor.type === "Property") {
      if (ancestor.computed || ancestor.value !== child) return false;
      if (SIGNING_DATA_KEYS.has(keyName(ancestor.key) ?? "")) return true;
    } else if (ancestor.type === "VariableDeclarator") {
      // const typedData = { ... }
      return ancestor.init === child && ancestor.id.type === "Identifier" && SIGNING_DATA_KEYS.has(ancestor.id.name);
    } else if (ancestor.type !== "ObjectExpression" && ancestor.type !== "ArrayExpression") {
      return false;
    }
    child = ancestor;
  }
  return false;
}

export function isPlaceholderPosition(node: AnyNode, parent: AnyNode | undefined, ancestors: AnyNode[] = []): boolean {
  if (ancestors.length > 0 && insideSigningData(node, ancestors)) return true;
  if (!parent) return false;
  switch (parent.type) {
    case "Property":
      return parent.value === node && !parent.computed && ADDRESS_PROPERTIES.has(keyName(parent.key) ?? "");
    case "CallExpression":
      return parent.arguments[0] === node && ADDRESS_ARGUMENT_FUNCTIONS.has(calleeName(parent.callee) ?? "");
    case "ArrayExpression":
      return true;
    case "VariableDeclarator":
      return parent.init === node;
    case "BinaryExpression":
      return EQUALITY.has(parent.operator);
    default:
      return false;
  }
}

export const PLACEHOLDER_POSITION_HELP =
  "Use it whole, as a transfer `to`, a getBalance `address`, the argument of wallet.lookupEns or wallet.resolveEns, an array element (for example a ui.show list), a variable's value, one side of an === comparison, or a value inside typedData or params of a signing action.";
