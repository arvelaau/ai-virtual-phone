export type WidgetType =
  | "music"
  | "calendar"
  | "clock"
  | "photo"
  | "loveNote"
  | "interviewMagazine"
  | "kaomoji"
  | "mascot"
  | "kawaiiMusicPlayer"
  | "iosMenu"
  | "mySpace"
  | "socialPost"
  | "coupleChat"
  | "moodPill"
  | "vinylRecord"
  | "receiptTask"
  | "ticketStub"
  | "postCard"
  | (string & {});

export type DIYTemplateSlot = {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type DIYWidgetTemplate = {
  id: string; // e.g., "diy-17012345"
  name: string;
  size: WidgetSize;
  mode: "image" | "code";
  bgAssetId?: string; // IndexedDB ID for PNG
  slots?: DIYTemplateSlot[];
  htmlString?: string;
};

export type WidgetSize =
  | "1x1"
  | "1x2"
  | "1x4"
  | "2x1"
  | "2x2"
  | "2x3"
  | "2x4"
  | "3x2"
  | "3x3"
  | "3x4"
  | "4x2"
  | "4x3"
  | "4x4"
  | "5x4"
  | "6x4";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  size: WidgetSize;
  page: number;
  row: number; // 1-based grid row
  col: number; // 1-based grid column
  config?: Record<string, unknown>;
};

export type WidgetCatalogEntry = {
  type: WidgetType;
  name: string;
  desc: string;
  size: WidgetSize;
  /** Whether the widget uses standard global rendering (glass, shadows) or handles its own physical shape entirely */
  track?: "freestyle";
};

/** How many grid cells a widget size occupies: [rows, cols] */
export const WIDGET_SIZE_CELLS: Record<WidgetSize, [number, number]> = {
  "1x1": [1, 1],
  "1x2": [1, 2],
  "2x1": [2, 1],
  "2x2": [2, 2],
  "1x4": [1, 4],
  "2x3": [2, 3],
  "3x2": [3, 2],
  "3x3": [3, 3],
  "2x4": [2, 4],
  "3x4": [3, 4],
  "4x2": [4, 2],
  "4x3": [4, 3],
  "4x4": [4, 4],
  "5x4": [5, 4],
  "6x4": [6, 4],
};

export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
  // 2×4 wide
  { type: "music", name: "Music Player", desc: "Cover art + track name + playback controls", size: "2x4" },
  { type: "interviewMagazine", name: "Presence Excerpt", desc: "Photo + flip-through card of this issue's interview excerpt", size: "2x4" },
  // 2×2
  { type: "calendar", name: "Calendar", desc: "Month view with today highlighted", size: "2x2" },
  { type: "clock", name: "Clock + Date", desc: "Large time readout + date and weekday", size: "2x2" },
  { type: "photo", name: "Photo Frame", desc: "Holds one photo; tap to swap it", size: "2x2" },
  { type: "loveNote", name: "Sweet Note", desc: "A random line of sweet talk", size: "2x2" },
  { type: "mascot", name: "Mascot", desc: "Your AI desk companion — tap to summon", size: "2x2" },
  // 🌸 Kawaii Aesthetic Series
  { type: "kawaiiMusicPlayer", name: "Kawaii Music Player", desc: "Music player in a soft-light style", size: "2x4" },
  { type: "mySpace", name: "My Space Card", desc: "Minimal all-white profile page", size: "3x4" },
  { type: "socialPost", name: "Micro-Space Post", desc: "Floating large-format image social post", size: "4x4" },
  { type: "largeTime", name: "Jumbo Digital Clock", desc: "Large-format digital time and date text", size: "2x4" },
  // 🍏 iOS System Mimicry
  { type: "iosMenu", name: "iOS Action Menu", desc: "Recreates the native iOS highlighted action sheet", size: "1x4" },
  // 💬 Message & Chat
  { type: "coupleChat", name: "Whispers", desc: "Mock two-person bubble chat with an animated heart waveform", size: "2x4" },
  { type: "moodPill", name: "Floating Mood Pill", desc: "Minimal floating text label with emoji trim", size: "1x4" },
  // 🪪 Objects & Badges
  { type: "vinylRecord", name: "Vinyl Record", desc: "A spinning, minimal vinyl music ornament", size: "2x2" },
  // 🎨 Freestyle & Analog Designs (Custom physics rendering)
  { type: "receiptTask", name: "Freestyle - Receipt", desc: "A bare receipt with torn, serrated edges", size: "3x2", track: "freestyle" },
  { type: "ticketStub", name: "Freestyle - Ticket Stub", desc: "Irregular die-cut, punched ticket stub", size: "2x4", track: "freestyle" },
  { type: "postCard", name: "Freestyle - Y2K Card", desc: "A completely free-form art display frame", size: "2x4", track: "freestyle" },
  { type: "cameraFrame", name: "Freestyle - Camera Viewfinder", desc: "Transparent photo viewport with a UI frame", size: "4x3", track: "freestyle" },
  { type: "colorPickerFrame", name: "Freestyle - Colour Picker Frame", desc: "Minimal white-dial colour picker, transparent frame", size: "2x2", track: "freestyle" },
  { type: "freestyleFrame18", name: "Freestyle - Grey Bubble", desc: "Horizontal chat-bubble sticker", size: "2x4", track: "freestyle" },
  { type: "freestyleFrame4", name: "Freestyle - Wide Frame", desc: "Wide 2x4 photo frame", size: "2x4", track: "freestyle" },
  { type: "freestyleFrame31", name: "Freestyle - Slider Frame", desc: "Square frame with a side scroll bar", size: "2x2", track: "freestyle" },
  { type: "freestyleFrame33", name: "Freestyle - Tall Frame", desc: "Large 3x4 portrait frame", size: "3x4", track: "freestyle" },
  { type: "freestyleFrame36", name: "Freestyle - Tape Strip", desc: "A plain horizontal divider strip", size: "1x4", track: "freestyle" },
  { type: "freestyleFrame49", name: "Freestyle - Square Frame", desc: "Standard 2x2 photo frame", size: "2x2", track: "freestyle" },
  { type: "freestyleFrame54", name: "Freestyle - Avatar Name Tag", desc: "1x4 name tag with an avatar column on the right", size: "1x4", track: "freestyle" },
  { type: "freestyleFrame68", name: "Freestyle - Weather Watch", desc: "2x4 frame with a weather-style layout", size: "2x4", track: "freestyle" },
  { type: "freestyleFrame72", name: "Freestyle - Photo Quad", desc: "4x4 frame holding four swappable photos", size: "4x4", track: "freestyle" },
  { type: "freestyleFrame88", name: "Freestyle - Music Cassette", desc: "2x3 frame with an album spindle cut-out", size: "2x3", track: "freestyle" },
  { type: "freestyleFrame90", name: "Freestyle - Personal Space", desc: "2x4 profile card with swappable photos", size: "2x4", track: "freestyle" },
];

export const GRID_ROWS = 6;
export const GRID_COLS = 4;
