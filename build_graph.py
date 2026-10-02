"""Builds a Tri-Wall API prompt with the claude-mcp workflow builders and prints it as JSON.

Run as a separate process (python -B build_graph.py < request.json) so that:
  * the newest version of the builders is always used (they are being improved in parallel), and
  * nothing is written into D:\\ComfyUI\\claude-mcp (no __pycache__: -B / PYTHONDONTWRITEBYTECODE).

stdin:  {"workflow": "fullset" | "distinct", "preset": {...}, "claude_mcp": "D:\\ComfyUI\\claude-mcp"}
stdout: the API prompt dict (JSON)
"""
import json
import sys

sys.dont_write_bytecode = True


def main():
    req = json.loads(sys.stdin.read())
    sys.path.insert(0, req["claude_mcp"])
    if req["workflow"] == "distinct":
        import distinct_workflow as wf
    else:
        import fullset2k_workflow as wf
    api = wf.build(req["preset"]).to_api()
    sys.stdout.write(json.dumps(api))


if __name__ == "__main__":
    main()
