import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/auth";
import { Ball } from "@/components/ball";
import { DrawButton } from "@/components/draw-button";
import {
  alertReports,
  houseSummaries,
  numberRoster,
  participantReport,
  pendingWithdrawals,
  recentActivity,
  recentDraws,
  walletTotals,
} from "@/lib/repo";
import { WithdrawalActions } from "@/components/withdrawal-actions";
import { formatEtb } from "@/lib/money";
import { SERVICE_RATE, fullHousePrizeShares } from "@/lib/pricing";
import { merchantWallet, isMerchantWallet } from "@/lib/telebirr/config";
import { resolveMode } from "@/lib/services/payments";
import { schedulerStatus } from "@/lib/scheduler";
import { hasKey, type Tr } from "@/lib/ui";
import { currentLang, text } from "@/lib/locale";

export const dynamic = "force-dynamic";

function eventLabel(t: Tr, event: string) {
  const key = `event.${event}`;
  return hasKey(key) ? t(key) : t("event.gateway_error");
}

/** UTC clock, shown as the digits are stored so no locale can reorder them. */
const clock = (iso: string | null) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 19)}` : "-");

const CHANNEL_NAMES: Record<string, string> = {
  telegram: "Telegram",
  email: "Email",
  sms: "SMS",
};

/** The dashboard belongs to the wallet that receives the payments, so the
 * merchant number in the environment is the only access list. */
export default async function AdminPage() {
  const [t, lang] = await Promise.all([text(), currentLang()]);
  const account = await currentAccount();
  if (!account) redirect("/login");

  if (!isMerchantWallet(account.phone)) {
    return (
      <section>
        <div className="center">
          <div className="alert">{t("dash.forbidden")}</div>
          <Link href="/houses" className="btn btn-ghost">
            {t("common.back")}
          </Link>
        </div>
      </section>
    );
  }

  const payee = merchantWallet() ?? "";

  const [houses, draws, activity, channels, roster, participant, withdrawals, wallets] =
    await Promise.all([
      houseSummaries(),
      recentDraws(5),
      recentActivity(12),
      alertReports(),
      numberRoster(),
      participantReport(),
      pendingWithdrawals(),
      walletTotals(),
    ]);
  const slots = houses.reduce((total, house) => total + house.capacity, 0);
  const paidNumbers = houses.reduce((total, house) => total + house.paidCount, 0);

  const resolution = resolveMode();
  const mode = "error" in resolution ? "unavailable" : resolution.mode;
  const jobs = schedulerStatus();
  const outgoing = channels.filter((channel) => channel.channel !== "dashboard");

  return (
    <section className="dash">
      <div className="sec-head">
        <div>
          <h2>{t("dash.title")}</h2>
          <p>{t("dash.subtitle")}</p>
        </div>
        <span className="pill num">{payee}</span>
      </div>

      <div className="stats">
        <div className="stat">
          <i style={{ background: "var(--tb-cyan)" }} />
          <b className="num">{houses.length}</b>
          <span>{t("stats.houses")}</span>
        </div>
        <div className="stat">
          <i style={{ background: "var(--tb-gold)" }} />
          <b className="num">{slots}</b>
          <span>{t("stats.slots")}</span>
        </div>
        <div className="stat">
          <i style={{ background: "#9be6ff" }} />
          <b className="num">{paidNumbers}</b>
          <span>{t("dash.paid")}</span>
        </div>
        <div className="stat">
          <i style={{ background: "#ffffff" }} />
          <b className="num">{Math.round(SERVICE_RATE * 100)}</b>
          <span>{t("house.fee")}</span>
        </div>
      </div>

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{t("dash.money")}</h2>
        </div>
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
              <th>{t("draws.place1")}</th>
              <th>{t("draws.place2")}</th>
              <th>{t("draws.place3")}</th>
            </tr>
          </thead>
          <tbody>
            {houses.map((house) => {
              const shares = fullHousePrizeShares(house);
              return (
                <tr key={house.id}>
                  <td className="num">{t("house.name", [house.label])}</td>
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
                  <td className="num share">
                    {formatEtb(shares.firstCents)} {t("common.birr")}
                  </td>
                  <td className="num">
                    {formatEtb(shares.secondCents)} {t("common.birr")}
                  </td>
                  <td className="num">
                    {formatEtb(shares.thirdCents)} {t("common.birr")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="note">{t("rules.fee")}</p>

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{t("dash.live")}</h2>
        </div>
      </div>

      <div className="card card--flat" style={{ padding: 0, overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t("houses.col.house")}</th>
              <th>{t("houses.col.size")}</th>
              <th>{t("common.round")}</th>
              <th>{t("dash.paid")}</th>
              <th>{t("dash.held")}</th>
              <th>{t("houses.col.free")}</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            {houses.map((house) => (
              <tr key={house.id}>
                <td className="num">{t("house.name", [house.label])}</td>
                <td className="num">{house.capacity}</td>
                <td className="num">{house.round}</td>
                <td className="num">{house.paidCount}</td>
                <td className="num">{house.heldCount}</td>
                <td className="num">{house.freeCount}</td>
                <td>
                  <Link href={`/houses/${house.id}`}>{t("houses.choose")}</Link>
                </td>
                <td>
                  <DrawButton houseId={house.id} lang={lang} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {roster.length > 0 && (
        <>
          <div className="sec-head" style={{ marginTop: 26 }}>
            <div>
              <h2>{t("dash.roster")}</h2>
              <p>{t("dash.forbidden")}</p>
            </div>
            <span className="pill num">{roster.length}</span>
          </div>
          <div className="card card--flat" style={{ padding: 0, overflow: "hidden" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t("houses.col.house")}</th>
                  <th>{t("common.number")}</th>
                  <th>{t("common.round")}</th>
                  <th>{t("auth.phone")}</th>
                  <th>{t("common.status")}</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((row) => (
                  <tr key={`${row.houseId}-${row.round}-${row.seatNumber}`}>
                    <td className="num">{t("house.name", [row.label])}</td>
                    <td className="num">
                      <Ball n={row.seatNumber} size="sm" />
                    </td>
                    <td className="num">{row.round}</td>
                    <td className="mono">{row.phone}</td>
                    <td>{row.status === "paid" ? t("status.paid") : t("mine.pending")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{t("dash.wallets")}</h2>
          <p>{t("dash.balanceTotal")}</p>
        </div>
        <span className="pill num">
          {formatEtb(wallets.holdingCents)} {t("common.birr")}
        </span>
      </div>

      <div className="rows">
        <div className="row">
          <span>{t("dash.balanceCount")}</span>
          <b className="num">{wallets.holders}</b>
        </div>
      </div>

      <label className="fld" style={{ marginTop: 18 }}>
        {t("dash.withdrawals")}
      </label>
      {withdrawals.length === 0 ? (
        <p className="note">{t("dash.noWithdrawals")}</p>
      ) : (
        <div className="rows">
          {withdrawals.map((request) => (
            <div className="row" key={request.id}>
              <span className="num">
                {t("dash.withdrawalFrom", [
                  request.phone,
                  formatEtb(request.amountCents),
                  formatEtb(Math.max(0, request.balanceCents - request.amountCents)),
                ])}
              </span>
              <span className="places">
                <WithdrawalActions withdrawalId={request.id} lang={lang} />
              </span>
            </div>
          ))}
        </div>
      )}

      {draws.length > 0 && (
        <>
          <div className="sec-head" style={{ marginTop: 26 }}>
            <div>
              <h2>{t("draws.title")}</h2>
            </div>
            <span className="pill num">{draws.length}</span>
          </div>
          <div className="rows">
            {draws.map((draw) => (
              <div className="row" key={draw.id}>
                <span className="num">
                  {t("house.name", [draw.house.label])} · {t("houses.round")} {draw.round} ·{" "}
                  <span className="mono">{draw.commitment.slice(0, 16)}</span>
                </span>
                <span className="places">
                  <b className="num">
                    {t("draws.place1")} <Ball n={draw.winnerSeatNumber} medal={1} size="sm" /> ·{" "}
                    {formatEtb(draw.firstCents)} {t("common.birr")}
                  </b>
                  {draw.secondSeatNumber !== null && (
                    <b className="num">
                      {t("draws.place2")} <Ball n={draw.secondSeatNumber} medal={2} size="sm" /> ·{" "}
                      {formatEtb(draw.secondCents)} {t("common.birr")}
                    </b>
                  )}
                  {draw.thirdSeatNumber !== null && (
                    <b className="num">
                      {t("draws.place3")} <Ball n={draw.thirdSeatNumber} medal={3} size="sm" /> ·{" "}
                      {formatEtb(draw.thirdCents)} {t("common.birr")}
                    </b>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{t("dash.automation")}</h2>
          <p>{t("dash.autoNote")}</p>
        </div>
        <span className="pill num">{jobs.enabled ? t("dash.running") : t("dash.stopped")}</span>
      </div>

      <div className="rows">
        <div className="row">
          <span>{t("dash.paymentMode")}</span>
          <b className="mono">{mode}</b>
        </div>
        <div className="row">
          <span>{t("dash.sweepJob")}</span>
          <b className="mono">
            {clock(jobs.jobs.sweep.lastRunAt)} · {jobs.jobs.sweep.lastSummary}
          </b>
        </div>
        <div className="row">
          <span>{t("dash.reconcileJob")}</span>
          <b className="mono">
            {clock(jobs.jobs.reconcile.lastRunAt)} · {jobs.jobs.reconcile.lastSummary}
          </b>
        </div>
        <div className="row">
          <span>{t("dash.dispatchJob")}</span>
          <b className="mono">
            {clock(jobs.jobs.dispatch.lastRunAt)} · {jobs.jobs.dispatch.lastSummary}
          </b>
        </div>
        <div className="row">
          <span>{t("dash.telegramJob")}</span>
          <b className="mono">
            {clock(jobs.jobs.telegram.lastRunAt)} · {jobs.jobs.telegram.lastSummary}
          </b>
        </div>
      </div>

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{t("dash.channels")}</h2>
        </div>
      </div>

      <div className="card card--flat" style={{ padding: 0, overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t("dash.channels")}</th>
              <th>{t("common.status")}</th>
              <th>{t("dash.delivered")}</th>
              <th>{t("dash.queued")}</th>
              <th>{t("dash.errored")}</th>
            </tr>
          </thead>
          <tbody>
            {outgoing.map((channel) => (
              <tr key={channel.channel}>
                <td className="mono">{CHANNEL_NAMES[channel.channel] ?? channel.channel}</td>
                <td>{channel.configured ? t("dash.running") : t("dash.notConfigured")}</td>
                <td className="num">{channel.delivered}</td>
                <td className="num">{channel.queued}</td>
                <td className="num">{channel.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {outgoing.length === 0 ? (
        <p className="note">{t("dash.noChannels")}</p>
      ) : (
        outgoing
          .filter((channel) => !channel.configured)
          .map((channel) => (
            <p className="note mono" key={channel.channel}>
              {CHANNEL_NAMES[channel.channel]}: {t("pay.missingVariables", [channel.missing.join(", ")])}
            </p>
          ))
      )}

      {outgoing
        .filter((channel) => channel.lastError !== null)
        .map((channel) => (
          <p className="note mono" key={`${channel.channel}-error`}>
            {CHANNEL_NAMES[channel.channel]} · {t("dash.lastError")}: {channel.lastError}
          </p>
        ))}

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{t("dash.participantNotices")}</h2>
        </div>
        <span className="pill num">
          {t("dash.linkedChats")} {participant.linkedChats}/{participant.accounts}
        </span>
      </div>

      <div className="card card--flat" style={{ padding: 0, overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t("dash.channels")}</th>
              <th>{t("common.status")}</th>
              <th>{t("dash.delivered")}</th>
              <th>{t("dash.queued")}</th>
              <th>{t("dash.errored")}</th>
            </tr>
          </thead>
          <tbody>
            {participant.channels.map((channel) => (
              <tr key={channel.channel}>
                <td className="mono">{CHANNEL_NAMES[channel.channel]}</td>
                <td>{channel.configured ? t("dash.running") : t("dash.notConfigured")}</td>
                <td className="num">{channel.delivered}</td>
                <td className="num">{channel.queued}</td>
                <td className="num">{channel.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="note">
        {t("mine.notices")}: {participant.notices}
      </p>

      <div className="sec-head" style={{ marginTop: 26 }}>
        <div>
          <h2>{t("dash.activity")}</h2>
        </div>
        <span className="pill num">{activity.length}</span>
      </div>

      {activity.length === 0 ? (
        <p className="note">{t("dash.noActivity")}</p>
      ) : (
        <div className="rows">
          {activity.map((row) => (
            <div className="row" key={row.id}>
              <span className="num">
                {eventLabel(t, row.event)} · <span className="mono">{clock(row.createdAt.toISOString())}</span>
              </span>
              <span className="places">
                {row.body.split("\n").map((line, index) => (
                  <b className="num" key={index}>
                    {line}
                  </b>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
