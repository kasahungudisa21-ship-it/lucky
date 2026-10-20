import { Ball } from "@/components/ball";
import { recentDraws } from "@/lib/repo";
import { formatEtb } from "@/lib/money";
import { t } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function DrawsPage() {
  const draws = await recentDraws();

  return (
    <section>
      <div className="sec-head">
        <div>
          <h2>{t("draws.title")}</h2>
          <p>{t("draws.subtitle")}</p>
        </div>
        <span className="pill num">{draws.length}</span>
      </div>

      {draws.length === 0 ? (
        <div className="card card--flat">
          <p>{t("draws.empty")}</p>
        </div>
      ) : (
        <div className="card card--flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t("houses.col.house")}</th>
                <th>{t("common.round")}</th>
                <th>{t("draws.place1")}</th>
                <th>{t("draws.place2")}</th>
                <th>{t("draws.place3")}</th>
                <th>{t("draws.participants")}</th>
                <th>{t("draws.pot")}</th>
                <th>{t("common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {draws.map((draw) => (
                <tr key={draw.id}>
                  <td className="num">{t("house.name", [draw.house.label])}</td>
                  <td className="num">{draw.round}</td>
                  <td>
                    <span className="places">
                      <Ball n={draw.winnerSeatNumber} medal={1} size="lg" />
                      <span className="mono">
                        {formatEtb(draw.firstCents)} {t("common.birr")}
                      </span>
                    </span>
                  </td>
                  <td className="num">
                    {draw.secondSeatNumber === null
                      ? "—"
                      : (
                        <span className="places">
                          <Ball n={draw.secondSeatNumber} medal={2} />
                          <span className="mono">
                            {formatEtb(draw.secondCents)} {t("common.birr")}
                          </span>
                        </span>
                      )}
                  </td>
                  <td className="num">
                    {draw.thirdSeatNumber === null
                      ? "—"
                      : (
                        <span className="places">
                          <Ball n={draw.thirdSeatNumber} medal={3} />
                          <span className="mono">
                            {formatEtb(draw.thirdCents)} {t("common.birr")}
                          </span>
                        </span>
                      )}
                  </td>
                  <td className="num">{draw.participantCount}</td>
                  <td className="num">
                    {formatEtb(draw.potCents)} {t("common.birr")}
                  </td>
                  <td>
                    {draw.payoutStatus === "pending" ? (
                      <span className="badge">{t("draws.payoutPending")}</span>
                    ) : (
                      <span className="badge">{draw.payoutStatus}</span>
                    )}
                    <div className="mono" style={{ marginTop: 6 }} title={draw.entropy}>
                      {t("draws.seedNote")} {draw.commitment.slice(0, 24)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
