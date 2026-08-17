/**
 * Pending swaps: tokens we received from closing a position, held until the
 * target's own Jupiter swap tells us what proportion to sell.
 *
 * This module exists to make that state single-writer. Four executors — byreal,
 * orca, meteora and dammv2 — each read data/pending-swaps.json whole, mutated
 * their own mint, and wrote the whole object back, with no lock between them.
 * Two closes landing together meant the slower writer had already parsed a stale
 * object, and its write silently erased the other mint's tokens: real balances
 * left in the wallet with nothing tracking them. All four now share the one Map
 * below, and the write chain hands Postgres a single-row upsert per mutation, so
 * a write for mint A can no longer touch mint B.
 *
 * Reads stay synchronous because the executors call them mid-transaction.
 */

import BN from 'bn.js';
import { pendingSwaps } from './repo';
import { WriteChain } from './write-chain';

const MODULE = 'PendingSwaps';

/**
 * What the executors agree on. Amounts are base units as decimal strings, which
 * is what BN reads and writes; the index signature keeps entries loaded from an
 * older shape intact through a round trip.
 */
export interface PendingSwapEntry {
  pending: string;
  botReceived: string;
  createdAt: number;
  [key: string]: unknown;
}

const map = new Map<string, PendingSwapEntry>();
const writes = new WriteChain(MODULE);

/** Load pending swaps from Postgres and arm the write-through. */
export async function initPendingSwaps(): Promise<void> {
  const rows = await pendingSwaps.all();
  map.clear();
  for (const [mint, payload] of Object.entries(rows)) {
    map.set(mint, payload as PendingSwapEntry);
  }
  writes.enable();
}

/** Resolves once every queued write has reached Postgres. For shutdown and tests. */
export async function flushPendingSwaps(): Promise<void> {
  await writes.drain();
}

/** How many mints are pending. */
export function countPendingSwaps(): number {
  return map.size;
}

/** One mint's entry, or undefined. */
export function getPendingSwap(inputMint: string): PendingSwapEntry | undefined {
  return map.get(inputMint);
}

/**
 * Every pending swap, in the Record shape the dashboard and the executors read.
 *
 * A shallow copy of the map, holding the live entry objects — callers only read
 * them, and they used to receive freshly parsed JSON either way.
 */
export function allPendingSwaps(): Record<string, PendingSwapEntry> {
  return Object.fromEntries(map);
}

function seed(createdAt = Date.now()): PendingSwapEntry {
  return { pending: '0', botReceived: '0', createdAt };
}

function persist(inputMint: string, entry: PendingSwapEntry): void {
  writes.push(`pending swap ${inputMint.slice(0, 8)}`, () => pendingSwaps.set(inputMint, entry));
}

/** Replace one mint's entry wholesale. */
export function setPendingSwap(inputMint: string, entry: PendingSwapEntry): void {
  map.set(inputMint, entry);
  persist(inputMint, entry);
}

/** Add to the amount we are holding for a mint. Returns the new total. */
export function addPending(inputMint: string, amount: BN): string {
  const entry = map.get(inputMint) ?? seed();
  const total = new BN(entry.pending).add(amount).toString();
  const updated = { ...entry, pending: total };
  map.set(inputMint, updated);
  persist(inputMint, updated);
  return total;
}

/** Add to the amount the target received for a mint. Returns the new total. */
export function addBotReceived(inputMint: string, amount: BN): string {
  const entry = map.get(inputMint) ?? seed();
  const total = new BN(entry.botReceived || '0').add(amount).toString();
  const updated = { ...entry, botReceived: total };
  map.set(inputMint, updated);
  persist(inputMint, updated);
  return total;
}

/** Drop one mint entirely (swapped out, dust, or cleared from the dashboard). */
export function deletePendingSwap(inputMint: string): void {
  map.delete(inputMint);
  writes.push(`pending swap removal ${inputMint.slice(0, 8)}`, () =>
    pendingSwaps.delete(inputMint),
  );
}

/** Drop every pending swap (dashboard "clear all"). */
export function clearPendingSwaps(): void {
  map.clear();
  writes.push('pending swap clear', () => pendingSwaps.clear());
}
