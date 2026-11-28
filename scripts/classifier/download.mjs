// Downloads the injection classifier (the ONNX export the app runs) from Hugging
// Face into models/injection-classifier/, and verifies every file.
//
//   npm run setup:classifier            (or: node scripts/classifier/download.mjs [--dir <folder>])
//
// - Pinned to one Hugging Face commit, so a later change to the repo cannot
//   change what is downloaded.
// - Every file is checked against a SHA-256 checksum kept in this repo. A file
//   that does not match is refused and nothing is installed: the classifier is a
//   safety check, so an unknown model must never take its place.
// - https only. Files are written to a temporary name and moved into place once
//   verified. Files already present and correct are skipped.
// - Needs Node 18+ only; no Python, no Hugging Face account.
//
// The app itself never downloads anything: it loads these local files only.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = "interiiteth/wallet-injection-classifier";
/** Hugging Face commit the files below come from. */
const REVISION = "3b92edc4c0af84d93a55fad327857ce03dd7e359";

/** Path in the repo -> size in bytes and SHA-256, taken from the verified local export. */
const FILES = {
  "config.json": { size: 1022, sha256: "2cbeda7e45ecb2e430754e0418eadc02002b05093e19c496c02c6660d9741e3f" },
  "tokenizer.json": { size: 8332368, sha256: "9968642089e08abb0a771056c4d4130cbb20c987d32f3d2831acfe357fc43e4c" },
  "tokenizer_config.json": { size: 1629, sha256: "c32bc20d05b36ec4cc7c3bce17be5a65930354aa2a37c1c4d6f730e0d24cd35e" },
  "special_tokens_map.json": { size: 970, sha256: "b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21" },
  "filter_config.json": { size: 5115, sha256: "65303bd5cd61feff32679cbe273e19d9e8b4ba4ade79383bea34b917728bc5f3" },
  "onnx/model.onnx": { size: 738604996, sha256: "0db59d8125be0290015014093a99124189fbedb68103d37abef642533daa0752" },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirArg = process.argv.indexOf("--dir");
const target = dirArg > 0 ? path.resolve(process.argv[dirArg + 1]) : path.join(root, "models", "injection-classifier");

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function sha256Of(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function alreadyGood(file, expected) {
  try {
    if ((await stat(file)).size !== expected.size) return false;
    return (await sha256Of(file)) === expected.sha256;
  } catch {
    return false;
  }
}

async function download(name, expected) {
  const dest = path.join(target, name);
  if (await alreadyGood(dest, expected)) {
    console.log(`  ok        ${name} (already present)`);
    return;
  }
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${name}`;
  const response = await fetch(url, { redirect: "follow" });
  // Hugging Face serves large files from its CDN; every hop must stay on https.
  if (!response.url.startsWith("https://")) throw new Error(`${name}: redirected to a non-https address`);
  if (!response.ok || !response.body) throw new Error(`${name}: download failed (HTTP ${response.status})`);

  await mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  const hash = createHash("sha256");
  let received = 0;
  let lastShown = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      if (expected.size > 50e6 && received - lastShown > 25e6) {
        lastShown = received;
        process.stdout.write(`\r  ...       ${name} ${mb(received)} of ${mb(expected.size)}`);
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial));
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  if (expected.size > 50e6) process.stdout.write("\n");
  const digest = hash.digest("hex");
  if (received !== expected.size || digest !== expected.sha256) {
    await rm(partial, { force: true });
    throw new Error(`${name}: checksum mismatch (got ${digest.slice(0, 12)}…, ${received} bytes). The file was not installed.`);
  }
  await rename(partial, dest);
  console.log(`  verified  ${name} (${mb(received)})`);
}

console.log(`Injection classifier: ${REPO} @ ${REVISION.slice(0, 8)}`);
console.log(`Into: ${path.relative(process.cwd(), target) || "."}`);
try {
  for (const [name, expected] of Object.entries(FILES)) await download(name, expected);
  console.log("Done. Every file matches its checksum. Restart the app if it is running.");
} catch (error) {
  console.error(`\nSetup failed: ${error.message}`);
  console.error("Nothing unverified was installed. Check your connection and run the command again.");
  process.exit(1);
}
