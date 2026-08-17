/**
 * The pump-pending store's write-through.
 *
 * The suite runs from a temporary working directory: resolving a token also
 * writes the token-names cache, which is one of the two files that deliberately
 * stayed on disk, and a test has no business touching the repository's copy.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addPumpPending,
  deletePumpEntry,
  flushPumpPending,
  getPumpPendingList,
  initPumpPending,
  isPumpApproved,
  isPumpPending,
  resolvePump,
} from '../src/state/pump-pending';
import { pumpPending } from '../src/state/repo';
import { canRunRepoTests, useOwnTestDatabase } from './repo/setup';

const HOUR = 60 * 60 * 1000;

function detected(mint: string, detectedAt = Date.now()) {
  return {
    mint,
    symbol: mint.toUpperCase(),
    pool: `${mint}/SOL`,
    targetWallet: 'wallet-1',
    detectedAt,
  };
}

describe.skipIf(!canRunRepoTests)('pump pending store', () => {
  useOwnTestDatabase('copybot_pump_pending_store', ['pump_pending']);

  const originalCwd = process.cwd();
  let scratch = '';

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-pump-'));
    // The cache write is best-effort and does not create its directory; the real
    // bot always has one by the time a pump token is resolved.
    fs.mkdirSync(path.join(scratch, 'data'));
    process.chdir(scratch);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('serves a newly detected token from memory before the write has landed', async () => {
    await initPumpPending();

    addPumpPending(detected('pump-a'));

    // No await: five executors call this while deciding whether to copy.
    expect(isPumpPending('pump-a')).toBe(true);
    expect(getPumpPendingList()).toHaveLength(1);
    await flushPumpPending();

    expect(await pumpPending.get('pump-a')).toMatchObject({ status: 'pending' });
  });

  it('reloads pending and resolved tokens alike', async () => {
    await initPumpPending();
    addPumpPending(detected('pump-a'));
    addPumpPending(detected('pump-b'));
    resolvePump('pump-a', 'approved');
    await flushPumpPending();

    await initPumpPending();

    expect(isPumpApproved('pump-a')).toBe(true);
    expect(isPumpPending('pump-a')).toBe(false);
    expect(isPumpPending('pump-b')).toBe(true);
  });

  it('treats a pending token past its hour as no longer pending', async () => {
    await initPumpPending();
    addPumpPending(detected('pump-a', Date.now() - HOUR - 1000));

    expect(isPumpPending('pump-a')).toBe(false);
    // Still on the list — the poller is what rejects it, and it has not run.
    expect(getPumpPendingList()).toHaveLength(1);
    await flushPumpPending();
  });

  it('persists an operator overriding a decision already taken', async () => {
    await initPumpPending();
    addPumpPending(detected('pump-a'));
    resolvePump('pump-a', 'approved');

    // The dashboard's resolve route has no pending-only guard, so this is
    // reachable. Memory and Postgres have to agree on the second answer, or a
    // restart would resurrect the first one.
    resolvePump('pump-a', 'rejected');
    await flushPumpPending();

    expect((await pumpPending.get('pump-a'))?.status).toBe('rejected');

    await initPumpPending();
    expect(isPumpApproved('pump-a')).toBe(false);
  });

  it('deletes an entry from both memory and Postgres', async () => {
    await initPumpPending();
    addPumpPending(detected('pump-a'));
    deletePumpEntry('pump-a');
    await flushPumpPending();

    expect(getPumpPendingList()).toHaveLength(0);
    expect(await pumpPending.get('pump-a')).toBeUndefined();
  });

  it('records the resolved symbol in the token-names cache', async () => {
    await initPumpPending();
    addPumpPending(detected('pump-a'));
    resolvePump('pump-a', 'approved');
    await flushPumpPending();

    const cache = JSON.parse(fs.readFileSync(path.join(scratch, 'data/token-names.json'), 'utf-8'));

    expect(cache['pump-a'].symbol).toBe('PUMP-A');
  });
});
