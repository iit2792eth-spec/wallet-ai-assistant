# Wallet Access Layer

An access layer between an AI model and an Ethereum wallet. The model interprets
requests and writes a small program; it never signs, never sees keys, and never
sees real addresses. Built for the Ethereum Foundation problem statement at
Inter IIT Tech Meet 15.0.

## Status

| Part | State |
|---|---|
| User interface, approvals, contacts, limits, settings | Built |
| SQLite database | Built |
| AI layer | Built |
| Text Encoder and Text Decoder | Built (`text-encoder/`, `text-decoder/`) |
| Access layer (QuickJS sandbox, policy checks) | Built (`access/`) |
| Wallet layer (keystore, viem) | Built (`wallet/`); Settings can create, import, unlock and lock a wallet and show balances. Not yet called by the access layer |

## Setup

Requires Node.js 22 or later (developed on Node 26).

```bash
npm install
npm run dev          # http://localhost:3000
```

The database (`data/app.db`) is created on first start from `db/schema.sql`.
Add a model under Settings before using the chat; models can be edited later.
Models are built with LangChain's `initChatModel` (`ai/model/factory.ts`). Base URL
is optional: leave it empty for OpenAI, Anthropic, Google, or Ollama on
`http://localhost:11434`, and set it only for a custom or remote endpoint
(e.g. an OpenAI-compatible server). Changing a model's provider or base URL
removes its saved API key, so a key is never sent to a different host.

Web pages, PDFs and pasted messages also need the prompt-injection classifier
(739 MB, not in git). Export it once from the fine-tuned model in
`v2_data_fix/model`:

```bash
pip install -r scripts/classifier/requirements.txt
sh scripts/classifier/export-onnx.sh   # writes models/injection-classifier/
```

Without it, typed requests work but documents and pasted messages are refused.

## AI layer

Specification: `docs/AI_layer.txt`. Code: `ai/`. Entry point: `runAiLayer` in `ai/index.ts`.

```
Query -> Planning -> (Executor) -> Coder <-> Code Verifier -> result
```

The result is exactly one of `code`, `clarification` or `rejection` (`ai/schemas.ts`).

| Path | Purpose |
|---|---|
| `ai/graph.ts`, `ai/nodes/` | The LangGraph state machine and its nodes |
| `ai/verifier/ast-checks.ts` | Deterministic checks on the generated code (the guarantee) |
| `ai/verifier/llm-review.ts` | Model review for logical errors (best effort) |
| `ai/verifier/dry-run.ts` | Runs the code in QuickJS on sample data: catches run-time errors and tells the reviewer what the code did |
| `ai/manifest/function_manifest.json` | Functions the sandbox provides; the Coder's reference and the verifier's allowlist |
| `ai/subagents/` | Web Scraping and PDF Reader tools, and field extraction |
| `ai/net/` | Network guards for the scraper and the model client |
| `ai/model/` | Model factory and JSON reply validation |
| `ai/config.ts` | Limits: `MAX_CLARIFICATION_ROUNDS`, `MAX_CODE_REVISIONS`, supported units |

### Existing components and what we built

| Existing | Used for |
|---|---|
| The model the user selects (any OpenAI-compatible, Ollama, Anthropic or Google model) | Planning, extraction, coding, review |
| LangGraph, LangChain chat model clients | Graph runtime and model connections |
| acorn, acorn-walk | Parsing the generated JavaScript |
| quickjs-emscripten | Running generated code against fake functions in tests |
| unpdf, html-to-text, undici | PDF text, HTML text, HTTP client |
| zod | Schema validation |

Built here: the graph and its nodes, the prompts, the function manifest, the
code verifier, the output schemas, the network guards, the sandboxed PDF reader
process, the stub encoder and decoder, and the tests.

### What is enforced in code

- Every model reply is validated against a strict schema; unknown fields and result types are rejected.
- The clarification and code revision limits are counted in code.
- Units, tokens and amount formats are checked against allowlists.
- The planner rejects only requests that need data or actions no function provides (prices, swaps, other chains). Anything computable from function results is planned as code: filtering, totals, grouping, sorting, dates. The program gets the current time from `now()`, fixed for the whole request so the dry run and the real run agree; `new Date()` without arguments and `Date.now()` are not available.
- Generated code may call only manifest functions and an allowlist of built-ins. Placeholders may appear only as complete string literals of an allowed type that the encoder knows.
- Web and PDF text passes through the Text Encoder inside the tool wrapper, before any model sees it. Extracted values are tagged `origin: "external"` and must be listed in `external_fields`.
- The scraper can reach only the host of the URL the user wrote. Internal, private and link-local addresses are blocked at DNS resolution, and each redirect is re-checked.
- The model client can reach only the configured provider host.
- The PDF reader runs in a separate Node process under the permission model, with no network.
- The model review is best effort and cannot loop. It reviews the code's behaviour on sample data, must cite the exact line it objects to, and gets one say on each objection. If the Coder keeps its code, or the reviewer repeats itself, the objection is shown to the user as an unverified note instead of blocking.

### Privacy

Everything the model receives goes to the model provider: the masked prompt,
encoded fields extracted from pages or PDFs, the function manifest, code drafts
and verifier feedback. Placeholders hide addresses, ENS names, emails, phone
numbers, private keys and seed phrases. They do not hide amounts, contact names
or other text. Results of running code (balances, history) are never sent to
any model.

### HTTPS only

Settings → Security → **HTTPS only**, on by default (`lib/https-only.ts`). While it is on:
- **A request is refused before anything is sent to the model** if the active model's endpoint (its base URL, or the provider's default) is not `https://`. The message names the model and URL (`pipeline/handle-message.ts`). The model client also refuses non-https URLs itself (`ai/net/host-locked-fetch.ts`). That second check covers every provider except Google, whose client takes no custom fetch, so for Google only the first check applies.
- **A web page or a PDF given as a URL is refused if it is `http://`,** and so is every redirect. An https page cannot hand the fetch over to http (`ai/net/guarded-fetch.ts`). The reason is shown to the user.
- **RPC URLs** (the network's RPC URL in Settings → Network, and the ENS RPC URL) must be `https://`. Every RPC connection, reads and sends alike, is refused before any request with the error `HTTPS_REQUIRED` (`wallet/clients.ts`). Saving an http RPC URL is refused while the setting is on.
- **The model form and the RPC URL field warn** when an address would be refused.

A local model served over http, such as Ollama's default `http://localhost:11434`, is refused while the setting is on. Turning it off needs an unlocked wallet, like every other settings change, and is recorded in the audit log (`setting_changed`). Refusals are recorded too (`https_only_refused`, `ai_document_failed`).

### Known limits

- The network policy is enforced inside the application, not by the operating system. macOS has no network namespaces, and Next.js is one process.
- A local model's own process (for example Ollama) is outside the app. Whether it makes outbound connections has to be checked by capturing traffic.
- The Google client does not accept a custom fetch, so the provider host lock does not apply to it.
- The stub encoder uses simple patterns. It is for development and tests, not a privacy guarantee.

### Activity stream

While a request runs, the chat shows a live list of what is happening, collapsed to one line when it finishes. Three sources, so the user never relies on model text for facts:

- **The app's own stages** (plain text): understanding the request, reading a document, writing and checking the program, restoring addresses, the safety checks, the dry run, checking balances, fees and limits, waiting for unlock or approval, and each transfer with its result.
- **Every wallet read** (indented detail lines, written by the access layer): "Reading your ETH balance", "Estimating the network fee", and so on.
- **The program's own narration** (italics): the Coder writes `ui.step("...")` lines into the program, shown as it runs. At most 15 lines of 100 characters, and the Coder is told to describe actions only, never to claim something is safe or approved.

The real run repeats the dry run's narration up to its first proposal, so that part is hidden; only what happens after approval is added.

### Conversation memory

The model sees the whole current request (including a pasted message and the answers to its clarification questions), but from earlier requests only trusted history: the user's typed messages and a record of what the access layer actually did, such as "(Send 0.5 ETH to [WALLET_ADDRESS_1]: confirmed.)". Records are written from fixed templates and real outcomes, never by a model, and an address the model was never given is not revealed. Pasted text, the planner's questions and anything the model wrote never carry over, so a planted "earlier conversation" or a steered summary cannot influence a later request. Follow-ups such as "actually, send 1 ETH more" still work through the record.

### Web pages and PDFs

Ask about or act on a page or PDF by naming it: "pay the invoice in /path/invoice.pdf", "what does https://example.com say?". The planner lists it as external data; the Executor fetches it (web) or reads it in a sandboxed process (PDF), encodes the text, and a model extracts only the values needed. Those values reach the program tagged as external, and a recipient from a document always gets a warning and never auto-approval. A `.json` file is never read as a document: it is typed data to sign.

**Payments in a document are read segment by segment, and code checks the result** (`ai/subagents/extract.ts`). This applies to web pages and PDFs, tables and prose alike. A model asked to copy out many similar rows drops some, so the model is never trusted to be complete:
1. **Split.** The encoded text is split into numbered segments (table lines, sentences), using the injection check's segmenter.
2. **Count.** Code picks every segment that could hold a payment: one with an address or ENS placeholder, or with an amount and a unit. Code knows exactly how many there are.
3. **Answer by number.** The model answers for each of those segments: its payments, or none with a reason (header, sender only, total, information, instruction to ignore, other). It sees about 40 segments at a time, each with its neighbours, and several batches run at once.
4. **Check the accounting.**
   - **Complete:** every candidate needs an answer. Missing or invalid answers are asked again, up to three rounds in all. After that the request stops and names the lines.
   - **Faithful:** the recipient must be written in that segment. The amount must be written in that segment or the one next to it (or be "all"). The unit must be written in the document.

The result is one `payments` table in document order. The activity stream shows the accounting, for example "99 lines could hold a payment: 99 payments read", and lists what was set aside and why. Set-aside lines are also listed on the first approval card, with the line itself (up to 5 per document, `pipeline/set-aside.ts`), so a payment the model wrongly skipped is seen before anything is approved. The audit log records the line numbers and reasons (`ai_document_extracted`). The program reads the table with `external.rows("payments")` at run time, and never copies it into its code. The Coder and reviewer see only the columns, the row count and the first three rows. The Text Decoder restores the address cells, all or nothing, like the code.

Limits:
- **Text read per document:** 100,000 characters. The activity stream says when a document was cut.
- **Payments per request:** 1,000. A document with more candidate lines is refused before any model call, with the count, and the user can ask for part of it.
- **JavaScript-built pages** come back nearly empty.
- **Scanned PDFs** (images only) have no text to read.

If a document cannot be used, the message says whether reading or extraction failed, and the audit log (`ai_document_failed`) records the cause.

### Injection classifier

Before any model sees a web page, PDF or pasted message, the text is split into
sentences and each one with words in it (not bare address/amount rows) is scored by our fine-tuned DeBERTa classifier, running
locally in the Next.js process (ONNX, `injection-filter/`). Typed messages are not
checked. If any sentence scores at or above the threshold the model was trained
with (0.0849), the user is told how many sentences were flagged, can open them with their
scores (**View flagged sentences**), and chooses **Remove flagged and continue**, **Continue anyway** or
**Cancel request**; nothing is removed silently. The later approval card says what
was removed or kept. If the classifier cannot run, the text is not used.
Evaluation and the choice of threshold: `docs/Injection_Classifier.md`.

### Swaps (Uniswap)

"Swap 0.01 ETH to USDC", "buy 100 USDC with ETH" or "how much USDC would 0.5 ETH get me?" work with ETH, USDC and EURC, through Uniswap v3 on Sepolia. The contracts are SwapRouter02 and QuoterV2, checked on chain, with addresses in the `dex_contracts` table. On Sepolia only ETH↔USDC has real liquidity; the EURC pools are tiny.

The model only states the intent: `{ action: "swap", tokenIn, tokenOut, amountIn | amountOut, slippage? }`. Everything that makes a swap dangerous is set in code (`access/analysis.ts`, `access/execute.ts`, `wallet/uniswap.ts`):
- **Pool:** all four fee tiers (0.01%, 0.05%, 0.3%, 1%) are quoted, and the best one is used.
- **Limits:** the least you accept (exact input) or the most you pay (exact output) comes from the quote and the slippage.
- **Recipient** is always your own wallet; a swap action with a recipient field is refused.
- **Deadline:** 10 minutes. The router comes from the database, never from the program.
- **Paying with a token:** the router may take exactly the most you may pay, through an EIP-2612 permit signed after approval and used inside the same transaction (`selfPermit` in the router's `multicall`). No allowance is left behind. ETH out is unwrapped by the router; unused ETH on an exact-output swap is refunded.
- **Slippage:** Settings → Security → Swap slippage (default 0.5%). It can be changed for one request only with a figure in your own typed words ("with 2% slippage"), checked in code. A figure from the model, a document or pasted text is ignored, and the card says so. There is no upper limit, but a typed figure above your setting first needs a separate **"Higher slippage than your setting"** confirmation; cancelling it cancels the request.
- **Price impact** is measured against the pool's own price, after its fee. A warning above 2%; the swap is blocked above 10%. On testnets, pool prices are not market prices, so this guards against thin pools, not wrong prices.
- **Never automatic:** swaps always show a card and do not count against spend limits.
- **Steps that depend on a swap** ("swap 0.01 ETH to USDC, then send 100 USDC to Bob"):
  - Only the swap's guaranteed minimum counts towards later steps.
  - A step the node cannot estimate yet gets a default gas limit, and is estimated again when sent.
  - A swap is a barrier: transfers sent before it are confirmed first, and nothing after it is sent until it is confirmed.
- **Just before sending,** the swap is quoted again on the same pool. If the price got worse than the limit you approved, nothing is sent.

The swap card shows: pay, receive at least (or exactly), the quote, the slippage and where it came from, the pool fee, the price impact, the recipient (your wallet) and the fee. Swaps are recorded as `swap` actions (database version 3) with what actually arrived, read from the receipt, and appear on the Activity page.

### Explain, prepare or sign

There is no mode switch: the mode comes from the request. The planner reads it ("what would happen if..." is explain, "prepare..." or "don't send yet" is prepare, otherwise sign), and code caps it using phrases in the user's own messages, so neither the model nor web or PDF content can turn an explain or prepare request into signing. The mode is shown on the summary card and passed to the access layer with the code.

### Tracing with LangSmith (optional)

For developing and testing the AI layer. Off by default. To turn it on, copy
`.env.example` to `.env.local` and set:

```bash
AI_TRACING=langsmith
LANGSMITH_API_KEY=...
LANGSMITH_PROJECT=wallet-access-layer   # optional
```

Each request then appears in LangSmith as an `ai_layer` run, with one child
per node (planning, executor, coder, code_verifier) and per model call. The
same settings apply to `npm test` and `npm run test:live`.

Traces are uploaded to LangSmith, a third party. That is outside the network
policy above, so keep it off for demos with real data. Traces contain what
the model sees (masked prompts, plans, code drafts, verifier errors), and
every value is redacted before upload as a second line of defence. Only
`AI_TRACING` turns tracing on: LangChain's own `LANGSMITH_TRACING` is
switched off, because it would upload without redaction.

## Text Encoder and Text Decoder

Specifications: `docs/Text_encoder.txt`, `docs/Text_decoder.txt`. Both are deterministic, with no model.

**Encoder** (`text-encoder/`). Replaces private values with numbered placeholders before any text reaches the AI layer. Rules apply in order, most specific first, and a span claimed by one rule cannot be matched by a later one:

1. Private key: 64 hex characters, with or without `0x` -> `[PRIVATE_KEY_N]`
2. Wallet address: `0x` + 40 hex characters -> `[WALLET_ADDRESS_N]`
3. Seed phrase: 12 to 24 consecutive BIP-39 words -> `[SEED_PHRASE_N]`
4. Malformed address (for example `0x8u80...` or a 39-character typo) -> `[INVALID_ADDRESS_N]`; the AI layer then asks the user to check it, without calling the model
5. Email, ENS name, phone number -> `[EMAIL_N]`, `[ENS_NAME_N]`, `[PHONE_N]`

Text that already looks like a placeholder is treated as an invalid address, so it can never alias a real one. Values the user gave are mapped per chat session, in memory, in private fields with no way to read the mapping out. The mapping is cleared five minutes after the last browser tab for the session disconnects.

**Decoder** (`text-decoder/`). The specification describes a list of action proposals; the AI layer outputs a program instead, so the same rules are applied to the program:

- The result must match the code result schema exactly, the code must parse, and it must not contain a raw address or key (the model never sees one, so one there was invented).
- A private key or seed phrase placeholder anywhere rejects the result.
- Wallet address and ENS placeholders are restored only where they stand whole in an address position: a transfer `to`, a getBalance `address`, the argument of `wallet.lookupEns`/`resolveEns`, an array element, a variable's value, or one side of `===`. The Code Verifier uses the same rule, so verified code can always be decoded.
- Rejections use the specification's reasons (`schema_violation`, `unknown_placeholder`, `forbidden_placeholder`, `placeholder_in_ineligible_field`) and messages that never contain a restored value. All or nothing: one bad placeholder rejects the whole result.
- Not detectable by the decoder: one valid placeholder swapped for another. The approval card shows the real recipient, so the user and the access layer catch it.

## Access layer

Specification: `docs/Access_layer.txt`. Code: `access/`. Entry point: `runPlan({ sessionId, decoded, mode })`, called by `pipeline/handle-message.ts` after the Text Decoder.

How a request runs:

1. **Validate** the decoded program with the Code Verifier's deterministic checks (`access/validator.ts`).
2. **Dry run** it in the QuickJS sandbox with real reads; `propose()` only records what the program would do (`access/index.ts`).
3. **Check every action together** (`access/analysis.ts`): security problems block the whole plan; otherwise it finds the longest run of steps from the start that can be completed, and whether saved limits allow running without asking.
4. **Explain / prepare**: show a card of what would happen. **Sign**: automatic approval within limits, or the user reviews the plan in batches of 20 steps, one card per batch (`approve` in `access/index.ts`). There is no limit on the number of steps per request, apart from a 1,000-action ceiling against runaway programs.
   - **Each row has a checkbox.** The buttons are **Approve all**, **Approve selected (n)** and **Cancel remaining** ("Cancel" when there is one batch).
   - **The card rechecks feasibility as rows are unticked,** using the same rules as the server (`lib/feasibility.ts`). Steps run in order, and a step that cannot be completed stops every later step, unless the user unticks it. Unticking frees balance for the rows after it.
   - **Before each card, the server rechecks** with every row left out so far. The card shows the balances left after the batches already approved. If an approved row cannot be completed, the remaining batches are not shown, because none of their rows could run.
   - **Cancel** leaves out this batch and the rest; batches already approved are still sent. **An expired card** cancels the whole request: nothing is sent.
5. **Run it for real**, only after every batch has been reviewed, executing exactly the approved actions through the Wallet Layer.
   - **Pipelined sending:** each batch is sent without waiting between transfers (consecutive nonces, `executeBatch` in `access/execute.ts`), then the whole batch is awaited.
   - **On failure:** if a transfer fails, the next batches are not sent. Transfers already sent in the same batch stay sent.
   - **Time limit:** the run gets 10 minutes plus 15 seconds per approved step.
   - **If the program proposes something different this time** (a balance changed), that batch is checked and approved again on its own.
6. **Record** each sign-mode action in `actions`, and report each step's outcome in chat. Unticked rows are recorded as `rejected`. The AI layer learns only "completed", "cancelled" or "failed", and the conversation record of a plan with more than 10 steps is a summary (counts and totals), so later prompts stay short.

| Check | Where |
|---|---|
| Program uses only manifest functions and allowed built-ins; no placeholders left; no private keys | `access/validator.ts` (shared with `ai/verifier/ast-checks.ts`) |
| No network, files, timers or host objects; memory 32 MB, stack 128 KB, 2 s CPU (waits excluded), 10 min total (plus 15 s per approved step for the real run), 2,500 host calls, 20 `ui.show`, 5 `propose`, 1,000 actions per plan (reviewed 20 per card) | `access/sandbox.ts`, `access/config.ts` |
| Everything leaving the sandbox is a frozen copy; only what was approved is executed | `access/sandbox.ts`, `access/index.ts` |
| `getBalance` only for the user's own wallet, refused before any RPC call | `access/host.ts` |
| `ui.show` content: title, text and list only, plain strings, size caps | `access/host.ts` |
| Action schemas: transfer and sign_typed_data, no unknown fields, amount > 0 | `access/actions.ts` |
| Recipient: address, ENS name or saved contact name; provenance user / contact / external / untrusted | `access/recipients.ts` |
| Running balance per token plus every fee, gas estimate failures, token configured, recipient resolvable | `access/analysis.ts` |
| One fee estimate per recipient for the whole plan: the program's `wallet.estimateFee()`, the feasibility check and the sent transaction's gas and fee caps all use it, so "balance minus fee" always fits | `access/fees.ts`, `wallet.transfer({ fees })` |
| Saved limits: per transaction, rolling 24 h and 7 d, batch totals; only transfers to user or contact recipients are auto-approved | `access/analysis.ts`, `access/record.ts` |
| A request that read a web page or PDF always asks, whatever the limits (decided from what the AI layer fetched, not what the model declared) | `ai/index.ts` (`external`), `access/analysis.ts` |
| Pasted text is detected two ways: the chat box reports any paste or drop, however short, and the server also flags text that looks pasted (over 300 characters, markup, a transcript with "User:"/"You:" lines, or several lines with an address). Its addresses are recorded as pasted, never as typed by you, in this request and later ones, and the request always asks with a warning. This blocks "fake earlier conversation" memory injection | `lib/pasted.ts`, `pipeline/handle-message.ts`, `access/recipients.ts` |
| Typed data: valid EIP-712; chain or owner mismatch blocks; Permit / Permit2 summarised; unknown types warned; never auto-approved; files never read from `data/` | `access/typed-data.ts` |
| Explain and prepare never sign or send | `access/index.ts` |
| Stop at the first failed step; later steps are skipped | `access/index.ts`, `access/execute.ts` |
| Card text from templates, never from the model | `access/templates.ts` |

ENS lookups (`wallet.resolveEns`, `wallet.lookupEns`, and ENS recipients) reveal the name or address to the mainnet RPC set in `ens_rpc_url`.

Signing can be asked for in three ways:

- **In words**, e.g. "sign a permit letting Ravi spend 25 USDC for a week". The program uses the `permit` template; the access layer reads the token's EIP-712 name, version, contract and the wallet's nonce from the chain (`wallet.getPermitData`) and builds the EIP-2612 message. The model never writes a domain, contract address or nonce. The deadline defaults to one hour.
- **Pasted typed data.** Addresses inside it are masked for the model and restored by the decoder anywhere inside `typedData` or `params`.
- **A JSON file path.** The file is read by the access layer, so its contents never reach the model.

Known limit: a 64-character hex value inside pasted typed data (for example a bytes32 salt) is masked as a possible private key, so the request is refused. Use a file path for such data.

## Wallet layer

Code: `wallet/`. Built on viem with a local encrypted keystore; MetaMask is not used. It does no checks: the access layer validates every input and gets the user's approval first. One function per task:

| Task | Function | Needs unlocked wallet |
|---|---|---|
| Balance | `getBalance({ token, address? })` | No |
| ENS name to address | `resolveEns({ name })` | No |
| Address to ENS name | `lookupEns({ address })` | No |
| Send ETH, USDC or EURC | `transfer({ token, to, amount, waitMs? })` | Yes |
| Sign EIP-712 data | `signTypedData({ typedData })` | Yes |
| This app's activity | `getActivity({ limit?, kind? })` | No |

Keystore management: `getWalletStatus`, `createWallet`, `importWallet` (private key or seed phrase), `unlockWallet`, `lockWallet`, `removeWallet` (needs the password; deletes the keystore). In the app: Settings > Wallet, and the wallet badge in the top bar (click to unlock or lock). Opening the app with a locked wallet asks for the password.

- Amounts are BigInt in base units. `transfer` waits for the transaction and returns `confirmed`, `reverted` or `pending`, with the hash, fee and an explorer link.
- ENS is read from Ethereum mainnet (setting `ens_rpc_url`); everything else uses the active network.
- Every failure is a `WalletError` with a `code`, a `message` safe to show the user, and `retryable`.
- The keystore (`data/keystore.json`, file mode 600) holds the key encrypted with AES-256-GCM under a scrypt-derived key. The password is never stored. While unlocked, the key is held in server memory only, and is dropped on lock, after 15 idle minutes, or on restart.
- Log lines shorten addresses (`0x1234…7890`) and hashes; private keys, seed phrases, passwords and signatures are never logged.

## Tests

```bash
npm test             # deterministic tests (AI layer, encoder, decoder, wallet, access layer); writes results/test-results.json
npm run test:access  # access layer only; writes results/access-results.json and .md
npm run test:live    # runs against the model selected in Settings; writes results/ai-live.json and .md
```

The deterministic tests cover the code verifier, schemas, counters, the encoder
path and the network guards. The live tests cover legitimate, ambiguous,
unsupported, extraction and malicious-content requests, and record latency,
Coder rounds and peak memory for each run.

Not yet measured: RAM and latency per request on a local model. `npm run test:live` records both.
