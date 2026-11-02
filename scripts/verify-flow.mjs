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
import { readFileSync } from "node:fs";
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
    const placed = new Set(places.map((entry) => entry.accountId));
    const fresh = remaining.filter((entry) => !placed.has(entry.accountId));
    const candidates = fresh.length > 0 ? fresh : remaining;
    const chosen = candidates[pickIndex(Buffer.from(entropyHex, "hex"), candidates.length, place)];
    places.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
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
  // A jar keyed by name, because a visit now carries two cookies: the session
  // and the chosen language. Deleting a cookie is a set with an empty value.
  const jar = new Map();
  const asHeader = () =>
    jar.size ? [...jar].map(([name, value]) => `${name}=${value}`).join("; ") : "";
  const absorb = (response) => {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0];
      const name = pair.slice(0, pair.indexOf("=")).trim();
      const value = pair.slice(pair.indexOf("=") + 1).trim();
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
  };
  const request = async function (path, init = {}) {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(jar.size ? { Cookie: asHeader() } : {}) },
    });
    absorb(response);
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body, location: response.headers.get("location") };
  };
  // the same session reading a server-rendered page instead of an API route,
  // so a check can look for a wallet number inside the HTML a person is shown
  request.raw = async function (path) {
    const response = await fetch(`${BASE}${path}`, {
      headers: jar.size ? { Cookie: asHeader() } : {},
    });
    absorb(response);
    return { status: response.status, text: await response.text() };
  };
  return request;
}

const suffix = String(Date.now()).slice(-7);
const seed = Number(suffix);
// "09" + 8 digits. 104729 * capacity stays under 1e8, so each participant gets a
// distinct number within a run and a fresh run starts from a new seed.
const phoneFor = (index) => `09${String((seed + index * 104729) % 100000000).padStart(8, "0")}`;

// Take the smallest house whose current round nobody is standing in. Deleting
// the round instead would let a test run destroy numbers real participants paid
// for, and a harness must never be able to do that.
const candidates = await prisma.house.findMany({ orderBy: [{ capacity: "asc" }, { ordinal: "asc" }] });
if (candidates.length === 0) {
  console.log("no houses seeded -- run: npm run setup");
  process.exit(1);
}
let house = null;
for (const candidate of candidates) {
  if (!candidate.isOpen) continue;
  const liveHere = await prisma.entry.count({
    where: { houseId: candidate.id, round: candidate.round, status: { in: ["pending_payment", "paid"] } },
  });
  const openSeats = await prisma.seat.count({ where: { houseId: candidate.id, status: "open" } });
  if (liveHere === 0 && openSeats === candidate.capacity) {
    house = candidate;
    break;
  }
}
if (!house) {
  console.log(
    "no open house has an untouched round: every candidate already holds paid numbers or seats still on hold",
  );
  process.exit(1);
}
const capacity = house.capacity;

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
    where: { houseId: house.id, round: house.round, seatNumber: 1, createdAt: { gte: startedAt } },
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
    select: { id: true, seatNumber: true, accountId: true },
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
// stored phone is the normalised form, so the entry row is the safe link.
// Earlier runs leave released rows behind in the same round, so this run's own
// rows are the only ones the link may use.
const ownEntry = await prisma.entry.findFirst({
  where: { houseId: house.id, round: house.round, seatNumber: 1, createdAt: { gte: startedAt } },
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

// Two languages on the screen, one language out of the phone: switching changes
// what a visitor reads, never what was already sent to them.
const ETHIOPIC = /[\u1200-\u12FF]/;
const ETHIOPIC_ALL = /[\u1200-\u12FF]/g;
// Two pieces of Amharic stay on an English page on purpose: the brand, and the
// switcher, which names the language it offers in that language's own script.
// Stripping whole words only, so any real Amharic sentence still shows up.
const AMHARIC_LABEL = String.fromCodePoint(0x12a0, 0x121b, 0x122d, 0x129b); // LANG_LABELS.am
const withoutBrand = (html) =>
  html
    .split(AMHARIC_LABEL)
    .join("")
    .replace(/\u120B\u12AA|\u120B/g, "");
const stillAmharic = (html) => html.includes('<html lang="am"');

const visitor = makeSession();
const homeAmharic = await visitor.raw("/");
check(
  "a visitor who never chose a language is served Amharic",
  homeAmharic.status === 200 &&
    stillAmharic(homeAmharic.text) &&
    !homeAmharic.text.includes("Pick your number"),
  `status=${homeAmharic.status}`,
);

const switched = await visitor("/api/lang?to=en", { redirect: "manual" });
check(
  "the switch sends the visitor back rather than answering with a page",
  switched.status === 307,
  `status=${switched.status}`,
);

const homeEnglish = await visitor.raw("/");
check(
  "the rest of that visit is English, tag and text alike",
  homeEnglish.text.includes('<html lang="en"') &&
    homeEnglish.text.includes("Pick your number, pay with Telebirr"),
  `status=${homeEnglish.status}`,
);
check(
  "an English page keeps no Amharic but the brand and the language switcher",
  !ETHIOPIC.test(withoutBrand(homeEnglish.text)),
  JSON.stringify([...new Set(withoutBrand(homeEnglish.text).match(ETHIOPIC_ALL) ?? [])].slice(0, 6)),
);
const catalogKeys = Object.keys(
  JSON.parse(readFileSync(new URL("./strings.en.json", import.meta.url), "utf8")),
);
// asked as a dotted-namespace regex, this matched dev-mode module paths like
// src/lib/auth.ts, so the real catalog keys are used instead
const rawKeys = catalogKeys.filter((key) => withoutBrand(homeEnglish.text).includes(key));
check(
  "the switch never leaves a raw key on the screen",
  rawKeys.length === 0,
  JSON.stringify(rawKeys.slice(0, 5)),
);

const refused = await visitor("/api/lang?to=de", { redirect: "manual" });
const afterRefusal = await visitor.raw("/");
check(
  "a language the portal does not have is refused and changes nothing",
  refused.status === 307 && afterRefusal.text.includes('<html lang="en"'),
  `status=${refused.status}`,
);
/** Where the switch sends the browser: this portal, and never somebody else's host. */
function staysOnPortal(location) {
  if (!location) return false;
  if (/^\/(?!\/)/.test(location)) return true;
  try {
    return new URL(location).host === new URL(BASE).host;
  } catch {
    return false;
  }
}

const smuggled = await visitor("/api/lang?to=am&next=https://evil.example.com/x", {
  redirect: "manual",
});
check(
  "the switch cannot be used to send a visitor off the portal",
  staysOnPortal(smuggled.location) && !smuggled.location.includes("evil"),
  `location=${smuggled.location}`,
);

// the signed-in pages are the ones made of client components, so the language
// has to travel into the browser for them too
const participantEnglish = await participants[0]?.request("/api/lang?to=en", {
  redirect: "manual",
});
const boardEnglish = await participants[0]?.request.raw(`/houses/${house.id}`);
const mineEnglish = await participants[0]?.request.raw("/me");
check(
  "a number held by this account is offered in English on its own page",
  participantEnglish?.status === 307 &&
    boardEnglish?.status === 200 &&
    !ETHIOPIC.test(withoutBrand(boardEnglish?.text ?? "")),
  JSON.stringify({ status: boardEnglish?.status }),
);
check(
  "a participant in English still reads the notice exactly as it was sent",
  mineEnglish?.status === 200 &&
    mineEnglish.text.includes("My numbers") &&
    mineEnglish.text.includes(ownNotice?.body ?? " \uFFFF"),
  JSON.stringify({
    status: mineEnglish?.status,
    noticeWasAmharic: ETHIOPIC.test(ownNotice?.body ?? ""),
  }),
);

const wentBack = await participants[0]?.request("/api/lang?to=am", { redirect: "manual" });
const boardAmharic = await participants[0]?.request.raw(`/houses/${house.id}`);
check(
  "the switch goes back to Amharic, which the rest of this run reads",
  wentBack?.status === 307 &&
    stillAmharic(boardAmharic?.text ?? "") &&
    ETHIOPIC.test(boardAmharic?.text ?? ""),
  `status=${boardAmharic?.status}`,
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

  // a person may keep several numbers in one house, but not the whole house
  const openNumbers = (
    await prisma.seat.findMany({
      where: { houseId: house.id, status: "open" },
      orderBy: { number: "asc" },
      take: 4,
      select: { number: true },
    })
  ).map((seat) => seat.number);
  if (openNumbers.length === 4) {
    const holder = stragglers[0];
    const heldRows = [];
    for (const number of openNumbers.slice(0, 3)) {
      const hold = await holder.request(`/api/houses/${house.id}/seats/${number}`, { method: "POST" });
      if (hold.status === 200) heldRows.push({ number, entryId: hold.body?.entryId });
    }
    check(
      "one account can hold three numbers in the same house",
      heldRows.length === 3 && new Set(heldRows.map((row) => row.number)).size === 3,
      JSON.stringify({ heldRows, openNumbers }),
    );
    check(
      "the three numbers are three separate live entries",
      (await prisma.entry.count({
        where: { id: { in: heldRows.map((row) => row.entryId) }, status: "pending_payment" },
      })) === 3,
      JSON.stringify(heldRows.map((row) => row.entryId)),
    );

    const fourth = await holder.request(`/api/houses/${house.id}/seats/${openNumbers[3]}`, { method: "POST" });
    check(
      "a fourth number is refused by the house limit",
      fourth.status === 409 && fourth.body?.error === "number_limit",
      JSON.stringify(fourth.body),
    );

    const again = await holder.request(`/api/houses/${house.id}/seats/${openNumbers[0]}`, { method: "POST" });
    check(
      "tapping a number already held keeps that same number",
      again.status === 200 && again.body?.entryId === heldRows[0].entryId,
      JSON.stringify({ again: again.body, first: heldRows[0] }),
    );

    // the countdown the board ticks down comes from the seat's own deadline
    const board = await holder.request.raw(`/houses/${house.id}`);
    const deadline = await prisma.seat.findFirst({
      where: { houseId: house.id, number: openNumbers[0] },
      select: { heldUntil: true },
    });
    const expiresIso = deadline?.heldUntil?.toISOString() ?? "";
    check(
      "the board hands each held number its pay-by deadline",
      board?.status === 200 && expiresIso !== "" && board.text.includes(expiresIso),
      JSON.stringify({ status: board?.status, expiresIso }),
    );

    for (const row of heldRows) {
      await holder.request(`/api/houses/${house.id}/seats/${row.number}?entryId=${row.entryId}`, {
        method: "DELETE",
      });
    }
    const afterRelease = await holder.request(`/api/houses/${house.id}/seats/${openNumbers[3]}`, {
      method: "POST",
    });
    check(
      "the limit counts live holds only, so releasing one opens a place",
      afterRelease.status === 200,
      JSON.stringify(afterRelease.body),
    );
    await holder.request(
      `/api/houses/${house.id}/seats/${openNumbers[3]}?entryId=${afterRelease.body?.entryId ?? ""}`,
      { method: "DELETE" },
    );
  }

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

// ---------------------------------------------------------------- balances
// Money a participant keeps on their own wallet: the ledger is the only record,
// so every check below compares what the portal reports with the rows behind it.
const TOPUP_MIN = 1000;
/** accounts are stored normalized, so a local 09… number has to be converted first */
const balanceOf = async (phone) =>
  prisma.wallet.findFirst({
    where: { account: { phone: walletOf(phone) } },
    select: { id: true, accountId: true },
  });
const sumOf = async (walletId) => {
  const sum = await prisma.ledgerEntry.aggregate({ where: { walletId }, _sum: { deltaCents: true } });
  return sum._sum.deltaCents ?? 0;
};
/** the same figure the portal prints, so a check can look for it in the page */
const birr = (cents) => (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

const runPhones = participants.map((participant) => walletOf(participant.phone));
const runWallets = await prisma.wallet.count({ where: { account: { phone: { in: runPhones } } } });
check(
  "every account this run registered has its own balance",
  runWallets === participants.length,
  `wallets=${runWallets} of ${participants.length}`,
);

const anonTopup = await makeSession()("/api/wallet/topup", {
  method: "POST",
  body: JSON.stringify({ amountCents: 5000 }),
});
check("adding to a balance needs a session", anonTopup.status === 401, JSON.stringify(anonTopup.body));

const tinyTopup = await participants[0].request("/api/wallet/topup", {
  method: "POST",
  body: JSON.stringify({ amountCents: TOPUP_MIN - 1 }),
});
check(
  "a top-up below the minimum is refused",
  tinyTopup.status === 400 && tinyTopup.body?.error === "amount_out_of_range",
  JSON.stringify(tinyTopup.body),
);

const halfTopup = await participants[0].request("/api/wallet/topup", {
  method: "POST",
  body: JSON.stringify({ amountCents: 2050.5 }),
});
check(
  "a top-up that is not whole cents is refused",
  halfTopup.status === 400 && halfTopup.body?.error === "invalid_amount",
  JSON.stringify(halfTopup.body),
);

const topupCents = 5000;
const openedTopup = await participants[0].request("/api/wallet/topup", {
  method: "POST",
  body: JSON.stringify({ amountCents: topupCents }),
});
const topupOrder = openedTopup.body?.merchOrderId ?? "";
check(
  "a top-up opens a gateway order of its own",
  openedTopup.status === 200 && topupOrder !== "" && openedTopup.body?.checkoutUrl?.includes(topupOrder),
  JSON.stringify(openedTopup.body),
);
const unconfirmedRows = await prisma.ledgerEntry.count({ where: { kind: "topup", refId: topupOrder } });
check("an unconfirmed top-up is not on the balance yet", unconfirmedRows === 0, `rows=${unconfirmedRows}`);

const settledTopup = await participants[0].request(`/api/payments/${topupOrder}`, { method: "POST" });
check(
  "confirming a top-up moves the money onto the balance",
  settledTopup.body?.settled === true && settledTopup.body?.kind === "topup",
  JSON.stringify(settledTopup.body),
);
const replayTopup = await participants[0].request(`/api/payments/${topupOrder}`, { method: "POST" });
const topupRows = await prisma.ledgerEntry.count({ where: { kind: "topup", refId: topupOrder } });
check(
  "the same top-up order can only credit once",
  replayTopup.body?.settled === false && replayTopup.body?.reason === "already" && topupRows === 1,
  JSON.stringify({ replay: replayTopup.body, rows: topupRows }),
);

const topupFeed = await prisma.alert.findFirst({
  where: { event: "wallet_topup", channel: "dashboard", createdAt: { gte: startedAt } },
  orderBy: { createdAt: "desc" },
});
check(
  "a balance top-up is reported to the owner without a wallet number",
  topupFeed !== null &&
    (topupFeed.body ?? "").includes(birr(topupCents)) &&
    (topupFeed.body ?? "").match(/0\d{9}|\+251\d{9}/g) === null,
  JSON.stringify(topupFeed?.body),
);
check(
  "the participant is told about their own top-up",
  (await prisma.notice.count({ where: { event: "wallet_topup", createdAt: { gte: startedAt } } })) === 1,
);

const walletA = await balanceOf(participants[0].phone);
check(
  "the balance the portal reports is the ledger sum",
  settledTopup.body?.balanceCents === (await sumOf(walletA.id)),
  JSON.stringify({ reported: settledTopup.body?.balanceCents, ledger: await sumOf(walletA.id) }),
);
const meWithWallet = await participants[0].request.raw("/me");
check(
  "/me shows the balance panel with its own inputs",
  meWithWallet.status === 200 &&
    meWithWallet.text.includes('id="wallet-topup"') &&
    meWithWallet.text.includes('id="wallet-withdraw"'),
  `status=${meWithWallet.status}`,
);

// a number paid from the balance spends money that Telebirr already reported at
// top-up time, so it must write a receipt, spend once, and never go negative.
// The round above credits prizes into some participants' wallets, so these tests
// take a participant whose own ledger is still empty instead of a fixed index.
const touchedAccounts = new Set(placeEntries.map((entry) => entry.accountId));
let balanceRunner = null;
let runnerWalletId = "";
for (const candidate of participants.slice(1)) {
  const wallet = await balanceOf(candidate.phone);
  if (!wallet || touchedAccounts.has(wallet.accountId)) continue;
  if ((await sumOf(wallet.id)) !== 0) continue;
  balanceRunner = candidate;
  runnerWalletId = wallet.id;
  break;
}
check(
  "a participant untouched by the round is available for the balance tests",
  balanceRunner !== null,
);
const openSeat = await prisma.seat.findFirst({
  where: { houseId: house.id, status: "open" },
  orderBy: { number: "asc" },
  select: { number: true },
});
const seatClaim = await balanceRunner.request(`/api/houses/${house.id}/seats/${openSeat?.number ?? 1}`, {
  method: "POST",
});
const seatEntry = await prisma.entry.findUnique({
  where: { id: seatClaim.body?.entryId ?? "" },
  select: { amountCents: true, status: true },
});
const shortPay = await balanceRunner.request(`/api/entries/${seatClaim.body?.entryId}/pay-balance`, {
  method: "POST",
});
check(
  "an empty balance cannot pay for a number",
  shortPay.status === 402 && shortPay.body?.error === "insufficient_balance",
  JSON.stringify(shortPay.body),
);
const afterShort = await prisma.entry.findUnique({
  where: { id: seatClaim.body?.entryId ?? "" },
  select: { status: true },
});
check(
  "a refused balance payment leaves the number still payable",
  afterShort?.status === "pending_payment" && seatEntry?.status === "pending_payment",
  `status=${afterShort?.status}`,
);

const priceCents = seatEntry?.amountCents ?? 0;
const fundedTopup = await balanceRunner.request("/api/wallet/topup", {
  method: "POST",
  body: JSON.stringify({ amountCents: priceCents }),
});
await balanceRunner.request(`/api/payments/${fundedTopup.body?.merchOrderId}`, { method: "POST" });
const balancePayAt = new Date();
const balancePay = await balanceRunner.request(`/api/entries/${seatClaim.body?.entryId}/pay-balance`, {
  method: "POST",
});
check(
  "a number can be paid from the balance",
  balancePay.status === 200 && balancePay.body?.paid === true,
  JSON.stringify(balancePay.body),
);
const walletB = await balanceOf(balanceRunner.phone);
const seatDebits = await prisma.ledgerEntry.findMany({
  where: { walletId: walletB.id, kind: "seat" },
  select: { deltaCents: true },
});
check(
  "the balance payment spends the money exactly once",
  seatDebits.length === 1 && seatDebits[0].deltaCents === -priceCents,
  JSON.stringify({ seatDebits, priceCents }),
);
const balanceReceipt = await prisma.payment.findFirst({
  where: { entryId: seatClaim.body?.entryId, status: "success", purpose: "seat" },
  select: { amountCents: true, rawPayload: true },
});
check(
  "a number paid from the balance writes one receipt for the full price, tagged as balance money",
  balanceReceipt !== null &&
    balanceReceipt.amountCents === priceCents &&
    String(balanceReceipt.rawPayload).includes("wallet_balance") &&
    (await prisma.payment.count({ where: { entryId: seatClaim.body?.entryId, purpose: "seat" } })) === 1,
  JSON.stringify({ receipt: balanceReceipt, priceCents }),
);
const replaySeatPay = await balanceRunner.request(
  `/api/entries/${seatClaim.body?.entryId}/pay-balance`,
  { method: "POST" },
);
check(
  "a replayed balance payment cannot spend twice",
  replaySeatPay.status === 409 &&
    (await prisma.ledgerEntry.count({ where: { walletId: walletB.id, kind: "seat" } })) === 1,
  JSON.stringify(replaySeatPay.body),
);
const balanceSeatFeed = await prisma.alert.count({
  where: { event: "seat_from_balance", channel: "dashboard", createdAt: { gte: startedAt } },
});
check("the owner is told a number was paid from a balance", balanceSeatFeed === 1, `rows=${balanceSeatFeed}`);

const paidNotice = await prisma.notice.findFirst({
  where: {
    event: "payment_settled",
    createdAt: { gte: balancePayAt },
    account: { phone: walletOf(balanceRunner.phone) },
  },
  select: { body: true },
});
const meAfterPaid = await balanceRunner.request.raw("/me");
check(
  "a balance payment tells the participant which number it bought and the page shows that notice",
  paidNotice !== null && meAfterPaid.status === 200 && meAfterPaid.text.includes(paidNotice.body),
  JSON.stringify({ notice: paidNotice?.body, status: meAfterPaid.status }),
);

// prizes land on the winners' balances inside the draw itself
const runDraw = await prisma.draw.findFirst({
  where: { houseId: house.id, createdAt: { gte: startedAt } },
  select: { id: true, potCents: true, payoutStatus: true },
});
const prizeRows = await prisma.ledgerEntry.findMany({
  where: { kind: "prize", createdAt: { gte: startedAt } },
  select: { walletId: true, deltaCents: true, refId: true },
});
const prizeSum = prizeRows.reduce((total, row) => total + row.deltaCents, 0);
check(
  "a settled draw credits three prizes and says so",
  runDraw !== null &&
    runDraw.payoutStatus === "credited" &&
    prizeRows.length === 3 &&
    new Set(prizeRows.map((row) => row.walletId)).size === 3,
  JSON.stringify({ payout: runDraw?.payoutStatus, rows: prizeRows.length }),
);
check(
  "the credited prizes add up to exactly the pot",
  prizeSum === (runDraw?.potCents ?? -1),
  JSON.stringify({ prizeSum, pot: runDraw?.potCents }),
);
check(
  "a prize is credited once per place per draw",
  new Set(prizeRows.map((row) => row.refId)).size === prizeRows.length,
  JSON.stringify(prizeRows.map((row) => row.refId)),
);

// withdrawals: a request books an intention, the owner's answer moves money
const anonWithdraw = await makeSession()("/api/wallet/withdrawal", {
  method: "POST",
  body: JSON.stringify({ amountCents: TOPUP_MIN }),
});
check("asking for a withdrawal needs a session", anonWithdraw.status === 401, JSON.stringify(anonWithdraw.body));

const tinyWithdraw = await participants[0].request("/api/wallet/withdrawal", {
  method: "POST",
  body: JSON.stringify({ amountCents: TOPUP_MIN - 1 }),
});
check(
  "a withdrawal below the minimum is refused",
  tinyWithdraw.status === 400 && tinyWithdraw.body?.error === "invalid_amount",
  JSON.stringify(tinyWithdraw.body),
);
const overWithdraw = await participants[0].request("/api/wallet/withdrawal", {
  method: "POST",
  body: JSON.stringify({ amountCents: (await sumOf(walletA.id)) + 100 }),
});
check(
  "a withdrawal larger than the balance is refused",
  overWithdraw.status === 402 && overWithdraw.body?.error === "insufficient_balance",
  JSON.stringify(overWithdraw.body),
);

const beforeRequest = await sumOf(walletA.id);
const askedWithdrawal = await participants[0].request("/api/wallet/withdrawal", {
  method: "POST",
  body: JSON.stringify({ amountCents: 2345 }),
});
check(
  "a participant can ask for their money back",
  askedWithdrawal.status === 200 &&
    askedWithdrawal.body?.requested === true &&
    askedWithdrawal.body?.status === "pending",
  JSON.stringify(askedWithdrawal.body),
);
const secondRequest = await participants[0].request("/api/wallet/withdrawal", {
  method: "POST",
  body: JSON.stringify({ amountCents: TOPUP_MIN }),
});
check(
  "only one withdrawal can wait at a time",
  secondRequest.status === 409 && secondRequest.body?.error === "pending_exists",
  JSON.stringify(secondRequest.body),
);
const waitingRow = await prisma.withdrawal.findFirst({
  where: { walletId: walletA.id },
  orderBy: { createdAt: "desc" },
});
check(
  "a waiting request moves no money",
  waitingRow?.status === "pending" &&
    (await prisma.ledgerEntry.count({ where: { walletId: walletA.id, kind: "withdrawal" } })) === 0 &&
    (await sumOf(walletA.id)) === beforeRequest,
  JSON.stringify({ status: waitingRow?.status, beforeRequest }),
);
const withdrawFeed = await prisma.alert.findFirst({
  where: { event: "withdrawal_requested", channel: "dashboard", createdAt: { gte: startedAt } },
  orderBy: { createdAt: "desc" },
});
check(
  "the owner is told a withdrawal is waiting, without a wallet number",
  withdrawFeed !== null &&
    (withdrawFeed.body ?? "").includes(birr(2345)) &&
    (withdrawFeed.body ?? "").match(/0\d{9}|\+251\d{9}/g) === null,
  JSON.stringify(withdrawFeed?.body),
);

const anonResolve = await makeSession()(`/api/admin/withdrawals/${waitingRow?.id ?? ""}`, {
  method: "POST",
  body: JSON.stringify({ outcome: "paid" }),
});
check("answering a withdrawal needs a session", anonResolve.status === 401, JSON.stringify(anonResolve.body));
const selfResolve = await participants[0].request(`/api/admin/withdrawals/${waitingRow?.id ?? ""}`, {
  method: "POST",
  body: JSON.stringify({ outcome: "paid" }),
});
check(
  "a participant cannot mark their own withdrawal paid",
  selfResolve.status === 403 && selfResolve.body?.error === "forbidden",
  JSON.stringify(selfResolve.body),
);
const meAfterRequest = await participants[0].request.raw("/me");
check(
  "/me reports the withdrawal that is waiting",
  meAfterRequest.status === 200 && meAfterRequest.text.includes(birr(waitingRow?.amountCents ?? 0)),
  `status=${meAfterRequest.status}`,
);

// a second house, filled by buyers who each keep two numbers: the pot still has
// to land on three different people. It has to be an untouched house, because the
// earlier phases leave live holds behind in the first one.
const roomyHouses = await prisma.house.findMany({
  where: { id: { not: house.id }, isOpen: true, capacity: { lte: participants.length * 3 } },
  orderBy: [{ capacity: "asc" }, { ordinal: "asc" }],
});
let shared = null;
for (const candidate of roomyHouses) {
  const [openSeats, live] = await Promise.all([
    prisma.seat.count({ where: { houseId: candidate.id, status: "open" } }),
    prisma.entry.count({
      where: { houseId: candidate.id, round: candidate.round, status: { in: ["pending_payment", "paid"] } },
    }),
  ]);
  if (openSeats === candidate.capacity && live === 0) {
    shared = candidate;
    break;
  }
}
check(
  "an untouched house is free for the shared-buyer round",
  shared !== null,
  `candidates=${roomyHouses.length} — close seats or entries in every small house block this test`,
);
if (shared) {
  // fill it with as few buyers as the house limit allows — three numbers each —
  // so any place that ignored the fresh-account rule would show up here
  const held = [];
  let filled = true;
  for (let number = 1; number <= shared.capacity && filled; number += 1) {
    const buyer = participants[Math.floor((number - 1) / 3)];
    const claim = await buyer.request(`/api/houses/${shared.id}/seats/${number}`, { method: "POST" });
    if (claim.status !== 200) {
      filled = false;
      break;
    }
    held.push({ buyer, entryId: claim.body?.entryId, number });
  }
  check(
    "buyers holding three numbers each can fill a whole house",
    filled && held.length === shared.capacity,
    JSON.stringify({ filled, seats: held.length, capacity: shared.capacity }),
  );

  for (const row of held) {
    const pay = await row.buyer.request(`/api/entries/${row.entryId}/pay`, { method: "POST" });
    const settle = await row.buyer.request(
      `/api/payments/${pay.body?.checkoutUrl?.split("/").pop() ?? ""}`,
      { method: "POST" },
    );
    if (!settle.body?.settled) check(`settle the shared round at ${row.number}`, false, JSON.stringify(settle.body));
  }

  const drawn = await prisma.draw.findFirst({
    where: { houseId: shared.id, round: shared.round },
    orderBy: { createdAt: "desc" },
  });
  check("a house filled by shared buyers draws", drawn !== null, `round=${shared.round}`);
  if (drawn) {
    const places = await prisma.entry.findMany({
      where: { id: { in: [drawn.winnerEntryId, drawn.secondEntryId, drawn.thirdEntryId] } },
      select: { accountId: true, seatNumber: true },
    });
    check(
      "the three prize places go to three different buyers",
      new Set(places.map((entry) => entry.accountId)).size === 3,
      JSON.stringify(places),
    );

    const pool2 = await prisma.entry.findMany({
      where: { houseId: shared.id, round: shared.round, status: { in: ["won", "lost"] } },
      orderBy: { seatNumber: "asc" },
      select: { id: true, seatNumber: true, accountId: true },
    });
    const replay = drawPlaces(drawn.entropy, pool2);
    check(
      "the shared-buyer round re-draws from its published seed",
      replay[0]?.id === drawn.winnerEntryId &&
        replay[1]?.id === drawn.secondEntryId &&
        replay[2]?.id === drawn.thirdEntryId,
      JSON.stringify({
        drawn: replay.map((entry) => entry.seatNumber),
        stored: [drawn.winnerSeatNumber, drawn.secondSeatNumber, drawn.thirdSeatNumber],
      }),
    );
  }
}

// The number bought with balance money joins no draw, so leaving it live would
// keep this house out of every later run. Remove the rows this run created for
// it, by the ids it holds, and hand the seat back: nobody else's numbers are
// ever touched.
await prisma.$transaction(async (tx) => {
  // the top-up and the seat spend carry different order ids, so the pair is found
  // by what it is: this wallet held nothing before the phase started
  await tx.ledgerEntry.deleteMany({ where: { walletId: runnerWalletId, kind: { in: ["topup", "seat"] } } });
  await tx.payment.deleteMany({ where: { entryId: seatClaim.body?.entryId } });
  await tx.entry.deleteMany({ where: { id: seatClaim.body?.entryId ?? "" } });
  await tx.seat.updateMany({
    where: { houseId: house.id, number: openSeat?.number ?? 1 },
    data: { status: "open", heldUntil: null },
  });
});
const balanceEntryRows = await prisma.entry.count({ where: { id: seatClaim.body?.entryId ?? "" } });
const handedBackSeat = await prisma.seat.count({
  where: { houseId: house.id, number: openSeat?.number ?? 1, status: "open" },
});
check(
  "the run hands the number it bought with balance money back to the pool",
  balanceEntryRows === 0 && handedBackSeat === 1,
  JSON.stringify({ entryRows: balanceEntryRows, seatRows: handedBackSeat }),
);

const allWallets = await prisma.ledgerEntry.groupBy({ by: ["walletId"], _sum: { deltaCents: true } });
check(
  "no balance anywhere can go below zero",
  allWallets.every((row) => (row._sum.deltaCents ?? 0) >= 0),
  JSON.stringify(allWallets.filter((row) => (row._sum.deltaCents ?? 0) < 0)),
);

await prisma.$disconnect();

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
