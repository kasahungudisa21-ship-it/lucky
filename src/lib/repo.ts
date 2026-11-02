import { prisma } from "@/lib/db";
import { channelStates, participantSms, participantTelegram, type AlertChannelName } from "@/lib/alerts/config";
import { fullHousePotCents, priceBreakdown } from "@/lib/pricing";
import { balanceOf, walletOfAccount } from "@/lib/services/wallet";

export type HouseSummary = {
  id: string;
  ordinal: number;
  label: string;
  capacity: number;
  round: number;
  isOpen: boolean;
  priceCents: number;
  feeCents: number;
  potPartCents: number;
  potCents: number;
  paidCount: number;
  heldCount: number;
  freeCount: number;
};

/** House list with the live participant counts for the current round. */
export async function houseSummaries(): Promise<HouseSummary[]> {
  const houses = await prisma.house.findMany({ orderBy: { ordinal: "asc" } });
  const counts = await prisma.entry.groupBy({
    by: ["houseId", "round", "status"],
    _count: { _all: true },
  });

  // keyed on house + round: entries from finished rounds are history and must
  // not be counted against a house that has already moved on
  const byHouseRound = new Map<string, { paid: number; held: number }>();
  for (const row of counts) {
    const key = `${row.houseId}:${row.round}`;
    const bucket = byHouseRound.get(key) ?? { paid: 0, held: 0 };
    if (row.status === "paid") bucket.paid += row._count._all;
    if (row.status === "pending_payment") bucket.held += row._count._all;
    byHouseRound.set(key, bucket);
  }

  return houses.map((house) => {
    const bucket = byHouseRound.get(`${house.id}:${house.round}`) ?? { paid: 0, held: 0 };
    const price = priceBreakdown(house);
    return {
      id: house.id,
      ordinal: house.ordinal,
      label: house.label,
      capacity: house.capacity,
      round: house.round,
      isOpen: house.isOpen,
      priceCents: price.priceCents,
      feeCents: price.serviceFeeCents,
      potPartCents: price.potPartCents,
      potCents: fullHousePotCents(house),
      paidCount: Math.min(bucket.paid, house.capacity),
      heldCount: bucket.held,
      freeCount: Math.max(0, house.capacity - bucket.paid - bucket.held),
    };
  });
}

export type SeatView = { number: number; status: "free" | "held" | "paid" | "mine" };
export type MySeat = { entryId: string; seatNumber: number; status: string; expiresAt: string | null };

export async function houseDetail(houseId: string, accountId: string | null) {
  const house = await prisma.house.findUnique({
    where: { id: houseId },
    include: { seats: { orderBy: { number: "asc" } } },
  });
  if (!house) return null;

  const mine = accountId
    ? await prisma.entry.findMany({
        where: { accountId, houseId, status: { in: ["pending_payment", "paid"] } },
        orderBy: { seatNumber: "asc" },
        select: { id: true, seatNumber: true, status: true },
      })
    : [];
  const mineNumbers = new Set(mine.map((entry) => entry.seatNumber));
  // an unpaid pick is only kept until the hold deadline, the board counts it down
  const holdByNumber = new Map(
    house.seats.filter((seat) => seat.status === "held").map((seat) => [seat.number, seat.heldUntil]),
  );

  const seats: SeatView[] = house.seats.map((seat) => {
    if (mineNumbers.has(seat.number)) return { number: seat.number, status: "mine" };
    if (seat.status === "paid") return { number: seat.number, status: "paid" };
    if (seat.status === "held") return { number: seat.number, status: "held" };
    return { number: seat.number, status: "free" };
  });

  return {
    house: {
      id: house.id,
      label: house.label,
      capacity: house.capacity,
      priceCents: house.priceCents,
      ordinal: house.ordinal,
      round: house.round,
      isOpen: house.isOpen,
    },
    seats,
    mine: mine.map<MySeat>((entry) => ({
      entryId: entry.id,
      seatNumber: entry.seatNumber,
      status: entry.status,
      expiresAt: holdByNumber.get(entry.seatNumber)?.toISOString() ?? null,
    })),
  };
}

export type MyEntry = {
  id: string;
  seatNumber: number;
  round: number;
  status: string;
  amountCents: number;
  house: { id: string; label: string; capacity: number };
  payments: { merchOrderId: string; status: string }[];
  /// the prize place this entry took, if the draw landed on it
  prize: { place: number; round: number; cents: number } | null;
};

export async function myEntries(accountId: string): Promise<MyEntry[]> {
  const entries = await prisma.entry.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "desc" }],
    include: {
      house: { select: { id: true, label: true, capacity: true } },
      payments: { select: { merchOrderId: true, status: true }, orderBy: { createdAt: "desc" }, take: 1 },
      wonDraw: { select: { round: true, firstCents: true } },
      secondDraw: { select: { round: true, secondCents: true } },
      thirdDraw: { select: { round: true, thirdCents: true } },
    },
  });

  return entries.map(({ wonDraw, secondDraw, thirdDraw, ...entry }) => ({
    ...entry,
    prize: wonDraw
      ? { place: 1, round: wonDraw.round, cents: wonDraw.firstCents }
      : secondDraw
        ? { place: 2, round: secondDraw.round, cents: secondDraw.secondCents }
        : thirdDraw
          ? { place: 3, round: thirdDraw.round, cents: thirdDraw.thirdCents }
          : null,
  }));
}

export type WalletMovement = {
  id: string;
  kind: string;
  deltaCents: number;
  createdAt: Date;
};

export type MyWallet = {
  balanceCents: number;
  movements: WalletMovement[];
  /** one request waits at a time, so the newest row is the one to report on */
  withdrawal: { amountCents: number; status: string } | null;
  /** a top-up Telebirr was given but has not confirmed, so it is not in the balance yet */
  awaitingCents: number;
};

/**
 * The participant's own money: the live balance, the movements that add up to
 * it, and the two states that belong to someone else to finish — Telebirr
 * confirming a top-up, the owner answering a withdrawal request.
 */
export async function myWallet(accountId: string): Promise<MyWallet> {
  const wallet = await walletOfAccount(accountId);
  const [balanceCents, movements, withdrawal, awaiting] = await Promise.all([
    balanceOf(wallet.id),
    prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { id: true, kind: true, deltaCents: true, createdAt: true },
    }),
    prisma.withdrawal.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      select: { amountCents: true, status: true },
    }),
    prisma.payment.aggregate({
      where: { walletId: wallet.id, purpose: "topup", status: { in: ["created", "checkout_published"] } },
      _sum: { amountCents: true },
    }),
  ]);

  return {
    balanceCents,
    movements,
    withdrawal,
    awaitingCents: awaiting._sum.amountCents ?? 0,
  };
}

export type MyNotice = {
  id: string;
  event: string;
  body: string;
  createdAt: Date;
  unread: boolean;
};

/**
 * The participant's own feed. The database row is the in-app message, so a
 * person is told what happened even when neither Telegram nor SMS reaches them.
 */
export async function myNotices(
  accountId: string,
  limit = 20,
): Promise<{ items: MyNotice[]; unread: number }> {
  const [rows, unread] = await Promise.all([
    prisma.notice.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, event: true, body: true, createdAt: true, readAt: true },
    }),
    prisma.notice.count({ where: { accountId, readAt: null } }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      event: row.event,
      body: row.body,
      createdAt: row.createdAt,
      unread: row.readAt === null,
    })),
    unread,
  };
}

/** How many of this account's notices have not been opened. Used by the header. */
export async function unreadNoticeCount(accountId: string) {
  return prisma.notice.count({ where: { accountId, readAt: null } });
}

/** Marks this account's whole feed read. Returns how many rows changed. */
export async function markNoticesRead(accountId: string) {
  const { count } = await prisma.notice.updateMany({
    where: { accountId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

export async function recentDraws(limit = 30) {
  return prisma.draw.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { house: { select: { label: true } } },
  });
}

export type RosterRow = {
  houseId: string;
  label: string;
  round: number;
  seatNumber: number;
  status: string;
  phone: string;
};

/**
 * Every number still held in a live round, with the wallet number behind it.
 * Names are never stored, so this is the closest the portal comes to a contact
 * list — and it is rendered only on /admin, which already requires the wallet
 * that receives the payments.
 */
export async function numberRoster(): Promise<RosterRow[]> {
  const entries = await prisma.entry.findMany({
    where: { status: { in: ["pending_payment", "paid"] } },
    select: {
      houseId: true,
      round: true,
      seatNumber: true,
      status: true,
      house: { select: { label: true, round: true } },
      account: { select: { phone: true } },
    },
    orderBy: [{ house: { ordinal: "asc" } }, { seatNumber: "asc" }],
  });

  return entries
    .filter((entry) => entry.round === entry.house.round)
    .map((entry) => ({
      houseId: entry.houseId,
      label: entry.house.label,
      round: entry.round,
      seatNumber: entry.seatNumber,
      status: entry.status,
      phone: entry.account.phone,
    }));
}

export type WalletTotals = {
  wallets: number;
  /** wallets the participants can still spend or withdraw from */
  holders: number;
  /** money held for participants — not income: prize and top-up cash owed back */
  holdingCents: number;
};

/**
 * What the portal is currently holding on other people's balances. Read off the
 * ledger rather than any stored figure, so it cannot disagree with /me.
 */
export async function walletTotals(): Promise<WalletTotals> {
  const [wallets, sums] = await Promise.all([
    prisma.wallet.count(),
    prisma.ledgerEntry.groupBy({ by: ["walletId"], _sum: { deltaCents: true } }),
  ]);
  const positive = sums.filter((row) => (row._sum.deltaCents ?? 0) > 0);
  return {
    wallets,
    holders: positive.length,
    holdingCents: positive.reduce((total, row) => total + (row._sum.deltaCents ?? 0), 0),
  };
}

export type WithdrawalRow = {
  id: string;
  phone: string;
  amountCents: number;
  balanceCents: number;
  createdAt: Date;
};

/**
 * Requests waiting for the owner to hand cash over. The wallet number is the
 * only way to know whose money it is, and this is rendered on /admin only.
 */
export async function pendingWithdrawals(limit = 20): Promise<WithdrawalRow[]> {
  const rows = await prisma.withdrawal.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      walletId: true,
      amountCents: true,
      createdAt: true,
      wallet: { select: { account: { select: { phone: true } } } },
    },
  });

  const balances = await prisma.ledgerEntry.groupBy({
    by: ["walletId"],
    where: { walletId: { in: rows.map((row) => row.walletId) } },
    _sum: { deltaCents: true },
  });
  const held = new Map(balances.map((row) => [row.walletId, row._sum.deltaCents ?? 0]));

  return rows.map((row) => ({
    id: row.id,
    phone: row.wallet.account.phone,
    amountCents: row.amountCents,
    balanceCents: held.get(row.walletId) ?? 0,
    createdAt: row.createdAt,
  }));
}

export type ActivityRow = {
  id: string;
  event: string;
  subject: string | null;
  body: string;
  createdAt: Date;
};

/**
 * What the system did on its own. Every event also lands on the dashboard
 * channel, so this feed exists even with no Telegram, SMTP or SMS set up.
 */
export async function recentActivity(limit = 12): Promise<ActivityRow[]> {
  const rows = await prisma.alert.findMany({
    where: { channel: "dashboard" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, event: true, subject: true, body: true, createdAt: true },
  });
  return rows;
}

export type ChannelReport = {
  channel: AlertChannelName;
  configured: boolean;
  missing: string[];
  delivered: number;
  queued: number;
  failed: number;
  lastError: string | null;
};

export async function alertReports(): Promise<ChannelReport[]> {
  const states = channelStates();
  const outgoing = states.filter((state) => state.channel !== "dashboard");
  if (outgoing.length === 0) return states.map((state) => ({ ...state, delivered: 0, queued: 0, failed: 0, lastError: null }));

  const grouped = await prisma.alert.groupBy({
    by: ["channel", "status"],
    _count: { _all: true },
  });
  const errored = await prisma.alert.findMany({
    where: { lastError: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { channel: true, lastError: true },
  });
  const firstError = new Map(errored.map((row) => [row.channel, row.lastError]));

  return states.map((state) => {
    const count = (status: string) =>
      grouped
        .filter((row) => row.channel === state.channel && row.status === status)
        .reduce((total, row) => total + row._count._all, 0);
    return {
      ...state,
      delivered: count("sent"),
      queued: count("pending") + count("sending"),
      failed: count("failed"),
      lastError: firstError.get(state.channel) ?? null,
    };
  });
}

export type ParticipantChannelReport = {
  channel: "telegram" | "sms";
  configured: boolean;
  delivered: number;
  queued: number;
  failed: number;
};

export type ParticipantReport = {
  channels: ParticipantChannelReport[];
  /** accounts a Telegram notice can currently reach */
  linkedChats: number;
  /** accounts an SMS notice can reach: every one, since the phone is the login */
  accounts: number;
  notices: number;
};

/**
 * The participant side of delivery. Legs are counted per channel because one
 * notice can be read on /me and still have failed to leave the process, and no
 * chat id or phone number is returned here — only totals.
 */
export async function participantReport(): Promise<ParticipantReport> {
  const [telegramLegs, smsLegs, linkedChats, accounts, notices] = await Promise.all([
    prisma.notice.groupBy({ by: ["telegram"], _count: { _all: true } }),
    prisma.notice.groupBy({ by: ["sms"], _count: { _all: true } }),
    prisma.account.count({ where: { telegramChatId: { not: null } } }),
    prisma.account.count(),
    prisma.notice.count(),
  ]);

  const legs = <K extends "telegram" | "sms">(
    rows: ({ [P in K]: string | null } & { _count: { _all: number } })[],
    leg: K,
  ) => {
    const value = (status: string) =>
      rows.filter((row) => row[leg] === status).reduce((total, row) => total + row._count._all, 0);
    return {
      delivered: value("sent"),
      queued: value("pending") + value("sending"),
      failed: value("failed"),
    };
  };

  return {
    channels: [
      {
        channel: "telegram",
        configured: participantTelegram() !== null,
        ...legs(telegramLegs, "telegram"),
      },
      { channel: "sms", configured: participantSms() !== null, ...legs(smsLegs, "sms") },
    ],
    linkedChats,
    accounts,
    notices,
  };
}
