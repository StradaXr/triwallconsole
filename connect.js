// connect.js — finding the Higgsfield CLI, installing it, and signing in.
//
// WHY THIS IS ITS OWN FILE, AND WHY THE RESOLVER IS THIS PARANOID
// ---------------------------------------------------------------
// The original resolver was:
//
//     if (win32 && APPDATA) { try %APPDATA%\npm\...\vendor\hf.exe }
//     return 'higgsfield';
//
// Both halves fail on a real machine:
//
//   1. `%APPDATA%\npm` is only npm's global prefix on a DEFAULT Windows npm
//      install. Any machine using nvm/fnm/volta, a corporate image, or a
//      bundled Node (observed in the wild: prefix = ...\AppData\Local\hermes\
//      node) puts global packages somewhere else entirely, so the vendored
//      binary is never found.
//   2. The fallback returns the bare string 'higgsfield', which only works if
//      npm's global BIN directory happens to be on this process's PATH. A
//      double-clicked launcher does not reliably inherit an interactive
//      shell's PATH — the same reason ffmpeg needed explicit resolution.
//
// So it would report "not installed" on a machine where it WAS installed, and
// would also fail right after a successful install. This resolver asks npm
// where its global prefix actually is, checks every known layout for both
// platforms, and falls back to PATH only as a last resort.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

function runSync(bin, args, timeout = 20000) {
  const r = spawn.sync(bin, args, { encoding: 'utf8', timeout });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || (r.error && r.error.message) || '').trim() };
}

let cachedPrefix = null;
function npmGlobalPrefix() {
  if (cachedPrefix !== null) return cachedPrefix;
  const r = runSync('npm', ['prefix', '-g']);
  cachedPrefix = r.ok && r.out ? r.out.split('\n').pop().trim() : '';
  return cachedPrefix;
}

// Every place a globally-installed @higgsfield/cli can put its vendored Go
// binary, across platforms and npm layouts.
function candidatePaths() {
  const exe = process.platform === 'win32' ? 'hf.exe' : 'hf';
  const rel = ['@higgsfield', 'cli', 'vendor', exe];
  const roots = [];
  const prefix = npmGlobalPrefix();
  if (prefix) {
    roots.push(path.join(prefix, 'node_modules'));           // Windows npm layout
    roots.push(path.join(prefix, 'lib', 'node_modules'));    // POSIX npm layout
  }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  roots.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'));
  roots.push('/usr/local/lib/node_modules');
  roots.push('/usr/lib/node_modules');
  if (process.env.npm_config_prefix) {
    roots.push(path.join(process.env.npm_config_prefix, 'node_modules'));
    roots.push(path.join(process.env.npm_config_prefix, 'lib', 'node_modules'));
  }
  return roots.map(r => path.join(r, ...rel));
}

// Returns { bin, source } or null. `source` is for the UI, so a person can see
// WHERE it was found when something looks wrong.
function resolveHiggsfield() {
  if (process.env.TRIWALL_HF && fs.existsSync(process.env.TRIWALL_HF)) {
    return { bin: process.env.TRIWALL_HF, source: 'TRIWALL_HF environment variable' };
  }
  for (const c of candidatePaths()) {
    if (fs.existsSync(c)) return { bin: c, source: 'vendored binary in the npm global folder' };
  }
  // Last resort: a wrapper on PATH. On Windows this is a .cmd shim, which
  // truncates multi-line arguments at the first newline — the documented
  // prompt-truncation bug — so it is genuinely the last choice, not the first.
  for (const name of ['higgsfield', 'higgs']) {
    const r = runSync(name, ['--version'], 10000);
    if (r.ok) return {
      bin: name, source: 'PATH wrapper',
      warning: process.platform === 'win32'
        ? 'Found only as a PATH shim. On Windows that shim truncates multi-line prompts at the first newline. Reinstall the CLI so the vendored binary can be used directly.'
        : null,
    };
  }
  return null;
}

// npm i -g @higgsfield/cli, streamed so the UI can show progress.
function installHiggsfield(onLine) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', '@higgsfield/cli', '--no-audit', '--no-fund'],
                        { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const take = d => { const s = d.toString(); log += s; if (onLine) onLine(s); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', e => resolve({ ok: false, log: log + '\n' + e.message,
      error: `Could not run npm: ${e.message}` }));
    child.on('close', code => {
      cachedPrefix = null;                       // prefix may not change, but re-ask anyway
      const found = resolveHiggsfield();
      resolve({
        ok: code === 0 && !!found,
        code, log: log.trim(), resolved: found,
        error: code !== 0
          ? 'npm install failed — see the log.'
          : (!found ? 'npm reported success but the binary still could not be found. If npm needed admin rights, run the install in an elevated terminal.' : null),
      });
    });
  });
}

// ------------------------------------------------------------- workspaces ---
// Undocumented in the original handoff, and a hard requirement: with no
// workspace selected EVERY call fails with "No workspace selected", even when
// signed in. It is the BILLING workspace, so on a team this is not cosmetic —
// it decides whose credits a render spends. Each person picks their own.
//
// Shapes are parsed defensively: the CLI's JSON is not documented here and a
// list of bare strings, of {id,name}, or a wrapper object are all plausible.
function parseWorkspaces(raw) {
  let j;
  try { j = JSON.parse(raw); } catch (e) { return null; }
  const arr = Array.isArray(j) ? j
    : (Array.isArray(j.workspaces) ? j.workspaces
    : (Array.isArray(j.items) ? j.items
    : (Array.isArray(j.data) ? j.data : null)));
  if (!arr) return null;
  return arr.map(w => {
    if (typeof w === 'string') return { id: w, name: w };
    const id = w.id || w.workspace_id || w.uuid || w.slug || null;
    // Confirmed against the live CLI: a personal workspace comes back with
    // `name: null` and the table renderer prints "Private" for it. Falling
    // through to the id here would put a raw UUID in the picker, which is
    // useless for choosing who gets billed.
    const explicit = w.name || w.title || w.display_name || w.slug || null;
    const name = explicit || (w.user_role === 'owner' ? 'Private' : (id || '(unnamed)'));
    return {
      id, name,
      role: w.user_role || w.role || w.membership || null,
      plan: w.plan_type || w.plan || null,
      credits: (typeof w.credits === 'number') ? Math.round(w.credits * 10) / 10 : null,
      selected: !!(w.is_selected || w.selected),
    };
  }).filter(w => w.id);
}

function listWorkspaces(bin) {
  const r = runSync(bin, ['workspace', 'list', '--json'], 25000);
  if (!r.ok) return { ok: false, error: r.err || r.out || 'workspace list failed', workspaces: [] };
  const ws = parseWorkspaces(r.out);
  return ws ? { ok: true, workspaces: ws }
            : { ok: false, error: 'Could not parse the workspace list.', raw: r.out.slice(0, 400), workspaces: [] };
}

// `workspace status` prints the bare sentence "No workspace selected." with a
// ZERO exit code when nothing is chosen, so exit status alone cannot be
// trusted here. The authoritative signal is the `is_selected` flag on the list,
// which is why that is checked first and status is only a fallback.
function workspaceStatus(bin) {
  const list = listWorkspaces(bin);
  if (list.ok) {
    const sel = list.workspaces.find(w => w.selected);
    // `workspaces` carried on every branch below (not just the selected one)
    // so a caller building a picker never needs a second `workspace list`
    // call just to get the same array workspaceStatus already fetched.
    if (sel) return { ok: true, selected: sel, none: false, workspaces: list.workspaces };
    return { ok: false, selected: null, none: true, workspaces: list.workspaces };
  }
  const r = runSync(bin, ['workspace', 'status', '--json'], 20000);
  const none = /no workspace/i.test(r.err + r.out);
  if (none) return { ok: false, selected: null, none: true, workspaces: [], listError: list.error || null };
  let j = null;
  try { j = JSON.parse(r.out); } catch (e) {}
  const w = j && (j.workspace || j);
  const id = w && (w.id || w.workspace_id || w.uuid || null);
  return {
    ok: !!id, selected: id ? { id, name: (w.name || w.title || id) } : null,
    none: !id, raw: id ? null : (r.out || r.err).slice(0, 200),
    workspaces: [], listError: list.error || null,
  };
}

function setWorkspace(bin, id) {
  const r = runSync(bin, ['workspace', 'set', String(id)], 25000);
  return { ok: r.ok, detail: r.ok ? `Billing workspace set to ${id}.` : (r.err || r.out || 'Could not set workspace.') };
}

function unsetWorkspace(bin) {
  const r = runSync(bin, ['workspace', 'unset'], 20000);
  return { ok: r.ok, detail: r.ok ? 'Workspace cleared — jobs return to your private account context.' : (r.err || r.out) };
}

function authLogout(bin) {
  const r = runSync(bin, ['auth', 'logout'], 20000);
  return { ok: r.ok, detail: r.ok ? 'Signed out on this machine.' : (r.err || r.out || 'Logout failed.') };
}

// SWITCHING ACCOUNTS NEEDS A PRIVATE WINDOW.
//
// `auth logout` only deletes the CLI's local token. The sign-in itself runs in
// the browser, which is still signed in to higgsfield.ai - and its sign-in page
// runs Google One Tap, which signs straight back in as the Google account the
// browser holds. So signing out and in again kept landing on the same wrong
// account however many times it was done. A private window has none of those
// sessions, so the account has to be chosen by hand.
//
// The CLI still opens its own normal tab (it has no switch to stop that), but
// Higgsfield's consent step waits for a click on Allow, so that tab does
// nothing unless someone approves it there.
function privateBrowser() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const find = (...rel) => roots.map(r => path.join(r, ...rel)).find(f => fs.existsSync(f));
  const all = {
    chrome:  { exe: find('Google', 'Chrome', 'Application', 'chrome.exe'), flag: '--incognito', name: 'Chrome incognito' },
    edge:    { exe: find('Microsoft', 'Edge', 'Application', 'msedge.exe'), flag: '--inprivate', name: 'Edge InPrivate' },
    firefox: { exe: find('Mozilla Firefox', 'firefox.exe'), flag: '-private-window', name: 'Firefox private window' },
  };
  // The operator's default browser first, so the window opens where they work.
  const r = runSync('reg', ['query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], 5000);
  const prog = r.ok ? r.out : '';
  const first = /Chrome/i.test(prog) ? 'chrome' : /MSEdge|Edge/i.test(prog) ? 'edge' : /Firefox/i.test(prog) ? 'firefox' : null;
  const order = [first, 'chrome', 'edge', 'firefox'].filter(Boolean);
  for (const k of order) if (all[k].exe) return all[k];
  return null;
}

// `opts.delayMs` opens it that much later, so it lands on top of whatever
// the CLI opens at the same moment.
function openPrivateWindow(url, opts) {
  if (process.platform !== 'win32') return { ok: false, error: 'Private-window launch is Windows-only here.' };
  const b = privateBrowser();
  if (!b) return { ok: false, error: 'No Chrome, Edge or Firefox found.' };
  const launch = () => { try { spawn(b.exe, [b.flag, url], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {} };
  const delay = (opts && opts.delayMs) || 0;
  if (delay) setTimeout(launch, delay); else launch();
  return { ok: true, browser: b.name };
}

module.exports = { resolveHiggsfield, installHiggsfield, authLogout, openPrivateWindow, npmGlobalPrefix, candidatePaths,
                   listWorkspaces, workspaceStatus, setWorkspace, unsetWorkspace };
