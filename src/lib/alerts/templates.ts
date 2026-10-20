import { formatEtb } from "@/lib/money";
import { t } from "@/lib/ui";

/**
 * Owner-facing message text. Everything is built from the generated Amharic
 * catalogue so an alert says exactly what the pages say, and it names houses and
 * numbers only — a participant's phone number never enters a message.
 */

export type AlertBody = { subject: string; text: string };

const birr = (cents: number) => `${formatEtb(cents)} ${t("common.birr")}`;

export function paymentSettledAlert(input: {
  label: string;
  round: number;
  seatNumber: number;
  amountCents: number;
}): AlertBody {
  return {
    subject: t("alert.paymentSubject", [input.label]),
    text: t("alert.payment", [
      input.label,
      input.round,
      input.seatNumber,
      birr(input.amountCents),
    ]),
  };
}

export type PlaceLine = { seatNumber: number; cents: number };

export function drawSettledAlert(input: {
  label: string;
  round: number;
  participantCount: number;
  potCents: number;
  first: PlaceLine;
  second: PlaceLine;
  third: PlaceLine;
}): AlertBody {
  const line = (label: string, place: PlaceLine) =>
    `${label} #${place.seatNumber} - ${birr(place.cents)}`;
  return {
    subject: t("alert.drawSubject", [input.label]),
    text: [
      t("alert.draw", [
        input.label,
        input.round,
        input.participantCount,
        birr(input.potCents),
      ]),
      line(t("draws.place1"), input.first),
      line(t("draws.place2"), input.second),
      line(t("draws.place3"), input.third),
    ].join("\n"),
  };
}

/** One message per house per sweep, so a busy house does not send one SMS a number. */
export function holdExpiredAlert(input: {
  label: string;
  numbers: number[];
}): AlertBody {
  const shown = input.numbers.slice(0, 10).join(", ");
  const rest = input.numbers.length - Math.min(10, input.numbers.length);
  return {
    subject: t("alert.holdSubject", [input.label]),
    text: t("alert.holdExpired", [input.label, rest > 0 ? `${shown} +${rest}` : shown]),
  };
}

/** Money arrived for a number that was already handed to somebody else. */
export function orphanPaymentAlert(input: {
  merchOrderId: string;
  label: string;
  seatNumber: number;
  amountCents: number;
}): AlertBody {
  return {
    subject: t("alert.orphanSubject", [input.label]),
    text: t("alert.orphan", [
      input.label,
      input.seatNumber,
      birr(input.amountCents),
      input.merchOrderId,
    ]),
  };
}

export function gatewayErrorAlert(reason: string): AlertBody {
  return {
    subject: t("alert.gatewaySubject"),
    // the gateway's own words stay ASCII, they are not part of the catalogue
    text: `${t("alert.gateway")}: ${reason.slice(0, 200)}`,
  };
}
