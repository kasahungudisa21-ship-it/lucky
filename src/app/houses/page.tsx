import Link from "next/link";
import { houseSummaries } from "@/lib/repo";
import { formatEtb } from "@/lib/money";
import { text } from "@/lib/locale";
import { currentAccount } from "@/lib/auth";

export default async function HousesPage() {
  const t = await text();
  const [account, houses] = await Promise.all([currentAccount(), houseSummaries()]);

  return (
    <section>
      <div className="sec-head">
        <div>
          <h2>{t("houses.title")}</h2>
          <p>{t("houses.subtitle")}</p>
        </div>
        <span className="pill num">{houses.length}</span>
      </div>

      <div className="card card--flat" style={{ padding: 0, overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t("houses.col.house")}</th>
              <th>{t("houses.col.size")}</th>
              <th>{t("houses.col.price")}</th>
              <th>{t("house.fee")}</th>
              <th>{t("dash.forPrize")}</th>
              <th>{t("houses.col.pot")}</th>
              <th>{t("houses.col.taken")}</th>
              <th>{t("houses.col.free")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {houses.map((house) => {
              const complete = house.paidCount >= house.capacity;
              return (
                <tr key={house.id}>
                  <td className="num">
                    {t("house.name", [house.label])} · {t("houses.round")} {house.round}
                  </td>
                  <td className="num">{house.capacity}</td>
                  <td className="num">
                    {formatEtb(house.priceCents)} {t("common.birr")}
                  </td>
                  <td className="num">
                    {formatEtb(house.feeCents)} {t("common.birr")}
                  </td>
                  <td className="num">
                    {formatEtb(house.potPartCents)} {t("common.birr")}
                  </td>
                  <td className="num">
                    {formatEtb(house.potCents)} {t("common.birr")}
                  </td>
                  <td className="num">{house.paidCount + house.heldCount}</td>
                  <td className="num">{house.freeCount}</td>
                  <td>
                    {complete ? (
                      <span className="badge badge-full">{t("houses.completed")}</span>
                    ) : (
                      <Link href={account ? `/houses/${house.id}` : "/login"}>{t("houses.choose")}</Link>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="note">{t("rules.privacy")}</p>
    </section>
  );
}
