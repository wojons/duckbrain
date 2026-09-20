/**
 * OPS-012 — in-daemon duplicate-bundle self-heal for the s3 autopush path.
 *
 * Production bug (verified live 2026-09-20): a namespace repo with TWO bundles
 * under `refs/heads/<branch>/` on its git-remote-s3 remote kills every push
 * with `error: dst refspec refs/heads/<branch> matches more than one`, and
 * the git-history mirror freezes while the native layer keeps syncing. The
 * repair (quarantine + prune) previously existed ONLY in the daily push
 * script `scripts/s3/duckbrain-s3-push.sh` (repair_duplicate_bundles, lines
 * 213-314), which runs at most once per 24h — while the layer that RACES is
 * the in-daemon autopush (src/git/autocommit.ts pushNamespaceAsync). This
 * module ports the repair into the daemon so the layer that races is the
 * layer that heals.
 *
 * The port is FAITHFUL to the bash semantics:
 *   - list `*.bundle` objects under `<keyPrefix>/refs/heads/<branch>/`,
 *     EXCLUDING keys containing `PROTECTED#`, `LOCK#`, `.zip`, `/LOCKS/`, or
 *     ending `.lock`;
 *   - 0 or 1 bundle → nothing to repair;
 *   - keeper = the bundle whose sha (basename minus `.bundle`) equals the
 *     LOCAL branch tip; if none matches, the newest by LastModified; if no
 *     keeper can be identified, abort WITHOUT deleting anything;
 *   - each stale bundle is skipped (left alone) when its sha is NOT a commit
 *     in the local repo (`git cat-file -e <sha>^{commit}`);
 *   - quarantine = server-side copy to `quarantine/git/<ns>/<branch>/<sha>.bundle`
 *     AT THE BUCKET ROOT (not under the key prefix), then a HeadObject size
 *     check — the original is deleted ONLY when the copy's size equals the
 *     source size;
 *   - re-list afterwards and log when the count is not exactly 1;
 *   - best-effort: every failure is a log line, never a throw.
 */

import { execFile } from "child_process";
import path from "path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface S3RemoteUrl {
  bucket: string;
  keyPrefix: string;
}

/**
 * Parse a git remote URL of the live form `s3://<bucket>/<key/prefix>`
 * (verified: `s3://duckbrain/current/git/scheduler` → bucket `duckbrain`,
 * key prefix `current/git/scheduler`). Returns null for non-`s3://` URLs —
 * the repair is a no-op for every other transport.
 */
export function parseS3RemoteUrl(url: string): S3RemoteUrl | null {
  if (!url.startsWith("s3://")) return null;
  const rest = url.slice("s3://".length).replace(/\/+$/, "");
  if (!rest) return null;
  const slash = rest.indexOf("/");
  if (slash === -1) return { bucket: rest, keyPrefix: "" };
  return { bucket: rest.slice(0, slash), keyPrefix: rest.slice(slash + 1) };
}

/**
 * True when a git push failure carries the duplicate-ref signature
 * (`error: dst refspec refs/heads/<branch> matches more than one`) — the
 * only push failure this self-heal acts on.
 */
export function isDuplicateRefPushError(message: string): boolean {
  return message.includes("matches more than one");
}

/** A `*.bundle` object under the ref prefix, kept with its LastModified. */
export interface RefBundle {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface RepairResult {
  /** Bundles seen under the ref prefix; -1 when the list itself failed. */
  scanned: number;
  /** Stale bundles quarantined AND deleted. */
  quarantined: number;
  /** Stale bundles left alone (sha not a local commit). */
  skipped: number;
  /** Bundles under the ref prefix after repair; -1 when unknown. */
  remaining: number;
}

export interface RepairParams {
  client: S3Client;
  bucket: string;
  keyPrefix: string;
  branch: string;
  /** Local branch tip sha — the source of truth for keeper selection. */
  localTip: string;
  /**
   * Namespace directory (the quarantine key uses its basename, and the
   * DEFAULT hasCommit runs `git cat-file` in it). Passing a bare name is
   * fine when hasCommit is injected.
   */
  namespace: string;
  /** Injected in tests; defaults to `git cat-file -e <sha>^{commit}`. */
  hasCommit?: (sha: string) => Promise<boolean>;
  /** Log sink; defaults to console.warn with the [Git] prefix. */
  log?: (line: string) => void;
}

/** The bash filter, verbatim: which keys count as repairable bundles. */
export function isRepairableBundleKey(key: string): boolean {
  return (
    key.endsWith(".bundle") &&
    !key.includes("PROTECTED#") &&
    !key.includes("LOCK#") &&
    !key.includes(".zip") &&
    !key.includes("/LOCKS/") &&
    !key.endsWith(".lock")
  );
}

/** sha of a bundle key: basename minus the `.bundle` suffix. */
function bundleSha(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  return base.replace(/\.bundle$/, "");
}

/**
 * Default hasCommit: `git cat-file -e <sha>^{commit}` in the namespace dir
 * via execFile — no shell, so the sha is passed as argv and needs no
 * quoting. Any failure (not a commit, not a repo, git missing) is `false`.
 */
export function defaultHasCommit(
  namespaceDir: string,
): (sha: string) => Promise<boolean> {
  return (sha: string) =>
    new Promise((resolve) => {
      execFile(
        "git",
        ["cat-file", "-e", `${sha}^{commit}`],
        { cwd: namespaceDir },
        (error) => {
          resolve(!error);
        },
      );
    });
}

/** Paginated list of repairable bundles under the ref prefix. */
async function listRefBundles(
  client: S3Client,
  bucket: string,
  refPrefix: string,
): Promise<RefBundle[]> {
  const out: RefBundle[] = [];
  let token: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: refPrefix,
        ContinuationToken: token,
      }),
    );
    for (const o of resp.Contents ?? []) {
      if (!o.Key || !isRepairableBundleKey(o.Key)) continue;
      out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
    }
    token = resp.NextContinuationToken;
  } while (token);
  return out;
}

/**
 * The faithful port of `repair_duplicate_bundles`. NEVER throws: each step
 * is individually caught, logged, and the repair continues or returns.
 */
export async function repairDuplicateRefBundles(
  params: RepairParams,
): Promise<RepairResult> {
  const log =
    params.log ?? ((line: string): void => console.warn(`[Git] ${line}`));
  const nsName =
    path.basename(params.namespace.replace(/\/+$/, "")) || params.namespace;
  const hasCommit = params.hasCommit ?? defaultHasCommit(params.namespace);
  const refPrefix = params.keyPrefix
    ? `${params.keyPrefix}/refs/heads/${params.branch}/`
    : `refs/heads/${params.branch}/`;

  let bundles: RefBundle[];
  try {
    bundles = await listRefBundles(params.client, params.bucket, refPrefix);
  } catch (error) {
    log(
      `repair ${nsName}: list failed for ${refPrefix} (${(error as Error).message}) — continuing`,
    );
    return { scanned: -1, quarantined: 0, skipped: 0, remaining: -1 };
  }

  const scanned = bundles.length;
  if (scanned <= 1) {
    // 0 or 1 bundle → nothing to repair.
    return { scanned, quarantined: 0, skipped: 0, remaining: scanned };
  }

  // Keeper = the bundle whose sha IS the local branch tip; if none matches,
  // the newest by LastModified. Never prune without an identified keeper —
  // that would delete the ref.
  let keeper: RefBundle | null = null;
  for (const b of bundles) {
    if (bundleSha(b.key) === params.localTip) keeper = b;
  }
  if (!keeper) {
    for (const b of bundles) {
      if (!b.lastModified) continue;
      if (
        !keeper ||
        !keeper.lastModified ||
        b.lastModified > keeper.lastModified
      ) {
        keeper = b;
      }
    }
    if (keeper) {
      log(
        `repair ${nsName}: no bundle matches the local tip ${params.localTip.slice(0, 12)} under ${refPrefix} — keeping the newest (${path.basename(keeper.key)})`,
      );
    }
  }
  if (!keeper) {
    log(
      `repair ${nsName}: could not identify a keeper under ${refPrefix} — nothing deleted`,
    );
    return { scanned, quarantined: 0, skipped: 0, remaining: scanned };
  }

  let quarantined = 0;
  let skipped = 0;
  for (const stale of bundles) {
    if (stale.key === keeper.key) continue;
    const sha = bundleSha(stale.key);

    // A stale bundle whose sha is NOT a commit in the local repo is left
    // alone — the local repo cannot vouch for it.
    let inRepo = false;
    try {
      inRepo = await hasCommit(sha);
    } catch {
      inRepo = false;
    }
    if (!inRepo) {
      skipped++;
      log(
        `repair-skip ${nsName}: stale bundle ${sha} under ${refPrefix} is NOT in the local repo — left alone`,
      );
      continue;
    }

    // Quarantine AT THE BUCKET ROOT (not under the key prefix).
    const qkey = `quarantine/git/${nsName}/${params.branch}/${sha}.bundle`;
    try {
      await params.client.send(
        new CopyObjectCommand({
          Bucket: params.bucket,
          Key: qkey,
          CopySource: encodeURIComponent(`${params.bucket}/${stale.key}`),
        }),
      );
    } catch (error) {
      log(
        `repair ${nsName}: quarantine copy failed for ${sha} (${(error as Error).message}) — continuing, original kept`,
      );
      continue;
    }

    let qsize: number | undefined;
    try {
      const head = await params.client.send(
        new HeadObjectCommand({ Bucket: params.bucket, Key: qkey }),
      );
      qsize = head.ContentLength;
    } catch {
      qsize = undefined;
    }
    if (qsize === undefined || qsize !== stale.size) {
      log(
        `repair ${nsName}: quarantine size mismatch for ${sha} (source=${stale.size} copy=${qsize ?? "?"}) — original NOT deleted`,
      );
      continue;
    }

    try {
      await params.client.send(
        new DeleteObjectCommand({ Bucket: params.bucket, Key: stale.key }),
      );
    } catch (error) {
      log(
        `repair ${nsName}: delete failed for ${sha} (quarantine copy kept) — continuing (${(error as Error).message})`,
      );
      continue;
    }
    quarantined++;
  }
  if (quarantined > 0) {
    log(
      `repair ${nsName}: quarantined ${quarantined} duplicate bundle(s) under ${refPrefix}`,
    );
  }

  // Assert exactly one bundle survives; if not, say so honestly and let the
  // retried push fail again — we do not fabricate success.
  let remaining = scanned - quarantined;
  try {
    remaining = (await listRefBundles(params.client, params.bucket, refPrefix))
      .length;
    if (remaining !== 1) {
      log(
        `repair ${nsName}: still ${remaining} bundles after repair (${refPrefix})`,
      );
    }
  } catch {
    log(
      `repair ${nsName}: re-verify list failed for ${refPrefix} (continuing)`,
    );
  }
  return { scanned, quarantined, skipped, remaining };
}

/**
 * Small orchestrator the autocommit wiring calls on a duplicate-ref push
 * failure: run the repair (bounded, never throwing), then retry the push
 * EXACTLY ONCE. Returns true when the retried push succeeded.
 */
export async function repairAndRetryPushOnDuplicate(
  params: RepairParams & { push: () => Promise<unknown> },
): Promise<boolean> {
  const log =
    params.log ?? ((line: string): void => console.warn(`[Git] ${line}`));
  try {
    await repairDuplicateRefBundles(params);
  } catch (error) {
    // repairDuplicateRefBundles is built never to throw — belt-and-braces so
    // a repair failure still falls through to the single retry.
    log(
      `repair ${params.namespace}: unexpected repair failure (${(error as Error).message}) — continuing to retry`,
    );
  }
  try {
    await params.push();
    return true;
  } catch (error) {
    log(
      `push retry after duplicate-bundle repair failed for ${params.namespace}: ${(error as Error).message}`,
    );
    return false;
  }
}
