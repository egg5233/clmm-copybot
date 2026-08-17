import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.RPC_URL ||= 'http://127.0.0.1:8899';
process.env.WS_URL ||= 'ws://127.0.0.1:8900';
process.env.BOT2_WALLET ||= '11111111111111111111111111111111';

const { PositionMap } = require('../src/state/position-map') as typeof import('../src/state/position-map');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-map-'));
const filePath = path.join(dir, 'position-map.json');

const map = new PositionMap(filePath);
const targetNft = 'target-position-nft';
const ourNft = 'our-position-nft';

map.set(targetNft, ourNft, 'MINTA/MINTB', 'target-wallet');

assert.strictEqual(map.findByOurNft(ourNft), targetNft);
assert.strictEqual(map.deleteByOurNft(ourNft), true);
assert.strictEqual(map.findByOurNft(ourNft), undefined);
assert.deepStrictEqual(map.toJSON(), {});
assert.strictEqual(map.deleteByOurNft('missing-nft'), false);

const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
assert.deepStrictEqual(persisted, {});

fs.rmSync(dir, { recursive: true, force: true });
