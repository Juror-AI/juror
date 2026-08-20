import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { callQaRpc, startQaRpcServer, type QaRpcResponse } from '../src/qa/rpc.js';

const temporaryDirectories = new Set<string>();

function socketPath(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'juror-qa-rpc-'));
  temporaryDirectories.add(directory);
  return { directory, path: join(directory, 'broker.sock') };
}

function rawRequest(path: string, chunks: string[]): Promise<QaRpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      for (const chunk of chunks) socket.write(chunk);
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(response.slice(0, newline)) as QaRpcResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!response.includes('\n')) reject(new Error('RPC socket closed without a framed response'));
    });
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('QA Unix-socket RPC', () => {
  it('uses owner-only socket permissions and round-trips one framed request', async () => {
    const socket = socketPath();
    const handler = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    const rpc = await startQaRpcServer(socket.path, handler);
    try {
      expect(statSync(socket.path).mode & 0o777).toBe(0o600);
      await expect(callQaRpc(socket.path, 'snapshot', { scenario: 'one' })).resolves.toEqual({
        method: 'snapshot',
        params: { scenario: 'one' },
      });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await rpc.close();
    }
    expect(() => statSync(socket.path)).toThrow();
  });

  it('accepts a newline frame split across chunks and ignores a second frame', async () => {
    const socket = socketPath();
    const handler = vi.fn(async (method: string) => `handled:${method}`);
    const rpc = await startQaRpcServer(socket.path, handler);
    try {
      const response = await rawRequest(socket.path, [
        '{"id":"split","method":"qa_',
        'status","params":{}}\n{"id":"second","method":"finish","params":{}}\n',
      ]);
      expect(response).toEqual({ id: 'split', result: 'handled:qa_status' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('qa_status', {});
    } finally {
      await rpc.close();
    }
  });

  it('returns framed errors for malformed, oversized, and handler-failed requests', async () => {
    const socket = socketPath();
    const rpc = await startQaRpcServer(socket.path, async (method) => {
      if (method === 'explode') throw new Error('trusted handler failed');
      return null;
    });
    try {
      await expect(rawRequest(socket.path, ['not-json\n'])).resolves.toMatchObject({
        id: 'unknown',
        error: expect.stringContaining('Unexpected token'),
      });
      await expect(rawRequest(socket.path, [
        `${JSON.stringify({ id: 'large', method: 'qa_status', params: 'x'.repeat(2 * 1024 * 1024) })}\n`,
      ])).resolves.toEqual({
        id: 'unknown',
        error: 'RPC request exceeded the size limit',
      });
      await expect(callQaRpc(socket.path, 'explode', {})).rejects.toThrow(
        'trusted handler failed',
      );
      await expect(callQaRpc(socket.path, 'after-error', {})).resolves.toBeNull();
    } finally {
      await rpc.close();
    }
  });

  it('serializes concurrent requests across independent socket connections', async () => {
    const socket = socketPath();
    let releaseFirst: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const rpc = await startQaRpcServer(socket.path, async (method) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      order.push(`start:${method}`);
      if (method === 'first') {
        signalStarted?.();
        await firstGate;
      }
      order.push(`finish:${method}`);
      active--;
      return method;
    });
    try {
      const first = callQaRpc(socket.path, 'first', {});
      await firstStarted;
      const second = callQaRpc(socket.path, 'second', {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual(['start:first']);
      releaseFirst?.();
      await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
      expect(maximumActive).toBe(1);
      expect(order).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second']);
    } finally {
      releaseFirst?.();
      await rpc.close();
    }
  });

  it('does not resolve close until every admitted handler has drained', async () => {
    const socket = socketPath();
    let releaseFirst: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const rpc = await startQaRpcServer(socket.path, async (method) => {
      order.push(`start:${method}`);
      if (method === 'first') {
        signalStarted?.();
        await firstGate;
      }
      order.push(`finish:${method}`);
      return method;
    });

    const first = callQaRpc(socket.path, 'first', {});
    await firstStarted;
    const second = callQaRpc(socket.path, 'second', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closing = rpc.close().then(() => { order.push('closed'); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['start:first']);

    releaseFirst?.();
    await expect(Promise.all([first, second, closing])).resolves.toEqual([
      'first',
      'second',
      undefined,
    ]);
    expect(order).toEqual([
      'start:first',
      'finish:first',
      'start:second',
      'finish:second',
      'closed',
    ]);
  });

  it('interrupts the active handler and cancels queued calls during cancellation close', async () => {
    const socket = socketPath();
    let signalStarted: (() => void) | undefined;
    let interruptActive: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const active = new Promise<never>((_resolve, reject) => {
      interruptActive = () => reject(new Error('active browser operation interrupted'));
    });
    const handled: string[] = [];
    const rpc = await startQaRpcServer(socket.path, async (method) => {
      handled.push(method);
      if (method === 'first') {
        signalStarted?.();
        await active;
      }
      return method;
    });

    const first = callQaRpc(socket.path, 'first', {}).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await firstStarted;
    const second = callQaRpc(socket.path, 'second', {}).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    await rpc.close({
      cancelPending: true,
      beforeDrain: async () => interruptActive?.(),
      timeoutMs: 1_000,
    });

    expect(handled).toEqual(['first']);
    expect(await first).toContain('closed before replying');
    expect(await second).toContain('closed before replying');
    expect(() => statSync(socket.path)).toThrow();
  });

  it('bounds cancellation cleanup when an active handler cannot be interrupted', async () => {
    const socket = socketPath();
    let signalStarted: (() => void) | undefined;
    let releaseHandler: (() => void) | undefined;
    let signalFinished: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const finished = new Promise<void>((resolve) => { signalFinished = resolve; });
    const rpc = await startQaRpcServer(socket.path, async () => {
      signalStarted?.();
      await handlerGate;
      signalFinished?.();
      return null;
    });
    const caller = callQaRpc(socket.path, 'stuck', {}).catch(() => undefined);
    await started;

    const startedAt = Date.now();
    await expect(rpc.close({ cancelPending: true, timeoutMs: 40 })).rejects.toThrow(
      'cancellation cleanup timed out',
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    releaseHandler?.();
    await finished;
    await caller;
    expect(() => statSync(socket.path)).toThrow();
  });
});
