"use client";

// "Dismissing the keyboard auto-triggers a reply", with a debounce window.
//
// Behavior: once the user dismisses the keyboard (or closes the emoji/plus panel), start
// waiting N seconds. Bringing the keyboard back up, tapping back into the input, or opening
// the emoji panel within those N seconds cancels this trigger. Once N quiet seconds pass,
// it presses "trigger reply" on the user's behalf.
//
// Implementation is just a timer: dismiss -> setTimeout(fire, N), any user action -> clearTimeout.
// All the business checks (was a message actually sent and not yet replied to, is a
// generation already running, etc.) happen at the moment fire runs, so the dismiss signal
// itself can afford to be "better a false positive than a miss" -- a false positive gets
// caught by fire's own checkup and never actually sends anything extra.
//
// The browser has no keyboard event, so dismissal has to be inferred, via three
// complementary paths:
// 1. Input blur: on a touch device (or once the keyboard has been confirmed open), treat
//    this directly as a dismiss signal. iOS has several ways to dismiss the keyboard that
//    never fire a visualViewport resize (see use-call-keyboard-offset); a pure event-driven
//    approach would miss those, and blur is the most reliable companion signal across them.
// 2. Viewport height: actively poll (rather than betting everything on the resize event)
//    while focused/the keyboard is up; the height recovering means it was dismissed. This
//    covers the "keyboard dismiss button" path, which hides the keyboard without a blur.
// 3. When the keyboard is dismissed via path 2 but focus is still on the input, fire no
//    longer vetoes on "focus is on the input" alone -- it instead checks the keyboard's
//    actual inset: zero inset means the keyboard really is gone.
//
// Non-invasive by design: every decision lives in this one file; the chat room only needs
// one call. With the config toggle off, behavior is identical to the original.

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { loadChatMessages } from "@/lib/chat-storage";
import { getKeyboardAutoSendDebounceMs, isKeyboardAutoSendEnabled } from "@/lib/keyboard-auto-send-config";

const KEYBOARD_INSET_THRESHOLD = 80;
const KEYBOARD_HEIGHT_CHANGE_THRESHOLD = 48;
// A width jump (rotation/split-screen) drags a big height change along with it -- must not
// be mistaken for the keyboard opening or closing.
const LAYOUT_WIDTH_CHANGE_THRESHOLD = 80;
const VIEWPORT_POLL_MS = 200;
const INPUT_SELECTOR = ".chat-input-textarea";

interface KeyboardDismissAutoSendOptions {
    /** Whether the current scene allows auto-trigger at all (pass false in offline mode / multi-select mode). */
    active: boolean;
    /** Something was actually sent and hasn't been replied to yet. */
    pending: boolean;
    /** A generation is currently running. */
    generating: boolean;
    /** The emoji/sticker/plus panel is open. */
    panelOpen: boolean;
    /** Used to check "was the last message really from the user" + to look up the per-session debounce duration. */
    sessionId: string;
    onTrigger: () => void;
}

const currentKeyboardInset = () => {
    const viewport = window.visualViewport;
    return Math.max(0, viewport ? window.innerHeight - viewport.height - viewport.offsetTop : 0);
};

export function useKeyboardDismissAutoSend(
    rootRef: RefObject<HTMLElement | null>,
    options: KeyboardDismissAutoSendOptions,
): void {
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const waitTimerRef = useRef(0);
    // Whether this debounce window came from a "keyboard hidden but focus never left the input"
    // dismissal (e.g. the iPad dismiss-keyboard chevron).
    const collapseKeptFocusRef = useRef(false);

    /** Cancels the current debounce window, if any. */
    const cancelWait = useCallback(() => {
        if (waitTimerRef.current) {
            window.clearTimeout(waitTimerRef.current);
            waitTimerRef.current = 0;
        }
    }, []);

    /**
     * The last non-system message must be from the user, or dismissing the keyboard with
     * nothing sent would fire by mistake. Exception: a system-instruction message is stored
     * with role "system", but it's really an action the user just took and is waiting on.
     */
    const hasUnrepliedUserMessage = useCallback((sessionId: string) => {
        const msgs = loadChatMessages(sessionId);
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
            const msg = msgs[i];
            if (msg.role === "system") {
                if (msg.mediaType === "system_instruction") return true;
                continue;
            }
            return msg.role === "user";
        }
        return false;
    }, []);

    /** End of the debounce window: do a full checkup right before firing; any failed check cancels it. */
    const fire = useCallback(() => {
        waitTimerRef.current = 0;
        const keptFocus = collapseKeptFocusRef.current;
        collapseKeptFocusRef.current = false;
        const cur = optionsRef.current;
        if (!cur.active || !cur.pending || cur.generating || cur.panelOpen) return;
        if (!isKeyboardAutoSendEnabled(cur.sessionId)) return;
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.matches(INPUT_SELECTOR)) {
            // Focus is still on the input: usually means the user has more to say.
            // The one case that's let through is a dismissal path that measurably closed the
            // keyboard while leaving focus where it was (the dismiss-keyboard button doesn't blur).
            if (!keptFocus) return;
            if (currentKeyboardInset() >= KEYBOARD_INSET_THRESHOLD) return;
        }
        // There's already a draft sitting in the input = the user isn't done typing.
        const draft = rootRef.current?.querySelector<HTMLTextAreaElement>(INPUT_SELECTOR);
        if (draft?.value.trim()) return;
        if (!hasUnrepliedUserMessage(cur.sessionId)) return;
        cur.onTrigger();
    }, [rootRef, hasUnrepliedUserMessage]);

    /** Keyboard dismissed / panel closed -> open an N-second debounce window (a repeat call resets the timer). */
    const scheduleWait = useCallback((keptFocus = false) => {
        if (!isKeyboardAutoSendEnabled(optionsRef.current.sessionId)) return;
        cancelWait();
        collapseKeptFocusRef.current = keptFocus;
        const n = getKeyboardAutoSendDebounceMs(optionsRef.current.sessionId);
        waitTimerRef.current = window.setTimeout(fire, Math.max(0, n));
    }, [cancelWait, fire]);

    // A panel going from open -> closed counts the same as dismissing the keyboard; a panel
    // opening cancels any pending wait.
    const prevPanelOpenRef = useRef(false);
    useEffect(() => {
        const wasOpen = prevPanelOpenRef.current;
        prevPanelOpenRef.current = options.panelOpen;
        if (options.panelOpen) { cancelWait(); return; }
        if (wasOpen) scheduleWait();
    }, [options.panelOpen, cancelWait, scheduleWait]);

    // The input regaining focus / receiving input -> the user has more to say, cancel the wait.
    // Uses a capture-phase document listener: the input lives in a child component, so state
    // can't be threaded into this hook directly.
    useEffect(() => {
        const isOurInput = (target: EventTarget | null) =>
            target instanceof HTMLElement
            && target.matches(INPUT_SELECTOR)
            && Boolean(rootRef.current?.contains(target));
        const onFocusIn = (event: FocusEvent) => { if (isOurInput(event.target)) cancelWait(); };
        const onInput = (event: Event) => { if (isOurInput(event.target)) cancelWait(); };
        document.addEventListener("focusin", onFocusIn, true);
        document.addEventListener("input", onInput, true);
        return () => {
            document.removeEventListener("focusin", onFocusIn, true);
            document.removeEventListener("input", onInput, true);
        };
    }, [rootRef, cancelWait]);

    // Clear the timer on unmount.
    useEffect(() => () => cancelWait(), [cancelWait]);

    // Keyboard open/close detection: visualViewport size + input-focus inference.
    // Events (resize/scroll/focus) are treated only as a "wake up" signal; active polling
    // backstops the actual determination, so it doesn't depend on any single resize event
    // arriving as expected.
    useEffect(() => {
        const viewport = window.visualViewport;
        const touchLike = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

        let keyboardWasOpen = false;
        let inputWasFocused = false;
        let stableViewportHeight = viewport?.height ?? window.innerHeight;
        let stableWindowHeight = window.innerHeight;
        let lastInnerWidth = window.innerWidth;
        let frame = 0;
        let pollTimer = 0;

        const chatInputFocused = () => {
            const focused = document.activeElement;
            return focused instanceof HTMLElement
                && focused.matches(INPUT_SELECTOR)
                && Boolean(rootRef.current?.contains(focused));
        };

        const syncPolling = () => {
            const shouldPoll = inputWasFocused || keyboardWasOpen;
            if (shouldPoll && !pollTimer) {
                pollTimer = window.setInterval(() => measure(), VIEWPORT_POLL_MS);
            } else if (!shouldPoll && pollTimer) {
                window.clearInterval(pollTimer);
                pollTimer = 0;
            }
        };

        const measure = () => {
            frame = 0;
            const viewportHeight = viewport?.height ?? window.innerHeight;
            // A width jump = rotation/split-screen/window resize -- this tick only re-samples
            // the baseline, it doesn't decide open/closed.
            if (Math.abs(window.innerWidth - lastInnerWidth) >= LAYOUT_WIDTH_CHANGE_THRESHOLD) {
                lastInnerWidth = window.innerWidth;
                stableViewportHeight = viewportHeight;
                stableWindowHeight = window.innerHeight;
                return;
            }
            // The viewport can only grow taller from the keyboard dismissing or the browser
            // chrome collapsing -- raise the baseline along with it, which self-heals the case
            // where the baseline was sampled short because the keyboard was already open when
            // the chat room was entered.
            if (viewportHeight > stableViewportHeight) stableViewportHeight = viewportHeight;
            if (window.innerHeight > stableWindowHeight) stableWindowHeight = window.innerHeight;

            const keyboardOpen = inputWasFocused && (
                currentKeyboardInset() >= KEYBOARD_INSET_THRESHOLD
                || stableViewportHeight - viewportHeight >= KEYBOARD_HEIGHT_CHANGE_THRESHOLD
                || stableWindowHeight - window.innerHeight >= KEYBOARD_HEIGHT_CHANGE_THRESHOLD
            );
            if (keyboardOpen) {
                // iOS's focusout can fire before the last visualViewport resize, so focus is
                // tracked separately, or the close event could get lost.
                if (inputWasFocused || chatInputFocused()) keyboardWasOpen = true;
                cancelWait(); // The keyboard opening (again) invalidates the previous debounce window.
                syncPolling();
                return;
            }
            if (!keyboardWasOpen) { syncPolling(); return; } // Never opened -> doesn't count as "dismissed".
            keyboardWasOpen = false;
            inputWasFocused = false;
            stableViewportHeight = viewportHeight; // Re-sample the baseline, or the next check would use a stale value.
            stableWindowHeight = window.innerHeight;
            syncPolling();
            // If focus is still on the input (the dismiss-keyboard-button path), note it so fire lets it through based on the measured inset.
            scheduleWait(chatInputFocused());
        };

        const requestMeasure = () => {
            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
        };

        const handleFocusIn = (event: FocusEvent) => {
            const target = event.target;
            if (target instanceof HTMLElement
                && target.matches(INPUT_SELECTOR)
                && Boolean(rootRef.current?.contains(target))) {
                inputWasFocused = true;
                stableViewportHeight = Math.max(stableViewportHeight, viewport?.height ?? window.innerHeight);
                stableWindowHeight = Math.max(stableWindowHeight, window.innerHeight);
                syncPolling();
            } else if (!keyboardWasOpen) {
                inputWasFocused = false;
                stableViewportHeight = viewport?.height ?? window.innerHeight;
                stableWindowHeight = window.innerHeight;
                syncPolling();
            }
            requestMeasure();
        };
        const handleFocusOut = (event: FocusEvent) => {
            const target = event.target;
            const related = event.relatedTarget;
            const fromOurInput = target instanceof HTMLElement
                && target.matches(INPUT_SELECTOR)
                && Boolean(rootRef.current?.contains(target));
            const toInput = related instanceof HTMLElement && related.matches(INPUT_SELECTOR);
            // Blur itself counts as a dismiss signal: on touch, the keyboard follows focus, so
            // it can't still be up after a blur. Some iOS dismissal paths never fire a resize,
            // so waiting for the viewport event would miss them -- open the debounce window
            // right here instead. A wrong call (keyboard wasn't actually dismissed) still gets
            // caught by fire's own checkup, e.g. "focus is back on the input".
            if (fromOurInput && !toInput && (keyboardWasOpen || touchLike)) {
                keyboardWasOpen = false;
                inputWasFocused = false;
                stableViewportHeight = viewport?.height ?? window.innerHeight;
                stableWindowHeight = window.innerHeight;
                syncPolling();
                scheduleWait();
                return;
            }
            requestMeasure();
        };

        viewport?.addEventListener("resize", requestMeasure);
        viewport?.addEventListener("scroll", requestMeasure);
        window.addEventListener("resize", requestMeasure);
        document.addEventListener("focusin", handleFocusIn);
        document.addEventListener("focusout", handleFocusOut);
        requestMeasure();

        return () => {
            if (frame) cancelAnimationFrame(frame);
            if (pollTimer) window.clearInterval(pollTimer);
            viewport?.removeEventListener("resize", requestMeasure);
            viewport?.removeEventListener("scroll", requestMeasure);
            window.removeEventListener("resize", requestMeasure);
            document.removeEventListener("focusin", handleFocusIn);
            document.removeEventListener("focusout", handleFocusOut);
        };
    }, [rootRef, cancelWait, scheduleWait]);
}
