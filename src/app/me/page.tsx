import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/auth";
import { Ball } from "@/components/ball";
import { MarkReadButton } from "@/components/mark-read";
import { TelegramLink } from "@/components/telegram-link";
import { myEntries, myNotices } from "@/lib/repo";
import { telegramLinkState } from "@/lib/notices/telegram";
import { formatEtb } from "@/lib/money";
import { t } from "@/lib/ui";

/** UTC clock, shown as the digits are stored so no locale can reorder them. */
const clock = (at: Date) => `${at.toISOString().slice(5, 10)} ${at.toISOString().slice(11, 16)}`;

export default async function MinePage() {
  const account = await currentAccount();
  if (!account) redirect("/login");
  const [entries, notices, link] = await Promise.all([
    myEntries(account.accountId),
    myNotices(account.accountId),
    telegramLinkState(account.accountId),
  ]);

  const placeLabel = (place: number) =>
    place === 1 ? t("draws.place1") : place === 2 ? t("draws.place2") : t("draws.place3");

  return (
    <section>
      <div className="sec-head">
        <div>
          <h2>{t("mine.title")}</h2>
          <p>{t("hero.rule")}</p>
        </div>
        <span className="pill num">{account.phone}</span>
      </div>

      {entries.length === 0 ? (
        <div className="card card--flat">
          <p>{t("mine.empty")}</p>
          <div className="form__btns">
            <Link href="/houses" className="btn btn-primary">
              {t("nav.houses")}
            </Link>
          </div>
        </div>
      ) : (
        <div className="card card--flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t("houses.col.house")}</th>
                <th>{t("common.number")}</th>
                <th>{t("common.round")}</th>
                <th>{t("common.amount")}</th>
                <th>{t("draws.prize")}</th>
                <th>{t("common.status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const label = entry.prize
                  ? placeLabel(entry.prize.place)
                  : entry.status === "lost"
                    ? t("mine.lost", [entry.round])
                    : entry.status === "pending_payment"
                      ? t("mine.pending")
                      : entry.status === "paid"
                        ? t("mine.paid")
                        : t("mine.released");

                return (
                  <tr key={entry.id}>
                    <td className="num">{t("house.name", [entry.house.label])}</td>
                    <td className="num">
                      <Ball n={entry.seatNumber} medal={entry.prize?.place} size="sm" />
                    </td>
                    <td className="num">{entry.prize ? entry.prize.round : entry.round}</td>
                    <td className="num">
                      {formatEtb(entry.amountCents)} {t("common.birr")}
                    </td>
                    <td className="num">
                      {entry.prize ? (
                        <>
                          {formatEtb(entry.prize.cents)} {t("common.birr")}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span className={`badge ${entry.prize ? "badge-prize" : ""}`}>{label}</span>
                    </td>
                    <td>
                      {entry.status === "pending_payment" && entry.payments[0] ? (
                        <Link href={`/pay/${entry.payments[0].merchOrderId}`}>{t("mine.payNow")}</Link>
                      ) : (
                        <Link href={`/houses/${entry.house.id}`}>{t("nav.houses")}</Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{t("mine.notices")}</h2>
          <p>{t("mine.inAppOnly")}</p>
        </div>
        {notices.unread > 0 && (
          <span className="pill num">{t("mine.unread", [notices.unread])}</span>
        )}
      </div>

      {notices.items.length === 0 ? (
        <p className="note">{t("mine.noNotices")}</p>
      ) : (
        <>
          <div className="rows">
            {notices.items.map((notice) => (
              <div
                className={`row notice ${notice.unread ? "notice--new" : ""}`}
                key={notice.id}
              >
                <span className="num">{notice.body}</span>
                <time className="mono">{clock(notice.createdAt)}</time>
              </div>
            ))}
          </div>
          {notices.unread > 0 && (
            <div className="form__btns">
              <MarkReadButton />
            </div>
          )}
        </>
      )}

      <div className="card card--flat" style={{ marginTop: 22 }}>
        <div className="unit__top">
          <b>{t("mine.linkTelegram")}</b>
        </div>
        <TelegramLink linked={link.linked} offered={link.offered} />
      </div>
    </section>
  );
}
