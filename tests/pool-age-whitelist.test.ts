import { describe, expect, it } from 'vitest';

import { isPoolAgeWhitelisted, parseMintSet } from '../src/utils/pool-age-whitelist';

const MINT_A = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT_B = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MINT_C = 'MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describe('parseMintSet', () => {
  it('produces an empty set for empty input', () => {
    expect(parseMintSet('').size).toBe(0);
  });

  it('trims, drops blanks, and dedupes', () => {
    expect(Array.from(parseMintSet(` ${MINT_A},, ${MINT_B} , ${MINT_A} `))).toEqual([
      MINT_A,
      MINT_B,
    ]);
  });
});

describe('isPoolAgeWhitelisted', () => {
  it('does not bypass when the whitelist is empty', () => {
    expect(isPoolAgeWhitelisted(MINT_A, MINT_B, parseMintSet(''))).toBe(false);
  });

  it('bypasses when either side of the pair is whitelisted', () => {
    expect(isPoolAgeWhitelisted(MINT_A, MINT_C, parseMintSet(MINT_A))).toBe(true);
    expect(isPoolAgeWhitelisted(MINT_C, MINT_B, parseMintSet(MINT_B))).toBe(true);
  });

  it('does not bypass when neither mint is whitelisted', () => {
    expect(isPoolAgeWhitelisted(MINT_A, MINT_B, parseMintSet(MINT_C))).toBe(false);
  });
});
