"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { tr, type Lang } from "@/lib/ui";

/**
 * The owner's answer to a withdrawal request. Only "hand this over" moves money,
 * and the server re-reads the balance at that moment, so a refusal or a stale
 * request can never take cash out.
 */
export function WithdrawalActions({
  withdrawalId,
  lang,
}: {
  withdrawalId: string;
  lang: Lang;
}) {
  const t = tr(lang);
  const router = useRouter();
  const [busy, setBusy] = useState<"paid" | "rejected" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function answer(outcome: "paid" | "rejected") {
    setBusy(outcome);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/withdrawals/${withdrawalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      const payload = (await response.json().catch(() => ({}))) as { status?: string; error?: string };
      if (!response.ok || !payload.status) {
        setMessage(t("pay.failed"));
        return;
      }
      router.refresh();
    } catch {
      setMessage(t("pay.failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="form__btns">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => answer("paid")}
          disabled={busy !== null}
        >
          {t("dash.markPaid")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => answer("rejected")}
          disabled={busy !== null}
        >
          {t("dash.reject")}
        </button>
      </div>
      {message && <p className="note">{message}</p>}
    </div>
  );
}
