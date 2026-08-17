import { describe, expect, it } from 'vitest';

import { formatReconcileScanLog } from '../src/executor/reconcile-log';

describe('formatReconcileScanLog', () => {
  it('truncates NFT mints to 8 chars and omits detail when absent', () => {
    expect(
      formatReconcileScanLog({
        scanned: 7,
        total: 372,
        targetNft: 'AVUPdSfvoP2748RmhJynFm13nfuRHUGwh76XbTQotu7D',
        ourNft: 'sma1KpwSBXMe5pGe1N5KEdFPbcMTmRpmsYd18A1m4RF',
        dex: 'byreal',
        status: 'checking',
      }),
    ).toBe('Reconcile scan 7/372: target=AVUPdSfv our=sma1KpwS dex=byreal status=checking');
  });

  it('appends the detail suffix when a detail is supplied', () => {
    expect(
      formatReconcileScanLog({
        scanned: 12,
        total: 372,
        targetNft: 'AzhU1vvkhmWGxZzSTEfmCnNxPdbfCLHxdwJ9JsYkt4E2',
        ourNft: 'AzhU1vvkhmWGxZzSTEfmCnNxPdbfCLHxdwJ9JsYkt4E2',
        dex: 'pancakeswap',
        status: 'skipped',
        detail: 'handled by pancakeswap reconciler',
      }),
    ).toBe(
      'Reconcile scan 12/372: target=AzhU1vvk our=AzhU1vvk dex=pancakeswap status=skipped detail=handled by pancakeswap reconciler',
    );
  });
});
