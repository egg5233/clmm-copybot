import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.jupApiKey is read from the environment when src/config is first imported, so the key
// has to be in place before the module graph loads. vi.hoisted runs ahead of the imports below.
vi.hoisted(() => {
  process.env.JUP_API_KEY = 'test-jup-key';
});

import { jupiterFetch, jupiterHeaders } from '../src/utils/jupiter-api';

type FetchCall = { url: string; init: RequestInit | undefined };

const calls: FetchCall[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('jupiterHeaders', () => {
  it('carries the configured Jupiter API key', () => {
    expect(jupiterHeaders()).toEqual({ 'x-api-key': 'test-jup-key' });
  });
});

describe('jupiterFetch', () => {
  it('attaches the API key to a GET without altering the URL', async () => {
    await jupiterFetch('https://api.jup.ag/swap/v1/quote?x=1');

    expect(calls[0].url).toBe('https://api.jup.ag/swap/v1/quote?x=1');
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('test-jup-key');
  });

  it('merges the API key into POST headers without clobbering the caller headers or body', async () => {
    await jupiterFetch('https://api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-other': '1' },
      body: '{}',
    });

    const post = calls[0].init!;
    expect(post.method).toBe('POST');
    expect(post.body).toBe('{}');
    expect(post.headers).toEqual({
      'Content-Type': 'application/json',
      'x-other': '1',
      'x-api-key': 'test-jup-key',
    });
  });
});
