import { describe, expect, it } from 'vitest';
import { redact, redactWith } from '../src/util/log.js';

describe('redact', () => {
  it('redacts Anthropic sk-ant keys', () => {
    const key = 'sk-ant-api03-' + 'a'.repeat(24);
    expect(redact(`token ${key} end`)).toBe('token [redacted] end');
    expect(redact('sk-ant-short')).toBe('sk-ant-short'); // near-miss
  });

  it('redacts OpenAI sk-proj keys', () => {
    const key = 'sk-proj-' + 'b'.repeat(24);
    expect(redact(key)).toBe('[redacted]');
    expect(redact('sk-proj-short')).toBe('sk-proj-short');
  });

  it('redacts generic sk- keys of sufficient length', () => {
    const key = 'sk-' + 'c'.repeat(32);
    expect(redact(`x=${key}`)).toBe('x=[redacted]');
    expect(redact('sk-tooshort')).toBe('sk-tooshort');
  });

  it('redacts xAI keys', () => {
    const key = 'xai-' + 'd'.repeat(24);
    expect(redact(key)).toBe('[redacted]');
    expect(redact('xai-short')).toBe('xai-short');
  });

  it('redacts Fireworks fw_ keys', () => {
    const key = 'fw_' + 'e'.repeat(16);
    expect(redact(key)).toBe('[redacted]');
    expect(redact('fw_short')).toBe('fw_short');
  });

  it('redacts GitHub ghp_/gho_/… tokens', () => {
    const key = 'ghp_' + 'f'.repeat(36);
    expect(redact(key)).toBe('[redacted]');
    expect(redact('ghp_short')).toBe('ghp_short');
  });

  it('redacts github_pat_ tokens', () => {
    const key = 'github_pat_' + 'g'.repeat(40);
    expect(redact(key)).toBe('[redacted]');
    expect(redact('github_pat_short')).toBe('github_pat_short');
  });

  it('redacts Google AIza keys', () => {
    const key = 'AIza' + 'h'.repeat(35);
    expect(redact(key)).toBe('[redacted]');
    expect(redact('AIzaShort')).toBe('AIzaShort');
  });

  it('redacts AWS AKIA access key ids', () => {
    const key = 'AKIA' + 'I'.repeat(16);
    expect(redact(`id ${key}`)).toBe('id [redacted]');
    expect(redact('AKIA_SHORT')).toBe('AKIA_SHORT');
  });

  it('replaces every occurrence in a multi-secret string', () => {
    const a = 'sk-' + 'j'.repeat(32);
    const b = 'xai-' + 'k'.repeat(24);
    expect(redact(`${a} and ${b} and ${a}`)).toBe('[redacted] and [redacted] and [redacted]');
  });
});

describe('redactWith', () => {
  it('substitutes live secrets of length >= 12', () => {
    const secret = 'live-secret-value';
    expect(redactWith(`leak ${secret} here`, [secret])).toBe('leak [redacted] here');
  });

  it('ignores secrets shorter than 12 characters', () => {
    const secret = 'short-key'; // 9
    expect(redactWith(`keep ${secret}`, [secret])).toBe(`keep ${secret}`);
  });

  it('still runs shape-based redact first', () => {
    const shaped = 'sk-' + 'm'.repeat(32);
    const live = 'another-live-secret';
    expect(redactWith(`${shaped} ${live}`, [live])).toBe('[redacted] [redacted]');
  });
});
