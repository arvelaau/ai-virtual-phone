"use client";

import { useMemo } from "react";
import { extractCssImports, scopeSessionCSS } from "@/lib/css-scoper";

/**
 * Session custom-CSS injector.
 *
 * Splits any `@import` in the user's CSS (usually Google Fonts) out into its own
 * `<link rel="stylesheet">`, and scopes the remaining rules into an inline `<style>`. Leaving
 * `@import` inside `<style>` lets iOS WebKit suspend the whole stylesheet while it loads/retries
 * -- on a flaky connection the page flickers between styled and unstyled (most visible scrolling
 * a story view to the top/bottom).
 *
 * The `<link>`'s `precedence` attribute lets React 19 hoist it into `<head>` and dedupe by href,
 * staying stable across re-renders; a failed font load only costs the font, not the rest of the
 * custom styling.
 */
export function SessionCustomCSS({ css, scope }: { css: string; scope: string }) {
    const { imports, body } = useMemo(() => {
        const extracted = extractCssImports(css || "");
        return { imports: extracted.imports, body: extracted.css };
    }, [css]);
    const scoped = useMemo(() => scopeSessionCSS(body, scope), [body, scope]);

    return (
        <>
            {imports.map((href) => (
                <link key={href} rel="stylesheet" href={href} precedence="default" />
            ))}
            {scoped ? <style dangerouslySetInnerHTML={{ __html: scoped }} /> : null}
        </>
    );
}
