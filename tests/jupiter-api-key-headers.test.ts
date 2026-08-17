import assert from 'assert';
import fs from 'fs';
import path from 'path';

process.env.RPC_URL ||= 'http://127.0.0.1:8899';
process.env.WS_URL ||= 'ws://127.0.0.1:8900';
process.env.BOT2_WALLET ||= '11111111111111111111111111111111';
process.env.JUP_API_KEY = 'test-jup-key';

import { jupiterFetch, jupiterHeaders } from '../src/utils/jupiter-api';

type FetchCall = { url: string; init?: RequestInit };

const calls: FetchCall[] = [];
(global as any).fetch = async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({}),
  };
};

async function main(): Promise<void> {
  assert.deepStrictEqual(jupiterHeaders(), { 'x-api-key': 'test-jup-key' });

  await jupiterFetch('https://api.jup.ag/swap/v1/quote?x=1');
  assert.strictEqual(calls[0].url, 'https://api.jup.ag/swap/v1/quote?x=1');
  assert.strictEqual((calls[0].init?.headers as Record<string, string>)['x-api-key'], 'test-jup-key');

  await jupiterFetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-other': '1' },
    body: '{}',
  });
  const post = calls[1].init!;
  const postHeaders = post.headers as Record<string, string>;
  assert.strictEqual(post.method, 'POST');
  assert.strictEqual(post.body, '{}');
  assert.strictEqual(postHeaders['Content-Type'], 'application/json');
  assert.strictEqual(postHeaders['x-other'], '1');
  assert.strictEqual(postHeaders['x-api-key'], 'test-jup-key');

  const root = path.resolve(__dirname, '..');
  const jupSwap = fs.readFileSync(path.join(root, 'src/executor/jupiter-swap.ts'), 'utf-8');
  const orca = fs.readFileSync(path.join(root, 'src/executor/orca-position.ts'), 'utf-8');
  const pcs = fs.readFileSync(path.join(root, 'src/executor/pancakeswap-position.ts'), 'utf-8');
  const configSource = fs.readFileSync(path.join(root, 'src/config.ts'), 'utf-8');
  const legacySwapHost = ['https://lite', 'api.jup.ag/swap/v1'].join('-');

  assert.match(jupSwap, /jupiterFetch/);
  assert.match(orca, /jupiterFetch/);
  assert.match(pcs, /jupiterFetch/);
  assert.match(configSource, /jupiterApiBase:\s*'https:\/\/api\.jup\.ag\/swap\/v1'/);
  assert(!configSource.includes(legacySwapHost), 'config must not use old Jupiter swap host');
  assert.doesNotMatch(jupSwap, /fetch\(`\$\{config\.jupiterApiBase\}/);
  assert.doesNotMatch(orca, /fetch\(`\$\{config\.jupiterApiBase\}/);
  assert.doesNotMatch(pcs, /fetch\(`https:\/\/api\.jup\.ag\/price\/v2/);

  console.log('jupiter-api-key-headers ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
