import { NextRequest, NextResponse } from "next/server";

import baseManifest from "../../public/manifest.json";

export const runtime = "nodejs";

// Edge's installed PWA renders the top status-bar area as a solid (black) band in
// `standalone` mode instead of showing the native status bar. Serving `minimal-ui`
// + a light theme_color brings the native status bar (clock/battery/signal) back —
// but ONLY for Edge, so Chrome/others keep the fully immersive `standalone` look.
// The manifest is fetched per browser at install time, so UA sniffing here works.
// Takes effect only on (re)install.
export function GET(request: NextRequest) {
  const ua = request.headers.get("user-agent") || "";
  const isEdge = /Edg/i.test(ua);

  const manifest = isEdge
    ? {
        ...baseManifest,
        display: "minimal-ui",
        display_override: ["minimal-ui", "standalone"],
        theme_color: "#f8f7f2",
      }
    : baseManifest;

  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      // Must vary by UA and not be CDN-cached, or one browser's manifest would be
      // served to another.
      "vary": "user-agent",
      "cache-control": "no-store",
    },
  });
}
