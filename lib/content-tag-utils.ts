import type { Prompt } from "./settings-types";
import { CONTENT_APP_LABELS } from "./settings-types";
import {
    CHECKPHONE_TAG_PROFILES,
    getCheckPhonePromptSecondaryTagLabel,
} from "./checkphone-config";

// Every label in this file is display text for the Preset / Regex "Scope" column and the
// custom-app tag pickers. Nothing is ever compared against these strings — scope matching
// runs on the `tags` arrays via areTagsEqual/getTagProfileId — so they are safe to reword.
// The Chinese entries in LEGACY_TAG_MIGRATIONS further down are TAGS, not labels: leave them.
const EXTRA_TAG_LABELS: Record<string, string> = {
    adventure: "Adventure",
    add_friend: "Add Friend",
    dwelling: "Dwelling",
    offline: "Offline",
    followup: "Follow-up",
    timed_wake: "Timed check-in",
    period_care: "Period care",
    text: "Text",
    voice: "Voice",
    video: "Video",
    post: "Post",
    generate: "Generate",
    comment: "Comment",
    reply: "Reply",
    npc: "NPC interaction",
    npc_reply: "NPC reply",
    layout: "Layout",
    full: "Full",
    items: "Items",
    entries: "Diary entries",
    explore: "Explore",
    annotate: "Annotate",
    discuss: "Discuss",
    activity: "Character browsing",
    reaction: "User post reactions",
    mention: "@mention replies",
    manifest: "Manifest",
    notes: "Notes",
    notewall: "Note wall",
    notewall_reply: "Note wall replies",
    interview_magazine: "Interview",
    cocreate: "Co-Create",
    action: "Actions",
    tool: "Tools",
    host: "Host",
    answer: "Character answers",
    article: "Published issue",
    archive: "Close chapter",
    write: "Draft writing",
};

export type TagProfile = {
    id: string;
    label: string;
    tags: string[];
};

export type TagMinorProfile = TagProfile;

export type TagGroupProfile = {
    id: string;
    label: string;
    tags: string[];
    minors: TagMinorProfile[];
};

const commonMinor = (majorId: string, tags: string[]): TagMinorProfile => ({
    id: `${majorId}_common`,
    label: "General",
    tags,
});

const profile = (majorId: string, minorId: string, minorLabel: string, tags: string[]): TagMinorProfile => ({
    id: `${majorId}_${minorId}`,
    label: minorLabel,
    tags,
});

export const CONTENT_SCOPE_TAG_GROUPS: TagGroupProfile[] = [
    {
        id: "universal",
        label: "General",
        tags: [],
        minors: [{ id: "universal_common", label: "General", tags: [] }],
    },
    {
        id: "chat",
        label: "Chat",
        tags: ["chat"],
        minors: [
            commonMinor("chat", ["chat"]),
            profile("chat", "text", "Text", ["chat", "text"]),
            profile("chat", "voice", "Voice", ["chat", "voice"]),
            profile("chat", "video", "Video", ["chat", "video"]),
            profile("chat", "offline", "Offline", ["chat", "offline"]),
            profile("chat", "followup", "Follow-up", ["chat", "followup"]),
            profile("chat", "timed_wake", "Timed check-in", ["chat", "timed_wake"]),
            profile("chat", "period_care", "Period care", ["chat", "period_care"]),
        ],
    },
    {
        id: "moments",
        label: "Moments",
        tags: ["moments"],
        minors: [
            commonMinor("moments", ["moments"]),
            profile("moments", "post", "Post", ["moments", "post"]),
            profile("moments", "comment", "Comment", ["moments", "comment"]),
            profile("moments", "reply", "Reply", ["moments", "reply"]),
            profile("moments", "npc", "NPC interaction", ["moments", "npc"]),
            profile("moments", "npc_reply", "NPC reply", ["moments", "npc_reply"]),
        ],
    },
    {
        id: "group_chat",
        label: "Group Chat",
        tags: ["group_chat"],
        minors: [
            commonMinor("group_chat", ["group_chat"]),
            profile("group_chat", "text", "Text", ["group_chat", "text"]),
            profile("group_chat", "offline", "Offline", ["group_chat", "offline"]),
        ],
    },
    {
        id: "diary",
        label: "Journal",
        tags: ["diary"],
        minors: [
            commonMinor("diary", ["diary"]),
            profile("diary", "entries", "Diary entries", ["diary", "entries"]),
            profile("diary", "notewall", "Note wall", ["diary", "notewall"]),
            profile("diary", "notewall_reply", "Note wall replies", ["diary", "notewall_reply"]),
        ],
    },
    {
        id: "xiaohongshu",
        label: "Xiaohongshu",
        tags: ["xiaohongshu"],
        minors: [
            commonMinor("xiaohongshu", ["xiaohongshu"]),
            profile("xiaohongshu", "activity", "Character browsing", ["xiaohongshu", "activity"]),
            profile("xiaohongshu", "reaction", "User post reactions", ["xiaohongshu", "reaction"]),
            profile("xiaohongshu", "comment", "Comment replies", ["xiaohongshu", "comment"]),
            profile("xiaohongshu", "mention", "@mention replies", ["xiaohongshu", "mention"]),
        ],
    },
    { id: "story", label: "Story", tags: ["story"], minors: [commonMinor("story", ["story"])] },
    { id: "vn", label: "Visual Novel", tags: ["vn"], minors: [commonMinor("vn", ["vn"])] },
    { id: "calendar", label: "Calendar", tags: ["calendar"], minors: [commonMinor("calendar", ["calendar"])] },
    { id: "adventure", label: "Adventure", tags: ["adventure"], minors: [commonMinor("adventure", ["adventure"])] },
    { id: "game", label: "Games", tags: ["game"], minors: [commonMinor("game", ["game"])] },
    { id: "add_friend", label: "Add Friend", tags: ["add_friend"], minors: [commonMinor("add_friend", ["add_friend"])] },
    {
        id: "checkphone",
        label: "CheckPhone",
        tags: ["checkphone"],
        minors: CHECKPHONE_TAG_PROFILES.map((item) => ({
            id: item.id,
            label: item.tags.length > 1 ? resolveContentTagLabel(item.tags[1]) : "General",
            tags: item.tags,
        })),
    },
    {
        id: "dwelling",
        label: "Dwelling",
        tags: ["dwelling"],
        minors: [
            commonMinor("dwelling", ["dwelling"]),
            profile("dwelling", "full", "Full layout", ["dwelling", "full"]),
            profile("dwelling", "items", "Item layout", ["dwelling", "items"]),
            profile("dwelling", "explore", "Explore", ["dwelling", "explore"]),
        ],
    },
    {
        id: "reading",
        label: "Reading",
        tags: ["reading"],
        minors: [
            commonMinor("reading", ["reading"]),
            profile("reading", "annotate", "Annotate", ["reading", "annotate"]),
            profile("reading", "discuss", "Discuss", ["reading", "discuss"]),
        ],
    },
    {
        id: "interview_magazine",
        label: "Interview",
        tags: ["interview_magazine"],
        minors: [
            commonMinor("interview_magazine", ["interview_magazine"]),
            profile("interview_magazine", "answer", "Character answers", ["interview_magazine", "answer"]),
            profile("interview_magazine", "article", "Published issue", ["interview_magazine", "article"]),
        ],
    },
    {
        id: "cocreate",
        label: "Co-Create",
        tags: ["cocreate"],
        minors: [
            commonMinor("cocreate", ["cocreate"]),
            profile("cocreate", "write", "Draft writing", ["cocreate", "write"]),
            profile("cocreate", "discuss", "Discuss", ["cocreate", "discuss"]),
            profile("cocreate", "action", "Executable actions", ["cocreate", "action"]),
        ],
    },
];

export const CONTENT_SCOPE_TAG_PROFILES: TagProfile[] = [
    ...CONTENT_SCOPE_TAG_GROUPS.flatMap((group) => group.minors.map((minor) => ({
        id: minor.id,
        label: minor.tags.length === 0 ? "General (all features)" : `${group.label}${minor.tags.length > 1 ? ` · ${minor.label}` : ""}`,
        tags: minor.tags,
    }))),
];

const LEGACY_TAG_MIGRATIONS = new Map<string, string[]>([
    [JSON.stringify(["chat", "chat-text"]), ["chat", "text"]],
    [JSON.stringify(["chat", "chat-voice"]), ["chat", "voice"]],
    [JSON.stringify(["chat", "chat-video"]), ["chat", "video"]],
    [JSON.stringify(["moments_npc"]), ["moments", "npc"]],
    [JSON.stringify(["朋友圈", "NPC回复"]), ["moments", "npc_reply"]],
    [JSON.stringify(["diary", "entries_generate"]), ["diary", "entries"]],
    [JSON.stringify(["diary", "notewall_generate"]), ["diary", "notewall"]],
    [JSON.stringify(["xiaohongshu", "character_activity"]), ["xiaohongshu", "activity"]],
    [JSON.stringify(["xiaohongshu", "user_post_reaction"]), ["xiaohongshu", "reaction"]],
    [JSON.stringify(["xiaohongshu", "comment_reply"]), ["xiaohongshu", "comment"]],
    [JSON.stringify(["xiaohongshu", "mention_reply"]), ["xiaohongshu", "mention"]],
    [JSON.stringify(["dwelling", "layout_full"]), ["dwelling", "full"]],
    [JSON.stringify(["dwelling", "layout_items"]), ["dwelling", "items"]],
    [JSON.stringify(["interview_magazine", "character_answer"]), ["interview_magazine", "answer"]],
]);

export function normalizePromptScopeTags(tags: unknown): string[] | undefined {
    const normalized = normalizeTags(tags);
    if (!normalized) return undefined;
    const migrated = LEGACY_TAG_MIGRATIONS.get(JSON.stringify(normalized));
    return migrated ? [...migrated] : normalized;
}

export function normalizeTags(tags: unknown): string[] | undefined {
    if (!Array.isArray(tags)) return undefined;
    const normalized = Array.from(
        new Set(
            tags
                .map((tag) => String(tag).trim())
                .filter(Boolean),
        ),
    );
    return normalized.length > 0 ? normalized : undefined;
}

export function areTagsEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

export function resolveContentTagLabel(tag: string): string {
    return EXTRA_TAG_LABELS[tag]
        ?? getCheckPhonePromptSecondaryTagLabel(tag)
        ?? CONTENT_APP_LABELS[tag as keyof typeof CONTENT_APP_LABELS]
        ?? tag;
}

export function getPromptTags(prompt: Pick<Prompt, "tags" | "featureTag" | "followUpOnly">): string[] {
    const normalizedTags = normalizePromptScopeTags(prompt.tags);
    if (normalizedTags) return normalizedTags;
    const tags: string[] = [];
    if (prompt.featureTag) tags.push(prompt.featureTag);
    if (prompt.followUpOnly) tags.push("followup");
    return tags;
}

export function getTagProfileId(tags: string[], profiles: TagProfile[] = CONTENT_SCOPE_TAG_PROFILES): string {
    const matched = profiles.find((profile) => areTagsEqual(profile.tags, tags));
    return matched?.id ?? "__custom__";
}

export function getTagsLabel(tags: string[], profiles: TagProfile[] = CONTENT_SCOPE_TAG_PROFILES): string {
    if (tags.length === 0) return "General";
    const matched = profiles.find((profile) => areTagsEqual(profile.tags, tags));
    if (matched) return matched.label;
    return tags.map((tag) => resolveContentTagLabel(tag)).join(" · ");
}

export function matchesActiveTags(requiredTags: string[] | null | undefined, activeTags: string[]): boolean {
    if (!requiredTags || requiredTags.length === 0) return true;
    return requiredTags.every((tag) => activeTags.includes(tag));
}

export function filterTagScopedItems<T extends { tags?: string[] }>(items: T[], activeTags: string[]): T[] {
    return items.filter((item) => matchesActiveTags(item.tags, activeTags));
}

export function getActiveAppTags(
    appId: string,
    options?: { appTags?: string[]; followUpCount?: number },
): string[] {
    if (options?.appTags) return [...options.appTags];
    return [appId, ...((options?.followUpCount ?? 0) > 0 ? ["followup"] : [])];
}
