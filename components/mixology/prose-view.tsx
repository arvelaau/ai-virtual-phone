"use client";

// House Special -- prose rendering: turns the AI's raw text into paragraphs carrying the
// official semantic classes, per the prose protocol.
// A garnish only has to know these class names to style it:
//   .mix-prose the prose container / .mix-para an ordinary paragraph / .mix-scene a scene divider
//   .mix-dialogue speech / .mix-thought inner voice / .mix-accent emphasis / .mix-narration narration

import { useMemo } from "react";
import { parseMixProse, type MixProseParagraph } from "@/lib/mixology/prose";

function renderParagraph(paragraph: MixProseParagraph, key: number) {
    if (paragraph.type === "scene") {
        return (
            <p className="mix-scene" key={key}>
                <span aria-hidden="true">— </span>
                {paragraph.text}
                <span aria-hidden="true"> —</span>
            </p>
        );
    }
    return (
        <p className="mix-para" key={key}>
            {paragraph.segments.map((segment, i) => (
                <span className={`mix-${segment.type}`} key={i}>{segment.text}</span>
            ))}
        </p>
    );
}

export function MixProseView({ text }: { text: string }) {
    const paragraphs = useMemo(() => parseMixProse(text), [text]);
    return (
        <div className="mix-prose">
            {paragraphs.map((paragraph, i) => renderParagraph(paragraph, i))}
        </div>
    );
}
