import { NextRequest, NextResponse } from "next/server";

/**
 * Web Share Target receiver. Android/desktop share sheets POST title/text/url
 * here; we forward the combined text to the quick-capture screen.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const form = await req.formData().catch(() => null);
  const parts = form
    ? [form.get("title"), form.get("text"), form.get("url")]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean)
    : [];
  const text = parts.join("\n").slice(0, 4000);
  // Behind Fly's proxy, req.url is the internal 0.0.0.0:3000 address. Use the
  // forwarded public host so the share sheet lands on the real app.
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    req.nextUrl.host;
  const proto =
    req.headers.get("x-forwarded-proto") ??
    req.nextUrl.protocol.replace(":", "") ??
    "https";
  const url = new URL("/capture", `${proto}://${host}`);
  if (text) url.searchParams.set("text", text);
  return NextResponse.redirect(url, { status: 303 });
}
