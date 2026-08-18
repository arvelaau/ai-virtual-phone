// House Special — adaptive height for sandboxed canvases: detecting the "grows every time
// you measure it" feedback loop.
//
// The canvases (opening canvas / receipt / encore) all run inside a scrolling="no" sandboxed
// iframe: the canvas measures itself, reports a height, and the host sizes the frame to it.
// The moment an author uses a viewport unit inside the canvas (100vh, 100dvh,
// min-height:100vh and friends), the content height starts depending on the IFRAME's height
// instead — the host makes the frame taller, so the canvas gets taller, so each measurement
// grows by the same amount, all the way to the ceiling. Once it pins there the height stops
// changing, and what the user sees is either "it scrolls to a point and then refuses to go
// further" (when the ceiling is shorter than the content) or a slab of blank space hanging
// off the end (when the ceiling is taller).
//
// The signature of the loop: the reported height is always "the current iframe height plus
// the same constant". Genuine growth — an image finishing loading, a font swapping in, a
// collapsed block being opened — does not land on exactly that formula several rounds running.
//
// Worth knowing: this is the same defect as the iframe height ratchet fixed in
// story-html-renderer.tsx and message-bubble.tsx, but the approach is different. Those
// changed WHAT is measured (body only, never documentElement); this one detects the
// ratchet's signature and freezes. That makes it able to handle the case those two
// deliberately left open — a canvas whose own CSS is written in viewport units, where no
// change to the measurement can break the cycle.

/** This many rounds of "taller than the current height by the same constant" declares a loop */
const LOOP_HITS = 4;
/** Two deltas within this many pixels count as "the same constant" (sub-pixel layout jitters
 *  by fractions) */
const DELTA_EPS = 1;

export type MixFrameHeightTracker = {
    /** The height currently applied to the iframe */
    applied: number;
    /** The previous round's delta */
    delta: number;
    /** How many rounds running have shown that same delta */
    hits: number;
};

export function createMixFrameHeightTracker(initial: number): MixFrameHeightTracker {
    return { applied: initial, delta: 0, hits: 0 };
}

/**
 * Take the height the canvas reported and work out what to apply.
 * Returns null when this round is judged to be the loop, meaning hold the current height.
 *
 * Freezing is safe. When the check trips, the current height was inflated by the loop, so it
 * is only ever TALLER than the first genuine content measurement — nothing gets clipped. And
 * it freezes for that round only: as soon as a report stops matching "height + the same
 * constant", normal tracking resumes, so real growth such as an image finishing loading is
 * never stuck.
 */
export function nextMixFrameHeight(
    tracker: MixFrameHeightTracker,
    reported: number,
    range: { min: number; max: number },
): number | null {
    if (!Number.isFinite(reported)) return null;

    const delta = reported - tracker.applied;
    if (delta > 0 && tracker.hits > 0 && Math.abs(delta - tracker.delta) <= DELTA_EPS) {
        tracker.hits += 1;
    } else {
        tracker.delta = delta;
        tracker.hits = delta > 0 ? 1 : 0;
    }
    if (tracker.hits >= LOOP_HITS) return null;

    const applied = Math.min(Math.max(reported, range.min), range.max);
    tracker.applied = applied;
    return applied;
}
