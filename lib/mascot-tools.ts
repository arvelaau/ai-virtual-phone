// lib/mascot-tools.ts
// Scroll's tool system: 7 packs + 43 fine-grained tools, on a dual text/native protocol.
//
// Pack design (only the loader is exposed by default; a pack expands on demand):
//   - Character Card Pack  (character_pack) — 3 sub-tools
//   - World Book Pack      (worldbook_pack) — 5 sub-tools
//   - Preset Pack          (preset_pack)    — 9 sub-tools
//   - Regex Pack           (regex_pack)     — 5 sub-tools
//   - CSS Styling Pack     (css_pack)       — 3 sub-tools
//   - Image Pack           (image_pack)     — 10 sub-tools
//   - Desktop Widget Pack  (widget_pack)    — 7 sub-tools
//   - Navigation           (navigate)       — 1 standalone tool, always exposed

import type { LlmToolDefinition } from "./llm-provider-adapter";
import type { ToolCall, ToolResult } from "./tool-executor";
import type { MascotPageContext } from "./mascot-context";
import type { Prompt } from "./settings-types";
import { CHARACTER_CARD_PROMPT, WORLDBOOK_PROMPT, PRESET_PROMPT, GENERAL_PRESET_PROMPT, REGEX_PROMPT, CSS_PROMPT, WIDGET_PROMPT } from "./mascot-prompts";
import {
    buildCssAssetNineSliceCss,
    calibrateCssAssetNineSlice,
    convertCssAsset,
    createCssAssetFromGeneratedImage,
    cropCssAsset,
    importUserImageAsCssAsset,
    listOrReadCssAssets,
    listUserUploadedImages,
    removeCssAssetBackground,
    uploadCssAssetToImageHost,
    type CssAssetUserImageHistoryMessage,
} from "./css-asset-tools";

// ── Shared types ────────────────────────────────────────

export type MascotSubTool = {
    name: string;
    description: string;
    parameterSchema: Record<string, unknown>;
};

export type MascotToolPackage = {
    id: string;
    label: string;
    /**
     * The pre-translation Chinese label. The model types the label in
     * `[FetchTool:<label>]`, so findPackageByLabel keeps accepting the old name
     * forever — the mascot's saved history is full of them.
     */
    legacyLabel?: string;
    description: string;
    subTools: MascotSubTool[];
    usageGuide?: string; // extra writing guide surfaced when the pack is expanded, under the text protocol
};

// ── Tool parameter schemas ──────────────────────────────

// ── CSS tools ──
const CSS_LOCATION_ENUM = ["chat_app", "chat_session", "mascot_chat", "story", "music", "calendar"];

const SESSION_NAME_DESC = "(only used when location=chat_session or story) The session name. For a chat room, give the character name, remark name or group name; for a story session, the character name or title. If omitted, the session currently open on the page is used; when the page has no session open, the tool returns a list of sessions for you to confirm. Not needed for mascot_chat.";

const READ_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "The CSS location. If omitted, returns a status overview of every location" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    additionalProperties: false,
};

const OVERWRITE_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "The CSS location" },
        css: { type: "string", description: "The complete new CSS, which replaces all CSS at that location" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    required: ["location", "css"],
    additionalProperties: false,
};

const CLEAR_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "The CSS location" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    required: ["location"],
    additionalProperties: false,
};

// ── Image tools ──
const IMAGE_ASSET_KIND_ENUM = ["bubble", "icon", "texture", "background", "misc"];

const GENERATE_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        description: { type: "string", description: "A description of the image asset to generate. An asset destined for CSS should state its purpose, colours and rough proportions. For bubbles and icons, do NOT ask for a transparent background; ask for a plain solid white background, no checkerboard, no sample text or watermark, and margin around the subject — then knock the white out afterwards with 去底透明. For a nine-slice bubble, keep the important decoration near the corners or the tail, and away from the top-centre, bottom-centre, left-middle, right-middle and the central stretch area." },
        kind: { type: "string", enum: IMAGE_ASSET_KIND_ENUM, description: "Asset kind: bubble = chat bubble, icon, texture, background, misc = anything else" },
        label: { type: "string", description: "A name for the asset, so it is easy to read, crop or upload later" },
        characterId: { type: "string", description: "Optional: the character id, when using that character's reference image" },
        useReferenceImage: { type: "boolean", description: "Whether to use the character's reference image. If unsure, do not pass true" },
    },
    required: ["description"],
    additionalProperties: false,
};

const LIST_USER_IMAGES_SCHEMA = {
    type: "object",
    properties: {
        limit: { type: "number", description: "How many recent user images to return at most. Default 12, maximum 20" },
    },
    additionalProperties: false,
};

const IMPORT_USER_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        sourceImageId: { type: "string", description: "The user image id, obtained from 列出用户图片. If omitted, user_image_1 is imported" },
        messageOffset: { type: "number", description: "Optional: which image-bearing user message, 0 being the most recent. Ignored when sourceImageId is given" },
        imageIndex: { type: "number", description: "Optional: which image within that message, 0 being the first. Ignored when sourceImageId is given" },
        kind: { type: "string", enum: IMAGE_ASSET_KIND_ENUM, description: "Asset kind: bubble = chat bubble, icon, texture, background, misc = anything else" },
        label: { type: "string", description: "The asset name to use after import" },
    },
    additionalProperties: false,
};

const CROP_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "The asset id, taken from the result of 生成图像素材 or 列出读取素材" },
        cropMode: { type: "string", enum: ["coordinates", "auto_trim"], description: "coordinates = crop by coordinates; auto_trim = automatically trim transparent or near-flat edges" },
        unit: { type: "string", enum: ["pixel", "percent"], description: "Coordinate unit, default pixel. percent means 0-100" },
        x: { type: "number", description: "Top-left x of the crop box; used in coordinates mode" },
        y: { type: "number", description: "Top-left y of the crop box; used in coordinates mode" },
        width: { type: "number", description: "Width of the crop box; used in coordinates mode" },
        height: { type: "number", description: "Height of the crop box; used in coordinates mode" },
        padding: { type: "number", description: "Extra margin to keep around the crop, in pixels. 2-12 is typical for auto_trim" },
        tolerance: { type: "number", description: "Edge tolerance for auto_trim, 0-255. Default 18; raise it when the background edge is not clean" },
        outputWidth: { type: "number", description: "Optional output width. Defaults to the cropped width" },
        outputHeight: { type: "number", description: "Optional output height. Defaults to the cropped height" },
        label: { type: "string", description: "A name for the new asset" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const REMOVE_IMAGE_BACKGROUND_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "The asset id" },
        tolerance: { type: "number", description: "Background tolerance, 0-255. Default 36 for a white or light grey ground; raise to 45-70 if a white fringe remains" },
        feather: { type: "number", description: "Edge feather radius, 0-4. Default 2, to soften jagged white fringing" },
        backgroundColor: { type: "string", description: "Optional: the background colour to remove, e.g. #ffffff. If omitted, the average of the four corners is used" },
        format: { type: "string", enum: ["png", "webp"], description: "Output format. Default png, which keeps transparency" },
        label: { type: "string", description: "A name for the new asset" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const CONVERT_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "The asset id" },
        format: { type: "string", enum: ["webp", "png", "jpeg"], description: "Output format. Prefer webp for CSS assets" },
        quality: { type: "number", description: "Image quality, 0.1-1. Applies to webp and jpeg; default 0.82" },
        maxWidth: { type: "number", description: "Maximum width. If omitted the image is neither enlarged nor shrunk" },
        maxHeight: { type: "number", description: "Maximum height. If omitted the image is neither enlarged nor shrunk" },
        label: { type: "string", description: "A name for the new asset" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const NINE_SLICE_CSS_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "The asset id. If the asset has already been uploaded to the image host, its publicUrl is used automatically" },
        url: { type: "string", description: "Optional: pass an image URL directly. When url is given, assetId may be omitted" },
        selector: { type: "string", description: "The CSS selector to apply the nine-slice to. Default .chat-bubble-role-assistant; the user's bubble is usually .chat-bubble-role-user" },
        sliceTop: { type: "number", description: "Top slice in pixels. Must come from 校准九宫格" },
        sliceRight: { type: "number", description: "Right slice in pixels. Must come from 校准九宫格" },
        sliceBottom: { type: "number", description: "Bottom slice in pixels. Must come from 校准九宫格" },
        sliceLeft: { type: "number", description: "Left slice in pixels. Must come from 校准九宫格" },
        displayTop: { type: "number", description: "The rendered width of the top band in CSS pixels. Must come from 校准九宫格 — it is not the source slice" },
        displayRight: { type: "number", description: "The rendered width of the right band in CSS pixels; typically 12-48" },
        displayBottom: { type: "number", description: "The rendered width of the bottom band in CSS pixels; typically 14-56" },
        displayLeft: { type: "number", description: "The rendered width of the left band in CSS pixels; typically 12-48" },
        paddingTop: { type: "number", description: "Padding between the text and the top edge of the bubble. Independent of the nine-slice protected zone — text may enter it. Must come from 校准九宫格" },
        paddingRight: { type: "number", description: "Padding between the text and the right edge of the bubble. Independent of the nine-slice protected zone — text may enter it. Must come from 校准九宫格" },
        paddingBottom: { type: "number", description: "Padding between the text and the bottom edge of the bubble. Independent of the nine-slice protected zone — text may enter it. Must come from 校准九宫格" },
        paddingLeft: { type: "number", description: "Padding between the text and the left edge of the bubble. Independent of the nine-slice protected zone — text may enter it. Must come from 校准九宫格" },
        minWidth: { type: "number", description: "Minimum width of the left and right protected zones. Pass the value from 校准九宫格 when you have one; it stops the two sides squeezing each other" },
        minHeight: { type: "number", description: "Minimum height of the top and bottom protected zones. Pass the value from 校准九宫格 when you have one; it stops the two sides squeezing each other" },
    },
    required: [
        "sliceTop",
        "sliceRight",
        "sliceBottom",
        "sliceLeft",
        "displayTop",
        "displayRight",
        "displayBottom",
        "displayLeft",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
    ],
    additionalProperties: false,
};

const CALIBRATE_NINE_SLICE_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "The id of the asset whose nine-slice guides are being calibrated" },
        selector: { type: "string", description: "The CSS selector to apply the nine-slice to. Default .chat-bubble-role-assistant; the user's bubble is usually .chat-bubble-role-user" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const READ_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "Optional asset id. If omitted, the 20 most recent assets are listed" },
    },
    additionalProperties: false,
};

const UPLOAD_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "The asset id" },
        filename: { type: "string", description: "Optional upload filename" },
        expirationSeconds: { type: "number", description: "ImgBB expiry in seconds. 0 = never, 60-15552000 = timed expiry. Defaults to the value configured in settings" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

// ── Character tools ──
const READ_CHARACTER_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The character name. If omitted, every character is listed" },
    },
    additionalProperties: false,
};

const CREATE_CHARACTER_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The character's full name" },
        persona: { type: "string", description: "The complete persona (7-section markdown)" },
        personality: { type: "string", description: "A short personality summary (roughly 60-150 words)" },
    },
    required: ["name", "persona", "personality"],
    additionalProperties: false,
};

const UPDATE_CHARACTER_FIELD_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The name of the character to change" },
        field: { type: "string", enum: ["name", "persona", "personality"], description: "The field name" },
        value: { type: "string", description: "The new value" },
    },
    required: ["name", "field", "value"],
    additionalProperties: false,
};

// ── World book tools ──
const LIST_WORLDBOOKS_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The world book name. If omitted, every world book is listed" },
    },
    additionalProperties: false,
};

const READ_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "The world book name" },
        entryComment: { type: "string", description: "The entry's comment, i.e. its remark name" },
    },
    required: ["worldbook", "entryComment"],
    additionalProperties: false,
};

const CREATE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "The world book name. It is created automatically if it does not exist" },
        comment: { type: "string", description: "The entry's remark — the label the user sees" },
        key: { type: "string", description: "Trigger keywords, comma-separated" },
        content: { type: "string", description: "The entry content (wrapping it in XML tags is recommended)" },
        constant: { type: "boolean", description: "Whether the entry is always active (true = injected every time, false = triggered by keyword)" },
        position: { type: "string", enum: ["0", "1"], description: "0 = before the character description, 1 = after it" },
    },
    required: ["worldbook", "comment", "key", "content"],
    additionalProperties: false,
};

const UPDATE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "The world book name" },
        entryUid: { type: "string", description: "The entry uid, taken from a read or list result" },
        field: { type: "string", enum: ["key", "content", "comment", "constant", "position"], description: "The field to update" },
        value: { type: "string", description: "The new value. Use 'true'/'false' for boolean fields and '0'/'1' for position" },
    },
    required: ["worldbook", "entryUid", "field", "value"],
    additionalProperties: false,
};

const DELETE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "The world book name" },
        entryUid: { type: "string", description: "The entry uid" },
    },
    required: ["worldbook", "entryUid"],
    additionalProperties: false,
};

// ── Preset tools ──
const LIST_PRESETS_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

const READ_PRESET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The preset name" },
    },
    required: ["name"],
    additionalProperties: false,
};

const READ_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "The preset id, taken from a read-preset result" },
        promptIndex: { type: "number", description: "The entry index, taken from a read-preset result; 0-based" },
    },
    required: ["presetId", "promptIndex"],
    additionalProperties: false,
};

const DUPLICATE_PRESET_SCHEMA = {
    type: "object",
    properties: {
        sourceName: { type: "string", description: "The name of the preset to copy" },
        newName: { type: "string", description: "The new name for the copy" },
        newDescription: { type: "string", description: "A description for the copy (optional; defaults to the source preset's description)" },
    },
    required: ["sourceName", "newName"],
    additionalProperties: false,
};

const CREATE_STORY_PRESET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The preset name" },
        description: { type: "string", description: "The preset description" },
        prompts: {
            type: "array",
            description: "The prompt list, in block order. Every entry needs at least a name; a marker entry (one starting with ◇) needs only a name; an ordinary entry takes name plus content; an assistant-role entry also takes role:'assistant'",
            items: {
                type: "object",
                properties: {
                    name: { type: "string", description: "The prompt name (one starting with ◇ is treated as a marker)" },
                    role: { type: "string", enum: ["system", "user", "assistant"] },
                    content: { type: "string", description: "The prompt content; a marker needs none" },
                },
                required: ["name"],
            },
        },
    },
    required: ["name", "prompts"],
    additionalProperties: false,
};

const CLONE_BUILTIN_PRESET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The new preset name" },
        description: { type: "string", description: "A description for the new preset (optional; empty by default)" },
    },
    required: ["name"],
    additionalProperties: false,
};

const UPDATE_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "The preset id" },
        promptIndex: { type: "number", description: "The prompt's index in the array; 0-based" },
        field: { type: "string", enum: ["name", "role", "content", "identifier"], description: "The field to update" },
        value: { type: "string", description: "The new value" },
    },
    required: ["presetId", "promptIndex", "field", "value"],
    additionalProperties: false,
};

const ADD_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "The preset id, taken from a read-preset result" },
        name: { type: "string", description: "The prompt name. One starting with ◇ is treated as a marker and its content is cleared" },
        role: { type: "string", enum: ["system", "user", "assistant"], description: "The role; system by default" },
        content: { type: "string", description: "The prompt content; a marker entry may omit it" },
        identifier: { type: "string", description: "An optional identifier. If omitted, one is generated automatically and de-duplicated" },
        insertAfterIndex: { type: "number", description: "Optional: insert after this promptIndex. If omitted, it is appended at the end" },
        enabled: { type: "boolean", description: "Whether it is enabled; true by default" },
        tags: {
            type: "array",
            description: "Optional: the tag array a general preset applies to. If unsure, do not pass it",
            items: { type: "string" },
        },
    },
    required: ["presetId", "name"],
    additionalProperties: false,
};

const UPDATE_PRESET_INFO_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "The preset id" },
        name: { type: "string", description: "A new preset name (optional)" },
        description: { type: "string", description: "A new preset description (optional)" },
    },
    required: ["presetId"],
    additionalProperties: false,
};

// ── Regex tools ──
const LIST_REGEX_GROUPS_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

const READ_REGEX_GROUP_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The regex group name" },
    },
    required: ["name"],
    additionalProperties: false,
};

const REGEX_RULE_OBJ = {
    type: "object",
    properties: {
        scriptName: { type: "string", description: "The rule name" },
        findRegex: { type: "string", description: "The find pattern, in /pattern/flags form" },
        replaceString: { type: "string", description: "The replacement string; $0, $1 and other capture groups are supported" },
        tags: {
            type: "array",
            items: { type: "string", enum: ["chat", "text", "group_chat", "story", "offline"] },
            description: "Required scope, one of four: chat = [\"chat\",\"text\"]; group chat = [\"group_chat\",\"text\"]; story mode = [\"story\"]; offline = [\"offline\"]. Never leave it empty.",
        },
        placement: { type: "array", items: { type: "number" }, description: "[1] = input, [2] = output (the status panel, inner thoughts and state values in chat/group/offline all live here), [5] = world book, [6] = chain of thought / reasoning (only story and visual novel mode fetch one; chat and the rest never do)" },
        disabled: { type: "boolean" },
        markdownOnly: { type: "boolean", description: "Applies at the display layer only; what is stored is unaffected" },
        promptOnly: { type: "boolean", description: "Applies when assembling the prompt only; the display is unaffected" },
        substituteRegex: { type: "string", enum: ["0", "1", "2"], description: "0 = no substitution, 1 = raw substitution, 2 = escaped macro substitution (for things like {{user}})" },
    },
    required: ["scriptName", "findRegex", "replaceString"],
};

const CREATE_REGEX_GROUP_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The regex group name" },
        rules: { type: "array", items: REGEX_RULE_OBJ, description: "The rule list" },
    },
    required: ["name", "rules"],
    additionalProperties: false,
};

const ADD_REGEX_RULE_SCHEMA = {
    type: "object",
    properties: {
        groupName: { type: "string", description: "The regex group name" },
        rule: REGEX_RULE_OBJ,
    },
    required: ["groupName", "rule"],
    additionalProperties: false,
};

const UPDATE_REGEX_RULE_SCHEMA = {
    type: "object",
    properties: {
        groupName: { type: "string", description: "The regex group name" },
        ruleId: { type: "string", description: "The rule id" },
        updates: { ...REGEX_RULE_OBJ, required: [] as string[] },
    },
    required: ["groupName", "ruleId", "updates"],
    additionalProperties: false,
};

// ── Navigation tool ──
const NAVIGATE_SCHEMA = {
    type: "object",
    properties: {
        page: { type: "string", enum: ["chat", "characters", "story", "vnmode", "moments", "calendar", "music", "resources", "settings"], description: "The page name" },
        subpage: { type: "string", enum: ["presets", "worldbook", "regex", "api", "voice", "binding", "data", "identity"], description: "The sub-page; only meaningful under settings" },
    },
    required: ["page"],
    additionalProperties: false,
};

const IMAGE_ASSET_USAGE_GUIDE = [
    "The Image Pack makes reusable assets for CSS themes. Recommended workflow:",
    "1. Start with 生成图像素材 to get an asset id and a preview. For bubbles and icons the generation prompt must say plain solid white background / no checkerboard background / no sample text / no watermark / subject centered with margin — never write transparent background.",
    "2. For a nine-slice bubble the generation prompt must require decorative elements only near corners or the speech-tail area / keep the center and middle edges clean / avoid decorations in the top-center, bottom-center, left-middle, right-middle, and center stretch areas. Large decorations such as a cat head, bow, flower or paw must not sit in the horizontal or vertical middle.",
    "3. Models like Image 2 often draw a \"transparent background\" as a fake checkerboard. Generate on white, then use 去底透明 to knock out the white connected to the edge, and finally 裁切素材 to trim the leftover canvas.",
    "4. If the user uploaded an asset already, confirm its sourceImageId with 列出用户图片 first, then bring it into the library with 导入用户图片为素材.",
    "5. When a bubble or icon has spare edges, prefer 裁切素材 with cropMode=auto_trim; only fall back to coordinates if the result is unsatisfying.",
    "6. Before writing CSS, convert to WebP with 压缩转换素材 and cap the dimensions, to keep the theme light to load.",
    "7. Only use 上传图床 for a public URL once the user has allowed image-host uploads and set an ImgBB key.",
    "8. Nine-slice values for an image bubble may never be guessed. When one is wanted, call 校准九宫格 first so the user can drag the guides by hand; the result returns slice/display/padding and the CSS.",
    "9. 生成九宫格CSS only accepts a complete, already-calibrated set of values and fails if any is missing. Do not fall back on default proportions and do not invent values.",
    "10. Never stretch a whole bubble image with background-size: 100% 100% or background-size: cover.",
    "11. A successful upload only yields the host URL. Never write an API key or a delete_url into CSS.",
].join("\n");

// ── Pack definitions ────────────────────────────────────

// ── Desktop widget tools ──
// Ported from upstream b41da23. Tool NAMES stay Chinese, matching every other tool in
// this file: they are identifiers matched by name in executeMascotTool's switch and in
// preset-manager.tsx. Renaming them is the separate tool-name track.
const WIDGET_SIZE_ENUM = ["1x1", "1x2", "1x4", "2x1", "2x2", "2x3", "2x4", "3x2", "3x3", "3x4", "4x2", "4x3", "4x4", "5x4", "6x4"];

const LIST_WIDGET_CATALOG_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

const READ_DESKTOP_LAYOUT_SCHEMA = {
    type: "object",
    properties: {
        page: { type: "number", description: "Desktop page number (1-based), default 1" },
    },
    additionalProperties: false,
};

const CREATE_DIY_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "Widget name (shown in the widget picker)" },
        size: { type: "string", enum: WIDGET_SIZE_ENUM, description: "Size, rows x columns" },
        htmlString: { type: "string", description: "A complete self-contained HTML document (all CSS/JS inline)" },
        autoPlace: { type: "boolean", description: "Place it on a free desktop slot after creating, default true" },
        page: { type: "number", description: "Target page for auto-placement (1-based), default 1" },
    },
    required: ["name", "size", "htmlString"],
    additionalProperties: false,
};

const UPDATE_DIY_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        templateId: { type: "string", description: "DIY template id (starts with diy-)" },
        name: { type: "string", description: "New widget name" },
        size: { type: "string", enum: WIDGET_SIZE_ENUM, description: "New size; any desktop instance whose slot cannot fit the new size is taken off the desktop" },
        htmlString: { type: "string", description: "New complete HTML document; desktop instances hot-reload immediately" },
    },
    required: ["templateId"],
    additionalProperties: false,
};

const PREVIEW_DIY_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        templateId: { type: "string", description: "Id of the DIY template to preview" },
    },
    required: ["templateId"],
    additionalProperties: false,
};

const PLACE_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        type: { type: "string", description: "Widget type: a DIY template id (starts with diy-) or a built-in widget type name (see the widget catalog)" },
        page: { type: "number", description: "Target page (1-based), default 1" },
        row: { type: "number", description: "Starting row (1-6); pass together with col to place exactly, otherwise a free slot is found automatically" },
        col: { type: "number", description: "Starting column (1-4)" },
    },
    required: ["type"],
    additionalProperties: false,
};

const REMOVE_DIY_WIDGET_SCHEMA = {
    type: "object",
    properties: {
        widgetId: { type: "string", description: "Id of the widget instance to take off the desktop (from 查看桌面布局; DIY instances only)" },
        templateId: { type: "string", description: "Id of the DIY template to delete; removes all of its desktop instances too" },
    },
    additionalProperties: false,
};

export const MASCOT_TOOL_PACKAGES: MascotToolPackage[] = [
    {
        id: "css_pack",
        label: "CSS Styling Pack",
        legacyLabel: "CSS样式套件",
        description: "Read / overwrite / clear each page's custom CSS. Workflow: 读取CSS first to get the current content and the available selectors, then assemble the full new content (the old rules you are keeping plus your changes), and finally write it back with 覆写CSS.",
        subTools: [
            { name: "读取CSS", description: "Read the current CSS at a location, plus the selectors and variables available there. Always read before changing anything. With no location, returns a status overview of all 5 locations.", parameterSchema: READ_CSS_SCHEMA },
            { name: "覆写CSS", description: "Replace all CSS at that location with new content. You must assemble the complete content yourself (the old rules you are keeping plus your changes) before writing.", parameterSchema: OVERWRITE_CSS_SCHEMA },
            { name: "清除CSS", description: "Clear all custom CSS at the given location.", parameterSchema: CLEAR_CSS_SCHEMA },
        ],
        usageGuide: CSS_PROMPT,
    },
    {
        id: "image_pack",
        label: "Image Pack",
        legacyLabel: "图像处理套件",
        description: "Generate images, import the user's own, knock out backgrounds, crop, compress and convert, list and read, upload, and build nine-slice CSS. Suited to making themed assets such as chat bubbles, icons and background textures.",
        subTools: [
            { name: "生成图像素材", description: "Call the configured image-generation API to produce an asset usable in CSS, save it to the local asset library, and return its id and a preview.", parameterSchema: GENERATE_IMAGE_ASSET_SCHEMA },
            { name: "列出用户图片", description: "List the images the user uploaded in the recent Scroll conversation, returning sourceImageId and a preview so one can be chosen for import.", parameterSchema: LIST_USER_IMAGES_SCHEMA },
            { name: "导入用户图片为素材", description: "Import an image the user sent to Scroll into the CSS asset library and return its assetId, ready to crop, knock out, upload and write CSS against.", parameterSchema: IMPORT_USER_IMAGE_ASSET_SCHEMA },
            { name: "去底透明", description: "Turn a white or flat-colour background that touches the image edge transparent. Good for the white-backed bubbles and icons Image 2 produces.", parameterSchema: REMOVE_IMAGE_BACKGROUND_SCHEMA },
            { name: "裁切素材", description: "Produce a new cropped asset from an existing asset id. Supports cropping by coordinates, and automatically trimming transparent or near-flat edges.", parameterSchema: CROP_IMAGE_ASSET_SCHEMA },
            { name: "压缩转换素材", description: "Convert an asset to WebP/PNG/JPEG, optionally capping the maximum dimensions and the quality, and return a new asset id.", parameterSchema: CONVERT_IMAGE_ASSET_SCHEMA },
            { name: "列出读取素材", description: "With no assetId, list the most recent assets. With an assetId, read that asset's details and return a preview.", parameterSchema: READ_IMAGE_ASSET_SCHEMA },
            { name: "上传图床", description: "Upload an asset to the ImgBB image host configured in settings, return the public URL, and store it on the asset record.", parameterSchema: UPLOAD_IMAGE_ASSET_SCHEMA },
            { name: "校准九宫格", description: "Open a dialog so the user can drag the nine-slice guides by hand, and return exact slice/display/padding values. Complex image bubbles must be calibrated with this first.", parameterSchema: CALIBRATE_NINE_SLICE_SCHEMA },
            { name: "生成九宫格CSS", description: "Build border-image nine-slice CSS from a complete, already-calibrated set of slice/display/padding values. It never guesses the values for you.", parameterSchema: NINE_SLICE_CSS_SCHEMA },
        ],
        usageGuide: IMAGE_ASSET_USAGE_GUIDE,
    },
    {
        id: "character_pack",
        label: "Character Card Pack",
        legacyLabel: "角色卡套件",
        description: "Create / edit / view character cards. A character is made of three fields: name, persona and personality.",
        subTools: [
            { name: "读取角色", description: "With no name, list every character. With a name, return that character's full fields.", parameterSchema: READ_CHARACTER_SCHEMA },
            { name: "创建角色", description: "Create a new character card. The persona must follow the 7-section structure (basics / appearance / worldview / personality / additional notes / history).", parameterSchema: CREATE_CHARACTER_SCHEMA },
            { name: "更新角色字段", description: "Change a single field on a character (name / persona / personality).", parameterSchema: UPDATE_CHARACTER_FIELD_SCHEMA },
        ],
        usageGuide: CHARACTER_CARD_PROMPT,
    },
    {
        id: "worldbook_pack",
        label: "World Book Pack",
        legacyLabel: "世界书套件",
        description: "Manage world books and their entries. A world book holds several entries, and each entry is either always active or triggered by keywords.",
        subTools: [
            { name: "列出世界书", description: "With no name, list every world book. With a name, return that book's entry list (including uids).", parameterSchema: LIST_WORLDBOOKS_SCHEMA },
            { name: "读取词条", description: "Read an entry's full content.", parameterSchema: READ_WORLDBOOK_ENTRY_SCHEMA },
            { name: "创建词条", description: "Create an entry in a world book. If the named book does not exist it is created automatically. Wrapping the content in XML tags is recommended for structure.", parameterSchema: CREATE_WORLDBOOK_ENTRY_SCHEMA },
            { name: "更新词条", description: "Change one field on an entry (key / content / comment / constant / position).", parameterSchema: UPDATE_WORLDBOOK_ENTRY_SCHEMA },
            { name: "删除词条", description: "Delete an entry from a world book.", parameterSchema: DELETE_WORLDBOOK_ENTRY_SCHEMA },
        ],
        usageGuide: WORLDBOOK_PROMPT,
    },
    {
        id: "preset_pack",
        label: "Preset Pack",
        legacyLabel: "预设套件",
        description: "Manage LLM presets. A preset is either story type or general type; general ones are cloned from the built-in preset. Each preset holds several prompts, joined in order into the system prompt.",
        subTools: [
            { name: "列出预设", description: "List every preset, with its type and whether it is the built-in one.", parameterSchema: LIST_PRESETS_SCHEMA },
            { name: "读取预设", description: "Read a preset's entry list (each entry's promptIndex, name, tag, role, and the first ~60 words of its content). It deliberately omits full content — a preset can hold dozens of entries — so use 读取预设条目 when you need one in full.", parameterSchema: READ_PRESET_SCHEMA },
            { name: "读取预设条目", description: "Read the full content of a single prompt in a preset, located by promptIndex.", parameterSchema: READ_PRESET_PROMPT_SCHEMA },
            { name: "创建剧情预设", description: "Create an empty story preset. Story presets have no built-in template, so you must write the prompts yourself in the 8-block order (main persona → markers → story guidance → prose style → anti-derailment → extras → output format → CoT).", parameterSchema: CREATE_STORY_PRESET_SCHEMA },
            { name: "克隆内置预设", description: "Clone the system's built-in general preset into a new one (70+ prompts covering every app mode). After cloning you would normally change 1-5 entries with 更新预设条目.", parameterSchema: CLONE_BUILTIN_PRESET_SCHEMA },
            { name: "复制预设", description: "Deep-copy one of the user's existing presets (keeping every entry, its order and its tags). Suits \"make a variant of my existing X preset\"; both story and general presets can be copied.", parameterSchema: DUPLICATE_PRESET_SCHEMA },
            { name: "添加预设条目", description: "Append or insert a prompt into an existing preset, keeping prompt_order in sync.", parameterSchema: ADD_PRESET_PROMPT_SCHEMA },
            { name: "更新预设条目", description: "Change a single field on one prompt in a preset.", parameterSchema: UPDATE_PRESET_PROMPT_SCHEMA },
            { name: "更新预设信息", description: "Change a preset's name or description.", parameterSchema: UPDATE_PRESET_INFO_SCHEMA },
        ],
        usageGuide: `${PRESET_PROMPT}\n\n=== Extra rules for general presets (type=general) ===\n${GENERAL_PRESET_PROMPT}`,
    },
    {
        id: "regex_pack",
        label: "Regex Pack",
        legacyLabel: "正则套件",
        description: "Manage regex rule groups. Each group holds several rules, and each rule defines a find/replace pattern and where it applies.",
        subTools: [
            { name: "列出正则组", description: "List every regex group and how many rules each holds.", parameterSchema: LIST_REGEX_GROUPS_SCHEMA },
            { name: "读取正则组", description: "Read all rules in a group, including their rule ids.", parameterSchema: READ_REGEX_GROUP_SCHEMA },
            { name: "创建正则组", description: "Create a new regex group and fill it with rules.", parameterSchema: CREATE_REGEX_GROUP_SCHEMA },
            { name: "添加正则规则", description: "Append one rule to an existing group.", parameterSchema: ADD_REGEX_RULE_SCHEMA },
            { name: "更新正则规则", description: "Change fields on a rule (pass a partial set in updates).", parameterSchema: UPDATE_REGEX_RULE_SCHEMA },
        ],
        usageGuide: REGEX_PROMPT,
    },
    {
        id: "widget_pack",
        label: "Desktop Widget Pack",
        legacyLabel: "桌面组件套件",
        description: "Create / update / preview / place DIY desktop widgets (self-contained HTML, rendered in a sandbox). Desktop instances hot-reload after an update, which suits small iterative steps.",
        subTools: [
            { name: "列出组件目录", description: "List the built-in widgets and the DIY widget templates (with templateId, size and mode).", parameterSchema: LIST_WIDGET_CATALOG_SCHEMA },
            { name: "查看桌面布局", description: "Show which cells of one page's 6x4 grid are occupied, plus that page's widget instances (with instance ids).", parameterSchema: READ_DESKTOP_LAYOUT_SCHEMA },
            { name: "创建DIY组件", description: "Create a new DIY widget template from a complete HTML document; placed on a free desktop slot by default.", parameterSchema: CREATE_DIY_WIDGET_SCHEMA },
            { name: "更新DIY组件", description: "Change a DIY template's name, size or HTML; desktop instances hot-reload immediately.", parameterSchema: UPDATE_DIY_WIDGET_SCHEMA },
            { name: "预览DIY组件", description: "Pop up a preview of a DIY template's current look inside the conversation, without leaving the chat.", parameterSchema: PREVIEW_DIY_WIDGET_SCHEMA },
            { name: "摆放组件", description: "Place a DIY template or a built-in widget on the desktop; finds a free slot when row/col are omitted.", parameterSchema: PLACE_WIDGET_SCHEMA },
            { name: "移除DIY组件", description: "Take a DIY instance off the desktop, or delete a DIY template along with all of its desktop instances.", parameterSchema: REMOVE_DIY_WIDGET_SCHEMA },
        ],
        usageGuide: WIDGET_PROMPT,
    },
];

// Navigation is standalone (not in a pack) and always exposed directly
export const MASCOT_NAVIGATE_TOOL: MascotSubTool = {
    name: "导航",
    description: "Jump to a given page inside the phone. subpage only applies when page=settings.",
    parameterSchema: NAVIGATE_SCHEMA,
};

// ── Tool list rendering under the text protocol ─────────────────────────────

/** The compact tool list, injected into the system prompt every turn. */
export function buildMascotToolsListPrompt(): string {
    const lines: string[] = [];
    lines.push("===== Your tools =====");
    lines.push("The tools below are grouped into packs. To use a pack, first fetch it to get the detailed action reference, then call the action you want.");
    lines.push("");
    for (const pkg of MASCOT_TOOL_PACKAGES) {
        lines.push(`【${pkg.label}】${pkg.description}`);
    }
    // Navigation sits outside the packs, so its schema is expanded inline here — it is a
    // single tool, and this saves a whole fetch round trip.
    lines.push("【Standalone tool】导航 (navigate) — jump to a given page. Callable directly.");
    lines.push("  Parameters:");
    lines.push("    · page (required) — the page name. One of: chat / characters / story / vnmode / moments / calendar / music / resources / settings");
    lines.push("    · subpage (optional) — a sub-page, only meaningful when page=settings. One of: presets / worldbook / regex / api / voice / binding / data / identity");
    lines.push("  Call it as: [CallTool:导航({\"page\":\"chat\"})] or [CallTool:导航({\"page\":\"settings\",\"subpage\":\"presets\"})]");
    lines.push("");
    lines.push("===== Calling rules =====");
    lines.push("· Fetch a pack with [FetchTool:packName], for example [FetchTool:CSS Styling Pack]");
    lines.push("· Run an action with [CallTool:actionName({\"param\":\"value\"})], for example [CallTool:读取CSS({\"location\":\"chat_session\"})]");
    lines.push("· Action names are the literal names shown in each pack — keep them exactly as written, including any Chinese characters");
    lines.push("· At most 2 packs can be open at once; fetching a third drops the oldest");
    lines.push("· When you do not need a tool, just reply in text and chat normally");
    lines.push("· Important: when you call an action, do NOT restate the action's arguments in your reply (for instance, never write the whole persona out again). Keep the reply to a sentence or two about what you are doing");
    return lines.join("\n");
}

/** The detailed schema shown once a pack is expanded (the response to a fetch directive). */
export function buildMascotPackageSchemaPrompt(packageLabel: string, protocol: "text" | "native" = "text"): string {
    // Goes through findPackageByLabel so the legacy Chinese pack names keep resolving
    // here too — this lookup used to be its own `p.label === packageLabel` comparison,
    // which would have silently stopped matching the moment the labels were translated.
    const pkg = findPackageByLabel(packageLabel) ?? MASCOT_TOOL_PACKAGES.find(p => p.id === packageLabel);
    if (!pkg) return `(No such pack: ${packageLabel})`;

    const lines: string[] = [];
    lines.push(`【${pkg.label}】action reference`);
    lines.push(pkg.description);
    lines.push("");
    for (const tool of pkg.subTools) {
        lines.push(`◆ ${tool.name}`);
        lines.push(`  Description: ${tool.description}`);
        const params = (tool.parameterSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>> | undefined;
        const required = (tool.parameterSchema as Record<string, unknown>).required as string[] | undefined;
        if (params && Object.keys(params).length > 0) {
            lines.push(`  Parameters:`);
            for (const [paramName, paramDef] of Object.entries(params)) {
                const isRequired = required?.includes(paramName) ? "required" : "optional";
                const enumStr = paramDef.enum ? ` (one of: ${(paramDef.enum as unknown[]).join("/")})` : "";
                lines.push(`    · ${paramName} (${paramDef.type}, ${isRequired})${enumStr} — ${paramDef.description || ""}`);
            }
        } else {
            lines.push(`  Parameters: none`);
        }
        // Under the text protocol, show the call syntax. Under the native protocol the LLM
        // already sees the tool schema directly, so this line is unnecessary.
        if (protocol === "text") {
            lines.push(`  Call it as: [CallTool:${tool.name}(${formatExampleArgs(tool.parameterSchema)})]`);
        }
        lines.push("");
    }
    if (pkg.usageGuide) {
        lines.push("===== Writing guide =====");
        lines.push(pkg.usageGuide);
    }
    return lines.join("\n");
}

function formatExampleArgs(schema: Record<string, unknown>): string {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || Object.keys(props).length === 0) return "{}";
    const example: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(props)) {
        if (def.enum && Array.isArray(def.enum)) example[k] = def.enum[0];
        else if (def.type === "string") example[k] = "...";
        else if (def.type === "number") example[k] = 0;
        else if (def.type === "boolean") example[k] = true;
        else if (def.type === "array") example[k] = [];
        else example[k] = null;
    }
    return JSON.stringify(example);
}

function numberOption(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

// ── Tool definitions under the native protocol ──────────

const MASCOT_NATIVE_TOOL_NAMES: Record<string, string> = {
    "导航": "mascot_navigate",
    "读取CSS": "mascot_read_css",
    "覆写CSS": "mascot_write_css",
    "清除CSS": "mascot_clear_css",
    "生成图像素材": "mascot_generate_css_asset",
    "列出用户图片": "mascot_list_user_images",
    "导入用户图片为素材": "mascot_import_user_image_asset",
    "去底透明": "mascot_remove_css_asset_background",
    "裁切素材": "mascot_crop_css_asset",
    "压缩转换素材": "mascot_convert_css_asset",
    "列出读取素材": "mascot_read_css_asset",
    "上传图床": "mascot_upload_css_asset",
    "校准九宫格": "mascot_calibrate_nine_slice",
    "生成九宫格CSS": "mascot_build_nine_slice_css",
    "读取角色": "mascot_read_character",
    "创建角色": "mascot_create_character",
    "更新角色字段": "mascot_update_character_field",
    "列出世界书": "mascot_list_worldbooks",
    "读取词条": "mascot_read_worldbook_entry",
    "创建词条": "mascot_create_worldbook_entry",
    "更新词条": "mascot_update_worldbook_entry",
    "删除词条": "mascot_delete_worldbook_entry",
    "列出预设": "mascot_list_presets",
    "读取预设": "mascot_read_preset",
    "读取预设条目": "mascot_read_preset_prompt",
    "创建剧情预设": "mascot_create_story_preset",
    "克隆内置预设": "mascot_clone_builtin_preset",
    "复制预设": "mascot_duplicate_preset",
    "添加预设条目": "mascot_add_preset_prompt",
    "更新预设条目": "mascot_update_preset_prompt",
    "更新预设信息": "mascot_update_preset_info",
    "列出正则组": "mascot_list_regex_groups",
    "读取正则组": "mascot_read_regex_group",
    "创建正则组": "mascot_create_regex_group",
    "添加正则规则": "mascot_add_regex_rule",
    "更新正则规则": "mascot_update_regex_rule",
    "列出组件目录": "mascot_list_widget_catalog",
    "查看桌面布局": "mascot_read_desktop_layout",
    "创建DIY组件": "mascot_create_diy_widget",
    "更新DIY组件": "mascot_update_diy_widget",
    "预览DIY组件": "mascot_preview_diy_widget",
    "摆放组件": "mascot_place_widget",
    "移除DIY组件": "mascot_remove_diy_widget",
};

const MASCOT_NATIVE_LOADER_NAMES: Record<string, string> = {
    widget_pack: "mascot_load_widget_pack",
    css_pack: "mascot_load_css_pack",
    image_pack: "mascot_load_image_pack",
    character_pack: "mascot_load_character_pack",
    worldbook_pack: "mascot_load_worldbook_pack",
    preset_pack: "mascot_load_preset_pack",
    regex_pack: "mascot_load_regex_pack",
};

export function getMascotNativeToolName(displayName: string): string {
    const name = MASCOT_NATIVE_TOOL_NAMES[displayName];
    if (!name) throw new Error(`Missing mascot native tool alias: ${displayName}`);
    return name;
}

export function getMascotNativeLoaderName(packageId: string): string {
    const name = MASCOT_NATIVE_LOADER_NAMES[packageId];
    if (!name) throw new Error(`Missing mascot native loader alias: ${packageId}`);
    return name;
}

/** Build the native LLM tool definition list from the set of already-expanded pack ids. */
export function getMascotNativeToolDefinitions(expandedPackageIds: string[] = []): LlmToolDefinition[] {
    const defs: LlmToolDefinition[] = [];

    // Navigation: always exposed
    defs.push({
        name: getMascotNativeToolName(MASCOT_NAVIGATE_TOOL.name),
        description: MASCOT_NAVIGATE_TOOL.description,
        parameters: MASCOT_NAVIGATE_TOOL.parameterSchema,
    });

    // Each pack exposes a loader first, unless it is already expanded
    const expanded = new Set(expandedPackageIds);
    for (const pkg of MASCOT_TOOL_PACKAGES) {
        if (expanded.has(pkg.id)) {
            // Expanded → expose every sub-tool
            for (const tool of pkg.subTools) {
                defs.push({
                    name: getMascotNativeToolName(tool.name),
                    description: tool.description,
                    parameters: tool.parameterSchema,
                });
            }
        } else {
            // Not expanded → expose the loader
            // Note: properties deliberately carries one meaningless optional field. Some providers
        // (Gemini among them) reject empty args, treating them as an uninitialised protobuf Struct.
            defs.push({
                name: getMascotNativeLoaderName(pkg.id),
                description: `Expand the action reference for "${pkg.label}". ${pkg.description}`,
                parameters: {
                    type: "object",
                    properties: {
                        reason: { type: "string", description: "Optional: why you want to expand this pack" },
                    },
                    additionalProperties: false,
                },
            });
        }
    }
    return defs;
}

/** Native tool id → tool name, used to turn an LLM call back into the name the dispatcher switches on. */
export function buildMascotNativeNameMap(): Map<string, string> {
    const map = new Map<string, string>();
    map.set(getMascotNativeToolName(MASCOT_NAVIGATE_TOOL.name), MASCOT_NAVIGATE_TOOL.name);
    for (const pkg of MASCOT_TOOL_PACKAGES) {
        map.set(getMascotNativeLoaderName(pkg.id), `_loader:${pkg.id}`);
        for (const tool of pkg.subTools) {
            map.set(getMascotNativeToolName(tool.name), tool.name);
        }
    }
    return map;
}

// ── Tool executor ─────────────────────────────────────

export type MascotToolContext = {
    pageContext: MascotPageContext;
    history?: CssAssetUserImageHistoryMessage[];
};

/** Execute a Scroll tool call. */
export async function executeMascotToolCall(call: ToolCall, ctx: MascotToolContext): Promise<ToolResult> {
    try {
        switch (call.name) {
            // ─── CSS ───
            case "读取CSS": return await handleReadCss(call.args, ctx);
            case "覆写CSS": return await handleOverwriteCss(call.args, ctx);
            case "清除CSS": return await handleClearCss(call.args, ctx);

            // ─── Images ───
            case "生成图像素材": return await handleGenerateCssAsset(call.args);
            case "列出用户图片": return await handleListUserImages(call.args, ctx);
            case "导入用户图片为素材": return await handleImportUserImageAsAsset(call.args, ctx);
            case "去底透明": return await handleRemoveCssAssetBackground(call.args);
            case "裁切素材": return await handleCropCssAsset(call.args);
            case "压缩转换素材": return await handleConvertCssAsset(call.args);
            case "列出读取素材": return await handleListOrReadCssAssets(call.args);
            case "上传图床": return await handleUploadCssAsset(call.args);
            case "校准九宫格": return await handleCalibrateNineSlice(call.args);
            case "生成九宫格CSS": return await handleBuildNineSliceCss(call.args);

            // ─── Desktop widgets ───
            case "列出组件目录": return await handleListWidgetCatalog();
            case "查看桌面布局": return await handleReadDesktopLayout(call.args);
            case "创建DIY组件": return await handleCreateDiyWidget(call.args);
            case "更新DIY组件": return await handleUpdateDiyWidget(call.args);
            case "预览DIY组件": return await handlePreviewDiyWidget(call.args);
            case "摆放组件": return await handlePlaceWidget(call.args);
            case "移除DIY组件": return await handleRemoveDiyWidget(call.args);

            // ─── Characters ───
            case "读取角色": return await handleReadCharacter(call.args);
            case "创建角色": return await handleCreateCharacter(call.args);
            case "更新角色字段": return await handleUpdateCharacterField(call.args);

            // ─── World books ───
            case "列出世界书": return await handleListWorldbooks(call.args);
            case "读取词条": return await handleReadWorldbookEntry(call.args);
            case "创建词条": return await handleCreateWorldbookEntry(call.args);
            case "更新词条": return await handleUpdateWorldbookEntry(call.args);
            case "删除词条": return await handleDeleteWorldbookEntry(call.args);

            // ─── Presets ───
            case "列出预设": return await handleListPresets();
            case "读取预设": return await handleReadPreset(call.args);
            case "读取预设条目": return await handleReadPresetPrompt(call.args);
            case "创建剧情预设": return await handleCreateStoryPreset(call.args);
            case "克隆内置预设": return await handleCloneBuiltinPreset(call.args);
            case "复制预设": return await handleDuplicatePreset(call.args);
            case "添加预设条目": return await handleAddPresetPrompt(call.args);
            case "更新预设条目": return await handleUpdatePresetPrompt(call.args);
            case "更新预设信息": return await handleUpdatePresetInfo(call.args);

            // ─── Regex ───
            case "列出正则组": return await handleListRegexGroups();
            case "读取正则组": return await handleReadRegexGroup(call.args);
            case "创建正则组": return await handleCreateRegexGroup(call.args);
            case "添加正则规则": return await handleAddRegexRule(call.args);
            case "更新正则规则": return await handleUpdateRegexRule(call.args);

            // ─── 导航 ───
            case "导航": return await handleNavigate(call.args);

            default:
                return { name: call.name, success: false, error: `Unknown tool: ${call.name}` };
        }
    } catch (err) {
        return { name: call.name, success: false, error: (err as Error).message };
    }
}

// ── Image Asset Handlers ───────────────────────

async function handleGenerateCssAsset(args: Record<string, unknown>): Promise<ToolResult> {
    return createCssAssetFromGeneratedImage({
        description: typeof args.description === "string" ? args.description : "",
        kind: args.kind,
        label: typeof args.label === "string" ? args.label : undefined,
        characterId: typeof args.characterId === "string" ? args.characterId : undefined,
        useReferenceImage: args.useReferenceImage === true,
    });
}

async function handleListUserImages(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    return listUserUploadedImages({
        history: ctx.history,
        limit: typeof args.limit === "number" ? args.limit : undefined,
    });
}

async function handleImportUserImageAsAsset(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    return importUserImageAsCssAsset({
        history: ctx.history,
        sourceImageId: typeof args.sourceImageId === "string" ? args.sourceImageId : undefined,
        messageOffset: typeof args.messageOffset === "number" ? args.messageOffset : undefined,
        imageIndex: typeof args.imageIndex === "number" ? args.imageIndex : undefined,
        kind: args.kind,
        label: typeof args.label === "string" ? args.label : undefined,
    });
}

async function handleCropCssAsset(args: Record<string, unknown>): Promise<ToolResult> {
    return cropCssAsset({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        cropMode: args.cropMode === "auto_trim" ? "auto_trim" : "coordinates",
        unit: args.unit === "percent" ? "percent" : "pixel",
        x: typeof args.x === "number" ? args.x : undefined,
        y: typeof args.y === "number" ? args.y : undefined,
        width: typeof args.width === "number" ? args.width : undefined,
        height: typeof args.height === "number" ? args.height : undefined,
        padding: typeof args.padding === "number" ? args.padding : undefined,
        tolerance: typeof args.tolerance === "number" ? args.tolerance : undefined,
        outputWidth: typeof args.outputWidth === "number" ? args.outputWidth : undefined,
        outputHeight: typeof args.outputHeight === "number" ? args.outputHeight : undefined,
        label: typeof args.label === "string" ? args.label : undefined,
    });
}

async function handleRemoveCssAssetBackground(args: Record<string, unknown>): Promise<ToolResult> {
    return removeCssAssetBackground({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        tolerance: typeof args.tolerance === "number" ? args.tolerance : undefined,
        feather: typeof args.feather === "number" ? args.feather : undefined,
        backgroundColor: typeof args.backgroundColor === "string" ? args.backgroundColor : undefined,
        format: args.format === "webp" ? "webp" : "png",
        label: typeof args.label === "string" ? args.label : undefined,
    });
}

async function handleConvertCssAsset(args: Record<string, unknown>): Promise<ToolResult> {
    return convertCssAsset({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        format: args.format === "png" || args.format === "jpeg" || args.format === "webp" ? args.format : undefined,
        quality: typeof args.quality === "number" ? args.quality : undefined,
        maxWidth: typeof args.maxWidth === "number" ? args.maxWidth : undefined,
        maxHeight: typeof args.maxHeight === "number" ? args.maxHeight : undefined,
        label: typeof args.label === "string" ? args.label : undefined,
    });
}

async function handleListOrReadCssAssets(args: Record<string, unknown>): Promise<ToolResult> {
    return listOrReadCssAssets({
        assetId: typeof args.assetId === "string" ? args.assetId : undefined,
    });
}

async function handleCalibrateNineSlice(args: Record<string, unknown>): Promise<ToolResult> {
    return calibrateCssAssetNineSlice({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        selector: typeof args.selector === "string" ? args.selector : undefined,
    });
}

async function handleBuildNineSliceCss(args: Record<string, unknown>): Promise<ToolResult> {
    return buildCssAssetNineSliceCss({
        assetId: typeof args.assetId === "string" ? args.assetId : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
        selector: typeof args.selector === "string" ? args.selector : undefined,
        sliceTop: typeof args.sliceTop === "number" ? args.sliceTop : undefined,
        sliceRight: typeof args.sliceRight === "number" ? args.sliceRight : undefined,
        sliceBottom: typeof args.sliceBottom === "number" ? args.sliceBottom : undefined,
        sliceLeft: typeof args.sliceLeft === "number" ? args.sliceLeft : undefined,
        displayTop: typeof args.displayTop === "number" ? args.displayTop : undefined,
        displayRight: typeof args.displayRight === "number" ? args.displayRight : undefined,
        displayBottom: typeof args.displayBottom === "number" ? args.displayBottom : undefined,
        displayLeft: typeof args.displayLeft === "number" ? args.displayLeft : undefined,
        paddingTop: typeof args.paddingTop === "number" ? args.paddingTop : undefined,
        paddingRight: typeof args.paddingRight === "number" ? args.paddingRight : undefined,
        paddingBottom: typeof args.paddingBottom === "number" ? args.paddingBottom : undefined,
        paddingLeft: typeof args.paddingLeft === "number" ? args.paddingLeft : undefined,
        minWidth: typeof args.minWidth === "number" ? args.minWidth : undefined,
        minHeight: typeof args.minHeight === "number" ? args.minHeight : undefined,
    });
}

async function handleUploadCssAsset(args: Record<string, unknown>): Promise<ToolResult> {
    return uploadCssAssetToImageHost({
        assetId: typeof args.assetId === "string" ? args.assetId : "",
        filename: typeof args.filename === "string" ? args.filename : undefined,
        expirationSeconds: typeof args.expirationSeconds === "number" ? args.expirationSeconds : undefined,
    });
}

// ── CSS Handlers ────────────────────────────────

const CSS_LOCATION_LABELS: Record<string, { label: string; storageKey?: string; needsSession?: "chat" | "story" }> = {
    chat_app: { label: "Chat app CSS", storageKey: "chat-app-custom-css" },
    chat_session: { label: "Individual chat room CSS", needsSession: "chat" },
    mascot_chat: { label: "AI assistant chat room CSS" },
    story: { label: "Story mode CSS", needsSession: "story" },
    music: { label: "Music CSS", storageKey: "music-custom-css" },
    calendar: { label: "Calendar CSS", storageKey: "calendar-custom-css" },
};

async function handleListCssLocations(): Promise<ToolResult> {
    const { kvGet } = await import("./kv-db");
    const { getMascotSettingsSnapshot } = await import("./mascot-settings");
    const lines: string[] = [];
    for (const [key, info] of Object.entries(CSS_LOCATION_LABELS)) {
        let status = "—";
        if (key === "mascot_chat") {
            status = getMascotSettingsSnapshot().chatCustomCSS ? "set" : "empty";
        } else if (info.storageKey) {
            const has = !!kvGet(info.storageKey);
            status = has ? "set" : "empty";
        } else {
            status = "view it from within that session";
        }
        lines.push(`· ${key} — ${info.label}：${status}`);
    }
    return { name: "列出CSS位置", success: true, data: lines.join("\n") };
}

/** Resolve a chat session id from the sessionName the user gave, or from the current
 *  page context. Returns { sessionId, displayName } or { error, choices }. */
async function resolveChatSession(sessionName: string | undefined, ctx: MascotToolContext): Promise<
    | { sessionId: string; displayName: string }
    | { error: string; choices?: string[] }
> {
    const { loadChatSessions } = await import("./chat-storage");
    const { loadCharacters } = await import("./character-storage");
    const sessions = loadChatSessions();
    if (sessions.length === 0) return { error: "There are no chat sessions yet. Start a chat with a character before changing its CSS" };
    const chars = loadCharacters();
    const charNameById = new Map(chars.map((c) => [c.id, c.name || ""]));

    const buildDisplayName = (s: typeof sessions[number]): string => {
        if (s.isGroup) return s.groupName || "Group chat";
        return s.alias || charNameById.get(s.contactId) || s.contactId;
    };

    if (sessionName) {
        const lowered = sessionName.toLowerCase();
        const matched = sessions.find((s) => {
            const display = buildDisplayName(s).toLowerCase();
            return display === lowered || display.includes(lowered);
        });
        if (matched) return { sessionId: matched.id, displayName: buildDisplayName(matched) };
        const choices = sessions.map((s) => buildDisplayName(s));
        return { error: `No chat session matching "${sessionName}"`, choices };
    }

    // No sessionName given: prefer the sessionId of the page currently open
    const ctxSessionId = ctx.pageContext.fields.sessionId;
    if (ctxSessionId) {
        const session = sessions.find((s) => s.id === ctxSessionId);
        if (session) return { sessionId: session.id, displayName: buildDisplayName(session) };
    }
    // Cannot pin it down → offer the choices
    const choices = sessions.map((s) => buildDisplayName(s));
    return { error: "Use sessionName to say which chat session to act on", choices };
}

async function resolveStorySession(sessionName: string | undefined, ctx: MascotToolContext): Promise<
    | { sessionId: string; displayName: string }
    | { error: string; choices?: string[] }
> {
    const { loadStorySessions } = await import("./story-storage");
    const { loadCharacters } = await import("./character-storage");
    const sessions = loadStorySessions();
    if (sessions.length === 0) return { error: "There are no story sessions yet" };
    const chars = loadCharacters();
    const charNameById = new Map(chars.map((c) => [c.id, c.name || ""]));

    const buildDisplayName = (s: typeof sessions[number]): string => {
        return s.title || charNameById.get((s as Record<string, unknown>).characterId as string || "") || s.id;
    };

    if (sessionName) {
        const lowered = sessionName.toLowerCase();
        const matched = sessions.find((s) => buildDisplayName(s).toLowerCase().includes(lowered));
        if (matched) return { sessionId: matched.id, displayName: buildDisplayName(matched) };
        const choices = sessions.map((s) => buildDisplayName(s));
        return { error: `No story session matching "${sessionName}"`, choices };
    }

    const ctxSessionId = ctx.pageContext.fields.storySessionId || ctx.pageContext.fields.sessionId;
    if (ctxSessionId) {
        const session = sessions.find((s) => s.id === ctxSessionId);
        if (session) return { sessionId: session.id, displayName: buildDisplayName(session) };
    }
    const choices = sessions.map((s) => buildDisplayName(s));
    return { error: "Use sessionName to say which story session to act on", choices };
}

async function readCssAt(location: string, ctx: MascotToolContext, sessionName?: string): Promise<{ css: string; sessionId?: string; displayName?: string; note?: string; choices?: string[] }> {
    const { kvGet } = await import("./kv-db");
    if (location === "chat_app") return { css: kvGet("chat-app-custom-css") || "" };
    if (location === "mascot_chat") {
        const { getMascotSettingsSnapshot } = await import("./mascot-settings");
        const settings = getMascotSettingsSnapshot();
        return { css: settings.chatCustomCSS || "", displayName: settings.nickname || "AI assistant" };
    }
    if (location === "music") return { css: kvGet("music-custom-css") || "" };
    if (location === "calendar") return { css: kvGet("calendar-custom-css") || "" };
    if (location === "chat_session") {
        const resolved = await resolveChatSession(sessionName, ctx);
        if ("error" in resolved) return { css: "", note: resolved.error, choices: resolved.choices };
        try {
            const { loadChatSessions } = await import("./chat-storage");
            const session = loadChatSessions().find((s) => s.id === resolved.sessionId);
            return { css: (session as Record<string, unknown>)?.customCSS as string || "", sessionId: resolved.sessionId, displayName: resolved.displayName };
        } catch { return { css: "", sessionId: resolved.sessionId, displayName: resolved.displayName }; }
    }
    if (location === "story") {
        const resolved = await resolveStorySession(sessionName, ctx);
        if ("error" in resolved) return { css: "", note: resolved.error, choices: resolved.choices };
        try {
            const { loadStorySessions } = await import("./story-storage");
            const session = loadStorySessions().find((s) => s.id === resolved.sessionId);
            return { css: (session as Record<string, unknown>)?.customCSS as string || "", sessionId: resolved.sessionId, displayName: resolved.displayName };
        } catch { return { css: "", sessionId: resolved.sessionId, displayName: resolved.displayName }; }
    }
    throw new Error(`Unknown CSS location: ${location}`);
}

async function handleReadCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location) return await handleListCssLocations();
    if (!CSS_LOCATION_LABELS[location]) return { name: "读取CSS", success: false, error: `Unknown location: ${location}` };

    // For chat_session / story: no sessionName and no matching session open on the page →
    // switch to discovery mode and return the session list as a success, not an error.
    if ((location === "chat_session" || location === "story") && !sessionName) {
        const ctxSessionId = location === "chat_session"
            ? ctx.pageContext.fields.sessionId
            : (ctx.pageContext.fields.storySessionId || ctx.pageContext.fields.sessionId);
        if (!ctxSessionId) {
            const resolved = location === "chat_session"
                ? await resolveChatSession(undefined, ctx)
                : await resolveStorySession(undefined, ctx);
            if ("error" in resolved && resolved.choices) {
                const parts = [
                    `Location: ${location} (${CSS_LOCATION_LABELS[location].label})`,
                    `No session was specified. These are the sessions you can change:`,
                    ...resolved.choices.map((c) => `· ${c}`),
                    "",
                    `Confirm with the user which one they mean, then call this tool again with the sessionName parameter.`,
                ];
                return { name: "读取CSS", success: true, data: parts.join("\n") };
            }
            if ("error" in resolved) {
                return { name: "读取CSS", success: false, error: resolved.error };
            }
        }
    }

    const result = await readCssAt(location, ctx, sessionName);
    // A sessionName was given but nothing matched → a genuine error
    if (result.note && result.choices) {
        return {
            name: "读取CSS",
            success: false,
            error: `${result.note}. Available sessions: ${result.choices.map((c) => `"${c}"`).join(", ")}`,
        };
    }

    const cssExamples = await import("./css-examples");
    const refMap: Record<string, string> = {
        chat_app: cssExamples.CHAT_APP_CSS_EXAMPLE,
        chat_session: cssExamples.CHAT_SESSION_CSS_EXAMPLE,
        mascot_chat: cssExamples.CHAT_SESSION_CSS_EXAMPLE,
        story: cssExamples.STORY_CSS_EXAMPLE,
        music: cssExamples.MUSIC_CSS_EXAMPLE,
        calendar: cssExamples.CALENDAR_CSS_EXAMPLE,
    };
    const reference = refMap[location] || "";
    const parts: string[] = [];
    parts.push(`Location: ${location} (${CSS_LOCATION_LABELS[location].label})`);
    if (result.displayName) parts.push(`Session: ${result.displayName}`);
    if (result.note) parts.push(`Note: ${result.note}`);
    parts.push(`\n=== Current CSS ===\n${result.css || "(empty)"}`);
    parts.push(`\n=== Available selectors and variables ===\n${reference}`);
    return { name: "读取CSS", success: true, data: parts.join("\n") };
}

async function writeCssAt(location: string, css: string, ctx: MascotToolContext, sessionName?: string): Promise<{ displayName?: string }> {
    const { kvSet, kvRemove } = await import("./kv-db");
    const trimmed = css.trim();
    if (location === "chat_app") {
        if (trimmed) kvSet("chat-app-custom-css", trimmed); else kvRemove("chat-app-custom-css");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("chat-app-css-updated"));
        return {};
    }
    if (location === "mascot_chat") {
        const { getMascotSettingsSnapshot, updateMascotSettings } = await import("./mascot-settings");
        updateMascotSettings({ chatCustomCSS: trimmed });
        return { displayName: getMascotSettingsSnapshot().nickname || "AI assistant" };
    }
    if (location === "music") {
        if (trimmed) kvSet("music-custom-css", trimmed); else kvRemove("music-custom-css");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("music-css-change", { detail: trimmed }));
        return {};
    }
    if (location === "calendar") {
        if (trimmed) kvSet("calendar-custom-css", trimmed); else kvRemove("calendar-custom-css");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("calendar-css-updated", { detail: trimmed }));
        return {};
    }
    if (location === "chat_session") {
        const resolved = await resolveChatSession(sessionName, ctx);
        if ("error" in resolved) {
            const err = new Error(`${resolved.error}${resolved.choices ? `. Available sessions: ${resolved.choices.map((c) => `"${c}"`).join(", ")}` : ""}`);
            throw err;
        }
        const { loadChatSessions, saveChatSessions } = await import("./chat-storage");
        const sessions = loadChatSessions();
        const idx = sessions.findIndex((s) => s.id === resolved.sessionId);
        if (idx < 0) throw new Error("No current session found");
        (sessions[idx] as Record<string, unknown>).customCSS = trimmed;
        saveChatSessions(sessions);
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: resolved.sessionId, css: trimmed } }));
        return { displayName: resolved.displayName };
    }
    if (location === "story") {
        const resolved = await resolveStorySession(sessionName, ctx);
        if ("error" in resolved) {
            const err = new Error(`${resolved.error}${resolved.choices ? `. Available sessions: ${resolved.choices.map((c) => `"${c}"`).join(", ")}` : ""}`);
            throw err;
        }
        const { updateStorySession } = await import("./story-storage");
        updateStorySession(resolved.sessionId, { customCSS: trimmed });
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("story-session-css-updated", { detail: { sessionId: resolved.sessionId, css: trimmed } }));
        return { displayName: resolved.displayName };
    }
    throw new Error(`Unknown CSS location: ${location}`);
}

async function handleOverwriteCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const css = args.css as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location || !CSS_LOCATION_LABELS[location]) return { name: "覆写CSS", success: false, error: `Unknown location: ${location}` };
    const result = await writeCssAt(location, css, ctx, sessionName);
    return { name: "覆写CSS", success: true, data: `Overwrote the CSS at ${location}${result.displayName ? ` (${result.displayName})` : ""}, ${css.length} characters` };
}

async function handleClearCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location || !CSS_LOCATION_LABELS[location]) return { name: "清除CSS", success: false, error: `Unknown location: ${location}` };
    const result = await writeCssAt(location, "", ctx, sessionName);
    return { name: "清除CSS", success: true, data: `Cleared the CSS at ${location}${result.displayName ? ` (${result.displayName})` : ""}` };
}

// ── Character Handlers ──────────────────────────

async function handleReadCharacter(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    const name = args.name as string | undefined;
    if (!name) {
        if (chars.length === 0) return { name: "读取角色", success: true, data: "(no characters)" };
        const lines = chars.map((c) => `· ${c.name || "(unnamed)"} [id: ${c.id}]`);
        return { name: "读取角色", success: true, data: `${chars.length} character(s):\n${lines.join("\n")}` };
    }
    const char = chars.find((c) => c.name === name);
    if (!char) return { name: "读取角色", success: false, error: `No character named ${name}` };
    const parts: string[] = [];
    parts.push(`id: ${char.id}`);
    parts.push(`name: ${char.name || ""}`);
    parts.push(`personality: ${char.personality || ""}`);
    parts.push(`persona:\n${char.persona || ""}`);
    return { name: "读取角色", success: true, data: parts.join("\n") };
}

async function handleCreateCharacter(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadCharacters, saveCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    if (chars.find((c) => c.name === args.name)) return { name: "创建角色", success: false, error: "A character with that name already exists" };
    const now = new Date().toISOString();
    const newChar = {
        id: `char_${Date.now()}`,
        name: args.name as string,
        avatar: null,
        persona: args.persona as string,
        personality: args.personality as string,
        createdAt: now,
        updatedAt: now,
    };
    chars.push(newChar as typeof chars[number]);
    saveCharacters(chars);
    return { name: "创建角色", success: true, data: `Created character ${newChar.name} (${newChar.id})` };
}

async function handleUpdateCharacterField(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadCharacters, saveCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    const idx = chars.findIndex((c) => c.name === args.name);
    if (idx < 0) return { name: "更新角色字段", success: false, error: `No character named ${args.name}` };
    const field = args.field as string;
    const value = args.value as string;
    const char = { ...chars[idx] } as Record<string, unknown>;
    if (field === "name" || field === "persona" || field === "personality") {
        char[field] = value;
    } else {
        return { name: "更新角色字段", success: false, error: `Unsupported field: ${field}` };
    }
    char.updatedAt = new Date().toISOString();
    chars[idx] = char as typeof chars[number];
    saveCharacters(chars);
    return { name: "更新角色字段", success: true, data: `Updated ${field} on ${args.name}` };
}

// ── Worldbook Handlers ──────────────────────────

async function handleListWorldbooks(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const name = args.name as string | undefined;
    if (!name) {
        if (books.length === 0) return { name: "列出世界书", success: true, data: "(no world books)" };
        const lines = books.map((b) => `· ${b.name} (${b.entries?.length || 0} entries)`);
        return { name: "列出世界书", success: true, data: `${books.length} world book(s):\n${lines.join("\n")}` };
    }
    const book = books.find((b) => b.name === name);
    if (!book) return { name: "列出世界书", success: false, error: `No world book named ${name}` };
    if (!book.entries || book.entries.length === 0) return { name: "列出世界书", success: true, data: `World book ${name} has no entries yet` };
    const lines = book.entries.map((e) => `· [${e.uid}] ${e.comment || "(no remark)"} — keys: ${e.key || "(none)"} ${e.constant ? "[always active]" : ""} ${e.position === 0 ? "(before)" : "(after)"}`);
    return { name: "列出世界书", success: true, data: `World book ${name} has ${book.entries.length} entries:\n${lines.join("\n")}` };
}

async function handleReadWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const book = books.find((b) => b.name === args.worldbook);
    if (!book) return { name: "读取词条", success: false, error: `No world book named ${args.worldbook}` };
    const entry = book.entries?.find((e) => e.comment === args.entryComment || e.uid === args.entryComment);
    if (!entry) return { name: "读取词条", success: false, error: `No entry named ${args.entryComment}` };
    const parts: string[] = [];
    parts.push(`uid: ${entry.uid}`);
    parts.push(`comment: ${entry.comment || ""}`);
    parts.push(`key: ${entry.key || ""}`);
    parts.push(`constant: ${entry.constant}`);
    parts.push(`position: ${entry.position}`);
    parts.push(`content:\n${entry.content || ""}`);
    return { name: "读取词条", success: true, data: parts.join("\n") };
}

async function handleCreateWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks, saveWorldBooks, createWorldBook } = await import("./settings-storage");
    const books = loadWorldBooks();
    let bookIdx = books.findIndex((b) => b.name === args.worldbook);
    if (bookIdx < 0) {
        const newBook = createWorldBook(args.worldbook as string);
        books.push(newBook);
        bookIdx = books.length - 1;
    }
    const book = { ...books[bookIdx] };
    const newEntry = {
        uid: `entry_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        key: args.key as string,
        content: args.content as string,
        comment: args.comment as string,
        use_regex: false,
        disable: false,
        constant: (args.constant as boolean) ?? false,
        position: numberOption(args.position, 0),
        insertion_order: 100,
        role: 0,
    };
    book.entries = [...(book.entries || []), newEntry];
    book.updatedAt = Date.now();
    books[bookIdx] = book;
    saveWorldBooks(books);
    return { name: "创建词条", success: true, data: `Created entry "${args.comment}" in ${args.worldbook} (uid: ${newEntry.uid})` };
}

async function handleUpdateWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks, saveWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const bookIdx = books.findIndex((b) => b.name === args.worldbook);
    if (bookIdx < 0) return { name: "更新词条", success: false, error: `No world book named ${args.worldbook}` };
    const book = { ...books[bookIdx] };
    const entries = [...(book.entries || [])];
    const entryIdx = entries.findIndex((e) => e.uid === args.entryUid);
    if (entryIdx < 0) return { name: "更新词条", success: false, error: `No entry with uid ${args.entryUid}` };
    const entry = { ...entries[entryIdx] };
    const field = args.field as string;
    const value = args.value as string;
    if (field === "key") entry.key = value;
    else if (field === "content") entry.content = value;
    else if (field === "comment") entry.comment = value;
    else if (field === "constant") entry.constant = value === "true";
    else if (field === "position") entry.position = parseInt(value, 10) || 0;
    else return { name: "更新词条", success: false, error: `Unsupported field: ${field}` };
    entries[entryIdx] = entry;
    book.entries = entries;
    book.updatedAt = Date.now();
    books[bookIdx] = book;
    saveWorldBooks(books);
    return { name: "更新词条", success: true, data: `Updated ${field} on entry ${args.entryUid}` };
}

async function handleDeleteWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks, saveWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const bookIdx = books.findIndex((b) => b.name === args.worldbook);
    if (bookIdx < 0) return { name: "删除词条", success: false, error: `No world book named ${args.worldbook}` };
    const book = { ...books[bookIdx] };
    const before = book.entries?.length || 0;
    book.entries = (book.entries || []).filter((e) => e.uid !== args.entryUid);
    if (book.entries.length === before) return { name: "删除词条", success: false, error: `No entry with uid ${args.entryUid}` };
    book.updatedAt = Date.now();
    books[bookIdx] = book;
    saveWorldBooks(books);
    return { name: "删除词条", success: true, data: `Deleted entry ${args.entryUid}` };
}

// ── Preset Handlers ────────────────────────────

const MARKER_NAMES: Record<string, string> = {
    "◇ 用户人设": "personaDescription", "◇ 世界书（角色前）": "worldInfoBefore",
    "◇ 角色描述": "charDescription", "◇ 角色性格": "charPersonality",
    "◇ 角色关系": "characterRelations",
    "◇ 世界书（角色后）": "worldInfoAfter", "◇ 日程": "calendarSchedule",
    "◇ 核心记忆": "memoryCore", "◇ 长期记忆": "memoryLongTerm", "◇ [短期记忆]": "shortTermMemory",
};

async function loadPresetStorage() {
    const storage = await import("./settings-storage");
    await storage.ensureSettingsStorageHydrated();
    return storage;
}

function createPresetPromptIdentifier(name: string, requested: unknown, existingIds: Set<string>): string {
    const requestedId = typeof requested === "string" ? requested.trim() : "";
    const markerId = name.startsWith("◇ ") ? MARKER_NAMES[name] : "";
    const generatedId = name.replace(/[^\w一-鿿]/g, "").slice(0, 30);
    const base = requestedId || markerId || generatedId || `prompt_${Date.now()}`;
    if (!existingIds.has(base)) return base;

    let counter = 2;
    let candidate = `${base}_${counter}`;
    while (existingIds.has(candidate)) {
        counter += 1;
        candidate = `${base}_${counter}`;
    }
    return candidate;
}

function rebuildPresetPromptOrder(prompts: Prompt[], previousOrder: Array<{ identifier: string; enabled: boolean }> | undefined) {
    const previousEnabled = new Map((previousOrder || []).map((entry) => [entry.identifier, entry.enabled]));
    return prompts
        .filter((prompt) => prompt.identifier)
        .map((prompt) => ({
            identifier: prompt.identifier,
            enabled: previousEnabled.get(prompt.identifier) ?? prompt.enabled,
        }));
}

async function handleListPresets(): Promise<ToolResult> {
    const { loadPresets } = await loadPresetStorage();
    const presets = loadPresets();
    if (presets.length === 0) return { name: "列出预设", success: true, data: "(no presets)" };
    const lines = presets.map((p) => {
        const featureTag = (p.prompts || []).some((x) => (x as Record<string, unknown>).featureTag);
        return `· ${p.name}${p.builtIn ? " (built-in)" : ""} — ${featureTag ? "general" : "story"} [id: ${p.id}]`;
    });
    return { name: "列出预设", success: true, data: `${presets.length} preset(s):\n${lines.join("\n")}` };
}

async function handleReadPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets } = await loadPresetStorage();
    const presets = loadPresets();
    const preset = presets.find((p) => p.name === args.name || p.name.includes(args.name as string));
    if (!preset) return { name: "读取预设", success: false, error: `No preset named ${args.name}` };
    const parts: string[] = [];
    parts.push(`id: ${preset.id}`);
    parts.push(`name: ${preset.name}`);
    parts.push(`description: ${preset.description || ""}`);
    parts.push(`builtIn: ${preset.builtIn || false}`);
    parts.push(`prompts (${preset.prompts?.length || 0}, summaries only — use 读取预设条目 for the full content):`);
    (preset.prompts || []).forEach((p, i) => {
        const segs: string[] = [`[${i}] ${p.name || p.identifier || "(unnamed)"}`];
        if (p.marker) segs.push("(marker)");
        const tags = (p as Record<string, unknown>).tags;
        const legacyTag = (p as Record<string, unknown>).featureTag;
        if (Array.isArray(tags) && tags.length > 0) {
            segs.push(`tags=[${tags.join(",")}]`);
        } else if (legacyTag) {
            segs.push(`tag=${legacyTag}`);
        }
        if (p.role && p.role !== "system") segs.push(`role=${p.role}`);
        // Summary: the opening only
        if (p.content) {
            const snippet = p.content.replace(/\s+/g, " ").slice(0, 100);
            segs.push(`— ${snippet}${p.content.length > 100 ? "..." : ""}`);
        } else if (!p.marker) {
            segs.push("(no content)");
        }
        parts.push(segs.join(" "));
    });
    return { name: "读取预设", success: true, data: parts.join("\n") };
}

async function handleReadPresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets } = await loadPresetStorage();
    const presets = loadPresets();
    const preset = presets.find((p) => p.id === args.presetId);
    if (!preset) return { name: "读取预设条目", success: false, error: `No preset with id ${args.presetId}` };
    const idx = args.promptIndex as number;
    const p = preset.prompts?.[idx];
    if (!p) return { name: "读取预设条目", success: false, error: `promptIndex ${idx} is out of range (${preset.prompts?.length || 0} entries)` };
    const parts: string[] = [];
    parts.push(`promptIndex: ${idx}`);
    parts.push(`identifier: ${p.identifier}`);
    parts.push(`name: ${p.name || ""}`);
    parts.push(`role: ${p.role || "system"}`);
    parts.push(`marker: ${p.marker || false}`);
    const tags = (p as Record<string, unknown>).tags;
    const legacyTag = (p as Record<string, unknown>).featureTag;
    if (Array.isArray(tags) && tags.length > 0) {
        parts.push(`tags: [${tags.join(", ")}]`);
    } else if (legacyTag) {
        parts.push(`featureTag: ${legacyTag} (legacy field)`);
    }
    parts.push(`content:\n${p.content || "(empty)"}`);
    return { name: "读取预设条目", success: true, data: parts.join("\n") };
}

async function handleCreateStoryPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync, createPreset } = await loadPresetStorage();
    const presets = loadPresets();
    if (presets.find((p) => p.name === args.name)) return { name: "创建剧情预设", success: false, error: "A preset with that name already exists" };

    const promptInputs = (args.prompts as Array<Record<string, unknown>>) || [];
    // Use the existing createPreset to get a skeleton carrying the default sampling
    // parameters (temperature, top_p and so on), so no field is left missing
    const newPreset = createPreset(args.name as string);
    newPreset.description = (args.description as string) || "";

    for (let i = 0; i < promptInputs.length; i++) {
        const input = promptInputs[i];
        const name = input.name as string;
        const isMarker = name.startsWith("◇ ");
        const identifier = isMarker && MARKER_NAMES[name]
            ? MARKER_NAMES[name]
            : (input.identifier as string) || name.replace(/[^\w一-鿿]/g, "").slice(0, 30) || `prompt_${i}`;
        const prompt = {
            identifier,
            name,
            role: (input.role as "system" | "user" | "assistant") || "system",
            content: isMarker ? "" : (input.content as string) || "",
            injection_position: 0,
            injection_depth: isMarker ? 0 : 4,
            enabled: true,
            marker: isMarker,
            system_prompt: false,
            forbid_overrides: false,
        };
        newPreset.prompts.push(prompt);
    }
    const firstSysIdx = newPreset.prompts.findIndex((p) => !p.marker && p.role === "system" && p.content);
    newPreset.prompts.forEach((p, i) => { p.system_prompt = i === firstSysIdx; });
    newPreset.prompt_order = newPreset.prompts
        .filter((p) => p.identifier)
        .map((p) => ({ identifier: p.identifier, enabled: true }));

    presets.push(newPreset);
    await savePresetsAsync(presets);
    return { name: "创建剧情预设", success: true, data: `Created story preset ${newPreset.name} (${newPreset.id}) with ${newPreset.prompts.length} prompt(s)` };
}

async function handleCloneBuiltinPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    if (presets.find((p) => p.name === args.name)) return { name: "克隆内置预设", success: false, error: "A preset with that name already exists" };

    const builtIn = presets.find((p) => p.builtIn);
    if (!builtIn) return { name: "克隆内置预设", success: false, error: "There is no built-in preset in the system to clone" };

    const copy = JSON.parse(JSON.stringify(builtIn)) as typeof builtIn;
    copy.id = `preset_${Date.now()}`;
    copy.name = args.name as string;
    copy.description = (args.description as string) || "";
    copy.builtIn = false;
    (copy as Record<string, unknown>).builtInVersion = undefined;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    presets.push(copy);
    await savePresetsAsync(presets);
    return { name: "克隆内置预设", success: true, data: `Cloned the built-in preset as "${copy.name}" (${copy.id}) with ${copy.prompts.length} prompt(s). Adjust entries afterwards with 更新预设条目 as needed` };
}

async function handleDuplicatePreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const source = presets.find((p) => p.name === args.sourceName || p.name.includes(args.sourceName as string));
    if (!source) return { name: "复制预设", success: false, error: `No source preset named ${args.sourceName}` };
    const newName = args.newName as string;
    if (presets.find((p) => p.name === newName)) return { name: "复制预设", success: false, error: `A preset named ${newName} already exists` };
    const copy = JSON.parse(JSON.stringify(source)) as typeof source;
    copy.id = `preset_${Date.now()}`;
    copy.name = newName;
    if (args.newDescription !== undefined) copy.description = args.newDescription as string;
    copy.builtIn = false;
    (copy as Record<string, unknown>).builtInVersion = undefined;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    presets.push(copy);
    await savePresetsAsync(presets);
    return { name: "复制预设", success: true, data: `Created "${copy.name}" (${copy.id}) as a copy of "${source.name}", with ${copy.prompts.length} prompt(s)` };
}

async function handleAddPresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "添加预设条目", success: false, error: `No preset with id ${args.presetId}` };

    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { name: "添加预设条目", success: false, error: "name must not be empty" };

    const preset = { ...presets[idx], prompts: [...(presets[idx].prompts || [])] };
    const existingIds = new Set(preset.prompts.map((prompt) => prompt.identifier).filter(Boolean));
    const isMarker = name.startsWith("◇ ");
    const content = isMarker ? "" : (typeof args.content === "string" ? args.content : "");
    const enabled = typeof args.enabled === "boolean" ? args.enabled : true;
    const prompt: Prompt = {
        identifier: createPresetPromptIdentifier(name, args.identifier, existingIds),
        name,
        role: (args.role as "system" | "user" | "assistant") || "system",
        content,
        injection_position: 0,
        injection_depth: isMarker ? 0 : 4,
        enabled,
        marker: isMarker,
        system_prompt: false,
        forbid_overrides: false,
    };

    if (Array.isArray(args.tags)) {
        const tags = args.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim());
        if (tags.length > 0) prompt.tags = tags;
    }

    const insertAfterIndex = typeof args.insertAfterIndex === "number" && Number.isFinite(args.insertAfterIndex)
        ? Math.trunc(args.insertAfterIndex)
        : null;
    if (insertAfterIndex !== null && insertAfterIndex >= 0 && insertAfterIndex < preset.prompts.length) {
        preset.prompts.splice(insertAfterIndex + 1, 0, prompt);
    } else {
        preset.prompts.push(prompt);
    }

    preset.prompt_order = rebuildPresetPromptOrder(preset.prompts, preset.prompt_order);
    preset.updatedAt = Date.now();
    presets[idx] = preset;
    await savePresetsAsync(presets);

    const promptIndex = preset.prompts.findIndex((item) => item.identifier === prompt.identifier);
    return { name: "添加预设条目", success: true, data: `Added prompt[${promptIndex}] "${prompt.name}" (${prompt.identifier})` };
}

async function handleUpdatePresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "更新预设条目", success: false, error: `No preset with id ${args.presetId}` };
    const preset = { ...presets[idx], prompts: [...presets[idx].prompts] };
    const promptIdx = args.promptIndex as number;
    if (promptIdx < 0 || promptIdx >= preset.prompts.length) return { name: "更新预设条目", success: false, error: `promptIndex is out of range (${preset.prompts.length} entries)` };
    const prompt = { ...preset.prompts[promptIdx] };
    const field = args.field as string;
    const value = args.value as string;
    if (field === "name") prompt.name = value;
    else if (field === "role") prompt.role = value as "system" | "user" | "assistant";
    else if (field === "content") prompt.content = value;
    else if (field === "identifier") prompt.identifier = value;
    else return { name: "更新预设条目", success: false, error: `Unsupported field: ${field}` };
    preset.prompts[promptIdx] = prompt;
    preset.updatedAt = Date.now();
    presets[idx] = preset;
    await savePresetsAsync(presets);
    return { name: "更新预设条目", success: true, data: `Updated ${field} on prompt[${promptIdx}]` };
}

async function handleUpdatePresetInfo(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "更新预设信息", success: false, error: `No preset with id ${args.presetId}` };
    const preset = { ...presets[idx] };
    if (args.name !== undefined) preset.name = args.name as string;
    if (args.description !== undefined) preset.description = args.description as string;
    preset.updatedAt = Date.now();
    presets[idx] = preset;
    await savePresetsAsync(presets);
    return { name: "更新预设信息", success: true, data: `Updated preset ${preset.name}` };
}

// ── Regex Handlers ────────────────────────────

async function handleListRegexGroups(): Promise<ToolResult> {
    const { loadRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    if (groups.length === 0) return { name: "列出正则组", success: true, data: "(no regex groups)" };
    const lines = groups.map((g) => `· ${g.name} (${g.rules?.length || 0} rule(s)) [id: ${g.id}]`);
    return { name: "列出正则组", success: true, data: `${groups.length} regex group(s):\n${lines.join("\n")}` };
}

async function handleReadRegexGroup(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const group = groups.find((g) => g.name === args.name || g.name.includes(args.name as string));
    if (!group) return { name: "读取正则组", success: false, error: `No regex group named ${args.name}` };
    const lines: string[] = [`id: ${group.id}`, `name: ${group.name}`, `rules:`];
    (group.rules || []).forEach((r) => {
        lines.push(`  [${r.id}] ${r.disabled ? "❌" : "✅"} ${r.scriptName}`);
        lines.push(`    find: ${r.findRegex}`);
        lines.push(`    replace: ${r.replaceString}`);
        lines.push(`    tags: ${JSON.stringify(r.tags || ["chat", "text"])}`);
        lines.push(`    placement: ${JSON.stringify(r.placement)}`);
    });
    return { name: "读取正则组", success: true, data: lines.join("\n") };
}

function normalizeMascotRegexRuleTags(tags: unknown): string[] {
    const values = Array.isArray(tags)
        ? tags.map((tag) => String(tag).trim()).filter(Boolean)
        : typeof tags === "string"
            ? tags.split(/[\s,，、/]+/).map((tag) => tag.trim()).filter(Boolean)
            : [];
    const has = (value: string) => values.includes(value);

    if (has("group_chat") || has("群聊")) return ["group_chat", "text"];
    if (has("story") || has("剧情") || has("故事") || has("故事模式")) return ["story"];
    if (has("offline") || has("线下")) return ["offline"];
    return ["chat", "text"];
}

function normalizeRule(r: Record<string, unknown>): Record<string, unknown> {
    return {
        id: r.id || `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        scriptName: r.scriptName || "",
        findRegex: r.findRegex || "",
        replaceString: r.replaceString || "",
        tags: normalizeMascotRegexRuleTags(r.tags),
        disabled: r.disabled ?? false,
        placement: r.placement || [2],
        markdownOnly: r.markdownOnly ?? false,
        promptOnly: r.promptOnly ?? false,
        substituteRegex: numberOption(r.substituteRegex, 0),
        runOnEdit: r.runOnEdit ?? false,
        trimStrings: r.trimStrings || [],
        minDepth: r.minDepth,
        maxDepth: r.maxDepth,
    };
}

async function handleCreateRegexGroup(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes, saveRegexes, createRegexGroup } = await import("./settings-storage");
    const groups = loadRegexes();
    if (groups.find((g) => g.name === args.name)) return { name: "创建正则组", success: false, error: "A regex group with that name already exists" };
    const newGroup = createRegexGroup(args.name as string);
    const rules = (args.rules as Array<Record<string, unknown>>) || [];
    newGroup.rules = rules.map(normalizeRule) as typeof newGroup.rules;
    groups.push(newGroup);
    saveRegexes(groups);
    return { name: "创建正则组", success: true, data: `Created regex group ${newGroup.name} (${newGroup.id}) with ${newGroup.rules.length} rule(s)` };
}

async function handleAddRegexRule(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes, saveRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const idx = groups.findIndex((g) => g.name === args.groupName);
    if (idx < 0) return { name: "添加正则规则", success: false, error: `No regex group named ${args.groupName}` };
    const group = { ...groups[idx], rules: [...(groups[idx].rules || [])] };
    const newRule = normalizeRule(args.rule as Record<string, unknown>);
    group.rules.push(newRule as typeof group.rules[number]);
    group.updatedAt = Date.now();
    groups[idx] = group;
    saveRegexes(groups);
    return { name: "添加正则规则", success: true, data: `Added rule ${newRule.id} to ${args.groupName}` };
}

async function handleUpdateRegexRule(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes, saveRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const idx = groups.findIndex((g) => g.name === args.groupName);
    if (idx < 0) return { name: "更新正则规则", success: false, error: `No regex group named ${args.groupName}` };
    const group = { ...groups[idx], rules: [...(groups[idx].rules || [])] };
    const ruleIdx = group.rules.findIndex((r) => r.id === args.ruleId);
    if (ruleIdx < 0) return { name: "更新正则规则", success: false, error: `No rule with id ${args.ruleId}` };
    const updates = { ...(args.updates as Record<string, unknown>) };
    if ("substituteRegex" in updates) updates.substituteRegex = numberOption(updates.substituteRegex, 0);
    if ("tags" in updates) updates.tags = normalizeMascotRegexRuleTags(updates.tags);
    group.rules[ruleIdx] = { ...group.rules[ruleIdx], ...updates } as typeof group.rules[number];
    group.updatedAt = Date.now();
    groups[idx] = group;
    saveRegexes(groups);
    return { name: "更新正则规则", success: true, data: `Updated rule ${args.ruleId}` };
}

// ── Navigation ────────────────────────────────

async function handleNavigate(args: Record<string, unknown>): Promise<ToolResult> {
    const page = args.page as string;
    const subpage = args.subpage as string | undefined;
    const { mascotNavigate } = await import("./mascot-events");
    mascotNavigate(page, subpage);
    return { name: "导航", success: true, data: `Navigated to ${page}${subpage ? `:${subpage}` : ""}` };
}

// ── Pack expansion management ────────────────

const EXPANDED_STORAGE_KEY = "mascot_expanded_packages_v1";
const MAX_EXPANDED = 2;

function normalizeExpandedPackageIds(ids: unknown): string[] {
    if (!Array.isArray(ids)) return [];
    const validIds = new Set(MASCOT_TOOL_PACKAGES.map((p) => p.id));
    const normalized: string[] = [];
    for (const id of ids) {
        if (typeof id !== "string" || !validIds.has(id)) continue;
        const existing = normalized.indexOf(id);
        if (existing >= 0) normalized.splice(existing, 1);
        normalized.push(id);
    }
    return normalized.slice(-MAX_EXPANDED);
}

export function loadExpandedPackages(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY)
            ?? window.sessionStorage.getItem(EXPANDED_STORAGE_KEY);
        if (!raw) return [];
        const ids = normalizeExpandedPackageIds(JSON.parse(raw));
        if (ids.length > 0 && !window.localStorage.getItem(EXPANDED_STORAGE_KEY)) {
            saveExpandedPackages(ids);
        }
        return ids;
    } catch { return []; }
}

export function saveExpandedPackages(ids: string[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(normalizeExpandedPackageIds(ids)));
    } catch {}
}

export function clearExpandedPackages(): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(EXPANDED_STORAGE_KEY);
        window.sessionStorage.removeItem(EXPANDED_STORAGE_KEY);
    } catch {}
}

export function touchExpandedPackage(currentIds: string[], packageId: string): string[] {
    const validIds = new Set(MASCOT_TOOL_PACKAGES.map((p) => p.id));
    if (!validIds.has(packageId)) return currentIds;
    const next = currentIds.filter((id) => id !== packageId);
    next.push(packageId);
    return next.slice(-MAX_EXPANDED);
}

/**
 * Pack label → package.
 *
 * The label is a live protocol token: the model types it in `[FetchTool:<label>]` and
 * mascot-chat-store.ts:450 resolves it through here. So the lookup is bilingual, like
 * every other parser in this migration — the labels are English now, but a model
 * steered by Chinese history still reaches for the legacy names, and the mascot's own
 * saved history is full of them. Matching is case-insensitive and trim-tolerant
 * because the model types these by hand.
 */
export function findPackageByLabel(label: string): MascotToolPackage | undefined {
    // The label comes straight out of what the model typed, so it may be anything.
    if (typeof label !== "string") return undefined;
    const wanted = label.trim().toLowerCase();
    if (!wanted) return undefined;
    return MASCOT_TOOL_PACKAGES.find(
        (p) => p.label.toLowerCase() === wanted
            || (p.legacyLabel && p.legacyLabel.toLowerCase() === wanted),
    );
}

// ── Desktop widget handlers ─────────────────────────
// Ported from upstream b41da23. Behaviour is unchanged; all user-visible strings and
// schema descriptions are translated. Tool names stay Chinese, like every other tool
// in this file — they are the identifiers the dispatcher switches on.

const DIY_HTML_MAX_LENGTH = 300_000;

async function widgetToolDeps() {
    const storage = await import("./widget-storage");
    const types = await import("./widget-types");
    const layoutStore = await import("./desktop-layout-storage");
    const { kvGet } = await import("./kv-db");
    const events = await import("./mascot-events");
    return { storage, types, layoutStore, kvGet, events };
}

type WidgetToolDeps = Awaited<ReturnType<typeof widgetToolDeps>>;

function readDesktopIconLayout(deps: WidgetToolDeps) {
    try {
        const raw = deps.kvGet(deps.layoutStore.ICON_LAYOUT_STORAGE_KEY);
        return deps.layoutStore.normalizeDesktopIconLayout(raw ? JSON.parse(raw) : null);
    } catch {
        return deps.layoutStore.normalizeDesktopIconLayout(null);
    }
}

function desktopPageIcons(deps: WidgetToolDeps, page: number) {
    const layout = readDesktopIconLayout(deps);
    const pageKey = deps.layoutStore.getDesktopPageKey(page);
    return layout[pageKey] ?? [];
}

/** Find a slot for `size` on the given page: validate row/col if supplied, otherwise scan for the first free spot. */
function resolveWidgetSpot(
    deps: WidgetToolDeps,
    size: string,
    page: number,
    row?: number,
    col?: number,
): { ok: true; row: number; col: number } | { ok: false; error: string } {
    const { GRID_ROWS, GRID_COLS } = deps.types;
    const widgets = deps.storage.loadWidgets();
    const grid = deps.storage.buildOccupancyGrid(desktopPageIcons(deps, page), widgets, page);
    const sizeKey = size as keyof typeof deps.types.WIDGET_SIZE_CELLS;
    if (typeof row === "number" && typeof col === "number") {
        if (!deps.storage.canPlaceWidget(grid, sizeKey, row, col)) {
            return { ok: false, error: `A ${size} widget does not fit at row ${row}, column ${col} on page ${page} (out of bounds or already occupied). Use the desktop layout tool to find a free slot.` };
        }
        return { ok: true, row, col };
    }
    for (let r = 1; r <= GRID_ROWS; r++) {
        for (let c = 1; c <= GRID_COLS; c++) {
            if (deps.storage.canPlaceWidget(grid, sizeKey, r, c)) return { ok: true, row: r, col: c };
        }
    }
    return { ok: false, error: `Page ${page} has no free slot big enough for ${size}. Try another page, or remove or move something first.` };
}

function diyTemplateDisplay(t: { id: string; name: string; size: string; mode: string }): string {
    return `· [DIY] ${t.name} (${t.size}, ${t.mode === "code" ? "code" : "image"} mode) [templateId: ${t.id}]`;
}

async function handleListWidgetCatalog(): Promise<ToolResult> {
    const deps = await widgetToolDeps();
    const lines: string[] = [];
    lines.push("Built-in widgets (type → name/size):");
    for (const entry of deps.types.WIDGET_CATALOG) {
        lines.push(`· ${entry.type} — ${entry.name} (${entry.size}${entry.track === "freestyle" ? ", freestyle" : ""})`);
    }
    const templates = deps.storage.loadDIYTemplates();
    lines.push("");
    if (templates.length === 0) {
        lines.push("DIY widget templates: (none yet)");
    } else {
        lines.push("DIY widget templates:");
        for (const t of templates) lines.push(diyTemplateDisplay(t));
    }
    return { name: "列出组件目录", success: true, data: lines.join("\n") };
}

async function handleReadDesktopLayout(args: Record<string, unknown>): Promise<ToolResult> {
    const deps = await widgetToolDeps();
    const page = numberOption(args.page, 1);
    if (page < 1 || page > 9) return { name: "查看桌面布局", success: false, error: `Invalid page number: ${page}` };
    const widgets = deps.storage.loadWidgets();
    const grid = deps.storage.buildOccupancyGrid(desktopPageIcons(deps, page), widgets, page);
    const lines: string[] = [];
    lines.push(`Page ${page}, 6x4 occupancy (W = widget, I = icon, · = free):`);
    grid.forEach((rowCells, r) => {
        const cells = rowCells.map((cell) => (cell === null ? "·" : cell.startsWith("widget:") ? "W" : "I"));
        lines.push(`row ${r + 1}  ${cells.join(" ")}`);
    });
    const pageWidgets = widgets.filter((w) => w.page === page);
    lines.push("");
    if (pageWidgets.length === 0) {
        lines.push("Widget instances on this page: (none)");
    } else {
        const templates = deps.storage.loadDIYTemplates();
        lines.push("Widget instances on this page:");
        for (const w of pageWidgets) {
            const diy = templates.find((t) => t.id === w.type);
            const builtin = deps.types.WIDGET_CATALOG.find((e) => e.type === w.type);
            const label = diy ? `${diy.name} (DIY)` : builtin ? builtin.name : w.type;
            lines.push(`· ${label} ${w.size} @ row ${w.row}, column ${w.col} [instance id: ${w.id}]`);
        }
    }
    const otherPages = Array.from(new Set(widgets.map((w) => w.page))).filter((p) => p !== page).sort();
    if (otherPages.length > 0) lines.push(`(Other pages also hold widgets: page ${otherPages.join(", ")})`);
    return { name: "查看桌面布局", success: true, data: lines.join("\n") };
}

async function handleCreateDiyWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const size = typeof args.size === "string" ? args.size : "";
    const htmlString = typeof args.htmlString === "string" ? args.htmlString : "";
    if (!name) return { name: "创建DIY组件", success: false, error: "name must not be empty" };
    if (!WIDGET_SIZE_ENUM.includes(size)) return { name: "创建DIY组件", success: false, error: `Invalid size: ${size}. Available: ${WIDGET_SIZE_ENUM.join("/")}` };
    if (!htmlString.trim()) return { name: "创建DIY组件", success: false, error: "htmlString must not be empty" };
    if (htmlString.length > DIY_HTML_MAX_LENGTH) return { name: "创建DIY组件", success: false, error: `htmlString is too long (${htmlString.length} characters, limit ${DIY_HTML_MAX_LENGTH})` };

    const deps = await widgetToolDeps();
    const templates = deps.storage.loadDIYTemplates();
    const id = `diy-${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    templates.push({ id, name, size: size as never, mode: "code", htmlString });
    deps.storage.saveDIYTemplates(templates);

    const autoPlace = args.autoPlace !== false;
    let placement = "Not placed on the desktop (autoPlace=false). Use the place-widget tool to put it there later.";
    if (autoPlace) {
        const page = numberOption(args.page, 1);
        const spot = resolveWidgetSpot(deps, size, page);
        if (spot.ok) {
            const widgets = deps.storage.placeWidget(deps.storage.loadWidgets(), {
                type: id, size: size as never, page, row: spot.row, col: spot.col,
            });
            deps.storage.saveWidgets(widgets);
            placement = `Placed automatically on page ${page} at row ${spot.row}, column ${spot.col}; the desktop has refreshed.`;
        } else {
            placement = `The template was created, but ${spot.error}`;
        }
    }
    deps.events.notifyDesktopWidgetsChanged();
    return { name: "创建DIY组件", success: true, data: `DIY widget "${name}" created [templateId: ${id}]. ${placement}` };
}

async function handleUpdateDiyWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const templateId = typeof args.templateId === "string" ? args.templateId : "";
    if (!templateId) return { name: "更新DIY组件", success: false, error: "templateId is missing" };
    const deps = await widgetToolDeps();
    const templates = deps.storage.loadDIYTemplates();
    const idx = templates.findIndex((t) => t.id === templateId);
    if (idx < 0) return { name: "更新DIY组件", success: false, error: `Template not found: ${templateId}. List the widget catalog to check the id.` };

    const target = { ...templates[idx] };
    const changed: string[] = [];
    if (typeof args.name === "string" && args.name.trim()) { target.name = args.name.trim(); changed.push("name"); }
    if (typeof args.htmlString === "string" && args.htmlString.trim()) {
        if (args.htmlString.length > DIY_HTML_MAX_LENGTH) return { name: "更新DIY组件", success: false, error: `htmlString is too long (limit ${DIY_HTML_MAX_LENGTH})` };
        target.htmlString = args.htmlString;
        changed.push("HTML");
    }
    const newSize = typeof args.size === "string" ? args.size : "";
    const sizeChanged = Boolean(newSize && newSize !== target.size);
    if (newSize && !WIDGET_SIZE_ENUM.includes(newSize)) return { name: "更新DIY组件", success: false, error: `Invalid size: ${newSize}` };
    if (sizeChanged) { target.size = newSize as never; changed.push("size"); }
    if (changed.length === 0) return { name: "更新DIY组件", success: false, error: "Nothing to update (pass at least one of name / size / htmlString)" };

    templates[idx] = target;
    deps.storage.saveDIYTemplates(templates);

    let instanceNote = "";
    if (sizeChanged) {
        const widgets = deps.storage.loadWidgets();
        const kept: typeof widgets = [];
        let dropped = 0;
        for (const w of widgets) {
            if (w.type !== templateId) { kept.push(w); continue; }
            const others = widgets.filter((o) => o.id !== w.id);
            const grid = deps.storage.buildOccupancyGrid(desktopPageIcons(deps, w.page), others, w.page);
            if (deps.storage.canPlaceWidget(grid, newSize as never, w.row, w.col)) {
                kept.push({ ...w, size: newSize as never });
            } else {
                dropped += 1;
            }
        }
        deps.storage.saveWidgets(kept);
        instanceNote = dropped > 0
            ? ` ${dropped} desktop instance(s) could not fit the new size in place and were taken off the desktop (the template remains; place it again when you want it back).`
            : " Desktop instances were resized in place.";
    }
    deps.events.notifyDesktopWidgetsChanged();
    return { name: "更新DIY组件", success: true, data: `Template "${target.name}" updated (${changed.join("/")}); the desktop reflects it immediately.${instanceNote}` };
}

async function handlePreviewDiyWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const templateId = typeof args.templateId === "string" ? args.templateId : "";
    if (!templateId) return { name: "预览DIY组件", success: false, error: "templateId is missing" };
    const deps = await widgetToolDeps();
    const template = deps.storage.loadDIYTemplates().find((t) => t.id === templateId);
    if (!template) return { name: "预览DIY组件", success: false, error: `Template not found: ${templateId}` };
    if (template.mode !== "code" || !template.htmlString) return { name: "预览DIY组件", success: false, error: "That template is not in code mode, so it cannot be previewed in a dialog yet" };
    const handled = deps.events.requestDiyWidgetPreview({
        templateId: template.id,
        name: template.name,
        size: template.size,
        htmlString: template.htmlString,
    });
    if (!handled) return { name: "预览DIY组件", success: false, error: "The preview dialog is not available right now (the mascot UI is not mounted)" };
    return { name: "预览DIY组件", success: true, data: `Opened a preview of "${template.name}" so the user can see it directly.` };
}

async function handlePlaceWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const type = typeof args.type === "string" ? args.type.trim() : "";
    if (!type) return { name: "摆放组件", success: false, error: "type is missing" };
    const deps = await widgetToolDeps();

    let size: string | null = null;
    let label = type;
    if (type.startsWith("diy-")) {
        const template = deps.storage.loadDIYTemplates().find((t) => t.id === type);
        if (!template) return { name: "摆放组件", success: false, error: `DIY template not found: ${type}` };
        size = template.size;
        label = template.name;
    } else {
        const entry = deps.types.WIDGET_CATALOG.find((e) => e.type === type);
        if (!entry) return { name: "摆放组件", success: false, error: `Unknown widget type: ${type}. List the widget catalog to see the available types.` };
        size = entry.size;
        label = entry.name;
    }

    const page = numberOption(args.page, 1);
    const row = typeof args.row === "number" ? args.row : undefined;
    const col = typeof args.col === "number" ? args.col : undefined;
    const spot = resolveWidgetSpot(deps, size, page, row, col);
    if (!spot.ok) return { name: "摆放组件", success: false, error: spot.error };

    const widgets = deps.storage.placeWidget(deps.storage.loadWidgets(), {
        type, size: size as never, page, row: spot.row, col: spot.col,
    });
    deps.storage.saveWidgets(widgets);
    deps.events.notifyDesktopWidgetsChanged();
    return { name: "摆放组件", success: true, data: `"${label}" placed on page ${page} at row ${spot.row}, column ${spot.col}; the desktop has refreshed.` };
}

async function handleRemoveDiyWidget(args: Record<string, unknown>): Promise<ToolResult> {
    const widgetId = typeof args.widgetId === "string" ? args.widgetId.trim() : "";
    const templateId = typeof args.templateId === "string" ? args.templateId.trim() : "";
    if (!widgetId && !templateId) return { name: "移除DIY组件", success: false, error: "Pass at least one of widgetId or templateId" };
    const deps = await widgetToolDeps();

    if (widgetId) {
        const widgets = deps.storage.loadWidgets();
        const target = widgets.find((w) => w.id === widgetId);
        if (!target) return { name: "移除DIY组件", success: false, error: `Widget instance not found: ${widgetId}` };
        if (!target.type.startsWith("diy-")) return { name: "移除DIY组件", success: false, error: "Only DIY widget instances may be removed; ask the user to rearrange built-in widgets themselves with a long press." };
        deps.storage.saveWidgets(deps.storage.removeWidget(widgets, widgetId));
        deps.events.notifyDesktopWidgetsChanged();
        return { name: "移除DIY组件", success: true, data: `Instance ${widgetId} was taken off the desktop (the template is kept).` };
    }

    if (!templateId.startsWith("diy-")) return { name: "移除DIY组件", success: false, error: "templateId must be a DIY template id starting with diy-" };
    const templates = deps.storage.loadDIYTemplates();
    const idx = templates.findIndex((t) => t.id === templateId);
    if (idx < 0) return { name: "移除DIY组件", success: false, error: `Template not found: ${templateId}` };
    const [removed] = templates.splice(idx, 1);
    deps.storage.saveDIYTemplates(templates);
    const widgets = deps.storage.loadWidgets();
    const remaining = widgets.filter((w) => w.type !== templateId);
    const removedInstances = widgets.length - remaining.length;
    deps.storage.saveWidgets(remaining);
    deps.events.notifyDesktopWidgetsChanged();
    return { name: "移除DIY组件", success: true, data: `Template "${removed.name}" deleted, along with ${removedInstances} desktop instance(s).` };
}
