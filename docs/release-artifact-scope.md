# Release artifact scope

What a DuckBrain release cuts, what it deliberately does not, and how to verify
it. Written for RELEASE-2026-10-26-001 (A2) so a release sweep stops guessing
which surfaces are in scope.

## The one action a release performs

Push an **annotated** tag `vX.Y.Z` at a commit that is already on `main` **and
already has a green `CI` push run for that exact commit**. `.github/workflows/release.yml`
verifies that run through the API and then publishes a GitHub Release:

- title `Release vX.Y.Z`
- notes = the `## [X.Y.Z]` section of `CHANGELOG.md` (falls back to the tag name
  when the section is absent)
- the tag must already exist (`--verify-tag`) and the release must not already
  exist — releases are immutable here

Nothing else. There is no build matrix, no artifact upload, no publish token.

## In scope

| Surface | How it is produced | Who |
| --- | --- | --- |
| Git tag `vX.Y.Z` | `git tag -a` on a green-CI `main` commit, pushed | the release operator |
| GitHub Release + notes | `release.yml` -> `gh release create` | CI, on tag push |
| Source tree at the tag | the tag itself (clone and check out) | GitHub |
| Docker image | **built locally / by the operator** from `Dockerfile` (`node:22-slim`, entrypoint `bin/duckbrain.ts`, default `http --port=3000 --bind-all`) | operator |

## Out of scope — do not do these

- **No npm publish.** The package is named `duckbrain` and declares a `bin`, so
  a stray `npm publish` would succeed and squat the name. Releases are cut from
  the tag; the CLI is run from source (`node --import tsx bin/duckbrain.ts`) or
  from the Docker image. If a publish policy is ever wanted, it is a separate
  decision with its own row — it is not part of a release cut.
- **No container-registry push.** No workflow pushes to ghcr.io or Docker Hub,
  and no image reference is published by a release. If an image is needed, the
  operator builds `Dockerfile` and distributes it explicitly.
- **No tag moves.** A bad release gets a NEW tag. `v1.1.0` stays at `6def80e0`
  (verify: `git ls-remote origin refs/tags/v1.1.0`); re-tagging a published or
  even unpublished version destroys the audit trail that makes a release
  meaningful.
- **No re-running the suite on the tag.** See the header of `release.yml`: the
  tree is identical to the green `main` commit, and re-running it on a detached
  ref only adds a second chance to fail on timing.

## Cut checklist

1. `git log -1 origin/main` — note the SHA you intend to tag.
2. `gh run list --commit <SHA> --workflow CI` — the push-to-main run must be
   `success`. If it is red, the release does not start.
3. `CHANGELOG.md` has a `## [X.Y.Z] - YYYY-MM-DD` section covering the range.
   `package.json` `version` matches it (the version-prep commit does both).
4. `git -c core.hooksPath=<repo hooks> tag -a vX.Y.Z -m "DuckBrain vX.Y.Z" <SHA>`
   then `git push origin vX.Y.Z`.
5. `gh release view vX.Y.Z` — confirm the notes are the CHANGELOG section.
6. `git ls-remote origin refs/tags/v1.1.0` — confirm the previous tag did not
   move.

## Verification of this repair

- `release.yml` no longer runs `pnpm test:run` (the v1.1.0 tag run
  39539627477 failure point) and no longer uses the archived
  `actions/create-release@v1`.
- It refuses to publish when the exact commit has no green `CI` push run, so a
  release cannot be cut from an untested commit.
