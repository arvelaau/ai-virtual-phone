"use client";

import { useEffect, useMemo, useState } from "react";
import { useCheckPhoneRefresh } from "@/lib/checkphone-refresh-tracker";
import { ChevronLeft, Paperclip, RefreshCw, Star, Trash2, Menu, Edit2, Mail, Video, Archive, MoreVertical, ChevronDown, CornerUpLeft, CornerUpRight, Smile } from "lucide-react";
import { CheckPhoneBilingualText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneEmailItem,
  CheckPhoneEmailPayload,
  CheckPhoneSnapshot,
} from "@/lib/checkphone-config";
import { generateCheckPhoneEmail } from "@/lib/checkphone-engine";
import { clearPhoneSnapshot, loadPhoneSnapshot, savePhoneSnapshot } from "@/lib/checkphone-storage";
import { normalizeBilingualTextInput, splitBilingualText } from "@/lib/bilingual-text";

type CheckPhoneEmailPageProps = {
  character: Character;
  onBack: () => void;
};

const EMAIL_MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Read the [Time] label off an email.
 *
 * Accepts the English form the entry teaches now ("3 Aug 14:32") and the legacy Chinese
 * one ("8月3日 14:32"), because snapshots generated before the migration still carry it
 * and nothing rewrites them. Returning null on an unrecognised label is the pre-existing
 * behaviour and stays: the list simply falls back to displaying the raw string.
 */
function parseEmailTimeLabel(label: string): Date | null {
  const trimmed = label.trim();
  let monthRaw: string | undefined;
  let dayRaw: string | undefined;
  let hourRaw: string | undefined;
  let minuteRaw: string | undefined;

  const en = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{1,2}):(\d{2})$/);
  if (en) {
    const monthIndex = EMAIL_MONTH_NAMES.indexOf(en[2].slice(0, 3).toLowerCase());
    if (monthIndex < 0) return null;
    [, dayRaw, , hourRaw, minuteRaw] = en;
    monthRaw = String(monthIndex + 1);
  } else {
    const zh = trimmed.match(/^(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/);
    if (!zh) return null;
    [, monthRaw, dayRaw, hourRaw, minuteRaw] = zh;
  }
  const now = new Date();
  let year = now.getFullYear();
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  let candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(candidate.getTime())) return null;
  if (candidate.getTime() - now.getTime() > 36 * 60 * 60 * 1000) {
    year -= 1;
    candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
  }
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function formatEmailTimeLabel(label: string): string {
  const parsed = parseEmailTimeLabel(label);
  if (!parsed) return label;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);
  const hh = String(parsed.getHours()).padStart(2, "0");
  const mm = String(parsed.getMinutes()).padStart(2, "0");
  if (parsed >= todayStart) return `Today ${hh}:${mm}`;
  if (parsed >= yesterdayStart) return `Yesterday ${hh}:${mm}`;
  return label;
}

function getEmailListPlainText(text: string): string {
  const normalized = normalizeBilingualTextInput(text);
  return splitBilingualText(normalized)?.original ?? normalized;
}

export function CheckPhoneEmailPage({ character, onBack }: CheckPhoneEmailPageProps) {
  const [snapshot, setSnapshot] = useState<CheckPhoneSnapshot<CheckPhoneEmailPayload> | null>(null);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useCheckPhoneRefresh(character.id, "email", setSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setDebugRawOutput(null);
    setSnapshot(null);
    setSelectedEmailId(null);
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhoneEmailPayload>(character.id, "email");
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
    const {
      payload,
      summary,
      error: nextError,
      debugRawOutput: nextDebugRawOutput,
    } = await generateCheckPhoneEmail(
      character.id,
      snapshot?.payload ?? null,
      snapshot?.updatedAt,
    );
    if (payload) {
      const now = new Date().toISOString();
      const nextSnapshot: CheckPhoneSnapshot<CheckPhoneEmailPayload> = {
        id: `${character.id}:email`,
        characterId: character.id,
        appId: "email",
        generatedAt: snapshot?.generatedAt ?? now,
        updatedAt: now,
        summary,
        payload,
      };
      await savePhoneSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setSelectedEmailId(null);
    }
    setError(nextError ?? null);
    setDebugRawOutput(nextDebugRawOutput ?? null);
    setLoading(false);
    setLoaded(true);
  }

  async function handleClear() {
    if (loading) return;
    await clearPhoneSnapshot(character.id, "email");
    setSnapshot(null);
    setSelectedEmailId(null);
    setError(null);
    setDebugRawOutput(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const emails = useMemo(
    () =>
      (payload?.emails ?? [])
        .map((email, index) => ({
          ...email,
          displayTimeLabel: formatEmailTimeLabel(email.timeLabel),
          sortTimestamp: parseEmailTimeLabel(email.timeLabel)?.getTime() ?? Number.NEGATIVE_INFINITY,
          originalIndex: index,
        }))
        .sort((a, b) => {
          if (a.sortTimestamp !== b.sortTimestamp) return b.sortTimestamp - a.sortTimestamp;
          return a.originalIndex - b.originalIndex;
        }),
    [payload?.emails],
  );
  const activeEmail = useMemo(
    () => emails.find((email) => email.id === selectedEmailId) ?? null,
    [emails, selectedEmailId],
  );

  // A simple deterministic color generator for avatars
  const getAvatarColor = (name: string) => {
    const colors = [
      "#ef5350", "#ec407a", "#ab47bc", "#7e57c2", "#5c6bc0", 
      "#42a5f5", "#26c6da", "#26a69a", "#66bb6a", "#9ccc65", 
      "#ffa726", "#ff7043", "#8d6e63", "#78909c"
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  return (
    <div className="cp-email-module">
      {/* 
        LIST VIEW 
      */}
      {!activeEmail && (
        <div className="cp-email-list-view">
          <header className="cp-email-md-appbar">
            <div className="cp-email-search-bar">
              <button 
                 className="cp-email-icon-btn" 
                 onClick={onBack}
                 title="Back to Home"
              >
                <ChevronLeft size={24} strokeWidth={2.5} color="#444746" />
              </button>
              <input type="text" placeholder="Search mail" className="cp-email-search-input" readOnly />
              <button
                 className="cp-email-icon-btn"
                 onClick={handleRefresh}
                 disabled={loading}
                 title="Refresh mail"
                 style={{ transform: "translateX(8px)" }}
              >
                <RefreshCw size={20} className={loading ? "cp-spin" : ""} color="#444746" />
              </button>
              <button
                 className="cp-email-icon-btn"
                 onClick={() => setConfirmClearOpen(true)}
                 title="Clear cache"
              >
                <Trash2 size={20} color="#444746" />
              </button>
              <div className="cp-email-search-avatar">
                {character.name ? character.name.charAt(0).toUpperCase() : 'U'}
              </div>
            </div>
          </header>

          <div className="cp-email-list-container">
            {payload ? <div className="cp-email-list-label">Primary</div> : null}

            {loading && (
              <div className="cp-email-status">Refreshing...</div>
            )}

            {loaded && !payload && !loading && (
              <div className="cp-email-status cp-empty-copy">
                <p>No emails yet</p>
                <span>Tap refresh to sync your inbox and email records</span>
              </div>
            )}

            {error ? <CheckPhoneDebugErrorCard error={error} debugRawOutput={debugRawOutput} /> : null}

            {payload && (
              <div className="cp-email-list">
                {emails.map((email, index) => {
                  const avatarStyle = { background: getAvatarColor(email.senderName), color: "#fff" };

                  return (
                    <button
                      key={email.id}
                      type="button"
                      className={`cp-email-item ${email.unread ? "is-unread" : ""}`}
                      onClick={() => setSelectedEmailId(email.id)}
                      style={{ animationDelay: `${index * 0.03}s` }}
                    >
                      <div className="cp-email-item-avatar" style={avatarStyle}>
                        {email.senderName.charAt(0).toUpperCase()}
                      </div>
                      <div className="cp-email-item-content">
                        <div className="cp-email-item-header">
                          <strong className="cp-email-item-sender">
                            {email.unread && email.senderName.includes("Google") && <span className="cp-email-check-icon">✅</span>}
                            {getEmailListPlainText(email.senderName)}
                          </strong>
                          <span className="cp-email-item-time">{email.displayTimeLabel}</span>
                        </div>
                        <div className="cp-email-item-subject">
                          {getEmailListPlainText(email.subject)}
                        </div>
                        <div className="cp-email-item-preview">
                          {getEmailListPlainText(email.preview)}
                        </div>
                      </div>
                      <div className="cp-email-item-actions">
                        <Star size={20} strokeWidth={email.starred ? 2.5 : 1.5} className={email.starred ? 'cp-email-star-active' : 'cp-email-star'} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <button className="cp-email-fab" type="button">
            <Edit2 size={20} strokeWidth={2.5} color="#001d35" />
            <span style={{ color: "#001d35", fontWeight: 500 }}>Compose</span>
          </button>

          <nav className="cp-email-bottom-nav">
            <div className="cp-email-nav-item is-active">
              <div className="cp-email-nav-icon-wrapper">
                <Mail size={22} fill="currentColor" />
              </div>
            </div>
            <div className="cp-email-nav-item">
              <div className="cp-email-nav-icon-wrapper">
                <Video size={24} strokeWidth={1.5} />
              </div>
            </div>
          </nav>
        </div>
      )}

      {/* 
        DETAIL VIEW 
      */}
      {payload && activeEmail && (
        <div className="cp-email-detail-view">
          <header className="cp-email-detail-topbar">
            <button className="cp-email-icon-btn" onClick={() => setSelectedEmailId(null)}>
               <ChevronLeft size={24} />
            </button>
            <div className="cp-email-detail-top-actions">
              <button className="cp-email-icon-btn"><Archive size={20} /></button>
              <button className="cp-email-icon-btn"><Mail size={20} /></button>
              <button className="cp-email-icon-btn"><MoreVertical size={20} /></button>
            </div>
          </header>

          <div className="cp-email-detail-scroll">
            <div className="cp-email-detail-subject-row">
               <div className="cp-email-detail-subject-text">
                 <h2><CheckPhoneBilingualText text={activeEmail.subject} tone="email" variant="inline" /></h2>
                 <span className="cp-email-tag">Inbox</span>
               </div>
               <button className="cp-email-star-btn">
                 <Star size={22} strokeWidth={1.5} />
               </button>
            </div>

            <div className="cp-email-detail-sender-row">
              <div className="cp-email-item-avatar" style={{ background: getAvatarColor(activeEmail.senderName), color: "#fff" }}>
                {activeEmail.senderName.charAt(0).toUpperCase()}
              </div>
              <div className="cp-email-detail-sender-info">
                <div className="cp-email-sender-name-line">
                  <strong>{activeEmail.senderName}</strong>
                  <span className="cp-email-detail-time">{activeEmail.displayTimeLabel}</span>
                </div>
                <div className="cp-email-detail-to">
                  To me <ChevronDown size={14} />
                </div>
              </div>
              <div className="cp-email-detail-sender-actions">
                <button className="cp-email-icon-btn"><Smile size={20}/></button>
                <button className="cp-email-icon-btn"><CornerUpLeft size={20}/></button>
                <button className="cp-email-icon-btn"><MoreVertical size={20}/></button>
              </div>
            </div>

            <div className="cp-email-detail-body">
              <CheckPhoneBilingualText text={activeEmail.body} tone="email" />
              {activeEmail.attachmentLabel ? (
                <div className="cp-email-attachment">
                  <Paperclip size={14} />
                  {activeEmail.attachmentLabel}
                </div>
              ) : null}
            </div>
          </div>

          <div className="cp-email-detail-bottom-actions">
             <button className="cp-email-action-pill"><CornerUpLeft size={16}/> Reply</button>
             <button className="cp-email-action-pill"><CornerUpRight size={16}/> Forward</button>
             <button className="cp-email-action-circle"><Smile size={18}/></button>
          </div>
        </div>
      )}

      {confirmClearOpen && (
        <ConfirmDialog
          title="Clear email content?"
          message="Once confirmed, the current email cache will be cleared. Future refreshes will no longer bring back the old email content."
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
