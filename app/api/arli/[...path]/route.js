export const dynamic = "force-dynamic";

const BASE = "https://api.arliai.com/v1";

async function proxy(req, { params }) {
  const { path } = await params;
  const { search } = new URL(req.url);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  const upstream = await fetch(`${BASE}/${path.join("/")}${search}`, {
    method: req.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.get("authorization") || "",
    },
    body: hasBody ? await req.text() : undefined,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") || "application/json",
    },
  });
}

export const GET = proxy;
export const POST = proxy;
