/**
 * DB-SUPA-5 change-feed hub.
 *
 * One `NamespaceFeed` per subscribed namespace. A subscriber only ever sees
 * COMMITTED changes: the feed observes the namespace repository's reachable
 * first-parent HEAD (never a debounce timer), derives each new commit's
 * accepted change records from the parent→child audit-ledger diff, and fans
 * them out in committed order.
 *
 * Reservation protocol (the commit-race guard): under a per-namespace feed
 * lock the feed captures HEAD, replays any requested cursor through that head,
 * registers the subscriber, and then delivers later heads in order — so a
 * commit that lands between replay and registration cannot be missed and
 * cannot be delivered twice.
 *
 * Delivery is at-least-once. Consumers deduplicate by `cursor` (or
 * `position.commit` + `position.ordinal`) and apply rows idempotently by
 * declared key; the service never promises exactly-once delivery, global
 * ordering, or delivery after a client loses its cursor.
 */

import fs from "fs";
import path from "path";
import type { AuthPrincipal } from "../../auth/middleware";
import { authorizeTableAccess } from "../../auth/roles";
import { getConfig } from "../../config";
import {
  commitExists,
  commitTimeIso,
  firstParentCommitsAfter,
  firstParentWindow,
  isAncestor,
  resolveHeadSha,
} from "../../git/ledger";
import { ChangelogCorruptError } from "../../serialization/auditLedger";
import type { ChangeOperation } from "../../serialization/changeRecord";
import { setCommitNotifier } from "../../serialization/namespaceWriter";
import {
  decodeCursor,
  encodeCursor,
  RealtimeError,
  type DecodedCursor,
} from "./cursor";
import { deriveCommitChanges, type DerivedChange } from "./replay";
import {
  HEARTBEAT_FRAME,
  changeFrame,
  overflowFrame,
  readyFrame,
  revokedFrame,
  type ChangeEventV1,
} from "./wire";

/** Server-side response sink. `write` returning false means backpressure. */
export interface SseSink {
  write(chunk: string): boolean;
  /** Register a one-shot drain listener (called again per block). */
  onDrain(listener: () => void): void;
  end(): void;
}

/** The default sink: an Express response with real socket backpressure. */
export function createHttpSseSink(res: {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  end(): unknown;
}): SseSink {
  return {
    write: (chunk) => res.write(chunk),
    onDrain: (listener) => {
      res.once("drain", listener);
    },
    end: () => {
      try {
        res.end();
      } catch {
        // Client already gone — closing twice is not an error.
      }
    },
  };
}

interface Frame {
  text: string;
  bytes: number;
  /** Cursor of a delivered change event; null for heartbeats. */
  cursor: string | null;
}

interface Subscriber {
  id: number;
  ns: string;
  principal: AuthPrincipal | undefined;
  tables: string[];
  ops: ChangeOperation[];
  sink: SseSink;
  queue: Frame[];
  queueBytes: number;
  blocked: boolean;
  closed: boolean;
  heartbeat: NodeJS.Timeout | null;
  lastDeliveredCursor: string | null;
  deliveredFrames: number;
  onClose?: () => void;
}

interface FeedState {
  ns: string;
  repoDir: string;
  subscribers: Set<Subscriber>;
  /** Last commit whose accepted changes were delivered to this feed's subs. */
  lastDeliveredCommit: string | null;
  timer: NodeJS.Timeout | null;
  lock: Promise<void>;
}

export interface RealtimeHubOptions {
  namespacesPath?: string;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  maxSubscribers?: number;
  maxQueueEvents?: number;
  maxQueueBytes?: number;
  maxReplayEvents?: number;
  maxReplayCommits?: number;
  retentionDays?: number;
  log?: (message: string) => void;
}

export interface SubscribeRequest {
  ns: string;
  principal: AuthPrincipal | undefined;
  /** Resolved, already-authorized table allow-list. */
  tables: string[];
  /** Requested operations (all three when the client sent no `ops`). */
  ops: ChangeOperation[];
  /** Raw cursor (already unwrapped from `cursor` / `Last-Event-ID`). */
  cursor: string | null;
  sink: SseSink;
  onClose?: () => void;
}

export interface Subscription {
  close(): void;
  readonly closed: boolean;
}

export class RealtimeHub {
  private readonly namespacesPath: string;
  private readonly pollIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly maxSubscribers: number;
  private readonly maxQueueEvents: number;
  private readonly maxQueueBytes: number;
  private readonly maxReplayEvents: number;
  private readonly maxReplayCommits: number;
  private readonly retentionDays: number;
  private readonly log: (message: string) => void;
  private readonly feeds = new Map<string, FeedState>();
  private nextSubscriberId = 1;

  constructor(options: RealtimeHubOptions = {}) {
    const config = getConfig(".");
    this.namespacesPath = path.resolve(
      options.namespacesPath ?? config.namespacesPath,
    );
    this.pollIntervalMs =
      options.pollIntervalMs ?? config.realtime.pollIntervalMs;
    this.heartbeatMs = options.heartbeatMs ?? config.realtime.heartbeatMs;
    this.maxSubscribers =
      options.maxSubscribers ?? config.realtime.maxSubscribers;
    this.maxQueueEvents =
      options.maxQueueEvents ?? config.realtime.maxQueueEvents;
    this.maxQueueBytes = options.maxQueueBytes ?? config.realtime.maxQueueBytes;
    this.maxReplayEvents =
      options.maxReplayEvents ?? config.realtime.maxReplayEvents;
    this.maxReplayCommits =
      options.maxReplayCommits ?? config.realtime.maxReplayCommits;
    this.retentionDays = options.retentionDays ?? config.realtime.retentionDays;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** Total live subscribers across every namespace feed. */
  get subscriberCount(): number {
    let total = 0;
    for (const feed of this.feeds.values()) total += feed.subscribers.size;
    return total;
  }

  /** Live subscribers for one namespace. */
  countFor(namespace: string): number {
    return this.feeds.get(namespace)?.subscribers.size ?? 0;
  }

  /** Namespaces with an active feed (timer/queue state). */
  get namespaceCount(): number {
    return this.feeds.size;
  }

  /** Namespace directory the hub serves (config-derived, injectable in tests). */
  namespaceDir(namespace: string): string {
    return path.join(this.namespacesPath, namespace);
  }

  /**
   * Validate a subscription request completely, replay any requested cursor,
   * and only then write the SSE response. `writeHeaders` runs after every
   * failure mode has been ruled out, so a rejected request never produces a
   * partial event stream.
   */
  async subscribe(
    request: SubscribeRequest,
    writeHeaders: () => void,
  ): Promise<Subscription> {
    const repoDir = this.namespaceDir(request.ns);
    if (!fs.existsSync(repoDir)) {
      throw new RealtimeError(
        "NOT_FOUND",
        `Namespace '${request.ns}' not found`,
      );
    }
    if (this.subscriberCount >= this.maxSubscribers) {
      throw new RealtimeError(
        "SUBSCRIBER_LIMIT",
        `realtime subscriber limit (${this.maxSubscribers}) reached`,
      );
    }

    const feed = this.feedFor(request.ns, repoDir);
    let subscriber: Subscriber | null = null;

    await this.runLocked(feed, async () => {
      const head = resolveHeadSha(repoDir);
      const boundary =
        request.cursor === null
          ? null
          : this.validateCursor(feed, repoDir, request.cursor, head);

      // A newer subscriber joining a live feed replays through the commit the
      // feed has already delivered and lets the live path cover the remainder
      // — no duplicates, no gap.
      const replayThrough =
        feed.subscribers.size > 0 ? feed.lastDeliveredCommit : head;

      const replayFrames: string[] = [];
      if (boundary !== null) {
        if (replayThrough === null) {
          throw this.cursorGone(
            `cursor references commit ${boundary.commit}, which is not in retained history`,
          );
        }
        if (
          boundary.commit !== replayThrough &&
          !isAncestor(repoDir, boundary.commit, replayThrough)
        ) {
          throw new RealtimeError(
            "INVALID_CURSOR",
            "cursor position is not reachable from the current committed history",
          );
        }
        const anchor = deriveCommitChanges(repoDir, boundary.commit, {
          ns: request.ns,
          namespacePath: repoDir,
        });
        if (boundary.ordinal > anchor.length) {
          throw new RealtimeError(
            "INVALID_CURSOR",
            `cursor ordinal ${boundary.ordinal} does not name a committed change record`,
          );
        }
        for (const change of anchor) {
          if (change.ordinal > boundary.ordinal) {
            replayFrames.push(changeFrame(this.eventFor(request.ns, change)));
          }
        }
        for (const commit of firstParentCommitsAfter(
          repoDir,
          boundary.commit,
          replayThrough,
        )) {
          for (const change of deriveCommitChanges(repoDir, commit, {
            ns: request.ns,
            namespacePath: repoDir,
          })) {
            replayFrames.push(changeFrame(this.eventFor(request.ns, change)));
          }
        }
        if (replayFrames.length > this.maxReplayEvents) {
          throw this.cursorGone(
            `cursor replay would deliver ${replayFrames.length} events, above the ` +
              `configured maximum of ${this.maxReplayEvents}`,
          );
        }
      }

      // HEAD's own position is reported by the ready control event only after
      // its commit validated, so a corrupt head fails closed before any byte.
      const headCursor =
        head === null ? null : this.headCursor(request.ns, repoDir, head);

      const created = this.createSubscriber(request);
      subscriber = created;
      writeHeaders();
      this.enqueueFrame(created, {
        text: readyFrame(request.ns, headCursor),
        bytes: Buffer.byteLength(readyFrame(request.ns, headCursor)),
        cursor: null,
      });
      for (const text of replayFrames) {
        this.enqueueFrame(created, {
          text,
          bytes: Buffer.byteLength(text),
          cursor: frameCursor(text),
        });
      }
      feed.subscribers.add(created);
      if (feed.subscribers.size === 1) {
        feed.lastDeliveredCommit = head;
        this.startTimer(feed);
      }
      if (created.closed) feed.subscribers.delete(created);
    });

    const attached = subscriber as Subscriber | null;
    if (attached === null || attached.closed) {
      throw new RealtimeError(
        "SUBSCRIBER_LIMIT",
        "subscription was closed before it attached",
      );
    }
    void this.check(request.ns);
    return {
      close: () => this.removeSubscriber(feed, attached),
      get closed() {
        return attached.closed;
      },
    };
  }

  /** Deliver any committed changes the feed has not yet published. */
  async check(namespace: string): Promise<void> {
    const feed = this.feeds.get(namespace);
    if (!feed) return;
    await this.runLocked(feed, async () => {
      if (feed.subscribers.size === 0) return;
      const head = resolveHeadSha(feed.repoDir);
      if (head === null || head === feed.lastDeliveredCommit) return;
      if (
        feed.lastDeliveredCommit !== null &&
        !isAncestor(feed.repoDir, feed.lastDeliveredCommit, head)
      ) {
        // History rewrite (squash/compaction). The feed never invents positions
        // from rewritten history: it re-anchors on the new head.
        this.log(
          `[realtime] namespace '${namespace}' first-parent history was rewritten; ` +
            `re-anchoring the change feed on ${head}`,
        );
        feed.lastDeliveredCommit = head;
        return;
      }
      const commits = firstParentCommitsAfter(
        feed.repoDir,
        feed.lastDeliveredCommit,
        head,
      );
      let delivered = 0;
      try {
        for (const commit of commits) {
          const changes = deriveCommitChanges(feed.repoDir, commit, {
            ns: namespace,
            namespacePath: feed.repoDir,
          });
          this.deliver(feed, changes);
          feed.lastDeliveredCommit = commit;
          delivered += changes.length;
          if (delivered > this.maxReplayEvents) break;
        }
      } catch (error) {
        if (error instanceof ChangelogCorruptError) {
          this.log(
            `[realtime] ${error.message}${
              error.detail.path
                ? ` (path ${error.detail.path}${
                    error.detail.line !== undefined
                      ? `:${error.detail.line}`
                      : ""
                  }, commit ${error.detail.commit})`
                : ""
            }`,
          );
          this.closeFeed(feed);
          return;
        }
        throw error;
      }
    });
  }

  /** Immediate check triggered by the serializer's post-flush notifier. */
  wake(namespace: string): void {
    if (!this.feeds.has(namespace)) return;
    void this.check(namespace).catch((error) => {
      this.log(
        `[realtime] wake check for '${namespace}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  /** Close every subscription (server shutdown, tests). */
  closeAll(): void {
    for (const feed of [...this.feeds.values()]) this.closeFeed(feed);
    for (const feed of [...this.feeds.values()]) {
      if (feed.timer) clearInterval(feed.timer);
      feed.timer = null;
    }
    this.feeds.clear();
  }

  /** Serialize work per namespace feed (the commit-race guard). */
  private runLocked<T>(feed: FeedState, work: () => Promise<T>): Promise<T> {
    const run = feed.lock.then(work, work);
    feed.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private feedFor(namespace: string, repoDir: string): FeedState {
    let feed = this.feeds.get(namespace);
    if (!feed) {
      feed = {
        ns: namespace,
        repoDir,
        subscribers: new Set(),
        lastDeliveredCommit: null,
        timer: null,
        lock: Promise.resolve(),
      };
      this.feeds.set(namespace, feed);
    }
    return feed;
  }

  private startTimer(feed: FeedState): void {
    if (feed.timer || this.pollIntervalMs <= 0) return;
    feed.timer = setInterval(() => {
      void this.check(feed.ns).catch((error) => {
        this.log(
          `[realtime] poll for '${feed.ns}' failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, this.pollIntervalMs);
    if (typeof feed.timer.unref === "function") feed.timer.unref();
  }

  private createSubscriber(request: SubscribeRequest): Subscriber {
    const subscriber: Subscriber = {
      id: this.nextSubscriberId++,
      ns: request.ns,
      principal: request.principal,
      tables: [...request.tables],
      ops: [...request.ops],
      sink: request.sink,
      queue: [],
      queueBytes: 0,
      blocked: false,
      closed: false,
      heartbeat: null,
      lastDeliveredCursor: null,
      deliveredFrames: 0,
      onClose: request.onClose,
    };
    if (this.heartbeatMs > 0) {
      subscriber.heartbeat = setInterval(() => {
        this.heartbeat(subscriber);
      }, this.heartbeatMs);
      if (typeof subscriber.heartbeat.unref === "function") {
        subscriber.heartbeat.unref();
      }
    }
    return subscriber;
  }

  private heartbeat(subscriber: Subscriber): void {
    // Only when the subscriber is keeping up: a pending queue or a blocked
    // socket means the client has not read what it already has.
    if (
      subscriber.closed ||
      subscriber.blocked ||
      subscriber.queue.length > 0
    ) {
      return;
    }
    try {
      subscriber.sink.write(HEARTBEAT_FRAME);
    } catch {
      this.removeSubscriberById(subscriber);
    }
  }

  private enqueueFrame(subscriber: Subscriber, frame: Frame): void {
    if (subscriber.closed) return;
    if (
      subscriber.queue.length + 1 > this.maxQueueEvents ||
      subscriber.queueBytes + frame.bytes > this.maxQueueBytes
    ) {
      this.overflow(subscriber);
      return;
    }
    subscriber.queue.push(frame);
    subscriber.queueBytes += frame.bytes;
    this.pump(subscriber);
  }

  private pump(subscriber: Subscriber): void {
    if (subscriber.closed || subscriber.blocked) return;
    while (subscriber.queue.length > 0 && !subscriber.closed) {
      const frame = subscriber.queue[0];
      let accepted: boolean;
      try {
        accepted = subscriber.sink.write(frame.text);
      } catch {
        this.removeSubscriberById(subscriber);
        return;
      }
      subscriber.queue.shift();
      subscriber.queueBytes -= frame.bytes;
      subscriber.deliveredFrames += 1;
      if (frame.cursor !== null) subscriber.lastDeliveredCursor = frame.cursor;
      if (!accepted) {
        subscriber.blocked = true;
        try {
          subscriber.sink.onDrain(() => {
            subscriber.blocked = false;
            this.pump(subscriber);
          });
        } catch {
          this.removeSubscriberById(subscriber);
          return;
        }
        return;
      }
    }
  }

  private overflow(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.queue = [];
    subscriber.queueBytes = 0;
    try {
      subscriber.sink.write(
        overflowFrame(subscriber.ns, subscriber.lastDeliveredCursor),
      );
    } catch {
      // The sink is already gone; the close below is still correct.
    }
    try {
      subscriber.sink.end();
    } catch {
      // Idempotent close.
    }
    this.removeSubscriberById(subscriber);
  }

  private revoke(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.queue = [];
    subscriber.queueBytes = 0;
    try {
      subscriber.sink.write(revokedFrame(subscriber.ns));
    } catch {
      // Ignore a dead sink.
    }
    try {
      subscriber.sink.end();
    } catch {
      // Idempotent close.
    }
    this.removeSubscriberById(subscriber);
  }

  private removeSubscriberById(subscriber: Subscriber): void {
    const feed = this.feeds.get(subscriber.ns);
    if (!feed) return;
    this.removeSubscriber(feed, subscriber);
  }

  private removeSubscriber(feed: FeedState, subscriber: Subscriber): void {
    subscriber.closed = true;
    subscriber.queue = [];
    subscriber.queueBytes = 0;
    if (subscriber.heartbeat) {
      clearInterval(subscriber.heartbeat);
      subscriber.heartbeat = null;
    }
    const removed = feed.subscribers.delete(subscriber);
    if (feed.subscribers.size === 0 && feed.timer) {
      clearInterval(feed.timer);
      feed.timer = null;
    }
    if (removed) subscriber.onClose?.();
  }

  private closeFeed(feed: FeedState): void {
    for (const subscriber of [...feed.subscribers]) {
      subscriber.closed = true;
      subscriber.queue = [];
      subscriber.queueBytes = 0;
      if (subscriber.heartbeat) {
        clearInterval(subscriber.heartbeat);
        subscriber.heartbeat = null;
      }
      try {
        subscriber.sink.end();
      } catch {
        // Idempotent close.
      }
      feed.subscribers.delete(subscriber);
      subscriber.onClose?.();
    }
    if (feed.timer) {
      clearInterval(feed.timer);
      feed.timer = null;
    }
  }

  private deliver(feed: FeedState, changes: DerivedChange[]): void {
    for (const change of changes) {
      if (feed.subscribers.size === 0) return;
      const event = this.eventFor(feed.ns, change);
      const text = changeFrame(event);
      const frame: Frame = {
        text,
        bytes: Buffer.byteLength(text),
        cursor: event.cursor,
      };
      for (const subscriber of [...feed.subscribers]) {
        if (subscriber.closed) continue;
        if (!subscriber.tables.includes(change.record.table)) continue;
        if (!subscriber.ops.includes(change.record.op)) continue;
        const decision = authorizeTableAccess(
          subscriber.principal,
          feed.ns,
          change.record.table,
          "read",
        );
        if (!decision.allowed) {
          // Authorization is re-checked before every live enqueue: a revoked
          // grant ends the stream instead of leaking queued rows.
          this.revoke(subscriber);
          continue;
        }
        this.enqueueFrame(subscriber, frame);
      }
    }
  }

  private eventFor(namespace: string, change: DerivedChange): ChangeEventV1 {
    return {
      version: 1,
      cursor: encodeCursor(namespace, change.commit, change.ordinal),
      namespace,
      table: change.record.table,
      op: change.record.op,
      row: change.record.row,
      position: { commit: change.commit, ordinal: change.ordinal },
      committedAt: change.committedAt,
      tombstone: change.record.tombstone,
      schemaVersion: change.record.schemaVersion,
      key: change.record.key,
    };
  }

  private headCursor(
    namespace: string,
    repoDir: string,
    head: string,
  ): string | null {
    const changes = deriveCommitChanges(repoDir, head, {
      ns: namespace,
      namespacePath: repoDir,
    });
    if (changes.length === 0) return null;
    const last = changes[changes.length - 1];
    return encodeCursor(namespace, last.commit, last.ordinal);
  }

  private cursorGone(message: string): RealtimeError {
    return new RealtimeError(
      "CHANGE_CURSOR_GONE",
      message,
      "Reconnect without a cursor to perform a full resync.",
    );
  }

  /**
   * Repository-level cursor validation. Format/version/namespace are checked
   * by `decodeCursor`; here the commit must exist in retained first-parent
   * history and the position must be resolvable. Cursor validation grants no
   * access — SUPA-4 authorization filtering still runs before replay.
   */
  private validateCursor(
    feed: FeedState,
    repoDir: string,
    raw: string,
    head: string | null,
  ): DecodedCursor {
    const decoded = decodeCursor(raw);
    if (decoded === null) {
      throw new RealtimeError(
        "INVALID_CURSOR",
        "cursor is not a valid dbch1 cursor",
      );
    }
    if (decoded.ns !== feed.ns) {
      throw new RealtimeError(
        "INVALID_CURSOR",
        `cursor belongs to namespace '${decoded.ns}', not '${feed.ns}'`,
      );
    }
    if (!commitExists(repoDir, decoded.commit)) {
      throw this.cursorGone(
        `commit ${decoded.commit} referenced by the cursor is no longer present`,
      );
    }
    if (head === null) {
      throw this.cursorGone(
        "namespace has no committed history to resume from",
      );
    }
    if (!isAncestor(repoDir, decoded.commit, head)) {
      throw new RealtimeError(
        "INVALID_CURSOR",
        `commit ${decoded.commit} is not reachable from the current HEAD`,
      );
    }
    const window = firstParentWindow(repoDir, head, this.maxReplayCommits);
    if (!window.includes(decoded.commit)) {
      const chain = firstParentWindow(repoDir, head, Number.MAX_SAFE_INTEGER);
      if (!chain.includes(decoded.commit)) {
        throw new RealtimeError(
          "INVALID_CURSOR",
          `commit ${decoded.commit} is not on the first-parent history of HEAD`,
        );
      }
      throw this.cursorGone(
        `commit ${decoded.commit} is older than the retained ` +
          `${this.maxReplayCommits}-commit first-parent window`,
      );
    }
    const committedAt = Date.parse(commitTimeIso(repoDir, decoded.commit));
    if (
      Number.isFinite(committedAt) &&
      Date.now() - committedAt > this.retentionDays * 24 * 60 * 60 * 1000
    ) {
      throw this.cursorGone(
        `commit ${decoded.commit} is older than the retained ${this.retentionDays}-day window`,
      );
    }
    return decoded;
  }
}

/** Extract the `id:` line's cursor from a rendered change frame. */
function frameCursor(frame: string): string | null {
  const match = /^id: (.+)$/m.exec(frame);
  return match ? match[1] : null;
}

let defaultHub: RealtimeHub | null = null;

/**
 * Process-wide hub for the mounted route. Registers the serializer's
 * post-flush notifier seam so a landed debounce commit is published promptly
 * instead of waiting a full poll interval (the feed still confirms every
 * change against a successful reachable HEAD, never a timer).
 */
export function getRealtimeHub(): RealtimeHub {
  if (!defaultHub) {
    defaultHub = new RealtimeHub();
    const hub = defaultHub;
    setCommitNotifier((namespace) => hub.wake(namespace));
  }
  return defaultHub;
}

export function resetRealtimeHubForTests(): void {
  defaultHub?.closeAll();
  defaultHub = null;
  setCommitNotifier(undefined);
}

/** Diagnostics for health/checks (never exposes pending writes as committed). */
export function realtimeDiagnostics(): {
  subscribers: number;
  namespaces: number;
} {
  if (!defaultHub) return { subscribers: 0, namespaces: 0 };
  return {
    subscribers: defaultHub.subscriberCount,
    namespaces: defaultHub.namespaceCount,
  };
}
