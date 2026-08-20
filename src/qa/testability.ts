/** Controller-owned preflight for changes that are explicitly outside browser QA scope. */

import { matchesGlob } from '../diff/patch.js';
import { QA_SCHEMA_VERSION, type QaPlan } from './types.js';

export const QA_EARLY_EXIT_MAX_PATTERNS = 100;
export const QA_EARLY_EXIT_MAX_PATTERN_CHARS = 500;
const MAX_CHANGED_PATH_CHARS = 4_096;

function safeRelativePath(value: string, maxLength: number): boolean {
  if (
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\0\r\n]/.test(value)
  ) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** @internal Validate the deliberately small, non-negated early-exit glob surface. */
export function safeQaEarlyExitPattern(value: unknown): value is string {
  return typeof value === 'string' &&
    !value.startsWith('!') &&
    safeRelativePath(value, QA_EARLY_EXIT_MAX_PATTERN_CHARS);
}

/**
 * Return a fixed plan only when trusted rules cover the complete changed-path manifest.
 * Missing, malformed, or partially matched manifests fail open to normal semantic planning.
 */
export function preflightQaTestability(
  changedFiles: readonly string[] | undefined,
  earlyExitPaths: readonly string[],
): QaPlan | null {
  if (!changedFiles || changedFiles.length === 0 || earlyExitPaths.length === 0) return null;
  if (
    earlyExitPaths.length > QA_EARLY_EXIT_MAX_PATTERNS ||
    !earlyExitPaths.every(safeQaEarlyExitPattern) ||
    !changedFiles.every((file) => safeRelativePath(file, MAX_CHANGED_PATH_CHARS))
  ) return null;
  if (!changedFiles.every((file) => earlyExitPaths.some((pattern) => matchesGlob(file, pattern)))) {
    return null;
  }
  return {
    schema_version: QA_SCHEMA_VERSION,
    impact_assessment:
      'The complete changed-path manifest matched trusted repository rules for changes outside browser QA scope.',
    testability: 'no_testable_surface',
    no_testable_surface_reason:
      'Every changed path is covered by a trusted early-exit rule, so no affected browser scenario is justified.',
    surfaces: [],
    scenarios: [],
    risk_notes: [
      'This neutral result does not validate infrastructure, documentation, test, or other non-browser behavior.',
    ],
    blind_spots: [
      'Repository-specific non-browser checks remain responsible for the changed paths.',
    ],
  };
}
