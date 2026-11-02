"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ballTones } from "@/lib/ball";
import { MAX_HELD_PER_HOUSE, SEAT_HOLD_MINUTES } from "@/lib/houses";
import { formatEtb } from "@/lib/money";
import { tr, type Lang } from "@/lib/ui";
import type { MySeat, SeatView } from "@/lib/repo";

const ERROR_KEYS: Record<string, string> = {
  number_taken: "error.numberTaken",
  number_limit: "error.numberLimit",
  house_closed: "error.houseClosed",
  number_out_of_range: "error.numberTaken",
  sign_in: "error.signIn",
  gateway: "pay.failed",
};

type Held = MySeat;

/** "9:41" — minutes and seconds left before an unpaid number goes back. */
function clockLeft(expiresAt: number, now: number) {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function HouseBoard({
  houseId,
  label,
  priceCents,
  feeCents,
  potPartCents,
  seats,
  mine,
  lang,
}: {
  houseId: string;
  label: string;
  priceCents: number;
  feeCents: number;
  potPartCents: number;
  seats: SeatView[];
  mine: Held[];
  lang: Lang;
}) {
  const t = tr(lang);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // numbers picked since the last server render, so the pay button appears at once
  const [picked, setPicked] = useState<Held[]>([]);
  const mineRows = [...mine, ...picked.filter((row) => !mine.some((held) => held.entryId === row.entryId))];

  // starts at zero so the first server render and the first client render agree —
  // a clock read during render would hydrate as a mismatch
  const [now, setNow] = useState(0);
  const lastReload = useRef(0);
  // the deadline list doubles as the effect key: a fresh hold restarts the clock,
  // and a row that disappeared server-side stops it
  const holdKey = mineRows
    .map((row) => (row.expiresAt ? Date.parse(row.expiresAt) : 0))
    .filter((ms) => ms > 0)
    .join(",");
  useEffect(() => {
    setNow(Date.now());
    const deadlines = holdKey === "" ? [] : holdKey.split(",").map(Number);
    if (deadlines.length === 0) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      // the sweep frees an expired hold whenever it next runs, so the board has to
      // re-read itself — otherwise a number already back in the pool still looks mine
      if (deadlines.some((ms) => ms <= at) && at - lastReload.current > 10_000) {
        lastReload.current = at;
        router.refresh();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [holdKey, router]);

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
      setPicked((rows) => [
        ...rows,
        {
          entryId: result.entryId,
          seatNumber: number,
          status: "pending_payment",
          expiresAt: new Date(Date.now() + SEAT_HOLD_MINUTES * 60_000).toISOString(),
        },
      ]);
      router.refresh();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function release(row: Held) {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/houses/${houseId}/seats/${row.seatNumber}?entryId=${row.entryId}`, { method: "DELETE" });
      setPicked((rows) => rows.filter((held) => held.entryId !== row.entryId));
      router.refresh();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pay(row: Held) {
    setBusy(true);
    setError(null);
    try {
      const result = await call(`/api/entries/${row.entryId}/pay`, { method: "POST" });
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
          {t(error, [MAX_HELD_PER_HOUSE])}
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
        {mineRows.length === 0 && (
          <div className="row total">
            <span>{t("house.pickTitle")}</span>
            <b className="num">{formatEtb(priceCents)} {t("common.birr")}</b>
          </div>
        )}
        {mineRows.map((row) => {
          const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : 0;
          return (
            <div className="row total" key={row.entryId}>
              <span>
                {t("house.selected", [row.seatNumber])}
                {expiresAt > 0 &&
                  now > 0 &&
                  (expiresAt > now ? (
                    <em className="mono"> {t("house.holdLeft", [clockLeft(expiresAt, now)])}</em>
                  ) : (
                    <em className="mono"> {t("house.holdGone")}</em>
                  ))}
              </span>
              <span className="places">
                <b className="num">{formatEtb(priceCents)} {t("common.birr")}</b>
                {row.status === "pending_payment" ? (
                  <>
                    <button type="button" className="btn btn-primary" onClick={() => pay(row)} disabled={busy}>
                      {t("house.pay", [formatEtb(priceCents)])}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => release(row)} disabled={busy}>
                      {t("house.release")}
                    </button>
                  </>
                ) : (
                  <span className="badge">{t("status.paid")}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <p className="note" style={{ color: "rgba(244,240,228,.6)" }}>
        {t("house.pickHint")}
      </p>
    </div>
  );
}
