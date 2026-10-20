import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { participantTelegram } from "@/lib/alerts/config";
import { telegramCall } from "@/lib/alerts/send";
import { emitNotice } from "./queue";
import { linkedNotice } from "./templates";

/**
 * Telegram has no address book to look a person up in: a bot may only write to a
 * chat that the person opened first. So /me hands out a single-use code, the
 * deep link opens the bot with it, and this module reads the incoming /start
 * messages to attach that chat id to the account the code came from.
 * A code is 16 hex characters and lives half an hour, so nobody can guess their
 * way into someone else's notices.
 */

const CODE_TTL_MS = 30 * 60_000;
const CODE_PATTERN = /^[0-9a-f]{16}$/;

export type LinkResult = { url: string } | { error: string };

export async function issueTelegramLink(accountId: string): Promise<LinkResult> {
  const config = participantTelegram();
  if (!config?.botUsername) return { error: "not_configured" };

  const code = randomBytes(8).toString("hex");
  await prisma.account.update({
    where: { id: accountId },
    data: { linkCode: code, linkExpiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  return { url: `https://t.me/${config.botUsername}?start=${code}` };
}

export async function telegramLinkState(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { telegramChatId: true },
  });
  return { linked: Boolean(account?.telegramChatId), offered: Boolean(participantTelegram()?.botUsername) };
}

// a webhook on the same bot would be a deliberate setup by someone else, so this
// only says so instead of deleting it
const holder = globalThis as unknown as { __luckyTelegramOffset?: number };

export type LinkPollResult = { linked: number; note: string };

/** One getUpdates pass: attaches every /start CODE that is still live. */
export async function pollTelegramLinks(): Promise<LinkPollResult> {
  const config = participantTelegram();
  if (!config) return { linked: 0, note: "off" };

  const offset = holder.__luckyTelegramOffset ?? 0;
  let payload: string;
  try {
    payload = await telegramCall(config.botToken, "getUpdates", {
      offset,
      limit: 50,
      timeout: 0,
      allowed_updates: ["message"],
    });
  } catch (error) {
    const message = (error as Error).message ?? "unreachable";
    return { linked: 0, note: message.includes("409") ? "webhook in use" : message.slice(0, 60) };
  }

  let updates: { update_id: number; message?: { text?: string; from?: { id?: number } } }[];
  try {
    updates = JSON.parse(payload).result ?? [];
  } catch {
    return { linked: 0, note: "unreadable reply" };
  }

  let linked = 0;
  let highest = offset;
  for (const update of updates) {
    highest = Math.max(highest, update.update_id + 1);
    const code = (update.message?.text ?? "").trim().split(" ")[1] ?? "";
    const chatId = update.message?.from?.id;
    if (!CODE_PATTERN.test(code) || typeof chatId !== "number") continue;
    if (await attachCode(code, chatId)) linked += 1;
  }

  holder.__luckyTelegramOffset = highest;
  return { linked, note: `offset ${highest}` };
}

/** Compare-and-set on the code, so two messages cannot claim one account. */
async function attachCode(code: string, chatId: number): Promise<boolean> {
  const account = await prisma.account.findFirst({
    where: { linkCode: code, linkExpiresAt: { gt: new Date() } },
    select: { id: true, telegramChatId: true },
  });
  if (!account) return false;

  const claimed = await prisma.account.updateMany({
    where: { id: account.id, linkCode: code },
    data: { telegramChatId: String(chatId), linkCode: null, linkExpiresAt: null },
  });
  if (claimed.count !== 1) return false;

  if (account.telegramChatId !== String(chatId)) {
    await emitNotice(account.id, "telegram_linked", linkedNotice(), { sms: false });
  }
  return true;
}
