import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { Stage } from "@/components/stage";
import { BRAND_EN, BRAND_NAME } from "@/lib/brand";
import { t } from "@/lib/ui";
import { currentAccount } from "@/lib/auth";
import { unreadNoticeCount } from "@/lib/repo";

export const metadata: Metadata = {
  title: t("brand.tagline"),
  description: t("hero.title"),
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const account = await currentAccount();
  const unread = account ? await unreadNoticeCount(account.accountId) : 0;

  return (
    <html lang="am">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- the rule targets pages/_document, this app is App Router */}
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+Ethiopic:wght@400;500;600;700&family=Noto+Serif+Ethiopic:wght@600;700&family=Space+Grotesk:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Stage />
        <SiteHeader account={account} unreadNotices={unread} />
        <div className="wrap">{children}</div>
        <footer>
          <div className="wrap">
            <b>
              {BRAND_NAME} · {BRAND_EN}
            </b>{" "}
            · {t("footer.note")}
          </div>
        </footer>
      </body>
    </html>
  );
}
