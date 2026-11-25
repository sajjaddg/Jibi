export interface SyntheticRecord {
  id: string;
  scope: string;
  kind: string;
  updatedAt: number;
  device: string;
  nonce: string;
  body: string;
}
export const DEFAULT_SHAPE: { sms: number; decisions: number; goals: number; days: number };
export function generateVault(options?: { seed?: number; scale?: number; scope?: string; now?: number }): SyntheticRecord[];
export function weigh(records: SyntheticRecord[]): { records: number; bodyBytes: number; wireBytes: number };
