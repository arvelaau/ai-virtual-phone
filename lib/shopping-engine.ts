import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { loadApiConfigs, loadBindingConfig } from "./settings-storage";
import type { CheckPhoneShoppingProduct, CheckPhoneShoppingTone } from "./checkphone-config";
import type { ApiConfig } from "./settings-types";
import type { ShoppingCatalog, ShoppingCategory, ShoppingRefreshResult, ShoppingSearchResponse } from "./shopping-types";
import type { LLMMessage } from "./llm-prompt-assembler";

export const SHOPPING_RECOMMENDATION_CATEGORIES: Array<Pick<ShoppingCategory, "id" | "title" | "subtitle">> = [
  { id: "digital", title: "Tech & Gadgets", subtitle: "Small devices, desk gear, smart accessories" },
  { id: "home", title: "Home & Living", subtitle: "Storage, scents, kitchenware, a lived-in feel" },
  { id: "style", title: "Fashion & Accessories", subtitle: "Clothes, bags, shoes and everyday outfits" },
  { id: "beauty", title: "Beauty & Personal Care", subtitle: "Skincare, makeup, body care, grooming tools" },
  { id: "food", title: "Food & Drink", subtitle: "Snacks, coffee, tea and light bites" },
  { id: "hobby", title: "Stationery & Hobbies", subtitle: "Paper goods, crafts, reading, sport, travel bits" },
];

/**
 * Category titles as they were taught before the English migration, mapped to the id they
 * still belong to. The title is what the model echoes back in `[Category]`, and a stored
 * catalog generated before the migration also carries them, so both have to keep
 * resolving. Frozen literals on purpose — never rebuild these from the array above.
 */
const LEGACY_CATEGORY_TITLES: Record<string, string> = {
  "数码好物": "digital",
  "生活家居": "home",
  "穿搭配饰": "style",
  "美妆个护": "beauty",
  "食品饮品": "food",
  "文具兴趣": "hobby",
};

/**
 * Resolve a `[Category]` value written by the model, or a title read back off a stored
 * catalog, to its category. Accepts the English titles taught now and the Chinese titles
 * taught before. Returns null when nothing matches, so callers decide their own fallback.
 *
 * Exported because `shopping-storage.ts:normalizeCategory` matches stored titles against
 * this same list — a second copy there would desync the moment either side is reworded.
 */
export function findShoppingCategoryByTitle(
  value: string,
): Pick<ShoppingCategory, "id" | "title" | "subtitle"> | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const byTitle = SHOPPING_RECOMMENDATION_CATEGORIES.find(
    category => category.title.toLowerCase() === normalized.toLowerCase(),
  );
  if (byTitle) return byTitle;
  const legacyId = LEGACY_CATEGORY_TITLES[normalized];
  return legacyId
    ? SHOPPING_RECOMMENDATION_CATEGORIES.find(category => category.id === legacyId) ?? null
    : null;
}

// This engine calls sendLLMRequest with a NULL preset (see generateShoppingCatalog and
// generateShoppingSearchResults), so `output_language_rule` from the preset assembler
// never reaches it. The language rule has to be stated locally or the model simply
// mirrors whatever language the stored prompt happens to be in.
const SHOPPING_OUTPUT_LANGUAGE_RULE =
  "Always write in English. The search term and anything else quoted to you are information about what to sell — never a reference for which language to write in.";

export const DEFAULT_SHOPPING_REFRESH_PROMPT = [
  "<shopping_refresh_instruction>",
  "You are generating the home-page category recommendation feed for a standalone shopping app.",
  SHOPPING_OUTPUT_LANGUAGE_RULE,
  "",
  "Requirements:",
  "- Generate only browsable, buyable home-page recommendations. Never generate recently viewed, saved items, cart or orders.",
  "- Do not write characters, personas, memories, plot or narration.",
  "- Cover these 6 categories, 5 to 7 products each:",
  ...SHOPPING_RECOMMENDATION_CATEGORIES.map(category => `  - ${category.title}: ${category.subtitle}`),
  "- Product name, shop, price, blurb and detail must all be specific, like something you could really buy.",
  "- [Detail] describes the product itself: material, size, what it is for, how it feels, when you would use it. Never why you recommend it, and never a system explanation.",
  "- [Icon] is one clear, attractive emoji or symbol closely tied to the product.",
  "",
  "Output format:",
  "#Recommendation1",
  "[Category]Tech & Gadgets",
  "[Name]product name",
  "[Shop]shop name",
  "[Price]price",
  "[Blurb]short blurb for the list view",
  "[Detail]product detail text",
  "[Icon]product icon",
  "",
  "#Recommendation2",
  "[Category]Tech & Gadgets",
  "[Name]product name",
  "[Shop]shop name",
  "[Price]price",
  "[Blurb]short blurb for the list view",
  "[Detail]product detail text",
  "[Icon]product icon",
  "",
  "Rules:",
  "- Every product needs a [Category], and it must be one of the 6 category names above, spelled exactly as written there.",
  "- Output 5 to 7 products per category, numbering every product continuously: #Recommendation1, #Recommendation2, #Recommendation3.",
  "- Never output #RecentlyViewed, #Saved, #Cart or #Orders; those come from what the user does.",
  "- IMPORTANT: the words after each tag in the format above are PLACEHOLDERS. Replace them with real product content — never output the placeholder word itself.",
  "- Output only the block format above. No Markdown, no explanation, no code block, no JSON.",
  "</shopping_refresh_instruction>",
].join("\n");

export const DEFAULT_SHOPPING_SEARCH_PROMPT = [
  "<shopping_search_instruction>",
  "You are generating the search-result product feed for the search term \"{{query}}\" in a standalone shopping app.",
  SHOPPING_OUTPUT_LANGUAGE_RULE,
  "",
  "Requirements:",
  "- Generate only browsable, buyable products that are strongly relevant to \"{{query}}\".",
  "- Do not generate home-page category recommendations, recently viewed, saved items, cart or orders.",
  "- Do not write characters, personas, memories, plot or narration.",
  "- Span different price points, styles and use cases, but keep every product tied to the search term.",
  "- Product name, shop, price, blurb and detail must all be specific, like something you could really buy.",
  "- [Detail] describes the product itself: material, size, what it is for, how it feels, when you would use it. Never why you recommend it, and never a system explanation.",
  "- [Icon] is one clear, attractive emoji or symbol closely tied to the product.",
  "",
  "Output format:",
  "#SearchResult1",
  "[Name]product name",
  "[Shop]shop name",
  "[Price]price",
  "[Blurb]short blurb for the list view",
  "[Detail]product detail text",
  "[Icon]product icon",
  "",
  "#SearchResult2",
  "[Name]product name",
  "[Shop]shop name",
  "[Price]price",
  "[Blurb]short blurb for the list view",
  "[Detail]product detail text",
  "[Icon]product icon",
  "",
  "Rules:",
  "- Generate 12 to 18 search results.",
  "- Number every product continuously: #SearchResult1, #SearchResult2, #SearchResult3.",
  "- Never output #Recommendation, #RecentlyViewed, #Saved, #Cart or #Orders; those come from other features or from what the user does.",
  "- IMPORTANT: the words after each tag in the format above are PLACEHOLDERS. Replace them with real product content — never output the placeholder word itself.",
  "- Output only the block format above. No Markdown, no explanation, no code block, no JSON.",
  "</shopping_search_instruction>",
].join("\n");

// ── Frozen pre-migration defaults ──
//
// Both prompts above are STORED in KV as user settings (shopping-storage.ts writes them
// into the default state), so translating the constants alone would never reach anyone who
// already has shopping state — exactly the trap documented for interview-magazine-engine.
// shopping-storage.ts recognises these byte-for-byte and upgrades them to the new defaults.
//
// The category lines are rebuilt from a FROZEN local copy, never from
// SHOPPING_RECOMMENDATION_CATEGORIES: translating that array would silently rewrite these
// literals, and then they would no longer match what is actually in anyone's KV store —
// which is precisely how the interview-magazine host-name migration nearly broke.
const LEGACY_CN_CATEGORY_LINES = [
  "  - 数码好物：小设备、桌面装备、智能配件",
  "  - 生活家居：收纳、香氛、餐厨与居家质感",
  "  - 穿搭配饰：服饰、包袋、鞋履和日常搭配",
  "  - 美妆个护：护肤、彩妆、身体护理和仪容工具",
  "  - 食品饮品：零食、咖啡、茶饮和轻食补给",
  "  - 文具兴趣：纸品、手作、阅读、运动和旅行小物",
];

export const SHOPPING_CN_DEFAULT_REFRESH_PROMPT = [
  "<shopping_refresh_instruction>",
  "你正在为一个独立购物 App 生成首页分类推荐商品流。",
  "",
  "要求：",
  "- 只生成可以浏览和购买的首页推荐商品，不要生成最近浏览、收藏、购物车或订单。",
  "- 不要写角色、人设、记忆、剧情或旁白。",
  "- 必须按以下 6 个分类推荐，每个分类 5 到 7 条商品：",
  ...LEGACY_CN_CATEGORY_LINES,
  "- 商品名称、店铺、价格、说明和详情都要具体，像真实可购买的商品。",
  "- [详情] 写商品本身的材质、规格、用途、质感、适用场景，不要写推荐理由或系统解释。",
  "- [图标] 用单个直观、美观、和商品强相关的 emoji 或符号。",
  "",
  "输出格式：",
  "#推荐1",
  "[分类]数码好物",
  "[名称]商品名称",
  "[店铺]店铺名称",
  "[价格]价格",
  "[说明]列表短说明",
  "[详情]商品详情文本",
  "[图标]商品图标",
  "",
  "#推荐2",
  "[分类]数码好物",
  "[名称]商品名称",
  "[店铺]店铺名称",
  "[价格]价格",
  "[说明]列表短说明",
  "[详情]商品详情文本",
  "[图标]商品图标",
  "",
  "规则：",
  "- 每条商品都必须有 [分类]，且分类名只能使用上面 6 个分类名。",
  "- 每个分类连续输出 5 到 7 条商品，所有商品使用连续编号，例如 #推荐1、#推荐2、#推荐3。",
  "- 不要输出 #最近浏览、#收藏、#购物车、#订单；这些由用户交互产生。",
  "- 示例字段值都是占位说明，实际输出必须替换成真实商品内容。",
  "- 只输出上述块格式内容，不要输出 Markdown、解释、代码块或 JSON。",
  "</shopping_refresh_instruction>",
].join("\n");

export const SHOPPING_CN_DEFAULT_SEARCH_PROMPT = [
  "<shopping_search_instruction>",
  "你正在为一个独立购物 App 的搜索词“{{query}}”生成搜索结果商品流。",
  "",
  "要求：",
  "- 只生成与搜索词“{{query}}”高度相关、可以浏览和购买的商品。",
  "- 不要生成首页分类推荐、最近浏览、收藏、购物车或订单。",
  "- 不要写角色、人设、记忆、剧情或旁白。",
  "- 商品要覆盖不同价位、不同风格和不同使用场景，但都必须围绕搜索词。",
  "- 商品名称、店铺、价格、说明和详情都要具体，像真实可购买的商品。",
  "- [详情] 写商品本身的材质、规格、用途、质感、适用场景，不要写推荐理由或系统解释。",
  "- [图标] 用单个直观、美观、和商品强相关的 emoji 或符号。",
  "",
  "输出格式：",
  "#搜索结果1",
  "[名称]商品名称",
  "[店铺]店铺名称",
  "[价格]价格",
  "[说明]列表短说明",
  "[详情]商品详情文本",
  "[图标]商品图标",
  "",
  "#搜索结果2",
  "[名称]商品名称",
  "[店铺]店铺名称",
  "[价格]价格",
  "[说明]列表短说明",
  "[详情]商品详情文本",
  "[图标]商品图标",
  "",
  "规则：",
  "- 生成 12 到 18 条搜索结果。",
  "- 所有商品使用连续编号，例如 #搜索结果1、#搜索结果2、#搜索结果3。",
  "- 不要输出 #推荐、#最近浏览、#收藏、#购物车、#订单；这些由其他功能或用户交互产生。",
  "- 示例字段值都是占位说明，实际输出必须替换成真实商品内容。",
  "- 只输出上述块格式内容，不要输出 Markdown、解释、代码块或 JSON。",
  "</shopping_search_instruction>",
].join("\n");

type ParsedRecommendationBlock = {
  order: number;
  fields: Record<string, string>;
};

function resolveShoppingApiConfig(): ApiConfig | null {
  const configs = loadApiConfigs();
  const binding = loadBindingConfig();
  if (binding.globalDefaults.apiConfigId) {
    return configs.find(config => config.id === binding.globalDefaults.apiConfigId) ?? null;
  }
  return configs[0] ?? null;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function deriveTone(index: number): CheckPhoneShoppingTone {
  const tones: CheckPhoneShoppingTone[] = ["ivory", "mist", "blush", "graphite"];
  return tones[index % tones.length];
}

function stripJsonWrapperNoise(text: string): string {
  return text
    .replace(/^\s*```(?:json|text|markdown)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseTaggedFields(source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let activeKey = "";
  const lines = source.replace(/\r/g, "").split("\n");

  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      activeKey = match[1].trim();
      fields[activeKey] = match[2].trim();
      continue;
    }
    if (activeKey && line.trim()) {
      fields[activeKey] = `${fields[activeKey]}\n${line.trim()}`.trim();
    }
  }

  return fields;
}

// Block headings and field tags, English first (what is taught now) then the Chinese form
// taught before the migration. Both are accepted everywhere: a stored prompt that has not
// been upgraded yet still teaches Chinese, and the model can answer in either.
const RECOMMENDATION_BLOCK_LABELS = ["Recommendation", "推荐"];
const SEARCH_RESULT_BLOCK_LABELS = ["SearchResult", "Search Result", "搜索结果", "推荐"];

const FIELD_ALIASES = {
  category: ["Category", "分类"],
  name: ["Name", "名称"],
  shop: ["Shop", "店铺"],
  price: ["Price", "价格"],
  blurb: ["Blurb", "说明"],
  detail: ["Detail", "详情"],
  icon: ["Icon", "图标"],
} as const;

/** Read one logical field out of a parsed block, trying each alias in order. */
function pickField(fields: Record<string, string>, key: keyof typeof FIELD_ALIASES): string {
  const aliases = FIELD_ALIASES[key];
  for (const alias of aliases) {
    if (fields[alias]) return fields[alias];
  }
  // Second pass, case-insensitive: models write `[name]` about as often as `[Name]`.
  const lowered = aliases.map(alias => alias.toLowerCase());
  for (const [rawKey, value] of Object.entries(fields)) {
    if (value && lowered.includes(rawKey.trim().toLowerCase())) return value;
  }
  return "";
}

function extractProductBlocks(rawOutput: string, labels: string[]): ParsedRecommendationBlock[] {
  const source = stripJsonWrapperNoise(rawOutput);
  const labelPattern = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // `\s*` before the number: `#Recommendation 1` reads natural in English, where the
  // Chinese form never had a space. Case-insensitive for the same reason.
  const matches = [...source.matchAll(new RegExp(`^#\\s*(?:${labelPattern})\\s*(\\d+)\\s*$`, "gim"))];
  const allHeadings = [...source.matchAll(/^#\s*\S.*$/gm)];
  return matches.map((current, index) => {
    const start = (current.index ?? 0) + current[0].length;
    const next = allHeadings.find((match) => (match.index ?? 0) > (current.index ?? 0));
    const end = next?.index ?? source.length;
    return {
      order: Number(current[1]) || index + 1,
      fields: parseTaggedFields(source.slice(start, end).trim()),
    };
  });
}

function resolveCategory(value: string): Pick<ShoppingCategory, "id" | "title" | "subtitle"> {
  return findShoppingCategoryByTitle(cleanText(value, 80)) ?? SHOPPING_RECOMMENDATION_CATEGORIES[0];
}

function parseProduct(block: ParsedRecommendationBlock, index: number): { category: Pick<ShoppingCategory, "id" | "title" | "subtitle">; product: CheckPhoneShoppingProduct | null } {
  const fields = block.fields;
  const category = resolveCategory(pickField(fields, "category"));
  const title = cleanText(pickField(fields, "name"), 200);
  const merchantLabel = cleanText(pickField(fields, "shop"), 120);
  const priceLabel = cleanText(pickField(fields, "price"), 80);
  const subtitle = cleanText(pickField(fields, "blurb") || pickField(fields, "detail") || pickField(fields, "name"), 400);
  const detail = cleanText(pickField(fields, "detail") || subtitle, 1200);
  const previewIcon = cleanText(pickField(fields, "icon"), 8);

  if (!title || !merchantLabel || !priceLabel || !subtitle || !detail || !previewIcon) {
    return { category, product: null };
  }

  const signature = `${category.title}|${title}|${merchantLabel}|${priceLabel}|${previewIcon}`;
  return {
    category,
    product: {
      id: `rec_${hashString(signature)}`,
      title,
      merchantLabel,
      priceLabel,
      tagLabel: category.title,
      subtitle,
      detail,
      previewIcon,
      tone: deriveTone(index),
    },
  };
}

function parseSearchProduct(block: ParsedRecommendationBlock, query: string, index: number): CheckPhoneShoppingProduct | null {
  const fields = block.fields;
  const title = cleanText(pickField(fields, "name"), 200);
  const merchantLabel = cleanText(pickField(fields, "shop"), 120);
  const priceLabel = cleanText(pickField(fields, "price"), 80);
  const subtitle = cleanText(pickField(fields, "blurb") || pickField(fields, "detail") || pickField(fields, "name"), 400);
  const detail = cleanText(pickField(fields, "detail") || subtitle, 1200);
  const previewIcon = cleanText(pickField(fields, "icon"), 8);
  const tagLabel = cleanText(pickField(fields, "category"), 80) || `Search: ${query}`;

  if (!title || !merchantLabel || !priceLabel || !subtitle || !detail || !previewIcon) {
    return null;
  }

  const signature = `${query}|${title}|${merchantLabel}|${priceLabel}|${previewIcon}`;
  return {
    id: `search_${hashString(signature)}`,
    title,
    merchantLabel,
    priceLabel,
    tagLabel,
    subtitle,
    detail,
    previewIcon,
    tone: deriveTone(index),
  };
}

/** Exported for round-trip testing: pure, and otherwise only reachable behind a network call. */
export function parseShoppingCatalog(rawOutput: string): ShoppingCatalog | null {
  const grouped = new Map<string, ShoppingCategory>();
  for (const category of SHOPPING_RECOMMENDATION_CATEGORIES) {
    grouped.set(category.id, { ...category, items: [] });
  }

  const products = extractProductBlocks(rawOutput, RECOMMENDATION_BLOCK_LABELS)
    .sort((a, b) => a.order - b.order)
    .map(parseProduct)
    .filter((entry): entry is { category: Pick<ShoppingCategory, "id" | "title" | "subtitle">; product: CheckPhoneShoppingProduct } => Boolean(entry.product));

  for (const { category, product } of products) {
    const group = grouped.get(category.id) ?? { ...category, items: [] };
    if (!group.items.some(item => item.id === product.id)) {
      group.items.push(product);
    }
    grouped.set(category.id, group);
  }

  const categories = SHOPPING_RECOMMENDATION_CATEGORIES
    .map(category => grouped.get(category.id))
    .filter((category): category is ShoppingCategory => Boolean(category && category.items.length > 0));

  const recommendations = categories.flatMap(category => category.items);
  return recommendations.length > 0 ? { categories, recommendations } : null;
}

/** Exported for round-trip testing — see parseShoppingCatalog. */
export function parseShoppingSearchResult(rawOutput: string, query: string): CheckPhoneShoppingProduct[] {
  const seen = new Set<string>();
  const results: CheckPhoneShoppingProduct[] = [];
  const products = extractProductBlocks(rawOutput, SEARCH_RESULT_BLOCK_LABELS)
    .sort((a, b) => a.order - b.order)
    .map((block, index) => parseSearchProduct(block, query, index))
    .filter((item): item is CheckPhoneShoppingProduct => Boolean(item));

  for (const product of products) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    results.push(product);
  }

  return results;
}

function applySearchPromptTemplate(prompt: string, query: string): string {
  const template = prompt || DEFAULT_SHOPPING_SEARCH_PROMPT;
  // {{搜索词}} stays: a user who customised the search prompt before the migration may
  // still have that placeholder in their stored copy.
  const filled = template
    .replaceAll("{{query}}", query)
    .replaceAll("{{搜索词}}", query)
    .replaceAll("{{keyword}}", query);
  return filled.includes(query)
    ? filled
    : `${filled}\n\nCurrent search term: ${query}`;
}

export async function generateShoppingCatalog(refreshPrompt: string): Promise<ShoppingRefreshResult> {
  const apiConfig = resolveShoppingApiConfig();
  if (!apiConfig) {
    return { catalog: null, error: "No usable API Configuration found. Please assign one in Settings -> Binding Manager -> Global config.", rawOutput: "" };
  }

  try {
    const rawOutput = await sendLLMRequest(
      apiConfig,
      null,
      [{ role: "user", content: refreshPrompt || DEFAULT_SHOPPING_REFRESH_PROMPT }],
      [],
      { characterName: "Shopping App" },
      { skipOutputRegex: true, appId: "shopping" },
    );

    if (!rawOutput.trim()) {
      return { catalog: null, error: "The LLM returned an empty response.", rawOutput };
    }

    const catalog = parseShoppingCatalog(rawOutput);
    if (!catalog) {
      return { catalog: null, error: "No valid category recommendation blocks were found.", rawOutput };
    }

    return { catalog, rawOutput };
  } catch (error) {
    return {
      catalog: null,
      error: error instanceof Error ? error.message : "Generation failed.",
      rawOutput: "",
    };
  }
}

export async function generateShoppingSearchResults(query: string, searchPrompt: string): Promise<ShoppingSearchResponse> {
  const normalizedQuery = cleanText(query, 80);
  if (!normalizedQuery) {
    return { result: null, error: "Enter a search term.", rawOutput: "" };
  }

  const apiConfig = resolveShoppingApiConfig();
  if (!apiConfig) {
    return { result: null, error: "No usable API Configuration found. Please assign one in Settings -> Binding Manager -> Global config.", rawOutput: "" };
  }

  try {
    const rawOutput = await sendLLMRequest(
      apiConfig,
      null,
      [{ role: "user", content: applySearchPromptTemplate(searchPrompt, normalizedQuery) }],
      [],
      { characterName: "Shopping App" },
      { skipOutputRegex: true, appId: "shopping_search" },
    );

    if (!rawOutput.trim()) {
      return { result: null, error: "The LLM returned an empty response.", rawOutput };
    }

    const items = parseShoppingSearchResult(rawOutput, normalizedQuery);
    if (items.length === 0) {
      return { result: null, error: "No valid search-result product blocks were found.", rawOutput };
    }

    return {
      result: {
        query: normalizedQuery,
        items,
        generatedAt: new Date().toISOString(),
      },
      rawOutput,
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : "Search failed.",
      rawOutput: "",
    };
  }
}

export async function previewShoppingPromptPayload(
  mode: "catalog" | "search",
  params?: { query?: string; refreshPrompt?: string; searchPrompt?: string },
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const apiConfig = resolveShoppingApiConfig();
  if (!apiConfig) throw new Error("No usable API Configuration found. Please assign one in Settings -> Binding Manager -> Global config.");
  const prompt = mode === "search"
    ? applySearchPromptTemplate(params?.searchPrompt || DEFAULT_SHOPPING_SEARCH_PROMPT, params?.query?.trim() || "gift")
    : (params?.refreshPrompt || DEFAULT_SHOPPING_REFRESH_PROMPT);
  const messages = [{ role: "user" as const, content: prompt, _debugMeta: { marker: mode === "search" ? "shopping_search" : "shopping_catalog" } }];
  return {
    messages: previewMessagesForApi(apiConfig, null, messages),
    characterName: mode === "search" ? "Shopping Search" : "Shopping App",
    model: apiConfig.defaultModel,
    presetName: "(no preset)",
  };
}
