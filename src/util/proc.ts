/** Child-process helpers with hard timeouts and no shell interpolation. */

import { spawn } from 'node:child_process';
import type { HarnessIO } from '../types.js';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  /** Cap captured output so a runaway agent cannot exhaust memory. */
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Spawn a process without a shell and capture stdout/stderr.
 *
 * `stdin` is always written and then closed — every CLI we drive reads stdin when it
 * is a pipe, and a job that leaves it open hangs until the timeout instead of running.
 */
export function run(argv: string[], opts: RunOptions = {}): Promise<HarnessIO> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error('run() called with an empty argv');

  const started = Date.now();
  const maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  return new Promise<HarnessIO>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : null;

    const onAbort = () => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (c: Buffer) => {
      if (outBytes < maxBuffer) {
        out.push(c);
        outBytes += c.length;
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      if (errBytes < maxBuffer) {
        err.push(c);
        errBytes += c.length;
      }
    });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        durationMs: Date.now() - started,
        timedOut,
      });
    });

    // Writing to a child that has already exited raises EPIPE; it is not an error here.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}

/** Convenience wrapper for short-lived, must-succeed commands like `git`. */
export async function runOrThrow(argv: string[], opts: RunOptions = {}): Promise<string> {
  const io = await run(argv, { timeoutMs: 120_000, ...opts });
  if (io.exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${io.exitCode}): ${argv.join(' ')}\n${io.stderr.trim() || io.stdout.trim()}`,
    );
  }
  return io.stdout;
}

/** Resolve an executable through PATH without invoking a shell. */
export async function which(bin: string): Promise<string | null> {
  const io = await run(['/usr/bin/env', 'which', bin], { timeoutMs: 10_000 });
  if (io.exitCode !== 0) return null;
  const first = io.stdout.split('\n').map((s) => s.trim()).find(Boolean);
  return first ?? null;
}
