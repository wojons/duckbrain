OPS tick duckbrain-ops-2026-11-10-11-52-30 — HARDEN-DUCKBRAIN-002

Selected row: HARDEN-DUCKBRAIN-002, currently blocked on owner authorization for the production daemon cutover.

Read-only probes and exact observed outputs:

1. Command:
`du -sh namespaces; find namespaces -type f -name '*.jsonl' | wc -l`
Output:
`9.2G namespaces`
`387475`

2. Command:
`du -sh /home/kara/.duckbrain-live/namespaces; find /home/kara/.duckbrain-live/namespaces -type f -name '*.jsonl' | wc -l`
Output:
`9.2G /home/kara/.duckbrain-live/namespaces`
`367428`

3. Command:
`git clean -xdn -- namespaces | wc -l; git clean -xdn -- namespaces | sed -n '1,3p'`
Output:
`319`
`Would skip repository namespaces/axiom`
`Would skip repository namespaces/eduos`
`Would skip repository namespaces/pokemon-global`

4. Command:
`readlink -f /proc/2037161/cwd; tr '\0' ' ' </proc/2037161/cmdline`
Output:
`/home/kara/duckbrain`
`/usr/bin/node bin/duckbrain.js http --port 3000 --bind-all --auth=apikey --rate-limit 600 --unix-socket=/tmp/duckbrain.sock --unix-socket-mode=0660 --unix-socket-group=kara`

5. Command:
`systemctl --user show duckbrain-http.service -p WorkingDirectory -p ExecStart -p MainPID -p SubState`
Output:
`SubState=running`
`MainPID=2037161`
`ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node bin/duckbrain.js http --port 3000 --bind-all --auth=apikey --rate-limit 600 --unix-socket=/tmp/duckbrain.sock --unix-socket-mode=0660 --unix-socket-group=kara ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`
`WorkingDirectory=/home/kara/duckbrain`

6. Command:
`sqlite3 ~/.hermes/scheduler.db "select id||'|'||project_name||'|'||status from ticks where project_name like 'duckbrain%' and status in ('running','started','pending') order by spawned_at desc;"`
Output: empty (no in-flight duckbrain tick at probe time).

7. Command:
`curl -sS -m 10 -w '\nHTTP=%{http_code}\n' http://127.0.0.1:3000/health`
Output:
`{"status":"healthy","uptime":268277.819513799,"timestamp":"2026-11-10T12:42:53.977Z","embedding":{"provider":"openai","model":"qwen/qwen3-embedding-8b","healthy":true,"providers":[{"id":"openai","healthy":true,"note":"ok"}]},"keys_error":null,"durability":{"defaultMode":"buffered","overrides":{}},"deadline_exceeded":[]}`
`HTTP=200`

Interpretation: the production daemon still runs with WorkingDirectory=/home/kara/duckbrain and no explicit DUCKBRAIN_NAMESPACES_PATH or DUCKBRAIN_DATA_DIR in its effective ExecStart. The live namespace tree is therefore still inside the Git checkout, and the dry-run cleanup lists 319 namespace paths. An external copy exists, but it has 367,428 JSONL files versus 387,475 in the live tree; it is not a cutover-ready byte-identical snapshot. No restart, rsync, deletion, service-unit edit, or other mutation was performed. The row remains blocked on the owner-gated cutover and quiesced delta sync.
