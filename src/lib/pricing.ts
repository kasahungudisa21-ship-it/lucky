// Pricing for one participant in a house.
// A participant pays exactly the price the house carries. The service charge is
// cut out of that money — a quarter of it — and only what is left builds the
// prize pool, so a filled house pays out three quarters of its takings.

/** the share of every payment kept by the platform */
export const SERVICE_RATE = 0.25;

/** the two stored figures a price is worked out from */
export type HousePricing = {
  capacity: number;
  priceCents: number;
};

/** the charge taken out of a participant's payment */
export const serviceFeeCents = (house: HousePricing) =>
  Math.round(house.priceCents * SERVICE_RATE);

/** the part of one payment that goes to the prizes */
export const potPartCents = (house: HousePricing) => house.priceCents - serviceFeeCents(house);

/** prize pot of a filled house — the service charge stays out of it */
export const fullHousePotCents = (house: HousePricing) => house.capacity * potPartCents(house);

/** the part of a settled entry that belongs to the pot */
export const entryPriceCents = (entry: { amountCents: number; feeCents: number }) =>
  entry.amountCents - entry.feeCents;

export type PrizeShares = {
  firstCents: number;
  secondCents: number;
  thirdCents: number;
};

/**
 * The whole pot is paid out: 2nd place gets a quarter, 3rd an eighth and 1st
 * the rest (5/8), so rounding can never leave a cent unpclaimed.
 */
export const prizeShares = (potCents: number): PrizeShares => {
  const secondCents = Math.round(potCents / 4);
  const thirdCents = Math.round(potCents / 8);
  return { firstCents: potCents - secondCents - thirdCents, secondCents, thirdCents };
};

export const fullHousePrizeShares = (house: HousePricing) => prizeShares(fullHousePotCents(house));

export type PriceBreakdown = {
  /** what the participant is charged */
  priceCents: number;
  /** the part of that money kept as the service charge */
  serviceFeeCents: number;
  /** the part of that money that goes to the prizes */
  potPartCents: number;
};

export const priceBreakdown = (house: HousePricing): PriceBreakdown => ({
  priceCents: house.priceCents,
  serviceFeeCents: serviceFeeCents(house),
  potPartCents: potPartCents(house),
});
