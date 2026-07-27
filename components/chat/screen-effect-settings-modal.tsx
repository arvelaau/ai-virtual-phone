"use client";

// Fullscreen effects manager: full-width bottom sheet with two tabs — "Emoji Rain" for custom trigger-word rules;
// "Fullscreen Effects" for built-in effects (fireworks/hearts/confetti/bomb/dice). Global config, shared across all sessions.

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import {
    BUILTIN_SCREEN_EFFECTS,
    createChatScreenEffectRule,
    loadBuiltinScreenEffectSettings,
    loadChatScreenEffectRules,
    resetChatScreenEffectRules,
    saveBuiltinScreenEffectSettings,
    saveChatScreenEffectRules,
    type BuiltinScreenEffectSetting,
    type BuiltinScreenEffectType,
    type ChatScreenEffectRule,
} from "@/lib/chat-screen-effects";
import { ChatScreenEffectOverlay, type ActiveScreenEffect } from "./chat-screen-effect";

export function ScreenEffectSettingsModal({ onClose }: { onClose: () => void }) {
    const [tab, setTab] = useState<"rain" | "builtin">("rain");
    const [rules, setRules] = useState<ChatScreenEffectRule[]>(() => loadChatScreenEffectRules());
    const [builtins, setBuiltins] = useState<Record<BuiltinScreenEffectType, BuiltinScreenEffectSetting>>(
        () => loadBuiltinScreenEffectSettings(),
    );
    const [preview, setPreview] = useState<ActiveScreenEffect | null>(null);

    const updateRules = (next: ChatScreenEffectRule[]) => {
        setRules(next);
        saveChatScreenEffectRules(next);
    };
    const patchRule = (id: string, patch: Partial<ChatScreenEffectRule>) => {
        updateRules(rules.map(rule => (rule.id === id ? { ...rule, ...patch } : rule)));
    };
    const patchBuiltin = (type: BuiltinScreenEffectType, patch: Partial<BuiltinScreenEffectSetting>) => {
        const next = { ...builtins, [type]: { ...builtins[type], ...patch } };
        setBuiltins(next);
        saveBuiltinScreenEffectSettings(next);
    };
    const playPreview = (effect: ActiveScreenEffect["effect"], emojis: string) => {
        setPreview({ runId: `preview_${Date.now()}`, effect, emojis });
    };

    return (
        <div className="modal-overlay modal-overlay-bottom" onClick={onClose}>
            <div className="modal-sheet screen-fx-sheet" onClick={e => e.stopPropagation()}>
                <span className="screen-fx-grabber" aria-hidden="true" />
                <div className="screen-fx-titles">
                    <h2 className="screen-fx-title">Fullscreen Effects</h2>
                    <p className="screen-fx-subtitle">Plays automatically when a message contains a trigger word, shared across all chats</p>
                </div>

                <div className="screen-fx-tabs" role="tablist">
                    <button role="tab" aria-selected={tab === "rain"} {...(tab === "rain" ? { "data-active": "" } : {})} onClick={() => setTab("rain")}>
                        Emoji Rain
                    </button>
                    <button role="tab" aria-selected={tab === "builtin"} {...(tab === "builtin" ? { "data-active": "" } : {})} onClick={() => setTab("builtin")}>
                        Fullscreen Effects
                    </button>
                </div>

                <div className="screen-fx-list">
                    {tab === "rain" ? (
                        <>
                            <p className="screen-fx-note">Separate multiple trigger words with commas; the first match from top to bottom wins</p>
                            {rules.length === 0 && <p className="screen-fx-note">No rules yet, tap the button below to add one</p>}
                            {rules.map(rule => (
                                <div key={rule.id} className="screen-fx-card" {...(rule.enabled ? { "data-enabled": "" } : {})}>
                                    <label className="screen-fx-field">
                                        <span>Trigger Word</span>
                                        <input
                                            type="text"
                                            value={rule.keyword}
                                            onChange={e => patchRule(rule.id, { keyword: e.target.value.slice(0, 60) })}
                                            placeholder="e.g. Happy Birthday"
                                        />
                                    </label>
                                    <label className="screen-fx-field">
                                        <span>Falling Emoji</span>
                                        <input
                                            type="text"
                                            value={rule.emojis}
                                            onChange={e => patchRule(rule.id, { emojis: e.target.value.slice(0, 16) })}
                                            placeholder="e.g. 🎂🎉"
                                        />
                                    </label>
                                    <div className="screen-fx-card-actions">
                                        <button className="screen-fx-pill-btn" onClick={() => playPreview("emoji_rain", rule.emojis)}>
                                            Preview
                                        </button>
                                        <button className="screen-fx-icon-btn" aria-label="Delete rule" onClick={() => updateRules(rules.filter(r => r.id !== rule.id))}>
                                            <Trash2 size={17} />
                                        </button>
                                        <Toggle checked={rule.enabled} onChange={c => patchRule(rule.id, { enabled: c })} />
                                    </div>
                                </div>
                            ))}
                            <button className="screen-fx-add-btn" onClick={() => updateRules([...rules, createChatScreenEffectRule()])}>
                                <Plus size={17} /> Add Rule
                            </button>
                        </>
                    ) : (
                        <>
                            <p className="screen-fx-note">Tap in the "Effects" tab of the emoji panel to send, or send a message containing only the icon to trigger it; icons mixed in with text won't trigger it</p>
                            {BUILTIN_SCREEN_EFFECTS.map(effect => (
                                <div key={effect.type} className="screen-fx-card" {...(builtins[effect.type].enabled ? { "data-enabled": "" } : {})}>
                                    <div className="screen-fx-card-row">
                                        <span className="screen-fx-icon">{effect.icon}</span>
                                        <span className="screen-fx-name">{effect.name}</span>
                                        <button className="screen-fx-pill-btn" onClick={() => playPreview(effect.type, "")}>
                                            Preview
                                        </button>
                                        <Toggle
                                            checked={builtins[effect.type].enabled}
                                            onChange={c => patchBuiltin(effect.type, { enabled: c })}
                                        />
                                    </div>
                                </div>
                            ))}
                        </>
                    )}
                </div>

                <div className="screen-fx-footer">
                    {tab === "rain" && (
                        <button className="screen-fx-reset-link" onClick={() => setRules(resetChatScreenEffectRules())}>
                            Restore Default Rules
                        </button>
                    )}
                    <button className="screen-fx-cta" onClick={onClose}>Done</button>
                </div>
            </div>
            <ChatScreenEffectOverlay active={preview} onDone={() => setPreview(null)} />
        </div>
    );
}
