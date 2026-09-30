"use client";

// Sticker search suggestions: fuzzy-matches local stickers by name as the user types, shown as
// a horizontal list floating right above the input box; tapping one sends it directly (reusing
// onSendSticker's own sticker-message channel), and the parent clears the input after sending.
// Data source = built-in stickers (sticker-data, with an emoji fallback) + the current session's
// bound characters' own custom sticker packs (resolved to a URL from IndexedDB).

import { useEffect, useMemo, useRef, useState } from "react";
import { STICKER_PACKS } from "@/lib/sticker-data";
import { loadStickerPacksForCharacters, resolvePackStickerMap } from "@/lib/custom-sticker-storage";

export type StickerSearchItem = {
  key: string;
  name: string;
  /** The image URL resolved for a custom sticker (dataUrl / externalUrl). */
  url?: string;
  /** The emoji fallback for a built-in sticker. */
  emoji?: string;
};

type StickerSearchSuggestProps = {
  /** The input box's current raw text. */
  query: string;
  /** The character id(s) this session is tied to (1:1 = [contactId], group = participantIds). */
  characterIds: string[];
  /** Send: matches ChatTextInputBar's own onSendSticker (name, url?). */
  onSend: (name: string, url?: string) => void;
  /** Closes the suggestion list (sending / Escape / blur are handled by the parent; this only
   *  collapses it after a send). */
  onClose: () => void;
};

const DEBOUNCE_MS = 300;
const MAX_RESULTS = 12;

export function StickerSearchSuggest({ query, characterIds, onSend, onClose }: StickerSearchSuggestProps) {
  // ── Debounce: match 300ms after typing stops. ──
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // ── Load custom stickers (packs bound to this session's characters), resolving name -> url. ──
  const [customItems, setCustomItems] = useState<StickerSearchItem[]>([]);
  const loadSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++loadSeqRef.current;
    let cancelled = false;
    (async () => {
      const packs = loadStickerPacksForCharacters(characterIds).filter((pack) => pack.stickers.length > 0);
      const urlByName: Record<string, string> = {};
      for (const pack of packs) {
        const map = await resolvePackStickerMap(pack);
        for (const [name, url] of Object.entries(map)) {
          if (url) urlByName[name] = url;
        }
      }
      if (cancelled) return;
      const items: StickerSearchItem[] = [];
      for (const pack of packs) {
        for (const sticker of pack.stickers) {
          items.push({ key: `custom:${pack.id}:${sticker.name}`, name: sticker.name, url: urlByName[sticker.name] });
        }
      }
      setCustomItems(items);
    })();
    return () => {
      cancelled = true;
      // Only clean up the most recent load, so a stale result from a race can't overwrite a fresh one.
      if (loadSeqRef.current === seq) setCustomItems([]);
    };
  }, [characterIds]);

  // ── Built-in sticker packs (emoji fallback). ──
  const builtinItems = useMemo<StickerSearchItem[]>(
    () =>
      STICKER_PACKS.flatMap((pack) =>
        pack.stickers.map((sticker) => ({ key: `builtin:${sticker.name}`, name: sticker.name, emoji: sticker.emoji })),
      ),
    [],
  );

  // ── Fuzzy match + ranking (prefix first, then substring; dedupe by name, custom wins). ──
  const results = useMemo(() => {
    const q = debouncedQuery.toLowerCase();
    if (!q) return [];
    const rank = (name: string): number => {
      const n = name.toLowerCase();
      if (n === q) return 0;
      if (n.startsWith(q)) return 1;
      if (n.includes(q)) return 2;
      return -1;
    };
    const scored = [...customItems, ...builtinItems]
      .map((item) => ({ item, rank: rank(item.name) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.item.name.length - b.item.name.length);
    const seen = new Set<string>();
    const out: StickerSearchItem[] = [];
    for (const { item } of scored) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      out.push(item);
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }, [debouncedQuery, builtinItems, customItems]);

  if (!debouncedQuery || results.length === 0) return null;

  return (
    <div
      className="sticker-search-suggest"
      style={{ position: "absolute", left: 0, right: 0, bottom: "100%", zIndex: 60, marginBottom: 6 }}
      // Prevent the default mousedown behavior: tapping a list item shouldn't blur the textarea
      // first, or the list could get closed by that blur before the click ever lands.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        className="flex items-stretch gap-2 overflow-x-auto px-3 py-2.5 rounded-2xl hide-scrollbar"
        style={{
          background: "color-mix(in srgb, var(--c-card) 96%, transparent)",
          border: "1px solid var(--c-card-border)",
          boxShadow: "0 8px 28px rgba(0,0,0,0.12)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          maxWidth: "100%",
        }}
      >
        {results.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              onSend(item.name, item.url);
              onClose();
            }}
            className="shrink-0 flex flex-col items-center gap-1 px-2.5 py-2 rounded-xl bg-transparent border-none cursor-pointer transition-transform active:scale-95"
            style={{ minWidth: 64 }}
            title={item.name}
          >
            <span className="w-14 h-14 flex items-center justify-center overflow-hidden">
              {item.url ? (
                <img src={item.url} alt={item.name} className="w-14 h-14 object-contain" draggable={false} />
              ) : item.emoji ? (
                <span className="text-[32px] leading-none">{item.emoji}</span>
              ) : (
                <span className="ts-11 text-[var(--c-text)] w-full text-center truncate">{item.name}</span>
              )}
            </span>
            <span className="ts-11 text-[var(--c-text)] opacity-75 max-w-[64px] truncate leading-tight">{item.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
