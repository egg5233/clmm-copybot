import { describe, expect, it } from 'vitest';
import * as authLog from '../../src/state/repo/authLog';
import { canRunRepoTests, useTestDatabase } from './setup';

describe.skipIf(!canRunRepoTests)('authLog repository', () => {
  useTestDatabase(['auth_log']);

  describe('push and list', () => {
    it('round-trips an entry', async () => {
      await authLog.push('10.0.0.1', 'login-ok', 1_700_000_000_000);

      expect(await authLog.list()).toEqual([
        { ts: 1_700_000_000_000, ip: '10.0.0.1', event: 'login-ok' },
      ]);
    });

    it('returns entries newest first, the order the dashboard renders', async () => {
      for (let i = 0; i < 5; i++) {
        await authLog.push('10.0.0.1', `event${i}`);
      }

      expect((await authLog.list()).map((e) => e.event)).toEqual([
        'event4',
        'event3',
        'event2',
        'event1',
        'event0',
      ]);
    });

    it('returns 50 entries by default, matching GET /api/auth-log', async () => {
      for (let i = 0; i < 60; i++) {
        await authLog.push('10.0.0.1', `event${i}`);
      }

      expect(await authLog.list()).toHaveLength(50);
      expect(await authLog.count()).toBe(60);
      expect(authLog.DEFAULT_LIST_LIMIT).toBe(50);
    });

    it('honours an explicit limit', async () => {
      for (let i = 0; i < 10; i++) {
        await authLog.push('10.0.0.1', `event${i}`);
      }

      expect((await authLog.list(2)).map((e) => e.event)).toEqual(['event9', 'event8']);
    });
  });

  describe('cap enforcement', () => {
    it('keeps 200 of 205 pushes', async () => {
      for (let i = 0; i < 205; i++) {
        await authLog.push('10.0.0.1', `event${i}`);
      }

      expect(await authLog.count()).toBe(200);
      // The oldest five are gone; the newest is still first.
      expect((await authLog.list(1))[0].event).toBe('event204');
      expect((await authLog.list(200)).at(-1)?.event).toBe('event5');
    });

    it('never exceeds the cap even momentarily', async () => {
      for (let i = 0; i < 15; i++) {
        await authLog.push('10.0.0.1', 'x', Date.now(), 5);
        expect(await authLog.count()).toBeLessThanOrEqual(5);
      }
    });

    it('defaults to the cap the file version enforced', () => {
      expect(authLog.MAX_AUTH_LOG).toBe(200);
    });
  });

  describe('clear', () => {
    it('empties the log', async () => {
      await authLog.push('10.0.0.1', 'login-ok');
      await authLog.push('10.0.0.2', 'login-fail');

      await authLog.clear();

      expect(await authLog.list()).toEqual([]);
      expect(await authLog.count()).toBe(0);
    });
  });
});
