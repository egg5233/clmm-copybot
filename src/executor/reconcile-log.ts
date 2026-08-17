export type ReconcileScanStatus =
  | 'checking'
  | 'active'
  | 'orphan'
  | 'skipped'
  | 'transient-error';

export interface ReconcileScanLogInput {
  scanned: number;
  total: number;
  targetNft: string;
  ourNft: string;
  dex?: string;
  status: ReconcileScanStatus;
  detail?: string;
}

export function formatReconcileScanLog(input: ReconcileScanLogInput): string {
  const dex = input.dex || 'byreal';
  const base = `Reconcile scan ${input.scanned}/${input.total}: target=${input.targetNft.slice(0, 8)} our=${input.ourNft.slice(0, 8)} dex=${dex} status=${input.status}`;
  return input.detail ? `${base} detail=${input.detail}` : base;
}
