import { describe, expect, it } from 'vitest';

import { run } from '../src/util/proc.js';

describe('run process lifecycle', () => {
  it.runIf(process.platform !== 'win32')('kills the complete process group on timeout', async () => {
    const result = await run(
      ['/bin/sh', '-c', 'sleep 30 & child=$!; echo "$child"; wait "$child"'],
      { timeoutMs: 100 },
    );

    expect(result.timedOut).toBe(true);
    const grandchild = Number(result.stdout.trim());
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('honors an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    const result = await run(
      process.platform === 'win32'
        ? [process.execPath, '-e', 'setTimeout(() => {}, 30_000)']
        : ['/bin/sh', '-c', 'sleep 30'],
      { signal: controller.signal },
    );

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
