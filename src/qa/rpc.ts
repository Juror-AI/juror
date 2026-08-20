/**
 * Tiny local RPC transport between the model-facing MCP adapter and the trusted browser
 * broker. It intentionally supports one request per Unix-socket connection: the protocol
 * stays auditable, a crashed adapter cannot retain privileged state, and no network port is
 * opened on the runner.
 */

import { chmod, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

export interface QaRpcRequest {
  id: string;
  method: string;
  params: unknown;
}

export interface QaRpcResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export type QaRpcHandler = (method: string, params: unknown) => Promise<unknown>;

export interface QaRpcCloseOptions {
  /** Reject already-admitted calls that have not started instead of draining them. */
  cancelPending?: boolean;
  /** Interrupt the one active broker operation before waiting for its queue entry. */
  beforeDrain?: () => Promise<void>;
  /** Bound cancellation cleanup so an outer runner can still persist its report. */
  timeoutMs?: number;
}

export interface QaRpcServer {
  server: Server;
  close: (options?: QaRpcCloseOptions) => Promise<void>;
}

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRequest(line: string): QaRpcRequest {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RPC request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || !record['id']) throw new Error('RPC request needs an id');
  if (typeof record['method'] !== 'string' || !record['method']) {
    throw new Error('RPC request needs a method');
  }
  return { id: record['id'], method: record['method'], params: record['params'] };
}

export async function startQaRpcServer(
  socketPath: string,
  handler: QaRpcHandler,
): Promise<QaRpcServer> {
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });

  // The broker is a state machine, while MCP clients are allowed to issue tool
  // calls concurrently. Keep one global queue across socket connections so two
  // requests cannot both observe and mutate the same pre-await state.
  let queue: Promise<void> = Promise.resolve();
  let closing = false;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let input = '';
    let bytes = 0;
    let handled = false;

    const reply = (response: QaRpcResponse) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_MESSAGE_BYTES) {
        handled = true;
        reply({ id: 'unknown', error: 'RPC request exceeded the size limit' });
        return;
      }
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      let request: QaRpcRequest;
      try {
        request = parseRequest(input.slice(0, newline));
      } catch (error) {
        reply({ id: 'unknown', error: errorMessage(error) });
        return;
      }
      if (closing) {
        reply({ id: request.id, error: 'QA broker is shutting down' });
        return;
      }
      const execution = queue.then(() => {
        if (socket.destroyed) throw new Error('RPC caller disconnected before execution');
        return handler(request.method, request.params);
      });
      queue = execution.then(() => undefined, () => undefined);
      void execution
        .then((result) => reply({ id: request.id, result }))
        .catch((error) => reply({ id: request.id, error: errorMessage(error) }));
    });
    socket.on('error', () => {
      // The caller may disappear after a model timeout. The next connection remains usable.
    });
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  let closePromise: Promise<void> | null = null;

  return {
    server,
    close: (options = {}) => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        // Stop admission first, then wait for every already-admitted handler. A
        // caller may disconnect while queued, so Server.close() alone is not a
        // sufficient lifecycle barrier for the stateful browser broker.
        closing = true;
        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
        });
        const shutdown = (async () => {
          if (options.cancelPending) {
            // Queued executions check socket.destroyed before invoking the handler.
            // Destroying every admitted caller therefore cancels queued work while
            // beforeDrain interrupts the sole handler that may already be running.
            for (const socket of sockets) socket.destroy();
          }
          await options.beforeDrain?.();
          await Promise.all([queue, serverClosed]);
        })();

        let timeout: NodeJS.Timeout | undefined;
        try {
          if (options.timeoutMs === undefined) {
            await shutdown;
          } else {
            await Promise.race([
              shutdown,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () => reject(new Error('QA broker cancellation cleanup timed out')),
                  Math.max(1, options.timeoutMs ?? 1),
                );
              }),
            ]);
          }
        } finally {
          if (timeout) clearTimeout(timeout);
          if (options.cancelPending) {
            for (const socket of sockets) socket.destroy();
          }
          await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      })();
      return closePromise;
    },
  };
}

export function callQaRpc(socketPath: string, method: string, params: unknown): Promise<unknown> {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = `${JSON.stringify({ id, method, params } satisfies QaRpcRequest)}\n`;

  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let input = '';
    let bytes = 0;
    let settled = false;

    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(110_000, () => finish(new Error(`QA broker timed out during ${method}`)));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_MESSAGE_BYTES) {
        finish(new Error('QA broker response exceeded the size limit'));
        return;
      }
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      try {
        const value = JSON.parse(input.slice(0, newline)) as QaRpcResponse;
        if (value.id !== id) throw new Error('QA broker returned a mismatched response');
        if (value.error) throw new Error(value.error);
        finish(null, value.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error(`QA broker closed before replying to ${method}`));
    });
  });
}
