# Verdict: EMB-BOOT-001

**Task:** Embedding model boot-durability: auto-load text-embedding-qwen3-embedding-0.6b on LM Studio service start
**Evaluated:** 2026-08-27T11:51:27.057517
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m6:50AM[0m [32mINF[0m [1mscanned ~12044282 bytes (12.04 MB) in 5.29s[0m
[90m6:50AM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  99 passed (99)
      Tests  843 passed (843)
   S
- ✓ **tier2**
  - COMPLETE
  ✓ lmstudio-server.service unit contains an ExecStartPost loader (or equivalent) that runs lms load text-embedding-qwen3-embedding-0.6b after boot; after the lmstudio user service is cycled (stop then start), lms ps shows the embedding model loaded WITHOUT manual lms load; duckbrain /health at 127.0.0.1:3000 reports embedding.healthy=true: ops/lmstudio-server.service (matches deployed /home/kara/.config/systemd/user/lmstudio-server.service, diff=UNITS MATCH) contains ExecStartPost=/bin/bash -c 'for i in $(seq 1 30); do /home/kara/.lmstudio/bin/lms load text-embedding-qwen3-embedding-0.6b >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1'. Cycled service (systemctl --user stop then start): ExecStartPost re-ran with status=0/SUCCESS; lms ps shows text-embedding-qwen3-embedding-0.6b IDLE (639.15 MB) WITHOUT manual lms load; curl http://127.0.0.1:3000/health returns embedding.healthy=True (provider lmstudio, model text-embedding-qwen3-embedding-0.6b).
The lmstudio-server.service unit contains the required ExecStartPost loader that auto-loads text-embedding-qwen3-embedding-0.6b after boot; verified by cycling the service and confirming lms ps shows the model loaded and /health reports embedding.healthy=true.

## Summary

Judge Result: EMB-BOOT-001

Stage tier1: PASS
    ✓ secrets: [90m6:50AM[0m [32mINF[0m [1mscanned ~12044282 bytes (12.04 MB) in 5.29s[0m
[90m6:50AM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  99 passed (99)
      Tests  843 passed (843)
   S

Stage tier2: PASS
  COMPLETE
  ✓ lmstudio-server.service unit contains an ExecStartPost loader (or equivalent) that runs lms load text-embedding-qwen3-embedding-0.6b after boot; after the lmstudio user service is cycled (stop then start), lms ps shows the embedding model loaded WITHOUT manual lms load; duckbrain /health at 127.0.0.1:3000 reports embedding.healthy=true: ops/lmstudio-server.service (matches deployed /home/kara/.config/systemd/user/lmstudio-server.service, diff=UNITS MATCH) contains ExecStartPost=/bin/bash -c 'for i in $(seq 1 30); do /home/kara/.lmstudio/bin/lms load text-embedding-qwen3-embedding-0.6b >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1'. Cycled service (systemctl --user stop then start): ExecStartPost re-ran with status=0/SUCCESS; lms ps shows text-embedding-qwen3-embedding-0.6b IDLE (639.15 MB) WITHOUT manual lms load; curl http://127.0.0.1:3000/health returns embedding.healthy=True (provider lmstudio, model text-embedding-qwen3-embedding-0.6b).
The lmstudio-server.service unit contains the required ExecStartPost loader that auto-loads text-embedding-qwen3-embedding-0.6b after boot; verified by cycling the service and confirming lms ps shows the model loaded and /health reports embedding.healthy=true.

Overall: PASS ✓
