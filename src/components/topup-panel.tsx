"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatEtb } from "@/lib/money";
import { tr, type Lang } from "@/lib/ui";

/**
 * The gateway leg of a balance top-up. It shows no house, number or service
 * charge, because the money buys balance rather than a seat.
 */
export function TopupPanel({
  merchOrderId,
  amountCents,
  balanceCents,
  payee,
  status,
  mode,
  lang,
}: {
  merchOrderId: string;
  amountCents: number;
  /** the balance the ledger shows once this order is counted */
  balanceCents: number;
  payee: string | null;
  status: string;
  mode: "telebirr" | "simulate";
  lang: Lang;
}) {
  const t = tr(lang);
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
      // the same amount is the same intention: the service re-offers this order's
      // link instead of opening a second one at the gateway
      const response = await fetch("/api/wallet/topup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents }),
      });
      const payload = (await response.json()) as {
        checkoutUrl?: string;
        detail?: string;
        error?: string;
      };
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
          <span>{t("wallet.topupRow", [formatEtb(amountCents)])}</span>
          <b className="num">
            {formatEtb(amountCents)} {t("common.birr")}
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
          <div className="alert alert--ok">
            {t("wallet.topupDone", [formatEtb(amountCents), formatEtb(balanceCents)])}
          </div>
          <div className="form__btns">
            <Link href="/me" className="btn btn-primary">
              {t("wallet.title")}
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="note">{t("wallet.topupWallet", [formatEtb(amountCents)])}</p>
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
