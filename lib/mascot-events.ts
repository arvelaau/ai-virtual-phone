// lib/mascot-events.ts
// Unified event bus for mascot ↔ app communication.

import { setMascotContext, type MascotPageContext } from "./mascot-context";

// ── Page → Mascot: context changed ──
export function notifyMascotPageContext(ctx: MascotPageContext) {
  setMascotContext(ctx);
  window.dispatchEvent(new CustomEvent("mascot-page-context", { detail: ctx }));
}

// ── Mascot → Page: fill a field ──
export function mascotFillField(data: { field: string; value: string; _batchId?: string }) {
  window.dispatchEvent(new CustomEvent("mascot-fill-field", { detail: data }));
}

// ── Mascot → Shell: navigate ──
export function mascotNavigate(app: string, mode?: string) {
  window.dispatchEvent(new CustomEvent("mascot-navigate", { detail: { app, mode } }));
}
