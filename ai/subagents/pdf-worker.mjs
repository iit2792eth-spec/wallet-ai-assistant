// Runs in its own process under Node's permission model (see tools.ts).
// Reads one PDF and writes its text to stdout.
import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";

const data = await readFile(process.argv[2]);
const pdf = await getDocumentProxy(new Uint8Array(data));
const { text } = await extractText(pdf, { mergePages: true });
process.stdout.write(text);
