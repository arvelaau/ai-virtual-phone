// Stand-in for @spectrum-ts/core, @spectrum-ts/core/webhook and @spectrum-ts/imessage so a
// fixture can load the webhook route under jiti (the real SDK pulls in a gRPC client that
// jiti cannot evaluate). Aliased in by _fx-imessage-webhook-route.mjs.
//
// verifySpectrumSignature mirrors the documented scheme:
//   X-Spectrum-Signature = "v0=" + hex(HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody))
// _fx-imessage-webhook.mjs (group E) asserts that the REAL SDK function accepts exactly this
// construction, which is what keeps this stub honest.
const { createHmac, timingSafeEqual } = require("node:crypto");

const TOLERANCE_SECONDS = 5 * 60;

async function verifySpectrumSignature({ headers, rawBody, secret, now }) {
    const signature = headers["x-spectrum-signature"];
    const timestamp = headers["x-spectrum-timestamp"];
    if (!signature || !timestamp) return { ok: false, reason: "missing-headers" };
    const nowSec = Math.floor((now ?? Date.now()) / 1000);
    if (!Number.isFinite(Number(timestamp)) || Math.abs(nowSec - Number(timestamp)) > TOLERANCE_SECONDS) {
        return { ok: false, reason: "expired" };
    }
    const expected = "v0=" + createHmac("sha256", secret)
        .update(`v0:${timestamp}:`)
        .update(Buffer.from(rawBody))
        .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature-mismatch" };
    return { ok: true };
}

async function Spectrum() {
    throw new Error("Spectrum() is stubbed in fixtures; the work after after() is not exercised here.");
}

const imessage = { config: () => ({}) };

module.exports = { verifySpectrumSignature, Spectrum, imessage };
