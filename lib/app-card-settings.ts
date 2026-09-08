// lib/app-card-settings.ts
// Shared reads for the one global directive-card (chat/story/offline HTML card) setting left on
// ChatAppSettings: whether a card renders before or after the message's main text ("position").
//
// Which SURFACES a card can appear on ("scope") is deliberately NOT a global setting -- it is
// authored per-card, alongside the card itself (Studio's own scope picker, or a third-party app
// manifest's directive.scope), and read via custom-app-chat-directives.ts's
// directiveMatchesScope(). A global on/off toggle here would contradict that: the whole point of
// per-design scope is that one card can be "story only" while another is "everywhere", which a
// single app-wide switch cannot express. See CLAUDE.md's "App card position + scope settings"
// entry for how this file looked before that correction.

import { loadChatAppSettings, type ChatAppSettings } from "./chat-storage";

/**
 * Pure decision half of appCardRendersBeforeText(), taking settings as a parameter instead of
 * reading storage. loadChatAppSettings()/saveChatAppSettings() both no-op under
 * `typeof window === "undefined"` (plain Node, e.g. a fixture script), which would make the
 * storage-backed wrapper below untestable and silently always return the defaults -- exactly
 * the "vacuous control" shape this project has hit repeatedly (see CLAUDE.md's
 * selectBorrowableMemories / formatMascotUserIdentityRule entries). Split so a fixture can
 * construct a ChatAppSettings object directly and drive the real decision.
 */
export function appCardPositionBeforeTextFor(settings: ChatAppSettings): boolean {
    return settings.appCardPositionBeforeText === true;
}

/** Whether a directive card should render before the message's main text (default: after). */
export function appCardRendersBeforeText(): boolean {
    return appCardPositionBeforeTextFor(loadChatAppSettings());
}
