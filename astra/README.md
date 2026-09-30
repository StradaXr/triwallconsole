# Tri-Wall Astra — connected image workspace

A separate image-only console with the Tri-Wall look and feel, three wall cards,
reference uploads, composition rules, prompt drafting, image generation,
refinement, PNG downloads, ratings and a persistent local library.

## Run

Install Codex and sign in with ChatGPT, then run `npm run start:astra` and open
http://localhost:8937/. On Windows, use `Launch Astra Console.bat`.
Requires Node 18+, Codex with built-in image generation (verified with 0.159.2),
and access to GPT-6 Astra. No API key or Higgsfield account is used.
`ASTRA_CODEX_BIN` can specify the Codex executable; otherwise the bundled
Windows install is discovered, with `codex` on PATH as fallback.

Default data: `astra/.local/`. `ASTRA_DATA_DIR` changes the media/data folder;
`TRIWALL_STATE` overrides its state file. `ASTRA_PORT` changes the port.
The launcher sets independent state. Never share state between instances.

## Work entirely in the console

1. Describe the scene or upload a center reference.
2. Press Generate image or Draft prompt. Codex works in the background;
   progress and results appear here automatically.
3. Generate left & right uses the completed left as a reference for the right
   when match-sides is enabled. Refine preserves previous images in Library.
4. If a result is not exactly 16:9, inspect the original and click Fit & use
   to center-trim and resize to the selected size. The original is preserved
   and downloadable. This is resampling, not native higher-resolution output.

GPT-6 Astra directs requests; the built-in image tool renders them. Size and
quality are directions, not guaranteed rendering parameters. The importer
measures every result. The app and images are stored locally; inference runs
at OpenAI and consumes the signed-in Codex subscription's usage allowance.

The integration uses the official local `codex app-server` protocol over stdio.
Codex owns authentication; this app never reads tokens, accepts API keys or
uses unofficial inference endpoints. It verifies a ChatGPT account before
starting turns and uses ephemeral sessions with read-only sandboxing. Shell,
apps and plugins are disabled for this dedicated worker; unexpected approvals
are not granted. Failed/interrupted jobs are not automatically retried. After
a restart, click Run waiting requests for previously queued work.

Sources: https://learn.chatgpt.com/docs/app-server and
https://learn.chatgpt.com/docs/image-generation . The external SIWC hosted-tool
restriction does not apply to this native Codex workflow.

## Development

`npm run test:astra` verifies isolated queue/import/worker behavior without AI
requests. `codex.js` owns protocol calls; `worker.js` runs one job at a time.
`bridge.js` and `CHAT-WORKFLOW.md` remain for explicit manual recovery only;
do not process the same queue manually while the worker is active.

Source lives in this Git repository. Styles reuse root index.html, angles use
`theatre.js`. Local state, generated images and logs are ignored by Git.
The shared main-branch theme, Space Grotesk/JetBrains Mono fonts and light/dark
choice are also used by Astra. Its image controls remain specific to Codex.
The server binds to 127.0.0.1, validates Host/Origin, requires a per-process
mutation token and serves allowlisted files. The legacy video console is separate.
