"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { t } from "@/lib/ui";

// A round that is not fully paid is the only reason a push can fail here, so
// every skip is reported as that rather than as an unexplained error.
function skipText(reason: string | undefined) {
  if (reason === "closed") return t("error.houseClosed");
  return t("admin.notFull");
}

export function DrawButton({ houseId }: { houseId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pushDraw() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/houses/${houseId}/draw`, { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        drawn?: boolean;
        reason?: string;
      };
      if (!response.ok) {
        setMessage(t("dash.errored"));
        return;
      }
      setMessage(payload.drawn ? t("event.draw_settled") : skipText(payload.reason));
      if (payload.drawn) router.refresh();
    } catch {
      setMessage(t("dash.errored"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <button type="button" className="btn btn-ghost" onClick={pushDraw} disabled={busy}>
        {t("admin.draw")}
      </button>
      {message && <p className="note">{message}</p>}
    </div>
  );
}
