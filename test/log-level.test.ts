import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, parseLogLevelEnv, setLogLevel } from '../src/util/log.js';

describe('parseLogLevelEnv', () => {
  afterEach(() => {
    setLogLevel('info');
  });

  it('defaults to info when unset', () => {
    expect(parseLogLevelEnv(undefined)).toBe('info');
    expect(parseLogLevelEnv('')).toBe('info');
  });

  it('accepts known levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error', 'silent'] as const) {
      expect(parseLogLevelEnv(level)).toBe(level);
    }
  });

  it('falls back to info and warns once on unrecognized values', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(parseLogLevelEnv('verbose')).toBe('info');
    expect(write).toHaveBeenCalled();
    expect(String(write.mock.calls[0]?.[0])).toMatch(/JUROR_LOG_LEVEL/);
    write.mockRestore();
  });

  it('setLogLevel updates getLogLevel', () => {
    setLogLevel('error');
    expect(getLogLevel()).toBe('error');
  });
});
