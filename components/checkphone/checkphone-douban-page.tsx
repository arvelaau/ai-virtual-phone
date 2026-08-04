"use client";

import { useEffect, useMemo, useState } from "react";
import { useCheckPhoneRefresh } from "@/lib/checkphone-refresh-tracker";
import {
  BookOpen,
  ChevronLeft,
  Film,
  Home,
  MessageSquare,
  MoreHorizontal,
  Music2,
  PenLine,
  RefreshCw,
  Store,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { CheckPhoneBilingualText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneDoubanActivityItem,
  CheckPhoneDoubanPayload,
  CheckPhoneSnapshot,
} from "@/lib/checkphone-config";
import { generateCheckPhoneDouban } from "@/lib/checkphone-engine";
import { clearPhoneSnapshot, loadPhoneSnapshot, savePhoneSnapshot } from "@/lib/checkphone-storage";

type CheckPhoneDoubanPageProps = {
  character: Character;
  onBack: () => void;
};

const DOUBAN_TOP_TABS = ["Home", "Feed", "Books/Movies/Music", "Albums"];

function formatCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(count >= 10000000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.max(0, Math.round(count)));
}

function formatAbsoluteTime(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const timeText = value.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (value >= todayStart) return `Today ${timeText}`;
  if (value >= yesterdayStart) return `Yesterday ${timeText}`;
  return value.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).replace(/\//g, "-");
}

function formatJoinedAt(iso?: string): string {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return value.toISOString().slice(0, 10);
}

function getInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "D";
}

function getActivityVisual(item: CheckPhoneDoubanActivityItem) {
  switch (item.type) {
    case "movie_review":
    case "want_watch":
      return { icon: Film, color: "#22a640" };
    case "book_review":
    case "want_read":
      return { icon: BookOpen, color: "#1faa45" };
    case "diary":
      return { icon: PenLine, color: "#20a841" };
    case "listened":
      return { icon: Music2, color: "#19a84a" };
    case "post":
    default:
      return { icon: MessageSquare, color: "#21a342" };
  }
}

function renderStars(rating?: number) {
  if (!rating) return null;
  const full = Math.max(1, Math.min(5, Math.round(rating)));
  return (
    <div className="cp-douban-stars" aria-label={`${full} stars`}>
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} className={index < full ? "is-filled" : ""}>★</span>
      ))}
    </div>
  );
}

function ActivityCard({ item }: { item: CheckPhoneDoubanActivityItem }) {
  const visual = getActivityVisual(item);
  const Icon = visual.icon;
  const hasSubject = Boolean(item.subjectName || item.subjectMeta || item.coverIcon);
  return (
    <article className="cp-douban-activity-card">
      <div className="cp-douban-activity-side" style={{ color: visual.color }}>
        <Icon size={18} strokeWidth={1.9} />
      </div>
      <div className="cp-douban-activity-main">
        <div className="cp-douban-activity-head">
          <div className="cp-douban-activity-label">
            <strong>{item.actionLabel}</strong>
            {item.categoryLabel ? <span>{item.categoryLabel}</span> : null}
          </div>
          <time>{formatAbsoluteTime(item.createdAt)}</time>
          <MoreHorizontal size={17} strokeWidth={1.8} />
        </div>

        {hasSubject ? (
          <div className="cp-douban-subject-row">
            <div className="cp-douban-subject-cover">{item.coverIcon || item.title.slice(0, 1)}</div>
            <div className="cp-douban-subject-main">
              <h3><CheckPhoneBilingualText text={item.subjectName || item.title} tone="douban" variant="inline" /></h3>
              {item.subjectMeta ? <p><CheckPhoneBilingualText text={item.subjectMeta} tone="douban" variant="inline" /></p> : null}
              {renderStars(item.rating)}
            </div>
          </div>
        ) : (
          <h3 className="cp-douban-activity-title"><CheckPhoneBilingualText text={item.title} tone="douban" variant="inline" /></h3>
        )}

        <p className="cp-douban-activity-body"><CheckPhoneBilingualText text={item.body} tone="douban" /></p>

        <div className="cp-douban-activity-foot">
          <span>{formatCount(item.reactionCount)} reactions</span>
          <span>{formatCount(item.commentCount)} comments</span>
        </div>
      </div>
    </article>
  );
}

export function CheckPhoneDoubanPage({ character, onBack }: CheckPhoneDoubanPageProps) {
  const [snapshot, setSnapshot] = useState<CheckPhoneSnapshot<CheckPhoneDoubanPayload> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useCheckPhoneRefresh(character.id, "douban", setSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [debugParseMode, setDebugParseMode] = useState<"raw" | "sanitized" | "failed" | null>(null);
  const [debugParseError, setDebugParseError] = useState<string | null>(null);
  const [debugNormalizeError, setDebugNormalizeError] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setSnapshot(null);
    setDebugRawOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhoneDoubanPayload>(character.id, "douban");
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
    const {
      payload,
      summary,
      error: nextError,
      debugRawOutput: nextDebugRawOutput,
      debugParseMode: nextDebugParseMode,
      debugParseError: nextDebugParseError,
      debugNormalizeError: nextDebugNormalizeError,
    } = await generateCheckPhoneDouban(
      character.id,
      snapshot?.payload ?? null,
      snapshot?.updatedAt,
    );
    if (payload) {
      const now = new Date().toISOString();
      const nextSnapshot: CheckPhoneSnapshot<CheckPhoneDoubanPayload> = {
        id: `${character.id}:douban`,
        characterId: character.id,
        appId: "douban",
        generatedAt: snapshot?.generatedAt ?? now,
        updatedAt: now,
        summary,
        payload,
      };
      await savePhoneSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
    }
    setError(nextError ?? null);
    setDebugRawOutput(nextDebugRawOutput ?? null);
    setDebugParseMode(nextDebugParseMode ?? null);
    setDebugParseError(nextDebugParseError ?? null);
    setDebugNormalizeError(nextDebugNormalizeError ?? null);
    setLoading(false);
    setLoaded(true);
  }

  async function handleClear() {
    if (loading) return;
    await clearPhoneSnapshot(character.id, "douban");
    setSnapshot(null);
    setError(null);
    setDebugRawOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const profile = payload?.profile ?? null;
  const activities = useMemo(
    () => [...(payload?.activities ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [payload?.activities],
  );

  return (
    <div className="cp-douban-module">
      <header className="cp-douban-appbar">
        <button type="button" className="cp-douban-nav-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={22} strokeWidth={2.2} />
        </button>
        <div className="cp-douban-header-stack">
          <div className="cp-douban-header-title">Douban</div>
        </div>
        <div className="cp-appbar-actions">
          <button type="button" className="cp-douban-nav-btn" onClick={handleRefresh} disabled={loading} aria-label="Refresh">
            <RefreshCw size={17} strokeWidth={2.1} className={loading ? "cp-spin" : ""} />
          </button>
          <button
            type="button"
            className="cp-douban-nav-btn"
            onClick={() => setConfirmClearOpen(true)}
            disabled={loading || !snapshot}
            aria-label="Clear Douban snapshot"
          >
            <Trash2 size={16} strokeWidth={2} />
          </button>
        </div>
      </header>

      {loading && (
        <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
          <span className="cp-refresh-indicator-text">Refreshing Douban</span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
        </div>
      )}

      <div className="cp-douban-body">
        {!loaded && <div className="cp-douban-status">Syncing Douban...</div>}

        {loaded && !payload && !loading && (
          <div className="cp-douban-status cp-empty-copy">
            <p>No Douban content yet</p>
            <span className="cp-douban-hint">Tap refresh to sync profile and feed</span>
          </div>
        )}

        {error ? (
          <CheckPhoneDebugErrorCard
            title="Unable to parse Douban content right now."
            error={error}
            debugParseMode={debugParseMode}
            debugParseError={debugParseError}
            debugNormalizeError={debugNormalizeError}
            debugRawOutput={debugRawOutput}
          />
        ) : null}

        {payload && profile && (
          <>
            <div className="cp-douban-scroll">
              <section className="cp-douban-profile-panel">
                <div className="cp-douban-profile-row">
                  <div className="cp-douban-avatar">{getInitial(profile.name)}</div>
                  <div className="cp-douban-profile-copy">
                    <h2>{profile.name}</h2>
                    <p>
                      <CheckPhoneBilingualText
                        text={profile.bio}
                        className="cp-douban-profile-bio-text"
                        tone="douban"
                        variant="inline"
                      />
                    </p>
                    <span>
                      {[profile.location, profile.joinedAt ? `Joined ${formatJoinedAt(profile.joinedAt)}` : ""].filter(Boolean).join("  |  ")}
                    </span>
                  </div>
                </div>
                <div className="cp-douban-profile-stats">
                  <div><span>Following</span><strong>{formatCount(profile.followingCount)}</strong></div>
                  <div><span>Followers</span><strong>{formatCount(profile.followerCount)}</strong></div>
                  <div><span>Want to Watch</span><strong>{formatCount(profile.wantWatchCount)}</strong></div>
                  <div><span>Want to Read</span><strong>{formatCount(profile.wantReadCount)}</strong></div>
                </div>
              </section>

              <nav className="cp-douban-top-tabs" aria-label="Douban profile tabs">
                {DOUBAN_TOP_TABS.map((tab) => (
                  <span key={tab} className={tab === "Feed" ? "is-active" : ""}>{tab}</span>
                ))}
              </nav>

              <section className="cp-douban-activity-list">
                {activities.map((item) => <ActivityCard key={item.id} item={item} />)}
              </section>
            </div>

            <nav className="cp-douban-bottom-nav" aria-label="Douban navigation">
              <span><Home size={18} strokeWidth={1.8} />Home</span>
              <span><BookOpen size={18} strokeWidth={1.8} />Books/Movies/Music</span>
              <span><UsersRound size={18} strokeWidth={1.8} />Groups</span>
              <span><Store size={18} strokeWidth={1.8} />Marketplace</span>
              <span className="is-active"><UserRound size={18} strokeWidth={1.8} />Me</span>
            </nav>
          </>
        )}
      </div>

      {confirmClearOpen && (
        <ConfirmDialog
          title="Clear Douban content?"
          message="This clears the current Douban cache. Refreshing again won't bring back the old content."
          variant="danger"
          confirmLabel="Confirm Clear"
          cancelLabel="Cancel"
          onConfirm={handleClear}
          onCancel={() => setConfirmClearOpen(false)}
        />
      )}
    </div>
  );
}
