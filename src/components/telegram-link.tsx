"use client";

import { useState } from "react";
import { t } from "@/lib/ui";

/**
 * Telegram cannot be reached by phone number, so the participant opens the bot
 * themselves through the link this hands out. The chat id lands on the account a
 * few seconds later when the telegram job reads the bot's inbox.
 */
export function TelegramLink({ linked, offered }: { linked: boolean; offered: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  async function requestLink() {
    setBusy(true);
    setUnavailable(false);
    try {
      const response = await fetch("/api/notices/telegram", { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { url?: string };
      if (!response.ok || !payload.url) {
        setUnavailable(true);
        return;
      }
      setUrl(payload.url);
    } catch {
      setUnavailable(true);
    } finally {
      setBusy(false);
    }
  }

  if (linked) return <p className="note">{t("mine.linked")}</p>;
  if (!offered) return <p className="note">{t("mine.notConfigured")} {t("mine.inAppOnly")}</p>;

  return (
    <div className="stack">
      <button type="button" className="btn btn-ghost" onClick={requestLink} disabled={busy}>
        {t("mine.linkTelegram")}
      </button>
      {url && (
        <p className="note">
          <a href={url} target="_blank" rel="noreferrer" className="mono">
            {url}
          </a>{" "}
          {t("mine.linkHint")}
        </p>
      )}
      {unavailable && <p className="note">{t("mine.notConfigured")}</p>}
    </div>
  );
}
