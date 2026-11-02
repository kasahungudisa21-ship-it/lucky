import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { currentLang, text } from "@/lib/locale";
import { currentAccount } from "@/lib/auth";

export default async function LoginPage() {
  const [t, lang] = await Promise.all([text(), currentLang()]);
  if (await currentAccount()) redirect("/houses");

  return (
    <section className="center">
      <AuthForm mode="login" lang={lang} />
      <p className="note">
        <Link href="/register">{t("auth.noAccount")}</Link>
      </p>
    </section>
  );
}
