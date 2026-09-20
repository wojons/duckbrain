#!/usr/bin/env python3
"""Render the DuckBrain WORKLOAD results into a single self-contained HTML report.

Unlike the earlier surface report (one call per endpoint), this one answers the
question Bane actually asked: does the end-to-end system hand a real workload?
"""
import html
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/db-workload-final.json")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/home/kara/duckbrain-workload-report/index.html")
REPO = Path("/home/kara/duckbrain")

r = json.loads(SRC.read_text())
run = r.get("run", {})
boot = r.get("W0_boot", {})
w1 = r.get("W1_sustained", {})
w2 = r.get("W2_concurrent", {})
w3 = r.get("W3_accumulation", {})
w4 = r.get("W4_mixed", {})
w5 = r.get("W5_pipeline", {})
w6 = r.get("W6_kill9", {})
v = r.get("W7_verdict", {})
findings = r.get("findings", [])

head_sha = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True).stdout.strip()
head_subj = subprocess.run(["git", "-C", str(REPO), "log", "-1", "--format=%s"],
                           capture_output=True, text=True).stdout.strip()
branch = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--abbrev-ref", "HEAD"],
                        capture_output=True, text=True).stdout.strip()

E = html.escape


def esc(v):
    return E(str(v))


def card(label, value, sub="", ok=None):
    cls = "card" + (" good" if ok is True else " bad" if ok is False else "")
    return (f'<div class="{cls}"><div class="cv">{esc(value)}</div>'
            f'<div class="cl">{esc(label)}</div>{f"<div class=cs>{esc(sub)}</div>" if sub else ""}</div>')


def rows(pairs):
    out = []
    for k, val, extra in pairs:
        out.append(f"<tr><td class=k>{esc(k)}</td><td class=v>{esc(val)}</td>"
                   f"<td class=x>{esc(extra)}</td></tr>")
    return "\n".join(out)


lat = w1.get("latency_ms", {})
slat = w4.get("structural_read_latency_ms", {})
wlat = w4.get("write_latency_ms", {})
race = w2.get("same_key_race", {})
kw = w4.get("keyword_reads", {})
passed = v.get("passed", 0)
total = v.get("total", 0)
allpass = v.get("all_pass")

checks_html = "\n".join(
    f'<li class="chk {"ok" if c["pass"] else "no"}">'
    f'<span class="mark">{"PASS" if c["pass"] else "FAIL"}</span>'
    f'<span class="cname">{esc(c["name"])}</span>'
    f'<span class="cdet">{esc(c["detail"])}</span></li>'
    for c in v.get("checks", [])
)

find_html = ""
for f in findings:
    find_html += f"""
    <div class="finding sev-{esc(f.get('severity','info').lower())}">
      <div class="fhead"><span class="fid">{esc(f.get('id'))}</span>
        <span class="fsev">{esc(f.get('severity','info'))}</span></div>
      <p class="fsum">{esc(f.get('summary'))}</p>
      <p class="fev"><b>Evidence:</b> <code>{esc(f.get('evidence'))}</code></p>
      <p class="fsg"><b>Suggested:</b> {esc(f.get('suggest'))}</p>
    </div>"""

kw_codes = ", ".join(f"{k}→{n}" for k, n in (kw.get("codes") or {}).items())

html_doc = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DuckBrain — workload test pass</title>
<style>
:root{{--bg:#0f1115;--panel:#181b21;--panel2:#1f232b;--line:#2b303a;--fg:#e6e8ec;
--dim:#9aa3b2;--good:#3ddc84;--bad:#ff6b6b;--warn:#ffc857;--accent:#6ea8ff}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}}
.wrap{{max-width:1080px;margin:0 auto;padding:32px 20px 80px}}
h1{{font-size:29px;margin:0 0 6px}}
h2{{font-size:19px;margin:38px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}}
h3{{font-size:15px;margin:22px 0 8px;color:var(--accent)}}
.sub{{color:var(--dim);font-size:13.5px;margin-bottom:20px}}
.banner{{padding:18px 20px;border-radius:11px;margin:18px 0 26px;
border:1px solid var(--line);background:var(--panel)}}
.banner.good{{border-color:#1f5c3a;background:linear-gradient(180deg,#12271c,#141a18)}}
.banner.bad{{border-color:#6b2b2b;background:linear-gradient(180deg,#2a1416,#1a1414)}}
.btitle{{font-size:19px;font-weight:650;margin-bottom:4px}}
.bsub{{color:var(--dim);font-size:13.5px}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:11px;margin:16px 0}}
.card{{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}}
.card.good{{border-color:#1f5c3a}} .card.bad{{border-color:#6b2b2b}}
.cv{{font-size:23px;font-weight:660;line-height:1.2}}
.cl{{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-top:5px}}
.cs{{font-size:12px;color:var(--dim);margin-top:4px}}
table{{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}}
th,td{{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}}
th{{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}}
td.k{{color:var(--dim);width:34%}} td.v{{font-weight:600}} td.x{{color:var(--dim);font-size:12.5px}}
ul.checks{{list-style:none;padding:0;margin:10px 0}}
li.chk{{display:flex;gap:11px;padding:8px 11px;border-radius:8px;margin-bottom:5px;
background:var(--panel);border:1px solid var(--line);align-items:baseline}}
li.chk.no{{border-color:#6b2b2b;background:#221517}}
.mark{{font-size:11px;font-weight:700;letter-spacing:.05em;min-width:44px;
color:var(--good)}} li.chk.no .mark{{color:var(--bad)}}
.cname{{flex:1}} .cdet{{color:var(--dim);font-size:12.5px;text-align:right}}
.finding{{border:1px solid var(--line);border-left-width:3px;border-radius:9px;
padding:13px 15px;margin:11px 0;background:var(--panel)}}
.finding.sev-p2{{border-left-color:var(--warn)}} .finding.sev-p3{{border-left-color:var(--accent)}}
.finding.sev-info{{border-left-color:#5a6472}}
.fhead{{display:flex;gap:9px;align-items:center;margin-bottom:6px}}
.fid{{font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
.fsev{{font-size:10.5px;padding:2px 7px;border-radius:20px;background:var(--panel2);
color:var(--dim);letter-spacing:.05em}}
.fsum{{margin:5px 0}} .fev,.fsg{{margin:5px 0;font-size:13px;color:var(--dim)}}
code{{background:var(--panel2);padding:2px 6px;border-radius:5px;font-size:12.5px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}}
.meta{{color:var(--dim);font-size:12.5px;margin-top:26px;padding-top:14px;border-top:1px solid var(--line)}}
.pill{{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11.5px;
background:var(--panel2);color:var(--dim);margin-right:6px}}
.note{{font-size:13.5px;color:var(--dim);font-style:italic}}
</style></head><body><div class="wrap">

<h1>DuckBrain — workload test pass</h1>
<div class="sub">
Does the end-to-end system hand an actual workload — sustained volume, concurrent writers,
accumulation integrity, mixed read/write, kill&nbsp;-9 durability, and the full
HTTP → JSONL → git → DuckDB → clone chain? Every number below is from live HTTP calls
against a scratch daemon; nothing is simulated.
</div>

<div class="banner {'good' if allpass else 'bad'}">
  <div class="btitle">{'All gates passed' if allpass else 'Gates: ' + str(passed) + '/' + str(total)}</div>
  <div class="bsub">
    {esc(w1.get('acked',0))} writes ACKed at {esc(w1.get('throughput_wps','?'))} wps ·
    peak {esc(w1.get('concurrency','?'))} concurrent clients ·
    {esc(w3.get('distinct_keys_readable','?'))} keys readable ·
    {esc(w6.get('acked_lost','?'))} ACKed writes lost across <code>kill -9</code> ·
    head <code>{esc(head_sha)}</code>
  </div>
</div>

<h2>The headline numbers</h2>
<div class="cards">
{card("writes/sec sustained", w1.get("throughput_wps", "—"), f"@ {w1.get('concurrency','?')} concurrent", ok=(w1.get("throughput_wps",0) or 0) >= 100)}
{card("writes ACKed", f"{w1.get('acked',0)}/{w1.get('writes_attempted',0)}", "HTTP 201", ok=w1.get("errors",1)==0)}
{card("write p95", f"{lat.get('p95','—')} ms", f"p50 {lat.get('p50','—')} ms", ok=None)}
{card("read p95 under load", f"{slat.get('p95','—')} ms", f"p50 {slat.get('p50','—')} ms", ok=None)}
{card("ACKed writes lost", w6.get("acked_lost", "—"), f"of {w6.get('acked_before_kill',0)} ACKed before kill -9", ok=w6.get("acked_lost",1)==0)}
{card("keys readable", w3.get("distinct_keys_readable", "—"), f"API total {w3.get('api_reported_total','?')}", ok=None)}
{card("git commits", w3.get("git_commits", "—"), "namespace auto-commit", ok=(w3.get("git_commits") or 0) > 0)}
{card("gates", f"{passed}/{total}", "end-to-end checks", ok=allpass)}
</div>

<h2>Phase by phase</h2>

<h3>W1 — sustained writes</h3>
<table><tr><th>Metric</th><th>Value</th><th>Notes</th></tr>
{rows([
 ("writes attempted / ACKed", f"{w1.get('writes_attempted')} / {w1.get('acked')}", f"{w1.get('errors')} errors"),
 ("throughput", f"{w1.get('throughput_wps')} writes/sec", f"wall {w1.get('wall_s')}s at {w1.get('concurrency')} concurrent clients"),
 ("latency p50 / p95 / p99", f"{lat.get('p50')} / {lat.get('p95')} / {lat.get('p99')} ms", f"mean {lat.get('mean')} ms, max {lat.get('max')} ms"),
 ("rate-limiter sheds", w1.get("rate_limited_retries"), "requests the token bucket deferred and the client retried"),
])}</table>

<h3>W2 — concurrent independent writers</h3>
<table><tr><th>Metric</th><th>Value</th><th>Notes</th></tr>
{rows([
 ("clients x writes each", f"{w2.get('clients')} x {w2.get('per_client')}", "barrier-synchronised start"),
 ("writes ACKed", w2.get("acked"), f"{w2.get('errors')} errors"),
 ("throughput", f"{w2.get('throughput_wps')} writes/sec", f"wall {w2.get('wall_s')}s"),
 ("same-key race", f"{race.get('acked')} ACKs → {race.get('distinct_ids')} distinct rows", f"last writer id present; survives = row count, per DB-GAP-045"),
])}</table>

<h3>W3 — accumulation integrity</h3>
<table><tr><th>Metric</th><th>Value</th><th>Notes</th></tr>
{rows([
 ("ACKed keys", w3.get("acked_unique_keys"), "distinct keys the server confirmed"),
 ("keys readable", w3.get("distinct_keys_readable"), f"swept in {w3.get('sweep_pages')} page(s) — limit caps at 1000/request"),
 ("ACKed writes lost", w3.get("missing_acked"), "every confirmed write must read back"),
 ("duplicate keys", w3.get("duplicate_key_count"), f"{', '.join(w3.get('duplicate_keys',[])) or 'none'}"),
 ("on disk", f"{w3.get('disk_jsonl_lines')} JSONL lines", f"across {w3.get('disk_jsonl_files')} files"),
 ("git history", f"{w3.get('git_commits')} commits", "index the transport, not the durability mechanism"),
])}</table>

<h3>W4 — mixed read/write under load ({w4.get('seconds')}s, {w4.get('concurrency')} threads)</h3>
<table><tr><th>Class</th><th>Throughput</th><th>Latency p50 / p95 / p99</th><th>Errors</th></tr>
<tr><td class=k>writes</td><td class=v>{w4.get('write_wps')}/s</td>
<td class=x>{wlat.get('p50')} / {wlat.get('p95')} / {wlat.get('p99')} ms</td>
<td class=x>{w4.get('write_errors')}</td></tr>
<tr><td class=k>structural reads</td><td class=v>{w4.get('structural_read_rps')}/s</td>
<td class=x>{slat.get('p50')} / {slat.get('p95')} / {slat.get('p99')} ms</td>
<td class=x>{w4.get('structural_read_errors')}</td></tr>
<tr><td class=k>keyword search (?contains=)</td><td class=v>{kw.get('ok',0)} ok</td>
<td class=x>—</td><td class=x>{kw.get('errors',0)} (codes {esc(kw_codes)})</td></tr>
</table>
<p class="note">Structural reads are prefix / attribute / offset-page / domain / bare list.
Keyword search is scored separately because it needs the FTS sidecar — see the findings.</p>

<h3>W5 — the full pipeline (HTTP → disk → DuckDB → git clone)</h3>
<table><tr><th>Leg</th><th>Result</th><th>Detail</th></tr>
{rows([
 ("HTTP write", w5.get("http_write",{}).get("code"), f"id {w5.get('http_write',{}).get('id')}"),
 ("landed as JSONL on disk", w5.get("disk_jsonl_grep",{}).get("found"), ", ".join(w5.get("disk_jsonl_grep",{}).get("files",[]))),
 ("readable back over HTTP", ", ".join(w5.get("http_readback",{}).get("keys",[])) or "—", f"code {w5.get('http_readback',{}).get('code')}"),
 ("DuckDB SQL over the JSONL", w5.get("duckdb_sql",{}).get("rows"), w5.get("duckdb_sql",{}).get("query")),
 ("reached git HEAD", w5.get("commit_transport",{}).get("marker_in_head"), "commit transport (debounced)"),
 ("git clone contains it", w5.get("git_clone",{}).get("marker_found"), str(w5.get("git_clone",{}).get("files",""))),
])}</table>

<h3>W6 — <code>kill -9</code> durability</h3>
<table><tr><th>Metric</th><th>Value</th><th>Notes</th></tr>
{rows([
 ("writes ACKed before kill", w6.get("acked_before_kill"), f"killed after {w6.get('killed_after_s')}s at {w6.get('writes_attempted')} attempted"),
 ("present after restart", w6.get("present_after_restart"), "same data dir, fresh process"),
 ("ACKed writes lost", w6.get("acked_lost"), f"{', '.join(w6.get('lost_samples',[])) or 'none'}"),
 ("in-flight writes that errored", w6.get("errors"), "writes cut off by the kill — never ACKed, so not owed"),
])}</table>

<h2>Every gate, pass or fail</h2>
<ul class="checks">
{checks_html}
</ul>

<h2>Findings</h2>
{find_html or '<p class="note">None.</p>'}

<div class="meta">
<span class="pill">branch {esc(branch)}</span>
<span class="pill">head <code>{esc(head_sha)}</code></span>
<span class="pill">durability {esc(run.get('durability','fsync'))}</span>
<span class="pill">rate-limit {esc(run.get('rate_limit_per_min','?'))}/min</span>
<span class="pill">source {esc(SRC)}</span><br><br>
{esc(head_subj)}<br>
Run {esc(run.get('started'))} → {esc(run.get('finished'))} · sandbox {esc(run.get('root'))}<br>
Production auth store {esc('untouched' if r.get('cleanup',{}).get('prod_auth_untouched') else 'CHANGED — investigate')}
(<code>{esc(str(r.get('cleanup',{}).get('prod_auth_sha256_after'))[:16])}…</code>)<br>
Rendered {esc(datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC'))}
</div>
</div></body></html>"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(html_doc)
print(f"wrote {OUT} ({len(html_doc)} bytes)")
print(f"gates {passed}/{total} all_pass={allpass} findings={len(findings)}")
