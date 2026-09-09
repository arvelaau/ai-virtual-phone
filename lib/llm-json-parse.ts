import { jsonrepair } from "jsonrepair";

/**
 * Extracted from `lib/interview-magazine-engine.ts`'s original `parseJsonLike` so a second
 * consumer (the review app) doesn't duplicate it. Strips `<think>` blocks and code fences,
 * narrows to the outermost `{...}` span, then tries a plain parse before falling back to
 * `jsonrepair`. Returns `null` on total failure -- callers should supply hand-written fallback
 * content rather than surfacing a raw parse error.
 *
 * Not a replacement for `lib/checkphone-json-repair.ts`, which is a separate, richer API
 * (diagnostic parse-mode info, typography normalization) tightly coupled to checkphone's own
 * callers -- left untouched.
 */
export function parseJsonLike<T>(raw: string): T | null {
  const source = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1")
    .trim();
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? source.slice(first, last + 1) : source;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(candidate)) as T;
    } catch {
      return null;
    }
  }
}
