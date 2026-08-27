# Verdict: EMB-BOOT-001

**Task:** Embedding model boot-durability: auto-load text-embedding-qwen3-embedding-0.6b on LM Studio service start
**Evaluated:** 2026-08-27T11:49:56.666142
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: [90m6:48AM[0m [32mINF[0m [1mscanned ~12036401 bytes (12.04 MB) in 5.62s[0m
[90m6:48AM[0m [3
  ✗ tests: 
 RUN  v4.1.10 /home/kara/duckbrain

 ❯ src/cli/http.test.ts (6 tests | 1 failed) 13395ms
     × con
- ✓ **tier2**
  - COMPLETE
  ✓ lmstudio-server.service unit contains an ExecStartPost loader (or equivalent) that runs lms load text-embedding-qwen3-embedding-0.6b after boot; after the lmstudio user service is cycled (stop then start), lms ps shows the embedding model loaded WITHOUT manual lms load; duckbrain /health at 127.0.0.1:3000 reports embedding.healthy=true: ops/lmstudio-server.service contains `ExecStartPost=/bin/bash -c 'for i in $(seq 1 30); do /home/kara/.lmstudio/bin/lms load text-embedding-qwen3-embedding-0.6b >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1'` (retry loop). Runtime-verified: ran `systemctl --user stop` then `start lmstudio-server.service`; ExecStartPost exited status=0/SUCCESS; `lms ps` shows text-embedding-qwen3-embedding-0.6b loaded (3 entries) with NO manual lms load; `curl http://127.0.0.1:3000/health` returns embedding.healthy=true, model=text-embedding-qwen3-embedding-0.6b. Note: ops/lmstudio-server.service is untracked in git (?? ops/) despite docs claiming it is tracked, but the deployed unit at ~/.config/systemd/user/ is active and functional.
The lmstudio-server.service unit contains an ExecStartPost retry loop that auto-loads text-embedding-qwen3-embedding-0.6b; verified by cycling the service and confirming lms ps shows the model loaded without manual load and /health reports embedding.healthy=true.

## Summary

Judge Result: EMB-BOOT-001

Stage tier1: FAIL
    ✓ secrets: [90m6:48AM[0m [32mINF[0m [1mscanned ~12036401 bytes (12.04 MB) in 5.62s[0m
[90m6:48AM[0m [3
  ✗ tests: 
 RUN  v4.1.10 /home/kara/duckbrain

 ❯ src/cli/http.test.ts (6 tests | 1 failed) 13395ms
     × con

Stage tier2: PASS
  COMPLETE
  ✓ lmstudio-server.service unit contains an ExecStartPost loader (or equivalent) that runs lms load text-embedding-qwen3-embedding-0.6b after boot; after the lmstudio user service is cycled (stop then start), lms ps shows the embedding model loaded WITHOUT manual lms load; duckbrain /health at 127.0.0.1:3000 reports embedding.healthy=true: ops/lmstudio-server.service contains `ExecStartPost=/bin/bash -c 'for i in $(seq 1 30); do /home/kara/.lmstudio/bin/lms load text-embedding-qwen3-embedding-0.6b >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1'` (retry loop). Runtime-verified: ran `systemctl --user stop` then `start lmstudio-server.service`; ExecStartPost exited status=0/SUCCESS; `lms ps` shows text-embedding-qwen3-embedding-0.6b loaded (3 entries) with NO manual lms load; `curl http://127.0.0.1:3000/health` returns embedding.healthy=true, model=text-embedding-qwen3-embedding-0.6b. Note: ops/lmstudio-server.service is untracked in git (?? ops/) despite docs claiming it is tracked, but the deployed unit at ~/.config/systemd/user/ is active and functional.
The lmstudio-server.service unit contains an ExecStartPost retry loop that auto-loads text-embedding-qwen3-embedding-0.6b; verified by cycling the service and confirming lms ps shows the model loaded without manual load and /health reports embedding.healthy=true.

Overall: FAIL ✗
