/** Order prices on the wire and in EIP-712 are decicents (tenths of a cent): 10 = 1.0¢, 600 = 60¢. */
export const PRICE_CROSS = 1000;
export const MIN_DECICENTS = 10;
export const MAX_DECICENTS = 990;

export function centsToDecicents(cents: number): number {
  return Math.round(cents * 10);
}

export function decicentsToCents(d: number): number {
  return d / 10;
}

export function complementAsk(noBidDecicents: number): number {
  return PRICE_CROSS - noBidDecicents;
}

/** Format decicents for ¢ labels (`60`, `4.5`). */
export function fmtPriceDecicents(d: number): string {
  if (!Number.isFinite(d)) return "—";
  if (d % 10 === 0) return String(d / 10);
  return `${Math.trunc(d / 10)}.${d % 10}`;
}

export function priceTickOk(decicents: number): boolean {
  if (!Number.isInteger(decicents) || decicents < MIN_DECICENTS || decicents > MAX_DECICENTS) return false;
  if (decicents < 50 || decicents > 950) return true;
  return decicents % 10 === 0;
}
