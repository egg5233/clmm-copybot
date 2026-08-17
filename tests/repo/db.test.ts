import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, query, withTransaction } from '../../src/state/db';
import { ALL_TABLES, canRunRepoTests } from './setup';

/**
 * A table of this suite's own, so the transaction tests never collide with the
 * suites that own the migration's tables — vitest runs the files in parallel
 * against the one database.
 */
const SCRATCH = 'db_test_scratch';

describe('db connection layer', () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(async () => {
    await closePool();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it('fails loudly when DATABASE_URL is unset', async () => {
    await closePool();
    delete process.env.DATABASE_URL;

    // Silently dropping state would be far worse than refusing to start.
    expect(() => getPool()).toThrow(/DATABASE_URL is not set/);
    expect(() => getPool()).toThrow(/npm run db:start/);
  });

  it('reuses one pool and builds a fresh one after close', async () => {
    if (!canRunRepoTests) return;

    const first = getPool();
    expect(getPool()).toBe(first);

    await closePool();
    expect(getPool()).not.toBe(first);
  });
});

describe.skipIf(!canRunRepoTests)('migrated schema', () => {
  afterAll(async () => {
    await closePool();
  });

  it('created every table the migration declares', async () => {
    const res = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [[...ALL_TABLES]],
    );

    expect(res.rows.map((r) => r.table_name).sort()).toEqual([...ALL_TABLES].sort());
  });

  it('documented on every table which JSON file it replaces', async () => {
    const res = await query<{ table_name: string; comment: string | null }>(
      `SELECT c.relname AS table_name, obj_description(c.oid) AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [[...ALL_TABLES]],
    );

    expect(res.rows).toHaveLength(ALL_TABLES.length);
    for (const row of res.rows) {
      expect(row.comment, `${row.table_name} has no table comment`).toBeTruthy();
      expect(row.comment, `${row.table_name} does not name a JSON file`).toMatch(/\.json/);
    }
  });
});

describe.skipIf(!canRunRepoTests)('withTransaction', () => {
  beforeAll(async () => {
    await query(`CREATE TABLE IF NOT EXISTS ${SCRATCH} (id BIGSERIAL PRIMARY KEY, value TEXT)`);
  });

  afterEach(async () => {
    await query(`TRUNCATE ${SCRATCH} RESTART IDENTITY`);
  });

  afterAll(async () => {
    await query(`DROP TABLE IF EXISTS ${SCRATCH}`);
    await closePool();
  });

  it('rolls back everything a failed transaction wrote', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query(`INSERT INTO ${SCRATCH} (value) VALUES ($1)`, ['first']);
        await client.query(`INSERT INTO ${SCRATCH} (value) VALUES ($1)`, ['second']);
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');

    const res = await query<{ count: string }>(`SELECT count(*) AS count FROM ${SCRATCH}`);
    expect(res.rows[0].count).toBe('0');
  });

  it('commits what a successful transaction wrote and returns its value', async () => {
    const id = await withTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO ${SCRATCH} (value) VALUES ($1) RETURNING id`,
        ['kept'],
      );
      return res.rows[0].id;
    });

    const res = await query<{ id: string; value: string }>(`SELECT id, value FROM ${SCRATCH}`);
    expect(res.rows).toEqual([{ id, value: 'kept' }]);
  });

  it('returns the client to the pool after a failure', async () => {
    // A leaked client would exhaust the pool; running more transactions than the
    // pool holds proves the release happens on the error path too.
    for (let i = 0; i < 12; i++) {
      await expect(
        withTransaction(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    }

    await expect(query('SELECT 1')).resolves.toBeTruthy();
  });
});
