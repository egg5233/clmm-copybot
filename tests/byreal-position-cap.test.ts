import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { normalizeByrealMaxOpenPositions } from '../src/config';
import { applyByrealMaxOpenPositionsConfig } from '../src/dashboard/server';
import { getByrealPositionCapStatus } from '../src/executor/byreal-position';
import { PositionMap } from '../src/state/position-map';

describe('normalizeByrealMaxOpenPositions', () => {
  it('treats missing, non-numeric, negative, fractional and zero values as no cap', () => {
    for (const value of [undefined, '', 'abc', '-1', '12.5', '0']) {
      expect(normalizeByrealMaxOpenPositions(value)).toBe(0);
    }
  });

  it('accepts positive integers as the cap', () => {
    expect(normalizeByrealMaxOpenPositions('1')).toBe(1);
    expect(normalizeByrealMaxOpenPositions('415')).toBe(415);
  });
});

describe('Byreal open position counting', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function mapWithOnePositionPerDex(): PositionMap {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byreal-position-cap-'));
    const map = new PositionMap(path.join(dir, 'position-map.json'));
    map.set('target-byreal-legacy', 'our-byreal-legacy', 'A/B', 'wallet-a');
    map.set(
      'target-byreal-tagged',
      'our-byreal-tagged',
      'A/B',
      'wallet-b',
      undefined,
      undefined,
      'byreal',
    );
    map.set('target-orca', 'our-orca', 'A/B', 'wallet-c', undefined, undefined, 'orca');
    map.set('target-meteora', 'our-meteora', 'A/B', 'wallet-d', undefined, undefined, 'meteora');
    map.set('target-pcs', 'our-pcs', 'A/B', 'wallet-e', undefined, undefined, 'pancakeswap');
    map.set('target-dammv2', 'our-dammv2', 'A/B', 'wallet-f', undefined, undefined, 'dammv2');
    return map;
  }

  it('counts untagged legacy entries as Byreal and excludes the other DEXes', () => {
    const map = mapWithOnePositionPerDex();

    expect(map.countByDex().byreal).toBe(2);
    expect(map.getByrealOpenCount()).toBe(2);
  });

  it('reports the cap disabled when it is 0', () => {
    const map = mapWithOnePositionPerDex();

    expect(getByrealPositionCapStatus(map, 0)).toEqual({
      enabled: false,
      current: 2,
      cap: 0,
      reached: false,
      reason: null,
    });
  });

  it('reports the cap not reached while below it', () => {
    const map = mapWithOnePositionPerDex();

    expect(getByrealPositionCapStatus(map, 3)).toEqual({
      enabled: true,
      current: 2,
      cap: 3,
      reached: false,
      reason: null,
    });
  });

  it('reports the cap reached with a skip reason once the count meets it', () => {
    const map = mapWithOnePositionPerDex();

    expect(getByrealPositionCapStatus(map, 2)).toEqual({
      enabled: true,
      current: 2,
      cap: 2,
      reached: true,
      reason: 'Byreal position cap reached (2/2)',
    });
  });
});

describe('applyByrealMaxOpenPositionsConfig', () => {
  it('persists an invalid cap as a normalized 0 rather than omitting the env key', () => {
    const targetConfig = { byrealMaxOpenPositions: 415 };
    const envUpdates: Record<string, string> = {};

    applyByrealMaxOpenPositionsConfig({ byrealMaxOpenPositions: 'bad' }, targetConfig, envUpdates);

    expect(targetConfig.byrealMaxOpenPositions).toBe(0);
    expect(envUpdates).toEqual({ BYREAL_MAX_OPEN_POSITIONS: '0' });
  });

  it('persists a valid cap to both the live config and the env updates', () => {
    const targetConfig = { byrealMaxOpenPositions: 0 };
    const envUpdates: Record<string, string> = {};

    applyByrealMaxOpenPositionsConfig({ byrealMaxOpenPositions: '415' }, targetConfig, envUpdates);

    expect(targetConfig.byrealMaxOpenPositions).toBe(415);
    expect(envUpdates).toEqual({ BYREAL_MAX_OPEN_POSITIONS: '415' });
  });

  it('leaves the cap untouched when the PATCH body omits the field', () => {
    const targetConfig = { byrealMaxOpenPositions: 123 };
    const envUpdates: Record<string, string> = {};

    applyByrealMaxOpenPositionsConfig({}, targetConfig, envUpdates);

    expect(targetConfig.byrealMaxOpenPositions).toBe(123);
    expect(envUpdates).toEqual({});
  });
});
