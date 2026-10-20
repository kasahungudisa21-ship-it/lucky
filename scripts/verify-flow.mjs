/**
 * End-to-end flow check against a running dev server.
 *
 *   npm run dev                        # terminal one
 *   npm run verify                     # terminal two (loads .env for DATABASE_URL and CRON_SECRET)
 *
 * Registers fresh accounts, has each claim a specific number in the smallest
 * house, settles the simulated payments one by one, and asserts that the draw
 * fired automatically once the last number was paid. The three prize places are
 * re-drawn here from the published seed, so the harness proves the same thing
 * an outside verifier could check by hand. Nothing here reaches a real gateway:
 * settlement goes through the development-only simulate path.
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const BASE = process.argv[2] ?? "http://localhost:3210";
const prisma = new PrismaClient();
const results = [];
// alerts from earlier runs are still in the table, so every check here counts
// only what this run produced
const startedAt = new Date();

function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${condition ? "" : ` -- ${detail}`}`);
}

// mirrors src/lib/services/draws.ts: unbiased index over the stored seed,
// salted per place so the three draws stay independent
const UINT64_MAX = 2n ** 64n - 1n;
function pickIndex(seed, count, place) {
  const modulus = BigInt(count);
  const rejectionLimit = (UINT64_MAX / modulus) * modulus;
  for (let counter = 0; ; counter += 1) {
    const digest = createHash("sha256").update(seed).update(`place-${place}`).update(String(counter)).digest();
    const value = digest.readBigUInt64BE(0);
    if (value < rejectionLimit) return Number(value % modulus);
  }
}

function drawPlaces(entropyHex, pool) {
  const remaining = [...pool];
  const places = [];
  for (let place = 1; place <= 3; place += 1) {
    places.push(remaining.splice(pickIndex(Buffer.from(entropyHex, "hex"), remaining.length, place), 1)[0]);
  }
  return places;
}

// the charge is a quarter of the price, cut out of the money the participant
// pays rather than added to it, so the prize part of a payment is three quarters
const SERVICE_RATE = 0.25;
function expectedFeeForPrice(priceCents) {
  return Math.round(priceCents * SERVICE_RATE);
}

function makeSession() {
  let cookie = "";
  const request = async function (path, init = {}) {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body };
  };
  // the same session reading a server-rendered page instead of an API route,
  // so a check can look for a wallet number inside the HTML a person is shown
  request.raw = async function (path) {
    const response = await fetch(`${BASE}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    return { status: response.status, text: await response.text() };
  };
  return request;
}

const suffix = String(Date.now()).slice(-7);
const seed = Number(suffix);
// "09" + 8 digits. 104729 * capacity stays under 1e8, so each participant gets a
// distinct number within a run and a fresh run starts from a new seed.
const phoneFor = (index) => `09${String((seed + index * 104729) % 100000000).padStart(8, "0")}`;

const house = await prisma.house.findFirst({ orderBy: [{ capacity: "asc" }, { ordinal: "asc" }] });
if (!house) {
  console.log("no houses seeded -- run: npm run setup");
  process.exit(1);
}
const capacity = house.capacity;

// make sure the house starts empty for this round
await prisma.entry.deleteMany({ where: { houseId: house.id, round: house.round } });
await prisma.seat.updateMany({ where: { houseId: house.id }, data: { status: "open", heldUntil: null } });

const guard = await makeSession()("/houses");
check("houses list is not public JSON", guard.status === 200 || guard.status === 307, `status=${guard.status}`);

const anonClaim = await makeSession()(`/api/houses/${house.id}/seats/1`, { method: "POST" });
check("claiming a number needs a session", anonClaim.status === 401, JSON.stringify(anonClaim.body));

const participants = [];
for (let index = 1; index <= capacity; index += 1) {
  const phone = phoneFor(index);
  const request = makeSession();
  const register = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone, pin: "1234", pinConfirm: "1234", accepted: true }),
  });
  if (register.status !== 200) {
    check(`register participant ${index}`, false, JSON.stringify(register.body));
    break;
  }
  participants.push({ index, phone, request });
}
check(`registered ${participants.length} participants`, participants.length === capacity);

const firstLogin = await makeSession()("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ phone: participants[0]?.phone ?? "", pin: "9999" }),
});
check("wrong PIN is rejected", firstLogin.status === 400 && firstLogin.body?.error === "login_failed");

// a hand-typed seat link must be answered with 400, never a Prisma throw on NaN
for (const bad of ["abc", "3.5", "1e999", "0"]) {
  const refused = await participants[0].request(`/api/houses/${house.id}/seats/${bad}`, { method: "POST" });
  check(`a seat link of "${bad}" is refused`, refused.status === 400 && refused.body?.error === "number_out_of_range", JSON.stringify(refused.body));
}

let drawSeen = null;
for (const participant of participants) {
  const claim = await participant.request(`/api/houses/${house.id}/seats/${participant.index}`, { method: "POST" });
  if (claim.status !== 200) {
    check(`claim number ${participant.index}`, false, JSON.stringify(claim.body));
    break;
  }

  const pay = await participant.request(`/api/entries/${claim.body.entryId}/pay`, { method: "POST" });
  if (pay.status !== 200 || !pay.body?.checkoutUrl) {
    check(`start payment for ${participant.index}`, false, JSON.stringify(pay.body));
    break;
  }

  const merchOrderId = pay.body.checkoutUrl.split("/").pop();
  const settle = await participant.request(`/api/payments/${merchOrderId}`, { method: "POST" });
  if (!settle.body?.settled) {
    check(`settle payment ${participant.index}`, false, JSON.stringify(settle.body));
    break;
  }
  if (settle.body?.draw && !settle.body.draw.skipped) drawSeen = settle.body.draw;

  // only the last payment may trigger the draw
  if (participant.index < capacity) {
    check(
      `no early draw at ${participant.index}`,
      Boolean(settle.body.draw?.skipped),
      JSON.stringify(settle.body.draw),
    );
  }
}

const winnerCount = await prisma.draw.count({ where: { houseId: house.id, round: house.round } });
check("the last payment returned the draw", drawSeen !== null, JSON.stringify(drawSeen));
check("exactly one draw recorded for the filled round", winnerCount === 1, `draws=${winnerCount}`);

const rows = await prisma.draw.findMany({ where: { houseId: house.id, round: house.round }, orderBy: { createdAt: "desc" }, take: 1 });
if (rows[0]) {
  // Each house carries its own price now, so the expectation is read from the
  // house row and not derived from its size. The participant pays exactly that
  // price; the service charge is the quarter of it that the platform keeps, so
  // only the rest is what the pot is built from. Mirrored here so the portal
  // cannot quietly change the cut.
  const expectedPrice = house.priceCents;
  const expectedFee = expectedFeeForPrice(expectedPrice);
  const expectedPot = rows[0].participantCount * (expectedPrice - expectedFee);

  check("draw pot equals participants times the prize part of the price", rows[0].potCents === expectedPot, JSON.stringify({ pot: rows[0].potCents, expected: expectedPot, n: rows[0].participantCount }));

  const claimedEntry = await prisma.entry.findFirst({
    where: { houseId: house.id, round: house.round, seatNumber: 1 },
    select: { amountCents: true, feeCents: true },
  });
  check(
    "an entry is charged the house price with the service charge cut out of it",
    claimedEntry?.amountCents === expectedPrice && claimedEntry?.feeCents === expectedFee,
    JSON.stringify({ ...claimedEntry, expectedPrice, expectedFee }),
  );

  const roundEntries = await prisma.entry.findMany({
    where: { houseId: house.id, round: house.round },
    select: { id: true },
  });
  const settled = await prisma.payment.aggregate({
    where: { status: "success", entryId: { in: roundEntries.map((row) => row.id) } },
    _sum: { amountCents: true, feeCents: true },
    _count: { _all: true },
  });
  check(
    "the gateway was asked for the house price of every entry",
    settled._count._all === rows[0].participantCount && settled._sum.amountCents === settled._count._all * expectedPrice,
    JSON.stringify({ ...settled._sum, count: settled._count._all, expectedPrice }),
  );
  check(
    "pot equals the settled payments minus their service charges",
    settled._sum.amountCents - settled._sum.feeCents === expectedPot &&
      settled._sum.feeCents === rows[0].participantCount * expectedFee,
    JSON.stringify(settled._sum),
  );

  check("winner seat is inside the house", rows[0].winnerSeatNumber >= 1 && rows[0].winnerSeatNumber <= capacity);
  check("draw records verifiable entropy", rows[0].entropy.length === 64 && rows[0].commitment.length === 64);

  const pool = await prisma.entry.findMany({
    where: { houseId: house.id, round: rows[0].round, status: { in: ["won", "lost"] } },
    orderBy: { seatNumber: "asc" },
    select: { id: true, seatNumber: true },
  });
  const places = drawPlaces(rows[0].entropy, pool);
  check(
    "the three places re-draw from the published seed",
    places[0]?.id === rows[0].winnerEntryId &&
      places[1]?.id === rows[0].secondEntryId &&
      places[2]?.id === rows[0].thirdEntryId,
    JSON.stringify({
      drawn: places.map((entry) => entry.seatNumber),
      stored: [rows[0].winnerSeatNumber, rows[0].secondSeatNumber, rows[0].thirdSeatNumber],
    }),
  );
  check(
    "three different numbers hold a place",
    new Set([rows[0].winnerEntryId, rows[0].secondEntryId, rows[0].thirdEntryId]).size === 3,
    JSON.stringify([rows[0].winnerEntryId, rows[0].secondEntryId, rows[0].thirdEntryId]),
  );
  check(
    "every place seat is inside the house",
    [rows[0].winnerSeatNumber, rows[0].secondSeatNumber, rows[0].thirdSeatNumber].every(
      (seat) => seat >= 1 && seat <= capacity,
    ),
    JSON.stringify(rows[0]),
  );

  // 2nd takes a quarter, 3rd an eighth, 1st the rest, so the whole pot is paid
  const expectedSecond = Math.round(rows[0].potCents / 4);
  const expectedThird = Math.round(rows[0].potCents / 8);
  check(
    "2nd place gets a quarter of the pot",
    rows[0].secondCents === expectedSecond,
    JSON.stringify({ got: rows[0].secondCents, expected: expectedSecond }),
  );
  check(
    "3rd place gets an eighth of the pot",
    rows[0].thirdCents === expectedThird,
    JSON.stringify({ got: rows[0].thirdCents, expected: expectedThird }),
  );
  check(
    "1st place gets what the other two leave",
    rows[0].firstCents === rows[0].potCents - expectedSecond - expectedThird,
    JSON.stringify({ got: rows[0].firstCents, pot: rows[0].potCents }),
  );
  check(
    "the three shares add up to exactly the pot",
    rows[0].firstCents + rows[0].secondCents + rows[0].thirdCents === rows[0].potCents,
    JSON.stringify([rows[0].firstCents, rows[0].secondCents, rows[0].thirdCents, rows[0].potCents]),
  );

  const winner = await prisma.entry.findUnique({ where: { id: rows[0].winnerEntryId } });
  check("winner entry marked won", winner?.status === "won", `status=${winner?.status}`);
  const wonCount = await prisma.entry.count({
    where: { houseId: house.id, round: rows[0].round, status: "won" },
  });
  check("exactly three entries won a place", wonCount === 3, `won=${wonCount}`);
  const stillPaid = await prisma.entry.count({ where: { houseId: house.id, round: rows[0].round, status: "paid" } });
  check("losers moved out of the paid pool", stillPaid === 0, `paid=${stillPaid}`);
  const openSeats = await prisma.seat.count({ where: { houseId: house.id, status: "open" } });
  check("house reopens empty for the next round", openSeats === capacity, `open=${openSeats}`);
}

const nextRound = await prisma.house.findUnique({ where: { id: house.id } });
check("round advanced", (nextRound?.round ?? 0) === (house.round + 1), `round=${nextRound?.round}`);

// every confirmation and every draw is written to the owner's feed as it happens,
// so the portal reports itself even with no messenger configured
const paidFeed = await prisma.alert.count({
  where: { event: "payment_settled", channel: "dashboard", createdAt: { gte: startedAt } },
});
check("one feed entry per settled payment", paidFeed === capacity, `entries=${paidFeed}`);

const drawFeed = await prisma.alert.findMany({
  where: { event: "draw_settled", channel: "dashboard", createdAt: { gte: startedAt } },
  orderBy: { createdAt: "asc" },
});
check("the draw is reported once", drawFeed.length === 1, `entries=${drawFeed.length}`);
const feedLines = (drawFeed[0]?.body ?? "").split("\n");
check(
  "the feed entry names all three places",
  feedLines.length === 4 && feedLines.slice(1).every((line) => /#\d+/.test(line)),
  JSON.stringify(drawFeed[0]?.body),
);
check(
  "the feed entry carries no phone number",
  (drawFeed[0]?.body ?? "").match(/0\d{9}|\+251\d{9}/g) === null,
  JSON.stringify(drawFeed[0]?.body),
);

// the participant side of the same two events: each settled payment tells its
// owner, and the finished round tells the three winners and everyone else
const notices = await prisma.notice.findMany({
  where: { createdAt: { gte: startedAt } },
  include: { account: { select: { phone: true, telegramChatId: true } } },
});
const noticeOf = (event) => notices.filter((notice) => notice.event === event);

check(
  "one notice per settled payment",
  noticeOf("payment_settled").length === capacity,
  `rows=${noticeOf("payment_settled").length} of ${capacity}`,
);
check(
  "each settled number is told on its own account",
  new Set(noticeOf("payment_settled").map((notice) => notice.accountId)).size === capacity,
  `accounts=${new Set(noticeOf("payment_settled").map((notice) => notice.accountId)).size}`,
);
check(
  "three win notices and one closing notice for everyone else",
  noticeOf("draw_won").length === 3 && noticeOf("draw_closed").length === capacity - 3,
  JSON.stringify({ won: noticeOf("draw_won").length, closed: noticeOf("draw_closed").length }),
);

const settledDraw = await prisma.draw.findFirst({
  where: { houseId: house.id, createdAt: { gte: startedAt } },
  select: { winnerEntryId: true, secondEntryId: true, thirdEntryId: true },
});
const placeEntries = await prisma.entry.findMany({
  where: { id: { in: [settledDraw?.winnerEntryId ?? "", settledDraw?.secondEntryId ?? "", settledDraw?.thirdEntryId ?? ""] } },
  select: { accountId: true, seatNumber: true },
});
const seatByAccount = new Map(placeEntries.map((entry) => [entry.accountId, String(entry.seatNumber)]));
check(
  "the prize notices went to the three winning accounts",
  noticeOf("draw_won").every((notice) => seatByAccount.has(notice.accountId)),
  JSON.stringify(noticeOf("draw_won").map((notice) => notice.accountId)),
);
check(
  "a prize notice names the number it won",
  noticeOf("draw_won").every((notice) => notice.body.includes(seatByAccount.get(notice.accountId) ?? " ")),
  JSON.stringify(noticeOf("draw_won").map((notice) => notice.body)),
);
check(
  "no notice carries a wallet number",
  notices.every((notice) => notice.body.match(/0\d{9}|\+251\d{9}/g) === null),
  JSON.stringify(notices.map((notice) => notice.body).filter((body) => /0\d{9}|\+251\d{9}/.test(body))),
);

const openLegs = notices.filter((notice) => notice.telegram !== "none" || notice.sms !== "none");
check(
  "a leg is only opened where that account has a destination",
  openLegs.every(
    (notice) =>
      (notice.telegram === "none" || notice.account.telegramChatId !== null) &&
      (notice.sms === "none" || notice.account.phone !== null),
  ),
  `legs=${openLegs.length}`,
);
if (!process.env.ALERT_TELEGRAM_BOT_TOKEN && !process.env.ALERT_SMS_URL) {
  check(
    "with no participant gateway nothing is left waiting to leave",
    openLegs.length === 0,
    `legs=${openLegs.length}`,
  );
}

// the account behind number 1 is the one this session signed in as, and the
// stored phone is the normalised form, so the entry row is the safe link
const ownEntry = await prisma.entry.findFirst({
  where: { houseId: house.id, round: house.round, seatNumber: 1 },
  select: { accountId: true },
});
const ownAccountId = ownEntry?.accountId ?? "";
const mine = await participants[0]?.request.raw("/me");
const ownNotice = noticeOf("payment_settled").find((notice) => notice.accountId === ownAccountId);
check(
  "the participant reads their own notice on /me",
  mine?.status === 200 && ownNotice !== undefined && mine.text.includes(ownNotice?.body ?? " "),
  JSON.stringify({ status: mine?.status, found: ownNotice !== undefined }),
);

const anonRead = await makeSession()("/api/notices/read", { method: "POST" });
check("clearing the feed needs a session", anonRead.status === 401, JSON.stringify(anonRead.body));
const anonLink = await makeSession()("/api/notices/telegram", { method: "POST" });
check("asking for a link needs a session", anonLink.status === 401, JSON.stringify(anonLink.body));

const unreadBefore = await prisma.notice.count({ where: { accountId: ownAccountId, readAt: null } });
const marked = await participants[0]?.request("/api/notices/read", { method: "POST" });
const unreadAfter = await prisma.notice.count({ where: { accountId: ownAccountId, readAt: null } });
check(
  "marking the feed read clears exactly this account's notices",
  marked?.status === 200 && marked?.body?.marked === unreadBefore && unreadAfter === 0,
  JSON.stringify({ status: marked?.status, marked: marked?.body?.marked, unreadBefore, unreadAfter }),
);

// one number cannot be held twice, a live hold can be released by its owner, and
// an unpaid hold must be reclaimed by the sweep
const stragglers = participants.slice(0, 2);
if (stragglers.length === 2) {
  const claim = await stragglers[0].request(`/api/houses/${house.id}/seats/${capacity}`, { method: "POST" });
  check("the next round accepts a fresh claim", claim.status === 200, JSON.stringify(claim.body));

  const clash = await stragglers[1].request(`/api/houses/${house.id}/seats/${capacity}`, { method: "POST" });
  check("a held number cannot be taken twice", clash.status === 409 && clash.body?.error === "number_taken", JSON.stringify(clash.body));

  const release = await stragglers[0].request(
    `/api/houses/${house.id}/seats/${capacity}?entryId=${claim.body?.entryId ?? ""}`,
    { method: "DELETE" },
  );
  check("a participant can release a live number", release.status === 200, JSON.stringify(release.body));
  const freed = await prisma.seat.findFirst({ where: { houseId: house.id, number: capacity } });
  check("releasing opens the number for someone else", freed?.status === "open", `status=${freed?.status}`);

  const reClaim = await stragglers[1].request(`/api/houses/${house.id}/seats/${capacity}`, { method: "POST" });
  check("the released number is claimable by another account", reClaim.status === 200, JSON.stringify(reClaim.body));

  await prisma.seat.updateMany({
    where: { houseId: house.id, number: capacity },
    data: { heldUntil: new Date(Date.now() - 60_000) },
  });

  // nothing calls the server here: the timer it started by itself has to notice
  // the expired hold, otherwise the portal is not self-running at all
  let releasedByTimer = false;
  for (let waited = 0; waited < 95 && !releasedByTimer; waited += 2) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const watched = await prisma.seat.findFirst({ where: { houseId: house.id, number: capacity } });
    releasedByTimer = watched?.status === "open";
  }
  check(
    "the server reclaims an expired number on its own timer",
    releasedByTimer,
    "waited 95s without the sweep job running",
  );

  // a row the dispatcher cannot deliver: it must be claimed, tried and put on a
  // backoff, never sent in a loop and never read as a success
  const probe = await prisma.alert.create({
    data: {
      event: "gateway_error",
      channel: "telegram",
      subject: "verify probe",
      body: "verify probe",
      status: "pending",
      runAt: new Date(),
    },
  });

  const unauthorised = await fetch(`${BASE}/api/cron/draw`, { method: "POST" });
  check("the sweep refuses a request without the secret", unauthorised.status === 401 || unauthorised.status === 403, `status=${unauthorised.status}`);
  const sweep = await fetch(`${BASE}/api/cron/draw`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
  });
  check("cron sweep accepts the shared secret", sweep.status === 200, `status=${sweep.status}`);
  const seat = await prisma.seat.findFirst({ where: { houseId: house.id, number: capacity } });
  check("expired hold released the number", seat?.status === "open", `status=${seat?.status}`);

  const sweepBody = await sweep.json().catch(() => null);
  check(
    "the sweep reports released numbers and completed houses",
    typeof sweepBody?.released === "number" && typeof sweepBody?.checked === "number",
    JSON.stringify(sweepBody),
  );
  check(
    "the reconcile pass does not poll a development gateway",
    sweepBody?.reconciled?.checked === 0 && sweepBody?.reconciled?.error === null,
    JSON.stringify(sweepBody?.reconciled),
  );
  check(
    "the sweep reports the alert queue",
    typeof sweepBody?.alerts?.sent === "number" &&
      typeof sweepBody?.alerts?.queued === "number" &&
      typeof sweepBody?.alerts?.failed === "number",
    JSON.stringify(sweepBody?.alerts),
  );
  check(
    "the sweep reports the participant queue and the link poll",
    typeof sweepBody?.notices?.sent === "number" && typeof sweepBody?.links?.note === "string",
    JSON.stringify({ notices: sweepBody?.notices, links: sweepBody?.links }),
  );

  const holdFeed = await prisma.alert.findFirst({
    where: { event: "hold_expired", channel: "dashboard", createdAt: { gte: startedAt } },
    orderBy: { createdAt: "desc" },
  });

  check(
    "a reclaimed number is reported to the owner",
    holdFeed !== null && (holdFeed.body ?? "").includes(String(capacity)),
    JSON.stringify(holdFeed?.body),
  );

  const tried = await prisma.alert.findUnique({ where: { id: probe.id } });
  check(
    "an undeliverable alert is tried once per pass",
    (tried?.attempts ?? 0) >= 1 && tried?.status !== "sending",
    JSON.stringify({ attempts: tried?.attempts, status: tried?.status }),
  );
  check(
    "a failed alert waits on a backoff instead of a hot loop",
    tried?.status === "failed" || (tried !== null && tried.runAt.getTime() > Date.now()),
    JSON.stringify({ status: tried?.status, runAt: tried?.runAt }),
  );
  check(
    "an alert row keeps the reason it failed",
    tried?.lastError !== null && tried?.lastError !== undefined
      ? !tried.lastError.includes("bot") && !/\d{6,}/.test(tried.lastError)
      : false,
    JSON.stringify(tried?.lastError),
  );
  await prisma.alert.delete({ where: { id: probe.id } });

  const messengerConfigured = Boolean(
    process.env.ALERT_TELEGRAM_BOT_TOKEN ??
      process.env.ALERT_SMTP_HOST ??
      process.env.ALERT_SMS_URL ??
      "",
  );
  if (!messengerConfigured) {
    const stray = await prisma.alert.count({
      where: { channel: { not: "dashboard" }, status: { in: ["pending", "sending"] } },
    });
    check("nothing waits for a transport that is not configured", stray === 0, `rows=${stray}`);
  }

  const late = await stragglers[1].request(
    `/api/houses/${house.id}/seats/${capacity}?entryId=${reClaim.body?.entryId ?? ""}`,
    { method: "DELETE" },
  );
  check("an already expired hold cannot be released again", late.status === 409 && late.body?.error === "not_releasable", JSON.stringify(late.body));
}

// the charge is a quarter of the price in every house, and a house is priced by
// its own row rather than by how many seats it holds: the four 100 seat houses
// cost 100, 200, 500, 1000, 2000 or 5000 birr a seat depending on which one it is
const pricedHouses = await prisma.house.findMany({ orderBy: { ordinal: "asc" } });
check("every house is priced", pricedHouses.length === 17, `houses=${pricedHouses.length}`);

const byLabel = new Map(pricedHouses.map((row) => [row.label, row]));
check(
  "100A, 100B and 100C hold 100 numbers and cost 100 birr each",
  ["100A", "100B", "100C"].every((label) => {
    const row = byLabel.get(label);
    return row?.capacity === 100 && row.priceCents === 10000;
  }),
  JSON.stringify(pricedHouses.map((row) => [row.label, row.capacity, row.priceCents])),
);
check(
  "the 200, 500, 1000, 2000 and 5000 houses hold 100 numbers each",
  [200, 500, 1000, 2000, 5000].every((price) => {
    const row = byLabel.get(String(price));
    return row?.capacity === 100 && row.priceCents === price * 100;
  }),
  JSON.stringify(pricedHouses.map((row) => [row.label, row.capacity, row.priceCents])),
);

for (const row of pricedHouses) {
  const open = await prisma.seat.findFirst({
    where: { houseId: row.id, status: "open" },
    orderBy: { number: "asc" },
  });
  if (!open) continue;
  const price = row.priceCents;
  const fee = expectedFeeForPrice(price);
  const held = await participants[0].request(`/api/houses/${row.id}/seats/${open.number}`, { method: "POST" });
  const entry = await prisma.entry.findUnique({ where: { id: held.body?.entryId ?? "" } });
  check(
    `house ${row.label} charges ${price / 100} birr and cuts ${fee / 100} birr out of it`,
    held.status === 200 && entry?.feeCents === fee && entry?.amountCents === price,
    JSON.stringify({ status: held.status, entry: entry && { amountCents: entry.amountCents, feeCents: entry.feeCents } }),
  );
  await participants[0].request(
    `/api/houses/${row.id}/seats/${open.number}?entryId=${entry?.id ?? ""}`,
    { method: "DELETE" },
  );
}

// the wallet behind a number is shown only to the merchant who receives the
// payments, so every page a participant can open must stay number-only. The
// header always prints the signed-in account's own number, so the checks below
// look for someone else's.
const walletOf = (phone) => `+251${phone.slice(1)}`;
const viewer = participants[0]?.request ?? makeSession();
const stranger = participants[1]?.phone ?? "";

const live = await prisma.entry.findMany({
  where: { status: { in: ["pending_payment", "paid"] } },
  select: {
    round: true,
    house: { select: { round: true } },
    account: { select: { phone: true } },
  },
});
check(
  "a held number belongs to its house's current round",
  live.every((entry) => entry.round === entry.house.round),
  JSON.stringify(live.filter((entry) => entry.round !== entry.house.round)),
);
check(
  "every held number has one wallet behind it",
  live.every((entry) => /^\+\d{12}$/.test(entry.account.phone)),
  JSON.stringify(live.map((entry) => entry.account.phone).filter((phone) => !/^\+\d{12}$/.test(phone))),
);

if (stranger !== "") {
  const seen = [];
  for (const path of ["/admin", "/houses", `/houses/${house.id}`, "/me", "/draws"]) {
    seen.push([path, await viewer.raw(path)]);
  }
  for (const [path, page] of seen) {
    const leaked = page.text.includes(walletOf(stranger)) || page.text.includes(stranger);
    check(
      `${path} shown to a participant carries no other wallet number`,
      !leaked,
      `status=${page.status} leaked=${leaked}`,
    );
  }
  check(
    "a participant is turned away from the merchant list",
    seen
      .find(([path]) => path === "/admin")?.[1]?.text.includes('class="dash"') === false,
    JSON.stringify({ status: seen.find(([path]) => path === "/admin")?.[1]?.status }),
  );
}

// the per-house draw push runs the same completeness check the payment path
// runs, so a participant or an anonymous caller must not be able to reach it
// and a refused push must leave the round exactly as it was
const pushPath = `/api/admin/houses/${house.id}/draw`;
const roundBefore = (await prisma.house.findUnique({ where: { id: house.id } }))?.round;
const drawsBefore = await prisma.draw.count({ where: { houseId: house.id, round: roundBefore } });

const anonPush = await makeSession()(pushPath, { method: "POST" });
check("pushing a draw needs a session", anonPush.status === 401, JSON.stringify(anonPush.body));

const participantPush = await viewer(pushPath, { method: "POST" });
check(
  "a participant cannot push a draw",
  participantPush.status === 403 && participantPush.body?.error === "forbidden",
  JSON.stringify(participantPush.body),
);

const roundAfter = (await prisma.house.findUnique({ where: { id: house.id } }))?.round;
const drawsAfter = await prisma.draw.count({ where: { houseId: house.id, round: roundBefore } });
check(
  "a refused push does not move the round or record a draw",
  roundAfter === roundBefore && drawsAfter === drawsBefore,
  JSON.stringify({ roundBefore, roundAfter, drawsBefore, drawsAfter }),
);

await prisma.$disconnect();
const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
