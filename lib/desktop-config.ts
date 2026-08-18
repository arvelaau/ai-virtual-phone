import type { CustomAppIconId } from "@/lib/custom-app-types";

export type IconId =
  | "chat"
  | "diary"
  | "music"
  | "reading"
  | "cocreate"
  | "story"
  | "game"
  | "appmarket"
  | "xiaohongshu"
  | "dwelling"
  | "checkphone"
  | "shopping"
  | "calendar"
  | "couplespace"
  | "interview_magazine"
  | "vnmode"
  | "mapmode"
  | "vnplay"
  | "vnchapters"
  | "moments"
  | "group_chat"
  | "settings"
  | "theme"
  | "resources"
  | "characters"
  | "worldbuilder"
  | "mixology";

export type DesktopIconId = IconId | CustomAppIconId;

export type IconPosition = { id: DesktopIconId; row: number; col: number };

export type IconMeta = {
  id: IconId;
  label: string;
  tone: string;
  placeholder: boolean;
  path?: string;
};

export const PAGE_1_DEFAULT: IconId[] = ["chat", "diary", "music", "calendar", "checkphone", "shopping", "reading", "interview_magazine"];

export const PAGE_2_DEFAULT: IconId[] = [
  "cocreate",
  "game",
  "appmarket",
  "xiaohongshu",
  "dwelling",
  "couplespace",
  "story",
  "vnmode",
  "mapmode"
];

// Default icons for page three (centred; see createDefaultDesktopIconLayout for placement)
export const PAGE_3_DEFAULT: IconId[] = ["worldbuilder", "mixology"];

export const DOCK_DEFAULT: IconId[] = ["settings", "theme", "resources", "characters"];

export const ICONS: Record<IconId, IconMeta> = {
  chat: { id: "chat", label: "Chat", tone: "var(--c-icon-green)", placeholder: false },
  mixology: { id: "mixology", label: "House Special", tone: "var(--c-icon-violet)", placeholder: false },
  couplespace: { id: "couplespace", label: "Couple Space", tone: "var(--c-icon-rose, #d98f9b)", placeholder: false },
  diary: { id: "diary", label: "Notes", tone: "var(--c-icon-violet)", placeholder: false },
  music: { id: "music", label: "Music", tone: "var(--c-icon-coral)", placeholder: false },
  reading: { id: "reading", label: "Reading", tone: "var(--c-icon-amber)", placeholder: false },
  cocreate: { id: "cocreate", label: "Co-Create", tone: "var(--c-icon-cocreate, #c8b58a)", placeholder: false },
  story: { id: "story", label: "Story", tone: "var(--c-icon-story, #8b6f52)", placeholder: false },
  game: { id: "game", label: "Games", tone: "var(--c-icon-blue)", placeholder: false },
  appmarket: { id: "appmarket", label: "App Market", tone: "var(--c-icon-teal)", placeholder: false },
  xiaohongshu: {
    id: "xiaohongshu",
    label: "Xiaohongshu",
    tone: "var(--c-icon-rose)",
    placeholder: false
  },
  checkphone: { id: "checkphone", label: "Check Phone", tone: "var(--c-icon-slate)", placeholder: false },
  dwelling: {
    id: "dwelling",
    label: "Dwelling",
    tone: "var(--c-icon-rose)",
    placeholder: false
  },
  shopping: { id: "shopping", label: "Shopping", tone: "var(--c-icon-amber)", placeholder: false },
  calendar: { id: "calendar", label: "Calendar", tone: "var(--c-icon-rose)", placeholder: true },
  interview_magazine: { id: "interview_magazine", label: "Presence", tone: "var(--c-icon-lilac)", placeholder: false },
  vnmode: { id: "vnmode", label: "VN Mode", tone: "var(--c-icon-rose)", placeholder: false },
  mapmode: { id: "mapmode", label: "Adventure", tone: "var(--c-icon-amber)", placeholder: false },
  vnplay: { id: "vnplay", label: "VN Player", tone: "var(--c-icon-rose)", placeholder: true },
  vnchapters: { id: "vnchapters", label: "Chapters", tone: "var(--c-icon-rose)", placeholder: true },
  moments: { id: "moments", label: "Moments", tone: "var(--c-icon-lilac)", placeholder: false },
  group_chat: { id: "group_chat", label: "Group Chat", tone: "var(--c-icon-teal)", placeholder: false },
  settings: { id: "settings", label: "Settings", tone: "var(--c-icon-slate)", placeholder: false },
  theme: { id: "theme", label: "Themes", tone: "var(--c-icon-violet)", placeholder: true },
  resources: { id: "resources", label: "Resources", tone: "var(--c-icon-teal)", placeholder: false },
  characters: {
    id: "characters",
    label: "Characters",
    tone: "var(--c-icon-lilac)",
    placeholder: false,
    path: "/characters"
  },
  worldbuilder: {
    id: "worldbuilder",
    label: "World Builder",
    tone: "var(--c-icon-amber)",
    placeholder: false,
    path: "/world-builder"
  },
};
