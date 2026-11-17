#!/usr/bin/env python3
"""Dogfood 2026-11-17: seed a realistic 'team memory' corpus into a scratch DuckBrain.

Real user story: a 5-agent team uses one namespace as shared project memory for a
sprint. Writes are the ordinary documented POST /api/memories payload.

Records the per-request wall time and status so the run can quote real numbers.
Writes ONLY to the scratch daemon on 127.0.0.1:3391 (isolated store).
"""
import json, time, urllib.request, urllib.error, datetime, pathlib

BASE = "http://127.0.0.1:3391"
NS = "alpha"
OUT = pathlib.Path("/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence/seed.jsonl")
OUT.parent.mkdir(parents=True, exist_ok=True)


def call(method, path, body=None, timeout=60):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, raw, (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), (time.time() - t0) * 1000
    except Exception as e:
        return -1, f"EXC {type(e).__name__}: {e}", (time.time() - t0) * 1000


rows = []
def rec(step, status, ms, body, note=""):
    rows.append({"step": step, "status": status, "wall_ms": round(ms, 1),
                 "body": body[:400], "note": note})
    print(f"{status}\t{ms:8.1f}ms\t{step}\t{body[:120]}")

# 1. Creating the namespace is documented as what git-inits it.
st, body, ms = call("GET", f"/api/namespaces")
rec("list_namespaces_before", st, ms, body)

st, body, ms = call("POST", "/api/namespaces", {"name": NS})
rec("create_namespace", st, ms, body)

# 2. The sprint workload: 40 memories over 5 key prefixes and all 6 domains.
DOMAINS = ["person", "event", "concept", "message", "config", "raw_note"]
PREFIXES = ["/team/roster", "/sprint/decisions", "/sprint/incidents",
            "/infra/configs", "/handoffs"]

corpus = []
for i in range(34):
    pfx = PREFIXES[i % len(PREFIXES)]
    dom = DOMAINS[i % len(DOMAINS)]
    key = f"{pfx}/{i:02d}"
    corpus.append({
        "key": key,
        "domain": dom,
        "content": (f"Sprint memory {i}: the {dom} note recorded that deploy pipeline "
                    f"{i} was migrated after the Postgres cutover and the on-call "
                    f"rotation changed to team-{i % 4}."),
        "attributes": {"ticket": f"SPR-{100+i}", "owner": f"agent-{i % 5}",
                       "confidence": 0.5 + (i % 5) / 10},
    })

# non-scalar attributes: a real user stores a list and a nested object
corpus.append({"key": "/team/roster/lead", "domain": "person",
               "content": "Team lead is responsible for the deploy pipeline and sprint reviews.",
               "attributes": {"tags": ["lead", "deploy", "review"], "meta": {"level": 3, "active": True},
                              "since": "2026-01-05"}})
corpus.append({"key": "/team/roster/oncall", "domain": "person",
               "content": "On-call rotation runs weekly, handover on Monday 09:00 UTC.",
               "attributes": {"tags": ["oncall"], "meta": {"level": 2, "active": True}}})
# validity windows: one already expired, one in the future
corpus.append({"key": "/infra/configs/old-db-host", "domain": "config",
               "content": "Legacy Postgres primary was db-old.internal:5432 (retired).",
               "attributes": {"valid_until": "2026-10-01T00:00:00Z", "confidence": 0.9}})
corpus.append({"key": "/infra/configs/new-db-host", "domain": "config",
               "content": "Postgres primary moved to db-new.internal:6432 after cutover.",
               "attributes": {"valid_from": "2027-01-01T00:00:00Z", "confidence": 0.9}})
# a duplicate-content pair (same text, two keys) - the consolidation dedupe case
dup = ("Standup happens at 09:15 UTC every weekday in the #sprint channel.")
corpus.append({"key": "/sprint/decisions/standup-a", "domain": "concept",
               "content": dup, "attributes": {"kind": "process"}})
corpus.append({"key": "/sprint/decisions/standup-b", "domain": "concept",
               "content": dup, "attributes": {"kind": "process"}})
# remaining 4 to reach 42 total
for i in range(4):
    corpus.append({"key": f"/handoffs/shift-{i}", "domain": "message",
                   "content": f"Shift handover {i}: zebra alerting tuned, flaky test {i} quarantined.",
                   "attributes": {"shift": i, "owner": "agent-0"}})

for r in corpus:
    st, body, ms = call("POST", f"/api/memories?namespace={NS}", r)
    rec(f"write {r['key']}", st, ms, body)

print(f"\nwrote={len(corpus)}")
with OUT.open("a") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
print(f"evidence={OUT}")
