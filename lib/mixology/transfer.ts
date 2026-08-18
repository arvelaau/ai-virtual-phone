// lib/mixology/transfer.ts
// House Special -- moving materials around offline: export to a file, import from one.
// The second route besides the online hall: backups, handing something to a friend, and
// moving between devices all work without a network.

import { downloadFile } from "@/lib/download-utils";
import {
    MIX_SLOT_ORDER,
    createMixId,
    type MixMaterial,
    type MixMaterialKind,
} from "./types";

const FILE_MARK = "float-mixology-material";
const FILE_VERSION = 1;

/** Text-chunk keyword for our PNG card. Our own format, deliberately different from the
 *  SillyTavern character-card keywords (chara/ccv3). */
const PNG_KEYWORD = "float-mixology-card";
/** Keywords used by third-party character-card formats (SillyTavern V2/V3 and friends).
 *  Always rejected. */
const THIRD_PARTY_PNG_KEYWORDS = ["chara", "ccv3"];

type MixTransferFile = {
    mark: typeof FILE_MARK;
    version: number;
    material: MixMaterial;
};

function safeFileName(name: string): string {
    // Replace characters a filename cannot contain with underscores. Non-ASCII is kept.
    const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
    return cleaned || "material";
}


// -- PNG card: our own format, with the data embedded in the image ------------------
// The payload is base64 JSON written into a PNG tEXt chunk (keyword float-mixology-card),
// so the picture IS the card. If a SillyTavern keyword (chara/ccv3) turns up while parsing,
// it is rejected outright.

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function isPng(u8: Uint8Array): boolean {
    return PNG_SIG.every((b, i) => u8[i] === b);
}

/** Walk the PNG's text chunks and return a keyword -> text map (tEXt is latin1; an
 *  uncompressed iTXt segment is utf8) */
function readPngTextChunks(u8: Uint8Array): Map<string, string> {
    const out = new Map<string, string>();
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let offset = 8;
    while (offset + 12 <= u8.length) {
        const length = dv.getUint32(offset);
        const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
        const data = u8.subarray(offset + 8, offset + 8 + length);
        if (type === "tEXt") {
            const sep = data.indexOf(0);
            if (sep > 0) {
                out.set(new TextDecoder().decode(data.subarray(0, sep)).toLowerCase(), new TextDecoder("latin1").decode(data.subarray(sep + 1)));
            }
        } else if (type === "iTXt") {
            const pos = data.indexOf(0);
            if (pos > 0) {
                const kw = new TextDecoder().decode(data.subarray(0, pos)).toLowerCase();
                const compressed = data[pos + 1];
                let cursor = pos + 3;
                cursor = data.indexOf(0, cursor) + 1; // language tag
                cursor = data.indexOf(0, cursor) + 1; // translated keyword
                if (compressed === 0 && cursor > 0) out.set(kw, new TextDecoder().decode(data.subarray(cursor)));
            }
        }
        if (type === "IEND") break;
        offset += 12 + length;
    }
    return out;
}

let _crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
    if (!_crcTable) {
        _crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            _crcTable[n] = c;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
}

/** Insert a tEXt chunk just before IEND */
function insertPngTextChunk(u8: Uint8Array, keyword: string, text: string): Uint8Array {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let offset = 8;
    let iendOffset = -1;
    while (offset + 12 <= u8.length) {
        const length = dv.getUint32(offset);
        const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
        if (type === "IEND") { iendOffset = offset; break; }
        offset += 12 + length;
    }
    if (iendOffset < 0) throw new Error("This PNG is malformed.");
    const kwBytes = new TextEncoder().encode(keyword);
    const textBytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff); // base64 is pure ASCII
    const payload = new Uint8Array(kwBytes.length + 1 + textBytes.length);
    payload.set(kwBytes, 0);
    payload[kwBytes.length] = 0;
    payload.set(textBytes, kwBytes.length + 1);
    const chunk = new Uint8Array(12 + payload.length);
    const cdv = new DataView(chunk.buffer);
    cdv.setUint32(0, payload.length);
    chunk.set(new TextEncoder().encode("tEXt"), 4);
    chunk.set(payload, 8);
    const crcBody = chunk.subarray(4, 8 + payload.length);
    cdv.setUint32(8 + payload.length, crc32(crcBody));
    const out = new Uint8Array(u8.length + chunk.length);
    out.set(u8.subarray(0, iendOffset), 0);
    out.set(chunk, iendOffset);
    out.set(u8.subarray(iendOffset), iendOffset + chunk.length);
    return out;
}

/** Parse materials out of a PNG card; third-party formats such as SillyTavern cards are
 *  always rejected with an error */
export function parseMixMaterialsFromPng(buffer: ArrayBuffer): MixMaterial[] {
    const u8 = new Uint8Array(buffer);
    if (!isPng(u8)) throw new Error("That is not a valid PNG file.");
    const chunks = readPngTextChunks(u8);
    const ours = chunks.get(PNG_KEYWORD);
    if (ours) {
        let json: string;
        try {
            json = decodeURIComponent(escape(atob(ours.trim())));
        } catch {
            throw new Error("This card's data is corrupted. Please export it again.");
        }
        return parseMixMaterialsFromJson(json);
    }
    if (THIRD_PARTY_PNG_KEYWORDS.some((kw) => chunks.has(kw))) {
        throw new Error("Third-party character-card formats are not supported.");
    }
    throw new Error("There is no House Special card data in this PNG.");
}

/** Draw the cover dataURL as the PNG's base image; with no cover, draw a plain placeholder card */
async function buildCardImage(card: MixMaterial): Promise<Uint8Array> {
    const W = 600;
    const H = 880;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This environment does not support canvas.");
    if (card.cover) {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error("Could not decode the cover image"));
            el.src = card.cover as string;
        });
        // cover-fill, cropping the overflow
        const scale = Math.max(W / img.width, H / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
        const grad = ctx.createLinearGradient(0, 0, W * 0.7, H);
        grad.addColorStop(0, "#2a2438");
        grad.addColorStop(0.55, "#161320");
        grad.addColorStop(1, "#0c0a12");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "rgba(242, 240, 247, 0.9)";
        ctx.font = "600 44px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(card.name.slice(0, 12), W / 2, H / 2);
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png");
    });
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Export one material as a PNG card in our own format (the picture is the card).
 * Saving always goes through downloadFile: the system share sheet on iOS, an ordinary
 * download everywhere else -- the same behaviour as the app market, theme pack and regex
 * group exports.
 */
export async function exportMixMaterialPng(material: MixMaterial): Promise<void> {
    const payload: MixTransferFile = { mark: FILE_MARK, version: FILE_VERSION, material };
    const base64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const png = insertPngTextChunk(await buildCardImage(material), PNG_KEYWORD, base64);
    const blob = new Blob([png.buffer as ArrayBuffer], { type: "image/png" });
    await downloadFile(blob, `${safeFileName(material.name)}.png`);
}

/** Export one material as a .json file (as above: the share sheet on iOS) */
export async function exportMixMaterial(material: MixMaterial): Promise<void> {
    const payload: MixTransferFile = { mark: FILE_MARK, version: FILE_VERSION, material };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    await downloadFile(blob, `${safeFileName(material.name)}.json`);
}

function isMixKind(value: unknown): value is MixMaterialKind {
    return typeof value === "string" && (MIX_SLOT_ORDER as string[]).includes(value);
}

/**
 * Parse imported JSON text.
 * Accepts three shapes: a wrapped file exported by this tool, a bare material object, and
 * an array of several at once.
 * Every import is given a fresh id, so it can never overwrite an existing cabinet material
 * that happens to share its name.
 */
export function parseMixMaterialsFromJson(text: string): MixMaterial[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("That is not a valid JSON file.");
    }

    const candidates: unknown[] = [];
    const collect = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (record.mark === FILE_MARK && record.material) {
            collect(record.material);
            return;
        }
        candidates.push(record);
    };
    collect(parsed);

    const now = Date.now();
    const materials: MixMaterial[] = [];
    for (const candidate of candidates) {
        const record = candidate as Record<string, unknown>;
        if (!isMixKind(record.kind)) continue;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        if (!name) continue;
        // A character card needs at least one opening line, or no session can start
        if (record.kind === "character") {
            const openings = Array.isArray(record.openings)
                ? record.openings.filter((o): o is string => typeof o === "string" && Boolean(o.trim()))
                : [];
            if (openings.length === 0) continue;
            // Anything imported from a file counts as your own local work: fresh id, publish
            // link and imported flag stripped, so editing, exporting and publishing all behave
            // normally. (The "somebody else's work" restriction applies to installs from the
            // materials page, which is a different path.)
            materials.push({
                ...(record as unknown as MixMaterial),
                id: createMixId("mixmat"),
                publishedId: undefined,
                publishedAt: undefined,
                imported: undefined,
                name,
                openings,
                createdAt: now,
                updatedAt: now,
            } as MixMaterial);
            continue;
        }
        materials.push({
            ...(record as unknown as MixMaterial),
            id: createMixId("mixmat"),
            publishedId: undefined,
            publishedAt: undefined,
            imported: undefined,
            name,
            createdAt: now,
            updatedAt: now,
        } as MixMaterial);
    }

    if (materials.length === 0) {
        // Third-party JSON such as a SillyTavern V2/V3 card: say plainly that it is not
        // supported, rather than the vaguer "nothing recognizable here"
        const isThirdPartyCard = (value: unknown): boolean => {
            if (!value || typeof value !== "object") return false;
            const record = value as Record<string, unknown>;
            const spec = typeof record.spec === "string" ? record.spec : "";
            if (/^chara_card/i.test(spec)) return true;
            if ("first_mes" in record || "mes_example" in record) return true;
            const data = record.data;
            return Boolean(data && typeof data === "object" && "first_mes" in (data as Record<string, unknown>));
        };
        if (candidates.some(isThirdPartyCard)) {
            throw new Error("Third-party character-card formats are not supported.");
        }
        throw new Error("No recognizable material in this file.");
    }
    return materials;
}
