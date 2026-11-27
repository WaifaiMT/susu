import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: no cookie means no session, so skip straight to
// sign-in. Real authorization happens on the server in every page and action.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("session")) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/orgs/:path*", "/o/:path*"],
};
