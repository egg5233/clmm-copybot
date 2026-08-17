import assert from 'assert';
import { isPoolAgeWhitelisted, parseMintSet } from '../src/utils/pool-age-whitelist';

const MINT_A = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT_B = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MINT_C = 'MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

{
  const parsed = parseMintSet('');
  assert.equal(parsed.size, 0, 'empty input should produce an empty set');
  assert.equal(isPoolAgeWhitelisted(MINT_A, MINT_B, parsed), false, 'empty whitelist should not bypass');
}

{
  const parsed = parseMintSet(` ${MINT_A},, ${MINT_B} , ${MINT_A} `);
  assert.deepEqual(Array.from(parsed), [MINT_A, MINT_B], 'parser should trim, drop blanks, and dedupe');
}

{
  const whitelistA = parseMintSet(MINT_A);
  assert.equal(isPoolAgeWhitelisted(MINT_A, MINT_C, whitelistA), true, 'mintA hit should bypass');

  const whitelistB = parseMintSet(MINT_B);
  assert.equal(isPoolAgeWhitelisted(MINT_C, MINT_B, whitelistB), true, 'mintB hit should bypass');

  const whitelistNone = parseMintSet(MINT_C);
  assert.equal(isPoolAgeWhitelisted(MINT_A, MINT_B, whitelistNone), false, 'absent mints should not bypass');
}

