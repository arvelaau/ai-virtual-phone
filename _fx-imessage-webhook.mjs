// Fixture for lib/imessage-webhook-core.ts + the Spectrum signature scheme the route relies on.
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import path from "node:path";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const core = jiti("./lib/imessage-webhook-core.ts");
const { verifySpectrumSignature } = await import("@spectrum-ts/core/webhook");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};

// A: address normalisation + line matching
eq("A1 phone formats equal", core.normalizeIMessageAddress("+1 (555) 123-4567"), core.normalizeIMessageAddress("15551234567"));
eq("A2 email lowercased", core.normalizeIMessageAddress(" Foo@Bar.COM "), "foo@bar.com");
eq("A3 empty", core.normalizeIMessageAddress(""), "");
const index = { format: "x", version: 1, updatedAt: "", lines: [
  { lineId: "l1", phone: "+15551234567", characterId: "c1", characterName: "A", sessionId: "s1", path: "p1", updatedAt: "" },
  { lineId: "l2", phone: "+442071838750", characterId: "c2", characterName: "B", sessionId: "s2", path: "p2", updatedAt: "" },
] };
eq("A4 match by digits", core.findLineForSender(index, "+1 555 123 4567")?.lineId, "l1");
eq("A5 second line", core.findLineForSender(index, "442071838750")?.lineId, "l2");
eq("A6 unbound -> null", core.findLineForSender(index, "+19998887777"), null);
eq("A7 empty sender -> null", core.findLineForSender(index, ""), null);

// B: model output -> bubbles
eq("B1 plain split", core.modelOutputToBubbles("hi\n\nhow are you"), ["hi", "how are you"]);
eq("B2 strips inner + state", core.modelOutputToBubbles("[InnerThoughts]secret[/InnerThoughts]\n\nhello"), ["hello"]);
eq("B3 strips think", core.modelOutputToBubbles("<think>plan</think>hey"), ["hey"]);
eq("B4 multi-word survives", core.modelOutputToBubbles("Blue Ceramic Mug is great"), ["Blue Ceramic Mug is great"]);
eq("B5 empty", core.modelOutputToBubbles("   "), []);
eq("B6 no 5-bubble cap any more (only a runaway guard)", core.modelOutputToBubbles(Array.from({ length: 9 }, (_, i) => `m${i}`).join("\n\n")).length, 9);
eq("B7 unclosed inner does not leak", core.modelOutputToBubbles("[InnerThoughts]oops\nreal reply")[0], "real reply");

// C: prompt composition
const tpl = { version: 1, slotToken: "T", beforeMessages: [{ role: "system", content: "SYS" }, { role: "user", content: "old" }], afterMessages: [{ role: "system", content: "TAIL" }], baseHistoryLength: 1, createdAt: "" };
const stored = (id, t, role, content) => ({ format: "ai-phone-imessage-cloud-message", version: 1, direction: role === "user" ? "inbound" : "outbound", lineId: "l1", characterId: "c1", sessionId: "s1", externalId: id, createdAt: t, role, content });
const recent = [stored("a", "2026-01-01T00:00:00Z", "user", "baked"), stored("c", "2026-01-03T00:00:00Z", "assistant", "later-b"), stored("b", "2026-01-02T00:00:00Z", "user", "later-a")];
const since = core.messagesAfterSnapshot(recent, "2026-01-01T12:00:00Z", 20);
eq("C1 drops baked history", since.map(m => m.externalId), ["b", "c"]);
eq("C2 sorted ascending", since.map(m => m.content), ["later-a", "later-b"]);
const built = core.buildPromptFromTemplate(tpl, since, "NEW");
eq("C3 order", built.map(m => m.content), ["SYS", "old", "later-a", "later-b", "NEW", "TAIL"]);
eq("C4 new msg is user role", built[4].role, "user");
eq("C5 limit keeps newest", core.messagesAfterSnapshot(recent, "2025-01-01T00:00:00Z", 1).map(m => m.externalId), ["c"]);

// D: path safety
eq("D1 sanitised path", core.inboundMessagePath("p", "l/1", "../x y"), "p/messages/l_1/___x_y.json");

// E: signature scheme (v0=HMAC-SHA256(secret, "v0:ts:body"))
const secret = "whsec_test";
const body = new TextEncoder().encode(JSON.stringify({ event: "message", message: { id: "1" } }));
const ts = String(Math.floor(Date.now() / 1000));
const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:`).update(Buffer.from(body)).digest("hex");
const hdr = (s, t = ts) => ({ "x-spectrum-signature": s, "x-spectrum-timestamp": t });
eq("E1 valid", (await verifySpectrumSignature({ headers: hdr(sig), rawBody: body, secret })).ok, true);
eq("E2 wrong secret", (await verifySpectrumSignature({ headers: hdr(sig), rawBody: body, secret: "nope" })).ok, false);
const tampered = new TextEncoder().encode(JSON.stringify({ event: "message", message: { id: "2" } }));
eq("E3 tampered body", (await verifySpectrumSignature({ headers: hdr(sig), rawBody: tampered, secret })).ok, false);
eq("E4 missing headers", (await verifySpectrumSignature({ headers: {}, rawBody: body, secret })).ok, false);
eq("E5 stale timestamp", (await verifySpectrumSignature({ headers: hdr(sig, "1000"), rawBody: body, secret })).ok, false);

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
