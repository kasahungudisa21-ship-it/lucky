"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { tr, type Lang } from "@/lib/ui";

const ERROR_KEYS: Record<string, string> = {
  invalid_phone: "error.phone",
  invalid_pin: "error.pin",
  pin_mismatch: "error.pinMismatch",
  accept_required: "error.accept",
  login_failed: "error.login",
  exists: "error.exists",
};

export function AuthForm({ mode, lang }: { mode: "register" | "login"; lang: Lang }) {
  const t = tr(lang);
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === "register";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/auth/${isRegister ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isRegister ? { phone, pin, pinConfirm, accepted } : { phone, pin },
        ),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(ERROR_KEYS[payload.error ?? ""] ?? "error.login");
        return;
      }
      router.push("/houses");
      router.refresh();
    } catch {
      setError("error.login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card card--flat" onSubmit={submit}>
      <div className="sec-head" style={{ marginBottom: 6 }}>
        <div>
          <h2 style={{ paddingLeft: 0, fontSize: 24 }}>{isRegister ? t("auth.registerTitle") : t("auth.signInTitle")}</h2>
        </div>
      </div>

      {error && <div className="alert">{t(error)}</div>}

      <label className="fld" htmlFor="phone">
        {t("auth.phone")}
      </label>
      <input
        id="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        placeholder="0912345678"
        required
      />
      <p className="note">{t("auth.phoneHint")}</p>

      <label className="fld" htmlFor="pin">
        {t("auth.pin")}
      </label>
      <input
        id="pin"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        pattern="\d{4,6}"
        maxLength={6}
        value={pin}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
        required
      />
      <p className="note">{t("auth.pinHint")}</p>

      {isRegister && (
        <>
          <label className="fld" htmlFor="pinConfirm">
            {t("auth.pinConfirm")}
          </label>
          <input
            id="pinConfirm"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={pinConfirm}
            onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, "").slice(0, 6))}
            required
          />

          <button
            type="button"
            className="switch"
            data-on={accepted}
            role="switch"
            aria-checked={accepted}
            onClick={() => setAccepted((current) => !current)}
          >
            <span className="track">
              <span className="knob" />
            </span>
            <span>{t("auth.accept")}</span>
          </button>
        </>
      )}

      <div className="form__btns">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {isRegister ? t("auth.submitRegister") : t("auth.submitSignIn")}
        </button>
      </div>

      <p className="note">{t("auth.privacyNote")}</p>
    </form>
  );
}
