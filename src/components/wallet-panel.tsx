"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { etbToCents, formatEtb } from "@/lib/money";
import { tr, type Lang } from "@/lib/ui";

const KIND_KEYS: Record<string, string> = {
  topup: "wallet.kindTopup",
  seat: "wallet.kindSeat",
  prize: "wallet.kindPrize",
  withdrawal: "wallet.kindWithdrawal",
  refund: "wallet.kindRefund",
};

export type WalletMovementView = {
  id: string;
  kind: string;
  deltaCents: number;
  at: string;
};

/**
 * The participant's money. Nothing here moves a balance on its own: a top-up is
 * handed to Telebirr and only lands when the gateway confirms it, a withdrawal
 * is a request the owner has to answer. The numbers shown are the ledger's.
 */
export function WalletPanel({
  balanceCents,
  movements,
  withdrawal,
  awaitingCents,
  minCents,
  maxCents,
  lang,
}: {
  balanceCents: number;
  movements: WalletMovementView[];
  withdrawal: { amountCents: number; status: string } | null;
  awaitingCents: number;
  minCents: number;
  maxCents: number;
  lang: Lang;
}) {
  const t = tr(lang);
  const router = useRouter();
  const [topupBirr, setTopupBirr] = useState("");
  const [withdrawBirr, setWithdrawBirr] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const birr = (cents: number) => formatEtb(cents);
  const topupCents = etbToCents(Number(topupBirr) || 0);
  const withdrawCents = etbToCents(Number(withdrawBirr) || 0);

  const rangeMessage = (low: number, high: number) => t("wallet.min", [birr(low), birr(high)]);
  const withdrawRange = (low: number, high: number) => t("wallet.withdrawRange", [birr(low), birr(high)]);

  async function addBalance() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/wallet/topup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: topupCents }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        checkoutUrl?: string;
        detail?: string;
        error?: string;
      };
      if (!response.ok || !payload.checkoutUrl) {
        setMessage(
          payload.error === "invalid_amount" || payload.error === "amount_out_of_range"
            ? rangeMessage(minCents, maxCents)
            : (payload.detail ?? t("pay.notConfigured")),
        );
        return;
      }
      window.location.assign(payload.checkoutUrl);
    } catch {
      setMessage(t("pay.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function askWithdrawal() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/wallet/withdrawal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: withdrawCents }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        requested?: boolean;
        error?: string;
        balanceCents?: number;
      };
      if (!response.ok || !payload.requested) {
        if (payload.error === "pending_exists") {
          setMessage(t("wallet.withdrawPending", [birr(withdrawCents)]));
        } else if (payload.error === "insufficient_balance") {
          setMessage(withdrawRange(minCents, payload.balanceCents ?? 0));
        } else {
          setMessage(withdrawRange(minCents, Math.min(maxCents, balanceCents)));
        }
        return;
      }
      setWithdrawBirr("");
      router.refresh();
    } catch {
      setMessage(t("pay.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="rows">
        <div className="row total">
          <span>{t("wallet.balance")}</span>
          <b className="num">
            {birr(balanceCents)} {t("common.birr")}
          </b>
        </div>
        {awaitingCents > 0 && (
          <div className="row">
            <span>{t("wallet.awaitingTopup")}</span>
            <b className="num">
              {birr(awaitingCents)} {t("common.birr")}
            </b>
          </div>
        )}
        {withdrawal && (
          <div className="row">
            <span>{t("wallet.withdraw")}</span>
            <b className="num">
              {birr(withdrawal.amountCents)} {t("common.birr")}
            </b>
            <span className="badge">
              {withdrawal.status === "paid"
                ? t("wallet.withdrawPaid")
                : withdrawal.status === "rejected"
                  ? t("wallet.withdrawRejected")
                  : t("dash.pending")}
            </span>
          </div>
        )}
      </div>

      {message && <div className="alert">{message}</div>}

      <div>
        <label className="fld" htmlFor="wallet-topup">
          {t("wallet.amount")}
        </label>
        <input
          id="wallet-topup"
          type="number"
          inputMode="decimal"
          min={minCents / 100}
          max={maxCents / 100}
          step={1}
          value={topupBirr}
          onChange={(event) => setTopupBirr(event.target.value)}
        />
        <p className="note">{rangeMessage(minCents, maxCents)}</p>
        <div className="form__btns">
          <button
            type="button"
            className="btn btn-primary"
            onClick={addBalance}
            disabled={busy || topupCents < minCents || topupCents > maxCents}
          >
            {t("wallet.topup")}
          </button>
        </div>
      </div>

      <div>
        <label className="fld" htmlFor="wallet-withdraw">
          {t("wallet.withdrawAmount")}
        </label>
        <input
          id="wallet-withdraw"
          type="number"
          inputMode="decimal"
          min={minCents / 100}
          max={balanceCents / 100}
          step={1}
          value={withdrawBirr}
          onChange={(event) => setWithdrawBirr(event.target.value)}
        />
        <p className="note">
          {balanceCents < minCents ? t("wallet.empty") : withdrawRange(minCents, balanceCents)}
        </p>
        <div className="form__btns">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={askWithdrawal}
            disabled={
              busy ||
              withdrawal?.status === "pending" ||
              withdrawCents < minCents ||
              withdrawCents > balanceCents
            }
          >
            {t("wallet.withdrawButton")}
          </button>
        </div>
      </div>

      <div>
        <label className="fld">{t("wallet.history")}</label>
        {movements.length === 0 ? (
          <p className="note">{t("wallet.empty")}</p>
        ) : (
          <div className="rows">
            {movements.map((movement) => (
              <div className="row" key={movement.id}>
                <span>{KIND_KEYS[movement.kind] ? t(KIND_KEYS[movement.kind]) : movement.kind}</span>
                <b className="num">
                  {movement.deltaCents >= 0 ? "+" : "-"}
                  {birr(Math.abs(movement.deltaCents))} {t("common.birr")}
                </b>
                <span className="mono">{movement.at}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
