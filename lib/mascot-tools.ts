// lib/mascot-tools.ts
// Scroll工具系统：7 个套件 + 36 个细粒度工具，支持文本协议和原生协议双轨。
//
// 套件设计（默认只暴露 loader，按需展开）：
//   - 角色卡套件 (character_pack)     — 3 个子工具
//   - 世界书套件 (worldbook_pack)     — 5 个子工具
//   - 预设套件 (preset_pack)          — 5 个子工具
//   - 正则套件 (regex_pack)           — 5 个子工具
//   - CSS套件 (css_pack)              — 3 个子工具
//   - 图像处理套件 (image_pack)       — 10 个子工具
//   - 导航工具 (navigate)             — 1 个独立工具（直接暴露）

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

// ── 通用类型 ────────────────────────────────────────────

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

// ── 工具参数 Schema 定义 ────────────────────────────────

// ── CSS 工具 ──
const CSS_LOCATION_ENUM = ["chat_app", "chat_session", "mascot_chat", "story", "music", "calendar"];

const SESSION_NAME_DESC = "（仅 location=chat_session 或 story 时使用）会话名：聊天室填角色名/备注名/群名；剧情会话填角色名/标题。不传则用当前页面正在打开的会话；当前页面没打开会话时，工具会返回可选会话列表让你确认。mascot_chat 不需要传。";

const READ_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "CSS 位置；不传则返回所有位置的状态概览" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    additionalProperties: false,
};

const OVERWRITE_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "CSS 位置" },
        css: { type: "string", description: "新的完整 CSS 内容，会替换该位置的所有 CSS" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    required: ["location", "css"],
    additionalProperties: false,
};

const CLEAR_CSS_SCHEMA = {
    type: "object",
    properties: {
        location: { type: "string", enum: CSS_LOCATION_ENUM, description: "CSS 位置" },
        sessionName: { type: "string", description: SESSION_NAME_DESC },
    },
    required: ["location"],
    additionalProperties: false,
};

// ── 图像处理工具 ──
const IMAGE_ASSET_KIND_ENUM = ["bubble", "icon", "texture", "background", "misc"];

const GENERATE_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        description: { type: "string", description: "要生成的图片素材描述。用于 CSS 的素材应明确用途、颜色和尺寸倾向。制作气泡/图标时，不要要求透明背景；应要求纯白背景/solid white background、不要透明棋盘格/checkerboard、不要示例文字/水印、主体四周留白，生成后再用「去底透明」转透明。制作九宫格气泡时，重要装饰应靠四角或尾部，避开顶部/底部横向中间、左右竖向中间和中心拉伸区。" },
        kind: { type: "string", enum: IMAGE_ASSET_KIND_ENUM, description: "素材类型：bubble=聊天气泡，icon=图标，texture=纹理，background=背景，misc=其他" },
        label: { type: "string", description: "素材名称，便于后续读取/裁切/上传" },
        characterId: { type: "string", description: "可选：使用某角色参考图时传角色 id" },
        useReferenceImage: { type: "boolean", description: "是否使用角色参考图；不确定不要传 true" },
    },
    required: ["description"],
    additionalProperties: false,
};

const LIST_USER_IMAGES_SCHEMA = {
    type: "object",
    properties: {
        limit: { type: "number", description: "最多返回多少张最近用户图片，默认 12，最大 20" },
    },
    additionalProperties: false,
};

const IMPORT_USER_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        sourceImageId: { type: "string", description: "用户图片 id，从「列出用户图片」获取；不传则默认导入 user_image_1" },
        messageOffset: { type: "number", description: "可选：第几条带图用户消息，0=最近；传 sourceImageId 时忽略" },
        imageIndex: { type: "number", description: "可选：同一条消息里的第几张图，0=第一张；传 sourceImageId 时忽略" },
        kind: { type: "string", enum: IMAGE_ASSET_KIND_ENUM, description: "素材类型：bubble=聊天气泡，icon=图标，texture=纹理，background=背景，misc=其他" },
        label: { type: "string", description: "导入后的素材名称" },
    },
    additionalProperties: false,
};

const CROP_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id，从「生成图像素材」或「列出读取素材」结果获取" },
        cropMode: { type: "string", enum: ["coordinates", "auto_trim"], description: "coordinates=按坐标裁切；auto_trim=自动裁掉透明/近似纯色边缘" },
        unit: { type: "string", enum: ["pixel", "percent"], description: "坐标单位；默认 pixel。percent 表示 0-100 百分比" },
        x: { type: "number", description: "裁切框左上角 x；coordinates 模式使用" },
        y: { type: "number", description: "裁切框左上角 y；coordinates 模式使用" },
        width: { type: "number", description: "裁切框宽度；coordinates 模式使用" },
        height: { type: "number", description: "裁切框高度；coordinates 模式使用" },
        padding: { type: "number", description: "裁切框额外保留边距，单位像素；auto_trim 时常用 2-12" },
        tolerance: { type: "number", description: "auto_trim 的边缘容差，0-255；默认 18，背景边缘不干净时可提高" },
        outputWidth: { type: "number", description: "可选：输出宽度。不传则使用裁切宽度" },
        outputHeight: { type: "number", description: "可选：输出高度。不传则使用裁切高度" },
        label: { type: "string", description: "新素材名称" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const REMOVE_IMAGE_BACKGROUND_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id" },
        tolerance: { type: "number", description: "底色容差，0-255；白底/浅灰底默认 36，仍有白边可提高到 45-70" },
        feather: { type: "number", description: "边缘羽化半径，0-4；默认 2，用来减轻白边锯齿" },
        backgroundColor: { type: "string", description: "可选：指定要去掉的底色，例如 #ffffff；不传则自动取四角平均色" },
        format: { type: "string", enum: ["png", "webp"], description: "输出格式；默认 png，保留透明度" },
        label: { type: "string", description: "新素材名称" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const CONVERT_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id" },
        format: { type: "string", enum: ["webp", "png", "jpeg"], description: "输出格式；CSS 素材优先 webp" },
        quality: { type: "number", description: "图片质量，0.1-1；webp/jpeg 有效，默认 0.82" },
        maxWidth: { type: "number", description: "最大宽度；不传则不放大也不缩小" },
        maxHeight: { type: "number", description: "最大高度；不传则不放大也不缩小" },
        label: { type: "string", description: "新素材名称" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const NINE_SLICE_CSS_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id；如果素材已上传图床，会自动使用 publicUrl" },
        url: { type: "string", description: "可选：直接传图片 URL；传了 url 时可不传 assetId" },
        selector: { type: "string", description: "要应用九宫格的 CSS 选择器，默认 .chat-bubble-role-assistant；用户气泡通常用 .chat-bubble-role-user" },
        sliceTop: { type: "number", description: "九宫格上切片像素；必须使用「校准九宫格」返回值" },
        sliceRight: { type: "number", description: "九宫格右切片像素；必须使用「校准九宫格」返回值" },
        sliceBottom: { type: "number", description: "九宫格下切片像素；必须使用「校准九宫格」返回值" },
        sliceLeft: { type: "number", description: "九宫格左切片像素；必须使用「校准九宫格」返回值" },
        displayTop: { type: "number", description: "实际显示的上边区宽度，单位 CSS 像素；必须使用「校准九宫格」返回值，不是源图 slice" },
        displayRight: { type: "number", description: "实际显示的右边区宽度，单位 CSS 像素；通常 12-48" },
        displayBottom: { type: "number", description: "实际显示的下边区宽度，单位 CSS 像素；通常 14-56" },
        displayLeft: { type: "number", description: "实际显示的左边区宽度，单位 CSS 像素；通常 12-48" },
        paddingTop: { type: "number", description: "文字离气泡外框顶部的留白，独立于九宫格保护区；文字可以进入保护区，必须使用「校准九宫格」返回值" },
        paddingRight: { type: "number", description: "文字离气泡外框右侧的留白，独立于九宫格保护区；文字可以进入保护区，必须使用「校准九宫格」返回值" },
        paddingBottom: { type: "number", description: "文字离气泡外框底部的留白，独立于九宫格保护区；文字可以进入保护区，必须使用「校准九宫格」返回值" },
        paddingLeft: { type: "number", description: "文字离气泡外框左侧的留白，独立于九宫格保护区；文字可以进入保护区，必须使用「校准九宫格」返回值" },
        minWidth: { type: "number", description: "左右保护区最低宽度；有「校准九宫格」返回值时必须照传，用来防止左右保护区互相挤压" },
        minHeight: { type: "number", description: "上下保护区最低高度；有「校准九宫格」返回值时必须照传，用来防止上下保护区互相挤压" },
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
        assetId: { type: "string", description: "要校准九宫格切线的素材 id" },
        selector: { type: "string", description: "要应用九宫格的 CSS 选择器，默认 .chat-bubble-role-assistant；用户气泡通常用 .chat-bubble-role-user" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

const READ_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "可选：素材 id。不传则列出最近 20 个素材" },
    },
    additionalProperties: false,
};

const UPLOAD_IMAGE_ASSET_SCHEMA = {
    type: "object",
    properties: {
        assetId: { type: "string", description: "素材 id" },
        filename: { type: "string", description: "上传文件名，可选" },
        expirationSeconds: { type: "number", description: "ImgBB 过期秒数；0=永久，60-15552000=定时过期。不传则用设置页默认值" },
    },
    required: ["assetId"],
    additionalProperties: false,
};

// ── 角色工具 ──
const READ_CHARACTER_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "角色名；不传则列出所有角色" },
    },
    additionalProperties: false,
};

const CREATE_CHARACTER_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "角色全名" },
        persona: { type: "string", description: "完整人设（7 段式 markdown）" },
        personality: { type: "string", description: "性格简介（80-200 字）" },
    },
    required: ["name", "persona", "personality"],
    additionalProperties: false,
};

const UPDATE_CHARACTER_FIELD_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "要修改的角色名" },
        field: { type: "string", enum: ["name", "persona", "personality"], description: "字段名" },
        value: { type: "string", description: "新值" },
    },
    required: ["name", "field", "value"],
    additionalProperties: false,
};

// ── 世界书工具 ──
const LIST_WORLDBOOKS_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "世界书名；不传则列出所有世界书" },
    },
    additionalProperties: false,
};

const READ_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "世界书名" },
        entryComment: { type: "string", description: "词条的 comment（备注名）" },
    },
    required: ["worldbook", "entryComment"],
    additionalProperties: false,
};

const CREATE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "世界书名；如果不存在会自动创建" },
        comment: { type: "string", description: "词条备注（用户可见的标签）" },
        key: { type: "string", description: "触发关键词，多个用逗号分隔" },
        content: { type: "string", description: "词条内容（推荐用 XML 标签包裹）" },
        constant: { type: "boolean", description: "是否常驻（true=每次都注入，false=关键词触发）" },
        position: { type: "string", enum: ["0", "1"], description: "0=角色描述前，1=角色描述后" },
    },
    required: ["worldbook", "comment", "key", "content"],
    additionalProperties: false,
};

const UPDATE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "世界书名" },
        entryUid: { type: "string", description: "词条 uid（从读取/列出结果里获取）" },
        field: { type: "string", enum: ["key", "content", "comment", "constant", "position"], description: "要更新的字段" },
        value: { type: "string", description: "新值（boolean 字段用 'true'/'false'，position 用 '0'/'1'）" },
    },
    required: ["worldbook", "entryUid", "field", "value"],
    additionalProperties: false,
};

const DELETE_WORLDBOOK_ENTRY_SCHEMA = {
    type: "object",
    properties: {
        worldbook: { type: "string", description: "世界书名" },
        entryUid: { type: "string", description: "词条 uid" },
    },
    required: ["worldbook", "entryUid"],
    additionalProperties: false,
};

// ── 预设工具 ──
const LIST_PRESETS_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

const READ_PRESET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "预设名" },
    },
    required: ["name"],
    additionalProperties: false,
};

const READ_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "预设 id（从读取预设结果获取）" },
        promptIndex: { type: "number", description: "条目索引（从读取预设结果获取，从 0 开始）" },
    },
    required: ["presetId", "promptIndex"],
    additionalProperties: false,
};

const DUPLICATE_PRESET_SCHEMA = {
    type: "object",
    properties: {
        sourceName: { type: "string", description: "要复制的源预设名" },
        newName: { type: "string", description: "副本的新名字" },
        newDescription: { type: "string", description: "副本描述（可选，默认沿用源预设的描述）" },
    },
    required: ["sourceName", "newName"],
    additionalProperties: false,
};

const CREATE_STORY_PRESET_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "预设名" },
        description: { type: "string", description: "预设描述" },
        prompts: {
            type: "array",
            description: "Prompt 列表，按板块顺序排列。每条至少有 name；marker 条目（◇ 开头）只需 name；普通条目传 name+content；assistant 角色额外加 role:'assistant'",
            items: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Prompt 名（◇ 开头会被识别为 marker）" },
                    role: { type: "string", enum: ["system", "user", "assistant"] },
                    content: { type: "string", description: "Prompt 内容；marker 无需 content" },
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
        name: { type: "string", description: "新预设名" },
        description: { type: "string", description: "新预设描述（可选，默认空）" },
    },
    required: ["name"],
    additionalProperties: false,
};

const UPDATE_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "预设 id" },
        promptIndex: { type: "number", description: "Prompt 在数组中的索引（从 0 开始）" },
        field: { type: "string", enum: ["name", "role", "content", "identifier"], description: "要更新的字段" },
        value: { type: "string", description: "新值" },
    },
    required: ["presetId", "promptIndex", "field", "value"],
    additionalProperties: false,
};

const ADD_PRESET_PROMPT_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "预设 id（从读取预设结果获取）" },
        name: { type: "string", description: "Prompt 名；◇ 开头会被识别为 marker 并清空 content" },
        role: { type: "string", enum: ["system", "user", "assistant"], description: "角色，默认 system" },
        content: { type: "string", description: "Prompt 内容；marker 条目可不传" },
        identifier: { type: "string", description: "可选 identifier；不传则自动生成且避开重复" },
        insertAfterIndex: { type: "number", description: "可选：插到该 promptIndex 后；不传则追加到末尾" },
        enabled: { type: "boolean", description: "是否启用，默认 true" },
        tags: {
            type: "array",
            description: "可选：通用预设的适用标签数组；不确定不要传",
            items: { type: "string" },
        },
    },
    required: ["presetId", "name"],
    additionalProperties: false,
};

const UPDATE_PRESET_INFO_SCHEMA = {
    type: "object",
    properties: {
        presetId: { type: "string", description: "预设 id" },
        name: { type: "string", description: "新的预设名（可选）" },
        description: { type: "string", description: "新的预设描述（可选）" },
    },
    required: ["presetId"],
    additionalProperties: false,
};

// ── 正则工具 ──
const LIST_REGEX_GROUPS_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

const READ_REGEX_GROUP_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "正则组名" },
    },
    required: ["name"],
    additionalProperties: false,
};

const REGEX_RULE_OBJ = {
    type: "object",
    properties: {
        scriptName: { type: "string", description: "规则名" },
        findRegex: { type: "string", description: "查找正则（/pattern/flags 格式）" },
        replaceString: { type: "string", description: "替换字符串（支持 $0/$1 等捕获组）" },
        tags: {
            type: "array",
            items: { type: "string", enum: ["chat", "text", "group_chat", "story", "offline"] },
            description: "必填适用范围，四选一：聊天=[\"chat\",\"text\"]；群聊=[\"group_chat\",\"text\"]；剧情/故事模式=[\"story\"]；线下=[\"offline\"]。不要留空。",
        },
        placement: { type: "array", items: { type: "number" }, description: "[1]=输入,[2]=输出(聊天/群聊/线下的状态栏·内心·状态值都在这),[5]=世界书,[6]=思维链/推理(仅剧情·漫卷模式获取,聊天等用不到)" },
        disabled: { type: "boolean" },
        markdownOnly: { type: "boolean", description: "仅显示层应用，不影响存储" },
        promptOnly: { type: "boolean", description: "仅 prompt 应用，不影响显示" },
        substituteRegex: { type: "string", enum: ["0", "1", "2"], description: "0=不替换 1=原始替换 2=转义后替换宏（如{{user}}）" },
    },
    required: ["scriptName", "findRegex", "replaceString"],
};

const CREATE_REGEX_GROUP_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "正则组名" },
        rules: { type: "array", items: REGEX_RULE_OBJ, description: "规则列表" },
    },
    required: ["name", "rules"],
    additionalProperties: false,
};

const ADD_REGEX_RULE_SCHEMA = {
    type: "object",
    properties: {
        groupName: { type: "string", description: "正则组名" },
        rule: REGEX_RULE_OBJ,
    },
    required: ["groupName", "rule"],
    additionalProperties: false,
};

const UPDATE_REGEX_RULE_SCHEMA = {
    type: "object",
    properties: {
        groupName: { type: "string", description: "正则组名" },
        ruleId: { type: "string", description: "规则 id" },
        updates: { ...REGEX_RULE_OBJ, required: [] as string[] },
    },
    required: ["groupName", "ruleId", "updates"],
    additionalProperties: false,
};

// ── 导航工具 ──
const NAVIGATE_SCHEMA = {
    type: "object",
    properties: {
        page: { type: "string", enum: ["chat", "characters", "story", "vnmode", "moments", "calendar", "music", "resources", "settings"], description: "页面名" },
        subpage: { type: "string", enum: ["presets", "worldbook", "regex", "api", "voice", "binding", "data", "identity"], description: "子页面（仅 settings 下有效）" },
    },
    required: ["page"],
    additionalProperties: false,
};

const IMAGE_ASSET_USAGE_GUIDE = [
    "图像处理套件用于给 CSS 主题制作可复用素材。推荐工作流：",
    "1. 先用「生成图像素材」得到素材 id 和预览。制作气泡/图标时，生图提示词里要写 plain solid white background / no checkerboard background / no sample text / no watermark / subject centered with margin，不要写 transparent background。",
    "2. 制作九宫格气泡时，生图提示词必须要求 decorative elements only near corners or the speech-tail area / keep the center and middle edges clean / avoid decorations in the top-center, bottom-center, left-middle, right-middle, and center stretch areas。猫头、蝴蝶结、花、爪子等大装饰不要放在横向或竖向中间。",
    "3. Image 2 这类模型常会把“透明背景”画成伪透明棋盘格：用白底生成后，再用「去底透明」把外缘连通的白底转透明，最后用「裁切素材」裁掉多余画布。",
    "4. 如果用户上传了现成素材，先用「列出用户图片」确认 sourceImageId，再用「导入用户图片为素材」导入素材库。",
    "5. 气泡/图标如果有多余边缘，优先用 cropMode=auto_trim 的「裁切素材」；结果不理想再按坐标微调。",
    "6. 写入 CSS 前先用「压缩转换素材」转 WebP，并限制尺寸，减少主题加载负担。",
    "7. 只有用户允许图床上传且设置了 ImgBB key 后，才用「上传图床」拿公开 URL。",
    "8. 图片气泡不允许自动猜九宫格参数。需要图片气泡时，先调用「校准九宫格」让用户在弹窗里手动拖切线；校准结果会返回 slice/display/padding 和 CSS。",
    "9. 「生成九宫格CSS」只接受已经校准好的完整参数；缺参数时会失败。不要用系统默认比例、不要自己瞎猜参数。",
    "10. 不要用 background-size: 100% 100% 或 background-size: cover 直接拉伸整张气泡图。",
    "11. 上传成功后只会得到图床URL；不要把 API Key 或 delete_url 写入 CSS。",
].join("\n");

// ── 套件定义 ────────────────────────────────────────────

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

// 导航是独立工具（不在套件里），直接暴露
export const MASCOT_NAVIGATE_TOOL: MascotSubTool = {
    name: "导航",
    description: "跳转到手机里指定页面。subpage 仅在 page=settings 时生效。",
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
    lines.push(`【${pkg.label}】动作详解`);
    lines.push(pkg.description);
    lines.push("");
    for (const tool of pkg.subTools) {
        lines.push(`◆ ${tool.name}`);
        lines.push(`  说明：${tool.description}`);
        const params = (tool.parameterSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>> | undefined;
        const required = (tool.parameterSchema as Record<string, unknown>).required as string[] | undefined;
        if (params && Object.keys(params).length > 0) {
            lines.push(`  参数：`);
            for (const [paramName, paramDef] of Object.entries(params)) {
                const isRequired = required?.includes(paramName) ? "必填" : "可选";
                const enumStr = paramDef.enum ? `（枚举：${(paramDef.enum as unknown[]).join("/")}）` : "";
                lines.push(`    · ${paramName} (${paramDef.type}, ${isRequired})${enumStr} — ${paramDef.description || ""}`);
            }
        } else {
            lines.push(`  参数：无`);
        }
        // 文本协议下展示 [执行动作:...] 语法；原生协议下 LLM 已经能直接看 tool schema，不需要这一行
        if (protocol === "text") {
            lines.push(`  调用：[执行动作:${tool.name}(${formatExampleArgs(tool.parameterSchema)})]`);
        }
        lines.push("");
    }
    if (pkg.usageGuide) {
        lines.push("===== 写作指南 =====");
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

// ── 原生协议下的工具定义 ─────────────────────────────────

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

/** 根据已展开的套件 id，构建原生 LLM 工具定义列表 */
export function getMascotNativeToolDefinitions(expandedPackageIds: string[] = []): LlmToolDefinition[] {
    const defs: LlmToolDefinition[] = [];

    // 导航工具：始终暴露
    defs.push({
        name: getMascotNativeToolName(MASCOT_NAVIGATE_TOOL.name),
        description: MASCOT_NAVIGATE_TOOL.description,
        parameters: MASCOT_NAVIGATE_TOOL.parameterSchema,
    });

    // 每个套件先暴露一个 loader（除非已展开）
    const expanded = new Set(expandedPackageIds);
    for (const pkg of MASCOT_TOOL_PACKAGES) {
        if (expanded.has(pkg.id)) {
            // 已展开 → 暴露所有子工具
            for (const tool of pkg.subTools) {
                defs.push({
                    name: getMascotNativeToolName(tool.name),
                    description: tool.description,
                    parameters: tool.parameterSchema,
                });
            }
        } else {
            // 未展开 → 暴露 loader
            // 注：properties 故意带一个无意义可选字段，避免某些 provider（如 Gemini）把空 args 视为未初始化的 protobuf Struct 而拒绝。
            defs.push({
                name: getMascotNativeLoaderName(pkg.id),
                description: `展开「${pkg.label}」动作说明。${pkg.description}`,
                parameters: {
                    type: "object",
                    properties: {
                        reason: { type: "string", description: "可选：为什么要展开这个套件" },
                    },
                    additionalProperties: false,
                },
            });
        }
    }
    return defs;
}

/** 原生工具名 → 中文工具名映射（用于将 LLM 调用转回中文工具名执行） */
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

// ── 工具执行器 ────────────────────────────────────────

export type MascotToolContext = {
    pageContext: MascotPageContext;
    history?: CssAssetUserImageHistoryMessage[];
};

/** 执行Scroll工具调用 */
export async function executeMascotToolCall(call: ToolCall, ctx: MascotToolContext): Promise<ToolResult> {
    try {
        switch (call.name) {
            // ─── CSS ───
            case "读取CSS": return await handleReadCss(call.args, ctx);
            case "覆写CSS": return await handleOverwriteCss(call.args, ctx);
            case "清除CSS": return await handleClearCss(call.args, ctx);

            // ─── 图像处理 ───
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

            // ─── 角色 ───
            case "读取角色": return await handleReadCharacter(call.args);
            case "创建角色": return await handleCreateCharacter(call.args);
            case "更新角色字段": return await handleUpdateCharacterField(call.args);

            // ─── 世界书 ───
            case "列出世界书": return await handleListWorldbooks(call.args);
            case "读取词条": return await handleReadWorldbookEntry(call.args);
            case "创建词条": return await handleCreateWorldbookEntry(call.args);
            case "更新词条": return await handleUpdateWorldbookEntry(call.args);
            case "删除词条": return await handleDeleteWorldbookEntry(call.args);

            // ─── 预设 ───
            case "列出预设": return await handleListPresets();
            case "读取预设": return await handleReadPreset(call.args);
            case "读取预设条目": return await handleReadPresetPrompt(call.args);
            case "创建剧情预设": return await handleCreateStoryPreset(call.args);
            case "克隆内置预设": return await handleCloneBuiltinPreset(call.args);
            case "复制预设": return await handleDuplicatePreset(call.args);
            case "添加预设条目": return await handleAddPresetPrompt(call.args);
            case "更新预设条目": return await handleUpdatePresetPrompt(call.args);
            case "更新预设信息": return await handleUpdatePresetInfo(call.args);

            // ─── 正则 ───
            case "列出正则组": return await handleListRegexGroups();
            case "读取正则组": return await handleReadRegexGroup(call.args);
            case "创建正则组": return await handleCreateRegexGroup(call.args);
            case "添加正则规则": return await handleAddRegexRule(call.args);
            case "更新正则规则": return await handleUpdateRegexRule(call.args);

            // ─── 导航 ───
            case "导航": return await handleNavigate(call.args);

            default:
                return { name: call.name, success: false, error: `未知工具：${call.name}` };
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
    chat_app: { label: "聊天应用 CSS", storageKey: "chat-app-custom-css" },
    chat_session: { label: "单独聊天室 CSS", needsSession: "chat" },
    mascot_chat: { label: "AI助手聊天室 CSS" },
    story: { label: "剧情模式 CSS", needsSession: "story" },
    music: { label: "音乐 CSS", storageKey: "music-custom-css" },
    calendar: { label: "日历 CSS", storageKey: "calendar-custom-css" },
};

async function handleListCssLocations(): Promise<ToolResult> {
    const { kvGet } = await import("./kv-db");
    const { getMascotSettingsSnapshot } = await import("./mascot-settings");
    const lines: string[] = [];
    for (const [key, info] of Object.entries(CSS_LOCATION_LABELS)) {
        let status = "—";
        if (key === "mascot_chat") {
            status = getMascotSettingsSnapshot().chatCustomCSS ? "已设置" : "空";
        } else if (info.storageKey) {
            const has = !!kvGet(info.storageKey);
            status = has ? "已设置" : "空";
        } else {
            status = "需在对应会话中查看";
        }
        lines.push(`· ${key} — ${info.label}：${status}`);
    }
    return { name: "列出CSS位置", success: true, data: lines.join("\n") };
}

/** 根据用户传入的 sessionName 或当前页面 context 解析出 chat session id。
 *  返回 { sessionId, displayName } 或 { error, choices } */
async function resolveChatSession(sessionName: string | undefined, ctx: MascotToolContext): Promise<
    | { sessionId: string; displayName: string }
    | { error: string; choices?: string[] }
> {
    const { loadChatSessions } = await import("./chat-storage");
    const { loadCharacters } = await import("./character-storage");
    const sessions = loadChatSessions();
    if (sessions.length === 0) return { error: "还没有任何聊天会话，先和角色发起聊天再来改 CSS" };
    const chars = loadCharacters();
    const charNameById = new Map(chars.map((c) => [c.id, c.name || ""]));

    const buildDisplayName = (s: typeof sessions[number]): string => {
        if (s.isGroup) return s.groupName || "群聊";
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
        return { error: `找不到匹配「${sessionName}」的聊天会话`, choices };
    }

    // 没传 sessionName：优先用当前页面的 sessionId
    const ctxSessionId = ctx.pageContext.fields.sessionId;
    if (ctxSessionId) {
        const session = sessions.find((s) => s.id === ctxSessionId);
        if (session) return { sessionId: session.id, displayName: buildDisplayName(session) };
    }
    // 没法定位 → 列出选项
    const choices = sessions.map((s) => buildDisplayName(s));
    return { error: "请用 sessionName 指定要操作哪个聊天会话", choices };
}

async function resolveStorySession(sessionName: string | undefined, ctx: MascotToolContext): Promise<
    | { sessionId: string; displayName: string }
    | { error: string; choices?: string[] }
> {
    const { loadStorySessions } = await import("./story-storage");
    const { loadCharacters } = await import("./character-storage");
    const sessions = loadStorySessions();
    if (sessions.length === 0) return { error: "还没有任何剧情会话" };
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
        return { error: `找不到匹配「${sessionName}」的剧情会话`, choices };
    }

    const ctxSessionId = ctx.pageContext.fields.storySessionId || ctx.pageContext.fields.sessionId;
    if (ctxSessionId) {
        const session = sessions.find((s) => s.id === ctxSessionId);
        if (session) return { sessionId: session.id, displayName: buildDisplayName(session) };
    }
    const choices = sessions.map((s) => buildDisplayName(s));
    return { error: "请用 sessionName 指定要操作哪个剧情会话", choices };
}

async function readCssAt(location: string, ctx: MascotToolContext, sessionName?: string): Promise<{ css: string; sessionId?: string; displayName?: string; note?: string; choices?: string[] }> {
    const { kvGet } = await import("./kv-db");
    if (location === "chat_app") return { css: kvGet("chat-app-custom-css") || "" };
    if (location === "mascot_chat") {
        const { getMascotSettingsSnapshot } = await import("./mascot-settings");
        const settings = getMascotSettingsSnapshot();
        return { css: settings.chatCustomCSS || "", displayName: settings.nickname || "AI助手" };
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
    throw new Error(`未知 CSS 位置：${location}`);
}

async function handleReadCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location) return await handleListCssLocations();
    if (!CSS_LOCATION_LABELS[location]) return { name: "读取CSS", success: false, error: `未知位置：${location}` };

    // 对 chat_session / story：sessionName 未传 + 当前页面也没打开对应会话 → 改为"发现模式"，返回会话列表（成功状态）
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
                    `位置：${location}（${CSS_LOCATION_LABELS[location].label}）`,
                    `当前没指定会话，下面是所有可改的会话：`,
                    ...resolved.choices.map((c) => `· ${c}`),
                    "",
                    `请向用户确认想改哪一个，然后用 sessionName 参数重新调用本工具读取。`,
                ];
                return { name: "读取CSS", success: true, data: parts.join("\n") };
            }
            if ("error" in resolved) {
                return { name: "读取CSS", success: false, error: resolved.error };
            }
        }
    }

    const result = await readCssAt(location, ctx, sessionName);
    // 传了 sessionName 但找不到匹配 → 真正的错误
    if (result.note && result.choices) {
        return {
            name: "读取CSS",
            success: false,
            error: `${result.note}。可选会话：${result.choices.map((c) => `「${c}」`).join("、")}`,
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
    parts.push(`位置：${location}（${CSS_LOCATION_LABELS[location].label}）`);
    if (result.displayName) parts.push(`会话：${result.displayName}`);
    if (result.note) parts.push(`注意：${result.note}`);
    parts.push(`\n=== 当前 CSS ===\n${result.css || "(空)"}`);
    parts.push(`\n=== 可用选择器和变量参考 ===\n${reference}`);
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
        return { displayName: getMascotSettingsSnapshot().nickname || "AI助手" };
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
            const err = new Error(`${resolved.error}${resolved.choices ? `。可选会话：${resolved.choices.map((c) => `「${c}」`).join("、")}` : ""}`);
            throw err;
        }
        const { loadChatSessions, saveChatSessions } = await import("./chat-storage");
        const sessions = loadChatSessions();
        const idx = sessions.findIndex((s) => s.id === resolved.sessionId);
        if (idx < 0) throw new Error("找不到当前会话");
        (sessions[idx] as Record<string, unknown>).customCSS = trimmed;
        saveChatSessions(sessions);
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: resolved.sessionId, css: trimmed } }));
        return { displayName: resolved.displayName };
    }
    if (location === "story") {
        const resolved = await resolveStorySession(sessionName, ctx);
        if ("error" in resolved) {
            const err = new Error(`${resolved.error}${resolved.choices ? `。可选会话：${resolved.choices.map((c) => `「${c}」`).join("、")}` : ""}`);
            throw err;
        }
        const { updateStorySession } = await import("./story-storage");
        updateStorySession(resolved.sessionId, { customCSS: trimmed });
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("story-session-css-updated", { detail: { sessionId: resolved.sessionId, css: trimmed } }));
        return { displayName: resolved.displayName };
    }
    throw new Error(`未知 CSS 位置：${location}`);
}

async function handleOverwriteCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const css = args.css as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location || !CSS_LOCATION_LABELS[location]) return { name: "覆写CSS", success: false, error: `未知位置：${location}` };
    const result = await writeCssAt(location, css, ctx, sessionName);
    return { name: "覆写CSS", success: true, data: `已覆写 ${location}${result.displayName ? `（${result.displayName}）` : ""} 的 CSS，共 ${css.length} 字符` };
}

async function handleClearCss(args: Record<string, unknown>, ctx: MascotToolContext): Promise<ToolResult> {
    const location = args.location as string;
    const sessionName = args.sessionName as string | undefined;
    if (!location || !CSS_LOCATION_LABELS[location]) return { name: "清除CSS", success: false, error: `未知位置：${location}` };
    const result = await writeCssAt(location, "", ctx, sessionName);
    return { name: "清除CSS", success: true, data: `已清除 ${location}${result.displayName ? `（${result.displayName}）` : ""} 的 CSS` };
}

// ── Character Handlers ──────────────────────────

async function handleReadCharacter(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    const name = args.name as string | undefined;
    if (!name) {
        if (chars.length === 0) return { name: "读取角色", success: true, data: "（没有角色）" };
        const lines = chars.map((c) => `· ${c.name || "(未命名)"} [id: ${c.id}]`);
        return { name: "读取角色", success: true, data: `共 ${chars.length} 个角色：\n${lines.join("\n")}` };
    }
    const char = chars.find((c) => c.name === name);
    if (!char) return { name: "读取角色", success: false, error: `找不到角色：${name}` };
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
    if (chars.find((c) => c.name === args.name)) return { name: "创建角色", success: false, error: "已存在同名角色" };
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
    return { name: "创建角色", success: true, data: `已创建角色 ${newChar.name} (${newChar.id})` };
}

async function handleUpdateCharacterField(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadCharacters, saveCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    const idx = chars.findIndex((c) => c.name === args.name);
    if (idx < 0) return { name: "更新角色字段", success: false, error: `找不到角色：${args.name}` };
    const field = args.field as string;
    const value = args.value as string;
    const char = { ...chars[idx] } as Record<string, unknown>;
    if (field === "name" || field === "persona" || field === "personality") {
        char[field] = value;
    } else {
        return { name: "更新角色字段", success: false, error: `不支持的字段：${field}` };
    }
    char.updatedAt = new Date().toISOString();
    chars[idx] = char as typeof chars[number];
    saveCharacters(chars);
    return { name: "更新角色字段", success: true, data: `已更新 ${args.name} 的 ${field}` };
}

// ── Worldbook Handlers ──────────────────────────

async function handleListWorldbooks(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const name = args.name as string | undefined;
    if (!name) {
        if (books.length === 0) return { name: "列出世界书", success: true, data: "（没有世界书）" };
        const lines = books.map((b) => `· ${b.name}（${b.entries?.length || 0} 条词条）`);
        return { name: "列出世界书", success: true, data: `共 ${books.length} 个世界书：\n${lines.join("\n")}` };
    }
    const book = books.find((b) => b.name === name);
    if (!book) return { name: "列出世界书", success: false, error: `找不到世界书：${name}` };
    if (!book.entries || book.entries.length === 0) return { name: "列出世界书", success: true, data: `世界书 ${name} 暂无词条` };
    const lines = book.entries.map((e) => `· [${e.uid}] ${e.comment || "(无备注)"} — keys: ${e.key || "(无)"} ${e.constant ? "[常驻]" : ""} ${e.position === 0 ? "(前置)" : "(后置)"}`);
    return { name: "列出世界书", success: true, data: `世界书 ${name} 共 ${book.entries.length} 条词条：\n${lines.join("\n")}` };
}

async function handleReadWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const book = books.find((b) => b.name === args.worldbook);
    if (!book) return { name: "读取词条", success: false, error: `找不到世界书：${args.worldbook}` };
    const entry = book.entries?.find((e) => e.comment === args.entryComment || e.uid === args.entryComment);
    if (!entry) return { name: "读取词条", success: false, error: `找不到词条：${args.entryComment}` };
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
    return { name: "创建词条", success: true, data: `已在《${args.worldbook}》创建词条「${args.comment}」(uid: ${newEntry.uid})` };
}

async function handleUpdateWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks, saveWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const bookIdx = books.findIndex((b) => b.name === args.worldbook);
    if (bookIdx < 0) return { name: "更新词条", success: false, error: `找不到世界书：${args.worldbook}` };
    const book = { ...books[bookIdx] };
    const entries = [...(book.entries || [])];
    const entryIdx = entries.findIndex((e) => e.uid === args.entryUid);
    if (entryIdx < 0) return { name: "更新词条", success: false, error: `找不到词条 uid：${args.entryUid}` };
    const entry = { ...entries[entryIdx] };
    const field = args.field as string;
    const value = args.value as string;
    if (field === "key") entry.key = value;
    else if (field === "content") entry.content = value;
    else if (field === "comment") entry.comment = value;
    else if (field === "constant") entry.constant = value === "true";
    else if (field === "position") entry.position = parseInt(value, 10) || 0;
    else return { name: "更新词条", success: false, error: `不支持的字段：${field}` };
    entries[entryIdx] = entry;
    book.entries = entries;
    book.updatedAt = Date.now();
    books[bookIdx] = book;
    saveWorldBooks(books);
    return { name: "更新词条", success: true, data: `已更新词条 ${args.entryUid} 的 ${field}` };
}

async function handleDeleteWorldbookEntry(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadWorldBooks, saveWorldBooks } = await import("./settings-storage");
    const books = loadWorldBooks();
    const bookIdx = books.findIndex((b) => b.name === args.worldbook);
    if (bookIdx < 0) return { name: "删除词条", success: false, error: `找不到世界书：${args.worldbook}` };
    const book = { ...books[bookIdx] };
    const before = book.entries?.length || 0;
    book.entries = (book.entries || []).filter((e) => e.uid !== args.entryUid);
    if (book.entries.length === before) return { name: "删除词条", success: false, error: `找不到词条 uid：${args.entryUid}` };
    book.updatedAt = Date.now();
    books[bookIdx] = book;
    saveWorldBooks(books);
    return { name: "删除词条", success: true, data: `已删除词条 ${args.entryUid}` };
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
    if (presets.length === 0) return { name: "列出预设", success: true, data: "（没有预设）" };
    const lines = presets.map((p) => {
        const featureTag = (p.prompts || []).some((x) => (x as Record<string, unknown>).featureTag);
        return `· ${p.name}${p.builtIn ? "（内置）" : ""} — ${featureTag ? "通用型" : "剧情型"} [id: ${p.id}]`;
    });
    return { name: "列出预设", success: true, data: `共 ${presets.length} 个预设：\n${lines.join("\n")}` };
}

async function handleReadPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets } = await loadPresetStorage();
    const presets = loadPresets();
    const preset = presets.find((p) => p.name === args.name || p.name.includes(args.name as string));
    if (!preset) return { name: "读取预设", success: false, error: `找不到预设：${args.name}` };
    const parts: string[] = [];
    parts.push(`id: ${preset.id}`);
    parts.push(`name: ${preset.name}`);
    parts.push(`description: ${preset.description || ""}`);
    parts.push(`builtIn: ${preset.builtIn || false}`);
    parts.push(`prompts (${preset.prompts?.length || 0} 条，仅显示摘要；查看完整内容请用「读取预设条目」)：`);
    (preset.prompts || []).forEach((p, i) => {
        const segs: string[] = [`[${i}] ${p.name || p.identifier || "(无名)"}`];
        if (p.marker) segs.push("(marker)");
        const tags = (p as Record<string, unknown>).tags;
        const legacyTag = (p as Record<string, unknown>).featureTag;
        if (Array.isArray(tags) && tags.length > 0) {
            segs.push(`tags=[${tags.join(",")}]`);
        } else if (legacyTag) {
            segs.push(`tag=${legacyTag}`);
        }
        if (p.role && p.role !== "system") segs.push(`role=${p.role}`);
        // 摘要：仅前 100 字
        if (p.content) {
            const snippet = p.content.replace(/\s+/g, " ").slice(0, 100);
            segs.push(`— ${snippet}${p.content.length > 100 ? "..." : ""}`);
        } else if (!p.marker) {
            segs.push("(无内容)");
        }
        parts.push(segs.join(" "));
    });
    return { name: "读取预设", success: true, data: parts.join("\n") };
}

async function handleReadPresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets } = await loadPresetStorage();
    const presets = loadPresets();
    const preset = presets.find((p) => p.id === args.presetId);
    if (!preset) return { name: "读取预设条目", success: false, error: `找不到预设 id：${args.presetId}` };
    const idx = args.promptIndex as number;
    const p = preset.prompts?.[idx];
    if (!p) return { name: "读取预设条目", success: false, error: `promptIndex ${idx} 越界（共 ${preset.prompts?.length || 0} 条）` };
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
        parts.push(`featureTag: ${legacyTag}（旧字段）`);
    }
    parts.push(`content:\n${p.content || "(空)"}`);
    return { name: "读取预设条目", success: true, data: parts.join("\n") };
}

async function handleCreateStoryPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync, createPreset } = await loadPresetStorage();
    const presets = loadPresets();
    if (presets.find((p) => p.name === args.name)) return { name: "创建剧情预设", success: false, error: "已存在同名预设" };

    const promptInputs = (args.prompts as Array<Record<string, unknown>>) || [];
    // 用现成的 createPreset 拿带默认采样参数（temperature/top_p 等）的骨架，避免缺字段
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
    return { name: "创建剧情预设", success: true, data: `已创建剧情预设 ${newPreset.name} (${newPreset.id})，含 ${newPreset.prompts.length} 条 prompt` };
}

async function handleCloneBuiltinPreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    if (presets.find((p) => p.name === args.name)) return { name: "克隆内置预设", success: false, error: "已存在同名预设" };

    const builtIn = presets.find((p) => p.builtIn);
    if (!builtIn) return { name: "克隆内置预设", success: false, error: "系统里没有内置预设，无法克隆" };

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
    return { name: "克隆内置预设", success: true, data: `已克隆内置预设为「${copy.name}」(${copy.id})，含 ${copy.prompts.length} 条 prompt。后续按需用「更新预设条目」改` };
}

async function handleDuplicatePreset(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const source = presets.find((p) => p.name === args.sourceName || p.name.includes(args.sourceName as string));
    if (!source) return { name: "复制预设", success: false, error: `找不到源预设：${args.sourceName}` };
    const newName = args.newName as string;
    if (presets.find((p) => p.name === newName)) return { name: "复制预设", success: false, error: `已存在同名预设：${newName}` };
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
    return { name: "复制预设", success: true, data: `已基于「${source.name}」创建副本「${copy.name}」(${copy.id})，含 ${copy.prompts.length} 条 prompt` };
}

async function handleAddPresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "添加预设条目", success: false, error: `找不到预设 id：${args.presetId}` };

    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { name: "添加预设条目", success: false, error: "name 不能为空" };

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
    return { name: "添加预设条目", success: true, data: `已添加 prompt[${promptIndex}]「${prompt.name}」(${prompt.identifier})` };
}

async function handleUpdatePresetPrompt(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "更新预设条目", success: false, error: `找不到预设 id：${args.presetId}` };
    const preset = { ...presets[idx], prompts: [...presets[idx].prompts] };
    const promptIdx = args.promptIndex as number;
    if (promptIdx < 0 || promptIdx >= preset.prompts.length) return { name: "更新预设条目", success: false, error: `promptIndex 越界（共 ${preset.prompts.length} 条）` };
    const prompt = { ...preset.prompts[promptIdx] };
    const field = args.field as string;
    const value = args.value as string;
    if (field === "name") prompt.name = value;
    else if (field === "role") prompt.role = value as "system" | "user" | "assistant";
    else if (field === "content") prompt.content = value;
    else if (field === "identifier") prompt.identifier = value;
    else return { name: "更新预设条目", success: false, error: `不支持的字段：${field}` };
    preset.prompts[promptIdx] = prompt;
    preset.updatedAt = Date.now();
    presets[idx] = preset;
    await savePresetsAsync(presets);
    return { name: "更新预设条目", success: true, data: `已更新 prompt[${promptIdx}] 的 ${field}` };
}

async function handleUpdatePresetInfo(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadPresets, savePresetsAsync } = await loadPresetStorage();
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === args.presetId);
    if (idx < 0) return { name: "更新预设信息", success: false, error: `找不到预设 id：${args.presetId}` };
    const preset = { ...presets[idx] };
    if (args.name !== undefined) preset.name = args.name as string;
    if (args.description !== undefined) preset.description = args.description as string;
    preset.updatedAt = Date.now();
    presets[idx] = preset;
    await savePresetsAsync(presets);
    return { name: "更新预设信息", success: true, data: `已更新预设 ${preset.name}` };
}

// ── Regex Handlers ────────────────────────────

async function handleListRegexGroups(): Promise<ToolResult> {
    const { loadRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    if (groups.length === 0) return { name: "列出正则组", success: true, data: "（没有正则组）" };
    const lines = groups.map((g) => `· ${g.name}（${g.rules?.length || 0} 条规则）[id: ${g.id}]`);
    return { name: "列出正则组", success: true, data: `共 ${groups.length} 个正则组：\n${lines.join("\n")}` };
}

async function handleReadRegexGroup(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const group = groups.find((g) => g.name === args.name || g.name.includes(args.name as string));
    if (!group) return { name: "读取正则组", success: false, error: `找不到正则组：${args.name}` };
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
    if (groups.find((g) => g.name === args.name)) return { name: "创建正则组", success: false, error: "已存在同名正则组" };
    const newGroup = createRegexGroup(args.name as string);
    const rules = (args.rules as Array<Record<string, unknown>>) || [];
    newGroup.rules = rules.map(normalizeRule) as typeof newGroup.rules;
    groups.push(newGroup);
    saveRegexes(groups);
    return { name: "创建正则组", success: true, data: `已创建正则组 ${newGroup.name} (${newGroup.id})，含 ${newGroup.rules.length} 条规则` };
}

async function handleAddRegexRule(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes, saveRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const idx = groups.findIndex((g) => g.name === args.groupName);
    if (idx < 0) return { name: "添加正则规则", success: false, error: `找不到正则组：${args.groupName}` };
    const group = { ...groups[idx], rules: [...(groups[idx].rules || [])] };
    const newRule = normalizeRule(args.rule as Record<string, unknown>);
    group.rules.push(newRule as typeof group.rules[number]);
    group.updatedAt = Date.now();
    groups[idx] = group;
    saveRegexes(groups);
    return { name: "添加正则规则", success: true, data: `已向 ${args.groupName} 添加规则 ${newRule.id}` };
}

async function handleUpdateRegexRule(args: Record<string, unknown>): Promise<ToolResult> {
    const { loadRegexes, saveRegexes } = await import("./settings-storage");
    const groups = loadRegexes();
    const idx = groups.findIndex((g) => g.name === args.groupName);
    if (idx < 0) return { name: "更新正则规则", success: false, error: `找不到正则组：${args.groupName}` };
    const group = { ...groups[idx], rules: [...(groups[idx].rules || [])] };
    const ruleIdx = group.rules.findIndex((r) => r.id === args.ruleId);
    if (ruleIdx < 0) return { name: "更新正则规则", success: false, error: `找不到规则 id：${args.ruleId}` };
    const updates = { ...(args.updates as Record<string, unknown>) };
    if ("substituteRegex" in updates) updates.substituteRegex = numberOption(updates.substituteRegex, 0);
    if ("tags" in updates) updates.tags = normalizeMascotRegexRuleTags(updates.tags);
    group.rules[ruleIdx] = { ...group.rules[ruleIdx], ...updates } as typeof group.rules[number];
    group.updatedAt = Date.now();
    groups[idx] = group;
    saveRegexes(groups);
    return { name: "更新正则规则", success: true, data: `已更新规则 ${args.ruleId}` };
}

// ── Navigation ────────────────────────────────

async function handleNavigate(args: Record<string, unknown>): Promise<ToolResult> {
    const page = args.page as string;
    const subpage = args.subpage as string | undefined;
    const { mascotNavigate } = await import("./mascot-events");
    mascotNavigate(page, subpage);
    return { name: "导航", success: true, data: `已跳转到 ${page}${subpage ? `:${subpage}` : ""}` };
}

// ── 套件展开管理 ─────────────────────────────

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
