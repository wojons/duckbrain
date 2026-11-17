#!/usr/bin/env python3
"""Step 2b perf: what does a real recall cost on a 44-fact scratch namespace?

Warm and cold arms for the operations an agent actually runs, plus the semantic
(q=) arm which pays the embedding provider. Cold = the first call in this process
after the daemon has been idle (no prior query in this run); warm = repeats.
Numbers are wall ms measured around the HTTP round trip only.
"""
import json, time, statistics, urllib.request, urllib.error, pathlib

BASE = "http://127.0.0.1:3391"
OUT = pathlib.Path("/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence/perf.jsonl")
rows = []


def timed(label, path, timeout=180):
    t0 = time.time()
    code, raw = -1, ""
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            code, raw = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read().decode()
    except Exception as e:
        code, raw = -1, f"EXC {type(e).__name__}: {e}"
    ms = (time.time() - t0) * 1000
    n = None
    try:
        d = json.loads(raw)
        items = d.get("items") if isinstance(d, dict) else d
        n = len(items) if isinstance(items, list) else None
    except Exception:
        pass
    rec = {"label": label, "http": code, "ms": round(ms, 1), "items": n, "head": raw[:160]}
    rows.append(rec)
    print(f"{label:34s} http={code:3d} {ms:8.1f} ms items={n}")
    return ms, code, raw


# cold arm
timed("cold_list_all", "/api/memories?namespace=alpha&limit=100")
timed("cold_prefix", "/api/memories?namespace=alpha&prefix=/team/roster/&limit=100")
timed("cold_semantic", "/api/memories?namespace=alpha&q=postgres+cutover&limit=10")
timed("cold_contains", "/api/memories?namespace=alpha&contains=Postgres&limit=100")

warm = {}
for label, path in [
    ("warm_list_all", "/api/memories?namespace=alpha&limit=100"),
    ("warm_prefix", "/api/memories?namespace=alpha&prefix=/team/roster/&limit=100"),
    ("warm_semantic", "/api/memories?namespace=alpha&q=postgres+cutover&limit=10"),
    ("warm_contains", "/api/memories?namespace=alpha&contains=Postgres&limit=100"),
    ("warm_keys", "/api/keys?namespace=alpha"),
    ("warm_compaction", "/api/compaction/stats?namespace=alpha"),
]:
    samples = [timed(label, path)[0] for _ in range(5)]
    warm[label] = samples
    print(f"   -> {label}: median={statistics.median(samples):.1f} ms  "
          f"min={min(samples):.1f} max={max(samples):.1f}")

with OUT.open("w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
    f.write(json.dumps({"summary": {k: {"median_ms": round(statistics.median(v), 1),
                                        "samples_ms": [round(x, 1) for x in v]}
                                    for k, v in warm.items()}}) + "\n")
print(f"evidence={OUT}")
