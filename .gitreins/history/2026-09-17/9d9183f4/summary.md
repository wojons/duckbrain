# Verdict: DOGFOOD-0904-03

**Task:** Fresh-user install path: README + getting-started document node>=22/pnpm prerequisites and a copy-paste quickstart smoke
**Evaluated:** 2026-09-17T07:12:15.166606
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m2:07AM[0m [32mINF[0m [1mscanned ~9324721 bytes (9.32 MB) in 1.7s[0m
[90m2:07AM[0m [32mI
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  132 passed (132)
      Tests  1122 passed (1122)

- ✓ **tier2**
  - COMPLETE
  ✓ AC-1 README carries a Prerequisites block before Installation naming Node >= 22 (nvm one-liner + distro alternative), pnpm (corepack enable / npm i -g pnpm), and git; AC-2 README + docs/guide/getting-started.md carry a copy-paste smoke that starts the HTTP daemon, curls /health, creates a scratch namespace, writes a memory and reads it back, with real commands that run in order; AC-3 the fresh-host setup steps measured on a bare Debian box (global git identity, git-remote-s3+awscli venv for the S3 tier, sshpass for the integration suite) are folded in and labelled by feature; AC-4 getting-started prerequisites say Node 22+, consistent with package.json engines >=22; AC-5 documented commands verified by the foreman on a scratch daemon: AC-1: README.md:29 '## Quick Start' > :31 '### Installation' > :33 '#### Prerequisites' (before the install commands at :53-63). Names git, Node.js 22+, pnpm 11+; nvm one-liner (curl .../nvm/v0.40.7/install.sh | bash; nvm install 22 && nvm use 22); distro alternative ('or install from nodejs.org / your distro's packages'); pnpm via 'corepack enable && corepack prepare pnpm@11 --activate' with fallback 'npm i -g pnpm'; git named. AC-2: README.md:65-88 '### Verify the install' and docs/guide/getting-started.md:57-85 carry the identical 5-step copy-paste smoke — (1) pnpm start http --port=3000 &, (2) curl /health, (3) POST /api/namespaces {"name":"quickstart"}, (4) POST /api/memories?namespace=quickstart {"key":"/quickstart/hello","domain":"concept","content":"first memory from the quickstart"}, (5) GET /api/memories/key/quickstart/hello?namespace=quickstart — in runnable order. AC-3: docs/guide/getting-started.md:114 '## Optional extras (fresh hosts)' with feature-labelled subsections: '### Global git identity (required by the git-backed memory store)' (git config --global user.name/user.email), '### S3 storage tier (only if you enable s3.enabled)' (python3 -m venv ~/.venvs/duckbrain-s3; pip install git-remote-s3 awscli; export PATH), '### Running the test suites' (pnpm test:integration needs sshpass; apt install sshpass on Debian/Ubuntu); README.md:51 summarizes all three labelled by feature. AC-4: docs/guide/getting-started.md:18 '**Node.js** 22+ (required by `package.json` `engines`: `>=22`)' matches package.json engines.node '>=22'. AC-5: live scratch-daemon run — node bin/duckbrain.js http --port=3999 returned /health {"status":"healthy",...}; POST /api/namespaces -> {"name":"quickstart","path":"namespaces/quickstart","isDefault":false}; POST /api/memories -> 201 {"key":"/quickstart/hello","content":"first memory from the quickstart"}; GET /api/memories/key/quickstart/hello -> {"key":"/quickstart/hello","content":"first memory from the quickstart"}. Test suite: `npx vitest run` (guards.test_command) -> 'Test Files 132 passed (132) / Tests 1122 passed (1122)' EXIT=0.
All five criteria pass: README/getting-started document Node 22+/pnpm/git prerequisites, the 5-step copy-paste smoke runs successfully end-to-end on a live scratch daemon, fresh-host extras are folded in and feature-labelled, and the full vitest suite is green (132 files / 1122 tests, exit 0).

## Summary

Judge Result: DOGFOOD-0904-03

Stage tier1: PASS
    ✓ secrets: [90m2:07AM[0m [32mINF[0m [1mscanned ~9324721 bytes (9.32 MB) in 1.7s[0m
[90m2:07AM[0m [32mI
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  132 passed (132)
      Tests  1122 passed (1122)


Stage tier2: PASS
  COMPLETE
  ✓ AC-1 README carries a Prerequisites block before Installation naming Node >= 22 (nvm one-liner + distro alternative), pnpm (corepack enable / npm i -g pnpm), and git; AC-2 README + docs/guide/getting-started.md carry a copy-paste smoke that starts the HTTP daemon, curls /health, creates a scratch namespace, writes a memory and reads it back, with real commands that run in order; AC-3 the fresh-host setup steps measured on a bare Debian box (global git identity, git-remote-s3+awscli venv for the S3 tier, sshpass for the integration suite) are folded in and labelled by feature; AC-4 getting-started prerequisites say Node 22+, consistent with package.json engines >=22; AC-5 documented commands verified by the foreman on a scratch daemon: AC-1: README.md:29 '## Quick Start' > :31 '### Installation' > :33 '#### Prerequisites' (before the install commands at :53-63). Names git, Node.js 22+, pnpm 11+; nvm one-liner (curl .../nvm/v0.40.7/install.sh | bash; nvm install 22 && nvm use 22); distro alternative ('or install from nodejs.org / your distro's packages'); pnpm via 'corepack enable && corepack prepare pnpm@11 --activate' with fallback 'npm i -g pnpm'; git named. AC-2: README.md:65-88 '### Verify the install' and docs/guide/getting-started.md:57-85 carry the identical 5-step copy-paste smoke — (1) pnpm start http --port=3000 &, (2) curl /health, (3) POST /api/namespaces {"name":"quickstart"}, (4) POST /api/memories?namespace=quickstart {"key":"/quickstart/hello","domain":"concept","content":"first memory from the quickstart"}, (5) GET /api/memories/key/quickstart/hello?namespace=quickstart — in runnable order. AC-3: docs/guide/getting-started.md:114 '## Optional extras (fresh hosts)' with feature-labelled subsections: '### Global git identity (required by the git-backed memory store)' (git config --global user.name/user.email), '### S3 storage tier (only if you enable s3.enabled)' (python3 -m venv ~/.venvs/duckbrain-s3; pip install git-remote-s3 awscli; export PATH), '### Running the test suites' (pnpm test:integration needs sshpass; apt install sshpass on Debian/Ubuntu); README.md:51 summarizes all three labelled by feature. AC-4: docs/guide/getting-started.md:18 '**Node.js** 22+ (required by `package.json` `engines`: `>=22`)' matches package.json engines.node '>=22'. AC-5: live scratch-daemon run — node bin/duckbrain.js http --port=3999 returned /health {"status":"healthy",...}; POST /api/namespaces -> {"name":"quickstart","path":"namespaces/quickstart","isDefault":false}; POST /api/memories -> 201 {"key":"/quickstart/hello","content":"first memory from the quickstart"}; GET /api/memories/key/quickstart/hello -> {"key":"/quickstart/hello","content":"first memory from the quickstart"}. Test suite: `npx vitest run` (guards.test_command) -> 'Test Files 132 passed (132) / Tests 1122 passed (1122)' EXIT=0.
All five criteria pass: README/getting-started document Node 22+/pnpm/git prerequisites, the 5-step copy-paste smoke runs successfully end-to-end on a live scratch daemon, fresh-host extras are folded in and feature-labelled, and the full vitest suite is green (132 files / 1122 tests, exit 0).

Overall: PASS ✓
