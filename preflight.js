// preflight.js — "can this machine actually run the tool, and is this person
// signed in?" Everything the Connections panel needs, in one place.
//
// CREDENTIAL POLICY, deliberately: this tool NEVER asks for, receives, stores
// or transmits a password, API key or token. Sign-in is always handed to the
// vendor's own CLI, which runs its own browser OAuth flow against the
// teammate's own account. We only ever READ whether a session already exists
// (and its expiry), and shell out to the official `login` command. There is no
// field anywhere in this app that takes a secret, and there should never be.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

function run(bin, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const finish = (code) => {
      if (done) return; done = true;
      resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() });
    };
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { err += e.message; finish(-1); });
    child.on('close', finish);
    setTimeout(() => { try { child.kill(); } catch (e) {} finish(-2); }, timeoutMs);
  });
}

function credentialsPath() {
  return path.join(os.homedir(), '.config', 'higgsfield', 'credentials.json');
}

// Reads ONLY the expiry timestamp. The tokens in this file are never read into
// memory, never logged, and never sent anywhere.
function higgsfieldSessionExpiry() {
  try {
    const p = credentialsPath();
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j.expires_at) return null;
    const ms = j.expires_at * 1000;
    return { expiresAt: new Date(ms).toISOString(), hoursLeft: +((ms - Date.now()) / 3600000).toFixed(1) };
  } catch (e) { return null; }
}

async function checkHiggsfield(bin) {
  const res = await run(bin, ['account', 'status', '--json'], 20000);
  const session = higgsfieldSessionExpiry();
  if (!res.ok) {
    const missing = /ENOENT|not recognized|not found/i.test(res.err + res.out);
    return {
      id: 'higgsfield', label: 'Higgsfield', required: true, ok: false,
      state: missing ? 'not-installed' : 'signed-out',
      detail: missing
        ? 'Not installed yet. Click Install — it takes about a minute and needs no terminal.'
        : 'Installed, but this machine is not signed in to a Higgsfield account yet. Click Sign in.',
      fix: missing ? 'npm i -g @higgsfield/cli' : 'higgsfield auth login',
      canInstall: missing,
      canLogin: !missing,
      session,
    };
  }
  let account = null;
  try {
    const j = JSON.parse(res.out);
    account = {
      email: j.email || j.user?.email || null,
      plan: j.plan || j.subscription || null,
      credits: j.credits ?? j.balance ?? null,
    };
  } catch (e) { account = { raw: res.out.slice(0, 160) }; }
  return {
    id: 'higgsfield', label: 'Higgsfield', required: true, ok: true, state: 'signed-in',
    detail: account.email
      ? `Signed in as ${account.email}${account.plan ? ` — ${account.plan}` : ''}${account.credits != null ? `, ${account.credits} credits` : ''}`
      : 'Signed in.',
    account, session, canLogin: false, canLogout: true, fix: null,
  };
}

// FREE, DEFINITIVE LOGIN CHECK — measured, not guessed.
//
// A logged-OUT `claude -p` call fails in about 120ms with
// `is_error: true`, `result: "Not logged in · Please run /login"` and
// `total_cost_usd: 0`. A logged-IN call takes 15-25s and costs ~$0.06.
//
// So a short-timeout probe separates them at zero cost: a fast failure is a
// definitive "logged out", and anything still running when the timeout expires
// must be a real request, which we kill before it can bill anything meaningful.
// This is why the earlier version's "presence only, confirmed on first use"
// compromise is gone — it let a logged-out CLI show a green dot, and the first
// person to click Generate got a wall of raw JSON instead of "sign in".
const CLAUDE_PROBE_MS = 9000;

async function checkClaude(bin) {
  const v = await run(bin, ['--version'], 15000);
  const missing = !v.ok && /ENOENT|not recognized|not found/i.test(v.err + v.out);
  if (missing) {
    return {
      id: 'claude', label: 'Claude Code CLI', required: true, ok: false, state: 'not-installed',
      detail: 'Not installed, or not on PATH for this process. It is what writes the prompts.',
      fix: 'npm i -g @anthropic-ai/claude-code', canLogin: false, canTest: false,
    };
  }
  const version = (v.out || '').split('\n')[0] || 'version unknown';
  const probe = await probeClaudeLogin(bin);

  if (probe.loggedOut) {
    return {
      id: 'claude', label: 'Claude Code CLI', required: true, ok: false, state: 'signed-out',
      detail: `Installed (${version}) but NOT signed in — "${probe.reason}". Prompt drafting will fail ` +
              `until you sign in. Click Sign in, or run \`claude\` in a terminal and use /login.`,
      fix: 'claude', canLogin: true, canTest: true,
      loginNote: 'Run `claude` in a terminal, then type /login and follow the browser prompt.',
    };
  }
  return {
    id: 'claude', label: 'Claude Code CLI', required: true, ok: true, state: 'signed-in',
    detail: `Installed (${version}) and signed in — prompt drafting is available.`,
    fix: null, canLogin: false, canTest: true,
  };
}

// Resolves { loggedOut: true, reason } only on a FAST, explicit auth failure.
// A probe that is still running when the timer fires is killed and treated as
// signed in, because only a genuine request takes that long.
function probeClaudeLogin(bin) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(bin, ['-p', '--no-session-persistence', '--output-format', 'json', '--effort', 'low'],
                        { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const finish = (r) => { if (done) return; done = true; try { child.kill(); } catch (e) {} resolve(r); };
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', () => finish({ loggedOut: false, inconclusive: true }));
    child.on('close', () => {
      const blob = out + err;
      let result = null;
      try { result = JSON.parse(out).result; } catch (e) {}
      const authFail = /not logged in|please run \/login|unauthor|authentication|invalid api key/i.test(result || blob);
      finish(authFail
        ? { loggedOut: true, reason: (result || 'Not logged in').toString().slice(0, 120) }
        : { loggedOut: false, inconclusive: !out });
    });
    // Still alive at the deadline => a real call is in flight => signed in.
    setTimeout(() => finish({ loggedOut: false, killedEarly: true }), CLAUDE_PROBE_MS);
    child.stdin.write('hi');
    child.stdin.end();
  });
}

// The real check, on demand. One bounded call, ~$0.06.
async function testClaude(bin) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(bin, ['-p', '--no-session-persistence', '--output-format', 'json', '--effort', 'low'],
                        { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const finish = (code) => {
      if (done) return; done = true;
      let cost = null;
      try { cost = JSON.parse(out).total_cost_usd; } catch (e) {}
      const good = code === 0 && /"result"|"total_cost_usd"/.test(out);
      resolve({
        ok: good,
        detail: good
          ? `Signed in and working${cost != null ? ` (this test cost about $${cost.toFixed(3)})` : ''}.`
          : `Call failed — most likely not signed in. Run \`claude\` in a terminal and sign in. ${(err || out).slice(0, 200)}`,
      });
    };
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { err += e.message; finish(-1); });
    child.on('close', finish);
    setTimeout(() => { try { child.kill(); } catch (e) {} finish(-2); }, 60000);
    child.stdin.write('Reply with exactly: ok');
    child.stdin.end();
  });
}

async function checkPython(bin) {
  const v = await run(bin, ['-c', 'import sys;print(sys.version.split()[0])'], 15000);
  if (!v.ok) {
    return { id: 'python', label: 'Python + OpenCV', required: false, ok: false, state: 'not-installed',
      detail: 'Python not found. Reference decoding and self-calibration need it; everything else works without it.',
      fix: 'Install Python 3.10+, then: pip install numpy opencv-python-headless', canLogin: false };
  }
  const libs = await run(bin, ['-c', 'import numpy,cv2;print(numpy.__version__,cv2.__version__)'], 30000);
  if (!libs.ok) {
    return { id: 'python', label: 'Python + OpenCV', required: false, ok: false, state: 'missing-libs',
      detail: `Python ${v.out} found, but numpy/opencv are missing. Decoding and calibration are disabled until they are installed.`,
      fix: 'pip install numpy opencv-python-headless', canLogin: false };
  }
  return { id: 'python', label: 'Python + OpenCV', required: false, ok: true, state: 'ready',
    detail: `Python ${v.out}, numpy/opencv ${libs.out} — reference decoding and self-calibration available.`,
    fix: null, canLogin: false };
}

async function checkFfmpeg(bin) {
  const r = await run(bin, ['-version'], 10000);
  return {
    id: 'ffmpeg', label: 'FFmpeg', required: false, ok: r.ok,
    state: r.ok ? 'ready' : 'not-installed',
    detail: r.ok
      ? (r.out.split('\n')[0] || 'Available.')
      : 'FFmpeg not found. Only the Genjutsu left/right mirror fix needs it.',
    fix: r.ok ? null : (process.platform === 'win32'
      ? 'winget install Gyan.FFmpeg' : 'brew install ffmpeg   # or: sudo apt install ffmpeg'),
    canLogin: false,
  };
}

// The billing workspace. Undocumented but mandatory: with none selected every
// Higgsfield call fails, signed in or not. Only checked once sign-in succeeds,
// because it cannot be read while signed out.
function workspaceCheck(hf, CONNECT, bin) {
  if (!hf.ok) {
    return { id: 'workspace', label: 'Billing workspace', required: true, ok: false, state: 'blocked',
      detail: 'Sign in first — the workspace list cannot be read until then.', fix: null };
  }
  // workspaceStatus() already runs `workspace list` internally and now
  // carries the array on its return, so the picker below reuses that instead
  // of spawning the CLI a second time for the same data.
  const st = CONNECT.workspaceStatus(bin);
  if (st.ok && st.selected) {
    // `workspaces` carried here too (not just the none-selected branch below)
    // so the "Use this workspace" picker still has options to switch TO on a
    // team with more than one - previously this branch left it empty and the
    // picker was only ever useful the very first time, before anything was
    // selected yet.
    return { id: 'workspace', label: 'Billing workspace', required: true, ok: true, state: 'selected',
      detail: `Renders bill to "${st.selected.name}". Change it below if that is the wrong account.`,
      workspace: st.selected, workspaces: st.workspaces || [], canPickWorkspace: true, fix: null };
  }
  return { id: 'workspace', label: 'Billing workspace', required: true, ok: false, state: 'none-selected',
    detail: 'No workspace selected — every generation will fail until you pick one. This is what your credits bill to.',
    workspaces: st.workspaces || [], listError: st.listError || null,
    canPickWorkspace: true, fix: 'higgsfield workspace list' };
}

async function preflight(bins) {
  const [hf, cl, py, ff] = await Promise.all([
    checkHiggsfield(bins.higgsfield),
    checkClaude(bins.claude || 'claude'),
    checkPython(bins.python),
    checkFfmpeg(bins.ffmpeg),
  ]);
  const ws = bins.connect ? workspaceCheck(hf, bins.connect, bins.higgsfield) : null;
  const checks = ws ? [hf, ws, cl, py, ff] : [hf, cl, py, ff];
  return {
    checks,
    node: process.version,
    platform: process.platform,
    readyToGenerate: hf.ok && (!ws || ws.ok),
    readyToPrompt: cl.ok,
    readyToDecode: py.ok,
    allRequiredOk: checks.filter(c => c.required).every(c => c.ok),
  };
}

// Opens the vendor's own sign-in in a terminal window the person can see and
// interact with. We do not capture its output, and we never see the credential
// — the CLI writes its own session file in the user's home directory.
function openLoginTerminal(which, bins) {
  const cmd = which === 'higgsfield'
    ? `"${bins.higgsfield}" auth login`
    : 'claude';
  const title = which === 'higgsfield' ? 'Higgsfield sign-in' : 'Claude sign-in';
  try {
    if (process.platform === 'win32') {
      // The empty "" is the window title, and it is not optional. `start` reads
      // the FIRST quoted token as the title, so `start "Higgsfield sign-in"
      // cmd /k "C:\...\hf.exe" auth login` consumed the real title, then took
      // the quoted exe path as a title too and tried to run the rest, giving
      // '"C:\...\hf.exe"' is not recognized as an internal or external command.
      // Passing "" first means the quoted path is always read as the command.
      spawn('cmd', ['/c', 'start', '', 'cmd', '/k', cmd], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell app "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`,
                          '-e', 'tell app "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']
        .find(t => { try { return !spawn.sync(t, ['--version'], { stdio: 'ignore' }).error; } catch (e) { return false; } });
      if (!term) return { ok: false, error: 'No terminal emulator found — run the command yourself.', cmd };
      spawn(term, ['-e', `bash -lc '${cmd}; read -p "Press enter to close"'`], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, cmd, note: 'A terminal window opened. Finish signing in there, then click "Re-check".' };
  } catch (e) {
    return { ok: false, error: e.message, cmd };
  }
}

module.exports = { preflight, testClaude, openLoginTerminal, credentialsPath, higgsfieldSessionExpiry };
