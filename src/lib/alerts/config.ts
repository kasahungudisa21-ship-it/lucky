/**
 * Owner-alert channels, configured only by environment variables. A channel with
 * anything missing is reported as unconfigured and never queued, so a half-set-up
 * SMTP box cannot swallow alerts. Secret values are never returned to a caller
 * that renders them — only the variable names go to the dashboard.
 */

export type AlertChannelName = "telegram" | "email" | "sms" | "dashboard";

export const ALERT_CHANNELS: AlertChannelName[] = ["telegram", "email", "sms", "dashboard"];

const value = (name: string) => {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw.trim() : undefined;
};

export type TelegramConfig = { botToken: string; chatId: string };

export function telegramConfig(): TelegramConfig | null {
  const botToken = value("ALERT_TELEGRAM_BOT_TOKEN");
  const chatId = value("ALERT_TELEGRAM_CHAT_ID");
  return botToken && chatId ? { botToken, chatId } : null;
}

export type EmailConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
};

export function emailConfig(): EmailConfig | null {
  const host = value("ALERT_SMTP_HOST");
  const rawPort = value("ALERT_SMTP_PORT");
  const user = value("ALERT_SMTP_USER");
  const pass = value("ALERT_SMTP_PASS");
  const from = value("ALERT_EMAIL_FROM");
  const to = value("ALERT_EMAIL_TO");
  if (!host || !user || !pass || !from || !to) return null;

  const port = Number(rawPort ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, user, pass, from, to };
}

export type SmsConfig = { url: string; apiKey: string; to: string; sender: string | null };

/**
 * Deliberately provider-agnostic: the request body is fixed but any HTTPS SMS
 * gateway can be put behind it. Without an SMS contract nothing is configured and
 * the channel simply stays absent from the queue.
 */
export function smsConfig(): SmsConfig | null {
  const url = value("ALERT_SMS_URL");
  const apiKey = value("ALERT_SMS_API_KEY");
  const to = value("ALERT_SMS_TO");
  if (!url || !apiKey || !to) return null;
  if (!url.startsWith("https://")) return null;
  return { url, apiKey, to, sender: value("ALERT_SMS_SENDER") ?? null };
}

export function alertsEnabled(): boolean {
  return value("ALERTS_ENABLED") !== "false";
}

export type ChannelState = {
  channel: AlertChannelName;
  configured: boolean;
  /** environment variable names still missing, for the dashboard */
  missing: string[];
};

const REQUIRED_VARS: Record<Exclude<AlertChannelName, "dashboard">, string[]> = {
  telegram: ["ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID"],
  email: [
    "ALERT_SMTP_HOST",
    "ALERT_SMTP_PORT",
    "ALERT_SMTP_USER",
    "ALERT_SMTP_PASS",
    "ALERT_EMAIL_FROM",
    "ALERT_EMAIL_TO",
  ],
  sms: ["ALERT_SMS_URL", "ALERT_SMS_API_KEY", "ALERT_SMS_TO"],
};

function isConfigured(channel: Exclude<AlertChannelName, "dashboard">) {
  if (channel === "telegram") return telegramConfig() !== null;
  if (channel === "email") return emailConfig() !== null;
  return smsConfig() !== null;
}

export function channelStates(): ChannelState[] {
  return ALERT_CHANNELS.map((channel) => {
    if (channel === "dashboard") return { channel, configured: true, missing: [] };
    const configured = isConfigured(channel);
    return {
      channel,
      configured,
      missing: configured ? [] : REQUIRED_VARS[channel].filter((name) => !value(name)),
    };
  });
}

/** Channels that actually have a transport; the dashboard feed is always on. */
export function outgoingChannels(): Exclude<AlertChannelName, "dashboard">[] {
  if (!alertsEnabled()) return [];
  return (["telegram", "email", "sms"] as const).filter(isConfigured);
}

/**
 * Participant-facing channels. The gateway is the owner's, but the destination
 * comes from each account row, so nothing here needs ALERT_TELEGRAM_CHAT_ID or
 * ALERT_SMS_TO. A participant can only be reached where their own account
 * carries a destination: a linked chat id, or the phone they registered with.
 */
export type ParticipantTelegram = { botToken: string; botUsername: string | null };

export function participantTelegram(): ParticipantTelegram | null {
  if (!alertsEnabled()) return null;
  const botToken = value("ALERT_TELEGRAM_BOT_TOKEN");
  if (!botToken) return null;
  return { botToken, botUsername: value("ALERT_TELEGRAM_BOT_USERNAME") ?? null };
}

export type ParticipantSms = { url: string; apiKey: string; sender: string | null };

export function participantSms(): ParticipantSms | null {
  if (!alertsEnabled()) return null;
  const url = value("ALERT_SMS_URL");
  const apiKey = value("ALERT_SMS_API_KEY");
  if (!url || !apiKey || !url.startsWith("https://")) return null;
  return { url, apiKey, sender: value("ALERT_SMS_SENDER") ?? null };
}
