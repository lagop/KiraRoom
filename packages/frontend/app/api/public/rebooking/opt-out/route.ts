import { NextResponse } from "next/server";

const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1").replace(/\/+$/, "");

/**
 * The opt-out link of rebooking reminders sent before they carried the
 * shared unsubscribe link. It pointed here, where nothing answered (404).
 * The API checks the old signature and redirects to that client's
 * unsubscribe page (/public/baja/...), whose button unsubscribes; opening
 * the link alone changes nothing.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams({
    token: params.get("token") ?? "",
    client: params.get("client") ?? "",
  });
  return NextResponse.redirect(`${API}/rebooking/public/opt-out?${query.toString()}`, 302);
}
