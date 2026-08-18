"use client";

// House Special -- slot editing: which materials are stacked in one slot, and when each
// applies.
//
// Two nested sheets: the outer one is the slot's list (reorder / remove / add another), and
// tapping "When it applies" on an entry opens the inner condition editor.
// A condition has only five forms, each of which fits in a sentence. No nesting, no
// expressions -- writing real logic is a different job and should not have a hole opened for
// it here.

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { describeMixCondition } from "@/lib/mixology/state";
import {
    MIX_KIND_LABELS,
    MIX_SLOT_MAX,
    MIX_SLOT_STACK,
    type MixCompareOp,
    type MixCondition,
    type MixMaterial,
    type MixMaterialKind,
    type MixSlotEntry,
} from "@/lib/mixology/types";
import { KindGlyph } from "./mixology-shared";

const COMPARE_OPS: { value: MixCompareOp; label: string }[] = [
    { value: ">", label: "is greater than" },
    { value: ">=", label: "is at least" },
    { value: "<", label: "is less than" },
    { value: "<=", label: "is at most" },
    { value: "=", label: "equals" },
    { value: "!=", label: "does not equal" },
];

type ConditionForm = "always" | "turn" | "var" | "keyword" | "chance";

function formOf(when: MixCondition | undefined): ConditionForm {
    return when?.type ?? "always";
}

/** The condition editor: pick one of five, each a single line to fill in */
function ConditionSheet({
    kind,
    materialName,
    when,
    varNames,
    onSave,
    onClose,
}: {
    kind: MixMaterialKind;
    materialName: string;
    when: MixCondition | undefined;
    varNames: string[];
    onSave: (next: MixCondition | undefined) => void;
    onClose: () => void;
}) {
    const [form, setForm] = useState<ConditionForm>(() => formOf(when));
    const [turnAfter, setTurnAfter] = useState(() => (when?.type === "turn" ? String(when.after) : "10"));
    const [varName, setVarName] = useState(() => (when?.type === "var" ? when.name : varNames[0] ?? ""));
    const [varOp, setVarOp] = useState<MixCompareOp>(() => (when?.type === "var" ? when.op : ">"));
    const [varValue, setVarValue] = useState(() => (when?.type === "var" ? when.value : ""));
    // Joined with ", " to round-trip against the split below and the field's placeholder.
    const [words, setWords] = useState(() => (when?.type === "keyword" ? when.words.join(", ") : ""));
    const [within, setWithin] = useState(() => (when?.type === "keyword" ? String(when.within ?? 1) : "1"));
    const [percent, setPercent] = useState(() => (when?.type === "chance" ? String(when.percent) : "30"));

    const commit = () => {
        if (form === "always") { onSave(undefined); return; }
        if (form === "turn") {
            const after = Math.max(0, Math.floor(Number(turnAfter) || 0));
            onSave({ type: "turn", after });
            return;
        }
        if (form === "var") {
            const name = varName.trim();
            if (!name || !varValue.trim()) return;
            onSave({ type: "var", name, op: varOp, value: varValue.trim() });
            return;
        }
        if (form === "keyword") {
            // Whitespace only separates when no explicit separator is present. A keyword is
            // matched with a plain substring test, so "rainy day" is a perfectly good one --
            // splitting on whitespace unconditionally would shred it into two. Same defect and
            // same fix as parseMixTags in types.ts and parseTags in xiaohongshu-engine.ts.
            const explicit = /[、,，]/.test(words);
            const list = words.split(explicit ? /[、,，]+/ : /\s+/).map((w) => w.trim()).filter(Boolean);
            if (!list.length) return;
            const scope = Math.max(1, Math.floor(Number(within) || 1));
            onSave({ type: "keyword", words: list, within: scope > 1 ? scope : undefined });
            return;
        }
        const p = Math.max(0, Math.min(100, Math.floor(Number(percent) || 0)));
        onSave({ type: "chance", percent: p });
    };

    const canSave = form !== "var" || Boolean(varName.trim() && varValue.trim());

    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-head">
                    <div className="mix-sheet-title">When it applies</div>
                    <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
                </div>
                <div className="mix-sheet-body">
                    <div className="mix-cond-target">{MIX_KIND_LABELS[kind]} · {materialName}</div>

                    <label className="mix-cond-opt" data-on={form === "always" ? "true" : undefined}>
                        <input type="radio" checked={form === "always"} onChange={() => setForm("always")} />
                        <span>Always</span>
                    </label>

                    <label className="mix-cond-opt" data-on={form === "turn" ? "true" : undefined}>
                        <input type="radio" checked={form === "turn"} onChange={() => setForm("turn")} />
                        <span>
                            After turn
                            <input
                                className="mix-cond-num"
                                inputMode="numeric"
                                value={turnAfter}
                                onFocus={() => setForm("turn")}
                                onChange={(e) => setTurnAfter(e.target.value)}
                            />
                            
                        </span>
                    </label>

                    <label className="mix-cond-opt" data-on={form === "var" ? "true" : undefined}>
                        <input type="radio" checked={form === "var"} onChange={() => setForm("var")} disabled={!varNames.length} />
                        <span>
                            When
                            {varNames.length ? (
                                <select
                                    className="mix-cond-sel"
                                    value={varName}
                                    onFocus={() => setForm("var")}
                                    onChange={(e) => { setForm("var"); setVarName(e.target.value); }}
                                >
                                    {varNames.map((name) => <option value={name} key={name}>{name}</option>)}
                                </select>
                            ) : (
                                <em className="mix-cond-hint">(tick some items to remember on the receipt first)</em>
                            )}
                            {varNames.length ? (
                                <>
                                    <select
                                        className="mix-cond-sel"
                                        value={varOp}
                                        onFocus={() => setForm("var")}
                                        onChange={(e) => { setForm("var"); setVarOp(e.target.value as MixCompareOp); }}
                                    >
                                        {COMPARE_OPS.map((op) => <option value={op.value} key={op.value}>{op.label}</option>)}
                                    </select>
                                    <input
                                        className="mix-cond-val"
                                        value={varValue}
                                        placeholder="value"
                                        onFocus={() => setForm("var")}
                                        onChange={(e) => setVarValue(e.target.value)}
                                    />
                                </>
                            ) : null}
                        </span>
                    </label>

                    <label className="mix-cond-opt" data-on={form === "keyword" ? "true" : undefined}>
                        <input type="radio" checked={form === "keyword"} onChange={() => setForm("keyword")} />
                        <span>
                            When
                            <input
                                className="mix-cond-text"
                                value={words}
                                placeholder="rain, snow (comma separated)"
                                onFocus={() => setForm("keyword")}
                                onChange={(e) => setWords(e.target.value)}
                            />
                            comes up, within the last
                            <input
                                className="mix-cond-num"
                                inputMode="numeric"
                                value={within}
                                onFocus={() => setForm("keyword")}
                                onChange={(e) => setWithin(e.target.value)}
                            />
                            turns
                        </span>
                    </label>

                    <label className="mix-cond-opt" data-on={form === "chance" ? "true" : undefined}>
                        <input type="radio" checked={form === "chance"} onChange={() => setForm("chance")} />
                        <span>
                            On a random
                            <input
                                className="mix-cond-num"
                                inputMode="numeric"
                                value={percent}
                                onFocus={() => setForm("chance")}
                                onChange={(e) => setPercent(e.target.value)}
                            />
                            % of turns
                        </span>
                    </label>

                    <div className="mix-form-footer">
                        <button type="button" className="mix-ghost-btn" onClick={onClose}>Cancel</button>
                        <button type="button" className="mix-brew-btn" onClick={commit} disabled={!canSave}>Confirm</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function MixSlotEditor({
    kind,
    entries,
    resolve,
    varNames,
    onChange,
    onPickMore,
    onClose,
}: {
    kind: MixMaterialKind;
    entries: MixSlotEntry[];
    /** Resolve a material by id (nothing back means it was deleted from the cabinet) */
    resolve: (id: string) => MixMaterial | null;
    /** The remembered items available, for the variable condition */
    varNames: string[];
    onChange: (next: MixSlotEntry[]) => void;
    onPickMore: () => void;
    onClose: () => void;
}) {
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const stackMode = MIX_SLOT_STACK[kind];
    const full = entries.length >= MIX_SLOT_MAX;

    const move = (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= entries.length) return;
        const next = [...entries];
        [next[index], next[target]] = [next[target], next[index]];
        onChange(next);
    };

    const remove = (index: number) => onChange(entries.filter((_, i) => i !== index));

    const setWhen = (index: number, when: MixCondition | undefined) => {
        onChange(entries.map((entry, i) => {
            if (i !== index) return entry;
            const { when: _drop, ...rest } = entry;
            return when ? { ...rest, when } : rest;
        }));
        setEditingIndex(null);
    };

    const editing = editingIndex !== null ? entries[editingIndex] : undefined;
    const editingName = editing ? resolve(editing.materialId)?.name ?? "Deleted material" : "";

    return (
        <>
            <div className="mix-sheet-mask" onClick={onClose}>
                <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                    <div className="mix-sheet-head">
                        <div className="mix-sheet-title">{MIX_KIND_LABELS[kind]} in this slot</div>
                        <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
                    </div>
                    <div className="mix-sheet-body">
                        <div className="mix-struct-note">
                            {stackMode === "concat"
                                ? "Everything in this slot whose condition holds applies, layered in the order below."
                                : "This slot is read top to bottom and uses the first entry whose condition holds; the rest sit this turn out."}
                        </div>

                        <div className="mix-stack-list">
                            {entries.map((entry, index) => {
                                const material = resolve(entry.materialId);
                                return (
                                    <div className="mix-stack-row" key={`${entry.materialId}-${index}`}>
                                        <div className="mix-stack-order">{index + 1}</div>
                                        <div className="mix-stack-glyph"><KindGlyph kind={kind} size={20} /></div>
                                        <div className="mix-stack-main">
                                            <div className="mix-stack-name" data-gone={material ? undefined : "true"}>
                                                {material?.name ?? "This material is no longer in the cabinet"}
                                            </div>
                                            <button
                                                type="button"
                                                className="mix-stack-when"
                                                onClick={() => setEditingIndex(index)}
                                            >
                                                {describeMixCondition(entry.when)}
                                            </button>
                                        </div>
                                        <div className="mix-stack-ops">
                                            <button type="button" className="mix-icon-btn" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up"><ArrowUp size={15} /></button>
                                            <button type="button" className="mix-icon-btn" onClick={() => move(index, 1)} disabled={index === entries.length - 1} aria-label="Move down"><ArrowDown size={15} /></button>
                                            <button type="button" className="mix-icon-btn" onClick={() => remove(index)} aria-label="Remove"><Trash2 size={15} /></button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <button type="button" className="mix-stack-add" onClick={onPickMore} disabled={full}>
                            <Plus size={16} />
                            {full ? `A slot holds at most ${MIX_SLOT_MAX}` : "Add another"}
                        </button>
                    </div>
                </div>
            </div>

            {editing ? (
                <ConditionSheet
                    kind={kind}
                    materialName={editingName}
                    when={editing.when}
                    varNames={varNames}
                    onSave={(next) => setWhen(editingIndex!, next)}
                    onClose={() => setEditingIndex(null)}
                />
            ) : null}
        </>
    );
}
