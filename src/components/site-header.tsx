import Link from "next/link";
import { BRAND_EN, BRAND_LOGO, BRAND_NAME } from "@/lib/brand";
import { t } from "@/lib/ui";
import { sessionCookieName, type SessionClaims } from "@/lib/auth";
import { isMerchantWallet } from "@/lib/telebirr/config";
import { SignOutButton } from "./sign-out-button";

export function SiteHeader({
  account,
  unreadNotices = 0,
}: {
  account: SessionClaims | null;
  unreadNotices?: number;
}) {
  return (
    <header>
      <div className="wrap nav">
        <Link href="/" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="logo">{BRAND_LOGO}</span>
          {BRAND_NAME} <span className="brand__en">{BRAND_EN}</span>
        </Link>

        <nav className="links">
          <Link href="/houses">{t("nav.houses")}</Link>
          <Link href="/me">
            {t("nav.mine")}
            {account && unreadNotices > 0 && (
              <span className="nav-badge num">{unreadNotices}</span>
            )}
          </Link>
          <Link href="/draws">{t("nav.draws")}</Link>
          {account && isMerchantWallet(account.phone) && (
            <Link href="/admin">{t("nav.dash")}</Link>
          )}
        </nav>

        <div className="nav-cta">
          {account ? (
            <>
              <span className="num" style={{ fontSize: 13, color: "var(--muted)" }}>
                {account.phone}
              </span>
              <SignOutButton cookieName={sessionCookieName} label={t("nav.signOut")} />
            </>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost">
                {t("nav.signIn")}
              </Link>
              <Link href="/register" className="btn btn-primary">
                {t("nav.openPortal")}
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
