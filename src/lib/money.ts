const CENTS_PER_ETB = 100;

export const etbToCents = (etb: number) => Math.round(etb * CENTS_PER_ETB);

export const formatEtb = (cents: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(cents / CENTS_PER_ETB);

/** Telebirr amounts are decimal strings with two fraction digits. */
export const centsToTelebirrAmount = (cents: number) =>
  (cents / CENTS_PER_ETB).toFixed(2);
