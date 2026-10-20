import { prisma } from "@/lib/db";
import { participantSms, participantTelegram } from "@/lib/alerts/config";
import { smsTo, telegramTo } from "@/lib/alerts/send";

/**
 * Participant notices. One row per participant per event, held in the database
 * so the in-app feed and the outbound legs are the same message: what the
 * participant reads on /me is exactly what Telegram or SMS carried.
 * A leg is only queued when both the gateway and that account's own destination
 * exist, so nobody is ever sent to and nobody blocks the queue.
 */

export type NoticeEvent = "payment_settled" | "draw_won" | "draw_closed" | "telegram_linked";

/** `sms: false` keeps a message inside the channel it belongs to, e.g. the
 * confirmation that a Telegram chat was just linked must not arrive by SMS. */
export type NoticeInput = { accountId: string; event: NoticeEvent; body: string; sms?: boolean };

const MAX_ATTEMPTS = 4;
const STALE_SENDING_MS = 120_000;

const backoffAt = (now: Date, attempts: number) =>
  new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** attempts));

export async function emitNotices(inputs: NoticeInput[]) {
  if (inputs.length === 0) return;
  try {
    const ids = [...new Set(inputs.map((input) => input.accountId))];
    const accounts = await prisma.account.findMany({
      where: { id: { in: ids } },
      select: { id: true, phone: true, telegramChatId: true },
    });
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const telegramOn = participantTelegram() !== null;
    const smsOn = participantSms() !== null;
    const now = new Date();

    await prisma.notice.createMany({
      data: inputs.flatMap((input) => {
        const account = byId.get(input.accountId);
        if (!account) return [];
        return [
          {
            accountId: account.id,
            event: input.event,
            body: input.body,
            telegram: telegramOn && account.telegramChatId ? "pending" : "none",
            sms: smsOn && account.phone && input.sms !== false ? "pending" : "none",
            runAt: now,
          },
        ];
      }),
    });
  } catch (error) {
    // a notice that cannot be written must not undo the event that caused it
    console.error("notice queue failed", (error as Error).name);
  }
}

export async function emitNotice(
  accountId: string,
  event: NoticeEvent,
  body: string,
  options?: { sms?: boolean },
) {
  await emitNotices([{ accountId, event, body, sms: options?.sms }]);
}

export type NoticeDispatch = { sent: number; queued: number; failed: number };

type NoticeRow = Awaited<ReturnType<typeof dueNotices>>[number];

async function dueNotices(now: Date, limit: number) {
  return prisma.notice.findMany({
    where: {
      runAt: { lte: now },
      OR: [
        { telegram: "pending", tgAttempts: { lt: MAX_ATTEMPTS } },
        { sms: "pending", smsAttempts: { lt: MAX_ATTEMPTS } },
      ],
    },
    orderBy: { runAt: "asc" },
    take: limit,
    include: { account: { select: { telegramChatId: true, phone: true } } },
  });
}

/** Sends every participant leg that is due, with the same backoff the owner queue uses. */
export async function dispatchNotices(
  now = new Date(),
  limit = 10,
): Promise<NoticeDispatch> {
  const result = { sent: 0, queued: 0, failed: 0 };

  // a process that died mid-send must not strand a leg in "sending"
  const stale = new Date(now.getTime() - STALE_SENDING_MS);
  await prisma.notice.updateMany({
    where: { telegram: "sending", updatedAt: { lt: stale } },
    data: { telegram: "pending" },
  });
  await prisma.notice.updateMany({
    where: { sms: "sending", updatedAt: { lt: stale } },
    data: { sms: "pending" },
  });

  for (const notice of await dueNotices(now, limit)) {
    if (notice.telegram === "pending") await sendTelegramLeg(notice, now, result);
    if (notice.sms === "pending") await sendSmsLeg(notice, now, result);
  }
  return result;
}

async function sendTelegramLeg(notice: NoticeRow, now: Date, result: NoticeDispatch) {
  const claimed = await prisma.notice.updateMany({
    where: { id: notice.id, telegram: "pending" },
    data: { telegram: "sending", tgAttempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return;

  const attempts = notice.tgAttempts + 1;
  const config = participantTelegram();
  const chatId = notice.account.telegramChatId;
  if (!config || !chatId) {
    // the destination or the bot went away: nothing to retry, so the leg just ends
    await prisma.notice.update({ where: { id: notice.id }, data: { telegram: "none" } });
    return;
  }

  try {
    await telegramTo(config.botToken, chatId, notice.body);
    await prisma.notice.update({
      where: { id: notice.id },
      data: { telegram: "sent", lastError: null },
    });
    result.sent += 1;
  } catch (error) {
    const detail = (error as Error).message?.slice(0, 200) ?? "unknown";
    await prisma.notice.update({
      where: { id: notice.id },
      data: {
        telegram: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        lastError: detail,
        runAt: backoffAt(now, attempts),
      },
    });
    if (attempts >= MAX_ATTEMPTS) result.failed += 1;
    else result.queued += 1;
  }
}

async function sendSmsLeg(notice: NoticeRow, now: Date, result: NoticeDispatch) {
  const claimed = await prisma.notice.updateMany({
    where: { id: notice.id, sms: "pending" },
    data: { sms: "sending", smsAttempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return;

  const attempts = notice.smsAttempts + 1;
  const config = participantSms();
  const phone = notice.account.phone;
  if (!config || !phone) {
    await prisma.notice.update({ where: { id: notice.id }, data: { sms: "none" } });
    return;
  }

  try {
    await smsTo(config, phone, notice.body);
    await prisma.notice.update({
      where: { id: notice.id },
      data: { sms: "sent", lastError: null },
    });
    result.sent += 1;
  } catch (error) {
    const detail = (error as Error).message?.slice(0, 200) ?? "unknown";
    await prisma.notice.update({
      where: { id: notice.id },
      data: {
        sms: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        lastError: detail,
        runAt: backoffAt(now, attempts),
      },
    });
    if (attempts >= MAX_ATTEMPTS) result.failed += 1;
    else result.queued += 1;
  }
}
