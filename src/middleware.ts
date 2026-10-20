import { NextResponse, type NextRequest } from "next/server";

const PROTECTED = ["/houses", "/me", "/pay"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!PROTECTED.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();
  if (request.cookies.has("lucky_session")) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/houses/:path*", "/me/:path*", "/pay/:path*"],
};
