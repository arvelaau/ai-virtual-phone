"use client";

// 名片「现场建档」流程：AI 推荐了一个档案库里没有的人 → 弹窗确认 →
// 按名字+聊天语境生成人设 → 可编辑预览 → 确认写入（与角色 app 生成配角
// 共用 materializeSupportingCharacter 落库）。

import { useState } from "react";
import {
    generateNamedSupportingCharacter,
    materializeSupportingCharacter,
    type GeneratedSupportingCharacter,
} from "@/lib/npc-generator";
import { buildChatContextExcerpt, resolveContactCard } from "@/lib/contact-card";
import { Loader2 } from "lucide-react";

type FlowStep = "confirm" | "generating" | "preview";

export function ContactCardGenerateFlow({
    recommenderCharacterId,
    recommenderName,
    contactName,
    sessionId,
    messageId,
    onClose,
    onCreated,
}: {
    recommenderCharacterId: string;
    recommenderName: string;
    contactName: string;
    sessionId: string;
    messageId: string;
    onClose: () => void;
    /** 写入完成（或发现已存在档案）后回调，气泡借此刷新解析状态 */
    onCreated: () => void;
}) {
    const [step, setStep] = useState<FlowStep>("confirm");
    const [draft, setDraft] = useState<GeneratedSupportingCharacter | null>(null);
    const [error, setError] = useState("");

    const patch = (partial: Partial<GeneratedSupportingCharacter>) => {
        setDraft(prev => (prev ? { ...prev, ...partial } : prev));
    };

    async function handleGenerate() {
        setStep("generating");
        setError("");
        try {
            const chatContext = buildChatContextExcerpt(sessionId, messageId, recommenderName);
            const generated = await generateNamedSupportingCharacter(recommenderCharacterId, contactName, chatContext);
            setDraft(generated);
            setStep("preview");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStep(draft ? "preview" : "confirm");
        }
    }

    function handleConfirmWrite() {
        if (!draft) return;
        // 防重：写入前再查一次（用户可能刚好手动建了同名角色）
        const existing = resolveContactCard(recommenderCharacterId, contactName);
        if (!existing.character) {
            materializeSupportingCharacter(draft, recommenderCharacterId, { allowAutoPost: false });
        }
        onCreated();
        onClose();
    }

    return (
        <div className="modal-overlay" onClick={step === "generating" ? undefined : onClose}>
            <div className="modal-dialog contact-card-flow-dialog" onClick={e => e.stopPropagation()}>
                {step === "confirm" && (
                    <>
                        <div className="ts-16 font-semibold text-center text-[var(--c-text)]">Generate Character Profile</div>
                        <p className="ts-13 text-[var(--c-text)] opacity-80 leading-relaxed">
                            There&apos;s no profile for &quot;{contactName}&quot; yet. Generate a persona profile for them based on {recommenderName}&apos;s recommendation context?
                        </p>
                        <p className="ts-11 text-[var(--c-text)] opacity-50 leading-relaxed">
                            You can edit and confirm after generation; once saved, you can add them as a friend.
                        </p>
                        {error && <p className="ts-12" style={{ color: "var(--c-danger, #d33)" }}>{error}</p>}
                        <div className="flex gap-3 w-full">
                            <button className="ui-btn ui-btn-ghost flex-1" onClick={onClose}>Cancel</button>
                            <button className="ui-btn ui-btn-success flex-1" onClick={handleGenerate}>Generate Profile</button>
                        </div>
                    </>
                )}

                {step === "generating" && (
                    <>
                        <div className="ts-16 font-semibold text-center text-[var(--c-text)]">Generate Character Profile</div>
                        <div className="flex flex-col items-center gap-3 py-6">
                            <Loader2 size={26} className="animate-spin" style={{ color: "var(--c-icon)" }} />
                            <span className="ts-12 text-[var(--c-text)] opacity-60">Generating a profile for &quot;{contactName}&quot; based on the chat context…</span>
                        </div>
                    </>
                )}

                {step === "preview" && draft && (
                    <>
                        <div className="ts-16 font-semibold text-center text-[var(--c-text)]">Confirm &quot;{contactName}&quot;&apos;s Profile</div>
                        <div className="contact-card-flow-fields">
                            <label className="contact-card-flow-label">Persona (full character card)</label>
                            <textarea
                                className="ui-input contact-card-flow-textarea"
                                style={{ minHeight: 140 }}
                                value={draft.persona}
                                onChange={e => patch({ persona: e.target.value })}
                            />
                            <label className="contact-card-flow-label">Personality</label>
                            <input
                                className="ui-input"
                                value={draft.personality}
                                onChange={e => patch({ personality: e.target.value })}
                            />
                            <label className="contact-card-flow-label">Brief persona (injected for characters in the same world)</label>
                            <textarea
                                className="ui-input contact-card-flow-textarea"
                                style={{ minHeight: 72 }}
                                value={draft.briefPersona}
                                onChange={e => patch({ briefPersona: e.target.value })}
                            />
                            <div className="flex gap-2">
                                <div className="flex-1 flex flex-col gap-1">
                                    <label className="contact-card-flow-label">They are {recommenderName}&apos;s</label>
                                    <input className="ui-input" value={draft.relationLabel} onChange={e => patch({ relationLabel: e.target.value })} />
                                </div>
                                <div className="flex-1 flex flex-col gap-1">
                                    <label className="contact-card-flow-label">{recommenderName} is their</label>
                                    <input className="ui-input" value={draft.reverseRelationLabel} onChange={e => patch({ reverseRelationLabel: e.target.value })} />
                                </div>
                            </div>
                        </div>
                        {error && <p className="ts-12" style={{ color: "var(--c-danger, #d33)" }}>{error}</p>}
                        <div className="flex gap-3 w-full">
                            <button className="ui-btn ui-btn-ghost flex-1" onClick={onClose}>Cancel</button>
                            <button className="ui-btn ui-btn-outline flex-1" onClick={handleGenerate}>Regenerate</button>
                            <button
                                className="ui-btn ui-btn-success flex-1"
                                disabled={!draft.persona.trim()}
                                onClick={handleConfirmWrite}
                            >
                                Save Profile
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
