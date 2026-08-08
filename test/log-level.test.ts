import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, resolveLogLevel, setLogLevel } from '../src/util/log.js';

describe('resolveLogLevel', () => {
  const levels = ['debug', 'info', 'warn', 'error', 'silent'] as const;

  it('accepts every ORDER key', () => {
    for (const level of levels) {
      expect(resolveLogLevel(level)).toBe(level);
    }
  });

  it('defaults to info when the value is missing or empty', () => {
    expect(resolveLogLevel(undefined)).toBe('info');
    expect(resolveLogLevel('')).toBe('info');
  });

  it('falls back to info for unrecognized values (e.g. a typo like verbose)', () => {
    expect(resolveLogLevel('verbose')).toBe('info');
    expect(resolveLogLevel('TRACE')).toBe('info');
    expect(resolveLogLevel('Info')).toBe('info'); // case-sensitive
  });

  it('warns on stderr at most once for unrecognized values', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Force at least one invalid resolution; the module may already have warned at import.
    resolveLogLevel('not-a-level');
    resolveLogLevel('also-bad');
    const warnings = write.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('JUROR_LOG_LEVEL') && s.includes('not recognized'));
    // Across the whole process we should never emit more than one such line.
    expect(warnings.length).toBeLessThanOrEqual(1);
    write.mockRestore();
  });
});

describe('setLogLevel / getLogLevel', () => {
  afterEach(() => {
    setLogLevel('info');
  });

  it('round-trips explicit CLI overrides', () => {
    setLogLevel('debug');
    expect(getLogLevel()).toBe('debug');
    setLogLevel('error');
    expect(getLogLevel()).toBe('error');
  });
});
