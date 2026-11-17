#!/usr/bin/env python3
"""MCP-over-HTTP recall probe: which prefix field does the tool honour?

The tool schema names the prefix filter `keyPrefix`; the CLI's recall command passes
`mode:"prefix"` + `prefix:...`. This probe measures both spellings and the unfiltered
baseline, so the CLI's dropped filter can be attributed to a field name.
Read-only (recall only) against the scratch daemon on 127.0.0.1:3391.
"""
import json, time, urllib.request, urllib.error, pathlib

URL = "http://127.0.0.1:3391/mcp"
OUT = pathlib.Path("/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence/mcp-recall.jsonl")


def rpc(payload, timeout=120):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(URL, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            code = r.status
    except urllib.error.HTTPError as e:
        raw, code = e.read().decode(), e.code
    except Exception as e:
        raw, code = f"EXC {type(e).__name__}: {e}", -1
    ms = (time.time() - t0) * 1000
    # streamable HTTP: body may be SSE (data: {...}) or plain JSON
    body = raw
    if "data:" in raw:
        parts = [ln[5:].strip() for ln in raw.splitlines() if ln.startswith("data:")]
        body = parts[-1] if parts else raw
    try:
        return code, json.loads(body), ms, raw
    except Exception:
        return code, None, ms, raw


def items_of(res):
    if not isinstance(res, dict):
        return None
    r = res.get("result") or {}
    for k in ("items", "memories", "results"):
        if isinstance(r.get(k), list):
            return r[k]
    if isinstance(r.get("content"), list) and r["content"]:
        for c in r["content"]:
            txt = c.get("text", "")
            try:
                d = json.loads(txt)
                for k in ("items", "memories", "results"):
                    if isinstance(d.get(k), list):
                        return d[k]
            except Exception:
                pass
    return None


rows = []
def call(label, args):
    payload = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
               "params": {"name": "recall", "arguments": args}}
    code, res, ms, raw = rpc(payload)
    items = items_of(res)
    n = len(items) if items is not None else None
    first = [i.get("key") for i in (items or [])][:4]
    err = None
    if isinstance(res, dict):
        err = res.get("error") or (res.get("result") or {}).get("isError")
    rec = {"label": label, "args": args, "http": code, "wall_ms": round(ms, 1),
           "items": n, "first_keys": first, "error": err, "raw_head": raw[:300]}
    rows.append(rec)
    print(f"{label:26s} http={code} ms={ms:7.1f} items={n} err={err} keys={first[:3]}")


call("baseline_all", {"namespace": "alpha", "limit": 100})
call("keyPrefix", {"namespace": "alpha", "keyPrefix": "/team/roster/", "limit": 100})
call("prefix_unknown_field", {"namespace": "alpha", "prefix": "/team/roster/", "limit": 100})
call("mode_prefix_like_cli", {"namespace": "alpha", "mode": "prefix", "prefix": "/team/roster/", "limit": 100})
call("keyPrefix_nonexistent", {"namespace": "alpha", "keyPrefix": "/definitely/not/here/", "limit": 100})

with OUT.open("w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
print(f"evidence={OUT}")
