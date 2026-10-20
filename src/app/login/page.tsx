import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { t } from "@/lib/ui";
import { currentAccount } from "@/lib/auth";

export default async function LoginPage() {
  if (await currentAccount()) redirect("/houses");

  return (
    <section className="center">
      <AuthForm mode="login" />
      <p className="note">
        <Link href="/register">{t("auth.noAccount")}</Link>
      </p>
    </section>
  );
}
