import { notFound, redirect } from "next/navigation";
import { PayPanel } from "@/components/pay-panel";
import { currentAccount } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatEtb } from "@/lib/money";
import { entryPriceCents } from "@/lib/pricing";
import { merchantWallet } from "@/lib/telebirr/config";
import { t } from "@/lib/ui";
import { resolveMode } from "@/lib/services/payments";

export default async function PayPage({ params }: { params: Promise<{ merchOrderId: string }> }) {
  const { merchOrderId } = await params;
  const account = await currentAccount();
  if (!account) redirect("/login");

  const payment = await prisma.payment.findFirst({
    where: { merchOrderId, entry: { accountId: account.accountId } },
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

  const statusLabel =
    payment.status === "success"
      ? t("status.paid")
      : payment.status === "failed"
        ? t("status.failed")
        : t("mine.pending");

  return (
    <section className="center">
      <div className="sec-head">
        <div>
          <h2 style={{ paddingLeft: 0 }}>{t("pay.title")}</h2>
        </div>
        <span className="pill num">
          {statusLabel} · {formatEtb(payment.amountCents)} {t("common.birr")}
        </span>
      </div>

      {"error" in resolution ? (
        <div className="alert">{resolution.error}</div>
      ) : (
        <PayPanel
          merchOrderId={payment.merchOrderId}
          entryId={payment.entry.id}
          houseId={payment.entry.houseId}
          seatNumber={payment.entry.seatNumber}
          label={payment.entry.house.label}
          prizeCents={entryPriceCents(payment)}
          feeCents={payment.feeCents}
          amountCents={payment.amountCents}
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
