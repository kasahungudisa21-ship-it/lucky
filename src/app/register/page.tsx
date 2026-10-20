import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { t } from "@/lib/ui";
import { currentAccount } from "@/lib/auth";

export default async function RegisterPage() {
  if (await currentAccount()) redirect("/houses");

  return (
    <section className="center">
      <AuthForm mode="register" />
      <p className="note">
        <Link href="/login">{t("auth.haveAccount")}</Link>
      </p>
    </section>
  );
}
