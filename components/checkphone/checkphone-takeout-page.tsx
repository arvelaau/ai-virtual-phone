"use client";

import { useEffect, useMemo, useState } from "react";
import { useCheckPhoneRefresh } from "@/lib/checkphone-refresh-tracker";
import { ChevronLeft, StickyNote, Search, RotateCcw, Eraser } from "lucide-react";
import { CheckPhoneBilingualText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneSnapshot,
  CheckPhoneTakeoutOrder,
  CheckPhoneTakeoutPayload,
} from "@/lib/checkphone-config";
import { generateCheckPhoneTakeout } from "@/lib/checkphone-engine";
import { clearPhoneSnapshot, loadPhoneSnapshot, savePhoneSnapshot } from "@/lib/checkphone-storage";

type CheckPhoneTakeoutPageProps = {
  character: Character;
  onBack: () => void;
};

const TAKEOUT_TABS = ["美食", "饮品", "商超", "药品", "其他"] as const;
const TAKEOUT_FILTERS = ["全部", ...TAKEOUT_TABS] as const;

type TakeoutFilter = (typeof TAKEOUT_FILTERS)[number];

function formatTakeoutTime(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const hhmm = value.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (value >= todayStart) return `Today ${hhmm}`;
  if (value >= yesterdayStart) return `Yesterday ${hhmm}`;
  return value.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).replace(/\//g, ".") + ` ${hhmm}`;
}

function formatAmount(amount: number): string {
  return `¥ ${Number.isInteger(amount) ? amount : amount.toFixed(2).replace(/\.00$/, "")}`;
}

type RenderableTakeoutItem = CheckPhoneTakeoutOrder["items"][number] | string;

function getTakeoutItemName(item: RenderableTakeoutItem): string {
  return typeof item === "string" ? item : item.name;
}

function getTakeoutItemIcon(item: RenderableTakeoutItem, orderIcon: string): string {
  return typeof item === "string" ? orderIcon : item.icon;
}

function buildOrderPreview(order: CheckPhoneTakeoutOrder): string {
  if (order.items.length === 1) return getTakeoutItemName(order.items[0] ?? "");
  const first = getTakeoutItemName(order.items[0] ?? "");
  return `${first} and ${order.items.length} items`;
}

export function CheckPhoneTakeoutPage({ character, onBack }: CheckPhoneTakeoutPageProps) {
  const [snapshot, setSnapshot] = useState<CheckPhoneSnapshot<CheckPhoneTakeoutPayload> | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<TakeoutFilter>("全部");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useCheckPhoneRefresh(character.id, "takeout", setSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [debugSanitizedOutput, setDebugSanitizedOutput] = useState<string | null>(null);
  const [debugParseMode, setDebugParseMode] = useState<"raw" | "sanitized" | "failed" | null>(null);
  const [debugParseError, setDebugParseError] = useState<string | null>(null);
  const [debugNormalizeError, setDebugNormalizeError] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setSnapshot(null);
    setSelectedOrderId(null);
    setSelectedCategory("全部");
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhoneTakeoutPayload>(character.id, "takeout");
      if (cancelled) return;
      setSnapshot(cached);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  async function handleRefresh() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    const {
      payload,
      summary,
      error: nextError,
      debugRawOutput: nextDebugRawOutput,
      debugSanitizedOutput: nextDebugSanitizedOutput,
      debugParseMode: nextDebugParseMode,
      debugParseError: nextDebugParseError,
      debugNormalizeError: nextDebugNormalizeError,
    } = await generateCheckPhoneTakeout(character.id, snapshot?.payload ?? null, snapshot?.updatedAt);
    if (payload) {
      const now = new Date().toISOString();
      const nextSnapshot: CheckPhoneSnapshot<CheckPhoneTakeoutPayload> = {
        id: `${character.id}:takeout`,
        characterId: character.id,
        appId: "takeout",
        generatedAt: snapshot?.generatedAt ?? now,
        updatedAt: now,
        summary,
        payload,
      };
      await savePhoneSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setSelectedOrderId(null);
      setSelectedCategory("全部");
    }
    setError(nextError ?? null);
    setDebugRawOutput(nextDebugRawOutput ?? null);
    setDebugSanitizedOutput(nextDebugSanitizedOutput ?? null);
    setDebugParseMode(nextDebugParseMode ?? null);
    setDebugParseError(nextDebugParseError ?? null);
    setDebugNormalizeError(nextDebugNormalizeError ?? null);
    setLoading(false);
    setLoaded(true);
  }

  async function handleClear() {
    if (loading) return;
    await clearPhoneSnapshot(character.id, "takeout");
    setSnapshot(null);
    setSelectedOrderId(null);
    setSelectedCategory("全部");
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const orders = useMemo(() => payload?.orders ?? [], [payload?.orders]);
  const visibleOrders = useMemo(
    () => selectedCategory === "全部" ? orders : orders.filter((order) => order.category === selectedCategory),
    [orders, selectedCategory],
  );
  const activeOrder = useMemo(
    () => orders.find((order) => order.id === selectedOrderId) ?? null,
    [orders, selectedOrderId],
  );

  return (
    <div className="cp-takeout-module">
      <header
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "var(--cp-appbar-safe-top) 16px 10px",
          background: "#fff",
          zIndex: 4,
        }}
      >
        <button
          type="button"
          onClick={activeOrder ? () => setSelectedOrderId(null) : onBack}
          aria-label="Back"
          style={{ background: "transparent", border: "none", color: "#333", padding: 0 }}
        >
          <ChevronLeft size={26} strokeWidth={2.5} />
        </button>
        <div
          style={{
            flex: 1,
            height: "36px",
            background: "#f5f5f5",
            borderRadius: "18px",
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            color: "#999",
            fontSize: "calc(14px*var(--app-text-scale,1))",
            gap: "6px",
          }}
        >
          <Search size={16} />
          <span>{payload?.headerTitle || "Search my orders"}</span>
        </div>
        <div style={{ display: "flex", gap: "16px", marginLeft: "4px" }}>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            aria-label="Refresh"
            style={{
              background: "transparent",
              border: "none",
              color: "#333",
              padding: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "2px",
              fontSize: "calc(10px*var(--app-text-scale,1))",
            }}
          >
            <RotateCcw size={18} strokeWidth={2} className={loading ? "cp-spin" : ""} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => setConfirmClearOpen(true)}
            disabled={loading || !snapshot}
            aria-label="Clear"
            style={{
              background: "transparent",
              border: "none",
              color: "#333",
              padding: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "2px",
              fontSize: "calc(10px*var(--app-text-scale,1))",
            }}
          >
            <Eraser size={18} strokeWidth={2} />
            <span>Clear</span>
          </button>
        </div>
      </header>

      {loading && (
        <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
          <span className="cp-refresh-indicator-text">Refreshing takeout...</span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
        </div>
      )}

      <div className="cp-takeout-body" style={{ marginTop: 0 }}>
        {!loaded && <div className="cp-takeout-status">Syncing orders...</div>}

        {loaded && !payload && !loading && (
          <div className="cp-takeout-status cp-empty-copy">
            <p>No takeout content yet</p>
            <span className="cp-takeout-hint">Tap refresh to sync recent orders</span>
          </div>
        )}

        {error ? (
          <CheckPhoneDebugErrorCard
            title="Unable to parse takeout content right now."
            error={error}
            debugParseMode={debugParseMode}
            debugParseError={debugParseError}
            debugNormalizeError={debugNormalizeError}
            debugRawOutput={debugRawOutput}
            debugSanitizedOutput={debugSanitizedOutput}
          />
        ) : null}

        {payload && (
          <>
            <section className="cp-takeout-hero">
              <div className="cp-takeout-hero-copy">
                <h2>Takeout</h2>
                <p>Fragments of life, hidden in every order.</p>
              </div>

              <div
                className="cp-takeout-tabs"
                role="tablist"
                aria-label="Takeout categories"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 0,
                  padding: "12px 6px 6px",
                  overflow: "visible"
                }}
              >
                {TAKEOUT_FILTERS.map((category) => (
                  <button
                    key={category}
                    type="button"
                    className={`cp-takeout-tab${selectedCategory === category ? " is-active" : ""}`}
                    onClick={() => setSelectedCategory(category)}
                    role="tab"
                    aria-selected={selectedCategory === category}
                    style={{
                      fontSize: selectedCategory === category ? "16px" : "15px",
                      padding: "4px 8px"
                    }}
                  >
                    {category}
                  </button>
                ))}
              </div>
            </section>

            {visibleOrders.length === 0 ? (
              <div className="cp-takeout-status">
                <p>No orders in this category yet.</p>
                <span className="cp-takeout-hint">Switch categories above, or refresh to sync recent orders.</span>
              </div>
            ) : (
          <div className="cp-takeout-list">
            {visibleOrders.map((order) => (
              <button
                key={order.id}
                type="button"
                className="cp-takeout-order-card"
                onClick={() => setSelectedOrderId(order.id)}
              >
                <div className="cp-takeout-order-head">
                  <div className="cp-takeout-order-shop">
                    <div className="cp-takeout-order-icon">{order.icon}</div>
                    <strong><CheckPhoneBilingualText text={order.shopName} tone="takeout" /></strong>
                    <span style={{ fontSize: 'calc(13px*var(--app-text-scale,1))', color: '#999', marginLeft: '2px' }}>&gt;</span>
                  </div>
                  <span className="cp-takeout-order-status">{order.status}</span>
                </div>
                <div className="cp-takeout-order-content">
                  <p><CheckPhoneBilingualText text={buildOrderPreview(order)} tone="takeout" /></p>
                  <div className="cp-takeout-order-price">{formatAmount(order.amount)}</div>
                </div>
                <div className="cp-takeout-order-footer">
                  <div className="cp-takeout-order-time">Ordered: {formatTakeoutTime(order.createdAt)}</div>
                  <div className="cp-takeout-order-actions">
                    <div className="cp-takeout-btn">More</div>
                    <div className="cp-takeout-btn cp-takeout-btn-primary">Order again</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
            )}
          </>
        )}

        {activeOrder ? (
          <div className="cp-takeout-detail-backdrop" onClick={() => setSelectedOrderId(null)}>
            <div className="cp-takeout-detail" onClick={(event) => event.stopPropagation()}>
              <div className="cp-takeout-detail-topbar" style={{ position: "sticky", top: 0, zIndex: 10, background: "#f5f5f5" }}>
                <button type="button" onClick={() => setSelectedOrderId(null)} aria-label="Back">
                  <ChevronLeft size={24} strokeWidth={2.5} />
                </button>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <button type="button" style={{ fontSize: 'calc(14px*var(--app-text-scale,1))', fontWeight: 500 }}>Contact support</button>
                </div>
              </div>

              <div className="cp-takeout-detail-status-header">
                {activeOrder.status === "已完成" ? "订单已完成" :
                 activeOrder.status === "已取消" ? "订单已取消" : activeOrder.status}
                <div style={{ fontSize: 'calc(13px*var(--app-text-scale,1))', color: '#666', marginTop: '4px', fontWeight: 'normal' }}>
                  Thank you for your trust -- we look forward to serving you again.
                </div>
              </div>

              <div className="cp-takeout-detail-actions">
                <button type="button" className="cp-takeout-btn" style={{ whiteSpace: "nowrap", padding: "6px 8px", fontSize: "calc(11px*var(--app-text-scale,1))" }}>More</button>
                <button type="button" className="cp-takeout-btn" style={{ whiteSpace: "nowrap", padding: "6px 8px", fontSize: "calc(11px*var(--app-text-scale,1))" }}>Request after-sales</button>
                <button type="button" className="cp-takeout-btn" style={{ whiteSpace: "nowrap", padding: "6px 8px", fontSize: "calc(11px*var(--app-text-scale,1))" }}>Contact merchant</button>
                <button type="button" className="cp-takeout-btn" style={{ whiteSpace: "nowrap", padding: "6px 8px", fontSize: "calc(11px*var(--app-text-scale,1))" }}>Call rider</button>
                <button type="button" className="cp-takeout-btn cp-takeout-btn-primary" style={{ whiteSpace: "nowrap", padding: "6px 8px", fontSize: "calc(11px*var(--app-text-scale,1))" }}>Order again</button>
              </div>

              <div className="cp-takeout-detail-card">
                <div className="cp-takeout-detail-shop">
                  <div className="cp-takeout-order-icon" style={{ width: 24, height: 24, fontSize: "calc(14px*var(--app-text-scale,1))" }}>{activeOrder.icon}</div>
                  <h3><CheckPhoneBilingualText text={activeOrder.shopName} tone="takeout" /> <span style={{ color: '#ccc', fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 'normal', marginLeft: 4 }}>&gt;</span></h3>
                </div>

                <div>
                  {activeOrder.items.map((item, index) => (
                    <div key={`${activeOrder.id}-${index}`} className="cp-takeout-detail-item">
                      <div className="cp-takeout-detail-item-img">
                        {getTakeoutItemIcon(item, activeOrder.icon)}
                      </div>
                      <div className="cp-takeout-detail-item-info">
                        <h4><CheckPhoneBilingualText text={getTakeoutItemName(item)} tone="takeout" /></h4>
                        <div className="cp-takeout-detail-item-qty">x 1</div>
                      </div>
                      <div className="cp-takeout-detail-item-price">
                      </div>
                    </div>
                  ))}
                </div>

                <div className="cp-takeout-detail-fee">
                  <span>Packaging fee</span>
                  <span>¥1</span>
                </div>
                <div className="cp-takeout-detail-fee">
                  <span>Delivery fee</span>
                  <span>Free delivery</span>
                </div>

                <div className="cp-takeout-detail-total">
                  Total paid <strong>{formatAmount(activeOrder.amount)}</strong>
                </div>
              </div>

              {activeOrder.scenario || activeOrder.innerVoice ? (
                <div className="cp-takeout-detail-section">
                  {activeOrder.scenario && (
                    <>
                      <h4>Scenario notes</h4>
                      <p style={{ marginBottom: '16px' }}><CheckPhoneBilingualText text={activeOrder.scenario} tone="takeout" /></p>
                    </>
                  )}
                  {activeOrder.innerVoice && (
                    <>
                      <h4>Inner thoughts</h4>
                      <p><CheckPhoneBilingualText text={activeOrder.innerVoice} tone="takeout" /></p>
                    </>
                  )}
                </div>
              ) : null}

              {activeOrder.note ? (
                <div className="cp-takeout-detail-section">
                  <h4>Order note</h4>
                  <p><CheckPhoneBilingualText text={activeOrder.note} tone="takeout" /></p>
                </div>
              ) : null}

              {activeOrder.review ? (
                <div className="cp-takeout-detail-section">
                  <h4>Review</h4>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                    <StickyNote size={14} style={{ marginTop: 2, flexShrink: 0, color: '#999' }} />
                    <p><CheckPhoneBilingualText text={activeOrder.review} tone="takeout" /></p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {confirmClearOpen && (
        <ConfirmDialog
          title="Clear takeout content?"
          message="Confirming will clear this character's generated takeout cache. Refreshing again afterward will not bring back the old content."
          variant="danger"
          confirmLabel="Confirm clear"
          cancelLabel="Cancel"
          onConfirm={handleClear}
          onCancel={() => setConfirmClearOpen(false)}
        />
      )}
    </div>
  );
}
