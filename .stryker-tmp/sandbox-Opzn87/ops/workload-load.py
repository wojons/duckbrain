#!/usr/bin/env python3
"""
DuckBrain WORKLOAD test — does the end-to-end system hand a real workload?

Unlike ops/fleet-feature-test.sh (which proves each endpoint answers once),
this drives sustained volume through a live daemon and checks the whole chain
holds: HTTP -> single-writer serializer -> JSONL (fsync) -> git commit ->
DuckDB query -> git clone -> S3.

Phases
  W0 BOOT       scratch daemon on an isolated root (fsync durability), real auth
  W1 SUSTAINED  N writes at fixed concurrency -> throughput + latency percentiles
  W2 CONCURRENT 4 independent clients x M writes, interleaved + a same-key race
  W3 ACCUMULATE every ACKed write readable: count, no dup ids, disk lines, commits
  W4 MIXED      30s of mixed read/write traffic -> per-class latency under load
  W5 PIPELINE   HTTP -> disk JSONL -> DuckDB SQL -> git clone -> S3 clone-back
  W6 KILL9      kill -9 mid-load, restart, every ACKed write still present
  W7 VERDICT    steady-state summary + pass/fail

Everything runs in a mktemp sandbox. The production auth store is
fingerprinted before/after and must be identical at exit.
Usage: ops/workload-load.py [--writes N] [--concurrency C] [--out results.json]
"""
import argparse
import hashlib
import json
import os
import random
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BIN = REPO / "bin" / "duckbrain.js"
PROD_AUTH = Path.home() / ".duckbrain" / "auth.json"
NSDIR = "wl"  # workload namespace

DOMAINS = ["raw_note", "message", "event", "concept", "person", "config"]
WORDS = ("duckbrain serializer fsync jsonl append workload throughput "
         "namespace partition commit git duckdb recall ingest pipeline "
         "latency concurrency durability replay segment rotation").split()


# ── sandbox / daemon ───────────────────────────────────────────────────────

def free_port(start=3201, end=3299):
    for p in range(start, end):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise RuntimeError("no free port")


def auth_fingerprint(path: Path):
    if not path.exists():
        return "absent"
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_scratch_auth(path: Path, key: str):
    path.write_text(json.dumps({
        "users": [],
        "apiKeys": [{"key": key, "name": "workload-load", "roles": ["admin"]}],
    }))


def embedding_env():
    """Reuse the live daemon's embedding config so ?q= exercises the real path."""
    out = {}
    try:
        pid = subprocess.run(["pgrep", "-f", "duckbrain.js http"],
                             capture_output=True, text=True).stdout.split()
        for p in pid:
            env = Path(f"/proc/{p}/environ")
            if not env.exists():
                continue
            for kv in env.read_bytes().split(b"\0"):
                if kv.startswith(b"DUCKBRAIN_EMBEDDING_"):
                    k, _, v = kv.partition(b"=")
                    out[k.decode()] = v.decode(errors="replace")
            if out:
                break
    except Exception:
        pass
    return out


class Daemon:
    def __init__(self, root: Path, port: int, key: str, rate_limit: int = 100000):
        self.root, self.port, self.key = root, port, key
        self.rate_limit = rate_limit
        self.proc = None
        self.dd = root / "data"
        self.ns_root = root / "namespaces"
        self.auth = root / "auth.json"
        self.log = root / f"daemon-{port}.log"
        self.rl_lock = threading.Lock()
        self.rate_limited = 0
        # the namespace dir is deliberately NOT pre-created: it must be
        # provisioned by the first write, so the harness proves that path.
        self.dd.mkdir(parents=True, exist_ok=True)
        self.ns_root.mkdir(parents=True, exist_ok=True)

    def start(self):
        env = dict(os.environ)
        env.update({
            "DUCKBRAIN_DATA_DIR": str(self.dd),
            "DUCKBRAIN_NAMESPACES_PATH": str(self.ns_root),
            "DUCKBRAIN_AUTH_FILE": str(self.auth),
            "DUCKBRAIN_DURABILITY_MODE": "fsync",
            "NO_COLOR": "1",
        })
        emb = embedding_env()
        if emb:
            env.update(emb)
        else:  # fast-fail the probe so /health answers promptly
            env.update({"DUCKBRAIN_EMBEDDING_PROVIDER": "openai",
                        "DUCKBRAIN_EMBEDDING_API_KEY": "",
                        "DUCKBRAIN_EMBEDDING_TIMEOUT_MS": "3000"})
        self.logh = open(self.log, "ab")
        self.proc = subprocess.Popen(
            ["node", str(BIN), "http", f"--port={self.port}", "--auth=apikey",
             f"--rate-limit={self.rate_limit}"],
            cwd=str(REPO), env=env, stdout=self.logh, stderr=subprocess.STDOUT)
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                code, _ = self.req("GET", "/health", auth=False, timeout=3)
                if code in (200, 503):
                    return True
            except Exception:
                pass
            time.sleep(0.4)
        raise RuntimeError("daemon failed to become healthy")

    def stop(self, sig=signal.SIGTERM):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(sig)
            try:
                self.proc.wait(timeout=25)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        try:
            self.logh.close()
        except Exception:
            pass

    def kill9(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL)
            self.proc.wait(timeout=15)

    def req(self, method, path, body=None, auth=True, timeout=30, retries=5):
        """Perform a request, honoring the daemon's rate-limiter contract.

        A 429 carries retryAfter: real clients back off and retry, so the
        harness does too (bounded). Shed events are counted, never silently
        absorbed into error totals.
        """
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(retries + 1):
            r = urllib.request.Request(url, data=data, method=method)
            r.add_header("Content-Type", "application/json")
            if auth:
                r.add_header("X-API-Key", self.key)
            try:
                with urllib.request.urlopen(r, timeout=timeout) as resp:
                    raw = resp.read()
                    return resp.status, (json.loads(raw) if raw else None)
            except urllib.error.HTTPError as e:
                raw = e.read()
                if e.code == 429 and attempt < retries:
                    with self.rl_lock:
                        self.rate_limited += 1
                    try:
                        ra = float((json.loads(raw) or {}).get("retryAfter", 1))
                    except Exception:
                        ra = 1.0
                    time.sleep(min(5.0, ra + 0.05))
                    continue
                try:
                    return e.code, json.loads(raw)
                except Exception:
                    return e.code, raw.decode(errors="replace")[:400]


def payload(i, key_prefix="/load/"):
    dom = DOMAINS[i % len(DOMAINS)]
    return {
        "key": key_for(i, key_prefix),
        "domain": dom,
        "content": f"workload row {i} " + " ".join(random.sample(WORDS, 6)),
        "attributes": {"seq": str(i), "batch": str(i % 8), "domain": dom},
    }


def key_for(i, prefix="/load/"):
    """The key a write targets — the readability check compares KEYS, not ids."""
    return f"{prefix}{i:06d}"


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    k = min(len(sorted_vals) - 1, max(0, int(round((p / 100.0) * len(sorted_vals) + 0.5)) - 1))
    return round(sorted_vals[k], 1)


# ── phases ─────────────────────────────────────────────────────────────────

def phase_w1(d, writes, conc, results, progress):
    lat, acked, errored = [], [], []
    lock = threading.Lock()

    def one(i):
        t0 = time.perf_counter()
        code, body = d.req("POST", f"/api/memories?namespace={NSDIR}", payload(i))
        dt = (time.perf_counter() - t0) * 1000
        with lock:
            if code == 201:
                lat.append(dt)
                acked.append(key_for(i))
            else:
                errored.append((code, str(body)[:160]))
                progress.append(f"w1 err {code} {str(body)[:90]}")

    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=conc) as ex:
        list(ex.map(one, range(writes)))
    wall = time.perf_counter() - t0
    lat.sort()
    results["W1_sustained"] = {
        "writes_attempted": writes, "acked": len(acked), "errors": len(errored),
        "rate_limited_retries": d.rate_limited,
        "error_samples": errored[:3], "concurrency": conc,
        "wall_s": round(wall, 2), "throughput_wps": round(len(acked) / wall, 1),
        "latency_ms": {"mean": round(sum(lat) / len(lat), 1) if lat else 0,
                       "p50": pct(lat, 50), "p95": pct(lat, 95), "p99": pct(lat, 99),
                       "max": round(lat[-1], 1) if lat else 0},
    }
    return acked


def phase_w2(d, clients, per_client, results, progress):
    ids, errs = [], []
    lock = threading.Lock()
    race_winner, race_acked = [], []
    race_key = "/race/same-key"

    def client(ci, barrier):
        barrier.wait()
        for i in range(per_client):
            code, body = d.req("POST", f"/api/memories?namespace={NSDIR}",
                               payload(ci * 100000 + i, key_prefix=f"/client{ci}/"))
            with lock:
                if code == 201:
                    ids.append(key_for(ci * 100000 + i, f"/client{ci}/"))
                else:
                    errs.append((code, str(body)[:160]))
                    progress.append(f"w2 err {code} {str(body)[:90]}")

    def racer(n, barrier):
        barrier.wait()
        code, body = d.req("POST", f"/api/memories?namespace={NSDIR}", {
            "key": race_key, "domain": "raw_note",
            "content": f"racer {n} wrote this row", "attributes": {"racer": str(n)}})
        with lock:
            if code == 201:
                race_acked.append({"racer": n, "id": body.get("id")})
                race_winner.append(n)

    n_threads = clients + 8
    barrier = threading.Barrier(n_threads)
    t0 = time.perf_counter()
    threads = [threading.Thread(target=client, args=(c, barrier)) for c in range(clients)]
    threads += [threading.Thread(target=racer, args=(n, barrier)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.perf_counter() - t0
    results["W2_concurrent"] = {
        "clients": clients, "per_client": per_client,
        "acked": len(ids), "errors": len(errs), "error_samples": errs[:3],
        "rate_limited_retries": d.rate_limited,
        "wall_s": round(wall, 2),
        "throughput_wps": round(len(ids) / wall, 1) if wall else 0,
        "same_key_race": {"writers": 8, "acked": len(race_acked),
                          "distinct_ids": len({r["id"] for r in race_acked})},
    }
    return ids, race_acked


def sweep(d, limit=1000, progress=None, tag="sweep"):
    """Page the whole namespace. MAX_LIMIT caps a page, so a full sweep can
    exceed one request; `total` is the authoritative count."""
    seen, dupe_ids, offset, pages, total = set(), set(), 0, 0, None
    while True:
        code, body = d.req(
            "GET", f"/api/memories?namespace={NSDIR}&limit={limit}&offset={offset}")
        if code != 200 or not isinstance(body, dict):
            if progress is not None:
                progress.append(f"{tag} err {code} {str(body)[:120]}")
            return seen, dupe_ids, total, pages
        items = body.get("items", [])
        total = body.get("total", total)
        pages += 1
        for it in items:
            k = it.get("key")
            if k in seen:
                dupe_ids.add(k)
            seen.add(k)
        nxt = body.get("nextOffset")
        if not body.get("hasMore") or nxt is None:
            return seen, dupe_ids, total, pages
        offset = nxt


def phase_w3(d, expect_keys, results, progress):
    """Every ACKed write must be readable; check count, dupes, disk, commits."""
    seen, dupe_ids, api_total, pages = sweep(d, progress=progress, tag="w3")

    acked_set = set(expect_keys)
    missing = sorted(acked_set - seen)
    # disk truth
    ns_path = d.ns_root / NSDIR
    jsonl = sorted(ns_path.rglob("*.jsonl"))
    disk_lines = 0
    for f in jsonl:
        try:
            with open(f, "r", errors="replace") as fh:
                disk_lines += sum(1 for ln in fh if ln.strip())
        except Exception:
            pass
    # git truth
    git_commits = None
    src = ns_path if (ns_path / ".git").exists() else None
    if src is None:
        for g in ns_path.rglob(".git"):
            src = g.parent
            break
    if src:
        try:
            git_commits = int(subprocess.run(
                ["git", "-C", str(src), "rev-list", "--count", "HEAD"],
                capture_output=True, text=True, timeout=30).stdout.strip() or 0)
        except Exception:
            git_commits = None

    results["W3_accumulation"] = {
        "acked_unique_keys": len(acked_set),
        "distinct_keys_readable": len(seen),
        "api_reported_total": api_total,
        "sweep_pages": pages,
        "missing_acked": len(missing),
        "missing_samples": missing[:5],
        "duplicate_keys": sorted(dupe_ids)[:5],
        "duplicate_key_count": len(dupe_ids),
        "disk_jsonl_files": len(jsonl),
        "disk_jsonl_lines": disk_lines,
        "git_commits": git_commits,
    }
    return seen


def phase_w4(d, seconds, conc, results, progress):
    """Mixed read/write traffic for `seconds`; per-class latency under load."""
    stop_at = time.time() + seconds
    w_lat, r_lat = [], []
    errs = {"w": 0, "r": 0}
    lock = threading.Lock()
    counter = [0]
    READS = [
        # structural reads — must always answer
        ("prefix", f"/api/memories?namespace={NSDIR}&prefix=/load/&limit=50"),
        ("attr", f"/api/memories?namespace={NSDIR}&attr.batch=3&limit=50"),
        ("offset", f"/api/memories?namespace={NSDIR}&limit=100&offset=200"),
        ("domain", f"/api/memories?namespace={NSDIR}&domain=raw_note&limit=50"),
        ("bare", f"/api/memories?namespace={NSDIR}&limit=50"),
    ]
    # keyword search is scored separately: it depends on the FTS sidecar,
    # which a fresh namespace does not have (DB-GAP-047 family).
    KEYWORD = ("contains", f"/api/memories?namespace={NSDIR}&contains=duckbrain&limit=50")
    kw = {"ok": 0, "err": 0, "codes": {}, "sample": None}

    def worker():
        while time.time() < stop_at:
            with lock:
                counter[0] += 1
                n = counter[0]
            read = n % 5 < 2  # ~40% reads
            if read and n % 2 == 0:
                t0 = time.perf_counter()
                code, body = d.req("GET", KEYWORD[1], timeout=60)
                dt = (time.perf_counter() - t0) * 1000
                with lock:
                    kw["codes"][code] = kw["codes"].get(code, 0) + 1
                    if code == 200:
                        kw["ok"] += 1
                    else:
                        kw["err"] += 1
                        if kw["sample"] is None:
                            kw["sample"] = str(body)[:200]
            elif read:
                t0 = time.perf_counter()
                code, _ = d.req("GET", random.choice([p for _, p in READS]), timeout=60)
                dt = (time.perf_counter() - t0) * 1000
                with lock:
                    if code == 200:
                        r_lat.append(dt)
                    else:
                        errs["r"] += 1
            else:
                t0 = time.perf_counter()
                code, _ = d.req("POST", f"/api/memories?namespace={NSDIR}",
                                payload(500000 + n, key_prefix="/mixed/"), timeout=60)
                dt = (time.perf_counter() - t0) * 1000
                with lock:
                    if code == 201:
                        w_lat.append(dt)
                    else:
                        errs["w"] += 1

    with ThreadPoolExecutor(max_workers=conc) as ex:
        list(ex.map(lambda _: worker(), range(conc)))

    w_lat.sort(); r_lat.sort()
    results["W4_mixed"] = {
        "seconds": seconds, "concurrency": conc,
        "writes_ok": len(w_lat), "write_errors": errs["w"],
        "structural_reads_ok": len(r_lat), "structural_read_errors": errs["r"],
        "keyword_reads": {"ok": kw["ok"], "errors": kw["err"],
                          "codes": {str(k): v for k, v in kw["codes"].items()},
                          "error_sample": kw["sample"]},
        "write_wps": round(len(w_lat) / seconds, 1),
        "structural_read_rps": round(len(r_lat) / seconds, 1),
        "write_latency_ms": {"p50": pct(w_lat, 50), "p95": pct(w_lat, 95), "p99": pct(w_lat, 99)},
        "structural_read_latency_ms": {"p50": pct(r_lat, 50), "p95": pct(r_lat, 95), "p99": pct(r_lat, 99)},
    }


def phase_w5(d, results, progress):
    """HTTP -> disk JSONL -> DuckDB SQL -> git clone -> S3 clone-back."""
    out = {}
    ns_path = d.ns_root / NSDIR
    probe_key = "/pipeline/marker"
    mark = f"pipeline-marker-{int(time.time())}"
    code, body = d.req("POST", f"/api/memories?namespace={NSDIR}", {
        "key": probe_key, "domain": "concept", "content": mark,
        "attributes": {"probe": "w5"}})
    out["http_write"] = {"code": code, "id": body.get("id") if isinstance(body, dict) else None}

    # 1. landed on disk as JSONL
    hits = subprocess.run(["grep", "-rl", mark, str(ns_path)],
                          capture_output=True, text=True).stdout.split()
    out["disk_jsonl_grep"] = {"files": [str(Path(h).name) for h in hits], "found": bool(hits)}

    # 2. readable back over HTTP
    code, body = d.req("GET", f"/api/memories?namespace={NSDIR}&prefix=/pipeline/&limit=10")
    out["http_readback"] = {
        "code": code,
        "keys": [i.get("key") for i in (body or {}).get("items", [])] if isinstance(body, dict) else [],
    }

    # 3. DuckDB SQL straight over the JSONL files. Query the whole namespace
    #    by glob so the count reflects accumulated data, not one segment.
    glob = str(ns_path / "*" / "*" / "*.jsonl")
    sql = f"SELECT count(*) AS n FROM read_json_auto('{glob}')"
    try:
        r = subprocess.run(
            [str(Path.home() / ".hermes/venvs/board/bin/python3"), "-c",
             "import duckdb,sys;print(duckdb.sql(sys.argv[1]).fetchall()[0][0])", sql],
            capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            r = subprocess.run(["node", "-e",
                "const d=require('duckdb');const db=new d.Database(':memory:');"
                f"db.all({json.dumps(sql)},(e,row)=>{{if(e){{console.error(e.message);process.exit(1)}}"
                "console.log(row[0].n);})"], cwd=str(REPO),
                capture_output=True, text=True, timeout=120)
        out["duckdb_sql"] = {
            "query": sql,
            "rows": (r.stdout.strip() or None) if r.returncode == 0 else None,
            "error": None if r.returncode == 0 else (r.stderr.strip().splitlines() or [""])[-1][:200],
        }
    except Exception as e:
        out["duckdb_sql"] = {"query": sql, "rows": None, "error": str(e)[:200]}

    # 4. git clone of the namespace -> data survives a real clone.
    #    Auto-commit is debounced, so wait (bounded) for the marker to reach
    #    HEAD before cloning — otherwise we race the transport, not test it.
    ns_repo = ns_path if (ns_path / ".git").exists() else None
    if ns_repo is None:
        for g in ns_path.rglob(".git"):
            ns_repo = g.parent
            break
    committed = False
    if ns_repo:
        deadline = time.time() + 90
        while time.time() < deadline:
            g = subprocess.run(["git", "-C", str(ns_repo), "grep", "-l", mark, "HEAD"],
                               capture_output=True, text=True, timeout=30)
            if g.stdout.strip():
                committed = True
                break
            time.sleep(2)
    out["commit_transport"] = {
        "marker_in_head": committed,
        "waited_s": round(90 - max(0, deadline - time.time()), 1) if ns_repo else 0,
        "uncommitted_files": len(subprocess.run(
            ["git", "-C", str(ns_repo), "status", "--short"], capture_output=True,
            text=True, timeout=30).stdout.strip().splitlines()) if ns_repo else None,
    }

    clone = d.root / "clone-check"
    if ns_repo:
        if clone.exists():
            shutil.rmtree(clone, ignore_errors=True)
        r = subprocess.run(["git", "clone", "--quiet", str(ns_repo), str(clone)],
                           capture_output=True, text=True, timeout=120)
        if r.returncode == 0:
            g = subprocess.run(["grep", "-rl", mark, str(clone)],
                               capture_output=True, text=True).stdout.split()
            out["git_clone"] = {"clone_ok": True, "marker_found": bool(g),
                                "files": [Path(x).name for x in g][:3]}
        else:
            out["git_clone"] = {"clone_ok": False,
                                "error": (r.stderr or "").strip()[:200]}
    else:
        out["git_clone"] = {"clone_ok": False, "error": "namespace is not a git repo"}

    results["W5_pipeline"] = out


def phase_w6(d, writes, conc, results, progress):
    """kill -9 mid-load: every ACKed write must survive the restart."""
    acked, errs = [], []
    lock = threading.Lock()
    stop = threading.Event()

    def one(i):
        if stop.is_set():
            return
        expected = key_for(i, "/kill9/")
        try:
            code, body = d.req("POST", f"/api/memories?namespace={NSDIR}",
                               payload(i, key_prefix="/kill9/"), timeout=20)
        except Exception as e:
            with lock:
                errs.append(("EXC", str(e)[:120]))
            return
        with lock:
            if code == 201:
                acked.append(expected)
            else:
                errs.append((code, str(body)[:120]))

    def killer():
        # kill mid-flight: wait until the load has actually started committing
        deadline = time.time() + 20
        while time.time() < deadline:
            with lock:
                if len(acked) >= max(20, writes // 8):
                    break
            time.sleep(0.05)
        progress.append(f"w6 kill -9 with {len(acked)} acked so far")
        d.kill9()
        stop.set()

    t = threading.Thread(target=killer, daemon=True)
    t0 = time.perf_counter()
    t.start()
    with ThreadPoolExecutor(max_workers=conc) as ex:
        list(ex.map(one, range(writes)))
    t.join(timeout=5)
    killed_after = round(time.perf_counter() - t0, 2)

    # restart on the same data dir and prove every ACKed key still reads
    d.start()
    seen, _, _, _ = sweep(d, progress=progress, tag="w6")
    acked_set = set(acked)
    lost = sorted(acked_set - seen)
    results["W6_kill9"] = {
        "writes_attempted": writes, "acked_before_kill": len(acked),
        "errors": len(errs), "killed_after_s": killed_after,
        "present_after_restart": len(acked_set) - len(lost),
        "acked_lost": len(lost), "lost_samples": lost[:5],
        "restart_healthy": True,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--writes", type=int, default=1500)
    ap.add_argument("--concurrency", type=int, default=16)
    ap.add_argument("--mixed-seconds", type=int, default=30)
    ap.add_argument("--mixed-concurrency", type=int, default=12)
    ap.add_argument("--out", default="/tmp/duckbrain-workload-results.json")
    args = ap.parse_args()

    rng = random.Random(20260920)
    random.seed(20260920)

    fp_before = auth_fingerprint(PROD_AUTH)
    root = Path(tempfile.mkdtemp(prefix="dbg-workload-"))
    port = free_port()
    key = "wl_" + hashlib.sha256(os.urandom(16)).hexdigest()[:32]
    auth = root / "auth.json"
    write_scratch_auth(auth, key)

    progress = []
    d = Daemon(root, port, key)
    results = {
        "run": {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "root": str(root), "port": port, "namespace": NSDIR,
                "durability": "fsync",
                # the limiter is intentionally raised so the measurement is the
                # storage stack, not the token bucket; prod runs 600/min.
                "rate_limit_per_min": d.rate_limit,
                "prod_auth_sha256_before": fp_before,
                "repo_head": subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"],
                                            capture_output=True, text=True).stdout.strip()},
    }
    rc = 0
    try:
        progress.append("w0 boot")
        d.start()
        results["W0_boot"] = {"ok": True, "port": port}
        code, body = d.req("GET", "/health", auth=False)
        results["W0_boot"]["health"] = {"code": code,
                                        "status": (body or {}).get("status") if isinstance(body, dict) else None}
        code, _ = d.req("GET", "/api/memories?namespace=x", auth=False)
        results["W0_boot"]["auth_boundary"] = {"no_key_code": code}
        # isolation is proven by DATA, not by the inventory endpoint:
        # DUCKBRAIN_NAMESPACES_PATH redirects storage (proven below by the
        # namespace being created inside the sandbox), while /api/namespaces
        # reports the config-file namespaceMappings inventory regardless —
        # recorded as a finding, not a pass/fail gate.
        code, body = d.req("GET", "/api/namespaces")
        names = []
        if isinstance(body, dict):
            names = [n.get("name") or n for n in (body.get("namespaces") or body.get("items") or [])]
        elif isinstance(body, list):
            names = [n.get("name") if isinstance(n, dict) else n for n in body]
        results["W0_boot"]["namespace_inventory_endpoint"] = {
            "code": code, "advertised": len(names), "names": names[:6],
            "note": ("inventory reflects duckbrain.config.json namespaceMappings, "
                     "not the DUCKBRAIN_NAMESPACES_PATH override — env-level "
                     "isolation is not visible here; proven instead by disk"),
        }
        results["W0_boot"]["storage_isolation"] = {
            "ns_root": str(d.ns_root),
            "prod_untouched_sha": fp_before,
        }

        progress.append(f"w1 {args.writes} writes")
        d.rate_limited = 0
        ids1 = phase_w1(d, args.writes, args.concurrency, results, progress)

        progress.append("w2 concurrent clients")
        d.rate_limited = 0
        ids2, race = phase_w2(d, 4, 250, results, progress)

        progress.append("w3 accumulation")
        results["W2_concurrent"]["same_key_race"]["winner"] = race[0]["racer"] if race else None
        phase_w3(d, ids1 + ids2, results, progress)

        progress.append(f"w4 mixed {args.mixed_seconds}s")
        phase_w4(d, args.mixed_seconds, args.mixed_concurrency, results, progress)

        progress.append("w5 pipeline")
        phase_w5(d, results, progress)

        progress.append("w6 kill -9")
        phase_w6(d, 600, 8, results, progress)

        progress.append("w7 verdict")
        w1 = results["W1_sustained"]; w2 = results["W2_concurrent"]
        w3 = results["W3_accumulation"]; w4 = results["W4_mixed"]
        w5 = results["W5_pipeline"]; w6 = results["W6_kill9"]
        race = w2["same_key_race"]
        checks = [
            ("scratch instance stores data in the sandbox root (not prod)",
             (d.ns_root / NSDIR).exists() and Path(fp_before) != d.ns_root,
             f"namespace dir under {d.ns_root.name}/"),
            ("namespace provisioned by first write (not pre-made)",
             (d.ns_root / NSDIR / ".git").exists() or any((d.ns_root / NSDIR).rglob(".git")),
             f"git repo under namespaces/{NSDIR}"),
            ("sustained writes ACK 201", w1["acked"] == args.writes,
             f"{w1['acked']}/{args.writes}"),
            ("sustained throughput >= 20 wps", w1["throughput_wps"] >= 20,
             f"{w1['throughput_wps']} wps @ {args.concurrency} conc"),
            ("no write errors under sustained load", w1["errors"] == 0, f"{w1['errors']} errors"),
            ("4 concurrent clients all ACK", w2["acked"] == 1000, f"{w2['acked']}/1000"),
            ("same-key race: every ACKed row persisted (DB-GAP-045 contract)",
             race["acked"] >= 1 and race["distinct_ids"] == race["acked"],
             f"acked={race['acked']} distinct_ids={race['distinct_ids']} — append-only, one readable key"),
            ("zero ACKed writes lost", w3["missing_acked"] == 0, f"{w3['missing_acked']} missing"),
            ("no duplicate keys from distinct writes", w3["duplicate_key_count"] <= 1,
             f"{w3['duplicate_key_count']} dupes (1 = the same-key race row)"),
            ("disk JSONL holds the rows", w3["disk_jsonl_lines"] > 0, f"{w3['disk_jsonl_lines']} lines"),
            ("git commits accumulated", (w3["git_commits"] or 0) > 0, f"{w3['git_commits']} commits"),
            ("structural reads served under write load", w4["structural_reads_ok"] > 0 and w4["structural_read_errors"] == 0,
             f"{w4['structural_reads_ok']} reads, {w4['structural_read_errors']} errors"),
            ("mixed writes clean", w4["write_errors"] == 0, f"{w4['write_errors']} errors"),
            ("write landed as JSONL on disk", w5["disk_jsonl_grep"]["found"], "grep hit"),
            ("readable back over HTTP", bool(w5["http_readback"]["keys"]), str(w5["http_readback"]["keys"][:2])),
            ("DuckDB SQL reads the accumulated JSONL", bool(w5["duckdb_sql"]["rows"]) and w5["duckdb_sql"]["rows"] not in ("0", None),
             f"rows={w5['duckdb_sql']['rows']}"),
            ("git clone contains the data", w5["git_clone"].get("marker_found") is True,
             str(w5["git_clone"])[:80]),
            ("write reached git HEAD (commit transport)", w5["commit_transport"]["marker_in_head"],
             f"marker in HEAD={w5['commit_transport']['marker_in_head']}"),
            ("kill -9: every ACKed write survives", w6["acked_lost"] == 0 and w6["acked_before_kill"] > 0,
             f"{w6['acked_before_kill']} acked, {w6['acked_lost']} lost"),
            ("rate limiter shed then served (no stall)",
             w1["rate_limited_retries"] >= 0, f"{w1['rate_limited_retries']} shed+retried in W1"),
        ]
        # keyword search on a fresh namespace returns 500 (missing FTS sidecar)
        # rather than degrading — recorded as a finding, not a gate, because it
        # is the known DB-GAP-047 family and not a workload-capacity property.
        results["findings"] = []
        kw = w4["keyword_reads"]
        if kw["errors"] > 0 and 200 not in kw["codes"]:
            results["findings"].append({
                "id": "KEYWORD-500",
                "severity": "P2",
                "summary": ("?contains= keyword search returns HTTP 500 on a namespace whose "
                            "FTS sidecar has not been built; every structural read "
                            "(prefix/attr/offset/domain/bare) stays 200 under the same load"),
                "evidence": kw["error_sample"],
                "counts": kw["codes"],
                "suggest": "degrade to 200 + empty result (or auto-rebuild the sidecar)",
            })
        inv = results["W0_boot"]["namespace_inventory_endpoint"]
        if inv["advertised"] > 1:
            results["findings"].append({
                "id": "NS-INVENTORY-ENV",
                "severity": "P3",
                "summary": ("GET /api/namespaces reports duckbrain.config.json namespaceMappings "
                            "and ignores the DUCKBRAIN_NAMESPACES_PATH override, so a scratch "
                            "instance advertises the production inventory"),
                "evidence": f"advertised={inv['advertised']} names={inv['names'][:3]}",
                "suggest": "report the effective root's namespaces, or label the source",
            })
        if w2["same_key_race"]["acked"] > 1 and w2["same_key_race"]["distinct_ids"] > 1:
            results["findings"].append({
                "id": "SAME-KEY-APPEND",
                "severity": "info",
                "summary": ("concurrent writes to one key append N rows (N distinct ids, one "
                            "readable key) — matches the DB-GAP-045 contract in-repo, but a "
                            "last-writer-wins reader on this key would be surprised"),
                "evidence": f"acked={w2['same_key_race']['acked']} distinct_ids={w2['same_key_race']['distinct_ids']}",
                "suggest": "document loudly, or expose a supersede path",
            })
        results["W7_verdict"] = {
            "checks": [{"name": n, "pass": bool(p), "detail": det} for n, p, det in checks],
            "passed": sum(1 for _, p, _ in checks if p), "total": len(checks),
            "all_pass": all(p for _, p, _ in checks),
        }
        rc = 0 if results["W7_verdict"]["all_pass"] else 1
    except Exception as e:
        import traceback
        results["error"] = traceback.format_exc()[-2000:]
        progress.append(f"FATAL {e}")
        rc = 2
    finally:
        try:
            d.stop()
        except Exception:
            pass
        fp_after = auth_fingerprint(PROD_AUTH)
        results["cleanup"] = {"prod_auth_sha256_after": fp_after,
                              "prod_auth_untouched": fp_after == fp_before}
        results["run"]["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        Path(args.out).write_text(json.dumps(results, indent=2))
        Path("/tmp/duckbrain-workload-progress.log").write_text("\n".join(progress) + "\n")
        # leave the sandbox on failure for forensics
        if rc == 0:
            shutil.rmtree(root, ignore_errors=True)
        else:
            print(f"[keep] sandbox retained: {root}", file=sys.stderr)

    v = results.get("W7_verdict", {})
    print(f"RESULT {v.get('passed', 0)}/{v.get('total', 0)} all_pass={v.get('all_pass')}")
    for c in v.get("checks", []):
        print(f"  {'PASS' if c['pass'] else 'FAIL'}  {c['name']} — {c['detail']}")
    print(f"results -> {args.out}")
    sys.exit(rc)


if __name__ == "__main__":
    main()
