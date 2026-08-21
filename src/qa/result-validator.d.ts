import type { QaRunResult } from './types.js';

/** Strict runtime guard implemented by the adjacent dependency-free JavaScript module. */
export function isQaRunResult(value: unknown): value is QaRunResult;
