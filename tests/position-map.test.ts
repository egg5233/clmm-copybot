import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { PositionMap } from '../src/state/position-map';

describe('PositionMap', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps target NFT to our NFT, deletes by our NFT, and persists to disk', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-map-'));
    const filePath = path.join(dir, 'position-map.json');

    const map = new PositionMap(filePath);
    const targetNft = 'target-position-nft';
    const ourNft = 'our-position-nft';

    map.set(targetNft, ourNft, 'MINTA/MINTB', 'target-wallet');

    expect(map.findByOurNft(ourNft)).toBe(targetNft);
    expect(map.deleteByOurNft(ourNft)).toBe(true);
    expect(map.findByOurNft(ourNft)).toBeUndefined();
    expect(map.toJSON()).toEqual({});
    expect(map.deleteByOurNft('missing-nft')).toBe(false);

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(persisted).toEqual({});
  });
});
