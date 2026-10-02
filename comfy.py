"""Talks to the local ComfyUI engine (never opens its web UI).

Start-up follows D:\\ComfyUI\\claude-mcp\\comfyui_mcp.py _ensure_running(): headless, no window.
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import requests

try:
    import websocket  # websocket-client
except Exception:  # pragma: no cover - progress falls back to polling
    websocket = None

HERE = Path(__file__).parent
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
COMFY_DIR = Path(os.environ.get("COMFY_DIR", r"D:\ComfyUI\ComfyUI_windows_portable"))
CLAUDE_MCP = Path(os.environ.get("TRIWALL_CLAUDE_MCP", r"D:\ComfyUI\claude-mcp"))

_start_lock = threading.Lock()


class Cancelled(Exception):
    pass


def is_running() -> bool:
    try:
        requests.get(COMFY_URL + "/system_stats", timeout=5).raise_for_status()
        return True
    except Exception:
        return False


def ensure_running(on_wait=None):
    if is_running():
        return
    with _start_lock:
        if is_running():
            return
        py = COMFY_DIR / "python_embeded" / "python.exe"
        main = COMFY_DIR / "ComfyUI" / "main.py"
        if not py.exists():
            raise RuntimeError(f"The painting engine (ComfyUI) wasn't found at {COMFY_DIR}.")
        (HERE / "logs").mkdir(exist_ok=True)
        log = open(HERE / "logs" / "comfyui.log", "a")
        subprocess.Popen([str(py), "-s", str(main), "--windows-standalone-build"],
                         cwd=str(COMFY_DIR), stdout=log, stderr=subprocess.STDOUT,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        for _ in range(240):
            if on_wait:
                on_wait()
            time.sleep(1)
            if is_running():
                return
        raise RuntimeError("Started the painting engine but it didn't come up within 4 minutes "
                           "(see logs/comfyui.log).")


def upload_image(path: Path, name: str) -> str:
    """Upload a file to ComfyUI's input folder; returns the name ComfyUI stored it under."""
    with open(path, "rb") as f:
        r = requests.post(COMFY_URL + "/upload/image", files={"image": (name, f, "image/png")},
                          data={"type": "input", "overwrite": "true"}, timeout=120)
    r.raise_for_status()
    d = r.json()
    return (d.get("subfolder") + "/" if d.get("subfolder") else "") + d["name"]


def build_api(workflow: str, preset: dict) -> dict:
    """Build an API prompt with claude-mcp's builders, in a child process (see build_graph.py)."""
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", COMFY_URL=COMFY_URL, COMFY_DIR=str(COMFY_DIR))
    req = json.dumps({"workflow": workflow, "preset": preset, "claude_mcp": str(CLAUDE_MCP)})
    last = ""
    for _ in range(3):  # the builders are edited in parallel; a half-saved file can fail once
        p = subprocess.run([sys.executable, "-B", str(HERE / "build_graph.py")], input=req, capture_output=True,
                           text=True, encoding="utf-8", env=env, cwd=str(HERE), timeout=180,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if p.returncode == 0:
            return json.loads(p.stdout)
        last = p.stderr[-3000:]
        time.sleep(3)
    raise RuntimeError("Couldn't prepare the painting recipe:\n" + last)


def swap_seeds(api: dict, swap: dict) -> int:
    """Swap KSampler seeds by value (as claude-mcp/run_seeds.py). Returns how many were changed."""
    n = 0
    for v in api.values():
        if v["class_type"] == "KSampler" and v["inputs"].get("seed") in swap:
            v["inputs"]["seed"] = swap[v["inputs"]["seed"]]
            n += 1
    return n


# ----------------------------------------------------------------------------- progress wording
def stage_for(node: dict) -> str | None:
    """Plain-language stage for a node that starts executing."""
    cls, title = node["class_type"], node.get("_meta", {}).get("title", "")
    t = title.lower()
    if cls == "KSampler":
        if t.startswith("left wall"):
            return "Painting the left wall"
        if t.startswith("right wall"):
            return "Painting the right wall"
        if t.startswith("lr"):
            return "Painting the left corner"
        if t.startswith("rr"):
            return "Painting the right corner"
        return "Painting"
    if cls == "SamplerCustomAdvanced":
        return "Cleaning up"
    if cls == "ColorTransfer":
        return "Matching the colours"
    if cls == "ImageUpscaleWithModel":
        return "Making it sharper for 4K"
    if cls in ("UNETLoader", "CLIPLoader", "VAELoader", "ControlNetLoader", "UpscaleModelLoader"):
        return "Warming up the painter"
    if cls == "SaveImage":
        return "Saving"
    return None


HEAVY = ("KSampler", "SamplerCustomAdvanced", "ImageUpscaleWithModel")


def run(api: dict, report, cancel_flag=None, timeout=3 * 3600, on_image=None, on_queued=None,
        prompt_id: str | None = None) -> dict:
    """Queue `api`, report progress, return {filename_prefix: [image bytes, ...]}.

    report(stage=str, detail=str, fraction=float|None, queue_ahead=int|None)
    on_image(prefix, bytes): called as soon as each SaveImage finishes (for a live reveal).
    on_queued(prompt_id): called once the job is in ComfyUI's queue (so it can be picked up after a restart).
    prompt_id: resume tracking a job that is already queued instead of queueing a new one.
    """
    ensure_running()
    client_id = str(uuid.uuid4())
    heavy_ids = [k for k, v in api.items() if v["class_type"] in HEAVY]
    done_heavy, cur = set(), {"node": None, "frac": 0.0}

    ws = None
    if websocket is not None:
        try:
            ws = websocket.create_connection(COMFY_URL.replace("http", "ws", 1) + f"/ws?clientId={client_id}",
                                             timeout=5)
            ws.settimeout(1)
        except Exception:
            ws = None

    if prompt_id is None:
        r = requests.post(COMFY_URL + "/prompt", json={"prompt": api, "client_id": client_id}, timeout=60)
        if r.status_code != 200:
            raise RuntimeError("The painting engine rejected the recipe: " + r.text[:1500])
        prompt_id = r.json()["prompt_id"]
    if on_queued:
        on_queued(prompt_id)

    def overall():
        if not heavy_ids:
            return None
        return min(0.99, (len(done_heavy) + cur["frac"]) / len(heavy_ids))

    report(stage="Sending your room to the painter", detail="", fraction=0.0)
    deadline, last_poll, started = time.time() + timeout, 0.0, False
    try:
        while time.time() < deadline:
            if cancel_flag and cancel_flag():
                _cancel(prompt_id)
                raise Cancelled()
            # websocket: live node / step progress
            if ws is not None:
                try:
                    msg = ws.recv()
                    if isinstance(msg, str):
                        m = json.loads(msg)
                        d = m.get("data", {})
                        if d.get("prompt_id") not in (None, prompt_id):
                            pass
                        elif m["type"] == "executing" and d.get("node"):
                            started = True
                            if cur["node"] in heavy_ids:
                                done_heavy.add(cur["node"])
                            cur.update(node=d["node"], frac=0.0)
                            node = api.get(str(d["node"]))
                            st = stage_for(node) if node else None
                            if st:
                                report(stage=st, detail="", fraction=overall(), queue_ahead=0)
                        elif m["type"] == "progress" and d.get("max"):
                            started = True
                            if str(d.get("node")) in heavy_ids:
                                cur["frac"] = d["value"] / d["max"]
                            report(detail=f"step {d['value']} of {d['max']}", fraction=overall(), queue_ahead=0)
                        elif m["type"] == "executed" and on_image:
                            node = api.get(str(d.get("node")))
                            if node and node["class_type"] == "SaveImage":
                                for img in (d.get("output") or {}).get("images", []):
                                    if img.get("type") == "output":
                                        try:
                                            on_image(node["inputs"]["filename_prefix"], _view(img))
                                        except Exception:
                                            pass
                        elif m["type"] == "execution_cached":
                            for nid in d.get("nodes", []):
                                if str(nid) in heavy_ids:
                                    done_heavy.add(str(nid))
                except websocket.WebSocketTimeoutException:
                    pass
                except Exception:
                    ws = None
            else:
                time.sleep(1)
            # polling: queue position and the final result (source of truth)
            if time.time() - last_poll > 3:
                last_poll = time.time()
                h = requests.get(COMFY_URL + f"/history/{prompt_id}", timeout=30).json()
                if prompt_id in h:
                    entry = h[prompt_id]
                    st = entry.get("status", {})
                    if st.get("status_str") == "error":
                        msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                        detail = msgs[0][1].get("exception_message", "") if msgs else ""
                        raise RuntimeError("The painter hit a problem: " + (detail or json.dumps(st)[:800]))
                    if st.get("status_str") == "success" or st.get("completed") or (not st and entry.get("outputs")):
                        return _collect(api, entry)
                q = requests.get(COMFY_URL + "/queue", timeout=30).json() if not started or ws is None else None
                if q is not None:
                    running = [x[1] for x in q.get("queue_running", [])]
                    pending = sorted(q.get("queue_pending", []), key=lambda x: x[0])
                    if prompt_id not in running and prompt_id not in [x[1] for x in pending]:
                        h2 = requests.get(COMFY_URL + f"/history/{prompt_id}", timeout=30).json()
                        if prompt_id not in h2:
                            raise RuntimeError("The painter lost this job (was it restarted?). Please try again.")
                        continue
                if not started:
                    if prompt_id in running:
                        started = True
                        report(stage="Starting", detail="", queue_ahead=0)
                    else:
                        ids = [x[1] for x in pending]
                        ahead = (ids.index(prompt_id) if prompt_id in ids else 0) + len(running)
                        # The painter is shared: say plainly that someone else's job is running, not that we're stuck.
                        busy = "another job is running" if running else "about to start"
                        report(stage=f"Waiting for the painter ({busy})",
                               detail=(f"{ahead} job{'s' if ahead != 1 else ''} ahead of you" if ahead else ""),
                               queue_ahead=ahead)
        raise RuntimeError("Gave up waiting for the painter after 3 hours.")
    finally:
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass


def _cancel(prompt_id: str):
    """Remove our job from the queue, or stop it if it is the one running (never touches other jobs)."""
    try:
        q = requests.get(COMFY_URL + "/queue", timeout=30).json()
        if any(x[1] == prompt_id for x in q.get("queue_running", [])):
            requests.post(COMFY_URL + "/interrupt", json={"prompt_id": prompt_id}, timeout=30)
        else:
            requests.post(COMFY_URL + "/queue", json={"delete": [prompt_id]}, timeout=30)
    except Exception:
        pass


def _collect(api: dict, entry: dict) -> dict:
    out = {}
    for nid, o in entry.get("outputs", {}).items():
        node = api.get(str(nid))
        if not node or node["class_type"] != "SaveImage":
            continue
        prefix = node["inputs"]["filename_prefix"]
        for img in o.get("images", []):
            if img.get("type") != "output":
                continue
            out.setdefault(prefix, []).append(_view(img))
    return out


def _view(img: dict) -> bytes:
    r = requests.get(COMFY_URL + "/view", params={"filename": img["filename"], "subfolder": img.get("subfolder", ""),
                                                 "type": "output"}, timeout=120)
    r.raise_for_status()
    return r.content


def upscale_graph(items: list[tuple[str, str, int, int]]) -> dict:
    """Real-ESRGAN x4 then an exact resize (as claude-mcp/upscale_x2.py). items: (key, input name, w, h)."""
    api = {"um": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "RealESRGAN_x4plus.pth"},
                  "_meta": {"title": "Upscale model"}}}
    for key, name, w, h in items:
        api[f"{key}_img"] = {"class_type": "LoadImage", "inputs": {"image": name}, "_meta": {"title": key}}
        api[f"{key}_up"] = {"class_type": "ImageUpscaleWithModel",
                            "inputs": {"upscale_model": ["um", 0], "image": [f"{key}_img", 0]},
                            "_meta": {"title": f"{key} upscale"}}
        api[f"{key}_fit"] = {"class_type": "ImageScale",
                             "inputs": {"image": [f"{key}_up", 0], "upscale_method": "lanczos", "width": w,
                                        "height": h, "crop": "center"}, "_meta": {"title": f"{key} {w}x{h}"}}
        api[f"{key}_save"] = {"class_type": "SaveImage", "inputs": {"images": [f"{key}_fit", 0],
                                                                    "filename_prefix": f"triwall_studio_4k_{key}"},
                              "_meta": {"title": f"{key} 4K"}}
    return api
