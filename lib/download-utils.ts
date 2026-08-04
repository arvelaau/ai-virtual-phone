export type DownloadFileOptions = {
    disableNativeShare?: boolean;
    nativeShareOnly?: boolean;
};

export function isAndroidBrowser(): boolean {
    return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export function isIOSBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    return /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export async function downloadFile(blob: Blob, filename: string, options: DownloadFileOptions = {}): Promise<void> {
    const url = URL.createObjectURL(blob);
    const anchorDownload = () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const shouldUseNativeShare = options.nativeShareOnly || (!options.disableNativeShare && isIOSBrowser());
    if (shouldUseNativeShare) {
        const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
        // navigator.share requires a SECURE CONTEXT. Over plain http:// on a LAN address
        // (e.g. http://192.168.1.5:3001) it is not merely unreliable — it is `undefined`.
        // That is the common case when testing from a phone against the dev server.
        const shareApiAvailable = typeof navigator !== "undefined"
            && typeof navigator.share === "function"
            && typeof navigator.canShare === "function";
        const canNativeShare = shareApiAvailable && navigator.canShare({ files: [file] });

        if (canNativeShare) {
            try {
                await navigator.share({ files: [file] });
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            } catch (err) {
                // User explicitly dismissed the share sheet → respect it, don't force a download.
                if (err instanceof DOMException && err.name === "AbortError") {
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    return;
                }
                // The share sheet existed but failed (webview without real file-share
                // support, lost user activation, …). Surface it rather than opening the
                // blob URL, which can navigate away from the app.
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                throw new Error("The browser could not open the system share sheet. Try again in Safari, or export a lightweight backup instead.");
            }
        }

        // No Share API at all. Throwing here would leave the user with nothing, so fall
        // back to a normal download: iOS Safari 13+ honours <a download> for blob URLs
        // and saves into Files. This is what makes Export Backup work over plain http.
        anchorDownload();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
    }

    anchorDownload();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadUrl(url: string, filename: string): Promise<void> {
    let blob: Blob | null = null;

    try {
        const res = await fetch(url);
        if (res.ok) blob = await res.blob();
    } catch { /* CORS or network error — try proxy */ }

    if (!blob && /^https?:\/\//.test(url)) {
        try {
            const res = await fetch("/api/tool-proxy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, method: "GET" }),
            });
            if (res.ok) blob = await res.blob();
        } catch { /* proxy also failed */ }
    }

    if (blob) {
        await downloadFile(blob, filename);
    } else {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
}
