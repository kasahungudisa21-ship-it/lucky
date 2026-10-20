"use client";

import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";
import { ballTones } from "@/lib/ball";
import { formatEtb } from "@/lib/money";
import { t } from "@/lib/ui";
import type { SeatView } from "@/lib/repo";

const ERROR_KEYS: Record<string, string> = {
  number_taken: "error.numberTaken",
  already_holds_number: "error.alreadyHolds",
  house_closed: "error.houseClosed",
  number_out_of_range: "error.numberTaken",
  sign_in: "error.signIn",
  gateway: "pay.failed",
};

export function HouseBoard({
  houseId,
  label,
  priceCents,
  feeCents,
  potPartCents,
  seats,
  mine,
}: {
  houseId: string;
  label: string;
  priceCents: number;
  feeCents: number;
  potPartCents: number;
  seats: SeatView[];
  mine: { entryId: string; seatNumber: number; status: string } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState(mine);

  const free = seats.filter((seat) => seat.status === "free").length;
  // counted as taken whether held or paid, so free + taken always equals capacity
  const taken = seats.length - free;

  async function call(path: string, init: RequestInit) {
    const response = await fetch(path, init);
    const payload = (await response.json().catch(() => ({}))) as Record<string, string>;
    if (!response.ok) throw new Error(ERROR_KEYS[payload.error ?? ""] ?? "pay.failed");
    return payload;
  }

  async function pick(number: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await call(`/api/houses/${houseId}/seats/${number}`, { method: "POST" });
      setHeld({ entryId: result.entryId, seatNumber: number, status: "pending_payment" });
      router.refresh();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    if (!held) return;
    setBusy(true);
    setError(null);
    try {
      await call(`/api/houses/${houseId}/seats/${held.seatNumber}?entryId=${held.entryId}`, {
        method: "DELETE",
      });
      setHeld(null);
      router.refresh();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!held) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call(`/api/entries/${held.entryId}/pay`, { method: "POST" });
      window.location.assign(result.checkoutUrl);
    } catch (issue) {
      setError((issue as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="board">
      <div className="board__head">
        <b className="num" style={{ fontSize: 19 }}>
          {t("house.name", [label])}
        </b>
        <span className="num" style={{ color: "rgba(244,240,228,.62)" }}>
          {t("house.priceRule", [formatEtb(priceCents)])}
        </span>
      </div>

      {error && (
        <div className="alert" style={{ marginTop: 14 }}>
          {t(error)}
        </div>
      )}

      <div className="tlist">
        {seats.map((seat) => {
          const tone = ballTones(seat.number);
          return (
            <button
              key={seat.number}
              type="button"
              className="tchip"
              data-status={seat.status}
              style={{ "--ball": tone.solid, "--ball-soft": tone.soft } as CSSProperties}
              disabled={busy || seat.status !== "free"}
              onClick={() => pick(seat.number)}
              title={t("common.number") + " " + seat.number}
            >
              {seat.number}
              {seat.status === "mine" && <i>{t("house.mineLabel")}</i>}
            </button>
          );
        })}
      </div>

      <div className="legend">
        <span>
          <em style={{ background: "rgba(244,240,228,.06)" }} /> {t("status.free")}
        </span>
        <span>
          <em style={{ background: "var(--gold)" }} /> {t("status.held")}
        </span>
        <span>
          <em style={{ background: "rgba(244,240,228,.86)" }} /> {t("status.paid")}
        </span>
        <span>
          <em style={{ background: "var(--teal)" }} /> {t("house.mineLabel")}
        </span>
      </div>

      <div className="rows">
        <div className="row">
          <span>{t("houses.col.free")}</span>
          <b className="num">{free}</b>
        </div>
        <div className="row">
          <span>{t("houses.col.taken")}</span>
          <b className="num">{taken}</b>
        </div>
        <div className="row">
          <span>{t("houses.col.price")}</span>
          <b className="num">{formatEtb(priceCents)} {t("common.birr")}</b>
        </div>
        <div className="row">
          <span>{t("house.fee")}</span>
          <b className="num">{formatEtb(feeCents)} {t("common.birr")}</b>
        </div>
        <div className="row">
          <span>{t("dash.forPrize")}</span>
          <b className="num">{formatEtb(potPartCents)} {t("common.birr")}</b>
        </div>
        <div className="row total">
          <span>{held ? t("house.selected", [held.seatNumber]) : t("house.pickTitle")}</span>
          <b className="num">{formatEtb(priceCents)} {t("common.birr")}</b>
        </div>
      </div>

      <div className="form__btns board__foot">
        {held && held.status === "pending_payment" && (
          <>
            <button type="button" className="btn btn-primary" onClick={pay} disabled={busy}>
              {t("house.pay", [formatEtb(priceCents)])}
            </button>
            <button type="button" className="btn btn-ghost" onClick={release} disabled={busy}>
              {t("house.release")}
            </button>
          </>
        )}
        {held && held.status === "paid" && (
          <button type="button" className="btn btn-ghost" onClick={() => router.push(`/me`)}>
            {t("nav.mine")}
          </button>
        )}
      </div>

      <p className="note" style={{ color: "rgba(244,240,228,.6)" }}>
        {t("house.pickHint")}
      </p>
    </div>
  );
}
