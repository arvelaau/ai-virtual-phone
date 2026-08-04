"use client";

import { useEffect } from "react";

/**
 * Android fullscreen fallback: tap the screen to enter fullscreen mode (iOS doesn't
 * support this API and will silently ignore it).
 *
 * world-builder opens in a separate window via window.open and isn't inside main-app's
 * React tree, so it can't pick up main-app's "tap to enter fullscreen" listener, which
 * means the browser address bar stays visible. This component replicates the same logic
 * for the world-builder window — just mount it.
 */
export function AndroidFullscreen() {
  useEffect(() => {
    const isMobile = window.matchMedia(
      "(max-width: 500px) and (hover: none) and (pointer: coarse)"
    ).matches;
    if (!isMobile) return;

    function tryFullscreen() {
      const doc = document.documentElement;
      if (document.fullscreenElement) return;
      doc.requestFullscreen?.().catch(() => { });
    }
    // Try to enter fullscreen on every click (can re-enter after exiting)
    document.addEventListener("click", tryFullscreen);
    return () => {
      document.removeEventListener("click", tryFullscreen);
    };
  }, []);

  return null;
}
