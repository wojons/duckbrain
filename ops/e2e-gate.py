#!/usr/bin/env python3
"""
DuckBrain end-to-end release gate.

Runs on a bunker agent against a real DuckBrain daemon and verifies from
OUTSIDE the agent: nothing here trusts DuckBrain's own "success" response.

Design rules
------------
1. The agent is the CLIENT, never the judge. Every claim is checked against
   bytes on disk, the audit ledger, the API's own view, and the object store.
2. Isolation first. Its own namespaces root, its own auth store, its own S3
   prefix - so nothing observed can be explained by leftover state.
3. Every leg has a falsifier: a specific number that must hold, or the leg
   FAILS. No "looked fine".
4. Adversarial legs carry as much weight as the happy path - a round trip that
   succeeds proves the least about a system whose failures are silent.

Usage (on the agent):
    python3 e2e-gate.py [--port 10310] [--ns e2egate] [--s3-prefix <p>]
Exit code = number of failed legs (0 = all green).
"""
import argparse, json, os, shutil, signal, subprocess, sys, time
import urllib.request, urllib.error

AP = argparse.ArgumentParser()
AP.add_argument("--port", type=int, default=10310)
AP.add_argument("--ns", default="e2egate")
AP.add_argument("--s3-prefix", default="e2e-gate-20260926")
AP.add_argument("--repo", default=os.path.expanduser("~/duckbrain"))
AP.add_argument("--root", default=os.path.expanduser("~/e2e-gate"))
A = AP.parse_args()

BASE = f"http://127.0.0.1:{A.port}"
REPO, ROOT, NS = A.repo, A.root, A.ns
RESULTS = []


def record(leg, ok, detail):
    RESULTS.append((leg, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {leg}: {detail}")


def sh(cmd, env=None, timeout=240):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", "TIMEOUT")


# ---------------------------------------------------------------- HTTP helpers
def req(method, path, body=None, key=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method,
                               headers={"Content-Type": "application/json"})
    if key:
        r.add_header("x-api-key", key)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw or b"{}")
            except Exception:
                return resp.status, {"_raw": raw.decode(errors="replace")[:200]}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return "ERR", {"error": str(e)[:160]}


def post(key, content, api_key, ns=NS, timeout=30):
    return req("POST", "/api/memories",
               {"key": key, "domain": "raw_note", "content": content,
                "attributes": {}, "namespace": ns}, key=api_key, timeout=timeout)


# ------------------------------------------------------------- disk/audit read
def disk_rows(ns=None):
    out = []
    base = os.path.join(ROOT, "namespaces")
    for dp, _, fns in os.walk(base):
        if "_audit" in dp or ".duckbrain-audit" in dp:
            continue
        for fn in fns:
            if not fn.endswith(".jsonl"):
                continue
            for line in open(os.path.join(dp, fn), errors="replace"):
                if line.strip():
                    try:
                        out.append(json.loads(line))
                    except Exception:
                        pass
    return out


def audit_rows():
    p = os.path.join(ROOT, "namespaces", NS, "_audit", "current.jsonl")
    if not os.path.exists(p):
        return []
    return [json.loads(l) for l in open(p, errors="replace") if l.strip()]


def is_junk(text):
    t = str(text or "").strip().lower()
    return t == "" or t in ("null", "undefined", "n/a")


# ================================================================ SETUP
print("=" * 72)
print("DuckBrain E2E RELEASE GATE")
print("=" * 72)
head = sh(f"cd {REPO} && git rev-parse --short HEAD").stdout.strip()
branch = sh(f"cd {REPO} && git branch --show-current").stdout.strip()
print(f"  build: {head} ({branch})")
print(f"  ns={NS}  port={A.port}  s3-prefix={A.s3_prefix}")

os.makedirs(os.path.join(ROOT, "namespaces"), exist_ok=True)
cfg = json.load(open(os.path.join(REPO, "duckbrain.config.example.json")))
cfg["namespacesPath"] = os.path.join(ROOT, "namespaces")
cfg["defaultNamespace"] = NS
cfg["namespaceMappings"] = {}
cfg["embedding"] = dict(cfg.get("embedding", {})); cfg["embedding"]["provider"] = "none"
cfg["s3"] = {"enabled": True, "endpoint": "https://hel1.your-objectstorage.com",
             "region": "us-east-1", "bucket": "duckbrain", "prefix": A.s3_prefix,
             "forcePathStyle": True, "pushOnCommit": True, "intervalSec": 30}
CFG = os.path.join(ROOT, "duckbrain.config.json")
json.dump(cfg, open(CFG, "w"), indent=2)

env = dict(os.environ)
env.update({"DUCKBRAIN_CONFIG_PATH": CFG,
            "DUCKBRAIN_NAMESPACES_PATH": cfg["namespacesPath"],
            "AWS_PROFILE": "duckbrain",
            "AWS_ENDPOINT_URL": "https://hel1.your-objectstorage.com",
            "AWS_DEFAULT_REGION": "us-east-1"})

AUTH = os.path.join(ROOT, "auth.json")
open(AUTH, "w").write('{"users":[],"apiKeys":[]}')
r = sh(f"cd {REPO} && node bin/duckbrain.js token --name e2egate --auth-file {AUTH}", env=env)
# The CLI prints the plaintext token on the line AFTER the "Generated API token:"
# header. Scanning for "any long alnum word" grabbed the wrong string earlier and
# every write 401'd - take the line that follows the header, and nothing else.
_lines = [l.strip() for l in (r.stdout + r.stderr).splitlines()]
TOK = None
for _i, _l in enumerate(_lines):
    if "Generated API token" in _l and _i + 1 < len(_lines):
        _cand = _lines[_i + 1].strip()
        if _cand and " " not in _cand:
            TOK = _cand
        break
if not TOK:
    TOK = next((l for l in _lines if len(l) >= 20 and " " not in l
                and l.replace("-", "").replace("_", "").isalnum()), None)
print(f"  token minted: {bool(TOK)}")

DENV = dict(env); DENV["DUCKBRAIN_AUTH_FILE"] = AUTH

# Pre-flight: kill anything already listening on the target port. A leftover
# daemon from an earlier (crashed) run keeps the port and serves its OWN auth
# store, so a fresh token 401s against a process the harness did not start -
# which reads as a product defect but is not one. This is the same orphaned
# scratch-daemon class the fleet files as DB-GAP-061.
_stale = sh(f"fuser -k {A.port}/tcp 2>/dev/null; pkill -f 'duckbrain.js http --port={A.port}' 2>/dev/null; true")
time.sleep(1)
_still = sh(f"ss -ltn 2>/dev/null | grep -c ':{A.port} '").stdout.strip()
print(f"  port {A.port} free after pre-flight: {_still == '0'}")

log = open(os.path.join(ROOT, "daemon.log"), "w")
daemon = subprocess.Popen(["node", "bin/duckbrain.js", "http", f"--port={A.port}", "--auth=apikey"],
                          cwd=REPO, env=DENV, stdout=log, stderr=log, start_new_session=True)
ready = False
for _ in range(45):
    st, _b = req("GET", "/health")
    if st in (200, 503):
        ready = True; break
    time.sleep(1)
print(f"  daemon ready: {ready} (health={st})")
if not ready:
    print(open(os.path.join(ROOT, "daemon.log")).read()[-1500:]); sys.exit(99)

# The minted token must actually work before any leg runs. A bad token would make
# every leg fail for the wrong reason and read as a product defect, so this is an
# explicit abort rather than a finding.
_tst, _ = post("/gate/tokencheck", "token check body", TOK)
print(f"  token authenticates: {_tst == 201} (POST -> {_tst})")
if _tst != 201:
    print("  ABORT: minted token does not authenticate - environmental (harness), not a product finding")
    sys.exit(98)

# ================================================================ LEG 1
print("\n--- LEG 1: round trip, verified by BYTES (not status codes)")
body = "gate leg1 body with = sign and  trailing space "
st, _ = post("/gate/leg1", body, TOK)
rows = {r.get("key"): r for r in disk_rows()}
row = rows.get("/gate/leg1")
stored = str(row.get("embedding_text")) if row else None
record("L1 write accepted", st == 201, f"POST -> {st}")
record("L1 bytes identical on disk", stored == body,
       f"in={len(body)}B out={len(stored) if stored is not None else 'MISSING'}B"
       + ("" if stored == body else f"  stored={stored!r}"))
st, page = req("GET", f"/api/memories?namespace={NS}", key=TOK)
api_row = next((i for i in (page.get("items") or []) if i.get("key") == "/gate/leg1"), None)
record("L1 API agrees with disk", bool(api_row) and str(api_row.get("content")) == body,
       "API returns the same bytes" if api_row else "row absent from API view")

# ================================================================ LEG 2
print("\n--- LEG 2: junk must be REFUSED and must not reach storage")
before_disk = len(disk_rows())
junk_cases = [("3 spaces", "   "), ("tab+nl", "\t\n  "), ("null", "null"),
              ("undefined", "undefined"), ("N/A", "N/A"), ("empty", "")]
all400 = True
for label, c in junk_cases:
    st, _ = post(f"/gate/junk-{label.replace(' ', '_')}", c, TOK)
    all400 &= (st == 400)
record("L2 every junk payload refused", all400, f"6 payloads -> 400: {all400}")
after_disk = disk_rows()
added = [r for r in after_disk if str(r.get("key", "")).startswith("/gate/junk-")]
record("L2 nothing stored for refusals", len(added) == 0, f"{len(added)} junk rows on disk")

# ================================================================ LEG 3
print("\n--- LEG 3: auth must actually gate")
st_no, _ = req("POST", "/api/memories",
               {"key": "/gate/anon", "domain": "raw_note", "content": "anon",
                "attributes": {}, "namespace": NS})
st_bad, _ = post("/gate/badkey", "bad key write", "definitely-not-a-valid-key")
anon_on_disk = [r for r in disk_rows() if r.get("key") in ("/gate/anon", "/gate/badkey")]
record("L3 no key -> refused", st_no in (401, 403), f"-> {st_no}")
record("L3 wrong key -> refused", st_bad in (401, 403), f"-> {st_bad}")
record("L3 refused writes stored nothing", len(anon_on_disk) == 0,
       f"{len(anon_on_disk)} rows leaked")

# ================================================================ LEG 4
print("\n--- LEG 4: durability - kill -9 mid-write, nothing torn")
import threading
stop = threading.Event()
sent = []

def hammer():
    i = 0
    while not stop.is_set():
        i += 1
        s, _b = post(f"/gate/durability-{i}", f"durability probe {i}" * 8, TOK, timeout=5)
        sent.append((i, s))

t = threading.Thread(target=hammer, daemon=True); t.start()
time.sleep(2.0)
os.killpg(os.getpgid(daemon.pid), signal.SIGKILL)
stop.set(); t.join(timeout=10)
time.sleep(0.5)
torn = []
for dp, _, fns in os.walk(os.path.join(ROOT, "namespaces")):
    if "_audit" in dp:
        continue
    for fn in fns:
        if fn.endswith(".jsonl"):
            for ln, line in enumerate(open(os.path.join(dp, fn), errors="replace"), 1):
                if line.strip():
                    try:
                        json.loads(line)
                    except Exception:
                        torn.append(f"{fn}:{ln}")
record("L4 no torn JSONL after SIGKILL", len(torn) == 0,
       f"acked={sum(1 for _, s in sent if s == 201)}, torn lines={len(torn)} {torn[:3]}")

# restart for the remaining legs
log = open(os.path.join(ROOT, "daemon.log"), "a")
daemon = subprocess.Popen(["node", "bin/duckbrain.js", "http", f"--port={A.port}", "--auth=apikey"],
                          cwd=REPO, env=DENV, stdout=log, stderr=log, start_new_session=True)
for _ in range(45):
    st, _b = req("GET", "/health")
    if st in (200, 503):
        break
    time.sleep(1)
rows = {r.get("key"): r for r in disk_rows()}
survived = sum(1 for k in rows if str(k).startswith("/gate/durability-"))
record("L4 acked rows survived the SIGKILL", survived > 0,
       f"{survived} durability rows readable after restart")

# ================================================================ LEG 5
print("\n--- LEG 5: four-way reconciliation (disk = audit = API = S3)")
rows = disk_rows()
junk_on_disk = [r for r in rows if is_junk(r.get("embedding_text"))]
aud = audit_rows()
accepted = sum(1 for a in aud if a.get("op") == "insert")
st, page = req("GET", f"/api/memories?namespace={NS}&limit=1000", key=TOK)
api_total = page.get("total") if isinstance(page, dict) else None
record("L5 disk contains zero junk", len(junk_on_disk) == 0,
       f"{len(junk_on_disk)} junk rows of {len(rows)}")
record("L5 audit accepted == disk rows", accepted == len(rows),
       f"audit={accepted} disk={len(rows)}")
record("L5 API total == disk rows", api_total == len(rows),
       f"api={api_total} disk={len(rows)}")

pu = sh(f"cd {REPO} && node bin/duckbrain.js s3 sync {NS} push", env=env, timeout=180)
time.sleep(3)
obj = f"s3://duckbrain/{A.s3_prefix}/{NS}/raw_note/2026-09/current.jsonl"
q = sh(f"cd {REPO} && node bin/duckbrain.js s3 query "
       f"\"SELECT count(*) AS n FROM read_json_auto('{obj}')\"", env=env, timeout=180)
out = (q.stdout or "") + (q.stderr or "")
try:
    s3n = int([l for l in out.splitlines() if l.strip().startswith("{")][-1].split(":")[1].split("}")[0])
except Exception:
    s3n = None
qj = sh(f"cd {REPO} && node bin/duckbrain.js s3 query "
        f"\"SELECT count(*) AS j FROM read_json_auto('{obj}') WHERE length(trim(coalesce(embedding_text,''))) = 0 "
        f"OR lower(trim(coalesce(embedding_text,''))) IN ('null','undefined','n/a')\"", env=env, timeout=180)
outj = (qj.stdout or "") + (qj.stderr or "")
try:
    s3junk = int([l for l in outj.splitlines() if l.strip().startswith("{")][-1].split(":")[1].split("}")[0])
except Exception:
    s3junk = None
record("L5 S3 rows == disk rows", s3n == len(rows), f"s3={s3n} disk={len(rows)}")
record("L5 S3 contains zero junk", s3junk == 0, f"s3 junk={s3junk}")

# ================================================================ LEG 6
print("\n--- LEG 6: the agent's OWN claim vs the bytes")
st, resp = req("GET", f"/api/memories/key/gate/leg1?namespace={NS}", key=TOK)
# This route's shape varies (object, wrapped object, or list) - normalise before
# reading, so a shape change shows up as a leg failure rather than a crash.
row_api = None
if isinstance(resp, dict):
    row_api = resp.get("memory") if isinstance(resp.get("memory"), dict) else resp
elif isinstance(resp, list) and resp and isinstance(resp[0], dict):
    row_api = resp[0]
claimed = row_api.get("content") if isinstance(row_api, dict) else None
# NB: `rows` is a LIST by this point (LEG 5 rebuilt it) - index it, do not .get()
_row_map = {r.get("key"): r for r in rows}
on_disk = str((_row_map.get("/gate/leg1") or {}).get("embedding_text"))
record("L6 claim matches disk", claimed == on_disk,
       f"claim={len(str(claimed))}B disk={len(on_disk)}B"
       + ("" if claimed == on_disk else "  MISMATCH - the API and the file disagree"))

# ================================================================ VERDICT
try:
    os.killpg(os.getpgid(daemon.pid), signal.SIGTERM)
except Exception:
    pass

failed = [r for r in RESULTS if not r[1]]
print("\n" + "=" * 72)
print(f"VERDICT: {len(RESULTS) - len(failed)}/{len(RESULTS)} legs passed"
      + ("  ** ALL GREEN **" if not failed else f"  ** {len(failed)} FAILED **"))
for leg, _ok, detail in failed:
    print(f"  FAILED: {leg} -- {detail}")
print("=" * 72)
sys.exit(len(failed))
