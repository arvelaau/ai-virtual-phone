"use client";

// The "auto-reply on keyboard dismiss" setting row in the chat settings panel, fully
// self-contained: reads and writes keyboard-auto-send-config on its own and needs no props
// from the panel besides sessionId.
// Mounting: drop it into any menu-group in chat-settings-panel.tsx --
//   <KeyboardAutoSendDebounceItem sessionId={session.id} />
//
// Visually matches the rest of the panel's rows: a colored icon on the left + title/description
// + a Toggle on the right; turning it on reveals a wait-duration input below. With the toggle
// off, behavior is identical to the original.

import { useState, type CSSProperties } from "react";
import { KeyboardOff } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import {
    getKeyboardAutoSendDebounceMs,
    isKeyboardAutoSendEnabled,
    setSessionKeyboardAutoSendEnabled,
    setSessionKeyboardAutoSendDebounce,
    MAX_AUTO_SEND_DEBOUNCE_MS,
} from "@/lib/keyboard-auto-send-config";

export function KeyboardAutoSendDebounceItem({ sessionId }: { sessionId: string }) {
    const [enabled, setEnabled] = useState(() => isKeyboardAutoSendEnabled(sessionId));
    const [seconds, setSeconds] = useState(() => getKeyboardAutoSendDebounceMs(sessionId) / 1000);

    const commit = (value: number) => {
        const clamped = Math.max(0, Math.min(MAX_AUTO_SEND_DEBOUNCE_MS / 1000, value));
        if (!Number.isFinite(clamped)) return;
        setSeconds(clamped);
        setSessionKeyboardAutoSendDebounce(sessionId, Math.round(clamped * 1000));
    };

    return (
        <>
            <div className="menu-item">
                {/* Same icon shell as the panel's other rows (chat-info-icon reads --icon-color) */}
                <span className="chat-info-icon" style={{ "--icon-color": "var(--c-icon-teal, #2a9d8f)" } as CSSProperties}>
                    <KeyboardOff size={22} strokeWidth={1.75} />
                </span>
                <div className="menu-label-group">
                    <span className="menu-label">Auto-Reply on Keyboard Dismiss</span>
                    <span className="menu-desc">Dismiss the keyboard after typing and they'll start replying -- no need to tap "Trigger Reply" (only affects this chat)</span>
                </div>
                <div className="menu-right">
                    <Toggle
                        checked={enabled}
                        onChange={next => {
                            setEnabled(next);
                            setSessionKeyboardAutoSendEnabled(sessionId, next);
                        }}
                    />
                </div>
            </div>
            {/* Kept permanently in the DOM, hidden with display only: the chat info page has a
                script elsewhere in this group that inserts rows dynamically (hide reasoning),
                and a conditional mount would make React re-insert this row anchored at "custom
                CSS", landing it below that other, later row. */}
            <label className="menu-item" style={enabled ? undefined : { display: "none" }}>
                <div className="menu-label-group" style={{ paddingLeft: 48 }}>
                    <span className="menu-label">Wait This Long Before Replying</span>
                    <span className="menu-desc">Tapping back into the input within this window means you're not done -- it holds off replying</span>
                </div>
                <div className="menu-right">
                    <input
                        type="number"
                        inputMode="decimal"
                        autoComplete="off"
                        min={0}
                        max={MAX_AUTO_SEND_DEBOUNCE_MS / 1000}
                        step={0.5}
                        value={seconds}
                        onChange={e => commit(Number(e.target.value))}
                        className="ui-input h-8 w-16 text-center"
                    />
                </div>
            </label>
        </>
    );
}
