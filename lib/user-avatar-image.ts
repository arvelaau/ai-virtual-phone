/** Compresses an album image into a data URL suitable for saving as a local user avatar. */
export function fileToUserAvatarDataUrl(file: File, maxSize = 640, quality = 0.86): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read the image"));
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error("Could not process the image"));
            image.onload = () => {
                const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                const context = canvas.getContext("2d");
                if (!context) { reject(new Error("Could not process the image")); return; }
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/webp", quality));
            };
            image.src = String(reader.result || "");
        };
        reader.readAsDataURL(file);
    });
}
