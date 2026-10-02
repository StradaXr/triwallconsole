"use strict";
/* Tri-Wall Studio front end. Plain JS, no build step. */
const $ = (id) => document.getElementById(id);
const ORDER = ["left", "LR", "centre", "RR", "right"];
const NAMES = { left: "Left wall", LR: "Left corner", centre: "Centre wall", RR: "Right corner", right: "Right wall" };
const FIELDS = [
  ["lead", "The whole scene", "What every wall shares: the place, the style, the light and the colours."],
  ["left_scene", "Left wall", "What carries on to the left."],
  ["right_scene", "Right wall", "What carries on to the right."],
  ["ret", "Corners", "The narrow strips that join each wall to the centre."],
  ["tail", "Finish", "The look of the detail."],
  ["neg", "Things to keep out", "Never list anything you can see near the edges of your picture: it confuses the painter."],
  ["clean", "Clean-up pass", "The clean, finished look used to tidy up the walls."],
];
const STAGE_PIECES = {
  "Painting the left wall": ["left"], "Painting the right wall": ["right"],
  "Painting the left corner": ["LR"], "Painting the right corner": ["RR"],
};
const S = { status: null, project: null, style: "continue", scene: "street", medium: "cartoon", view: "3d", polling: false, lb: null,
  orbit: { ry: -12, rx: -5 }, shown: {} };
const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const face = (k) => $("f_" + k);

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let body = null;
  try { body = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok) throw new Error((body && body.detail) || `Request failed (${r.status})`);
  return body;
}
const post = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data || {}) });

function say(text, sub = "", kind = "") {
  const s = $("status");
  s.textContent = text; s.className = "status" + (kind ? " " + kind : "");
  $("substatus").textContent = sub || "";
}

function showOffline(text) {
  if (text) $("offlineText").textContent = text;
  $("offline").hidden = false; $("app").hidden = true;
}

// ================================================================ the 3D room
function fit() {
  const st = $("stage"), w = st.clientWidth, h = st.clientHeight;
  const u = Math.max(0.05, Math.min(w / (S.view === "flat" ? 4500 : 4000), h / (S.view === "flat" ? 1050 : 900)));
  document.documentElement.style.setProperty("--u", u.toFixed(4) + "px");
}

function applyOrbit() {
  const r = document.documentElement.style;
  if (S.view === "flat") {
    r.setProperty("--ry", "0deg"); r.setProperty("--rx", "0deg");
    r.setProperty("--a-ret", "0deg"); r.setProperty("--a-wall", "0deg");
    r.setProperty("--tz", "-1700");
  } else {
    r.setProperty("--ry", S.orbit.ry + "deg"); r.setProperty("--rx", S.orbit.rx + "deg");
    r.setProperty("--a-ret", "26deg"); r.setProperty("--a-wall", "34deg");
    r.setProperty("--tz", "-1700");
  }
}

function setView(v) {
  S.view = v;
  document.body.classList.toggle("flat", v === "flat");
  $("stage").classList.toggle("view-real", v === "real");
  document.querySelectorAll("[data-view]").forEach((b) => { const on = b.dataset.view === v; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  $("viewHint").textContent = { flat: "Laid out flat at the LED positions", real: "The real theatre: drag to look around, scroll to move" }[v] || "Drag to turn the room";
  $("real").hidden = v !== "real";
  if (v === "real") openReal(); else if (R.mod) R.mod.stop();
  fit(); applyOrbit();
}

// ---------------------------------------------------------------- "Real theatre" (three.js, loaded on first use)
const R = { mod: null, loading: null };
function realPieces() {
  const out = {};
  for (const k of ORDER) out[k] = S.shown[k] || null;
  if (!out.centre && S.project) out.centre = S.project.pieces.centre.url || S.project.crop_url || null;
  return out;
}
function realSync() { if (R.mod && S.view === "real") R.mod.show(realPieces()); }
async function openReal() {
  const msg = $("realMsg");
  if (!R.mod) {
    msg.hidden = false; msg.textContent = "Building the theatre…";
    R.loading = R.loading || (async () => {
      const mod = await import("/static/theatre-view.js");
      await mod.init($("realCanvas"), (piece) => openLightbox(piece));
      return mod;
    })();
    try { R.mod = await R.loading; }
    catch (e) {
      R.loading = null;
      msg.textContent = (e && e.message && e.message.includes("WebGL")) ? e.message
        : "Couldn't open the real theatre view. The 3D room and Flat view still work.";
      console.error(e);
      return;
    }
    msg.hidden = true;
  }
  if (S.view !== "real") return;
  R.mod.start(); realSync();
}

function wireOrbit() {
  const st = $("stage");
  let drag = null;
  st.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, label, a, input, #real")) return;
    if (S.view === "flat") return;
    drag = { x: e.clientX, y: e.clientY, ry: S.orbit.ry, rx: S.orbit.rx, moved: false };
    st.setPointerCapture(e.pointerId);
  });
  st.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; st.classList.add("dragging"); }
    S.orbit.ry = Math.max(-38, Math.min(38, drag.ry + dx * 0.12));
    S.orbit.rx = Math.max(-16, Math.min(8, drag.rx - dy * 0.08));
    applyOrbit();
  });
  const end = (e) => {
    if (!drag) return;
    const wasClick = !drag.moved; drag = null; st.classList.remove("dragging");
    // A click (not a drag) on the empty centre wall opens the file picker.
    if (wasClick && !S.project && e.target.closest && e.target.closest("#f_centre")) $("file").click();
  };
  st.addEventListener("pointerup", end);
  st.addEventListener("pointercancel", () => { drag = null; st.classList.remove("dragging"); });
  st.addEventListener("dblclick", () => { S.orbit = { ry: -12, rx: -5 }; applyOrbit(); });
  st.addEventListener("keydown", (e) => {
    if (e.target !== st || S.view === "flat") return;
    const step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, 2], ArrowDown: [0, -2] }[e.key];
    if (!step) return;
    e.preventDefault();
    S.orbit.ry = Math.max(-38, Math.min(38, S.orbit.ry + step[0]));
    S.orbit.rx = Math.max(-16, Math.min(8, S.orbit.rx + step[1]));
    applyOrbit();
  });
}

/* the picture on the centre wall, with the 2:1 crop shown as a bright frame */
function showCentre(p) {
  const st = $("stage");
  st.classList.add("has-picture");
  const img = face("centre").querySelector(".surface img");
  const [w, h] = p.original_size, [x0, y0, x1, y1] = p.crop;
  const centreUrl = p.pieces.centre.url || p.original_url;
  // Until the 2K centre comes back, show the crop of the original (object-fit: cover = the centred 2:1 crop).
  img.src = centreUrl;
  face("centre").classList.add("lit");
  const os = $("overspill"), k = 1920 / (x1 - x0);
  const U = (n) => `calc(var(--u) * ${n.toFixed(1)})`;
  os.style.backgroundImage = `url("${p.original_url}")`;
  os.style.left = U(-x0 * k); os.style.top = U(-y0 * k); os.style.width = U(w * k); os.style.height = U(h * k);
  const trimmed = !(x1 - x0 === w && y1 - y0 === h);
  st.classList.toggle("cropping", !p.has_result);
  os.hidden = !trimmed;
  spillFrom(p.original_url);
  return trimmed;
}

function spillFrom(url) {
  const im = new Image();
  im.onload = () => {
    try {
      const c = document.createElement("canvas"); c.width = 24; c.height = 12;
      const g = c.getContext("2d"); g.drawImage(im, 0, 0, 24, 12);
      const d = g.getImageData(0, 0, 24, 12).data; let r = 0, gg = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4, boost = (v) => Math.min(255, Math.round(v / n * 1.25 + 20));
      document.documentElement.style.setProperty("--spill", `${boost(r)}, ${boost(gg)}, ${boost(b)}`);
    } catch (e) { /* ignore */ }
  };
  im.src = url;
}

function clearRoom() {
  for (const k of ORDER) {
    const f = face(k); f.classList.remove("lit", "reveal", "painting", "waiting");
    f.querySelector(".surface img").removeAttribute("src");
  }
  S.shown = {};
  const st = $("stage"); st.classList.remove("has-picture", "cropping", "celebrate", "room-done");
  document.documentElement.style.setProperty("--spill", "124, 107, 255");
}

function light(k, url, animate) {
  const f = face(k), img = f.querySelector(".surface img");
  if (S.shown[k] === url) return;
  S.shown[k] = url;
  realSync();
  f.classList.remove("painting", "waiting", "reveal");
  const go = () => {
    f.classList.add("lit");
    if (animate && !reduceMotion) { void f.offsetWidth; f.classList.add("reveal"); }
  };
  if (img.getAttribute("src") === url) { go(); return; }
  img.onload = go; img.src = url;
}

function renderRoom(p) {
  const st = $("stage");
  st.classList.toggle("room-done", !!p.has_result);
  for (const k of ORDER) {
    const pc = p.pieces[k];
    if (pc.url) light(k, pc.url, false);
    else if (k !== "centre") { face(k).classList.remove("lit"); S.shown[k] = null; }
  }
  realSync();
}

function celebrate() {
  const st = $("stage");
  st.classList.remove("celebrate"); void st.offsetWidth; st.classList.add("celebrate");
  setTimeout(() => st.classList.remove("celebrate"), 2600);
}

// ================================================================ projects
async function upload(file) {
  if (!file || !file.type.startsWith("image/")) { say("That doesn't look like a picture.", "Try a PNG or JPG file.", "err"); return; }
  say("Hanging your picture on the wall…");
  const fd = new FormData(); fd.append("file", file);
  try {
    clearRoom();
    const p = await api("/api/projects", { method: "POST", body: fd });
    openProject(p);
    loadFilm();
  } catch (e) { say("Couldn't use that picture.", friendly(e.message), "err"); }
}

function openProject(p) {
  const changed = !S.project || S.project.name !== p.name;
  if (changed) clearRoom();
  S.project = p;
  store("tws.project", p.name);
  const trimmed = showCentre(p);
  renderRoom(p);
  setStyle(p.style || "continue");
  setScene(p.scene_type || (S.status && S.status.default_scene) || "street");
  setMedium(p.medium || "cartoon");
  renderPrompts(p);
  $("btnAdvanced").disabled = !p.prompts;
  updateActions();
  if (viewingJob()) showJobProgress(S.job);
  else {
    if (p.has_result) {
      say(p.has4k ? "Your room is finished, in 2K and 4K." : "Here's your room.",
        (p.summary && p.prompt_source === "claude" ? p.summary + "\n" : "") + "Hover over any wall to try another version or see it big." +
          (p.prompt_note && p.prompt_source === "claude" ? "\n" + p.prompt_note : ""));
    } else {
      say("Looking good. Ready when you are.", trimmed
        ? "The bright frame is what the LED centre wall shows (2:1). The faded parts are trimmed off."
        : "Your picture is already 2:1, so all of it goes on the centre wall.");
    }
  }
  document.querySelectorAll(".filmcard").forEach((c) => c.classList.toggle("current", c.dataset.name === p.name));
}

function newRoom() {
  S.project = null; store("tws.project", "");
  clearRoom(); renderPrompts(null); $("btnAdvanced").disabled = true; updateActions();
  say("Drop a picture onto the centre wall to begin.", "Any picture works. It's trimmed to 2:1 for the centre LED.");
  document.querySelectorAll(".filmcard").forEach((c) => c.classList.remove("current"));
}

function renderScenes() {
  const box = $("sceneSeg"), types = (S.status && S.status.scene_types) || {};
  if (box.childElementCount === Object.keys(types).length) return;
  box.innerHTML = "";
  for (const [k, label] of Object.entries(types)) {
    const b = document.createElement("button");
    b.dataset.scene = k; b.textContent = label; b.setAttribute("role", "radio");
    b.onclick = () => setScene(k);
    box.appendChild(b);
  }
  setScene(S.scene);
}
function setScene(k) {
  S.scene = k;
  document.querySelectorAll("[data-scene]").forEach((b) => { const on = b.dataset.scene === k; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  pickHint();
}
function setMedium(m) {
  S.medium = m;
  document.querySelectorAll("[data-medium]").forEach((b) => { const on = b.dataset.medium === m; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  pickHint();
}
function pickHint() {
  const p = S.project; if (!p) return;
  const guess = p.medium_guess ? `It looks like a ${p.medium_guess} to us. Is that right? ` : "";
  $("pickHint").textContent = p.has_result
    ? "These choices are used the next time you paint the whole room."
    : guess + "This picks the right words for the painter" + (S.status && S.status.claude ? " and tells Claude what it's looking at." : ".");
}

function setStyle(s) {
  if (s === "distinct" && !(S.status && S.status.distinct)) s = "continue";
  S.style = s;
  document.querySelectorAll("[data-style]").forEach((b) => { const on = b.dataset.style === s; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
}

function updateActions() {
  const p = S.project, here = viewingJob(), elsewhere = jobRunning() && !here, done = p && p.has_result;
  $("btnMake").hidden = !!done || here; $("btnMake").disabled = !p || elsewhere;
  $("styleRow").hidden = !(S.status && S.status.distinct) || !!done || here || !p;
  $("pickRow").hidden = !p || here;
  $("btn4k").hidden = !done || here; $("btn4k").disabled = elsewhere;
  $("btnDownload").hidden = !done || here;
  $("btnAgain").hidden = !done || here; $("btnAgain").disabled = elsewhere;
  $("btnCancel").hidden = !here;
  ["btnRepaint", "btnRewrite"].forEach((id) => $(id).disabled = jobRunning());
  $("lbReroll").disabled = jobRunning();
  if (done) {
    $("btnDownload").href = `/api/projects/${p.name}/download`;
    $("btn4k").textContent = p.has4k ? "4K ready ✓  Make again" : "Approve & make 4K";
  }
  let hint = "";
  if (elsewhere) hint = `The painter is busy with “${S.jobTitle || "another room"}”. The painting buttons come back when it's done.`;
  else if (here) hint = "";
  else if (done) hint = p.has4k ? "Download has the 2K and 4K files plus a picture of the whole room."
    : "Download has the 2K files plus a picture of the whole room. Approve to add 4K.";
  else if (p) hint = "Usually 4–6 minutes. " + (S.status && S.status.claude ? "Claude writes the scene, then the painter paints the walls and corners."
    : "The painter paints both walls and both corners.");
  $("dlHint").textContent = hint;
  $("stage").classList.toggle("room-busy", jobRunning());
}

function renderPrompts(p) {
  const box = $("fields"); box.innerHTML = "";
  if (!p || !p.prompts) { $("promptSource").textContent = ""; return; }
  for (const [k, label, help] of FIELDS) {
    if (k === "lead" && p.style === "distinct") continue;
    const f = document.createElement("div"); f.className = "field";
    f.innerHTML = `<label for="t_${k}">${label}</label><small>${help}</small><textarea id="t_${k}" rows="4"></textarea>`;
    box.appendChild(f);
    f.querySelector("textarea").value = p.prompts[k] || "";
  }
  const src = p.prompt_source === "claude" ? "Written by Claude after looking at your picture." : "Template words (Claude wasn't used).";
  const dropped = (p.prompts.dropped_from_negative || []).length
    ? ` Left out of “Things to keep out” because they're visible near the edges: ${p.prompts.dropped_from_negative.join(", ")}.` : "";
  $("promptSource").textContent = `${src}${dropped} Edit any box, then paint again.`;
}

// ================================================================ jobs
async function startJob(path, data, painting = []) {
  try {
    await post(path, data);
    S.job = { state: "running", project: S.project.name, stage: "Getting ready", kind: "" };
    S.jobTitle = S.project.title;
    for (const k of painting) { face(k).classList.add("waiting"); }
    renderJobChip(); updateActions();
    closePanel();
    pollJob();
  } catch (e) { say("That didn't start.", friendly(e.message), "err"); }
}

function make(useMine) {
  if (!S.project) return;
  const data = { style: S.style, scene_type: S.scene, medium: S.medium };
  if (useMine) {
    data.use_my_prompts = true; data.prompts = {};
    for (const [k] of FIELDS) { const t = $("t_" + k); if (t) data.prompts[k] = t.value; }
  }
  // Repainting the whole room: dim the old walls so the new ones can light up.
  for (const k of ["left", "LR", "RR", "right"]) { face(k).classList.remove("lit", "reveal"); S.shown[k] = null; }
  $("stage").classList.remove("cropping");
  startJob(`/api/projects/${S.project.name}/make`, data, ["left", "LR", "RR", "right"]);
}

function reroll(k) {
  closeLightbox();
  const distinct = S.project.style === "distinct" && S.status && S.status.distinct;
  const set = distinct ? (k === "left" ? ["left", "LR"] : k === "right" ? ["right", "RR"] : [k])
    : (k === "left" || k === "LR" ? ["left", "LR"] : ["right", "RR"]);
  for (const p of set) { face(p).classList.remove("lit", "reveal"); S.shown[p] = null; }
  startJob(`/api/projects/${S.project.name}/reroll`, { piece: k }, set);
}

function fmt(s) { const m = Math.floor(s / 60), r = s % 60; return `${m}:${String(r).padStart(2, "0")}`; }

// The painter runs one job at a time in the background. Any room can be opened while it runs; only the room being
// painted shows the live progress. Painting buttons on other rooms wait until the painter is free.
const jobRunning = () => !!(S.job && S.job.state === "running");
const viewingJob = () => jobRunning() && S.project && S.project.name === S.job.project;

function renderJobChip() {
  const chip = $("jobChip");
  if (!jobRunning()) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = `Painting: ${S.jobTitle || "a room"}` + (S.job.stage ? ` · ${S.job.stage.replace(/\s*\(.*\)$/, "")}` : "");
  chip.classList.toggle("here", viewingJob());
}

function toast(text, action) {
  const t = $("toast");
  t.querySelector("span").textContent = text;
  const b = t.querySelector("button");
  b.hidden = !action; if (action) { b.textContent = action.label; b.onclick = () => { t.hidden = true; action.run(); }; }
  t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 15000);
}

function showJobProgress(j) {
  const cur = STAGE_PIECES[j.stage] || [];
  for (const k of ["left", "LR", "RR", "right"]) {
    const f = face(k);
    if (f.classList.contains("lit")) continue;
    f.classList.toggle("painting", cur.includes(k));
    f.classList.add("waiting");
  }
  for (const [k, url] of Object.entries(j.live || {})) if (k !== "centre") light(k, url, true);
  const ahead = j.queue_ahead > 0;
  const usual = j.kind === "4k" ? "about a minute once it starts" : j.kind === "reroll" ? "usually 2–4 minutes" : "usually 4–6 minutes";
  say(j.stage,
    [ahead ? `Waiting in line: ${j.detail}. The painter is shared with other work; your room starts by itself.` : j.detail,
      j.elapsed != null ? `${fmt(j.elapsed)} so far · ${usual}` : "",
      "You can open your other rooms while this paints."].filter(Boolean).join("  ·  "), "busy");
}

async function finishedJob(j) {
  const mine = S.project && S.project.name === j.project;
  for (const k of ORDER) face(k).classList.remove("painting", "waiting");
  if (!mine) {
    const title = S.jobTitle || "your room";
    if (j.state === "done") toast(`${title}: ${j.message || "done"}`, { label: "Open it", run: () => openByName(j.project) });
    else if (j.state === "error") toast(`${title}: that didn't work. Open the room to see why.`, { label: "Open it", run: () => openByName(j.project) });
    updateActions();
    return;
  }
  const p = await api(`/api/projects/${j.project}`);
  let delay = 0;  // reveal anything that hasn't lit up yet, one by one
  for (const k of ["left", "LR", "RR", "right"]) {
    const pc = p.pieces[k];
    if (j.state === "done" && pc.url && S.shown[k] !== pc.url) { setTimeout(() => light(k, pc.url, true), delay); delay += reduceMotion ? 0 : 350; }
  }
  await sleep(delay);
  openProject(p);
  if (j.state === "done") {
    celebrate();
    say(j.message || "Done!", (p.summary && p.prompt_source === "claude" ? p.summary + "\n" : "") +
      (j.kind === "make" && p.prompt_note ? p.prompt_note + "\n" : "") + "Hover over any wall to try another version or see it big.");
  } else if (j.state === "error") say("Sorry, that didn't work.", friendly(j.error), "err");
  else if (j.state === "cancelled") say("Stopped.", "Nothing was changed.");
}

async function openByName(name) {
  try { openProject(await api(`/api/projects/${name}`)); }
  catch (e) { say("That room couldn't be opened.", friendly(e.message), "err"); }
}

async function pollJob() {
  if (S.polling) return;
  S.polling = true;
  let lastProject = null;
  try {
    for (;;) {
      let j;
      try { j = await api("/api/job"); } catch (e) { await sleep(2500); continue; }
      S.job = j;
      if (j.project && j.project !== lastProject) {
        lastProject = j.project;
        try { S.jobTitle = (await api(`/api/projects/${j.project}`)).title; } catch (e) { S.jobTitle = ""; }
      }
      if (j.state === "running") {
        if (viewingJob()) showJobProgress(j);
        renderJobChip(); updateActions();
      } else {
        S.polling = false; renderJobChip();
        if (j.state !== "idle") await finishedJob(j);
        loadFilm(); loadStatus(); updateActions();
        break;
      }
      await sleep(1500);
    }
  } finally { S.polling = false; renderJobChip(); updateActions(); }
}

// Plain words for the errors people can actually hit.
function friendly(msg) {
  const m = String(msg || "");
  if (/already being painted/i.test(m)) return "The painter is busy with another room. Try again when it's finished.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "The studio isn't responding. Is the black Tri-Wall Studio window still open?";
  if (/wasn't found|didn't come up/i.test(m)) return "The painting engine (ComfyUI) couldn't be started. " + m;
  if (/rejected the recipe|hit a problem/i.test(m)) return "The painter couldn't finish this one. Please try again. (Details: " + m.slice(0, 240) + ")";
  if (/lost this job/i.test(m)) return "The painter was restarted and lost this job. Please press the button again.";
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}

// ================================================================ big view
function openLightbox(k) {
  const p = S.project; if (!p) return;
  const pc = p.pieces[k]; if (!pc.url && k !== "centre") return;
  S.lb = k;
  $("lbTitle").textContent = NAMES[k];
  $("lbImg").src = pc.url || p.original_url; $("lbImg").alt = NAMES[k];
  $("lbSize").textContent = `2K ${pc.w}×${pc.h}` + (pc.url4k ? `  ·  4K ${pc.w * 2}×${pc.h * 2} ready` : "");
  $("lb4k").hidden = !pc.url4k; if (pc.url4k) $("lb4k").href = pc.url4k;
  $("lbReroll").hidden = k === "centre" || !p.has_result;
  $("lbReroll").disabled = jobRunning();
  $("lightbox").hidden = false; $("lbClose").focus();
}
function closeLightbox() { $("lightbox").hidden = true; S.lb = null; }

// ================================================================ advanced panel
function openPanel() {
  $("panel").classList.add("open"); $("panel").setAttribute("aria-hidden", "false"); $("scrim").hidden = false;
  $("btnAdvanced").setAttribute("aria-expanded", "true");
  setTimeout(() => { const t = $("fields").querySelector("textarea"); if (t) t.focus(); }, 300);
}
function closePanel() {
  $("panel").classList.remove("open"); $("panel").setAttribute("aria-hidden", "true"); $("scrim").hidden = true;
  $("btnAdvanced").setAttribute("aria-expanded", "false");
}

// ================================================================ status + filmstrip
async function loadStatus() {
  try {
    const s = await api("/api/status");
    S.status = s;
    const c = $("chipClaude");
    c.textContent = s.claude ? "Claude writes the scene" : "Template words";
    c.className = "chip " + (s.claude ? "ok" : "warn");
    $("setupNote").hidden = s.claude || store("tws.setupDismissed") === "1";
    const e = $("chipEngine");
    e.textContent = s.engine ? "Painter ready" : "Painter starts when needed";
    e.className = "chip " + (s.engine ? "ok" : "");
    renderScenes();
    updateActions();
    return true;
  } catch (e) { return false; }
}

async function loadFilm() {
  try {
    const list = await api("/api/projects");
    const film = $("film");
    film.querySelectorAll(".filmcard:not(.new)").forEach((n) => n.remove());
    for (const h of list) {
      const b = document.createElement("button");
      b.className = "filmcard" + (S.project && S.project.name === h.name ? " current" : "");
      b.dataset.name = h.name; b.setAttribute("role", "listitem");
      const when = h.created ? new Date(h.created).toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
      b.innerHTML = `<div class="mini ${h.done ? "" : "raw"}"></div><strong></strong><span>${when}${h.has4k ? " · 4K" : h.done ? "" : " · not painted yet"}</span>`;
      b.querySelector(".mini").style.backgroundImage = `url("${h.thumb}")`;
      b.querySelector("strong").textContent = h.title;
      b.onclick = () => openByName(h.name);
      film.appendChild(b);
    }
  } catch (e) { /* ignore */ }
}

// ================================================================ wiring
function wire() {
  const st = $("stage"), file = $("file");
  file.addEventListener("change", () => { upload(file.files[0]); file.value = ""; });
  $("dropcta").addEventListener("click", (e) => { e.preventDefault(); file.click(); });
  window.addEventListener("dragover", (e) => { e.preventDefault(); st.classList.add("over"); });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) st.classList.remove("over"); });
  window.addEventListener("drop", (e) => { e.preventDefault(); st.classList.remove("over"); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
  $("jobChip").onclick = () => S.job && S.job.project && openByName(S.job.project);
  st.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === st && !S.project) { e.preventDefault(); file.click(); } });

  // hover buttons on the walls
  for (const k of ORDER) {
    const f = face(k), surf = f.querySelector(":scope > .surface");
    surf.querySelectorAll(".hb.view").forEach((b) => b.onclick = (e) => { e.stopPropagation(); openLightbox(k); });
    surf.querySelectorAll(".hb.again").forEach((b) => b.onclick = (e) => { e.stopPropagation(); if (!jobRunning()) reroll(k); });
    surf.addEventListener("dblclick", (e) => { if (S.project && S.project.has_result) { e.stopPropagation(); openLightbox(k); } });
  }

  document.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => setView(b.dataset.view));
  document.querySelectorAll("[data-style]").forEach((b) => b.onclick = () => setStyle(b.dataset.style));
  document.querySelectorAll("[data-medium]").forEach((b) => b.onclick = () => setMedium(b.dataset.medium));
  $("btnMake").onclick = () => make(false);
  $("btnAgain").onclick = () => { S.project.has_result = false; updateActions(); say("Paint the whole room again?", "Pick a style and press “Make my walls”. Claude will look at your picture again."); };
  $("btn4k").onclick = () => startJob(`/api/projects/${S.project.name}/make4k`, {});
  $("btnCancel").onclick = () => post("/api/job/cancel");
  $("btnNew").onclick = newRoom;
  $("btnResetView").onclick = () => R.mod && R.mod.reset();
  $("btnAdvanced").onclick = openPanel;
  $("panelClose").onclick = closePanel;
  $("scrim").onclick = closePanel;
  $("btnRepaint").onclick = () => make(true);
  $("btnRewrite").onclick = () => make(false);
  $("setupClose").onclick = () => { $("setupNote").hidden = true; store("tws.setupDismissed", "1"); };
  $("lbClose").onclick = closeLightbox;
  $("lbReroll").onclick = () => S.lb && reroll(S.lb);
  $("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeLightbox(); closePanel(); }
    if ($("lightbox").hidden) return;
    const i = ORDER.indexOf(S.lb);
    if (e.key === "ArrowRight" && i < 4) openLightbox(ORDER[i + 1]);
    if (e.key === "ArrowLeft" && i > 0) openLightbox(ORDER[i - 1]);
  });
  window.addEventListener("resize", fit);
  wireOrbit();
}

async function init() {
  if (location.protocol === "file:") { showOffline(); return; }
  wire(); fit(); applyOrbit();
  if (!(await loadStatus())) {
    showOffline("Tri-Wall Studio isn't running right now. Double-click start_triwall_studio.bat in the triwall-studio folder, then reload this page.");
    return;
  }
  await loadFilm();
  let j = null;
  try { j = await api("/api/job"); } catch (e) { /* ignore */ }
  if (j && j.state === "running") { S.job = j; }
  const last = store("tws.project") || (S.job && S.job.project);
  if (last) { try { openProject(await api(`/api/projects/${last}`)); } catch (e) { newRoom(); } }
  else newRoom();
  if (jobRunning()) pollJob();
  setInterval(loadStatus, 30000);
}
init();
