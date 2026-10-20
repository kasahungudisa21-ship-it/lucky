import { emailConfig, smsConfig, telegramConfig } from "./config";

const TIMEOUT_MS = 12_000;
/** Telegram rejects anything longer; SMS is metered per 160 chars. */
const TELEGRAM_LIMIT = 4000;
const SMS_LIMIT = 480;

class SendError extends Error {}

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  }).catch((error: Error) => {
    throw new SendError(`network: ${error.name}`);
  });

  const text = (await response.text().catch(() => "")).slice(0, 300);
  if (!response.ok) throw new SendError(`http ${response.status} ${text}`);
  return text;
}

/** Any Bot API method: sendMessage for a delivery leg, getUpdates for the link poller. */
export async function telegramCall(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
) {
  const payload = await postJson(`https://api.telegram.org/bot${botToken}/${method}`, body, {});
  // Telegram answers 200 with ok:false for a blocked bot
  if (payload.includes('"ok":false')) throw new SendError("telegram refused");
  return payload;
}

export async function telegramTo(botToken: string, chatId: string, text: string) {
  await telegramCall(botToken, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, TELEGRAM_LIMIT),
  });
}

async function sendTelegram(text: string) {
  const config = telegramConfig();
  if (!config) throw new SendError("not_configured");
  await telegramTo(config.botToken, config.chatId, text);
}

async function sendEmail(subject: string, text: string) {
  const config = emailConfig();
  if (!config) throw new SendError("not_configured");
  // instrumentation is also compiled for the edge runtime, where node's built-ins
  // do not exist: leave the import for node to resolve at send time
  const { default: nodemailer } = await import(/* webpackIgnore: true */ "nodemailer");
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });
  await transport.sendMail({ from: config.from, to: config.to, subject, text });
}

/** The gateway half of an SMS leg: any HTTPS box with a bearer token. */
export async function smsTo(
  config: { url: string; apiKey: string; sender: string | null },
  to: string,
  message: string,
) {
  await postJson(
    config.url,
    { to, message: message.slice(0, SMS_LIMIT), ...(config.sender ? { sender: config.sender } : {}) },
    { Authorization: `Bearer ${config.apiKey}` },
  );
}

async function sendSms(subject: string, text: string) {
  const config = smsConfig();
  if (!config) throw new SendError("not_configured");
  await smsTo(config, config.to, `${subject}\n${text}`);
}

/** The channel comes back off a database row, so an unknown one is refused. */
export async function deliver(channel: string, subject: string, text: string) {
  if (channel === "dashboard") return;
  if (channel === "telegram") return sendTelegram(`${subject ? `${subject}\n` : ""}${text}`);
  if (channel === "email") return sendEmail(subject || text.slice(0, 120), text);
  if (channel === "sms") return sendSms(subject, text);
  throw new SendError(`unknown channel ${channel}`);
}

export { SendError };
