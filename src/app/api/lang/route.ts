/**
 * Switches the language of the screen.
 *
 * A GET rather than a form post, so the switcher in the header is an ordinary
 * link that works before any JavaScript has loaded.
 */
import { NextResponse, type NextRequest } from "next/server";
import { LANG_COOKIE, isLang } from "@/lib/locale";

/** Only ever a path on this portal: a leading "//" would be a protocol-relative
 * redirect to somebody else's site. */
function safePath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

/** Back to the page the switcher was clicked on: the caller's own path, or the
 * referring page when the link did not carry one. */
function backTo(request: NextRequest): string {
  const explicit = safePath(request.nextUrl.searchParams.get("next"));
  if (explicit) return explicit;
  const referer = request.headers.get("referer");
  if (referer) {
    const url = new URL(referer);
    if (url.origin === request.nextUrl.origin) return `${url.pathname}${url.search}`;
  }
  return "/";
}

export async function GET(request: NextRequest) {
  const to = request.nextUrl.searchParams.get("to");
  const back = new URL(backTo(request), request.url);
  if (!isLang(to)) return NextResponse.redirect(back);

  const response = NextResponse.redirect(back);
  response.cookies.set(LANG_COOKIE, to, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
