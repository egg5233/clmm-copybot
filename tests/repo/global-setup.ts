/**
 * Provides the Postgres the repository suites run against, once per vitest run.
 *
 * Where it comes from, in order:
 *   1. DATABASE_URL, if already set. CI provides one via a services container.
 *   2. A throwaway `docker run postgres:16-alpine` on a random free port, torn
 *      down again in teardown().
 *   3. Neither -> DATABASE_URL stays unset and the suites skip themselves.
 *
 * Testcontainers would cover case 2 for us, but shelling out to docker is forty
 * lines and keeps a test-only dependency out of the tree.
 *
 * Migrations are applied here through node-pg-migrate's JS API, so the tests run
 * against exactly the schema `npm run migrate` and the compose `migrate` service
 * produce — not a hand-maintained copy that can drift.
 *
 * Environment set here reaches the test workers: vitest forks them after global
 * setup has run.
 */

import { execFileSync, execSync } from 'child_process';
import { createServer } from 'net';
import { runner } from 'node-pg-migrate';
import path from 'path';
import { Client } from 'pg';

const IMAGE = 'postgres:16-alpine';
const LABEL = 'clmm-copybot-test-pg';
const DB_NAME = 'copybot_test';
const DB_USER = 'copybot';
const DB_PASSWORD = 'copybot';

let containerId: string | null = null;

function docker(args: string[], timeout = 60_000): string {
  return execFileSync('docker', args, { encoding: 'utf-8', timeout }).trim();
}

function hasDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Ask the OS for a port it is willing to bind, then hand it to docker. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Poll until the database answers a real query over TCP.
 *
 * `docker exec pg_isready` is not good enough here: the entrypoint runs initdb
 * against a bootstrap server first, and pg_isready happily reports that one as
 * ready over the local socket. Migrations started at that point die with
 * "Connection terminated unexpectedly" when the bootstrap server shuts down and
 * the real one takes over. The bootstrap server never listens on TCP, so a
 * successful query from the host means the real server is serving.
 */
async function waitForReady(connectionString: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = '';
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Postgres container never became ready. Last error: ${lastError}`);
}

async function startContainer(): Promise<void> {
  // A run that was killed rather than torn down leaves its container behind;
  // clear any before adding another.
  removeStrayContainers();

  const port = await freePort();
  containerId = docker([
    'run',
    '-d',
    '--rm',
    '--label',
    LABEL,
    '-e',
    `POSTGRES_DB=${DB_NAME}`,
    '-e',
    `POSTGRES_USER=${DB_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${DB_PASSWORD}`,
    '-p',
    `127.0.0.1:${port}:5432`,
    IMAGE,
  ]);

  const url = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`;
  try {
    await waitForReady(url);
  } catch (err) {
    removeContainer();
    throw err;
  }
  process.env.DATABASE_URL = url;
}

function removeContainer(): void {
  if (!containerId) return;
  try {
    docker(['rm', '-f', containerId], 30_000);
  } catch {
    // --rm means an already-stopped container is gone; nothing left to clean up.
  }
  containerId = null;
}

function removeStrayContainers(): void {
  try {
    const ids = docker(['ps', '-aq', '--filter', `label=${LABEL}`], 15_000);
    if (ids) docker(['rm', '-f', ...ids.split('\n')], 30_000);
  } catch {
    // Best effort — a stray container costs memory, not correctness.
  }
}

/**
 * Teardown is the value this function *returns*, not a named export: when a
 * globalSetup module has a default export, vitest treats it as setup and ignores
 * an exported `teardown` entirely. Returning it is the only form that runs.
 *
 * Nothing is returned on the paths that started no container — there is then
 * nothing to tear down, and vitest accepts a void return.
 */
export default async function setup(): Promise<(() => void) | undefined> {
  if (!process.env.DATABASE_URL) {
    if (!hasDocker()) {
      console.warn(
        '[repo tests] No DATABASE_URL and no working docker daemon — repository ' +
          'integration suites will skip. Start one with `npm run db:start`.',
      );
      return undefined;
    }
    await startContainer();
  }

  await runner({
    databaseUrl: process.env.DATABASE_URL as string,
    dir: path.resolve(__dirname, '../../migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    // node-pg-migrate narrates every applied migration; the suites are noisy enough.
    log: () => {},
  });

  return containerId ? removeContainer : undefined;
}
