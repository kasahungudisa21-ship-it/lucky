import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { HouseBoard } from "@/components/house-board";
import { currentAccount } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { houseDetail } from "@/lib/repo";
import { formatEtb } from "@/lib/money";
import { fullHousePotCents, fullHousePrizeShares, priceBreakdown } from "@/lib/pricing";
import { currentLang, text } from "@/lib/locale";

export default async function HousePage({ params }: { params: Promise<{ houseId: string }> }) {
  const [t, lang] = await Promise.all([text(), currentLang()]);
  const { houseId } = await params;
  const account = await currentAccount();
  if (!account) redirect("/login");

  const detail = await houseDetail(houseId, account.accountId);
  if (!detail) notFound();

  const draws = await prisma.draw.findMany({
    where: { houseId },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const price = priceBreakdown(detail.house);
  const shares = fullHousePrizeShares(detail.house);

  return (
    <section>
      <div className="sec-head">
        <div>
          <h2>{t("house.name", [detail.house.label])}</h2>
          <p>{t("house.title", [detail.house.capacity])}</p>
        </div>
        <span className="pill num">
          {t("houses.round")} {detail.house.round}
        </span>
      </div>

      <div className="split">
        <div className="stack">
          <div className="price-box" style={{ marginTop: 0 }}>
            <div>
              <span>{t("houses.col.price")}</span>
              <b className="num">
                {formatEtb(price.priceCents)} {t("common.birr")}
              </b>
            </div>
            <div className="hl">
              <span>{t("houses.col.pot")}</span>
              <b className="num">
                {formatEtb(fullHousePotCents(detail.house))} {t("common.birr")}
              </b>
            </div>
            <div>
              <span>{t("house.fee")}</span>
              <b className="num">
                {formatEtb(price.serviceFeeCents)} {t("common.birr")}
              </b>
            </div>
            <div>
              <span>{t("dash.forPrize")}</span>
              <b className="num">
                {formatEtb(price.potPartCents)} {t("common.birr")}
              </b>
            </div>
          </div>

          <div className="rows">
            <div className="row">
              <span>{t("draws.place1")}</span>
              <b className="num">
                {formatEtb(shares.firstCents)} {t("common.birr")}
              </b>
            </div>
            <div className="row">
              <span>{t("draws.place2")}</span>
              <b className="num">
                {formatEtb(shares.secondCents)} {t("common.birr")}
              </b>
            </div>
            <div className="row">
              <span>{t("draws.place3")}</span>
              <b className="num">
                {formatEtb(shares.thirdCents)} {t("common.birr")}
              </b>
            </div>
          </div>

          <p className="note">{t("rules.draw")}</p>
          <Link href="/houses" className="btn btn-ghost">
            {t("common.back")}
          </Link>
        </div>

        <HouseBoard
          lang={lang}
          houseId={detail.house.id}
          label={detail.house.label}
          priceCents={price.priceCents}
          feeCents={price.serviceFeeCents}
          potPartCents={price.potPartCents}
          seats={detail.seats}
          mine={detail.mine}
        />
      </div>

      {draws.length > 0 && (
        <div className="rows" style={{ marginTop: 18 }}>
          {draws.map((draw) => (
            <div className="row" key={draw.id}>
              <span>
                {t("houses.round")} {draw.round} ·{" "}
                <span className="mono">{draw.commitment.slice(0, 16)}</span>
              </span>
              <span className="places">
                <b className="num">
                  {t("draws.place1")} #{draw.winnerSeatNumber} · {formatEtb(draw.firstCents)}{" "}
                  {t("common.birr")}
                </b>
                {draw.secondSeatNumber !== null && (
                  <b className="num">
                    {t("draws.place2")} #{draw.secondSeatNumber} · {formatEtb(draw.secondCents)}{" "}
                    {t("common.birr")}
                  </b>
                )}
                {draw.thirdSeatNumber !== null && (
                  <b className="num">
                    {t("draws.place3")} #{draw.thirdSeatNumber} · {formatEtb(draw.thirdCents)}{" "}
                    {t("common.birr")}
                  </b>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
