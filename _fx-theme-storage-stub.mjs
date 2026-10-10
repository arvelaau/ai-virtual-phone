// Minimal in-memory stand-in for lib/theme-storage.ts, used only by this project's Node
// fixtures. The real module does raster normalization via browser Image/Canvas APIs that don't
// exist under Node; this stub skips normalization entirely and just round-trips the blob as a
// data URL, which is all lib/chat-asset-storage.ts's two functions need.
let nextId = 1;
const store = new Map();

async function blobToDataUrl(blob) {
    const buf = Buffer.from(await blob.arrayBuffer());
    const mimeType = blob.type || "application/octet-stream";
    return `data:${mimeType};base64,${buf.toString("base64")}`;
}

export async function saveThemeAssetFromBlob(blob, _type) {
    const id = `fx-theme-asset-${nextId++}`;
    store.set(id, await blobToDataUrl(blob));
    return id;
}

export async function getThemeAssetDataUrl(id) {
    return store.has(id) ? store.get(id) : null;
}

export async function deleteThemeAsset(id) {
    store.delete(id);
}
