"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  CreditCard,
  Heart,
  HeartHandshake,
  Home,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Star,
  Trash2,
  Truck,
  WalletCards,
  type LucideIcon,
} from "lucide-react";

import { CheckPhoneBilingualText, normalizeCheckPhoneText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { BlackMarketApp } from "@/components/shopping/black-market-app";
import { ConfirmDialog } from "@/components/ui";
import { splitBilingualText } from "@/lib/bilingual-text";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { createOrGetSession, pushChatMessage } from "@/lib/chat-storage";
import {
  DEFAULT_SHOPPING_REFRESH_PROMPT,
  DEFAULT_SHOPPING_SEARCH_PROMPT,
  generateShoppingCatalog,
  generateShoppingSearchResults,
  SHOPPING_RECOMMENDATION_CATEGORIES,
} from "@/lib/shopping-engine";
import {
  buildShoppingPaymentRequestItems,
  createShoppingPaymentRequestId,
  formatShoppingPaymentAmountForHistory,
  formatShoppingPaymentRequestItems,
  type ShoppingPaymentStatus,
} from "@/lib/shopping-payment-request";
import { createDefaultShoppingState, loadShoppingState, saveShoppingState, SHOPPING_STATE_UPDATED_EVENT } from "@/lib/shopping-storage";
import type { ShoppingCartItem, ShoppingCategory, ShoppingOrder, ShoppingProduct, ShoppingShippingEvent, ShoppingState } from "@/lib/shopping-types";
import {
  formatWalletAmount,
  getWalletBalance,
  loadWalletState,
  payWithWalletAccount,
  WALLET_BALANCE_ACCOUNT_ID,
  WALLET_UPDATED_EVENT,
} from "@/lib/wallet-storage";
import type { WalletState } from "@/lib/wallet-types";
import { DEFAULT_PAYMENT_REQUEST_LABEL } from "@/lib/rich-tag-builders";

type ShoppingAppProps = {
  onClose: (isBusy?: boolean) => void;
  visible?: boolean;
  onIdle?: () => void;
  onBusyChange?: (isBusy: boolean) => void;
};

type ShoppingTabId = "home" | "orders" | "cart" | "account";
type ShoppingSectionSearchTabId = Exclude<ShoppingTabId, "home">;

type ShoppingProductDetail = ShoppingProduct & {
  quantityLabel?: string;
  detailLabel?: string;
};

type ShoppingTranslationPreview = {
  original: string;
  translated: string;
};

type ShoppingPromptTab = "refresh" | "search";
type ShoppingSettingsTab = "prompts" | "shipping";

type ShoppingPromptDrafts = {
  refreshPrompt: string;
  searchPrompt: string;
  deliveryMinMinutes: number;
  deliveryMaxMinutes: number;
};

type ShoppingCartFeedback = {
  id: number;
};

type ResolvedShoppingShipping = {
  statusLabel: string;
  currentStage?: ShoppingShippingEvent["status"];
  timeline: ShoppingShippingEvent[];
};

const DEFAULT_DELIVERY_MIN_MINUTES = 60;
const DEFAULT_DELIVERY_MAX_MINUTES = 180;

const SHOPPING_TABS: Array<{ id: ShoppingTabId; label: string; icon: LucideIcon }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "orders", label: "Orders", icon: Truck },
  { id: "cart", label: "Cart", icon: ShoppingCart },
  { id: "account", label: "Favorites", icon: Heart },
];

const SHOPPING_SECTION_SEARCH_PLACEHOLDERS: Record<ShoppingSectionSearchTabId, string> = {
  orders: "Search orders",
  cart: "Search cart",
  account: "Search favorites",
};

function isShoppingSectionSearchTab(tab: ShoppingTabId): tab is ShoppingSectionSearchTabId {
  return tab !== "home";
}

function parseShoppingAmount(label: string): number {
  const match = label.replace(/[¥￥元,\s]/g, "").match(/-?\d+(?:\.\d+)?/);
  const amount = match ? Number(match[0]) : 0;
  return Number.isFinite(amount) ? amount : 0;
}

function parseShoppingQuantity(label?: string): number {
  const match = label?.match(/\d+/);
  if (!match) return 1;
  const quantity = Number(match[0]);
  return Number.isFinite(quantity) && quantity >= 0 ? Math.round(quantity) : 1;
}

function formatShoppingAmount(amount: number): string {
  const safeAmount = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return `¥${Number.isInteger(safeAmount) ? safeAmount : safeAmount.toFixed(2).replace(/\.00$/, "")}`;
}

function formatShoppingDateTime(date: Date): string {
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getWalletCardDisplayNumber(value: string): string {
  const tail = value.replace(/\D/g, "").slice(-4);
  return tail ? `Ending in ${tail}` : value;
}

function getStableShoppingHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function normalizeDeliveryMinutes(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(10080, Math.max(1, Math.round(value)));
}

function normalizeShoppingSearchValue(value: string): string {
  return normalizeCheckPhoneText(value).trim().toLowerCase();
}

function isBlackMarketSearchTrigger(value: string): boolean {
  return normalizeShoppingSearchValue(value).replace(/\s+/g, " ") === "black market";
}

function shoppingFieldsMatchSearch(fields: Array<string | undefined>, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return fields
    .map(field => normalizeShoppingSearchValue(field ?? ""))
    .join(" ")
    .includes(normalizedQuery);
}

function productMatchesSearch(
  item: ShoppingProduct | ShoppingCartItem | ShoppingOrder["items"][number],
  normalizedQuery: string,
): boolean {
  return shoppingFieldsMatchSearch([
    item.title,
    item.merchantLabel,
    item.priceLabel,
    item.subtitle,
    item.detail,
    item.previewIcon,
    "tagLabel" in item ? item.tagLabel : undefined,
    "quantityLabel" in item ? item.quantityLabel : undefined,
  ], normalizedQuery);
}

function orderMatchesSearch(order: ShoppingOrder, normalizedQuery: string, nowMs: number): boolean {
  const shipping = resolveOrderShipping(order, nowMs);
  return shoppingFieldsMatchSearch([
    order.id,
    order.statusLabel,
    shipping.statusLabel,
    order.timeLabel,
    order.totalLabel,
    order.merchantLabel,
    order.summary,
    order.note,
    order.paymentCardLabel,
    order.paidAt,
    ...shipping.timeline.flatMap(event => [event.label, event.timeLabel]),
    ...order.items.flatMap(item => [
      item.title,
      item.merchantLabel,
      item.priceLabel,
      item.quantityLabel,
      item.subtitle,
      item.detail,
      item.previewIcon,
    ]),
  ], normalizedQuery);
}

function normalizeDeliverySettings(settings: Pick<ShoppingState["settings"], "deliveryMinMinutes" | "deliveryMaxMinutes">) {
  const min = normalizeDeliveryMinutes(settings.deliveryMinMinutes, DEFAULT_DELIVERY_MIN_MINUTES);
  const max = normalizeDeliveryMinutes(settings.deliveryMaxMinutes, DEFAULT_DELIVERY_MAX_MINUTES);
  return {
    deliveryMinMinutes: Math.min(min, max),
    deliveryMaxMinutes: Math.max(min, max),
  };
}

function pickShoppingDurationMinutes(orderId: string, minMinutes: number, maxMinutes: number): number {
  const range = Math.max(0, maxMinutes - minMinutes);
  if (range === 0) return minMinutes;
  return minMinutes + (getStableShoppingHash(`${orderId}:delivery`) % (range + 1));
}

function addShoppingMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function buildShippingTimeline(orderId: string, orderedAt: Date, settings: ShoppingState["settings"]): ShoppingShippingEvent[] {
  const deliverySettings = normalizeDeliverySettings(settings);
  const totalMinutes = pickShoppingDurationMinutes(
    orderId,
    deliverySettings.deliveryMinMinutes,
    deliverySettings.deliveryMaxMinutes,
  );
  const shippedOffset = Math.max(1, Math.floor(totalMinutes * 0.18));
  const deliveringOffset = Math.max(shippedOffset, Math.floor(totalMinutes * 0.55));
  const timeline = [
    { status: "ordered" as const, label: "已下单", date: orderedAt },
    { status: "shipped" as const, label: "已发货", date: addShoppingMinutes(orderedAt, Math.min(shippedOffset, totalMinutes)) },
    { status: "delivering" as const, label: "配送中", date: addShoppingMinutes(orderedAt, Math.min(deliveringOffset, totalMinutes)) },
    { status: "delivered" as const, label: "已到货", date: addShoppingMinutes(orderedAt, totalMinutes) },
  ];
  return timeline.map(event => ({
    status: event.status,
    label: event.label,
    timeLabel: formatShoppingDateTime(event.date),
    timestamp: event.date.toISOString(),
  }));
}

function resolveOrderShipping(order: ShoppingOrder, nowMs: number): ResolvedShoppingShipping {
  const timeline = Array.isArray(order.shippingTimeline) ? order.shippingTimeline : [];
  if (timeline.length === 0) {
    return { statusLabel: order.statusLabel, timeline: [] };
  }
  const reached = timeline
    .filter(event => !Number.isNaN(new Date(event.timestamp).getTime()) && new Date(event.timestamp).getTime() <= nowMs)
    .slice(-1)[0];
  if (!reached || reached.status === "ordered") {
    return { statusLabel: "待发货", currentStage: "ordered", timeline };
  }
  return {
    statusLabel: reached.label,
    currentStage: reached.status,
    timeline,
  };
}

function getShoppingRating(product: ShoppingProductDetail): string {
  const seed = `${product.title}:${product.merchantLabel}:${product.priceLabel}`;
  return (4.5 + (getStableShoppingHash(seed) % 6) / 10).toFixed(1);
}

function cartQuantityLabel(quantity: number): string {
  return `× ${Math.max(0, Math.round(quantity))}`;
}

function toProductDetail(
  item: ShoppingProduct | ShoppingCartItem | ShoppingOrder["items"][number],
  defaults?: { tagLabel?: string; quantityLabel?: string; detailLabel?: string },
): ShoppingProductDetail {
  return {
    id: item.id,
    title: item.title,
    merchantLabel: item.merchantLabel,
    priceLabel: item.priceLabel,
    tagLabel: "tagLabel" in item ? item.tagLabel : defaults?.tagLabel ?? "Product",
    subtitle: item.subtitle,
    detail: item.detail,
    previewIcon: item.previewIcon,
    tone: item.tone,
    quantityLabel: "quantityLabel" in item ? item.quantityLabel : defaults?.quantityLabel,
    detailLabel: defaults?.detailLabel ?? "Description",
  };
}

function baseProduct(product: ShoppingProductDetail | ShoppingProduct): ShoppingProduct {
  return {
    id: product.id,
    title: product.title,
    merchantLabel: product.merchantLabel,
    priceLabel: product.priceLabel,
    tagLabel: product.tagLabel,
    subtitle: product.subtitle,
    detail: product.detail,
    previewIcon: product.previewIcon,
    tone: product.tone,
  };
}

function mergeShoppingProducts(...groups: ShoppingProduct[][]): ShoppingProduct[] {
  const seen = new Set<string>();
  const merged: ShoppingProduct[] = [];

  for (const product of groups.flat()) {
    const key = product.id || `${product.title}|${product.merchantLabel}|${product.priceLabel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(product);
  }

  return merged;
}

function productAsCartItem(product: ShoppingProductDetail | ShoppingProduct, quantity = 1): ShoppingCartItem {
  return {
    ...baseProduct(product),
    tagLabel: "Cart",
    quantityLabel: cartQuantityLabel(quantity),
  };
}

function buildOrderFromCart(
  cartItems: ShoppingCartItem[],
  totalLabel: string,
  settings: ShoppingState["settings"],
  options: {
    statusLabel?: string;
    note?: string;
    skipShipping?: boolean;
    paymentStatus?: ShoppingPaymentStatus;
    paymentRequestId?: string;
    payerCharacterId?: string;
    payerCharacterName?: string;
    paymentRequestedAt?: string;
  } = {},
): ShoppingOrder {
  const now = new Date();
  const id = `shop_order_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`;
  const summaryTitles = cartItems.slice(0, 3).map(item => normalizeCheckPhoneText(item.title));
  const summary = summaryTitles.join(", ") + (cartItems.length > 3 ? ` and ${cartItems.length} items total` : "");
  const merchantLabel = cartItems.length === 1 ? cartItems[0]?.merchantLabel ?? "SHOP" : `${cartItems.length} items`;
  return {
    id,
    statusLabel: options.statusLabel ?? "待发货",
    timeLabel: formatShoppingDateTime(now),
    totalLabel,
    merchantLabel,
    summary,
    note: options.note ?? `Checked out ${cartItems.length} item(s) from the cart.`,
    shippingTimeline: options.skipShipping ? [] : buildShippingTimeline(id, now, settings),
    paymentStatus: options.paymentStatus,
    paymentRequestId: options.paymentRequestId,
    payerCharacterId: options.payerCharacterId,
    payerCharacterName: options.payerCharacterName,
    paymentRequestedAt: options.paymentRequestedAt,
    items: cartItems.map((item, index) => ({
      id: `${id}_item_${index + 1}`,
      title: item.title,
      merchantLabel: item.merchantLabel,
      priceLabel: item.priceLabel,
      quantityLabel: item.quantityLabel,
      subtitle: item.subtitle,
      detail: item.detail,
      previewIcon: item.previewIcon,
      tone: item.tone,
    })),
  };
}

export function ShoppingApp({ onClose, visible = true, onIdle, onBusyChange }: ShoppingAppProps) {
  const [state, setState] = useState<ShoppingState>(() => createDefaultShoppingState());
  const [loaded, setLoaded] = useState(false);
  const [loadingTask, setLoadingTask] = useState<"refresh" | "search" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<ShoppingTabId>("home");
  const [selectedProduct, setSelectedProduct] = useState<ShoppingProductDetail | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [translationPreview, setTranslationPreview] = useState<ShoppingTranslationPreview | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<ShoppingSettingsTab>("prompts");
  const [expandedPrompts, setExpandedPrompts] = useState<Set<ShoppingPromptTab>>(new Set());
  const [promptDrafts, setPromptDrafts] = useState<ShoppingPromptDrafts>({
    refreshPrompt: DEFAULT_SHOPPING_REFRESH_PROMPT,
    searchPrompt: DEFAULT_SHOPPING_SEARCH_PROMPT,
    deliveryMinMinutes: DEFAULT_DELIVERY_MIN_MINUTES,
    deliveryMaxMinutes: DEFAULT_DELIVERY_MAX_MINUTES,
  });
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [searchInput, setSearchInput] = useState("");
  const [sectionSearchInputs, setSectionSearchInputs] = useState<Record<ShoppingSectionSearchTabId, string>>({
    orders: "",
    cart: "",
    account: "",
  });
  const [selectedCategoryId, setSelectedCategoryId] = useState("all");
  const [recentlyAddedProductId, setRecentlyAddedProductId] = useState<string | null>(null);
  const [cartFeedback, setCartFeedback] = useState<ShoppingCartFeedback | null>(null);
  const [confirmRefreshOpen, setConfirmRefreshOpen] = useState(false);
  const [confirmCheckoutOpen, setConfirmCheckoutOpen] = useState(false);
  const [paymentRequestOpen, setPaymentRequestOpen] = useState(false);
  const [paymentRequestTargets, setPaymentRequestTargets] = useState<Character[]>([]);
  const [selectedPaymentRequestTargetId, setSelectedPaymentRequestTargetId] = useState("");
  const [paymentRequestError, setPaymentRequestError] = useState<string | null>(null);
  const [confirmCartDeleteItemId, setConfirmCartDeleteItemId] = useState<string | null>(null);
  const [walletState, setWalletState] = useState<WalletState>(() => loadWalletState());
  const [selectedPaymentSourceId, setSelectedPaymentSourceId] = useState<string>(WALLET_BALANCE_ACCOUNT_ID);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [blackMarketOpen, setBlackMarketOpen] = useState(false);
  const [blackMarketTransition, setBlackMarketTransition] = useState(false);
  const cartFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cartPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blackMarketTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shoppingScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollRestoreFrameRef = useRef<number | null>(null);
  const wasVisibleRef = useRef(visible);

  useEffect(() => {
    const loadedState = loadShoppingState();
    setState(loadedState);
    setPromptDrafts({
      refreshPrompt: loadedState.settings.refreshPrompt,
      searchPrompt: loadedState.settings.searchPrompt,
      deliveryMinMinutes: loadedState.settings.deliveryMinMinutes,
      deliveryMaxMinutes: loadedState.settings.deliveryMaxMinutes,
    });
    setSearchInput("");
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setSearchInput("");
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const handleShoppingStateUpdated = () => {
      setState(loadShoppingState());
    };
    window.addEventListener(SHOPPING_STATE_UPDATED_EVENT, handleShoppingStateUpdated);
    return () => window.removeEventListener(SHOPPING_STATE_UPDATED_EVENT, handleShoppingStateUpdated);
  }, []);

  useEffect(() => () => {
    if (cartFeedbackTimerRef.current) {
      clearTimeout(cartFeedbackTimerRef.current);
    }
    if (cartPulseTimerRef.current) {
      clearTimeout(cartPulseTimerRef.current);
    }
    if (blackMarketTransitionTimerRef.current) {
      clearTimeout(blackMarketTransitionTimerRef.current);
    }
    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }
  }, []);

  useEffect(() => {
    const syncWallet = () => {
      const next = loadWalletState();
      setWalletState(next);
      setSelectedPaymentSourceId(current => current === WALLET_BALANCE_ACCOUNT_ID || next.cards.some(card => card.id === current)
        ? current
        : WALLET_BALANCE_ACCOUNT_ID);
    };
    syncWallet();
    window.addEventListener(WALLET_UPDATED_EVENT, syncWallet);
    return () => window.removeEventListener(WALLET_UPDATED_EVENT, syncWallet);
  }, []);

  useEffect(() => {
    if (state.orders.length === 0) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [state.orders.length]);

  function persist(updater: (current: ShoppingState) => ShoppingState) {
    setState(current => saveShoppingState(updater(current)));
  }

  const activeOrder = useMemo(
    () => state.orders.find(order => order.id === selectedOrderId) ?? null,
    [selectedOrderId, state.orders],
  );

  const cartTotals = useMemo(() => {
    const orderAmount = state.cartItems.reduce(
      (sum, item) => sum + parseShoppingAmount(item.priceLabel) * parseShoppingQuantity(item.quantityLabel),
      0,
    );
    return { orderAmount, totalPayment: orderAmount };
  }, [state.cartItems]);
  const selectedPaymentSource = useMemo(
    () => selectedPaymentSourceId === WALLET_BALANCE_ACCOUNT_ID
      ? {
          id: WALLET_BALANCE_ACCOUNT_ID,
          title: "Balance Payment",
          balance: getWalletBalance(walletState),
          description: "Red Envelopes and Transfers also use balance by default",
        }
      : (() => {
          const card = walletState.cards.find(item => item.id === selectedPaymentSourceId) ?? walletState.cards[0];
          return card
            ? {
                id: card.id,
                title: card.title,
                balance: card.balance,
                description: `${getWalletCardDisplayNumber(card.maskedNumber)} · Bank Card`,
              }
            : null;
        })(),
    [selectedPaymentSourceId, walletState],
  );
  const selectedPaymentSourceCanPay = Boolean(selectedPaymentSource && selectedPaymentSource.balance >= cartTotals.totalPayment);

  const savedIds = useMemo(() => new Set(state.savedItems.map(item => item.id)), [state.savedItems]);
  const cartIds = useMemo(() => new Set(state.cartItems.map(item => item.id)), [state.cartItems]);
  const loading = loadingTask !== null;
  const loadingLabel = loadingTask === "search" ? "Searching for new items" : "Refreshing products";
  const catalogCategories: ShoppingCategory[] = state.catalog.categories.length > 0
    ? state.catalog.categories
    : state.catalog.recommendations.length > 0
      ? [{ id: "featured", title: "Featured Picks", subtitle: "Recommended for you", items: state.catalog.recommendations }]
      : [];
  const visibleCatalogCategories = selectedCategoryId === "all"
    ? catalogCategories
    : catalogCategories.filter(category => category.id === selectedCategoryId || category.title === selectedCategoryId);
  const searchResultProducts = state.searchResult?.items ?? [];
  const allCatalogProducts = mergeShoppingProducts(searchResultProducts, catalogCategories.flatMap(category => category.items));
  const normalizedHomeSearchQuery = normalizeShoppingSearchValue(searchInput);
  const filteredAllCatalogProducts = normalizedHomeSearchQuery
    ? allCatalogProducts.filter(item => productMatchesSearch(item, normalizedHomeSearchQuery))
    : allCatalogProducts;
  const hasSearchResults = Boolean(state.searchResult?.items.length);
  const hasVisibleSearchResults = selectedCategoryId === "search" && hasSearchResults;
  const hasVisibleHomeProducts = selectedCategoryId === "all"
    ? filteredAllCatalogProducts.length > 0
    : visibleCatalogCategories.some(category => category.items.length > 0);
  const hasVisibleHomeContent = hasVisibleSearchResults || hasVisibleHomeProducts;
  const selectedCategoryLabel = selectedCategoryId === "all"
    ? "All"
    : selectedCategoryId === "search"
      ? `Search: ${state.searchResult?.query ?? ""}`
      : SHOPPING_RECOMMENDATION_CATEGORIES.find(category => category.id === selectedCategoryId)?.title ?? "this category";
  const emptyHomeTitle = selectedCategoryId === "all"
    ? normalizedHomeSearchQuery
      ? `No existing items found for "${searchInput.trim()}"`
      : "No products yet"
    : selectedCategoryId === "search"
      ? `No products found for "${state.searchResult?.query ?? searchInput.trim()}"`
      : `No products in ${selectedCategoryLabel} yet`;
  const emptyHomeHint = selectedCategoryId === "search"
    ? "Try a different keyword, or tap refresh to generate category picks"
    : selectedCategoryId === "all"
      ? normalizedHomeSearchQuery
        ? "Tap Search New Items to generate related products, or try a different keyword"
        : "Search for products, or tap refresh to generate category picks"
      : "Switch back to All, or tap refresh to generate category picks";
  const activeOrderShipping = activeOrder ? resolveOrderShipping(activeOrder, nowTick) : null;
  const normalizedCartSearchQuery = normalizeShoppingSearchValue(sectionSearchInputs.cart);
  const normalizedOrderSearchQuery = normalizeShoppingSearchValue(sectionSearchInputs.orders);
  const normalizedSavedSearchQuery = normalizeShoppingSearchValue(sectionSearchInputs.account);
  const filteredCartItems = useMemo(
    () => state.cartItems.filter(item => productMatchesSearch(item, normalizedCartSearchQuery)),
    [normalizedCartSearchQuery, state.cartItems],
  );
  const filteredOrders = useMemo(
    () => state.orders.filter(order => orderMatchesSearch(order, normalizedOrderSearchQuery, nowTick)),
    [normalizedOrderSearchQuery, nowTick, state.orders],
  );
  const filteredSavedItems = useMemo(
    () => state.savedItems.filter(item => productMatchesSearch(item, normalizedSavedSearchQuery)),
    [normalizedSavedSearchQuery, state.savedItems],
  );

  useEffect(() => {
    onBusyChange?.(loading);
    if (!visible && !loading) {
      onIdle?.();
    }
  }, [loading, visible, onBusyChange, onIdle]);

  function resetShoppingScroll() {
    const scrollEl = shoppingScrollRef.current;
    if (!scrollEl) return;
    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
      scrollRestoreFrameRef.current = null;
    }
    scrollEl.style.overflowY = "hidden";
    scrollEl.scrollTop = 0;
    scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      scrollRestoreFrameRef.current = null;
      scrollEl.style.removeProperty("overflow-y");
    });
  }

  useLayoutEffect(() => {
    resetShoppingScroll();
  }, [selectedTab]);

  function selectShoppingTab(tabId: ShoppingTabId) {
    resetShoppingScroll();
    setTranslationPreview(null);
    setSelectedTab(tabId);
  }

  async function handleRefresh() {
    if (loading) return;
    setLoadingTask("refresh");
    setError(null);
    setDebugRawOutput(null);
    const result = await generateShoppingCatalog(state.settings.refreshPrompt);
    if (result.catalog) {
      persist(current => ({
        ...current,
        catalog: result.catalog!,
        generatedAt: new Date().toISOString(),
      }));
      setSelectedProduct(null);
      setSelectedOrderId(null);
      setTranslationPreview(null);
    }
    setError(result.error ?? null);
    setDebugRawOutput(result.rawOutput ?? null);
    setLoadingTask(null);
    setLoaded(true);
  }

  function enterBlackMarketFromSearch() {
    if (blackMarketTransition) return;
    if (blackMarketTransitionTimerRef.current) {
      clearTimeout(blackMarketTransitionTimerRef.current);
    }
    setBlackMarketTransition(true);
    setSelectedCategoryId("all");
    setSelectedProduct(null);
    setSelectedOrderId(null);
    setTranslationPreview(null);
    setError(null);
    setDebugRawOutput(null);
    blackMarketTransitionTimerRef.current = setTimeout(() => {
      setSearchInput("");
      setBlackMarketTransition(false);
      setBlackMarketOpen(true);
      blackMarketTransitionTimerRef.current = null;
    }, 920);
  }

  async function handleSearch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = searchInput.trim();
    if (!query || loading || blackMarketTransition) return;
    if (isBlackMarketSearchTrigger(query)) {
      enterBlackMarketFromSearch();
      return;
    }
    setLoadingTask("search");
    setError(null);
    setDebugRawOutput(null);
    const result = await generateShoppingSearchResults(query, state.settings.searchPrompt);
    if (result.result) {
      persist(current => ({
        ...current,
        searchResult: result.result!,
      }));
      setSelectedCategoryId("search");
      setSelectedProduct(null);
      setSelectedOrderId(null);
      setTranslationPreview(null);
    }
    setError(result.error ?? null);
    setDebugRawOutput(result.rawOutput ?? null);
    setLoadingTask(null);
    setLoaded(true);
  }

  function handleSavePrompt() {
    const deliverySettings = normalizeDeliverySettings(promptDrafts);
    persist(current => ({
      ...current,
      settings: {
        ...current.settings,
        refreshPrompt: promptDrafts.refreshPrompt.trim() || DEFAULT_SHOPPING_REFRESH_PROMPT,
        searchPrompt: promptDrafts.searchPrompt.trim() || DEFAULT_SHOPPING_SEARCH_PROMPT,
        ...deliverySettings,
      },
    }));
    setPromptOpen(false);
  }

  function clearAllShoppingTraces() {
    // Keep settings (prompts/delivery time), reset everything else: catalog, search results, favorites, cart, orders
    persist(current => ({ ...createDefaultShoppingState(), settings: current.settings }));
    setSelectedProduct(null);
    setSelectedOrderId(null);
    setSelectedTab("home");
    setSelectedCategoryId("all");
    setSectionSearchInputs({ orders: "", cart: "", account: "" });
    setClearConfirmOpen(false);
  }

  function openPromptSettings() {
    setSettingsTab("prompts");
    setExpandedPrompts(new Set());
    setPromptDrafts({
      refreshPrompt: state.settings.refreshPrompt,
      searchPrompt: state.settings.searchPrompt,
      deliveryMinMinutes: state.settings.deliveryMinMinutes,
      deliveryMaxMinutes: state.settings.deliveryMaxMinutes,
    });
    setPromptOpen(true);
  }

  function updatePromptDraft(tab: ShoppingPromptTab, value: string) {
    const key = tab === "refresh" ? "refreshPrompt" : "searchPrompt";
    setPromptDrafts(current => ({ ...current, [key]: value }));
  }

  function resetPromptDraft() {
    setPromptDrafts(current => ({
      ...current,
      refreshPrompt: DEFAULT_SHOPPING_REFRESH_PROMPT,
      searchPrompt: DEFAULT_SHOPPING_SEARCH_PROMPT,
    }));
  }

  function updateDeliveryDraft(key: "deliveryMinMinutes" | "deliveryMaxMinutes", value: string) {
    const amount = Number(value);
    setPromptDrafts(current => ({
      ...current,
      [key]: normalizeDeliveryMinutes(amount, key === "deliveryMinMinutes" ? DEFAULT_DELIVERY_MIN_MINUTES : DEFAULT_DELIVERY_MAX_MINUTES),
    }));
  }

  function resetDeliveryDraft() {
    setPromptDrafts(current => ({
      ...current,
      deliveryMinMinutes: DEFAULT_DELIVERY_MIN_MINUTES,
      deliveryMaxMinutes: DEFAULT_DELIVERY_MAX_MINUTES,
    }));
  }

  function toggleSave(product: ShoppingProductDetail | ShoppingProduct) {
    const item = baseProduct(product);
    persist(current => {
      const exists = current.savedItems.some(saved => saved.id === item.id);
      return {
        ...current,
        savedItems: exists
          ? current.savedItems.filter(saved => saved.id !== item.id)
          : [{ ...item, tagLabel: "Saved" }, ...current.savedItems],
      };
    });
  }

  function addToCart(product: ShoppingProductDetail | ShoppingProduct) {
    const item = baseProduct(product);
    persist(current => {
      const exists = current.cartItems.find(cartItem => cartItem.id === item.id);
      return {
        ...current,
        cartItems: exists
          ? current.cartItems.map(cartItem => cartItem.id === item.id
            ? { ...cartItem, quantityLabel: cartQuantityLabel(parseShoppingQuantity(cartItem.quantityLabel) + 1) }
            : cartItem)
          : [productAsCartItem(item), ...current.cartItems],
      };
    });
    if (cartFeedbackTimerRef.current) {
      clearTimeout(cartFeedbackTimerRef.current);
    }
    if (cartPulseTimerRef.current) {
      clearTimeout(cartPulseTimerRef.current);
    }
    setRecentlyAddedProductId(item.id);
    setCartFeedback({
      id: Date.now(),
    });
    cartPulseTimerRef.current = setTimeout(() => {
      setRecentlyAddedProductId(current => current === item.id ? null : current);
    }, 650);
    cartFeedbackTimerRef.current = setTimeout(() => {
      setCartFeedback(null);
    }, 1700);
  }

  function changeCartQuantity(itemId: string, delta: number) {
    persist(current => ({
      ...current,
      cartItems: current.cartItems
        .map(item => {
          if (item.id !== itemId) return item;
          const quantity = parseShoppingQuantity(item.quantityLabel) + delta;
          return { ...item, quantityLabel: cartQuantityLabel(quantity) };
        })
        .filter(item => parseShoppingQuantity(item.quantityLabel) > 0),
    }));
  }

  function removeCartItem(itemId: string) {
    persist(current => ({
      ...current,
      cartItems: current.cartItems.filter(item => item.id !== itemId),
    }));
  }

  function confirmRemoveCartItem() {
    if (!confirmCartDeleteItemId) return;
    removeCartItem(confirmCartDeleteItemId);
    setConfirmCartDeleteItemId(null);
  }

  function openCheckoutSheet() {
    if (state.cartItems.length === 0) return;
    const nextWalletState = loadWalletState();
    setWalletState(nextWalletState);
    setSelectedPaymentSourceId(WALLET_BALANCE_ACCOUNT_ID);
    setPaymentError(null);
    setConfirmCheckoutOpen(true);
  }

  function openPaymentRequestSheet() {
    if (state.cartItems.length === 0) return;
    const targets = loadCharacters();
    setPaymentRequestTargets(targets);
    setSelectedPaymentRequestTargetId(targets[0]?.id ?? "");
    setPaymentRequestError(null);
    setPaymentRequestOpen(true);
  }

  function sendPaymentRequest() {
    if (state.cartItems.length === 0) return;
    const target = paymentRequestTargets.find(item => item.id === selectedPaymentRequestTargetId);
    if (!target) {
      setPaymentRequestError("Please choose who to ask to pay.");
      return;
    }
    const paymentRequestedAt = new Date().toISOString();
    const paymentRequestId = createShoppingPaymentRequestId();
    const order = buildOrderFromCart(
      state.cartItems,
      formatShoppingAmount(cartTotals.totalPayment),
      state.settings,
      {
        statusLabel: "待代付",
        note: `Sent a payment request to ${target.name}.`,
        skipShipping: true,
        paymentStatus: "payment_requested",
        paymentRequestId,
        payerCharacterId: target.id,
        payerCharacterName: target.name,
        paymentRequestedAt,
      },
    );
    const requestItems = buildShoppingPaymentRequestItems(order.items);
    const requestItemsText = formatShoppingPaymentRequestItems(requestItems);
    const amountLabel = formatShoppingPaymentAmountForHistory(cartTotals.totalPayment);
    const chatSession = createOrGetSession(target.id);
    pushChatMessage({
      sessionId: chatSession.id,
      role: "user",
      content: "",
      mediaType: "payment_request",
      mediaData: {
        amount: cartTotals.totalPayment,
        paymentRequestAmountLabel: amountLabel,
        paymentRequestId,
        shoppingOrderId: order.id,
        paymentRequestItems: requestItems,
        paymentRequestItemsText: requestItemsText,
        paymentRequestSummary: order.summary,
        paymentPayerId: target.id,
        paymentPayerName: target.name,
        paymentRequestedAt,
        // Must stay identical to DEFAULT_PAYMENT_REQUEST_LABEL in
        // lib/rich-tag-builders.ts — the parser sets the same label for an
        // AI-sent request, and the two paths should be indistinguishable.
        label: DEFAULT_PAYMENT_REQUEST_LABEL,
        status: "pending",
      },
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: chatSession.id } }));
    }
    persist(current => ({
      ...current,
      orders: [order, ...current.orders],
      cartItems: [],
    }));
    setSelectedTab("orders");
    setSelectedOrderId(order.id);
    setPaymentRequestOpen(false);
    setPaymentRequestError(null);
  }

  function handleCheckout() {
    if (state.cartItems.length === 0) return;
    const order = buildOrderFromCart(state.cartItems, formatShoppingAmount(cartTotals.totalPayment), state.settings);
    const paymentSource = selectedPaymentSource;
    if (!paymentSource) {
      setPaymentError("Please choose a payment method.");
      return;
    }
    const paymentResult = payWithWalletAccount({
      accountId: paymentSource.id,
      amount: cartTotals.totalPayment,
      title: "Shopping Payment",
      detail: `Shopping order: ${order.summary}`,
      category: "Shopping",
      relatedOrderId: order.id,
    });
    if (!paymentResult.ok || !paymentResult.transaction) {
      setWalletState(paymentResult.state);
      setPaymentError(paymentResult.error ?? "Payment failed.");
      return;
    }
    setWalletState(paymentResult.state);
    const paidOrder: ShoppingOrder = {
      ...order,
      paymentCardId: paymentSource.id,
      paymentCardLabel: paymentSource.id === WALLET_BALANCE_ACCOUNT_ID ? "Balance Payment" : `${paymentSource.title} (${paymentSource.description.replace(" · Bank Card", "")})`,
      paymentTransactionId: paymentResult.transaction.id,
      paidAt: paymentResult.transaction.createdAt,
    };
    persist(current => ({
      ...current,
      orders: [paidOrder, ...current.orders],
      cartItems: [],
    }));
    setSelectedTab("orders");
    setSelectedOrderId(paidOrder.id);
    setPaymentError(null);
    setConfirmCheckoutOpen(false);
  }

  function openProduct(product: ShoppingProduct | ShoppingCartItem | ShoppingOrder["items"][number], defaults?: { tagLabel?: string; detailLabel?: string }) {
    setTranslationPreview(null);
    setSelectedProduct(toProductDetail(product, defaults));
  }

  function renderShoppingCardText(text: string) {
    const normalized = normalizeCheckPhoneText(text);
    const bilingual = splitBilingualText(normalized);
    if (!bilingual) return <span className="cp-shopping-card-title-original">{normalized}</span>;
    const openTranslation = () => setTranslationPreview(bilingual);
    return (
      <span className="cp-shopping-card-title-line">
        <span className="cp-shopping-card-title-original">{bilingual.original}</span>
        <span
          className="cp-shopping-card-title-translate"
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openTranslation();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            openTranslation();
          }}
        >
          Chinese
        </span>
      </span>
    );
  }

  const topSubtitle = selectedProduct
    ? selectedProduct.tagLabel
    : activeOrder
      ? activeOrderShipping?.statusLabel ?? activeOrder.statusLabel
      : "Category picks & wishlist";

  const backAction = selectedProduct
    ? () => {
      setTranslationPreview(null);
      setSelectedProduct(null);
    }
    : activeOrder
      ? () => {
        setTranslationPreview(null);
        setSelectedOrderId(null);
      }
      : () => onClose(loading);

  const selectedProductRecentlyAdded = Boolean(selectedProduct && recentlyAddedProductId === selectedProduct.id);

  function ProductCard({ item, compact = false }: { item: ShoppingProduct; compact?: boolean }) {
    const isSaved = savedIds.has(item.id);
    const inCart = cartIds.has(item.id);
    const recentlyAdded = recentlyAddedProductId === item.id;
    const handleOpen = () => openProduct(item);
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={handleOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          handleOpen();
        }}
        style={{
          minWidth: 0,
          maxWidth: "100%",
          boxSizing: "border-box",
          background: "#fff",
          borderRadius: "16px",
          padding: "12px",
          display: "flex",
          flexDirection: "column",
          textAlign: "left",
          border: "none",
          boxShadow: "0 4px 20px rgba(0,0,0,0.03)",
          position: "relative",
          cursor: "pointer",
        }}
      >
        <button
          type="button"
          aria-label={isSaved ? "Remove from favorites" : "Add to favorites"}
          onClick={(event) => {
            event.stopPropagation();
            toggleSave(item);
          }}
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            zIndex: 2,
            background: isSaved ? "#ff6b00" : "#fff",
            border: "1px solid #eee",
            borderRadius: "50%",
            width: "30px",
            height: "30px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: isSaved ? "#fff" : "#777",
            boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
          }}
        >
          <Heart size={15} fill={isSaved ? "white" : "none"} />
        </button>
        <div style={{ width: "100%", height: compact ? "92px" : "120px", background: "#f5f5f5", borderRadius: "12px", marginBottom: "12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: compact ? "30px" : "34px" }}>
          {item.previewIcon}
        </div>
        <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: 600, marginBottom: "4px", display: "block", width: "100%", minWidth: 0 }}>
          {renderShoppingCardText(item.title)}
        </strong>
        <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888", marginBottom: "8px" }}>{item.merchantLabel}</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
          <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold" }}>{item.priceLabel}</span>
          <button
            type="button"
            aria-label={recentlyAdded ? "Added to cart" : inCart ? "Add to cart again" : "Add to cart"}
            onClick={(event) => {
              event.stopPropagation();
              addToCart(item);
            }}
            style={{
              background: recentlyAdded ? "#16a34a" : inCart ? "#222" : "#f46200",
              color: "#fff",
              width: "26px",
              height: "26px",
              borderRadius: "50%",
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transform: recentlyAdded ? "scale(1.14)" : "scale(1)",
              transition: "background 160ms ease, transform 180ms ease",
            }}
          >
            {recentlyAdded ? <Check size={16} strokeWidth={3} /> : <Plus size={16} />}
          </button>
        </div>
      </div>
    );
  }

  if (blackMarketOpen) {
    return <BlackMarketApp onClose={() => setBlackMarketOpen(false)} />;
  }

  return (
    <div className="cp-shopping-module" style={{ background: "#f8f9fa", fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: "var(--page-header-content-height, 42px)", marginTop: "var(--page-header-safe-top, 48px)", padding: "1px 24px" }}>
        {!selectedProduct && !activeOrder && selectedTab === "home" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <button type="button" aria-label="Back" onClick={backAction} style={{ width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
                <ChevronLeft size={22} strokeWidth={2.5} />
              </button>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#888" }}>Welcome Back</span>
                <strong style={{ fontSize: "calc(18px*var(--app-text-scale,1))", color: "#222", lineHeight: 1.15 }}>Shopping</strong>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <button type="button" aria-label="Clear shopping traces" onClick={() => setClearConfirmOpen(true)} style={{ width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
                <Trash2 size={18} strokeWidth={2.2} />
              </button>
              <button type="button" aria-label="Prompt settings" onClick={() => openPromptSettings()} style={{ width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
                <MoreHorizontal size={21} strokeWidth={2.35} />
              </button>
            </div>
          </>
        ) : (
          <>
            <button type="button" aria-label="Back" onClick={backAction} style={{ width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
              <ChevronLeft size={22} strokeWidth={2.5} />
            </button>
            <div style={{ flex: 1, minWidth: 0, marginLeft: "12px", display: "flex", alignItems: "center", background: "#fff", borderRadius: "20px", padding: "0 14px", height: "40px", color: "#999", fontSize: "calc(13px*var(--app-text-scale,1))", gap: "10px", boxShadow: "0 3px 12px rgba(0,0,0,0.018)" }}>
              <Search size={17} />
              {!selectedProduct && !activeOrder && isShoppingSectionSearchTab(selectedTab) ? (
                <input
                  aria-label={SHOPPING_SECTION_SEARCH_PLACEHOLDERS[selectedTab]}
                  value={sectionSearchInputs[selectedTab]}
                  onChange={event => setSectionSearchInputs(current => ({
                    ...current,
                    [selectedTab]: event.target.value,
                  }))}
                  placeholder={SHOPPING_SECTION_SEARCH_PLACEHOLDERS[selectedTab]}
                  style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: "#222", fontSize: "calc(13px*var(--app-text-scale,1))", height: "38px" }}
                />
              ) : (
                <span style={{ flex: 1 }}>{topSubtitle}</span>
              )}
            </div>
          </>
        )}
      </header>

      {loading && (
        <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
          <span className="cp-refresh-indicator-text">{loadingLabel}</span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
      )}

      {cartFeedback ? (
        <div key={cartFeedback.id} className="cp-shopping-cart-toast" role="status" aria-live="polite">
          <ShoppingCart size={16} />
          <span>Added to cart</span>
        </div>
      ) : null}

      {blackMarketTransition ? (
        <div className="cp-shopping-black-market-gate" role="status" aria-live="polite">
          <div className="cp-shopping-black-market-gate-noise" />
          <div className="cp-shopping-black-market-gate-panel">
            <span>SEARCH QUERY ACCEPTED</span>
            <strong data-text="BLACK MARKET">BLACK MARKET</strong>
            <em>&gt; routing through night channel...</em>
          </div>
        </div>
      ) : null}

      <div className="cp-shopping-body">
        {!loaded && <div className="cp-shopping-status">Syncing storefront...</div>}

        {error ? <CheckPhoneDebugErrorCard error={error} debugRawOutput={debugRawOutput} /> : null}

        {!selectedProduct && !activeOrder && (
          <>
            {selectedTab === "home" ? (
              <div style={{ padding: "0 24px", marginTop: "-4px", marginBottom: "16px" }}>
                <form onSubmit={handleSearch} style={{ display: "flex", alignItems: "center", background: "#fff", borderRadius: "22px", padding: "0 8px 0 14px", minHeight: "40px", color: "#999", fontSize: "calc(13px*var(--app-text-scale,1))", gap: "8px", boxShadow: "0 3px 12px rgba(0,0,0,0.018)" }}>
                  <Search size={17} />
                  <input
                    aria-label="Search products"
                    value={searchInput}
                    onChange={event => {
                      const nextValue = event.target.value;
                      setSearchInput(nextValue);
                      if (selectedCategoryId !== "all") {
                        setSelectedCategoryId("all");
                      }
                    }}
                    placeholder="Search products"
                    disabled={loading || blackMarketTransition}
                    style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: "#222", fontSize: "calc(13px*var(--app-text-scale,1))", height: "38px" }}
                  />
                  <button type="submit" disabled={!searchInput.trim() || loading || blackMarketTransition} style={{ border: "none", background: searchInput.trim() && !loading && !blackMarketTransition ? "#ff6b00" : "#eee", color: searchInput.trim() && !loading && !blackMarketTransition ? "#fff" : "#aaa", borderRadius: "16px", height: "30px", padding: "0 12px", minWidth: "88px", fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 700, whiteSpace: "nowrap" }}>
                    Search New Items
                  </button>
                </form>
                <div
                  role="tablist"
                  aria-label="Product categories"
                  style={{
                    display: "flex",
                    gap: "8px",
                    overflowX: "auto",
                    margin: "12px -24px 0",
                    padding: "0 24px 2px",
                    scrollbarWidth: "none",
                  }}
                >
                  {[
                    { id: "all", title: "All" },
                    ...(state.searchResult?.items.length ? [{ id: "search", title: `Search: ${state.searchResult.query}` }] : []),
                    ...SHOPPING_RECOMMENDATION_CATEGORIES,
                  ].map(category => {
                    const active = selectedCategoryId === category.id;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setSelectedCategoryId(category.id)}
                        style={{
                          flex: "0 0 auto",
                          minHeight: "36px",
                          border: active ? "none" : "1px solid #eee",
                          borderRadius: "18px",
                          background: active ? "#ff6b00" : "#fff",
                          color: active ? "#fff" : "#555",
                          padding: "0 14px",
                          fontSize: "calc(12px*var(--app-text-scale,1))",
                          fontWeight: active ? 700 : 600,
                          whiteSpace: "nowrap",
                          maxWidth: category.id === "search" ? "136px" : undefined,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          boxShadow: active ? "0 8px 18px rgba(255,107,0,0.22)" : "0 3px 10px rgba(0,0,0,0.018)",
                          cursor: "pointer",
                        }}
                      >
                        {category.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {loaded && selectedTab === "home" && !hasVisibleHomeContent && !loading && !error ? (
              <div className="cp-shopping-status cp-empty-copy">
                <p>{emptyHomeTitle}</p>
                <span className="cp-shopping-hint">{emptyHomeHint}</span>
              </div>
            ) : null}

            <div
              key={selectedTab}
              ref={shoppingScrollRef}
              className="cp-shopping-scroll"
              style={{ padding: "0 24px 120px", display: "flex", flexDirection: "column", gap: "32px", marginTop: selectedTab === "home" ? 0 : "8px" }}
            >
              {selectedTab === "home" && hasVisibleHomeContent ? (
                <>
                  {hasVisibleSearchResults && state.searchResult?.items.length ? (
                    <section>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px" }}>
                        {state.searchResult.items.map(item => <ProductCard key={item.id} item={item} />)}
                      </div>
                    </section>
                  ) : null}

                  {selectedCategoryId === "all" && filteredAllCatalogProducts.length > 0 ? (
                    <section>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px" }}>
                        {filteredAllCatalogProducts.map(item => <ProductCard key={item.id} item={item} />)}
                      </div>
                    </section>
                  ) : null}

                  {selectedCategoryId !== "all" && selectedCategoryId !== "search" ? visibleCatalogCategories.filter(category => category.items.length > 0).map(category => (
                    <section key={category.id}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px", gap: "12px" }}>
                        <div style={{ minWidth: 0 }}>
                          <h2 style={{ fontSize: "calc(19px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 4px 4px" }}>{category.title}</h2>
                          <p style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999", margin: "0 0 0 4px", lineHeight: 1.35 }}>{category.subtitle}</p>
                        </div>
                        <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#f46200", fontWeight: 500, whiteSpace: "nowrap", paddingTop: "3px" }}>{category.items.length}</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px" }}>
                        {category.items.map(item => <ProductCard key={item.id} item={item} />)}
                      </div>
                    </section>
                  )) : null}
                </>
              ) : null}

              {selectedTab === "cart" && (
                <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <h2 style={{ fontSize: "calc(19px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 8px 4px" }}>Cart</h2>
                  {state.cartItems.length === 0 ? (
                    <div className="cp-shopping-status cp-empty-copy" style={{ minHeight: "220px" }}>
                      <p>Your cart is empty</p>
                    </div>
                  ) : null}
                  {state.cartItems.length > 0 && filteredCartItems.length === 0 ? (
                    <div className="cp-shopping-status cp-empty-copy" style={{ minHeight: "220px" }}>
                      <p>No matching cart items found</p>
                    </div>
                  ) : null}
                  {filteredCartItems.map(item => (
                    (() => {
                      const quantity = parseShoppingQuantity(item.quantityLabel);
                      return (
                        <div
                          key={item.id}
                          onClick={() => openProduct(item, { detailLabel: "Description" })}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            openProduct(item, { detailLabel: "Description" });
                          }}
                          role="button"
                          tabIndex={0}
                          style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", background: "#fff", borderRadius: "16px", padding: "16px", display: "flex", alignItems: "center", border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.03)", gap: "16px", textAlign: "left", cursor: "pointer" }}
                        >
                          <div style={{ width: "80px", height: "80px", background: "#f5f5f5", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(36px*var(--app-text-scale,1))", flexShrink: 0 }}>
                            {item.previewIcon}
                          </div>
                          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", minWidth: 0, gap: "8px" }}>
                              <strong style={{ flex: "1 1 0", fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: 600, display: "block", minWidth: 0 }}>{renderShoppingCardText(item.title)}</strong>
                              <button type="button" aria-label="Remove from cart" onClick={(event) => {
                                event.stopPropagation();
                                setConfirmCartDeleteItemId(item.id);
                              }} style={{ border: "none", background: "transparent", color: "#ff6b00", padding: 0 }}>
                                <Trash2 size={16} />
                              </button>
                            </div>
                            <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888", marginTop: "4px" }}>{item.merchantLabel}</span>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
                              <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold" }}>{item.priceLabel}</span>
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", background: "#f9f9f9", borderRadius: "14px", padding: "4px 8px" }}>
                                <button type="button" aria-label={quantity > 1 ? "Decrease quantity" : "Remove item"} onClick={(event) => {
                                  event.stopPropagation();
                                  if (quantity > 1) {
                                    changeCartQuantity(item.id, -1);
                                  } else {
                                    setConfirmCartDeleteItemId(item.id);
                                  }
                                }} style={{ border: "none", background: "transparent", color: "#666", padding: 0, display: "flex" }}>
                                  <Minus size={12} />
                                </button>
                                <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500 }}>{quantity}</span>
                                <button type="button" aria-label="Increase quantity" onClick={(event) => {
                                  event.stopPropagation();
                                  changeCartQuantity(item.id, 1);
                                }} style={{ border: "none", background: "transparent", color: "#333", padding: 0, display: "flex" }}>
                                  <Plus size={12} />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()
                  ))}
                  {state.cartItems.length > 0 && !normalizedCartSearchQuery ? (
                    <div style={{ marginTop: "16px", background: "#fff", borderRadius: "16px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.03)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#666", marginBottom: "12px" }}>
                        <span>Order Amount</span>
                        <span style={{ color: "#222", fontWeight: 500 }}>{formatShoppingAmount(cartTotals.orderAmount)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold", borderTop: "1px dashed #eee", paddingTop: "16px", marginBottom: "24px" }}>
                        <span>Total Payment</span>
                        <span>{formatShoppingAmount(cartTotals.totalPayment)}</span>
                      </div>
                      <div style={{ display: "grid", gap: "10px" }}>
                        <button type="button" onClick={openCheckoutSheet} style={{ width: "100%", background: "#ff6b00", color: "#fff", borderRadius: "24px", padding: "14px 0", fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: "bold", border: "none" }}>Checkout</button>
                        <button
                          type="button"
                          onClick={openPaymentRequestSheet}
                          style={{ width: "100%", background: "#fff7ed", color: "#b45309", borderRadius: "24px", padding: "13px 0", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 800, border: "1px solid rgba(255,107,0,0.18)", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
                        >
                          <HeartHandshake size={16} strokeWidth={2.4} />
                          Ask Someone to Pay
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>
              )}

              {selectedTab === "orders" && (
                <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <h2 style={{ fontSize: "calc(19px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 8px 4px" }}>Orders</h2>
                  {state.orders.length === 0 ? (
                    <div className="cp-shopping-status cp-empty-copy" style={{ minHeight: "220px" }}>
                      <p>No orders yet</p>
                    </div>
                  ) : null}
                  {state.orders.length > 0 && filteredOrders.length === 0 ? (
                    <div className="cp-shopping-status cp-empty-copy" style={{ minHeight: "220px" }}>
                      <p>No matching orders found</p>
                    </div>
                  ) : null}
                  {filteredOrders.map(order => {
                    const shipping = resolveOrderShipping(order, nowTick);
                    return (
                      <button
                        key={order.id}
                        type="button"
                        onClick={() => {
                          setTranslationPreview(null);
                          setSelectedOrderId(order.id);
                        }}
                        style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", background: "#fff", borderRadius: "16px", padding: "16px 20px", display: "flex", flexDirection: "column", border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.03)", textAlign: "left", gap: "8px", lineHeight: 1.25 }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                          <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222" }}>{order.merchantLabel}</strong>
                          <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: shipping.statusLabel === "已到货" ? "#16a34a" : "#ff6b00", fontWeight: 500 }}>{shipping.statusLabel}</span>
                        </div>
                        <div style={{ display: "flex", gap: "10px", width: "100%", alignItems: "stretch" }}>
                          <div style={{ width: "56px", height: "56px", background: "#f5f5f5", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(24px*var(--app-text-scale,1))", flexShrink: 0 }}>
                            {order.items[0]?.previewIcon || "□"}
                          </div>
                          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: "56px" }}>
                            <div style={{ display: "flex", flexDirection: "column", transform: "translateY(10px)" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                                <span style={{ flex: 1, minWidth: 0, fontSize: "calc(13px*var(--app-text-scale,1))", color: "#333" }}>{renderShoppingCardText(order.summary)}</span>
                                <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999", whiteSpace: "nowrap" }}>{order.items.length} items</span>
                              </div>
                              <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{order.timeLabel}</span>
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", lineHeight: 1 }}>
                              <strong style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#222", lineHeight: 1 }}>{order.totalLabel}</strong>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </section>
              )}

              {selectedTab === "account" && (
                <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <h2 style={{ fontSize: "calc(19px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 8px 4px" }}>Favorites</h2>
                  {state.savedItems.length === 0 ? (
                    <div className="cp-shopping-status cp-empty-copy" style={{ minHeight: "220px" }}>
                      <p>No favorites yet</p>
                    </div>
                  ) : null}
                  {state.savedItems.length > 0 && filteredSavedItems.length === 0 ? (
                    <div className="cp-shopping-status cp-empty-copy" style={{ minHeight: "220px" }}>
                      <p>No matching favorites found</p>
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px" }}>
                    {filteredSavedItems.map(item => <ProductCard key={item.id} item={item} />)}
                  </div>
                </section>
              )}
            </div>

            <nav style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "#fff", display: "flex", justifyContent: "space-around", padding: "12px 0 calc(12px + env(safe-area-inset-bottom, 0px))", borderTop: "1px solid #eaeaea", zIndex: 10 }}>
              {SHOPPING_TABS.map(tab => {
                const Icon = tab.icon;
                const active = selectedTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onPointerDown={resetShoppingScroll}
                    onClick={() => {
                      selectShoppingTab(tab.id);
                    }}
                    style={{ background: "transparent", border: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", color: active ? "#ff6b00" : "#999" }}
                  >
                    <div style={{ background: active ? "#ff6b00" : "transparent", color: active ? "#fff" : "inherit", padding: "8px", borderRadius: "12px" }}>
                      <Icon size={active ? 20 : 22} strokeWidth={active ? 2.5 : 2} />
                    </div>
                    <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", fontWeight: active ? 600 : 500 }}>{tab.label}</span>
                  </button>
                );
              })}
            </nav>

            {selectedTab === "home" ? (
              <button
                type="button"
                aria-label="Refresh home recommendations"
                onClick={() => setConfirmRefreshOpen(true)}
                disabled={loading}
                style={{
                  position: "absolute",
                  right: "24px",
                  bottom: "calc(86px + env(safe-area-inset-bottom, 0px))",
                  zIndex: 12,
                  width: "54px",
                  height: "54px",
                  borderRadius: "50%",
                  border: "none",
                  background: loading ? "#ffb27a" : "#ff6b00",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 14px 30px rgba(255,107,0,0.34)",
                  cursor: loading ? "default" : "pointer",
                }}
              >
                <RefreshCw size={22} strokeWidth={2.6} className={loadingTask === "refresh" ? "cp-spin" : ""} />
              </button>
            ) : null}
          </>
        )}

        {selectedProduct && (
          <div style={{ position: "absolute", inset: 0, zIndex: 20, background: "#fff", display: "flex", flexDirection: "column", overflowY: "auto" }}>
            <header style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", height: "var(--page-header-content-height, 42px)", marginTop: "var(--page-header-safe-top, 48px)", padding: "1px 24px", background: "#fff" }}>
              <button type="button" aria-label="Back" onClick={backAction} style={{ background: "#fff", width: "34px", height: "34px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#333", border: "1px solid #eee", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}>
                <ChevronLeft size={20} />
              </button>
              <strong style={{ position: "absolute", left: "50%", bottom: "20px", transform: "translateX(-50%)", fontSize: "calc(16px*var(--app-text-scale,1))", color: "#222", fontWeight: 600 }}>Product Details</strong>
              <button type="button" aria-label={savedIds.has(selectedProduct.id) ? "Remove from favorites" : "Add to favorites"} onClick={() => toggleSave(selectedProduct)} style={{ background: savedIds.has(selectedProduct.id) ? "#ff6b00" : "#fff", width: "34px", height: "34px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: savedIds.has(selectedProduct.id) ? "#fff" : "#333", border: "1px solid #eee", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}>
                <Heart size={17} fill={savedIds.has(selectedProduct.id) ? "white" : "none"} />
              </button>
            </header>
            <div style={{ position: "relative", width: "100%", height: "220px", background: "#f8f9fa", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(72px*var(--app-text-scale,1))" }}>
              {selectedProduct.previewIcon}
            </div>

            <div style={{ padding: "22px 24px 34px", flex: 1, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#ff6b00", fontWeight: 600 }}>{selectedProduct.tagLabel}</span>
                <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", fontWeight: 500 }}>
                  <Star size={12} fill="#ffb800" color="#ffb800" />
                  <span>{getShoppingRating(selectedProduct)}</span>
                </div>
              </div>

              <h1 style={{ fontSize: "calc(20px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 8px 0", lineHeight: 1.22 }}><CheckPhoneBilingualText text={selectedProduct.title} tone="shopping" /></h1>
              <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#666", marginBottom: "16px" }}>{selectedProduct.merchantLabel}</div>

              <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: "16px", marginBottom: "20px" }}>
                <h3 style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", marginBottom: "8px" }}>{selectedProduct.detailLabel || "Description"}</h3>
                <p style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#666", lineHeight: 1.5, margin: 0 }}>
                  <CheckPhoneBilingualText text={selectedProduct.detail || selectedProduct.subtitle} tone="shopping" />
                </p>
              </div>

              <div style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "14px" }}>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999" }}>Price</span>
                  <strong style={{ fontSize: "calc(18px*var(--app-text-scale,1))", color: "#222" }}>{selectedProduct.priceLabel}</strong>
                </div>
                <button
                  type="button"
                  onClick={() => addToCart(selectedProduct)}
                  style={{
                    background: selectedProductRecentlyAdded ? "#16a34a" : "#222",
                    color: "#fff",
                    border: "none",
                    borderRadius: "24px",
                    padding: "12px 24px",
                    fontSize: "calc(13px*var(--app-text-scale,1))",
                    fontWeight: "bold",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    minWidth: "128px",
                    justifyContent: "center",
                    transform: selectedProductRecentlyAdded ? "scale(1.03)" : "scale(1)",
                    transition: "background 160ms ease, transform 180ms ease",
                  }}
                >
                  {selectedProductRecentlyAdded ? <Check size={16} strokeWidth={3} /> : <ShoppingCart size={16} />}
                  {selectedProductRecentlyAdded ? "Added" : cartIds.has(selectedProduct.id) ? "Add Again" : "Add to Cart"}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeOrder && (
          <div style={{ position: "absolute", inset: 0, zIndex: 20, background: "#f8f9fa", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <header style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--page-header-safe-top, 48px) 24px 16px", background: "#fff", borderBottom: "1px solid #f0f0f0", zIndex: 1 }}>
              <button type="button" aria-label="Back" onClick={backAction} style={{ width: "40px", height: "40px", borderRadius: "50%", border: "1px solid #eaeaea", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>
                <ChevronLeft size={20} strokeWidth={2.5} />
              </button>
              <strong style={{ fontSize: "calc(16px*var(--app-text-scale,1))", color: "#222" }}>Order Details</strong>
              <div style={{ width: "40px" }} />
            </header>

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ background: "#fff", borderRadius: "20px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.02)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999" }}>Order Status</span>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: activeOrderShipping?.statusLabel === "已到货" ? "#16a34a" : "#ff6b00", fontWeight: 600 }}>{activeOrderShipping?.statusLabel ?? activeOrder.statusLabel}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999" }}>Merchant</span>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", fontWeight: 500 }}>{activeOrder.merchantLabel}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999" }}>Order Date</span>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", fontWeight: 500 }}>{activeOrder.timeLabel}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px" }}>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#999" }}>Payment</span>
                  <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", fontWeight: 500, textAlign: "right" }}>
                    {activeOrder.paymentStatus === "payment_requested"
                      ? `Waiting for ${activeOrder.payerCharacterName || "them"} to pay`
                      : activeOrder.paymentStatus === "payment_declined"
                        ? `${activeOrder.payerCharacterName || "They"} declined to pay`
                        : activeOrder.paymentCardLabel ?? "No payment method recorded"}
                  </span>
                </div>
              </div>

              {activeOrderShipping?.timeline.length ? (
                <div style={{ background: "#fff", borderRadius: "20px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.02)" }}>
                  <h4 style={{ fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "0 0 16px 0" }}>Shipping Progress</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {activeOrderShipping.timeline.map((event, index) => {
                      const eventTime = new Date(event.timestamp).getTime();
                      const completed = !Number.isNaN(eventTime) && eventTime <= nowTick;
                      const current = event.status === activeOrderShipping.currentStage;
                      return (
                        <div key={`${event.status}-${event.timestamp}`} style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: "10px", position: "relative" }}>
                          <div style={{ position: "relative", display: "flex", justifyContent: "center" }}>
                            {index < activeOrderShipping.timeline.length - 1 ? (
                              <span style={{ position: "absolute", top: "18px", width: "2px", height: "28px", background: completed ? "rgba(255,107,0,0.26)" : "#ececec" }} />
                            ) : null}
                            <span style={{ width: "10px", height: "10px", marginTop: "3px", borderRadius: "50%", background: completed ? current ? "#ff6b00" : "#16a34a" : "#d8d8d8", boxShadow: current ? "0 0 0 5px rgba(255,107,0,0.12)" : "none", zIndex: 1 }} />
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", minWidth: 0 }}>
                            <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: completed ? "#222" : "#999", fontWeight: current ? 700 : 500 }}>{event.label}</span>
                            <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: completed ? "#666" : "#aaa", whiteSpace: "nowrap" }}>{completed ? event.timeLabel : `Est. ${event.timeLabel}`}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <h3 style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", margin: "8px 0 0 0" }}>Items</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {activeOrder.items.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openProduct(item, { tagLabel: activeOrderShipping?.statusLabel ?? activeOrder.statusLabel })}
                    style={{ background: "#fff", borderRadius: "16px", padding: "12px", display: "flex", alignItems: "flex-start", border: "none", boxShadow: "0 2px 10px rgba(0,0,0,0.02)", gap: "12px", textAlign: "left" }}
                  >
                    <div style={{ width: "60px", height: "60px", background: "#f5f5f5", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "calc(28px*var(--app-text-scale,1))", flexShrink: 0 }}>
                      {item.previewIcon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: 600, display: "block", lineHeight: 1.32, overflow: "visible", whiteSpace: "normal" }}><CheckPhoneBilingualText text={item.title} tone="shopping" /></strong>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                        <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold" }}>{item.priceLabel}</span>
                        <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999" }}>x {parseShoppingQuantity(item.quantityLabel)}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              <div style={{ background: "#fff", borderRadius: "20px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.02)" }}>
                <h4 style={{ fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: "bold", color: "#222", marginBottom: "8px" }}>Order Note</h4>
                <p style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#666", margin: 0 }}><CheckPhoneBilingualText text={activeOrder.note} tone="shopping" /></p>
              </div>

              <div style={{ background: "#fff", borderRadius: "20px", padding: "20px", boxShadow: "0 4px 20px rgba(0,0,0,0.02)", marginTop: "auto" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#666", marginBottom: "12px" }}>
                  <span>Total Items</span>
                  <span style={{ color: "#222", fontWeight: 500 }}>{activeOrder.items.length}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(16px*var(--app-text-scale,1))", color: "#222", fontWeight: "bold", borderTop: "1px dashed #eee", paddingTop: "16px" }}>
                  <span>Amount Paid</span>
                  <span style={{ color: "#ff6b00" }}>{activeOrder.totalLabel}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {translationPreview && (
        <div className="cp-shopping-translation-overlay" role="presentation" onClick={() => setTranslationPreview(null)}>
          <div className="cp-shopping-translation-sheet" role="dialog" aria-modal="true" aria-label="Chinese translation" onClick={event => event.stopPropagation()}>
            <div className="cp-shopping-translation-head">
              <span>Chinese Translation</span>
              <button type="button" onClick={() => setTranslationPreview(null)}>Close</button>
            </div>
            <p className="cp-shopping-translation-original">{translationPreview.original}</p>
            <div className="cp-shopping-translation-divider" />
            <p className="cp-shopping-translation-text">{translationPreview.translated}</p>
          </div>
        </div>
      )}

      {clearConfirmOpen && (
        <div className="cp-shopping-translation-overlay" role="presentation" onClick={() => setClearConfirmOpen(false)}>
          <div className="cp-shopping-translation-sheet" role="dialog" aria-modal="true" aria-label="Clear shopping traces" onClick={event => event.stopPropagation()} style={{ maxWidth: "320px" }}>
            <div className="cp-shopping-translation-head">
              <span>Clear Shopping Traces</span>
            </div>
            <p style={{ margin: "4px 0 16px", fontSize: "calc(13.5px*var(--app-text-scale,1))", lineHeight: 1.8, color: "#555" }}>
              Are you sure you want to clear all shopping page traces? This will clear the catalog, orders, and favorites, and cannot be undone.
            </p>
            <div style={{ display: "flex", gap: "10px" }}>
              <button type="button" onClick={() => setClearConfirmOpen(false)} style={{ flex: 1, height: "40px", borderRadius: "12px", border: "1px solid #e5e5e5", background: "#fff", color: "#555", fontSize: "calc(14px*var(--app-text-scale,1))" }}>
                Cancel
              </button>
              <button type="button" onClick={clearAllShoppingTraces} style={{ flex: 1, height: "40px", borderRadius: "12px", border: "none", background: "#e5484d", color: "#fff", fontWeight: 600, fontSize: "calc(14px*var(--app-text-scale,1))" }}>
                Confirm Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {promptOpen && (
        <div className="cp-shopping-translation-overlay" role="presentation" onClick={() => setPromptOpen(false)}>
          <div className="cp-shopping-translation-sheet" role="dialog" aria-modal="true" aria-label="Shopping prompts" onClick={event => event.stopPropagation()} style={{ maxHeight: "74vh" }}>
            <div className="cp-shopping-translation-head">
              <span>Shopping Settings</span>
              <button type="button" onClick={() => setPromptOpen(false)}>Close</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "12px" }}>
              {([
                { id: "prompts" as const, label: "Prompts" },
                { id: "shipping" as const, label: "Delivery Time" },
              ]).map(tab => {
                const active = settingsTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setSettingsTab(tab.id);
                      if (tab.id !== "prompts") {
                        setExpandedPrompts(new Set());
                      }
                    }}
                    style={{ border: active ? "none" : "1px solid #eee", background: active ? "#ff6b00" : "#fff", color: active ? "#fff" : "#555", borderRadius: "16px", padding: "9px 12px", fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 700 }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {settingsTab === "prompts" ? (
              <>
                <div style={{ border: "1px solid #eee", borderRadius: "16px", padding: "12px", background: "#fff" }}>
                  <div style={{ marginBottom: "10px" }}>
                    <strong style={{ display: "block", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", lineHeight: 1.25 }}>Prompts</strong>
                    <span style={{ display: "block", fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999", marginTop: "3px", lineHeight: 1.35 }}>Tap an entry to expand and edit</span>
                  </div>
                  {([
                    { id: "refresh" as const, label: "Home Refresh", value: promptDrafts.refreshPrompt },
                    { id: "search" as const, label: "Search Results", value: promptDrafts.searchPrompt },
                  ]).map(promptItem => {
                    const isOpen = expandedPrompts.has(promptItem.id);
                    return (
                      <div key={promptItem.id} className={`cp-shopping-settings-prompt${isOpen ? " is-open" : ""}`}>
                        <button
                          type="button"
                          className="cp-shopping-settings-prompt-head"
                          aria-expanded={isOpen}
                          onClick={() => setExpandedPrompts(current => {
                            const next = new Set(current);
                            if (next.has(promptItem.id)) next.delete(promptItem.id);
                            else next.add(promptItem.id);
                            return next;
                          })}
                        >
                          <span>{promptItem.label}</span>
                          <ChevronDown size={15} strokeWidth={2} />
                        </button>
                        {isOpen ? (
                          <textarea
                            className="cp-shopping-settings-prompt-textarea"
                            value={promptItem.value}
                            onChange={event => updatePromptDraft(promptItem.id, event.target.value)}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div style={{ border: "1px solid #eee", borderRadius: "16px", padding: "12px", background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ display: "block", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", lineHeight: 1.25 }}>Delivery Time Simulation</strong>
                  <span style={{ display: "block", fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999", marginTop: "3px", lineHeight: 1.35 }}>New orders will auto-arrive within this range</span>
                </div>
                <button type="button" onClick={resetDeliveryDraft} style={{ flex: "0 0 auto", border: "1px solid #eee", background: "#fafafa", color: "#666", borderRadius: "14px", padding: "7px 10px", fontSize: "calc(11px*var(--app-text-scale,1))" }}>Default</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 }}>
                  <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#777" }}>Min Delivery (minutes)</span>
                  <input
                    type="number"
                    min={1}
                    max={10080}
                    value={promptDrafts.deliveryMinMinutes}
                    onChange={event => updateDeliveryDraft("deliveryMinMinutes", event.target.value)}
                    style={{ width: "100%", minWidth: 0, height: "34px", border: "1px solid #eee", borderRadius: "12px", padding: "0 10px", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", outline: "none" }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 }}>
                  <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#777" }}>Max Delivery (minutes)</span>
                  <input
                    type="number"
                    min={1}
                    max={10080}
                    value={promptDrafts.deliveryMaxMinutes}
                    onChange={event => updateDeliveryDraft("deliveryMaxMinutes", event.target.value)}
                    style={{ width: "100%", minWidth: 0, height: "34px", border: "1px solid #eee", borderRadius: "12px", padding: "0 10px", fontSize: "calc(12px*var(--app-text-scale,1))", color: "#222", outline: "none" }}
                  />
                </label>
              </div>
              </div>
            )}
            <div style={{ display: "flex", gap: "10px", justifyContent: "space-between", marginTop: "14px" }}>
              <button type="button" onClick={settingsTab === "prompts" ? resetPromptDraft : resetDeliveryDraft} style={{ border: "1px solid #eee", background: "#fff", color: "#555", borderRadius: "16px", padding: "9px 14px", fontSize: "calc(12px*var(--app-text-scale,1))" }}>
                {settingsTab === "prompts" ? "Restore Default Prompts" : "Restore Default Time"}
              </button>
              <button type="button" onClick={handleSavePrompt} style={{ border: "none", background: "#ff6b00", color: "#fff", borderRadius: "16px", padding: "9px 18px", fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 700 }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {confirmCheckoutOpen && (
        <div className="cp-shopping-translation-overlay" role="presentation" onClick={() => {
          setConfirmCheckoutOpen(false);
          setPaymentError(null);
        }}>
          <div className="cp-shopping-translation-sheet" role="dialog" aria-modal="true" aria-label="Choose payment method" onClick={event => event.stopPropagation()}>
            <div className="cp-shopping-translation-head">
              <span>Choose Payment Method</span>
              <button type="button" onClick={() => {
                setConfirmCheckoutOpen(false);
                setPaymentError(null);
              }}>Close</button>
            </div>

            <div style={{ background: "#fff7ed", border: "1px solid rgba(255,107,0,0.14)", borderRadius: "18px", padding: "14px 16px", marginBottom: "14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#9a5a18", fontWeight: 700 }}>Amount Due</span>
                <strong style={{ fontSize: "calc(22px*var(--app-text-scale,1))", color: "#222", lineHeight: 1 }}>{formatShoppingAmount(cartTotals.totalPayment)}</strong>
              </div>
              <CreditCard size={24} color="#ff6b00" />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxHeight: "42vh", overflowY: "auto", paddingRight: "2px" }}>
              {[
                {
                  id: WALLET_BALANCE_ACCOUNT_ID,
                  title: "Balance Payment",
                  description: "Red Envelopes and Transfers default to balance",
                  balance: getWalletBalance(walletState),
                  icon: <CreditCard size={20} />,
                },
                ...walletState.cards.map(card => ({
                  id: card.id,
                  title: card.title,
                  description: `${getWalletCardDisplayNumber(card.maskedNumber)} · Bank Card`,
                  balance: card.balance,
                  icon: <WalletCards size={20} />,
                })),
              ].map(source => {
                const active = selectedPaymentSource?.id === source.id;
                const insufficient = source.balance < cartTotals.totalPayment;
                return (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => {
                      setSelectedPaymentSourceId(source.id);
                      setPaymentError(null);
                    }}
                    style={{
                      width: "100%",
                      border: active ? "2px solid #ff6b00" : "1px solid #eee",
                      background: "#fff",
                      borderRadius: "18px",
                      padding: "14px",
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      textAlign: "left",
                      boxShadow: active ? "0 10px 24px rgba(255,107,0,0.12)" : "0 4px 14px rgba(0,0,0,0.025)",
                    }}
                  >
                    <div style={{ width: "42px", height: "42px", borderRadius: "16px", background: active ? "#ff6b00" : "#f4f4f5", color: active ? "#fff" : "#555", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {source.icon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }}>
                      <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222" }}>{source.title}</strong>
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888" }}>{source.description} · Available {formatWalletAmount(source.balance)}</span>
                    </div>
                    {insufficient ? (
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#ef4444", fontWeight: 700, whiteSpace: "nowrap" }}>Insufficient balance</span>
                    ) : active ? (
                      <Check size={18} color="#ff6b00" strokeWidth={3} />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {paymentError || (selectedPaymentSource && !selectedPaymentSourceCanPay) ? (
              <div style={{ marginTop: "12px", borderRadius: "14px", background: "#fef2f2", color: "#b91c1c", padding: "10px 12px", display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "calc(12px*var(--app-text-scale,1))", lineHeight: 1.4 }}>
                <AlertCircle size={15} style={{ flexShrink: 0, marginTop: "1px" }} />
                <span>{paymentError ?? "This payment method has insufficient balance to complete payment."}</span>
              </div>
            ) : null}

            <div style={{ display: "flex", gap: "10px", justifyContent: "space-between", marginTop: "14px" }}>
              <button type="button" onClick={() => {
                setConfirmCheckoutOpen(false);
                setPaymentError(null);
              }} style={{ flex: 1, border: "1px solid #eee", background: "#fff", color: "#555", borderRadius: "18px", padding: "12px 0", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 700 }}>Cancel</button>
              <button type="button" disabled={!selectedPaymentSource || !selectedPaymentSourceCanPay} onClick={handleCheckout} style={{ flex: 1.4, border: "none", background: selectedPaymentSource && selectedPaymentSourceCanPay ? "#ff6b00" : "#eee", color: selectedPaymentSource && selectedPaymentSourceCanPay ? "#fff" : "#aaa", borderRadius: "18px", padding: "12px 0", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 800 }}>Confirm Payment</button>
            </div>
          </div>
        </div>
      )}

      {paymentRequestOpen && (
        <div className="cp-shopping-translation-overlay" role="presentation" onClick={() => {
          setPaymentRequestOpen(false);
          setPaymentRequestError(null);
        }}>
          <div
            className="cp-shopping-translation-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Choose who to ask to pay"
            onClick={event => event.stopPropagation()}
            style={{ maxHeight: "min(78vh, 560px)", overflow: "hidden", display: "flex", flexDirection: "column" }}
          >
            <div className="cp-shopping-translation-head" style={{ flexShrink: 0 }}>
              <span>Ask Someone to Pay</span>
              <button type="button" onClick={() => {
                setPaymentRequestOpen(false);
                setPaymentRequestError(null);
              }}>Close</button>
            </div>

            <div style={{ background: "#fff7ed", border: "1px solid rgba(255,107,0,0.14)", borderRadius: "18px", padding: "14px 16px", marginBottom: "14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 }}>
                <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#9a5a18", fontWeight: 700 }}>Payment Amount</span>
                <strong style={{ fontSize: "calc(22px*var(--app-text-scale,1))", color: "#222", lineHeight: 1 }}>{formatShoppingAmount(cartTotals.totalPayment)}</strong>
              </div>
              <HeartHandshake size={24} color="#ff6b00" />
            </div>

            {paymentRequestTargets.length === 0 ? (
              <div className="cp-shopping-status cp-empty-copy" style={{ minHeight: "120px" }}>
                <p>No characters available to choose</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", overflowY: "auto", paddingRight: "2px", flex: "1 1 auto", minHeight: 0 }}>
                {paymentRequestTargets.map(target => {
                  const active = selectedPaymentRequestTargetId === target.id;
                  return (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => {
                        setSelectedPaymentRequestTargetId(target.id);
                        setPaymentRequestError(null);
                      }}
                      style={{
                        width: "100%",
                        border: active ? "2px solid #ff6b00" : "1px solid #eee",
                        background: "#fff",
                        borderRadius: "18px",
                        padding: "14px",
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        textAlign: "left",
                        boxShadow: active ? "0 10px 24px rgba(255,107,0,0.12)" : "0 4px 14px rgba(0,0,0,0.025)",
                      }}
                    >
                      <div style={{ width: "42px", height: "42px", borderRadius: "16px", background: active ? "#ff6b00" : "#f4f4f5", color: active ? "#fff" : "#555", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
                        {target.avatar ? (
                          <img src={target.avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <span style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 800 }}>{target.name.slice(0, 1)}</span>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }}>
                        <strong style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#222" }}>{target.name}</strong>
                        <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#888" }}>Send a payment request to chat</span>
                      </div>
                      {active ? <Check size={18} color="#ff6b00" strokeWidth={3} /> : null}
                    </button>
                  );
                })}
              </div>
            )}

            {paymentRequestError ? (
              <div style={{ marginTop: "12px", borderRadius: "14px", background: "#fef2f2", color: "#b91c1c", padding: "10px 12px", display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "calc(12px*var(--app-text-scale,1))", lineHeight: 1.4, flexShrink: 0 }}>
                <AlertCircle size={15} style={{ flexShrink: 0, marginTop: "1px" }} />
                <span>{paymentRequestError}</span>
              </div>
            ) : null}

            <div style={{ display: "flex", gap: "10px", justifyContent: "space-between", marginTop: "14px", flexShrink: 0 }}>
              <button type="button" onClick={() => {
                setPaymentRequestOpen(false);
                setPaymentRequestError(null);
              }} style={{ flex: 1, border: "1px solid #eee", background: "#fff", color: "#555", borderRadius: "18px", padding: "12px 0", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 700 }}>Cancel</button>
              <button type="button" disabled={!selectedPaymentRequestTargetId} onClick={sendPaymentRequest} style={{ flex: 1.4, border: "none", background: selectedPaymentRequestTargetId ? "#ff6b00" : "#eee", color: selectedPaymentRequestTargetId ? "#fff" : "#aaa", borderRadius: "18px", padding: "12px 0", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 800 }}>Send Request</button>
            </div>
          </div>
        </div>
      )}

      {confirmCartDeleteItemId && (
        <ConfirmDialog
          title="Remove this item?"
          message="This item will be removed from your cart."
          variant="danger"
          confirmLabel="Remove"
          cancelLabel="Cancel"
          onConfirm={confirmRemoveCartItem}
          onCancel={() => setConfirmCartDeleteItemId(null)}
        />
      )}

      {confirmRefreshOpen && (
        <ConfirmDialog
          title="Refresh home recommendations?"
          message="This will regenerate the home category picks. Favorites, cart, and orders will not be affected."
          variant="action"
          confirmLabel="Refresh"
          cancelLabel="Cancel"
          onConfirm={() => {
            setConfirmRefreshOpen(false);
            void handleRefresh();
          }}
          onCancel={() => setConfirmRefreshOpen(false)}
        />
      )}
    </div>
  );
}
