export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const path = req.query.path.join("/");
  const r = await fetch(`https://api.arliai.com/v1/${path}`, {
    method: req.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.authorization || "",
    },
    body: req.method === "GET" ? undefined : JSON.stringify(req.body),
  });
  res.status(r.status).send(await r.text());
}
