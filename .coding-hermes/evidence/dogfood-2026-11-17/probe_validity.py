#!/usr/bin/env python3
"""Controlled validity-window probe (fresh namespace `beta`).

Three facts: current, expired (valid_until in the past), not-yet-valid (valid_from in
the future). Each written TWICE - once with the window inside `attributes` (the
convention RETR-011 documents) and once as a top-level field - so the probe separates
"the window is ignored" from "the window is read from a different place".

Then reads the CURRENT view (default) and the HISTORICAL view on both HTTP and CLI.
Scratch daemon only (127.0.0.1:3391).
"""
import json, subprocess, time, pathlib, os, urllib.request, urllib.error

BASE = "http://127.0.0.1:3391"
NS = "beta"
REPO = "/home/kara/duckbrain"
EV = pathlib.Path("/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence")
OUT = EV / "validity-probe.jsonl"
ENV = dict(os.environ,
           DUCKBRAIN_CONFIG_PATH="/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/duckbrain.config.json",
           DUCKBRAIN_NAMESPACES_PATH="/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/namespaces")


def req(method, path, body=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode(), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), (time.time() - t0) * 1000
    except Exception as e:
        return -1, f"EXC {type(e).__name__}: {e}", (time.time() - t0) * 1000


rows = []
def rec(**kw):
    rows.append(kw)
    print(json.dumps({k: kw[k] for k in kw if k in ("step", "http", "items", "keys", "wall_ms")}))


st, body, ms = req("POST", "/api/namespaces", {"name": NS})
rec(step="create_ns_beta", http=st, body=body[:200], wall_ms=round(ms, 1))

writes = [
    ("/facts/current", {"content": "Current fact: primary DB is db-new.internal:6432.", "attributes": {"confidence": 1}}),
    ("/facts/expired-attr", {"content": "Expired fact: primary DB is db-old.internal:5432.",
                             "attributes": {"valid_until": "2026-10-01T00:00:00Z"}}),
    ("/facts/future-attr", {"content": "Future fact: primary DB will be db-next.internal:7432.",
                            "attributes": {"valid_from": "2027-01-01T00:00:00Z"}}),
    ("/facts/expired-top", {"content": "Expired fact (top-level): cache host is cache-old.internal.",
                            "attributes": {}, "valid_until": "2026-10-01T00:00:00Z"}),
    ("/facts/future-top", {"content": "Future fact (top-level): cache host will be cache-next.internal.",
                           "attributes": {}, "valid_from": "2027-01-01T00:00:00Z"}),
]
for key, payload in writes:
    body = {"key": key, "domain": "config", **payload}
    st, b, ms = req("POST", f"/api/memories?namespace={NS}", body)
    rec(step=f"write {key}", http=st, body=b[:160], wall_ms=round(ms, 1))

# let the git debounce commit so as-of has a ref later; reads do not need it
time.sleep(2)


def http_list(label, query):
    st, body, ms = req("GET", f"/api/memories?namespace={NS}&limit=100{query}")
    try:
        d = json.loads(body)
        items = d.get("items", d if isinstance(d, list) else [])
        keys = sorted(i.get("key") for i in items)
        total = d.get("total") if isinstance(d, dict) else None
    except Exception:
        keys, total = [], None
    rec(step=label, http=st, items=len(keys), keys=keys, total_field=total,
        wall_ms=round(ms, 1), raw_head=body[:200])


def cli(label, args):
    t0 = time.time()
    p = subprocess.run(["node", "bin/duckbrain.js", *args], cwd=REPO, env=ENV,
                       capture_output=True, text=True, timeout=180)
    ms = (time.time() - t0) * 1000
    keys = sorted({ln.split('"key": "')[1].split('"')[0]
                   for ln in p.stdout.splitlines() if '"key": "' in ln})
    rec(step=label, rc=p.returncode, items=len(keys), keys=keys,
        header=p.stdout.splitlines()[0] if p.stdout else "", wall_ms=round(ms, 1))


http_list("http_current", "")
http_list("http_historical", "&historical=true")
cli("cli_current", ["recall", f"--namespace={NS}", "--limit=100"])
cli("cli_historical", ["recall", f"--namespace={NS}", "--limit=100", "--historical"])
cli("cli_asof_before_first_commit", ["recall", f"--namespace={NS}", "--as-of=2020-01-01"])
cli("cli_status_beta", ["status", f"--namespace={NS}"])

with OUT.open("w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
print(f"evidence={OUT}")
