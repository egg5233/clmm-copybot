import { config } from '../config';

export type JupiterHeaderMap = Record<string, string>;

export function jupiterHeaders(extra: JupiterHeaderMap = {}): JupiterHeaderMap {
  const headers: JupiterHeaderMap = { ...extra };
  if (config.jupApiKey) headers['x-api-key'] = config.jupApiKey;
  return headers;
}

export async function jupiterFetch(
  url: string,
  init: Omit<RequestInit, 'headers'> & { headers?: JupiterHeaderMap } = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: jupiterHeaders(init.headers),
  });
}
