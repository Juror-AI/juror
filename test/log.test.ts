import { describe, expect, it } from 'vitest';
import { redact, redactWith } from '../src/util/log.js';

// ─────────────────────────────────────────────────────────────────────────────
// redact() — shape-based secret matching
//
// One positive hit and one near-miss per SECRET_PATTERNS entry. Near-misses keep
// the prefix but break a length/charset rule so a future over-eager pattern does
// not start redacting legitimate identifiers.
// ─────────────────────────────────────────────────────────────────────────────

describe('redact', () => {
  it('redacts Anthropic sk-ant-api keys and leaves near-miss prefixes alone', () => {
    const key = 'sk-ant-api03-' + 'A'.repeat(20);
    expect(redact(`Authorization: Bearer ${key}`)).toBe('Authorization: Bearer [redacted]');
    // Too short after the prefix.
    expect(redact('sk-ant-api03-short')).toBe('sk-ant-api03-short');
  });

  it('redacts OpenAI project keys (sk-proj-) and leaves short tails alone', () => {
    const key = 'sk-proj-' + 'B'.repeat(20);
    expect(redact(`key=${key}`)).toBe('key=[redacted]');
    expect(redact('sk-proj-tooshort')).toBe('sk-proj-tooshort');
  });

  it('redacts generic sk- keys (32+ alnum) without eating shorter tokens', () => {
    const key = 'sk-' + 'c'.repeat(32);
    expect(redact(`export OPENAI_API_KEY=${key}`)).toBe('export OPENAI_API_KEY=[redacted]');
    // 31 chars after sk- — under the 32-char floor.
    expect(redact('sk-' + 'c'.repeat(31))).toBe('sk-' + 'c'.repeat(31));
  });

  it('redacts xAI keys and leaves short tails alone', () => {
    const key = 'xai-' + 'D'.repeat(20);
    expect(redact(`XAI_API_KEY=${key}`)).toBe('XAI_API_KEY=[redacted]');
    expect(redact('xai-short')).toBe('xai-short');
  });

  it('redacts Fireworks fw_ keys and leaves short tails alone', () => {
    const key = 'fw_' + 'E'.repeat(16);
    expect(redact(`token ${key}`)).toBe('token [redacted]');
    expect(redact('fw_tooshort')).toBe('fw_tooshort');
  });

  it('redacts classic GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_) and leaves short tails alone', () => {
    const key = 'ghp_' + 'F'.repeat(30);
    expect(redact(`Authorization: token ${key}`)).toBe('Authorization: token [redacted]');
    expect(redact('ghp_tooshort')).toBe('ghp_tooshort');
    // Other classic prefixes share the same charset/length rules.
    expect(redact('gho_' + 'G'.repeat(30))).toBe('[redacted]');
    expect(redact('ghu_' + 'H'.repeat(30))).toBe('[redacted]');
    expect(redact('ghs_' + 'I'.repeat(30))).toBe('[redacted]');
    expect(redact('ghr_' + 'J'.repeat(30))).toBe('[redacted]');
  });

  it('redacts fine-grained GitHub PATs and leaves short tails alone', () => {
    const key = 'github_pat_' + 'K'.repeat(40);
    expect(redact(`GH_TOKEN=${key}`)).toBe('GH_TOKEN=[redacted]');
    expect(redact('github_pat_tooshort')).toBe('github_pat_tooshort');
  });

  it('redacts Google API keys (AIza…) and leaves short tails alone', () => {
    const key = 'AIza' + 'L'.repeat(30);
    expect(redact(`key=${key}`)).toBe('key=[redacted]');
    expect(redact('AIzaShort')).toBe('AIzaShort');
  });

  it('redacts AWS access key ids (AKIA…) and leaves near-misses alone', () => {
    const key = 'AKIA' + 'M'.repeat(16);
    expect(redact(`AWS_ACCESS_KEY_ID=${key}`)).toBe('AWS_ACCESS_KEY_ID=[redacted]');
    // Wrong length.
    expect(redact('AKIA' + 'M'.repeat(15))).toBe('AKIA' + 'M'.repeat(15));
    // Lowercase is not an AWS access key id shape.
    expect(redact('akia' + 'm'.repeat(16))).toBe('akia' + 'm'.repeat(16));
  });

  it('replaces every occurrence in a multi-secret string', () => {
    const ant = 'sk-ant-api03-' + 'A'.repeat(20);
    const ghp = 'ghp_' + 'F'.repeat(30);
    const text = `ant=${ant} mid ghp=${ghp} end ${ant}`;
    expect(redact(text)).toBe('ant=[redacted] mid ghp=[redacted] end [redacted]');
  });

  it('returns non-secret text unchanged', () => {
    expect(redact('no secrets here, just code')).toBe('no secrets here, just code');
    expect(redact('')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// redactWith() — shape match plus exact live secrets from the environment
// ─────────────────────────────────────────────────────────────────────────────

describe('redactWith', () => {
  it('still applies shape-based redaction before exact matches', () => {
    const key = 'sk-' + 'c'.repeat(32);
    expect(redactWith(`hold ${key}`, [])).toBe('hold [redacted]');
  });

  it('substitutes a live secret only when it is at least 12 characters', () => {
    const long = 'supersecret1'; // 12
    const short = 'shortsecret'; // 11
    expect(redactWith(`a=${long} b=${short}`, [long, short])).toBe(
      'a=[redacted] b=shortsecret',
    );
  });

  it('ignores empty and under-length secrets without throwing', () => {
    expect(redactWith('hello', ['', 'abc', 'exactly11ch'])).toBe('hello');
  });

  it('replaces every occurrence of a live secret', () => {
    const secret = 'my-live-token';
    expect(redactWith(`${secret} and again ${secret}`, [secret])).toBe(
      '[redacted] and again [redacted]',
    );
  });

  it('redacts multiple distinct live secrets in one pass', () => {
    expect(redactWith('one=aaaaaaaaaaaa two=bbbbbbbbbbbb', ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])).toBe(
      'one=[redacted] two=[redacted]',
    );
  });
});
