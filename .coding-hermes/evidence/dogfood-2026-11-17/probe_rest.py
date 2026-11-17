#!/usr/bin/env python3
"""Read-only A/B: does the REST list filter by prefix (CLI does not)? + limit-form probe."""
import json, time, urllib.request, urllib.error, pathlib

BASE = "http://127.0.0.1:3391"
OUT = pathlib.Path("/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence/rest-prefix.jsonl")


def get(path, timeout=60):
    t0 = time.time()
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, r.read().decode(), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), (time.time() - t0) * 1000
    except Exception as e:
        return -1, f"EXC {type(e).__name__}: {e}", (time.time() - t0) * 1000


def count_items(raw):
    try:
        d = json.loads(raw)
    except Exception:
        return None, None
    if isinstance(d, dict):
        for k in ("items", "memories", "data", "results"):
            if isinstance(d.get(k), list):
                return len(d[k]), d.get("total", d.get("count"))
        return None, d.get("total")
    if isinstance(d, list):
        return len(d), None
    return None, None


rows = []
def probe(label, path):
    st, raw, ms = get(path)
    n, total = count_items(raw)
    keys = []
    try:
        d = json.loads(raw)
        items = d.get("items") if isinstance(d, dict) else d
        if isinstance(items, list):
            keys = [i.get("key") for i in items][:6]
    except Exception:
        pass
    rec = {"label": label, "path": path, "status": st, "wall_ms": round(ms, 1),
           "items": n, "total_field": total, "first_keys": keys, "body_head": raw[:200]}
    rows.append(rec)
    print(f"{label:28s} http={st} ms={ms:7.1f} items={n} total={total} keys={keys[:3]}")


probe("rest_all", "/api/memories?namespace=alpha&limit=100")
probe("rest_prefix_roster", "/api/memories?namespace=alpha&prefix=/team/roster/&limit=100")
probe("rest_prefix_nonexistent", "/api/memories?namespace=alpha&prefix=/definitely/not/here/&limit=100")
probe("rest_prefix_sprint_dec", "/api/memories?namespace=alpha&prefix=/sprint/decisions/&limit=100")
probe("rest_limit_3", "/api/memories?namespace=alpha&limit=3")
probe("rest_offset_5", "/api/memories?namespace=alpha&limit=5&offset=5")
probe("rest_keys", "/api/keys?namespace=alpha")
probe("rest_compaction_stats", "/api/compaction/stats?namespace=alpha")

with OUT.open("w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
print(f"evidence={OUT}")
