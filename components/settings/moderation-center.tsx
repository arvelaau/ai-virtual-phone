"use client";

// 管理中心（仅管理员可见）：举报队列 / 应用审核 / 用户管理。
// 依赖 docs/moderation-supabase.sql（role 列 + content_reports 表）。

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";

import { ConfirmDialog } from "../ui/modal";
import { fetchReports, moderationApi, type ContentReport } from "@/lib/moderation-client";
import { fetchCustomAppMarketAdminItems, reviewCustomAppMarketItem } from "@/lib/custom-app-market-client";
import type { CustomAppMarketItem } from "@/lib/custom-app-market-types";

const TYPE_LABELS: Record<string, string> = {
  market_app: "Market App",
  game: "Game",
  game_comment: "Game Comment",
  online_doc: "Online Cloud Content",
  online_room: "Online Room",
};

type Tab = "reports" | "review" | "users";

type FoundUser = { id: string; username: string; displayName: string; status: string };

export function ModerationCenter({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [tab, setTab] = useState<Tab>("reports");
  const notice = useCallback((msg: string) => onNotice?.(msg), [onNotice]);

  // ── 举报队列 ──
  const [reportStatus, setReportStatus] = useState<"pending" | "resolved" | "dismissed">("pending");
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [confirmAction, setConfirmAction] = useState<{ kind: "takedown" | "ban"; report: ContentReport } | null>(null);

  const loadReports = useCallback(async (status: "pending" | "resolved" | "dismissed") => {
    setReportsLoading(true);
    try {
      setReports(await fetchReports(status));
    } catch (err) {
      notice(err instanceof Error ? err.message : "Failed to load report list");
    } finally {
      setReportsLoading(false);
    }
  }, [notice]);

  useEffect(() => {
    if (tab === "reports") void loadReports(reportStatus);
  }, [tab, reportStatus, loadReports]);

  const runReportAction = async (report: ContentReport, body: Record<string, unknown>, successText: string) => {
    setBusyIds(current => ({ ...current, [report.id]: true }));
    try {
      await moderationApi(body);
      notice(successText);
      await loadReports(reportStatus);
    } catch (err) {
      notice(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyIds(current => {
        const next = { ...current };
        delete next[report.id];
        return next;
      });
    }
  };

  // ── 应用审核 ──
  const [reviewItems, setReviewItems] = useState<CustomAppMarketItem[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewBusyIds, setReviewBusyIds] = useState<Record<string, boolean>>({});

  const loadReviewItems = useCallback(async () => {
    setReviewLoading(true);
    try {
      setReviewItems(await fetchCustomAppMarketAdminItems({ adminKey: "", view: "pending" }));
    } catch (err) {
      notice(err instanceof Error ? err.message : "Failed to load review list (usually empty if pre-review isn't enabled)");
      setReviewItems([]);
    } finally {
      setReviewLoading(false);
    }
  }, [notice]);

  useEffect(() => {
    if (tab === "review") void loadReviewItems();
  }, [tab, loadReviewItems]);

  const reviewApp = async (item: CustomAppMarketItem, action: "approve" | "reject") => {
    setReviewBusyIds(current => ({ ...current, [item.id]: true }));
    try {
      await reviewCustomAppMarketItem({ adminKey: "", id: item.id, action });
      notice(action === "approve" ? `Approved "${item.name}"` : `Rejected "${item.name}"`);
      await loadReviewItems();
    } catch (err) {
      notice(err instanceof Error ? err.message : "Review action failed");
    } finally {
      setReviewBusyIds(current => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    }
  };

  // ── 用户管理 ──
  const [userQuery, setUserQuery] = useState("");
  const [foundUser, setFoundUser] = useState<FoundUser | null>(null);
  const [userSearched, setUserSearched] = useState(false);
  const [userBusy, setUserBusy] = useState(false);

  const searchUser = async () => {
    const username = userQuery.trim();
    if (!username) return;
    setUserBusy(true);
    try {
      const data = await moderationApi({ action: "findUser", username });
      setFoundUser((data.user as FoundUser | null) ?? null);
      setUserSearched(true);
    } catch (err) {
      notice(err instanceof Error ? err.message : "Search failed");
    } finally {
      setUserBusy(false);
    }
  };

  const toggleBan = async (user: FoundUser) => {
    setUserBusy(true);
    try {
      const banning = user.status !== "disabled";
      await moderationApi({ action: banning ? "banUser" : "unbanUser", userId: user.id });
      notice(banning ? `Banned @${user.username} (can no longer log in)` : `Unbanned @${user.username}`);
      setFoundUser({ ...user, status: banning ? "disabled" : "active" });
    } catch (err) {
      notice(err instanceof Error ? err.message : "Action failed");
    } finally {
      setUserBusy(false);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--surface-card, rgba(255,255,255,.65))",
    border: "1px solid var(--border-soft, rgba(0,0,0,.06))",
    borderRadius: 14,
    padding: "12px 14px",
    marginBottom: 10,
    fontSize: 13,
    lineHeight: 1.6,
  };
  const subStyle: React.CSSProperties = { color: "var(--text-tertiary, #8a8f98)", fontSize: 11.5 };
  const btnStyle: React.CSSProperties = {
    border: "1px solid var(--border-soft, rgba(0,0,0,.1))",
    background: "none",
    borderRadius: 999,
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    color: "inherit",
  };
  const dangerBtn: React.CSSProperties = { ...btnStyle, color: "var(--c-danger, #d9534f)", borderColor: "rgba(217,83,79,.4)" };
  const segStyle = (active: boolean): React.CSSProperties => ({
    ...btnStyle,
    border: "none",
    background: active ? "var(--c-ink, #17181c)" : "var(--surface-inset, rgba(0,0,0,.05))",
    color: active ? "#fff" : "inherit",
  });

  return (
    <div style={{ padding: "4px 2px 24px" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button type="button" style={segStyle(tab === "reports")} onClick={() => setTab("reports")}>Report Queue</button>
        <button type="button" style={segStyle(tab === "review")} onClick={() => setTab("review")}>App Review</button>
        <button type="button" style={segStyle(tab === "users")} onClick={() => setTab("users")}>User Management</button>
      </div>

      {tab === "reports" ? (
        <div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
            {(["pending", "resolved", "dismissed"] as const).map(status => (
              <button key={status} type="button" style={segStyle(reportStatus === status)} onClick={() => setReportStatus(status)}>
                {status === "pending" ? "Pending" : status === "resolved" ? "Resolved" : "Dismissed"}
              </button>
            ))}
            <button type="button" style={{ ...btnStyle, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => void loadReports(reportStatus)}>
              <RefreshCw size={12} />Refresh
            </button>
          </div>
          {reportsLoading ? <p style={subStyle}><Loader2 size={13} className="animate-spin" style={{ verticalAlign: -2 }} /> Loading…</p> : null}
          {!reportsLoading && reports.length === 0 ? <p style={subStyle}>No {reportStatus === "pending" ? "pending " : ""}reports.</p> : null}
          {reports.map(report => (
            <div key={report.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 12.5 }}>[{TYPE_LABELS[report.contentType] ?? report.contentType}] {report.contentOwnerName || "Unknown author"}</strong>
                <span style={subStyle}>{new Date(report.createdAt).toLocaleString()}</span>
              </div>
              <div style={{ margin: "4px 0", wordBreak: "break-all" }}>{report.contentPreview || "(No content preview)"}</div>
              <div style={subStyle}>Reporter: {report.reporterName}{report.reason ? ` · Reason: ${report.reason}` : ""}</div>
              {report.status === "pending" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" style={dangerBtn} disabled={busyIds[report.id]} onClick={() => setConfirmAction({ kind: "takedown", report })}>Take Down</button>
                  {report.contentOwnerId ? (
                    <button type="button" style={dangerBtn} disabled={busyIds[report.id]} onClick={() => setConfirmAction({ kind: "ban", report })}>Ban Author</button>
                  ) : null}
                  <button
                    type="button"
                    style={btnStyle}
                    disabled={busyIds[report.id]}
                    onClick={() => void runReportAction(report, { action: "dismiss", reportId: report.id }, "Report dismissed")}
                  >Dismiss</button>
                </div>
              ) : (
                <div style={{ ...subStyle, marginTop: 6 }}>
                  <ShieldCheck size={12} style={{ verticalAlign: -2 }} /> {report.resolution || report.status}{report.handledBy ? ` · ${report.handledBy}` : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {tab === "review" ? (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={subStyle}>Market apps pending review (requires env var APP_MARKET_REVIEW_ENABLED=true to enable pre-review)</span>
            <button type="button" style={{ ...btnStyle, display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => void loadReviewItems()}><RefreshCw size={12} />Refresh</button>
          </div>
          {reviewLoading ? <p style={subStyle}><Loader2 size={13} className="animate-spin" style={{ verticalAlign: -2 }} /> Loading…</p> : null}
          {!reviewLoading && reviewItems.length === 0 ? <p style={subStyle}>No apps pending review.</p> : null}
          {reviewItems.map(item => (
            <div key={item.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong>{item.name} <span style={subStyle}>v{item.version}</span></strong>
                <span style={subStyle}>{item.authorName}</span>
              </div>
              <div style={{ margin: "4px 0" }}>{item.description || "(No description)"}</div>
              <div style={subStyle}>Permissions: {item.permissions.length > 0 ? item.permissions.join(", ") : "None"}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" style={btnStyle} disabled={reviewBusyIds[item.id]} onClick={() => void reviewApp(item, "approve")}>Approve</button>
                <button type="button" style={dangerBtn} disabled={reviewBusyIds[item.id]} onClick={() => void reviewApp(item, "reject")}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "users" ? (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              value={userQuery}
              onChange={event => setUserQuery(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") void searchUser(); }}
              placeholder="Enter an exact username to search"
              style={{ flex: 1, minWidth: 0, border: "1px solid var(--border-soft, rgba(0,0,0,.1))", borderRadius: 12, padding: "8px 12px", fontSize: 13, background: "var(--surface-inset, rgba(0,0,0,.03))", color: "inherit", outline: "none" }}
            />
            <button type="button" style={{ ...btnStyle, display: "inline-flex", alignItems: "center", gap: 4 }} disabled={userBusy} onClick={() => void searchUser()}>
              <Search size={13} />Search
            </button>
          </div>
          {userSearched && !foundUser ? <p style={subStyle}>No user found with that username.</p> : null}
          {foundUser ? (
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <strong>{foundUser.displayName || foundUser.username}</strong>
                  <div style={subStyle}>@{foundUser.username} · {foundUser.status === "disabled" ? "Banned" : "Active"}</div>
                </div>
                <button type="button" style={foundUser.status === "disabled" ? btnStyle : dangerBtn} disabled={userBusy} onClick={() => void toggleBan(foundUser)}>
                  {foundUser.status === "disabled" ? "Unban" : "Ban"}
                </button>
              </div>
            </div>
          ) : null}
          <p style={{ ...subStyle, marginTop: 8 }}>Once banned, the account cannot log in and its posts and online activity are disabled; unbanning restores it. Admin accounts cannot be banned.</p>
        </div>
      ) : null}

      {confirmAction ? (
        <ConfirmDialog
          title={confirmAction.kind === "takedown" ? "Take Down Content" : "Ban Author"}
          message={confirmAction.kind === "takedown"
            ? `Take down this ${TYPE_LABELS[confirmAction.report.contentType] ?? "content"}? This will apply to all users.`
            : `Ban the author "${confirmAction.report.contentOwnerName || confirmAction.report.contentOwnerId}"? This account will no longer be able to log in.`}
          variant="danger"
          onConfirm={() => {
            const target = confirmAction;
            setConfirmAction(null);
            if (target.kind === "takedown") {
              void runReportAction(target.report, { action: "takedown", reportId: target.report.id }, "Taken down and resolved");
            } else {
              void runReportAction(target.report, { action: "banUser", userId: target.report.contentOwnerId }, `Banned ${target.report.contentOwnerName || "the author"}`);
            }
          }}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
    </div>
  );
}
