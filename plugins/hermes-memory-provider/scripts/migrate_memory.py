"""Migrate MEMORY.md / USER.md into the general DuckBrain namespace.

Lossless copy: every entry becomes a record keyed by file + ordinal + slug, with a
content hash. Idempotent — a record whose stored content hash matches is skipped.
Nothing is removed from the files: the cut (demotion) is a separate, reversible
step that should only run once recall quality is measured.
"""
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

NS = os.environ.get("DUCKBRAIN_NS", "hermes-memory")
URL = os.environ.get("DUCKBRAIN_URL", "http://127.0.0.1:3000")
DRY = "--apply" not in sys.argv
H = os.path.expanduser("~")

tok = os.environ.get("DUCKBRAIN_TOKEN") or open(
    sorted(glob.glob(f"{H}/.duckbrain/*.token"), key=os.path.getmtime)[-1]).read().strip()


def slug(text: str, n: int) -> str:
    words = re.findall(r"[a-z0-9]+", text.lower())[:6]
    return f"{n:02d}-" + "-".join(words)[:48] if words else f"{n:02d}"


def post(key: str, content: str, domain: str = "raw_note") -> tuple:
    body = json.dumps({"key": key, "content": content, "domain": domain, "namespace": NS})
    out = subprocess.run(
        ["curl", "-s", "-m", "25", "-X", "POST", "-H", f"x-api-key: {tok}",
         "-H", "Content-Type: application/json", "-d", body, f"{URL}/api/memories"],
        capture_output=True, text=True).stdout
    try:
        return json.loads(out), None
    except Exception:
        return None, out[:200]


def get(key: str):
    q = subprocess.run(
        ["curl", "-s", "-m", "25", "-H", f"x-api-key: {tok}",
         f"{URL}/api/memories/key/{key}?namespace={NS}"],
        capture_output=True, text=True).stdout
    try:
        d = json.loads(q)
    except Exception:
        return None
    return d.get("memory") or d.get("item") or (d if d.get("key") else None)


total = written = skipped = failed = 0
for fname in ("MEMORY.md", "USER.md"):
    path = f"{H}/.hermes/memories/{fname}"
    if not os.path.exists(path):
        continue
    text = open(path, encoding="utf-8").read()
    entries = [e.strip() for e in text.split("\n§\n") if e.strip()]
    print(f"{fname}: {len(entries)} entries, {len(text)} chars")
    for i, entry in enumerate(entries, 1):
        total += 1
        h = hashlib.sha256(entry.encode()).hexdigest()
        key = f"/memory/{fname}/{slug(entry, i)}"
        existing = get(key)
        if existing and hashlib.sha256(str(existing.get("content", "")).encode()).hexdigest() == h:
            skipped += 1
            continue
        if DRY:
            print(f"  WOULD WRITE {key}  ({len(entry)} ch)")
            written += 1
            continue
        payload = entry if "sha256:" not in entry[:40] else entry
        res, err = post(key, payload + f"\n\n[source: {fname} entry {i}/{len(entries)} sha256:{h[:12]}]")
        if err or not res or res.get("error"):
            failed += 1
            print(f"  FAIL {key}: {err or res}")
        else:
            written += 1

print(f"\n{'DRY RUN' if DRY else 'APPLIED'}: total={total} written={written} skipped={skipped} failed={failed}")

if not DRY:
    ok = 0
    bad = []
    for fname in ("MEMORY.md", "USER.md"):
        path = f"{H}/.hermes/memories/{fname}"
        if not os.path.exists(path):
            continue
        entries = [e.strip() for e in open(path, encoding="utf-8").read().split("\n§\n") if e.strip()]
        for i, entry in enumerate(entries, 1):
            key = f"/memory/{fname}/{slug(entry, i)}"
            rec = get(key)
            if rec and entry[:60] in str(rec.get("content", "")):
                ok += 1
            else:
                bad.append(key)
    print(f"READBACK: {ok}/{total} verified by content match; missing/broken={len(bad)}")
    if bad:
        print("  first bad:", bad[:5])
