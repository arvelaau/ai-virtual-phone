// lib/mixology/engine.ts
// House Special -- the session runtime: start, pour (generate a reply), redo, continue.
//
// A blend does NOT go through the chat preset / regex pipeline: it carries its whole prompt
// itself, and the prose protocol is handled by the app's own parser.
// The API comes from the global default binding, unrelated to any character binding -- a
// House Special session is its own world.

import { ChatEngineError, sendLLMRequest, sendLLMStreamRequest } from "../chat-engine";
import type { LLMMessage } from "../llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig } from "../settings-storage";
import type { ApiConfig } from "../settings-types";
import { applyMixMacros, assembleMixPrompt, MIX_DEFAULT_USER_NAME, MIX_ENCORE_CLOSE, MIX_ENCORE_OPEN, MIX_TICKET_CLOSE, MIX_TICKET_OPEN, type MixAssembledPrompt } from "./assembler";
import { applyMixFilterRules, extractMixBlocks } from "./prose";
import {
    getMixMaterial,
    getMixSession,
    resolveMixRecipeMaterials,
    saveMixSession,
} from "./storage";
import {
    createMixId,
    MIX_SLOT_ORDER,
    MIX_SLOT_STACK,
    mixKindAllowsCondition,
    mixSlotFirstId,
    type MixCharacterCard,
    type MixMaterial,
    type MixMechanismMaterial,
    type MixState,
    type MixMaterialKind,
    type MixRecipe,
    type MixSession,
    type MixTicketMaterial,
    type MixTurn,
} from "./types";
import {
    advanceMixState,
    buildMixConditionContext,
    initialMixState,
    pickActiveMixMaterials,
    rollbackMixState,
} from "./state";
import { mergeHookState, type MixHook, type MixHookPayload } from "./mechanism-protocol";
import { disposeMixSandboxes, runMixHook } from "./mechanism-runtime";

export const MIX_PROMPT_APP_ID = "mixology";
const MIX_PROMPT_TAGS = ["mixology"];

/** The API config a session uses: the global default binding */
export function resolveMixApiConfig(): ApiConfig | null {
    const binding = loadBindingConfig();
    const configs = loadApiConfigs();
    const id = binding.globalDefaults.apiConfigId;
    if (id) {
        const found = configs.find((c) => c.id === id);
        if (found) return found;
    }
    return configs[0] ?? null;
}

/** Assemble the prompt from the blend snapshot. Materials are fetched from the cabinet by
 *  id at call time; a deleted character card is an error. */
function assembleFromSession(session: MixSession): {
    prompt: MixAssembledPrompt;
    ticket?: MixTicketMaterial;
    active: Partial<Record<MixMaterialKind, MixMaterial[]>>;
} {
    const { entries } = resolveMixRecipeMaterials(session.recipe);
    const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
    const character = active.character?.[0];
    if (!character || character.kind !== "character") {
        throw new ChatEngineError("This blend's character card is no longer in the cabinet, so the session cannot continue.");
    }
    const prompt = assembleMixPrompt({
        character: character as MixCharacterCard,
        materials: active,
        userName: session.userName,
        openingIndex: session.openingIndex,
        state: session.state,
    });
    const ticketMat = active.ticket?.[0];
    const ticket = ticketMat?.kind === "ticket" ? (ticketMat as MixTicketMaterial) : undefined;
    return { prompt, ticket, active };
}

/**
 * Reconstruct a message's "raw output": on an assistant turn, put the stripped status-panel
 * and skit blocks back.
 * Shared by history replay and "edit raw output", so what you see when editing is exactly
 * what the model originally wrote.
 */
export function mixTurnRawText(turn: MixTurn): string {
    if (turn.role !== "assistant") return turn.text;
    // The order matches the output requirements -- status panel before the prose, skit after.
    // History replay is what demonstrates the model's own output habits back to it.
    const parts = [];
    if (turn.ticketRaw) parts.push(`${MIX_TICKET_OPEN}\n${turn.ticketRaw}\n${MIX_TICKET_CLOSE}`);
    parts.push(turn.text);
    if (turn.encoreRaw) parts.push(`${MIX_ENCORE_OPEN}\n${turn.encoreRaw}\n${MIX_ENCORE_CLOSE}`);
    return parts.filter(Boolean).join("\n\n");
}

/** Put the status-panel and skit blocks back on assistant messages during history replay, so
 *  the model can see the habits it established earlier */
function turnToHistoryContent(turn: MixTurn): string {
    return mixTurnRawText(turn);
}

function buildMixMessages(
    session: MixSession,
    assembled: MixAssembledPrompt,
    extraUserNudge?: string,
): LLMMessage[] {
    const messages: LLMMessage[] = [
        { role: "system", content: assembled.system, _debugMeta: { marker: "mixology_system" } },
    ];
    for (const turn of session.turns) {
        messages.push({
            role: turn.role,
            content: turnToHistoryContent(turn),
            _debugMeta: { marker: "mixology_history", _fromHistory: true },
        });
    }
    if (assembled.postHistory) {
        messages.push({
            role: "system",
            content: assembled.postHistory,
            _debugMeta: { marker: "mixology_strength" },
        });
    }
    if (extraUserNudge) {
        messages.push({
            role: "user",
            content: extraUserNudge,
            _debugMeta: { marker: "mixology_nudge" },
        });
    }
    return messages;
}

/** Start a session from the blend snapshot, with the opening line as the first assistant message */
export function startMixSession(
    recipe: MixRecipe,
    options?: { openingIndex?: number; userName?: string },
): MixSession {
    const characterId = mixSlotFirstId(recipe.slots, "character");
    const card = characterId ? getMixMaterial(characterId) : null;
    if (!card || card.kind !== "character") {
        throw new ChatEngineError("This blend has no character card, so there is nothing to pour.");
    }
    // The name to step into: explicitly passed > the mask's own name. Same rule as the
    // assembler; snapshotted onto the session here for the interface to use.
    const personaId = mixSlotFirstId(recipe.slots, "persona");
    const personaMat = personaId ? getMixMaterial(personaId) : null;
    const personaUserName = personaMat?.kind === "persona" ? personaMat.userName?.trim() : undefined;
    const openingIndex = options?.openingIndex ?? 0;
    // Starting values for the remembered state: the receipt items that declared an initial
    const ticketId = mixSlotFirstId(recipe.slots, "ticket");
    const ticketMat = ticketId ? getMixMaterial(ticketId) : null;
    const session: MixSession = {
        id: createMixId("mixsess"),
        recipe: { ...recipe, slots: { ...recipe.slots } },
        charName: card.charName.trim() || card.name,
        userName: options?.userName?.trim() || personaUserName || undefined,
        openingIndex,
        turns: [],
        state: initialMixState(ticketMat?.kind === "ticket" ? ticketMat : undefined),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const assembled = assembleFromSession(session).prompt;
    if (assembled.opening) {
        session.turns.push({
            id: createMixId("mixturn"),
            role: "assistant",
            text: assembled.opening,
            createdAt: Date.now(),
        });
    }
    saveMixSession(session);
    return session;
}

/**
 * The session-start hook: run once after the session exists, so a mechanism can initialise
 * its own storage and remembered values.
 * Deliberately NOT folded into startMixSession, which is synchronous because the interface
 * relies on it to navigate to the session immediately. The hook is async, so it runs in the
 * background and writes afterwards. A failure here never blocks the session from starting.
 */
export async function runMixSessionStart(sessionId: string): Promise<void> {
    const session = getMixSession(sessionId);
    if (!session) return;
    const result = await runMechanismHooks(session, "sessionStart", {});
    const latest = getMixSession(sessionId);
    if (!latest) return;
    const nextState = mergeHookState(latest.state ?? {}, result.state);
    const changed = JSON.stringify(nextState) !== JSON.stringify(latest.state ?? {})
        || JSON.stringify(result.store) !== JSON.stringify(latest.mechanismStore ?? {});
    if (!changed) return;
    saveMixSession({ ...latest, state: nextState, mechanismStore: result.store });
}

/**
 * The teardown hook: run once when leaving a session, and tear down that session's sandboxes
 * on the way out.
 * Only the storage and remembered values from its return are honoured -- rewriting prose at
 * this point would be pointless.
 */
export async function runMixSessionEnd(sessionId: string): Promise<void> {
    const session = getMixSession(sessionId);
    if (session) {
        try {
            const result = await runMechanismHooks(session, "sessionEnd", {});
            const latest = getMixSession(sessionId);
            if (latest) {
                saveMixSession({
                    ...latest,
                    state: mergeHookState(latest.state ?? {}, result.state),
                    mechanismStore: result.store,
                });
            }
        } catch {
            // A failed teardown does not matter; the sandboxes come down either way
        }
    }
    disposeMixSandboxes(sessionId);
}

export type MixReplyResult = {
    session: MixSession;
    turn: MixTurn;
};

/**
 * Status-panel repair. Plenty of models (DeepSeek measurably so) drop the status-panel block
 * from the end of a reply during long roleplay, and no amount of prompt wording fixes it
 * reliably. When the block is missing, ask for it back with one small separate request.
 * The repaired block then becomes precedent through history replay, and the rate at which
 * later turns produce it unprompted goes up noticeably.
 */
async function repairMixTicket(
    apiConfig: ApiConfig,
    session: MixSession,
    ticket: MixTicketMaterial,
    proseText: string,
    signal?: AbortSignal,
): Promise<string | undefined> {
    const charName = session.charName;
    const userName = session.userName || MIX_DEFAULT_USER_NAME;
    const contract = applyMixMacros(ticket.contract.trim(), charName, userName);
    if (!contract) return undefined;
    const lastUser = [...session.turns].reverse().find((t) => t.role === "user")?.text ?? "";
    const messages: LLMMessage[] = [
        {
            role: "system",
            content: [
                `You are filling in the status panel for a roleplay session; the character is ${charName}. Using this turn's prose, fill in this turn's actual data line by line as "Output contents" requires. Output only the status panel block itself and nothing else.`,
                "Output contents:",
                contract,
                `Output format: ${MIX_TICKET_OPEN} on the first line, then one line per item, and ${MIX_TICKET_CLOSE} on the last line.`,
            ].join("\n"),
            _debugMeta: { marker: "mixology_ticket_repair" },
        },
        {
            role: "user",
            content: `${lastUser ? `What ${userName} said this turn:\n${lastUser}\n\n` : ""}${charName}'s prose this turn:\n${proseText}`,
        },
    ];
    try {
        const raw = await sendLLMRequest(
            apiConfig,
            null,
            messages,
            [],
            { characterName: charName, userName },
            { appId: MIX_PROMPT_APP_ID, appTags: MIX_PROMPT_TAGS, skipOutputRegex: true, signal },
        );
        const { ticketRaw } = extractMixBlocks(raw);
        if (ticketRaw) return ticketRaw;
        // Some models return the data with no wrapper at all: with no tag anywhere and a
        // sensible length, take it as-is
        const bare = raw.trim();
        if (bare && !/[\[\]【】]/.test(bare) && bare.length < 1200) return bare;
    } catch {
        // A failed repair never blocks the main reply -- at worst this turn has no status panel
    }
    return undefined;
}

/**
 * Run one round of mechanism hooks. The mechanism slot stacks: every material whose condition
 * held runs in order, and text the previous one rewrote is handed to the next (the same mental
 * model as layering flavors).
 * An error, a timeout or garbage back from one mechanism only means that one had no effect --
 * it never affects the other mechanisms and never affects this turn's generation.
 */
async function runMechanismHooks(
    session: MixSession,
    hook: MixHook,
    input: { text?: string; ticketRaw?: string; encoreRaw?: string },
): Promise<{ text?: string; notes: string[]; state: MixState; store: Record<string, Record<string, string>> }> {
    const { entries } = resolveMixRecipeMaterials(session.recipe);
    const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
    const mechanisms = (active.mechanism ?? []).filter((m): m is MixMechanismMaterial => m.kind === "mechanism");
    const store = { ...(session.mechanismStore ?? {}) };
    const out = { text: input.text, notes: [] as string[], state: {} as MixState, store };
    if (!mechanisms.length) return out;
    for (const material of mechanisms) {
        const script = material.script?.trim();
        if (!script) continue;
        const payload: MixHookPayload = {
            hook,
            turnCount: session.turns.length,
            // The state passed in is the current values plus whatever earlier mechanisms just
            // wrote, so within one turn a later mechanism sees the earlier one's work
            state: { ...(session.state ?? {}), ...out.state },
            store: store[material.id] ?? {},
            charName: session.charName,
            userName: session.userName || MIX_DEFAULT_USER_NAME,
            text: out.text,
            ticketRaw: input.ticketRaw,
            encoreRaw: input.encoreRaw,
        };
        const result = await runMixHook(session.id, material.id, script, hook, payload);
        if (typeof result.text === "string") out.text = result.text;
        if (result.note) out.notes.push(result.note);
        if (result.state) out.state = mergeHookState(out.state, result.state);
        if (result.store) store[material.id] = result.store;
    }
    return out;
}

/** Before pouring: a mechanism's chance to rewrite the player's line or append a temporary hint */
async function runBeforeSendHooks(session: MixSession, text?: string): Promise<{ session: MixSession; text?: string; note?: string }> {
    const result = await runMechanismHooks(session, "beforeSend", { text });
    const next: MixSession = {
        ...session,
        state: mergeHookState(session.state ?? {}, result.state),
        mechanismStore: result.store,
    };
    return { session: next, text: result.text, note: result.notes.join("\n") || undefined };
}

/**
 * One generation. Passing onDelta switches it to streaming: the model reports a piece at a
 * time and the interface can write as it goes.
 * Streaming only changes HOW THE WAIT LOOKS. Storing, block splitting, the strainer and the
 * mechanism hooks all still run on the COMPLETE prose -- half a status-panel block or a
 * half-written marker line must never be treated as a result.
 */
async function runMixGeneration(
    session: MixSession,
    nudge: string | undefined,
    signal?: AbortSignal,
    skipBeforeSend = false,
    onDelta?: (text: string) => void,
): Promise<MixReplyResult> {
    const apiConfig = resolveMixApiConfig();
    if (!apiConfig) {
        throw new ChatEngineError("No API endpoint is configured yet. Add one in Settings first.");
    }
    // Before pouring: this covers the continue / redo / regenerate-after-edit paths. The
    // player-speaks path lives in generateMixReply instead, because the rewrite has to happen
    // before the line is stored. These paths have no new line, so a mechanism can only append
    // a temporary hint.
    let working = session;
    let extraNote: string | undefined;
    if (!skipBeforeSend) {
        const before = await runBeforeSendHooks(session);
        working = before.session;
        extraNote = before.note;
        if (working !== session) saveMixSession(working);
    }
    const combinedNudge = [nudge, extraNote].filter(Boolean).join("\n\n") || undefined;
    const { prompt: assembled, ticket, active } = assembleFromSession(working);
    const messages = buildMixMessages(working, assembled, combinedNudge);
    const meta = { characterName: working.charName, userName: working.userName || MIX_DEFAULT_USER_NAME };
    const llmOptions = { appId: MIX_PROMPT_APP_ID, appTags: MIX_PROMPT_TAGS, skipOutputRegex: true, signal };
    let raw: string;
    if (onDelta) {
        let got = false;
        try {
            const streamed = await sendLLMStreamRequest(apiConfig, null, messages, [], meta, llmOptions, {
                onDelta: (chunk) => { got = true; onDelta(chunk); },
            });
            raw = streamed.content;
        } catch (error) {
            // Nothing arrived at all before it failed: most likely this endpoint does not support
            // SSE, or a proxy in the middle took it apart. Retry once as an ordinary request.
            // If characters HAD already arrived, the failure is real -- rethrow it.
            if (got || (error instanceof Error && signal?.aborted)) throw error;
            raw = await sendLLMRequest(apiConfig, null, messages, [], meta, llmOptions);
        }
    } else {
        raw = await sendLLMRequest(apiConfig, null, messages, [], meta, llmOptions);
    }
    const extracted = extractMixBlocks(raw);
    const { encoreRaw } = extracted;
    let { ticketRaw } = extracted;
    // Strainer "enters the context" mode: clean the prose after the blocks are split out and
    // before storing, so the history sent back to the model is the cleaned text.
    // This slot stacks, so every strainer whose condition held cleans in turn.
    const filterRules = (active.filter ?? [])
        .flatMap((m) => (m.kind === "filter" ? m.rules : []));
    const text = applyMixFilterRules(extracted.text, filterRules.length ? filterRules : undefined, "context");
    if (!text && !ticketRaw) {
        throw new ChatEngineError("The model returned nothing. Please try again.");
    }
    if (assembled.hasTicket && !ticketRaw && ticket && text) {
        ticketRaw = await repairMixTicket(apiConfig, working, ticket, text, signal);
    }
    // Remembered values: updated from this turn's receipt text, keeping the previous value for
    // anything that could not be found. The result is also snapshotted onto this turn, so a
    // rewind / redo / edit can restore from the last remaining turn's snapshot directly.
    const stateFromTicket = advanceMixState(working.state, ticket, ticketRaw);
    // After pouring: a mechanism can rewrite the prose and write remembered values. It runs
    // after the receipt has been read, because the mechanism is the last word -- what it writes
    // outranks what the receipt produced.
    const afterHook = await runMechanismHooks(
        { ...working, state: stateFromTicket },
        "afterReply",
        { text, ticketRaw, encoreRaw },
    );
    const finalText = typeof afterHook.text === "string" ? afterHook.text : text;
    const nextState = mergeHookState(stateFromTicket, afterHook.state);
    const turn: MixTurn = {
        id: createMixId("mixturn"),
        role: "assistant",
        text: finalText,
        ticketRaw: assembled.hasTicket ? ticketRaw : undefined,
        encoreRaw: assembled.hasEncore ? encoreRaw : undefined,
        state: nextState,
        createdAt: Date.now(),
    };
    const updated: MixSession = {
        ...working,
        turns: [...working.turns, turn],
        state: nextState,
        mechanismStore: afterHook.store,
    };
    saveMixSession(updated);
    return { session: updated, turn };
}

/** Player speaks -> generate a reply */
export async function generateMixReply(
    sessionId: string,
    userText: string,
    signal?: AbortSignal,
    onUserTurn?: () => void,
    onDelta?: (text: string) => void,
): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("That session does not exist.");
    const trimmed = userText.trim();
    if (!trimmed) throw new ChatEngineError("Say something first.");
    // The before-pouring hook runs before the line is stored, because what a mechanism rewrites
    // is the player's line itself (turning "/roll" into an instruction carrying a random number,
    // say), and the rewritten version is what gets stored.
    const before = await runBeforeSendHooks(current, trimmed);
    const spoken = (before.text ?? trimmed).trim() || trimmed;
    const userTurn: MixTurn = {
        id: createMixId("mixturn"),
        role: "user",
        text: spoken,
        createdAt: Date.now(),
    };
    const withUser: MixSession = { ...before.session, turns: [...before.session.turns, userTurn] };
    saveMixSession(withUser);
    // The before-pouring hook is awaited, so this store lands a tick LATER than the caller's
    // synchronous read-back. Announce it, or the user's bubble waits for the model to return.
    onUserTurn?.();
    // This path has already run its before-pouring hook; do not fire it again in runMixGeneration
    return runMixGeneration(withUser, before.note, signal, true, onDelta);
}

/** This session's receipt material, which is where remembered values are declared. With several
 *  stacked in the slot, the first wins. */
function sessionTicket(session: MixSession): MixTicketMaterial | undefined {
    const ticketId = mixSlotFirstId(session.recipe.slots, "ticket");
    const found = ticketId ? getMixMaterial(ticketId) : null;
    return found?.kind === "ticket" ? found : undefined;
}

/**
 * Roll the remembered values back after truncating history: take the last remaining turn's
 * snapshot, or the session's starting values if everything was removed.
 * Without this, rewinding three turns and replaying them leaves affection stuck at the future
 * that was thrown away.
 */
function withRolledBackState(session: MixSession, turns: MixTurn[]): MixSession {
    const initial = initialMixState(sessionTicket(session));
    return { ...session, turns, state: rollbackMixState(turns, initial) };
}

/** Redo: throw away the last assistant reply and generate again (never the opening line) */
export async function rerollMixReply(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("That session does not exist.");
    const last = current.turns[current.turns.length - 1];
    if (!last || last.role !== "assistant" || current.turns.length <= 1) {
        throw new ChatEngineError("There is no reply to redo right now.");
    }
    const trimmedSession = withRolledBackState(current, current.turns.slice(0, -1));
    saveMixSession(trimmedSession);
    const beforeLast = trimmedSession.turns[trimmedSession.turns.length - 1];
    // The message before is also an assistant one (produced by Continue), so add an unstored
    // nudge to avoid two assistant messages in a row
    const nudge = beforeLast?.role === "assistant"
        ? "(Continue from the above and move the story on, but write it differently -- do not repeat yourself.)"
        : undefined;
    return runMixGeneration(trimmedSession, nudge, signal, false, onDelta);
}

/** Continue: say nothing and let the character write on (the nudge is never stored) */
export async function continueMix(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("That session does not exist.");
    return runMixGeneration(current, "(Continue straight on from the above and move the story forward; do not repeat anything already written.)", signal, false, onDelta);
}

/**
 * A session nobody has spoken in yet: re-read the opening line from the current character card
 * on the way in.
 *
 * The opening is a message written into turns[0] at the moment the session was created, not a
 * reference to the material -- so an author who edits the card and comes back to the session
 * still sees the old line. This only re-reads when the player has not said a single word yet:
 * a session that has been played is never touched, because that is real history, and changing
 * it would put the interface out of step with the context sent to the model.
 *
 * Returns whether it actually changed, so the caller can decide whether to say so.
 */
export function refreshMixOpening(sessionId: string): { session: MixSession; changed: boolean } | null {
    const current = getMixSession(sessionId);
    if (!current) return null;
    const onlyOpening = current.turns.length === 1 && current.turns[0].role === "assistant";
    if (!onlyOpening) return { session: current, changed: false };
    let fresh: string;
    try {
        fresh = assembleFromSession(current).prompt.opening;
    } catch {
        // The card was deleted or similar: keep the existing line rather than losing the opening
        return { session: current, changed: false };
    }
    if (!fresh.trim() || fresh === current.turns[0].text) return { session: current, changed: false };
    const updated: MixSession = {
        ...current,
        turns: [{ ...current.turns[0], text: fresh }],
        updatedAt: Date.now(),
    };
    saveMixSession(updated);
    return { session: updated, changed: true };
}

/** Rewind to a message: keep it and delete everything after it */
export function truncateMixAfterTurn(sessionId: string, turnId: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("That session does not exist.");
    const idx = current.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) throw new ChatEngineError("That message does not exist.");
    const updated = withRolledBackState(current, current.turns.slice(0, idx + 1));
    saveMixSession(updated);
    return updated;
}

/**
 * Edit a message and delete everything after it.
 * On an assistant turn what is edited is the "raw output", blocks included, and saving re-splits
 * and re-parses it -- so a reply the model emitted in the wrong format can be fixed by hand and
 * re-rendered. A player's line stays plain text.
 * When a player's line is edited, the caller should follow up with regenerateMixTail.
 */
export function editMixTurn(sessionId: string, turnId: string, newText: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("That session does not exist.");
    const idx = current.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) throw new ChatEngineError("That message does not exist.");
    const trimmed = newText.trim();
    if (!trimmed) throw new ChatEngineError("A message cannot be empty.");
    const kept = current.turns.slice(0, idx);
    let edited: MixTurn;
    if (current.turns[idx].role === "assistant") {
        const { text, ticketRaw, encoreRaw } = extractMixBlocks(trimmed);
        // The status panel was edited by hand, so this turn's snapshot has to be recomputed from
        // the new raw text or the numbers will not match what is on screen
        const before = withRolledBackState(current, kept).state;
        edited = {
            ...current.turns[idx],
            text,
            ticketRaw,
            encoreRaw,
            state: advanceMixState(before, sessionTicket(current), ticketRaw),
        };
    } else {
        edited = { ...current.turns[idx], text: trimmed };
    }
    const updated = withRolledBackState(current, [...kept, edited]);
    saveMixSession(updated);
    return updated;
}

/** Generate a reply against the current history (the regenerate after editing a player line) */
export async function regenerateMixTail(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("That session does not exist.");
    return runMixGeneration(current, undefined, signal, false, onDelta);
}

/** Take back the last turn: delete the last player line and every reply after it */
export function undoMixLastRound(sessionId: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("That session does not exist.");
    let lastUserIdx = -1;
    for (let i = current.turns.length - 1; i >= 0; i -= 1) {
        if (current.turns[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) throw new ChatEngineError("There is nothing to take back yet.");
    const updated = withRolledBackState(current, current.turns.slice(0, lastUserIdx));
    saveMixSession(updated);
    return updated;
}
