"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatEtb } from "@/lib/money";
import { t } from "@/lib/ui";

export function PayPanel({
  merchOrderId,
  entryId,
  houseId,
  seatNumber,
  label,
  prizeCents,
  feeCents,
  amountCents,
  payee,
  status,
  mode,
}: {
  merchOrderId: string;
  entryId: string;
  houseId: string;
  seatNumber: number;
  label: string;
  prizeCents: number;
  feeCents: number;
  amountCents: number;
  payee: string | null;
  status: string;
  mode: "telebirr" | "simulate";
}) {
  const router = useRouter();
  const [paid, setPaid] = useState(status === "success");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (paid) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/payments/${merchOrderId}`, { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { paid?: boolean };
      if (payload.paid) {
        setPaid(true);
        router.refresh();
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [paid, merchOrderId, router]);

  async function openCheckout() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/entries/${entryId}/pay`, { method: "POST" });
      const payload = (await response.json()) as { checkoutUrl?: string; detail?: string; error?: string };
      if (!response.ok || !payload.checkoutUrl) {
        setMessage(payload.detail ?? t("pay.notConfigured"));
        return;
      }
      window.location.assign(payload.checkoutUrl);
    } catch {
      setMessage(t("pay.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function simulatePaid() {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/payments/${merchOrderId}`, { method: "POST" });
    setBusy(false);
    const payload = (await response.json().catch(() => ({}))) as { settled?: boolean };
    if (!response.ok || !payload.settled) {
      setMessage(t("pay.failed"));
      return;
    }
    setPaid(true);
    router.refresh();
  }

  return (
    <div className="stack">
      <div className="rows">
        <div className="row">
          <span>
            {t("house.name", [label])} · {t("common.number")} {seatNumber} · {t("dash.forPrize")}
          </span>
          <b className="num">
            {formatEtb(prizeCents)} {t("common.birr")}
          </b>
        </div>
        <div className="row">
          <span>{t("house.fee")}</span>
          <b className="num">
            {formatEtb(feeCents)} {t("common.birr")}
          </b>
        </div>
        <div className="row total">
          <span>{t("common.amount")}</span>
          <b className="num">
            {formatEtb(amountCents)} {t("common.birr")}
          </b>
        </div>
      </div>

      {payee && <p className="note mono">{t("pay.payee", [payee])}</p>}

      {message && <div className="alert">{message}</div>}

      {paid ? (
        <>
          <div className="alert alert--ok">{t("pay.done", [seatNumber])}</div>
          <div className="form__btns">
            <Link href={`/houses/${houseId}`} className="btn btn-primary">
              {t("nav.houses")}
            </Link>
            <Link href="/me" className="btn btn-ghost">
              {t("nav.mine")}
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="note">{t("pay.wallet", [formatEtb(amountCents), seatNumber])}</p>
          <p className="note">{t("pay.waiting")}</p>
          <div className="form__btns">
            <button type="button" className="btn btn-primary" onClick={openCheckout} disabled={busy}>
              {t("pay.open")}
            </button>
            {mode === "simulate" && (
              <button type="button" className="btn btn-ghost" onClick={simulatePaid} disabled={busy}>
                {t("pay.simulateButton")}
              </button>
            )}
          </div>
          {mode === "simulate" && <p className="note">{t("pay.simulated")}</p>}
        </>
      )}
    </div>
  );
}
