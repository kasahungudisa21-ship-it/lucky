"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { tr, type Lang } from "@/lib/ui";

export function MarkReadButton({ lang }: { lang: Lang }) {
  const t = tr(lang);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function markRead() {
    setBusy(true);
    try {
      const response = await fetch("/api/notices/read", { method: "POST" });
      if (response.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn btn-ghost" onClick={markRead} disabled={busy}>
      {t("mine.markRead")}
    </button>
  );
}
