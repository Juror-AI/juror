/**
 * Rolling 30-day spend per repo.
 *
 * "This PR cost $0.97; this repo has spent $41.20 across 47 PRs" is the line that gets
 * screenshotted, so the ledger is written atomically and never throws: a truncated or
 * hand-edited file degrades to a fresh one instead of failing a review over bookkeeping.
 */

import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/log.js';
import { roundUsd } from './compute.js';

export interface RollingSpend {
  totalUsd: number;
  prCount: number;
  windowDays: number;
  /** Start of the window as `YYYY-MM-DD`, for the receipt line. */
  since: string;
}

/** One reviewed PR head. `usd: null` records a review whose cost we could not price. */
interface SpendEntry {
  prKey: string;
  usd: number | null;
  at: string;
}

interface Ledger {
  version: 1;
  entries: SpendEntry[];
}

const FILE_NAME = 'rolling.json';
const LOCK_NAME = 'rolling.lock';
const DAY_MS = 86_400_000;
export const DEFAULT_WINDOW_DAYS = 30;

/** A ceiling so a busy monorepo cannot grow the ledger without bound inside the window. */
const MAX_ENTRIES = 5_000;
/** Ledger writes take milliseconds; this is generous enough for a heavily loaded runner. */
const LOCK_WAIT_MS = 10_000;
/** A killed process cannot release its directory. Reap only locks far older than any write. */
const STALE_LOCK_MS = 120_000;

export function loadRolling(stateDir: string, windowDays = DEFAULT_WINDOW_DAYS): RollingSpend {
  return summarize(readLedger(stateDir), windowDays, Date.now());
}

export function recordSpend(
  stateDir: string,
  usd: number | null,
  prKey: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): RollingSpend {
  const now = Date.now();
  const cutoff = now - windowDays * DAY_MS;
  const release = acquireLedgerLock(stateDir);
  if (!release) return summarize(readLedger(stateDir), windowDays, now);

  try {
    // The lock covers the entire read-modify-rename sequence. Atomic rename alone prevents
    // torn JSON but cannot prevent two concurrent reviews from both reading the same old
    // ledger and having the last writer erase the other's entry.
    const entries = readLedger(stateDir).filter(
      (e) => e.prKey !== prKey && Date.parse(e.at) >= cutoff,
    );
    entries.push({
      prKey,
      usd: usd != null && Number.isFinite(usd) && usd >= 0 ? usd : null,
      at: new Date(now).toISOString(),
    });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

    writeLedger(stateDir, { version: 1, entries });
    return summarize(entries, windowDays, now);
  } finally {
    release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger I/O — every failure is a warning, never an exception
// ─────────────────────────────────────────────────────────────────────────────

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function waitSync(ms: number): void {
  // No shell `sleep`, no busy spin, and no async API change for callers that render the
  // returned total immediately. This blocks only while another tiny ledger write finishes.
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

/**
 * Cross-process directory lock. `mkdir` is atomic on every supported filesystem. The owner
 * token prevents a delayed holder from deleting a replacement lock after its own was reaped.
 */
function acquireLedgerLock(stateDir: string): (() => void) | null {
  const lock = join(stateDir, LOCK_NAME);
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const owner = join(lock, 'owner');
  const deadline = Date.now() + LOCK_WAIT_MS;

  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (error) {
    log.warn(`could not prepare rolling spend state at ${stateDir}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  while (Date.now() <= deadline) {
    let created = false;
    try {
      mkdirSync(lock, { mode: 0o700 });
      created = true;
      writeFileSync(owner, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
      return () => {
        try {
          if (readFileSync(owner, 'utf8').trim() === token) {
            rmSync(lock, { recursive: true, force: true });
          }
        } catch {
          // A stale-lock recovery may already have moved it. Never delete an unknown owner.
        }
      };
    } catch (error) {
      if (created) {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          /* best effort; the stale-lock path will recover it later */
        }
      }
      if (errorCode(error) !== 'EEXIST') {
        log.warn(`could not lock rolling spend at ${lock}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }

    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
        // Rename claims this exact stale inode atomically. A new writer may acquire `lock`
        // immediately afterward without either waiter being able to remove the other's dir.
        const stale = `${lock}.stale.${token}`;
        renameSync(lock, stale);
        rmSync(stale, { recursive: true, force: true });
        continue;
      }
    } catch {
      // It disappeared or another waiter reaped it; retry the atomic mkdir.
      continue;
    }
    waitSync(25);
  }

  log.warn(`timed out waiting for rolling spend lock at ${lock}; leaving the ledger unchanged`);
  return null;
}

function readLedger(stateDir: string): SpendEntry[] {
  let text: string;
  try {
    text = readFileSync(join(stateDir, FILE_NAME), 'utf8');
  } catch {
    return []; // No ledger yet is the common case, not an error.
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const raw = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isSpendEntry);
  } catch {
    log.debug('rolling spend ledger was corrupt; starting a fresh window');
    return [];
  }
}

function isSpendEntry(v: unknown): v is SpendEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as { prKey?: unknown; usd?: unknown; at?: unknown };
  if (typeof e.prKey !== 'string' || !e.prKey) return false;
  if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return false;
  if (e.usd === null) return true;
  return typeof e.usd === 'number' && Number.isFinite(e.usd);
}

function writeLedger(stateDir: string, ledger: Ledger): void {
  const file = join(stateDir, FILE_NAME);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    // Rename is atomic within a filesystem, so a killed job leaves either the old
    // ledger or the new one — never a half-written file the next run has to parse.
    renameSync(tmp, file);
  } catch (e) {
    log.warn(`could not update rolling spend at ${file}: ${e instanceof Error ? e.message : String(e)}`);
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * `totalUsd` and `prCount` describe the same set on purpose: a PR whose cost we could
 * not price is kept in the ledger (so a later priced re-review can replace it) but is
 * left out of both, rather than being counted as a $0 PR and understating the average.
 */
function summarize(entries: SpendEntry[], windowDays: number, now: number): RollingSpend {
  const cutoff = now - windowDays * DAY_MS;
  const priced = entries.filter((e) => Date.parse(e.at) >= cutoff && e.usd != null);
  const total = priced.reduce((sum, e) => sum + (e.usd ?? 0), 0);
  return {
    totalUsd: roundUsd(total),
    prCount: priced.length,
    windowDays,
    since: new Date(cutoff).toISOString().slice(0, 10),
  };
}
