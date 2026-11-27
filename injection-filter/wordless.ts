// Segments with no words in them — a table row of addresses and amounts, a
// date, a transaction hash — cannot carry an instruction, but the classifier
// has never seen such rows and scores them close to the threshold, which turns
// a statement of 100 transactions into a handful of random flags. These are
// skipped. The rule is strict: one ordinary word anywhere and the segment is
// scored as usual.

/** Token symbols allowed in a skipped segment ("0x… 0x… 0.01 ETH"). Exact tickers only. */
const TICKERS = ["ETH", "WETH", "STETH", "WSTETH", "USDC", "EURC", "USDT", "DAI", "WBTC", "BTC", "GWEI", "WEI", "USD", "EUR"];

const HEX = /\b0x[0-9a-fA-F]+\b/g; // addresses, hashes, calldata
const BARE_HEX = /\b[0-9a-fA-F]{16,}\b/g; // long hex without 0x
const TICKER = new RegExp(`(?<![\\p{L}\\p{N}])(?:${TICKERS.join("|")})(?![\\p{L}\\p{N}])`, "giu");

/** True if the segment has no letters left once hex values and token tickers are taken out. */
export function isWordless(text: string): boolean {
  const rest = text.replace(HEX, " ").replace(BARE_HEX, " ").replace(TICKER, " ");
  return !/\p{L}/u.test(rest);
}
