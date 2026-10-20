import { formatEtb } from "@/lib/money";
import { t } from "@/lib/ui";

/**
 * Participant-facing message text. Like the owner alerts it is built from the
 * generated catalogue, and it names houses, rounds and numbers only — a phone
 * number never enters a notice, because the notice is delivered TO that number.
 */

export const placeLabel = (place: number) =>
  place === 1 ? t("draws.place1") : place === 2 ? t("draws.place2") : t("draws.place3");

export function paymentNotice(input: { label: string; round: number; seatNumber: number }): string {
  return t("notice.payment", [input.label, input.round, input.seatNumber]);
}

export function wonNotice(input: {
  label: string;
  round: number;
  seatNumber: number;
  place: number;
  cents: number;
}): string {
  // the sentence already ends in "ብር", so the amount goes in bare
  return t("notice.won", [
    input.label,
    input.round,
    input.seatNumber,
    placeLabel(input.place),
    formatEtb(input.cents),
  ]);
}

export function closedNotice(input: { label: string }): string {
  return t("notice.closed", [input.label]);
}

export function linkedNotice(): string {
  return t("notice.linked", []);
}
