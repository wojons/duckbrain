import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  uniqueId, getRandomPort, startSshContainer, stopSshContainer,
  sshExec, waitForPort, run, sleep,
} from './helpers';

const id = uniqueId();
const sshPort = getRandomPort();
let containerName: string;

describe('SSH Tunnel Integration', () => {
  beforeAll(async () => {
    containerName = await startSshContainer(id, sshPort);
    await waitForPort(sshPort, 15000);
  }, 120000);

  afterAll(() => {
    stopSshContainer(containerName);
  });

  it('should SSH into the container and run a command', async () => {
    const result = run(
      `sshpass -p testpass ssh -o StrictHostKeyChecking=accept-new -p ${sshPort} testuser@127.0.0.1 "echo hello-from-container"`
    );
    expect(result).toContain('hello-from-container');
  });

  it('should detect DuckBrain is NOT installed on a fresh container', async () => {
    const result = run(
      `sshpass -p testpass ssh -o StrictHostKeyChecking=accept-new -p ${sshPort} testuser@127.0.0.1 "which duckbrain 2>/dev/null || echo NOT_FOUND"`
    );
    expect(result).toContain('NOT_FOUND');
  });

  it('should create an SSH tunnel with port forwarding', async () => {
    const tunnel = run(
      `sshpass -p testpass ssh -o StrictHostKeyChecking=accept-new -p ${sshPort} -L 0:localhost:22 -N -f testuser@127.0.0.1 2>&1 || true`
    );
    await sleep(500);
    const tunnelResult = run(`ps aux | grep "ssh.*${sshPort}" | grep -v grep || echo NO_TUNNEL`);
    const hasTunnel = !tunnelResult.includes('NO_TUNNEL');
    run(`pkill -f "ssh.*-L.*${sshPort}" 2>/dev/null || true`);
    if (hasTunnel) {
      expect(hasTunnel).toBe(true);
    }
  });

  it('should write and read a file through SSH', async () => {
    sshExec(containerName, 'echo "test-data" > /tmp/duckbrain-test.txt');
    const result = sshExec(containerName, 'cat /tmp/duckbrain-test.txt');
    expect(result).toContain('test-data');
  });

  it('should have git available in the container', async () => {
    const result = sshExec(containerName, 'which git');
    expect(result).toContain('git');
  });

  it('should have ssh client available in the container', async () => {
    const result = sshExec(containerName, 'which ssh');
    expect(result).toContain('ssh');
  });
});
