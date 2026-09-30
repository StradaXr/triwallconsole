'use strict';
// Local assistant helper. It talks to the running console; it never edits
// state.json behind the server's back and never submits inference requests.
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const base = `http://127.0.0.1:${Number(process.env.ASTRA_PORT || 8937)}`;
  const [command, id, file] = process.argv.slice(2);
  if (command === 'pending') {
    const r = await fetch(`${base}/api/queue`); if (!r.ok) throw new Error(await r.text()); console.log(JSON.stringify(await r.json(), null, 2)); return;
  }
  if (!['complete', 'draft'].includes(command) || !id || !file) throw new Error('Usage: node astra/bridge.js pending | complete <job-id> <image.png> | draft <job-id> <prompt.txt>');
  const stateResponse = await fetch(`${base}/api/state`); if (!stateResponse.ok) throw new Error(await stateResponse.text());
  const state = await stateResponse.json();
  const content = fs.readFileSync(path.resolve(file));
  const body = command === 'complete' ? { id, data: content.toString('base64'), source: 'ChatGPT / Codex built-in image tool' } : { id, prompt: content.toString('utf8') };
  const response = await fetch(`${base}/api/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Astra-Token': state.sessionToken }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  console.log(JSON.stringify(result.jobs.find(j => j.id === id), null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
