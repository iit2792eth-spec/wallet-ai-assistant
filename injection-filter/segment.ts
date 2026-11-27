// Sentence segmenter: a line-for-line port of piidata/segmenter.py from the
// classifier's dataset repository. The classifier was trained on exactly these
// segments, so this must keep producing the same output as the Python version
// (checked on every document of the dataset; see tests/injection-filter).

export type Segment = {
  /** Offsets into the original text (UTF-16 code units). */
  start: number;
  end: number;
  text: string;
};

const BOUNDARY = /(?<=[.!?])(?:["'”’)]*)[ \t]+(?=[A-Z0-9[{<#>*_])|\n+|(?<=;)\s+(?=[A-Z])/g;
const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|e\.g|i\.e|No|St)\.$/i;
const DECIMAL = /^\d+$/;
const isSpace = (char: string) => /\s/.test(char);

/** Splits text at sentence, markdown, bullet and line boundaries, keeping offsets. */
export function splitSegments(text: string): Segment[] {
  if (!text) return [];
  const spans: [number, number][] = [];
  let start = 0;
  for (const match of text.matchAll(BOUNDARY)) {
    const end = match.index;
    const left = text.slice(start, end).trimEnd();
    if (!left) {
      start = match.index + match[0].length;
      continue;
    }
    const words = left.split(/\s+/);
    const token = words[words.length - 1];
    // "Dr. Rao" and "0.05 ETH" are not sentence ends.
    if (ABBREVIATION.test(left) || (token.endsWith(".") && DECIMAL.test(token.slice(0, -1)))) continue;
    spans.push([start, end]);
    start = match.index + match[0].length;
  }
  if (start < text.length) spans.push([start, text.length]);

  const segments: Segment[] = [];
  for (let [a, b] of spans) {
    while (a < b && isSpace(text[a])) a++;
    while (b > a && isSpace(text[b - 1])) b--;
    if (a < b) segments.push({ start: a, end: b, text: text.slice(a, b) });
  }
  return segments;
}
