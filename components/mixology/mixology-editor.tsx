"use client";

// House Special -- the material editor: the create/edit form for every material kind,
// rendered inside the bottom sheet.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Plus, Trash2 } from "lucide-react";
import type {
    MixCharacterCard,
    MixFilterRule,
    MixMaterial,
    MixMaterialKind,
    MixTextMaterial,
    MixTicketVar,
} from "@/lib/mixology/types";
import { createMixId, formatMixTags, MIX_KIND_LABELS, MIX_PANEL_DEFAULT_LAYOUT, MIX_TAG_MAX, mixKindHasCover, mixPanelLayoutOf, parseMixTags } from "@/lib/mixology/types";
import { applyMixFilterRules } from "@/lib/mixology/prose";
import { MixPreviewInline, MixStructureSheet } from "./mixology-preview";

const OPENING_SEPARATOR = "\n---\n";

/** Say up front, for each kind: what this is for, and which prompt section it lands in.
 *  ⚠️ The `where` strings name PROMPT SECTIONS -- same lockstep as mixology-preview's
 *  STRUCTURE_ROWS and assembler.ts's headings. */
const KIND_GUIDE: Record<MixMaterialKind, { what: string; where: string }> = {
    character: {
        what: "Character information goes here: who they are, how they look, their personality, the world they live in, their starting relationship with the player, plus opening lines and sample dialogue.",
        where: "Goes into three sections: Character info, World & plot, and Sample dialogue.",
    },
    persona: {
        what: "The user persona goes here: who {{user}} is -- identity, personality, appearance, and your side of the relationship with {{char}}.",
        where: "Goes into the User info section; setting a name replaces every {{user}}.",
    },
    base: {
        what: "The roleplay charter goes here: how to stay in character, whether the model may speak for the player, whether conflict and negative feeling are allowed. This constrains attitude, not prose.",
        where: "Goes into the first section of the prompt.",
    },
    flavor: {
        what: "Prose style goes here: sentence length, narrative viewpoint, whether to lean on action or interiority. This constrains how it is written, and carries no character setting.",
        where: "Goes into the Prose style section.",
    },
    glass: {
        what: "Output requirements go here: how many paragraphs per turn, the pace of the narration, how to end a turn. The prose marker rules (「」 speech, * * inner voice, 【】 scene, ~ ~ emphasis) are built in at the head of this section, so there is no need to restate them.",
        where: "Follows the built-in prose marker rules.",
    },
    strength: {
        what: "The highest-priority requirements go here: one or two rules that absolutely must hold. Because they sit after the whole conversation and just before generation, the model follows them most closely -- and the more you add, the more they dilute each other.",
        where: "Placed after the whole conversation and just before generation, where the model can least ignore it.",
    },
    ticket: {
        what: "The status panel goes here: a data card carried alongside every turn -- affection, current mood, what they are carrying, whatever you decide. The contract decides what the model reports; the render code decides how the card looks.",
        where: "The contract goes into the prompt; the render code runs in the interface only.",
    },
    garnish: {
        what: "Interface styling goes here, as CSS: prose colors, the dialogue typeface, the shape of a bubble. Writing body / html / :root all mean the session screen itself.",
        where: "Never enters the prompt: it only changes presentation and costs no context.",
    },
    encore: {
        what: "The skit goes here: an extra scene beside the prose -- an onlooker's view, a social post, a stretch of security footage. The output contract decides when the AI writes one and what goes in it; the render code decides how it looks. Leave the contract empty and it is simply a static sketch (a journal page, a shift rota).",
        where: "The contract goes into the prompt; the render code runs in the interface only.",
    },
    mechanism: {
        what: "A mechanism goes here: a piece of logic that runs in a sandbox, plus an interface that stays on the session screen, drawn wherever and at whatever size its own code asks for. The two halves are usually written together -- they share one storage bucket and can see each other, so something the panel noted down can be used by the hook before the next send -- but writing only one half is fine. The logic is called at a few fixed moments (session start, before sending, after a reply arrives, leaving the session), each time receiving a payload and handing one back.",
        where: "Never enters the prompt. It runs in a sandbox with no network and no reach into the app itself, and is cut off on timeout -- that turn then proceeds as if there were no mechanism.",
    },
    filter: {
        what: "A strainer goes here: a set of regex replacements that clean up the AI's tics automatically -- leftover markdown, a verbal crutch, the wrong punctuation. Each rule is either display only (the original is stored and the substitution happens at render time, so editing the rule takes effect across the whole history at once) or enters context (cleaned before storing, so the history sent back to the model is clean too, but only new replies are affected).",
        where: "Never enters the prompt. It runs after the status-panel and skit blocks have been split out, touches the prose only, and cannot damage the block data.",
    },
};

/**
 * Which heading level a creator should use when subdividing a box.
 * The app itself owns # (a section) and ## (a box), so everything from ### down is theirs.
 * Not shown for the kinds that never reach the prompt (garnish / mechanism / strainer).
 */
const HEADING_NOTE = "To add a subheading inside a box, start it with ### (# and ## are taken by the app).";
const HEADING_NOTE_KINDS: MixMaterialKind[] = ["character", "persona", "base", "flavor", "glass", "strength", "ticket", "encore"];

/** Field name and example for the text kinds (base / flavor / glassware / bitters) */
const TEXT_FIELD_COPY: Record<"base" | "flavor" | "glass" | "strength", { label: string; placeholder: string }> = {
    base: {
        label: "Roleplay rules",
        placeholder: "e.g.\nYou are to become {{char}} completely, living inside the story in the first person.\n- Never step out of character, and never refer to yourself as an AI.\n- Never speak or decide on {{user}}'s behalf.\n- Conflict, refusal and negative feeling are all allowed; staying true to the persona matters more than pleasing {{user}}.",
    },
    flavor: {
        label: "Prose style",
        placeholder: "e.g.\nRestrained short sentences. Favour action, smell and setting detail over explaining what someone feels.\nLeave space between lines of dialogue; do not say everything.",
    },
    glass: {
        label: "Output requirements",
        placeholder: "e.g.\nWrite as third-person novel prose, two to four paragraphs per turn, with a blank line between them.\n- Thread action and setting detail through the narration; do not write a bare list of events.\n- End somewhere with a little resonance left, leaving {{user}} room to answer.",
    },
    strength: {
        label: "Highest priority requirements",
        placeholder: "One or two is plenty. e.g.\nKeep {{char}}'s restraint at all times, and never summarise {{user}}'s feelings for them.",
    },
};

/** Squash every cover to a JPEG dataURL of at most 900px, so a large image cannot blow out kv */
async function readCoverFile(file: File): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the image"));
        reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Could not decode the image"));
        el.src = dataUrl;
    });
    const max = 900;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale >= 1 && dataUrl.length < 400_000) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
}

type EditorProps = {
    kind: MixMaterialKind;
    initial?: MixMaterial;
    onSave: (material: MixMaterial) => void;
    onCancel: () => void;
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <>
            <label className="mix-form-label">
                {label}
                {hint ? <> · <b>{hint}</b></> : null}
            </label>
            {children}
        </>
    );
}

export function MixMaterialEditor({ kind, initial, onSave, onCancel }: EditorProps) {
    const isCharacter = kind === "character";
    const initialCard = isCharacter && initial?.kind === "character" ? (initial as MixCharacterCard) : null;

    const [name, setName] = useState(initial?.name ?? "");
    const [hook, setHook] = useState(initial?.hook ?? "");
    const [tagsText, setTagsText] = useState(formatMixTags(initial?.tags));
    const [cover, setCover] = useState(initial?.cover ?? "");
    // Character card only
    const [baseInfo, setBaseInfo] = useState(initialCard?.baseInfo ?? "");
    const [personality, setPersonality] = useState(initialCard?.personality ?? "");
    const [appearance, setAppearance] = useState(initialCard?.appearance ?? "");
    const [background, setBackground] = useState(initialCard?.background ?? "");
    const [worldview, setWorldview] = useState(initialCard?.worldview ?? "");
    const [cognition, setCognition] = useState(initialCard?.cognition ?? "");
    const [relations, setRelations] = useState(initialCard?.relations ?? "");
    const [plot, setPlot] = useState(initialCard?.plot ?? "");
    const [extra, setExtra] = useState(initialCard?.extra ?? "");
    const [openingsText, setOpeningsText] = useState(initialCard?.openings.join(OPENING_SEPARATOR) ?? "");
    const [canvas, setCanvas] = useState(initialCard?.canvas ?? "");
    const [examples, setExamples] = useState<{ role: "user" | "char"; text: string }[]>(
        initialCard?.examples ? initialCard.examples.map((e) => ({ ...e })) : [],
    );
    // Text kinds / receipt / garnish / encore
    const [content, setContent] = useState(
        initial && "content" in initial ? (initial as MixTextMaterial).content : "",
    );
    const [personaUserName, setPersonaUserName] = useState(initial?.kind === "persona" ? initial.userName ?? "" : "");
    const [contract, setContract] = useState(initial?.kind === "ticket" ? initial.contract : "");
    const [renderHtml, setRenderHtml] = useState(initial?.kind === "ticket" ? initial.renderHtml : "");
    const [previewRaw, setPreviewRaw] = useState(initial?.kind === "ticket" ? initial.previewRaw ?? "" : "");
    const [vars, setVars] = useState<MixTicketVar[]>(initial?.kind === "ticket" ? initial.vars ?? [] : []);
    const [script, setScript] = useState(initial?.kind === "mechanism" ? initial.script ?? "" : "");
    // Placement is not a form field: the interface code sets it itself via mix.move /
    // mix.size / mix.chrome and friends. Whatever an older material carries is preserved
    // as-is, so renaming one does not wipe the position somebody arranged.
    const keptLayout = initial?.kind === "mechanism" ? initial.layout : undefined;
    const keptDock = initial?.kind === "mechanism" ? initial.dock : undefined;
    const [panelHtml, setPanelHtml] = useState(initial?.kind === "mechanism" ? initial.panelHtml ?? "" : "");

    /**
     * Pick out lines shaped like "field: description" from the contract text and offer them as
     * a row of tappable candidates.
     * Writing the contract already means listing what gets reported each turn, so this just
     * lifts those names out to be tapped rather than retyped -- one typo and the value can
     * never be read back.
     */
    const contractFieldNames = useMemo(() => {
        const names: string[] = [];
        for (const line of contract.split(/\r?\n/)) {
            const matched = /^\s*[-*·]?\s*([^：:=\s][^：:=]{0,11})\s*[：:=]/.exec(line);
            if (!matched) continue;
            const name = matched[1].trim();
            if (name && !names.includes(name)) names.push(name);
        }
        return names.slice(0, 12);
    }, [contract]);
    const [css, setCss] = useState(initial?.kind === "garnish" ? initial.css : "");
    const [html, setHtml] = useState(initial?.kind === "encore" ? (initial.renderHtml ?? initial.html ?? "") : "");
    const [encoreContract, setEncoreContract] = useState(initial?.kind === "encore" ? initial.contract ?? "" : "");
    const [encorePreviewRaw, setEncorePreviewRaw] = useState(initial?.kind === "encore" ? initial.previewRaw ?? "" : "");
    // Strainer
    const [rules, setRules] = useState<MixFilterRule[]>(
        initial?.kind === "filter" ? initial.rules.map((r) => ({ ...r })) : [],
    );
    const [filterSample, setFilterSample] = useState("");
    // Test run: apply every rule in order regardless of mode, to show the result. Rules whose
    // regex is malformed are flagged individually.
    const filterTest = useMemo(() => {
        const badIndexes: number[] = [];
        rules.forEach((rule, i) => {
            if (!rule.find) return;
            try { new RegExp(rule.find, "g"); } catch { badIndexes.push(i); }
        });
        const result = filterSample
            ? applyMixFilterRules(applyMixFilterRules(filterSample, rules, "context"), rules, "display")
            : "";
        return { badIndexes, result };
    }, [rules, filterSample]);
    const [error, setError] = useState("");
    const [structureOpen, setStructureOpen] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

    // Tags: split by the same rules that will be stored, and show that as you type, so nothing
    // is silently trimmed away only once saved
    const tags = useMemo(() => parseMixTags(tagsText), [tagsText]);
    const tagsDropped = useMemo(() => {
        const all = new Set(tagsText.split(/[,，、|｜#＃\s]+/).map((t) => t.trim()).filter(Boolean));
        return Math.max(0, all.size - tags.length);
    }, [tagsText, tags.length]);

    const handleCoverFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            setCover(await readCoverFile(file));
        } catch {
            setError("The cover image could not be read. Please try a different one.");
        }
    };

    const handleSave = () => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError("Give this material a name first.");
            return;
        }
        const meta = {
            id: initial?.id ?? createMixId("mixmat"),
            name: trimmedName,
            hook: hook.trim() || undefined,
            author: initial?.author,
            tags: tags.length ? tags : undefined,
            cover: cover || undefined,
            createdAt: initial?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
        };
        if (isCharacter) {
            const openings = openingsText
                .split(/\n\s*---\s*(?:\n|$)/)
                .map((o) => o.trim())
                .filter(Boolean);
            if (!openings.length) {
                setError("Write at least one opening line, or there is nothing to pour.");
                return;
            }
            const card: MixCharacterCard = {
                ...meta,
                kind: "character",
                charName: trimmedName,
                baseInfo: baseInfo.trim() || undefined,
                personality: personality.trim() || undefined,
                appearance: appearance.trim() || undefined,
                background: background.trim() || undefined,
                worldview: worldview.trim() || undefined,
                cognition: cognition.trim() || undefined,
                relations: relations.trim() || undefined,
                plot: plot.trim() || undefined,
                extra: extra.trim() || undefined,
                openings,
                examples: examples.filter((e) => e.text.trim()).map((e) => ({ role: e.role, text: e.text.trim() })),
                canvas: canvas.trim() || undefined,
                authorNote: initialCard?.authorNote,
            };
            onSave(card);
            return;
        }
        if (kind === "ticket") {
            if (!contract.trim() || !renderHtml.trim()) {
                setError("A receipt needs both an output contract and render code.");
                return;
            }
            const cleanVars = vars
                .map((v) => ({ name: v.name.trim(), initial: v.initial?.trim() || undefined }))
                .filter((v, i, all) => v.name && all.findIndex((x) => x.name === v.name) === i);
            onSave({ ...meta, kind: "ticket", contract: contract.trim(), renderHtml, previewRaw: previewRaw.trim() || undefined, vars: cleanVars.length ? cleanVars : undefined });
            return;
        }
        if (kind === "mechanism") {
            onSave({
                ...meta,
                kind: "mechanism",
                script: script.trim() || undefined,
                layout: keptLayout,
                dock: keptDock,
                panelHtml: panelHtml.trim() || undefined,
            });
            return;
        }
        if (kind === "garnish") {
            if (!css.trim()) {
                setError("A garnish cannot be empty -- write some CSS.");
                return;
            }
            onSave({ ...meta, kind: "garnish", css });
            return;
        }
        if (kind === "encore") {
            if (!html.trim()) {
                setError("An encore's render code cannot be empty.");
                return;
            }
            onSave({
                ...meta,
                kind: "encore",
                contract: encoreContract.trim() || undefined,
                renderHtml: html,
                previewRaw: encorePreviewRaw.trim() || undefined,
            });
            return;
        }
        if (kind === "persona") {
            if (!content.trim()) {
                setError("A mask's persona text cannot be empty.");
                return;
            }
            onSave({ ...meta, kind: "persona", userName: personaUserName.trim() || undefined, content: content.trim() });
            return;
        }
        if (kind === "filter") {
            const cleaned = rules
                .map((r) => ({ find: r.find.trim(), replace: r.replace, mode: r.mode }))
                .filter((r) => r.find);
            if (!cleaned.length) {
                setError("A strainer needs at least one rule with a non-empty search.");
                return;
            }
            const bad = cleaned.findIndex((r) => { try { new RegExp(r.find, "g"); return false; } catch { return true; } });
            if (bad >= 0) {
                setError(`Rule ${bad + 1} has a malformed regex. Fix it in the test run area below before saving.`);
                return;
            }
            onSave({ ...meta, kind: "filter", rules: cleaned });
            return;
        }
        if (!content.trim()) {
            setError(`${MIX_KIND_LABELS[kind]} content cannot be empty.`);
            return;
        }
        onSave({ ...meta, kind, content: content.trim() } as MixTextMaterial);
    };

    const guide = KIND_GUIDE[kind];

    return (
        <div>
            <div className="mix-guide">
                <div className="mix-guide-what">{guide.what}</div>
                <div className="mix-guide-where">{guide.where}</div>
                {HEADING_NOTE_KINDS.includes(kind) ? <div className="mix-guide-level">{HEADING_NOTE}</div> : null}
                <button type="button" className="mix-guide-link" onClick={() => setStructureOpen(true)}>
                    <FileText size={12} style={{ verticalAlign: "-2px" }} /> See the full prompt structure
                </button>
            </div>
            <Field label={isCharacter ? "Character name" : "Name"} hint="required">
                <input className="mix-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={isCharacter ? "What the character is called -- this is {{char}} in the prompt" : `Name this ${MIX_KIND_LABELS[kind]} so you can recognise it at the bar`} />
            </Field>
            <Field label="Hook">
                <input className="mix-input" value={hook} onChange={(e) => setHook(e.target.value)} placeholder="One line on what makes it distinctive; shown on the card" />
            </Field>
            <Field label="Tags" hint={`up to ${MIX_TAG_MAX}`}>
                <input
                    className="mix-input"
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    placeholder="Separate with commas, e.g. modern city, unrequited, reunion"
                />
                {tags.length ? (
                    <div className="mix-tag-list" style={{ marginTop: 8 }}>
                        {tags.map((tag) => (
                            <span className="mix-tag" key={tag}>{tag}</span>
                        ))}
                    </div>
                ) : null}
                {tagsDropped > 0 ? (
                    <div className="mix-form-note">Tags beyond {MIX_TAG_MAX} are not saved; {tagsDropped} too many so far.</div>
                ) : null}
            </Field>
            {mixKindHasCover(kind) ? (
                <Field label="Cover image" hint={isCharacter ? "the session backdrop -- strongly recommended" : undefined}>
                    <div className="mix-cover-picker">
                        {cover ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="mix-cover-preview" src={cover} alt="Cover" />
                        ) : (
                            <div className="mix-cover-preview" />
                        )}
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <button type="button" className="mix-pill-btn" onClick={() => fileRef.current?.click()}>Choose image</button>
                            {cover ? (
                                <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setCover("")}>Remove</button>
                            ) : null}
                        </div>
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            style={{ display: "none" }}
                            onChange={(e) => { void handleCoverFile(e.target.files?.[0]); e.target.value = ""; }}
                        />
                    </div>
                </Field>
            ) : null}
            {isCharacter ? (
                <>
                    <Field label="Basics"><textarea className="mix-textarea" value={baseInfo} onChange={(e) => setBaseInfo(e.target.value)} placeholder="e.g. 27 / 183cm / night-shift clerk at a corner shop" /></Field>
                    <Field label="Personality"><textarea className="mix-textarea" value={personality} onChange={(e) => setPersonality(e.target.value)} placeholder="e.g. complains while helping anyway; hates being put out but never actually says no" /></Field>
                    <Field label="Appearance"><textarea className="mix-textarea" value={appearance} onChange={(e) => setAppearance(e.target.value)} placeholder="e.g. tall and thin, uniform sleeves always pushed to the elbow, an old piercing in the left ear" /></Field>
                    <Field label="Background"><textarea className="mix-textarea" value={background} onChange={(e) => setBackground(e.target.value)} placeholder="e.g. moved here three years ago, studies by day, works nights to pay the fees" /></Field>
                    <Field label="Worldview"><textarea className="mix-textarea" value={worldview} onChange={(e) => setWorldview(e.target.value)} placeholder="What world this happens in. e.g. an ordinary modern city, nothing supernatural" /></Field>
                    <Field label={"Initial awareness of {{user}}"}><textarea className="mix-textarea" value={cognition} onChange={(e) => setCognition(e.target.value)} placeholder="How much the character knows about you at the start. e.g. knows only that you come in three times a week; does not know your name" /></Field>
                    <Field label="Relationships & identity"><textarea className="mix-textarea" value={relations} onChange={(e) => setRelations(e.target.value)} placeholder="Which roles the player can step into and the relationship under each. e.g. a regular (an unspoken understanding) / a new colleague (he shows you the ropes)" /></Field>
                    <Field label="Current scene"><textarea className="mix-textarea" value={plot} onChange={(e) => setPlot(e.target.value)} placeholder="The moment the story opens on. e.g. a rainy night, ten minutes to closing, only the two of you left in the shop" /></Field>
                    <Field label="Extra setting"><textarea className="mix-textarea" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Supporting cast, private terms, places. e.g. the manager only works days; 'locker three' is a code between them" /></Field>
                    <Field label="Opening lines" hint="required. Write several and the player picks one at the start; separate them with --- on its own line">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 130 }}
                            value={openingsText}
                            onChange={(e) => setOpeningsText(e.target.value)}
                            placeholder={"The story's first beat, spoken by the character.\n\ne.g.\n【The corner shop, ten minutes to closing】\nHe squared off the skewers and looked up at you. 「Working this late again?」\n---\nA rainy night. He stood in the doorway under an umbrella, as if he had been waiting a while."}
                        />
                    </Field>
                    <Field label="Sample dialogue" hint="an anchor for prose style, not events that have happened">
                        <div className="mix-example-list">
                            {examples.map((example, i) => (
                                <div className="mix-example-row" key={i}>
                                    <button
                                        type="button"
                                        className="mix-example-role"
                                        data-role={example.role}
                                        onClick={() => setExamples((prev) => prev.map((e, idx) => (
                                            idx === i ? { ...e, role: e.role === "user" ? "char" : "user" } : e
                                        )))}
                                    >
                                        {example.role === "user" ? "Player" : "Character"}
                                    </button>
                                    <textarea
                                        className="mix-textarea"
                                        style={{ minHeight: 56 }}
                                        value={example.text}
                                        onChange={(e) => setExamples((prev) => prev.map((item, idx) => (
                                            idx === i ? { ...item, text: e.target.value } : item
                                        )))}
                                        placeholder={example.role === "user" ? "What the player might say" : "How the character answers"}
                                    />
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setExamples((prev) => prev.filter((_, idx) => idx !== i))}
                                        aria-label="Delete this exchange"
                                    >
                                        <Trash2 size={15} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                className="mix-pill-btn"
                                onClick={() => setExamples((prev) => [
                                    ...prev,
                                    { role: prev.length && prev[prev.length - 1].role === "user" ? "char" : "user", text: "" },
                                ])}
                            >
                                <Plus size={13} style={{ verticalAlign: "-2px" }} /> Add an exchange
                            </button>
                        </div>
                    </Field>
                    <Field label="Opening canvas" hint="optional, HTML. Laid over the cover scrim when the card is opened; never enters the prompt">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 170 }}
                            value={canvas}
                            onChange={(e) => setCanvas(e.target.value)}
                            placeholder={"This card's front page: a big title, a line of verse, tags, a note to the reader -- the layout is yours.\n\ne.g.\n<div style=\"padding:28px 6px;color:#fff;font:14px/2 serif\">\n  <h1 style=\"font-size:34px;letter-spacing:.3em\">Yan Chi</h1>\n  <p style=\"opacity:.65\">corner shop, night shift</p>\n  <p style=\"margin-top:22px\">「Working this late again?」</p>\n</div>"}
                        />
                    </Field>
                    <MixPreviewInline
                        label="Preview canvas"
                        target={{ kind: "canvas", html: canvas, cover }}
                        disabled={!canvas.trim()}
                    />
                </>
            ) : null}
            {kind === "persona" ? (
                <>
                    <Field label="Your name" hint="optional. The character will call you this; left empty it falls back to the default">
                        <input className="mix-input" value={personaUserName} onChange={(e) => setPersonaUserName(e.target.value)} placeholder="e.g. Ash" />
                    </Field>
                    <Field label="User persona" hint="required. {{char}} / {{user}} may be used">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 170 }}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder={"e.g.\n{{user}}: 22, an illustration student, lodging with an old friend of the family.\n- Outwardly compliant, quietly saving up the nerve to leave.\n- Afraid of thunder; clenches their left hand when lying."}
                        />
                    </Field>
                </>
            ) : null}
            {kind === "base" || kind === "flavor" || kind === "glass" || kind === "strength" ? (
                <Field label={TEXT_FIELD_COPY[kind].label} hint="required. {{char}} / {{user}} may be used">
                    <textarea
                        className="mix-textarea"
                        style={{ minHeight: 170 }}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={TEXT_FIELD_COPY[kind].placeholder}
                    />
                </Field>
            ) : null}
            {kind === "ticket" ? (
                <>
                    <Field label="Output contract" hint="required. Tells the AI which data to report each turn, and in what format">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 130 }}
                            value={contract}
                            onChange={(e) => setContract(e.target.value)}
                            placeholder={"e.g.\nAt the end of every turn report these three lines, one field each:\naffection: an integer from 0-100\nmood: three words at most\nthinking: one sentence"}
                        />
                    </Field>
                    <Field label="Render code" hint="required. HTML+CSS+JS that draws the text above into a card">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 180 }}
                            value={renderHtml}
                            onChange={(e) => setRenderHtml(e.target.value)}
                            placeholder={"Insert what the AI reported with {{RAW}}, or read window.TICKET_RAW from JS.\n\ne.g.\n<div style=\"padding:12px;border-radius:10px;background:#1c1c26;color:#d9b06a\">\n  <pre>{{RAW}}</pre>\n</div>"}
                        />
                    </Field>
                    <Field label="Preview sample data" hint="make something up, just to try the rendering">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            value={previewRaw}
                            onChange={(e) => setPreviewRaw(e.target.value)}
                            placeholder={"Make one up following the contract above. e.g.\naffection: 62\nmood: stubborn\nthinking: wants you to stay a while longer"}
                        />
                    </Field>
                    <Field label="Items to remember" hint="Remembered values persist across the session and can drive a material's 'when it applies'. If one cannot be read, the previous turn's value stands">
                        {contractFieldNames.length ? (
                            <div className="mix-var-suggest">
                                <span>Found in the contract:</span>
                                {contractFieldNames.map((name) => {
                                    const added = vars.some((v) => v.name.trim() === name);
                                    return (
                                        <button
                                            type="button"
                                            className="mix-var-chip"
                                            data-on={added ? "true" : undefined}
                                            key={name}
                                            onClick={() => setVars((prev) => (added
                                                ? prev.filter((v) => v.name.trim() !== name)
                                                : [...prev, { name }]))}
                                        >
                                            {name}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                        {vars.length ? (
                            <div className="mix-var-list">
                                {vars.map((item, index) => (
                                    <div className="mix-var-row" key={index}>
                                        <input
                                            className="mix-input"
                                            value={item.name}
                                            placeholder="Item name (spelled as in the contract)"
                                            onChange={(e) => setVars((prev) => prev.map((v, i) => (i === index ? { ...v, name: e.target.value } : v)))}
                                        />
                                        <input
                                            className="mix-input mix-var-initial"
                                            value={item.initial ?? ""}
                                            placeholder="Starting value"
                                            onChange={(e) => setVars((prev) => prev.map((v, i) => (i === index ? { ...v, initial: e.target.value } : v)))}
                                        />
                                        <button
                                            type="button"
                                            className="mix-icon-btn"
                                            onClick={() => setVars((prev) => prev.filter((_, i) => i !== index))}
                                            aria-label="Delete"
                                        >
                                            <Trash2 size={15} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="mix-var-empty">Nothing to remember yet -- tap a field from the contract above, or add one by hand.</div>
                        )}
                        <button type="button" className="mix-stack-add" onClick={() => setVars((prev) => [...prev, { name: "" }])}>
                            <Plus size={15} /> Add one by hand
                        </button>
                    </Field>
                    <MixPreviewInline
                        label="Preview receipt"
                        target={{ kind: "ticket", html: renderHtml, raw: previewRaw }}
                        disabled={!renderHtml.trim()}
                    />
                </>
            ) : null}
            {kind === "mechanism" ? (
                <>
                    <Field label="Hook logic" hint="may be left empty. Define the functions below and they are called at the matching moments; ctx.store is the same bucket the panel below uses">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 200 }}
                            value={script}
                            onChange={(e) => setScript(e.target.value)}
                            placeholder={"Each function receives a ctx and returns an object (return nothing to change nothing).\nctx: { turnCount, state, store, charName, userName, text, ticketRaw, encoreRaw }\nmay return: { text, note, state, store }\n\ne.g. turn a player typing \"/roll\" into an instruction carrying the result\nfunction onBeforeSend(ctx) {\n  if (ctx.text !== \"/roll\") return;\n  var n = 1 + Math.floor(Math.random() * 20);\n  return { text: \"(I rolled a \" + n + \")\" };\n}\n\ne.g. count how many turns running affection has gone up\nfunction onAfterReply(ctx) {\n  var up = Number(ctx.store.streak || 0);\n  return { store: { streak: String(up + 1) } };\n}"}
                        />
                    </Field>
                    <Field label="Interface code" hint="HTML + CSS + JS, run inside the sandbox. Where it is drawn, how big, and whether the app draws any shell are all written here with window.mix">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 160 }}
                            value={panelHtml}
                            onChange={(e) => setPanelHtml(e.target.value)}
                            placeholder={"<div style=\"padding:10px\">This is the persistent panel</div>\n\nwindow.mix\n  move(x, y) / size(w, h)         move and resize yourself (percentages of the session screen)\n  design(px)                      the width to lay out against, scaled to the panel afterwards; 0 = follow the panel\n  fit(px)                         report how tall the content is\n  chrome(on) / plate(on)          whether the app draws its title bar / backing plate, both off by default\n  drag(on) / resize(on)           whether the player may drag or resize it\n  z(n)                            stacking order 0-9\n  grab()                          call on pointerdown on your own title bar, and the app takes the drag from there\n  setStore(obj) / setState(obj)   write storage / write remembered values\n  say(text)                       say something as the player\nwindow.MIX_STATE / window.MIX_STORE  the current values\nwindow.onMixSync(state, store)       called back when the values change"}
                        />
                    </Field>
                    <MixPreviewInline
                        label="Try it on"
                        target={{
                            kind: "mechanism",
                            name,
                            html: panelHtml,
                            layout: mixPanelLayoutOf({ layout: keptLayout, dock: keptDock, panelHtml }) ?? MIX_PANEL_DEFAULT_LAYOUT,
                            script,
                        }}
                        disabled={!panelHtml.trim() && !script.trim()}
                    />
                    <div className="mix-struct-note" style={{ marginTop: 10 }}>
                        Hooks run in a sandbox with no network and no reach into the app itself, and are cut off on timeout -- that turn then proceeds as if there were no mechanism.
                        The storage belongs to this mechanism alone, one bucket per session, still there after leaving and coming back. Hooks and panel share that one bucket,
                        so &quot;the panel notes something down, and the next send carries it into the prompt&quot; works without any wiring.
                    </div>
                </>
            ) : null}
            {kind === "garnish" ? (
                <>
                    <Field label="Interface CSS" hint="required. Tap Try it on below for the full class-name reference">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 190 }}
                            value={css}
                            onChange={(e) => setCss(e.target.value)}
                            placeholder={"e.g.\n.mix-dialogue { color: #ffd479; font-weight: 600 }\n.mix-thought  { color: #8d7bf5 }\n.mix-scene    { letter-spacing: .5em }"}
                        />
                    </Field>
                    <MixPreviewInline
                        label="Try it on"
                        target={{ kind: "garnish", css }}
                        disabled={!css.trim()}
                    />
                </>
            ) : null}
            {kind === "encore" ? (
                <>
                    <Field label="Output contract" hint="optional. Only with a contract will the AI produce a skit during a session; left empty it is a static sketch">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 110 }}
                            value={encoreContract}
                            onChange={(e) => setEncoreContract(e.target.value)}
                            placeholder={"Tell the AI when to write one and what goes in it. e.g.\nOnly when the plot clearly moves or the mood turns: write a skit of at most 60 words from an onlooker's viewpoint (an assistant, a camera, a social post), naming that viewpoint on the first line. Omit the section entirely on uneventful turns."}
                        />
                    </Field>
                    <Field label="Render code" hint="required. HTML/JS; the AI's output arrives through {{RAW}} or window.ENCORE_RAW, and a static sketch simply displays">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 180 }}
                            value={html}
                            onChange={(e) => setHtml(e.target.value)}
                            placeholder={"e.g.\n<div style=\"padding:14px;background:#14111c;border-radius:10px;color:#f2f0f7\">\n  <pre style=\"margin:0;white-space:pre-wrap\">{{RAW}}</pre>\n</div>"}
                        />
                    </Field>
                    <Field label="Preview sample data" hint="optional. Mimic an AI skit to try the rendering">
                        <textarea className="mix-textarea" data-code="true" value={encorePreviewRaw} onChange={(e) => setEncorePreviewRaw(e.target.value)} />
                    </Field>
                    <MixPreviewInline
                        label="Run it"
                        target={{ kind: "encore", html, raw: encorePreviewRaw }}
                        disabled={!html.trim()}
                    />
                </>
            ) : null}
            {kind === "filter" ? (
                <>
                    <Field label="Cleanup rules" hint="Applied top to bottom. Search is a JS regex (the g flag is added for you); the replacement may use $1 for a capture group, and an empty one deletes">
                        <div className="mix-example-list">
                            {rules.map((rule, i) => (
                                <div className="mix-filter-rule" key={i} data-bad={filterTest.badIndexes.includes(i) ? "true" : undefined}>
                                    <div className="mix-filter-rule-main">
                                        <input
                                            className="mix-input"
                                            data-code="true"
                                            value={rule.find}
                                            onChange={(e) => setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, find: e.target.value } : r)))}
                                            placeholder="Search (regex), e.g. \\*\\*|--+"
                                        />
                                        <input
                                            className="mix-input"
                                            data-code="true"
                                            value={rule.replace}
                                            onChange={(e) => setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, replace: e.target.value } : r)))}
                                            placeholder="Replace with (empty = delete)"
                                        />
                                        {filterTest.badIndexes.includes(i) ? <div className="mix-filter-rule-bad">Malformed regex -- this rule will not apply</div> : null}
                                    </div>
                                    <button
                                        type="button"
                                        className="mix-filter-mode"
                                        data-mode={rule.mode}
                                        onClick={() => setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, mode: r.mode === "display" ? "context" : "display" } : r)))}
                                        title="Display only: the original is stored and swapped at render time, so it applies across the whole history at once. Enters context: cleaned before storing, so the history sent back to the model is clean too, but only new replies are affected"
                                    >
                                        {rule.mode === "display" ? "Display only" : "Enters context"}
                                    </button>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setRules((prev) => prev.filter((_, idx) => idx !== i))}
                                        aria-label="Delete this rule"
                                    >
                                        <Trash2 size={15} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                className="mix-pill-btn"
                                onClick={() => setRules((prev) => [...prev, { find: "", replace: "", mode: "display" }])}
                            >
                                <Plus size={13} style={{ verticalAlign: "-2px" }} /> Add a rule
                            </button>
                        </div>
                    </Field>
                    <Field label="Test run" hint="Paste a sample and see the result of every rule at once">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 90 }}
                            value={filterSample}
                            onChange={(e) => setFilterSample(e.target.value)}
                            placeholder={"e.g.\n**He paused**--「Mm... working late again?」"}
                        />
                        {filterSample ? (
                            <div className="mix-filter-result">{filterTest.result || "(everything was removed)"}</div>
                        ) : null}
                    </Field>
                </>
            ) : null}
            {structureOpen ? <MixStructureSheet highlight={kind} onClose={() => setStructureOpen(false)} /> : null}
            {error ? <div style={{ color: "#e2a3a3", fontSize: 12, marginTop: 12 }}>{error}</div> : null}
            <div className="mix-form-footer">
                <button type="button" className="mix-ghost-btn" onClick={onCancel}>Cancel</button>
                <button type="button" className="mix-brew-btn" onClick={handleSave}>Save to cabinet</button>
            </div>
        </div>
    );
}
