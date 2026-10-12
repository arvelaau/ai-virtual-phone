// lib/photo-style.ts
// The "looks like a real phone photo" style block that is appended to chat / Moments photo
// prompts. Leaf module with no imports, so settings, the image service and the settings page
// can all share one default.

export const DEFAULT_NATURAL_PHOTO_STYLE = [
    "Photographic style: an unedited photo taken casually and handheld on an iPhone 15 main camera (24mm equivalent, f/1.6, Smart HDR processing).",
    "Natural available light, realistic exposure and colors, mild sensor noise and slightly soft detail in dim places, true-to-life skin texture with pores and small imperfections, no retouching and no beauty filter.",
    "Candid and slightly imperfect framing, the way an ordinary person shoots: a normal everyday angle, a little real-world clutter, background in natural focus with only the gentle depth of field of a phone camera.",
    "It must not look like an illustration, a 3D render, a stock photo or a film still: no studio lighting, no cinematic color grading, no glow or bloom, no oversaturation, no HDR halo, no text overlay and no watermark.",
].join(" ");

/** The style block to append, or "" when the user turned the natural look off. */
export function resolvePhotoStylePrompt(settings: { naturalPhotoLook?: boolean; photoStylePrompt?: string } | null | undefined): string {
    if (!settings || settings.naturalPhotoLook === false) return "";
    const custom = typeof settings.photoStylePrompt === "string" ? settings.photoStylePrompt.trim() : "";
    return custom || DEFAULT_NATURAL_PHOTO_STYLE;
}
