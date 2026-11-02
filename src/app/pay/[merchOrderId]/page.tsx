import { notFound, redirect } from "next/navigation";
import { PayPanel } from "@/components/pay-panel";
import { TopupPanel } from "@/components/topup-panel";
import { currentAccount } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatEtb } from "@/lib/money";
import { entryPriceCents } from "@/lib/pricing";
import { merchantWallet } from "@/lib/telebirr/config";
import { currentLang, text } from "@/lib/locale";
import { resolveMode } from "@/lib/services/payments";
import { balanceOf, walletOfAccount } from "@/lib/services/wallet";

export default async function PayPage({ params }: { params: Promise<{ merchOrderId: string }> }) {
  const [t, lang] = await Promise.all([text(), currentLang()]);
  const { merchOrderId } = await params;
  const account = await currentAccount();
  if (!account) redirect("/login");

  // a seat order belongs to the account through its entry, a top-up order
  // through its wallet
  const payment = await prisma.payment.findFirst({
    where: {
      merchOrderId,
      OR: [
        { entry: { is: { accountId: account.accountId } } },
        { wallet: { is: { accountId: account.accountId } } },
      ],
    },
    include: {
      entry: {
        select: {
          id: true,
          status: true,
          seatNumber: true,
          houseId: true,
          house: { select: { label: true } },
        },
      },
    },
  });
  if (!payment) notFound();


  const resolution = resolveMode();
  const isTopup = payment.purpose === "topup";

  const statusLabel = isTopup
    ? payment.status === "success"
      ? t("wallet.credited")
      : payment.status === "failed"
        ? t("status.failed")
        : t("wallet.awaitingTopup")
    : payment.status === "success"
      ? t("status.paid")
      : payment.status === "failed"
        ? t("status.failed")
        : t("mine.pending");

  const own = await walletOfAccount(account.accountId);
  const walletCents = await balanceOf(own.id);
  // an unsettled top-up order has not reached the ledger yet, so the figure
  // shown for it is the balance it will leave once Telebirr confirms
  const projectedCents = isTopup
    ? walletCents + (payment.status === "success" ? 0 : payment.amountCents)
    : walletCents;

  return (
    <section className="center">
      <div className="sec-head">
        <div>
          <h2 style={{ paddingLeft: 0 }}>{isTopup ? t("wallet.topupTitle") : t("pay.title")}</h2>
        </div>
        <span className="pill num">
          {statusLabel} · {formatEtb(payment.amountCents)} {t("common.birr")}
        </span>
      </div>

      {"error" in resolution ? (
        <div className="alert">{resolution.error}</div>
      ) : isTopup ? (
        <TopupPanel
          lang={lang}
          merchOrderId={payment.merchOrderId}
          amountCents={payment.amountCents}
          balanceCents={projectedCents}
          payee={merchantWallet()}
          status={payment.status}
          mode={resolution.mode}
        />
      ) : (
        <PayPanel
          lang={lang}
          merchOrderId={payment.merchOrderId}
          entryId={payment.entry!.id}
          houseId={payment.entry!.houseId}
          seatNumber={payment.entry!.seatNumber}
          label={payment.entry!.house.label}
          prizeCents={entryPriceCents(payment)}
          feeCents={payment.feeCents}
          amountCents={payment.amountCents}
          balanceCents={walletCents}
          payee={merchantWallet()}
          status={payment.status}
          mode={resolution.mode}
        />
      )}

      <p className="mono" style={{ marginTop: 18 }}>
        {payment.merchOrderId}
      </p>
    </section>
  );
}
