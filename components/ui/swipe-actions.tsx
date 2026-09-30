"use client";

import { useRef, useState, type ReactNode } from "react";

// ── WeChat-style swipe-left actions ──
// A horizontal quick-swipe reveals action buttons; vertical scrolling, long-press dragging and
// similar gestures are unaffected. A list shares one controller, so only one row can be
// expanded at a time.

const DEFAULT_ACTIONS_WIDTH = 248; // four 62px buttons

interface SwipeGesture {
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    base: number;
    locked: boolean;
    offset: number;
    direction: "left" | "right" | null;
    left: boolean;
    right: boolean;
    onSwipeRight: (() => void) | null;
}

export function useSwipeActions(width = DEFAULT_ACTIONS_WIDTH) {
    const [swipingId, setSwipingId] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const gestureRef = useRef<SwipeGesture | null>(null);
    const suppressClickRef = useRef(false);

    const close = () => {
        setOpenId(null);
        setSwipingId(null);
    };

    const getContent = (wrapper: HTMLElement) =>
        wrapper.querySelector(":scope > .ui-swipe-content") as HTMLElement | null;

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string, opts?: { left?: boolean; right?: boolean; onSwipeRight?: () => void }) => {
        suppressClickRef.current = false;
        if (openId && openId !== id) close();
        const base = openId === id ? -width : 0;
        gestureRef.current = {
            id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, base,
            locked: false, offset: base, direction: null,
            left: opts?.left !== false,
            right: opts?.right === true,
            onSwipeRight: opts?.onSwipeRight ?? null,
        };
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current;
        if (!g || g.pointerId !== e.pointerId) return;
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (!g.locked) {
            // Abandon the gesture on vertical intent (scrolling/long-press reordering); only
            // lock once horizontal movement clears the threshold.
            if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
                gestureRef.current = null;
                return;
            }
            if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
            // Direction constraint: a left swipe needs this row to allow left, a right swipe needs it to allow right.
            if (dx < 0 && !g.left) return;
            if (dx > 0 && !g.right) return;
            g.locked = true;
            g.direction = dx < 0 ? "left" : "right";
            setSwipingId(g.id);
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        }
        if (e.cancelable) e.preventDefault();
        const content = getContent(e.currentTarget);
        if (!content) return;
        // A left swipe reveals the right-side actions; a right swipe shifts rightward (the
        // multi-select gesture).
        g.offset = g.direction === "right"
            ? Math.min(width, Math.max(0, g.base + dx))
            : Math.min(0, Math.max(-width, g.base + dx));
        content.style.transition = "none";
        content.style.transform = `translateX(${g.offset}px)`;
    };

    const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current;
        if (!g || g.pointerId !== e.pointerId) return;
        gestureRef.current = null;
        if (!g.locked) return;
        suppressClickRef.current = true;
        const content = getContent(e.currentTarget);
        // Right swipe past the threshold -> fire the onSwipeRight callback (multi-select), then spring back.
        if (g.direction === "right" && g.offset > width / 2) {
            const onRight = g.onSwipeRight;
            if (content) {
                content.style.transition = "transform 0.2s ease";
                content.style.transform = "translateX(0px)";
            }
            const id = g.id;
            setOpenId(null);
            window.setTimeout(() => setSwipingId(cur => (cur === id ? null : cur)), 220);
            onRight?.();
            return;
        }
        const open = g.offset < -width / 2;
        if (content) {
            content.style.transition = "transform 0.2s ease";
            content.style.transform = `translateX(${open ? -width : 0}px)`;
        }
        if (open) {
            setOpenId(g.id);
        } else {
            const id = g.id;
            setOpenId(null);
            // Wait for the spring-back animation to finish before unmounting the buttons, to avoid a flicker.
            window.setTimeout(() => setSwipingId(cur => (cur === id ? null : cur)), 220);
        }
    };

    // The browser may re-fire a click after the swipe ends; consumed by the row's own onClick.
    const consumeClickSuppression = () => {
        if (!suppressClickRef.current) return false;
        suppressClickRef.current = false;
        return true;
    };

    return {
        width,
        openId,
        swipingId,
        close,
        onPointerDown,
        onPointerMove,
        onPointerEnd,
        consumeClickSuppression,
        isRevealed: (id: string) => swipingId === id || openId === id,
        isOpen: (id: string) => openId === id,
    };
}

export type SwipeActionsController = ReturnType<typeof useSwipeActions>;

export function SwipeActionRow({ controller, id, disabled, actions, onTouchStart, onSwipeRight, rightSwipeEnabled = false, leftSwipeDisabled = false, children }: {
    controller: SwipeActionsController;
    id: string;
    disabled?: boolean;
    actions: ReactNode;
    onTouchStart?: (e: React.TouchEvent<HTMLDivElement>) => void;
    onSwipeRight?: () => void;
    rightSwipeEnabled?: boolean;
    leftSwipeDisabled?: boolean;
    children: ReactNode;
}) {
    return (
        <div
            className="ui-swipe-wrap"
            data-swipe-id={id}
            onTouchStart={onTouchStart}
            onPointerDown={disabled ? undefined : (e) => controller.onPointerDown(e, id, { left: !leftSwipeDisabled, right: rightSwipeEnabled, onSwipeRight })}
            onPointerMove={disabled ? undefined : controller.onPointerMove}
            onPointerUp={disabled ? undefined : controller.onPointerEnd}
            onPointerCancel={disabled ? undefined : controller.onPointerEnd}
        >
            {controller.isRevealed(id) && <div className="ui-swipe-actions">{actions}</div>}
            <div
                className="ui-swipe-content"
                style={{
                    transform: `translateX(${controller.isOpen(id) ? -controller.width : 0}px)`,
                    transition: "transform 0.2s ease",
                }}
            >
                {children}
            </div>
        </div>
    );
}
