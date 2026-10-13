// lib/music-link.ts
// Pure helpers for "the character knows what the Spotify / Apple Music link you sent is".
//
// What is available without logging in: title, artist, album, release year, a few track names
// for an album or playlist, and the cover art. NOT available: the audio, lyrics, how the song
// sounds. The context text built here says so, so the character does not invent them.
//
// Dependency-free so the server lookup, the webhook and tests can all share it.

export type MusicService = "spotify" | "apple_music";
export type MusicKind = "track" | "album" | "playlist" | "artist" | "episode" | "show";

export type MusicRef = {
    service: MusicService;
    kind: MusicKind;
    /** Spotify: the 22-char id. Apple Music: the numeric id, or "pl.xxxx" for a playlist. */
    id: string;
    /** Apple Music only: the song id when an album link points at one track (?i=). */
    trackId?: string;
    /** Apple Music storefront (us, jp, ...). */
    country: string;
    canonicalUrl: string;
};

const SPOTIFY_HOSTS = new Set(["open.spotify.com", "play.spotify.com"]);
const APPLE_HOSTS = new Set(["music.apple.com", "geo.music.apple.com", "embed.music.apple.com", "itunes.apple.com"]);

/** Finds candidate links inside free text; each one is validated by parseMusicUrl afterwards. */
const MUSIC_URL_RE = /https?:\/\/(?:open\.spotify\.com|play\.spotify\.com|(?:geo\.|embed\.)?music\.apple\.com|itunes\.apple\.com)\/[^\s<>"']+/gi;

const TRAILING_PUNCTUATION_RE = /[)\]}>.,;:!?。，！？]+$/;

const SPOTIFY_KINDS = new Set<MusicKind>(["track", "album", "playlist", "artist", "episode", "show"]);

function stripWww(host: string): string {
    return host.toLowerCase().replace(/^www\./, "");
}

function parseSpotify(url: URL): MusicRef | null {
    // /intl-fr/track/ID, /embed/track/ID, /user/someone/playlist/ID, /track/ID
    const segments = url.pathname.split("/").filter(Boolean);
    for (let i = 0; i < segments.length - 1; i += 1) {
        const kind = segments[i] as MusicKind;
        const id = segments[i + 1];
        if (SPOTIFY_KINDS.has(kind) && /^[A-Za-z0-9]{22}$/.test(id)) {
            return { service: "spotify", kind, id, country: "", canonicalUrl: `https://open.spotify.com/${kind}/${id}` };
        }
    }
    return null;
}

function parseApple(url: URL): MusicRef | null {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    let country = "us";
    let rest = segments;
    if (/^[a-z]{2}$/i.test(segments[0])) {
        country = segments[0].toLowerCase();
        rest = segments.slice(1);
    }
    const kindWord = (rest[0] || "").toLowerCase();
    const kind: MusicKind | null = kindWord === "album" ? "album"
        : kindWord === "song" ? "track"
        : kindWord === "playlist" ? "playlist"
        : kindWord === "artist" ? "artist"
        : null;
    if (!kind) return null;
    // the id is the last segment that looks like one: 1440857781, id1440857781, pl.abc123
    let id = "";
    for (let i = rest.length - 1; i >= 1; i -= 1) {
        const m = /^(?:id)?(\d{3,})$/i.exec(rest[i]) || /^(pl\.[A-Za-z0-9]+)$/i.exec(rest[i]);
        if (m) { id = m[1]; break; }
    }
    if (!id) return null;
    const trackParam = url.searchParams.get("i");
    const trackId = trackParam && /^\d{3,}$/.test(trackParam) ? trackParam : undefined;
    const refKind: MusicKind = kind === "album" && trackId ? "track" : kind;
    const canonicalUrl = `https://music.apple.com/${country}/${kind}/${rest.length > 2 ? rest[1] : "_"}/${id}${trackId ? `?i=${trackId}` : ""}`;
    return { service: "apple_music", kind: refKind, id, ...(trackId ? { trackId } : {}), country, canonicalUrl };
}

/** Parses a Spotify or Apple Music link; null when it is not one this module understands. */
export function parseMusicUrl(raw: string): MusicRef | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = stripWww(url.hostname);
    if (SPOTIFY_HOSTS.has(host)) return parseSpotify(url);
    if (APPLE_HOSTS.has(host)) return parseApple(url);
    return null;
}

export function extractMusicUrls(text: string, max = 3): string[] {
    if (!text) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    MUSIC_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MUSIC_URL_RE.exec(text)) !== null) {
        const cleaned = m[0].replace(TRAILING_PUNCTUATION_RE, "");
        const ref = parseMusicUrl(cleaned);
        if (!ref) continue;
        const key = `${ref.service}:${ref.kind}:${ref.trackId ?? ref.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
        if (out.length >= max) break;
    }
    return out;
}

/** Hosts a cover may be fetched from. Anything else is never contacted. */
export function isAllowedMusicImageHost(host: string): boolean {
    const h = host.toLowerCase();
    return h === "i.scdn.co"
        || h.endsWith(".scdn.co")
        || h.endsWith(".spotifycdn.com")
        || h === "mosaic.scdn.co"
        || h.endsWith(".mzstatic.com");
}

export type MusicInfo = {
    service: MusicService;
    kind: MusicKind;
    url: string;
    title: string;
    /** Artist(s) for a song / album, the owner for a playlist. */
    by?: string;
    album?: string;
    year?: string;
    /** A few track names for an album or playlist. */
    tracks?: string[];
    trackCount?: number;
    imageUrl?: string;
};

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function yearOf(value: unknown): string {
    const m = /^(\d{4})/.exec(str(value));
    return m ? m[1] : "";
}

/**
 * Reads the entity out of a Spotify embed page (`__NEXT_DATA__`). Best-effort: the page is not
 * a documented interface, so anything missing simply stays out of the result.
 */
export function parseSpotifyEmbedHtml(html: string): Partial<MusicInfo> | null {
    const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html || "");
    if (!m) return null;
    let data: unknown;
    try {
        data = JSON.parse(m[1]);
    } catch {
        return null;
    }
    const entity = (data as { props?: { pageProps?: { state?: { data?: { entity?: Record<string, unknown> } } } } })
        ?.props?.pageProps?.state?.data?.entity;
    if (!entity || typeof entity !== "object") return null;

    const out: Partial<MusicInfo> = {};
    const title = str(entity.title) || str(entity.name);
    if (title) out.title = title;
    const artists = Array.isArray(entity.artists)
        ? (entity.artists as Array<{ name?: unknown }>).map((a) => str(a?.name)).filter(Boolean)
        : [];
    if (artists.length) out.by = artists.join(", ");
    else if (str(entity.subtitle)) out.by = str(entity.subtitle);
    const release = (entity.releaseDate as { isoString?: unknown } | null)?.isoString;
    if (yearOf(release)) out.year = yearOf(release);
    if (Array.isArray(entity.trackList)) {
        const list = (entity.trackList as Array<{ title?: unknown }>).map((t) => str(t?.title)).filter(Boolean);
        if (list.length) {
            out.tracks = list.slice(0, 5);
            out.trackCount = list.length;
        }
    }
    return out;
}

function clip(value: string, max: number): string {
    const t = value.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const SERVICE_NAME: Record<MusicService, string> = { spotify: "Spotify", apple_music: "Apple Music" };
const KIND_NAME: Record<MusicKind, string> = {
    track: "song", album: "album", playlist: "playlist", artist: "artist", episode: "podcast episode", show: "podcast",
};

/**
 * The block that goes next to the link in the prompt: what is known, and just as importantly
 * what is not. `ref` names the service when the lookup failed.
 */
export function formatMusicContext(info: MusicInfo | null, failure?: string, ref?: Pick<MusicRef, "service" | "kind"> | null): string {
    if (!info) {
        const service = ref ? SERVICE_NAME[ref.service] : "music";
        return `(Music link context, for you only, never quote it: the user shared a ${service} link but it could not be read${failure ? ` (${clip(failure, 120)})` : ""}. It may be private, removed, or not available in a region. Say so honestly if it comes up, and do not guess what it is.)`;
    }
    const head = `${SERVICE_NAME[info.service]} ${KIND_NAME[info.kind]} "${clip(info.title, 160)}"`;
    const bits: string[] = [head];
    if (info.by) bits.push(info.kind === "playlist" ? `by ${clip(info.by, 80)}` : `by ${clip(info.by, 120)}`);
    const detail: string[] = [];
    if (info.album && info.album !== info.title) detail.push(`from the album "${clip(info.album, 120)}"`);
    if (info.year) detail.push(info.year);
    if (typeof info.trackCount === "number" && info.kind !== "track") detail.push(`${info.trackCount} tracks`);
    let line = bits.join(" ");
    if (detail.length) line += ` (${detail.join(", ")})`;
    if (info.tracks?.length) line += `. It includes: ${info.tracks.map((t) => `"${clip(t, 80)}"`).join(", ")}`;
    return `(Music link context, for you only, never quote it: the user shared a link to the ${line}. You know it only from its title and details: you cannot hear it and have not listened to it just now, so if you recognise it react the way you naturally would, and do not invent how it sounds or its lyrics. React the way you would to a friend sending you a song.)`;
}
