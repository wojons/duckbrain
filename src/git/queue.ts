/**
 * Git Operation Queue
 */

import { Mutex } from 'async-mutex';

export enum GitOperationType {
  COMMIT = 'commit',
  ADD = 'add'
}

export interface GitOperation {
  type: GitOperationType;
  files?: string[];
  message?: string;
}

export class GitQueue {
  private queue: GitOperation[] = [];
  private mutex = new Mutex();

  async enqueue(operation: GitOperation): Promise<any> {
    await this.mutex.runExclusive(() => {
      this.queue.push(operation);
    });
    return Promise.resolve();
  }

  async dequeue(): Promise<GitOperation | undefined> {
    return this.mutex.runExclusive(() => {
      if (this.queue.length === 0) return undefined;
      return this.queue.shift();
    });
  }

  async length(): Promise<number> {
    return this.mutex.runExclusive(() => this.queue.length);
  }

  async isEmpty(): Promise<boolean> {
    return this.mutex.runExclusive(() => this.queue.length === 0);
  }

  async clear(): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.queue = [];
    });
  }
}

export const gitQueue = new GitQueue();
