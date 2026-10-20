import Link from "next/link";
import { houseSummaries } from "@/lib/repo";
import { formatEtb } from "@/lib/money";
import { t } from "@/lib/ui";
import { currentAccount } from "@/lib/auth";
import { gatewayStatus } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const account = await currentAccount();
  const gateway = gatewayStatus();
  const houses = await houseSummaries();
  const prices = houses.map((house) => house.priceCents);
  const lowestCents = Math.min(...prices);
  const highestCents = Math.max(...prices);

  return (
    <>
      <div className="hero hero--grid">
        <div>
          <span className="eyebrow">{t("brand.demo")}</span>
          <h1>{t("hero.title")}</h1>
          <p>{t("hero.body")}</p>
          <p className="note">{t("hero.rule")}</p>
          <div className="form__btns">
            <Link href={account ? "/houses" : "/register"} className="btn btn-primary">
              {account ? t("nav.houses") : t("nav.register")}
            </Link>
            <Link href="/draws" className="btn btn-ghost">
              {t("nav.draws")}
            </Link>
          </div>
        </div>

        <div className="stats">
          <div className="stat">
            <i style={{ background: "var(--gold)" }} />
            <b className="num">{houses.length}</b>
            <span>{t("stats.houses")}</span>
          </div>
          <div className="stat">
            <i style={{ background: "var(--teal)" }} />
            <b className="num">{houses.reduce((sum, house) => sum + house.capacity, 0)}</b>
            <span>{t("stats.slots")}</span>
          </div>
          <div className="stat">
            <i style={{ background: "var(--violet)" }} />
            <b className="num">
              {formatEtb(lowestCents)} - {formatEtb(highestCents)}
            </b>
            <span>
              {t("houses.col.price")} · {t("common.birr")}
            </span>
          </div>
          <div className="stat">
            <i style={{ background: "var(--sky)" }} />
            <b className="num">{t("stats.draw")}</b>
            <span>{t("nav.draws")}</span>
          </div>
        </div>
      </div>

      <section>
        <div className="sec-head">
          <div>
            <h2>{t("rules.title")}</h2>
          </div>
        </div>
        <div className="grid g-2">
          <div className="card rule">
            <i>#</i>
            <div>
              <b>{t("houses.col.price")}</b>
              <p>{t("rules.price")}</p>
            </div>
          </div>
          <div className="card rule">
            <i>+</i>
            <div>
              <b>{t("house.fee")}</b>
              <p>{t("rules.fee")}</p>
            </div>
          </div>
          <div className="card rule">
            <i>{houses.length}</i>
            <div>
              <b>{t("nav.houses")}</b>
              <p>{t("rules.pick")}</p>
            </div>
          </div>
          <div className="card rule">
            <i>T</i>
            <div>
              <b>{t("pay.title")}</b>
              <p>{t("rules.pay")}</p>
            </div>
          </div>
          <div className="card rule">
            <i>◆</i>
            <div>
              <b>{t("draws.title")}</b>
              <p>{t("rules.draw")}</p>
            </div>
          </div>
        </div>
        <p className="note">{t("rules.privacy")}</p>

        {!gateway.configured && (
          <div className="alert alert--warn" style={{ marginTop: 16 }}>
            {t("pay.notConfigured")}
            <div className="mono" style={{ marginTop: 6 }}>
              {t("pay.missingVariables", [gateway.missingVariables.join(", ")])}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
