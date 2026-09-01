import { NextResponse, type NextRequest } from "next/server";

const APP_PASSWORD = process.env.APP_PASSWORD;
const APP_USERNAME = process.env.APP_USERNAME || "admin";

export function middleware(request: NextRequest) {
  // No password configured = public access (dev mode)
  if (!APP_PASSWORD) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = atob(encoded);
      const [user, pass] = decoded.split(":");
      if (user === APP_USERNAME && pass === APP_PASSWORD) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Gemini Balance"',
      "Content-Type": "text/plain",
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
