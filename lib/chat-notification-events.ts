export const CHAT_MESSAGE_NOTICE_EVENT = "ai-chat-message-notice";
export const CHAT_OPEN_SESSION_EVENT = "ai-chat-open-session";

export type ChatMessageNoticeDetail = {
  sessionId: string;
  body: string;
  senderName?: string;
  avatar?: string | null;
  isGroup?: boolean;
  /** Sound-settings "test" popup: fires the banner even while that session is already open */
  isTest?: boolean;
};

export function dispatchChatMessageNotice(detail: ChatMessageNoticeDetail): void {
  if (typeof window === "undefined") return;
  const body = detail.body.trim();
  if (!detail.sessionId || !body) return;
  window.dispatchEvent(new CustomEvent(CHAT_MESSAGE_NOTICE_EVENT, {
    detail: { ...detail, body },
  }));
}

// Opens the Contacts tab's "Add Friend" page pre-loaded with a character's profile (tap-to-add from a contact card)
export const CHAT_OPEN_ADD_CONTACT_EVENT = "ai-chat-open-add-contact";

export function dispatchOpenAddContact(characterId: string): void {
  if (typeof window === "undefined" || !characterId) return;
  window.dispatchEvent(new CustomEvent(CHAT_OPEN_ADD_CONTACT_EVENT, { detail: { characterId } }));
}
