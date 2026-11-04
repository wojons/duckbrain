# HARDEN-DUCKBRAIN-002 — moving the live data dir out of the git checkout

**Status:** prepared and proven on a copy. The cutover itself is owner-gated
(restarting the production daemon on `:3000`).

## The hazard, measured (not assumed)

```
$ cd /home/kara/duckbrain && git clean -xdn | grep -c 'namespaces/'
292
$ git clean -xdn | wc -l
354
```

`git clean -xdf` in that checkout — a routine "reset the tree" move — would
delete **292 paths under `namespaces/`**, plus `.gitreins/history/`, `.gitreins/logs/`,
`.gitreins/usage.jsonl`, `.coding-hermes/board/board.db` and more. `.gitignore:13`
(`/namespaces/`) protects those files from *commits*, not from `-x`. The live
daemon resolves its namespaces path from its working directory
(`cwd=/home/kara/duckbrain`, no `DUCKBRAIN_NAMESPACES_PATH` in
`/proc/<pid>/environ`), so live memory is inside the tree that every merge,
worker and reset touches.

## Why the data has to move (option "b" is refuted)

The row allowed a cheaper resolution: prove the layout is safe. The transcript
above refutes it — the tree is exactly as exposed as feared. So this is a move,
not a documentation fix.

## What is already done

1. **Full copy taken** to a path outside every checkout:

   ```
   rsync -a /home/kara/duckbrain/namespaces/ /home/kara/.duckbrain-live/namespaces/
   sent 8,164,860,572 bytes · total size 8,122,949,885 · speedup 0.99
   ```

2. **Fidelity checked** — same inventory, byte-identical content on a sample:

   ```
   src dirs=291  copy dirs=291
   src files=499169  copy files=499144     # 25 = files the live daemon wrote DURING the copy
   40 sampled *.jsonl: checked=40 mismatched=0
   ```

3. **The copy proven to serve the fleet's data** — a scratch daemon started with
   `DUCKBRAIN_NAMESPACES_PATH=/home/kara/.duckbrain-live/namespaces` on port
   28555 answered `/health` 200, listed **291 namespaces**, and a real recall
   returned live records (`/project/hermes-dagger/review-2026-11-03`); it wrote
   into **the copy's** read ledger, and the repo checkout's ledger did not grow.

## The drift you must not ignore

The live daemon kept writing during the copy:

```
copy ledger rows = 61,463
repo ledger rows = 61,476
```

13 rows of drift in the audit ledger alone. A cutover that simply repoints the
daemon would silently lose those. Hence the quiesced second pass below.

## Cutover (owner-gated — a restart of the production daemon)

```bash
# 1. stop the production daemon (its own start command, unchanged otherwise)
kill -TERM "$(ss -ltnp | sed -n 's/.*:3000 .*pid=\([0-9]*\).*/\1/p')"
#    wait for the port to close
until ! ss -ltn | grep -q ':3000'; do sleep 1; done

# 2. quiesced delta sync — the only pass that can be complete
rsync -a --delete /home/kara/duckbrain/namespaces/ /home/kara/.duckbrain-live/namespaces/

# 3. restart with the data path NAMED, not inherited
cd /home/kara/duckbrain   # code can stay here; only the data moves
DUCKBRAIN_NAMESPACES_PATH=/home/kara/.duckbrain-live/namespaces \
DUCKBRAIN_DATA_DIR=/home/kara/.duckbrain-live/data \
node bin/duckbrain.js http --port 3000 --bind-all --auth=apikey \
  --rate-limit 600 --unix-socket=/tmp/duckbrain.sock \
  --unix-socket-mode=0660 --unix-socket-group=kara
```

### Acceptance (paste into the row when done)

```bash
curl -s http://127.0.0.1:3000/health | jq -r '.status'          # healthy
curl -s -H "x-api-key: $KEY" http://127.0.0.1:3000/api/namespaces | jq 'length'   # 291
tail -1 /home/kara/.duckbrain-live/namespaces/.duckbrain-audit/reads.jsonl        # a fresh row
wc -l < /home/kara/duckbrain/namespaces/.duckbrain-audit/reads.jsonl              # stops growing
```

Then the repo-safe check that motivated the row:

```bash
cd /home/kara/duckbrain && git clean -xdn | grep -c 'namespaces/'   # must be 0 (or only ignored empties)
```

### Rollback

The old directory is left untouched by `rsync` (it only ever wrote to the new
path). Rollback is: stop the daemon, restart it **without** the two env
variables, and it resolves `./namespaces` again — the original data is still
there, complete, and only 13 ledger rows behind what the copy saw.

### After the move

Keep `/home/kara/duckbrain/namespaces` for one full day, then `rm -rf` it (it is
9.2G of duplicated memory). Do not delete it in the same session as the cutover —
it is the only rollback that exists.
