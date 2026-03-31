/**
 * Git Background Worker
 *
 * Background worker that batches git commits by line count or time interval.
 */

import { GitQueue, GitOperationType } from './queue';
import simpleGit from 'simple-git';

export interface GitWorkerConfig {
  batchLines: number;
  batchIntervalMs: number;
  repoPath: string;
}

const DEFAULT_CONFIG: GitWorkerConfig = {
  batchLines: 100,
  batchIntervalMs: 30000,
  repoPath: process.cwd()
};

interface PendingCommit {
  files: string[];
  lines: number;
  message: string;
}

export class GitWorker {
  private config: GitWorkerConfig;
  private queue: GitQueue;
  private git: any;
  private timer: any = null;
  private pendingCommit: PendingCommit | null = null;
  private running = false;

  constructor(config: Partial<GitWorkerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.queue = new GitQueue();
    this.git = simpleGit(this.config.repoPath);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTimer();
    console.log(`[GitWorker] Started (batchLines=${this.config.batchLines}, batchIntervalMs=${this.config.batchIntervalMs})`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    console.log('[GitWorker] Stopping...');
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flushCommit();
    console.log('[GitWorker] Stopped');
  }

  async add(files: string[], lineCount: number = 0): Promise<void> {
    if (!this.running) {
      await this.git.add(files);
      return;
    }
    await this.queue.enqueue({ type: GitOperationType.ADD, files });
    this.accumulateCommit(files, lineCount, 'chore: batch commit');
  }

  async commit(message: string, files?: string[]): Promise<void> {
    if (!this.running) {
      if (files) await this.git.add(files);
      await this.git.commit(message);
      return;
    }
    await this.queue.enqueue({ type: GitOperationType.COMMIT, files, message });
    await this.flushCommit();
    if (files && files.length > 0) {
      await this.git.add(files);
    }
    await this.git.commit(message);
  }

  private accumulateCommit(files: string[], lineCount: number, message: string): void {
    if (!this.pendingCommit) {
      this.pendingCommit = { files: [...files], lines: lineCount, message };
    } else {
      const existingFiles = new Set(this.pendingCommit.files);
      for (const file of files) {
        if (!existingFiles.has(file)) {
          this.pendingCommit.files.push(file);
          existingFiles.add(file);
        }
      }
      this.pendingCommit.lines += lineCount;
    }
    if (this.pendingCommit.lines >= this.config.batchLines) {
      this.flushCommit();
    }
  }

  private async flushCommit(): Promise<void> {
    if (!this.pendingCommit || this.pendingCommit.files.length === 0) return;
    const { files, message } = this.pendingCommit;
    this.pendingCommit = null;
    try {
      await this.git.add(files);
      await this.git.commit(message);
      console.log(`[GitWorker] Committed ${files.length} files`);
    } catch (error) {
      console.error('[GitWorker] Commit failed:', error);
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      if (this.pendingCommit && this.pendingCommit.files.length > 0) {
        console.log(`[GitWorker] Time-based flush (${this.config.batchIntervalMs}ms elapsed)`);
        this.flushCommit();
      }
    }, this.config.batchIntervalMs);
  }

  configure(config: Partial<GitWorkerConfig>): void {
    this.config = { ...this.config, ...config };
    console.log('[GitWorker] Configuration updated:', config);
    if (config.batchIntervalMs && this.running) {
      if (this.timer) clearInterval(this.timer);
      this.startTimer();
    }
  }

  getConfig(): GitWorkerConfig {
    return { ...this.config };
  }

  getPendingLines(): number {
    return this.pendingCommit?.lines || 0;
  }

  async getQueueLength(): Promise<number> {
    return this.queue.length();
  }
}

let singletonWorker: GitWorker | null = null;

export function getGitWorker(config?: Partial<GitWorkerConfig>): GitWorker {
  if (!singletonWorker) {
    singletonWorker = new GitWorker(config);
  }
  return singletonWorker;
}

export function resetGitWorker(): void {
  if (singletonWorker) {
    singletonWorker.stop();
    singletonWorker = null;
  }
}
