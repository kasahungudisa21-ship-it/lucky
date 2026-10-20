"use client";

import { useRouter } from "next/navigation";

export function SignOutButton({ cookieName, label }: { cookieName: string; label: string }) {
  const router = useRouter();

  return (
    <button
      className="btn btn-ghost"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
      data-cookie={cookieName}
    >
      {label}
    </button>
  );
}
