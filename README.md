# ላኪ · LUCKY — Telebirr lucky-draw portal

Participants claim a numbered seat in a house, pay with Telebirr, and a filled house draws
1st/2nd/3rd automatically. Identity is **number-only**: the portal never collects names, and
wallet phone numbers appear only on `/admin`.

Stack: Next.js 15 App Router, React 19, TypeScript (strict), Prisma + SQLite, Telebirr C2B
adapter (RSA-PSS signing), self-running scheduler.

## Quick start

```bash
npm ci
cp .env.example .env      # then fill in the values you actually need
npm run setup             # prisma db push + seed 9 houses
npm run dev               # http://localhost:3210
```

| Script | What it does |
| --- | --- |
| `npm run dev` / `npm start` | serve on port 3210 (`predev` runs `prisma generate`) |
| `npm run build` | `prisma generate && next build` — never run while a dev server holds `.next` on Windows |
| `npm run setup` | `prisma db push` then `tsx prisma/seed.ts` |
| `npm run verify` | end-to-end harness (`scripts/verify-flow.mjs`) against the local app |
| `npm run check:signer` | RSA-PSS signing/verification checks with a throwaway keypair |
| `npm run check:gateway` | offline dry run of the real Telebirr path (mock gateway, no money moves) |
| `npm run i18n` | regenerate `src/lib/ui.ts` from `scripts/strings.en.json` + `scripts/amharic-authored.json` |
| `npm run lint` / `npm run typecheck` | ESLint 9 / `tsc --noEmit` |

## Money model

`src/lib/pricing.ts` and `src/lib/houses.ts` are the source of truth:

- Each house carries its own `priceCents` and `label`; the service charge is
  `SERVICE_RATE = 0.25` cut **out of** that price, so `potPart = priceCents - feeCents`.
- A full house's pot splits 5/8 to 1st, 1/4 to 2nd, 1/8 to 3rd (`prizeShares`).
- Seats are held for `SEAT_HOLD_MINUTES = 15`; an account may hold at most
  `MAX_HELD_PER_HOUSE = 3` numbers in one house.
- Prize shares are credited to participant wallets; withdrawals are queued for the owner to
  mark paid. All balances live in the ledger (`Wallet` / `LedgerEntry`), never as a stored total.

## Payments

`PAYMENT_MODE` selects the behaviour resolved in `src/lib/services/payments.ts`:

- `simulate` — dev only. Refused when `NODE_ENV=production`, so a sandbox can never be reached
  by real customers.
- `telebirr` — requires all of `TELEBIRR_FABRIC_APP_ID`, `TELEBIRR_APP_SECRET`,
  `TELEBIRR_MERCHANT_APP_ID`, `TELEBIRR_MERCHANT_CODE`, `TELEBIRR_PRIVATE_KEY`,
  `TELEBIRR_NOTIFY_URL` (plus `TELEBIRR_PUBLIC_KEY` to verify gateway notifications).
  `TELEBIRR_ENVIRONMENT` is `test` or `production`; keys may be PEM or bare base64 DER.

Browser callbacks are never trusted on their own: the notify route and `reconcile.ts` re-query
the gateway and compare the amount before anything is marked paid, so a public HTTPS notify URL
is useful but not strictly required. **`npm run check:gateway` is the readiness gate** — it passes
fully only once real merchant credentials are in place.

## Routes

`/` house list · `/houses/[houseId]` seat board and claiming · `/register` + `/login` phone and PIN ·
`/pay/[merchOrderId]` checkout hand-off and result · `/me` own numbers, wallet and notices ·
`/draws` recorded results · `/admin` owner dashboard (gated on the merchant wallet) ·
`/api/lang` cookie-only locale switch (`lucky_lang`, Amharic default) · `/api/cron/draw` sweep,
guarded by `CRON_SECRET` and normally driven by the in-process scheduler (`RUN_SCHEDULER`).

## Deployment

`docker-compose.yml` + `Dockerfile` run the portal plus its own scheduler; the database lives on a
mounted `./data` volume (`DATABASE_URL=file:/data/lucky.db`). `.dockerignore` excludes `.env` and every
`*.db`, so no development data or secret reaches an image. Note this packaging has been audited by
reading only — it has not been built on the machine used for development.

## Repo hygiene

`.env`, `dev.db` and its backups, `node_modules`, `.next`, `data/` and `*.log` are ignored; the
commit history contains no credential material. Outbound SMS, Telegram and owner alerts are Amharic
by design, independent of the page language.
