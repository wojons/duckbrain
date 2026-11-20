# Installing the DuckBrain systemd assets

There is no install *script* in this repo (nothing under `scripts/` or
`ops/` copies unit files, and `node bin/duckbrain.js service install` writes
its own generated `duckbrain.service`, NOT these assets). The install path for
this directory is the `cp` recipe documented in
[`docs/guide/deployment.md`](../../docs/guide/deployment.md) § *Hardened
Lifecycle Assets (OPS-001)* — that recipe is the authoritative one and must
stay in step with this file.

## Copy the files, including the drop-in directory

`duckbrain-http.service.d/` is a **drop-in directory**: systemd reads
`<unit>.service.d/*.conf` in addition to the base unit. A recursive copy is
required — a plain `cp ops/systemd/*.service ops/systemd/*.timer <dir>` ships
the base unit but silently drops `10-restart-brake.conf`, which re-creates the
OPS-015 defect (an unbraked 3s crash loop on the 10s default start-limit
window).

```bash
# From the repo root. USER units (recommended for dev hosts).
mkdir -p ~/.config/systemd/user
cp -r ops/systemd/duckbrain-http.service \
      ops/systemd/duckbrain-http.service.d \
      ops/systemd/duckbrain-http-health.service \
      ops/systemd/duckbrain-http-health.timer \
      ops/systemd/duckbrain-http-recover.service \
      ops/systemd/duckbrain-http-recover.timer \
      ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now duckbrain-http.service
systemctl --user enable --now duckbrain-http-health.timer
systemctl --user enable --now duckbrain-http-recover.timer
```

System-wide variant: substitute `/etc/systemd/system` for
`~/.config/systemd/user`, add `User=`/`Group=`, and use `sudo systemctl`
without `--user`.

## Verify the brake landed in the effective unit

`StartLimit*` keys are accepted **only** in a `[Unit]` section (systemd >=230).
If they sit in `[Service]` they are ignored and the journal logs
`Unknown key StartLimitIntervalSec in section [Service]` on reload.

```bash
systemctl --user show duckbrain-http -p StartLimitIntervalUSec -p StartLimitBurst
# StartLimitIntervalUSec=5min
# StartLimitBurst=10
journalctl --user -u duckbrain-http --since "-10 min" | grep -i "Unknown key StartLimit"
# (no output = the keys were parsed in a valid section)
```

`5min` is what `StartLimitIntervalSec=300` must resolve to; `Restart=always` /
`RestartSec=3` stay in the base unit's `[Service]` where they belong.
