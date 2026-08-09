// In-memory {@link Journal} (test-only).
//
// Records journal entries in an array instead of appending to a JSONL file, and
// can be told to fail on demand — which is the interesting case: a journal
// failure must NOT fail the tool. The write already happened; reporting failure
// would tell the model to retry a write that succeeded. The contract is
// `ok: true` plus hint `journal_unavailable` (CC-33), and `failNext` is how a
// test gets there.

import type {
  Clock,
  Journal,
  JournalEntry,
  JournalEntryInput,
  JournalStatus,
} from '../types.js';

/** A {@link Journal} that keeps its entries in memory. */
export interface MemoryJournal extends Journal {
  /** Successfully appended entries, in order. Failed appends are not recorded. */
  readonly entries: readonly JournalEntry[];
  /** Make the next `count` appends (default 1) return `'failed'`. */
  failNext(count?: number): void;
  /** Drop recorded entries and any pending failures. */
  clear(): void;
}

/**
 * Create an in-memory journal. The {@link Clock} is REQUIRED: `ts` must come
 * from the injected clock (the wall clock is banned outside `core/clock.ts`
 * [eslint]), and a journal whose timestamps a test cannot pin is a journal whose
 * output a test cannot assert.
 */
export function createMemoryJournal(clock: Clock): MemoryJournal {
  const entries: JournalEntry[] = [];
  let failures = 0;

  return {
    entries,
    append: (entry: JournalEntryInput): Promise<JournalStatus> => {
      if (failures > 0) {
        failures -= 1;
        return Promise.resolve('failed');
      }
      entries.push({ ...entry, ts: new Date(clock.now()).toISOString() });
      return Promise.resolve('ok');
    },
    failNext: (count = 1): void => {
      failures += count;
    },
    clear: (): void => {
      entries.length = 0;
      failures = 0;
    },
  };
}
