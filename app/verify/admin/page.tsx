"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "../verify.css";

const ADMIN_KEY_STORAGE = "float_verify_admin_key";

type AdminItem = {
  id: string;
  queryCode: string;
  contact: string;
  status: "pending" | "approved" | "rejected";
  activationCode: string | null;
  note: string | null;
  createdAt: string;
  reviewedAt: string | null;
  hasImage: boolean;
};

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function AdminImage({ id, adminKey }: { id: string; adminKey: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const node = hostRef.current;
    if (!node || shouldLoad) return;
    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setShouldLoad(true);
        observer.disconnect();
      }
    }, { rootMargin: "300px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    let objectUrl = "";
    setSrc("");
    setError("");

    void (async () => {
      try {
        const response = await fetch(`/api/verify/admin/image?id=${encodeURIComponent(id)}`, {
          headers: { "x-verify-admin-key": adminKey },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Image failed to load (${response.status})`);
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Image failed to load");
        }
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [adminKey, id, shouldLoad]);

  return (
    <div ref={hostRef}>
      {error ? <div className="vr-error" style={{ marginTop: 8 }}>Failed to load review image: {error}</div> : null}
      {!error && !src ? <div className="vr-admin-time" style={{ marginTop: 8 }}>Loading review image…</div> : null}
      {src ? <img className="vr-admin-img" src={src} alt="Review image" /> : null}
    </div>
  );
}

export default function VerifyAdminPage() {
  const [key, setKey] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [items, setItems] = useState<AdminItem[]>([]);
  const [view, setView] = useState<"pending" | "all">("pending");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (adminKey: string, which: "pending" | "all") => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/verify/admin?view=${which}`, { headers: { "x-verify-admin-key": adminKey } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "Failed to load");
      setItems(data.items as AdminItem[]);
      setUnlocked(true);
      try { window.localStorage.setItem(ADMIN_KEY_STORAGE, adminKey); } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      if (!unlocked) setUnlocked(false);
    } finally {
      setLoading(false);
    }
  }, [unlocked]);

  useEffect(() => {
    document.title = "Float · Review Console";
    try {
      const saved = window.localStorage.getItem(ADMIN_KEY_STORAGE) || "";
      if (saved) { setKey(saved); void refresh(saved, "pending"); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function decide(id: string, action: "approve" | "reject") {
    if (busyId) return;
    let note = "";
    if (action === "reject") note = window.prompt("Rejection reason (shown to the applicant, may be left blank):") ?? "";
    else if (!window.confirm("Confirm approval and automatically issue an activation code?")) return;
    setBusyId(id);
    setError("");
    try {
      const response = await fetch("/api/verify/admin", {
        method: "POST",
        headers: { "content-type": "application/json", "x-verify-admin-key": key },
        body: JSON.stringify({ id, action, note }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "Action failed");
      await refresh(key, view);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyId("");
    }
  }

  return (
    <main className="vr-root">
      <div className="vr-brand">Float</div>
      <div className="vr-brand-sub">Beta Review Console · Admin</div>

      <section className="vr-card" style={{ maxWidth: 560 }}>
        {!unlocked ? (
          <div>
            <label className="vr-field">
              <span>Admin Key (VERIFY_ADMIN_KEY)</span>
              <input type="text" value={key} onChange={event => setKey(event.target.value)} placeholder="Enter key to access the review console" />
            </label>
            {error ? <div className="vr-error">{error}</div> : null}
            <button type="button" className="vr-btn" disabled={loading || !key.trim()} onClick={() => refresh(key.trim(), view)}>
              {loading ? "Verifying…" : "Enter Review Console"}
            </button>
          </div>
        ) : (
          <div>
            <div className="vr-tabs">
              <button type="button" className={`vr-tab${view === "pending" ? " on" : ""}`} onClick={() => { setView("pending"); void refresh(key, "pending"); }}>Pending</button>
              <button type="button" className={`vr-tab${view === "all" ? " on" : ""}`} onClick={() => { setView("all"); void refresh(key, "all"); }}>All Records</button>
            </div>
            {error ? <div className="vr-error">{error}</div> : null}
            <button type="button" className="vr-btn ghost" style={{ marginTop: 0 }} disabled={loading} onClick={() => refresh(key, view)}>
              {loading ? "Refreshing…" : "Refresh List"}
            </button>

            <div className="vr-admin-list">
              {items.length === 0 && !loading ? <div className="vr-status pending">{view === "pending" ? "No pending applications." : "No records."}</div> : null}
              {items.map(item => (
                <div key={item.id} className="vr-admin-item">
                  <div className="vr-admin-meta">
                    <span className="vr-admin-contact">{item.contact}</span>
                    <span className={`vr-admin-tag ${item.status}`}>{item.status === "pending" ? "Pending" : item.status === "approved" ? "Approved" : "Rejected"}</span>
                  </div>
                  <div className="vr-admin-time">Submitted {formatTime(item.createdAt)} · Query code {item.queryCode}{item.reviewedAt ? ` · Reviewed ${formatTime(item.reviewedAt)}` : ""}</div>
                  {item.status === "approved" && item.activationCode ? <div className="vr-admin-time">Activation code issued: <span className="vr-admin-code">{item.activationCode}</span></div> : null}
                  {item.status === "rejected" && item.note ? <div className="vr-admin-time">Rejection reason: {item.note}</div> : null}
                  {item.hasImage ? <AdminImage id={item.id} adminKey={key} /> : <div className="vr-admin-time" style={{ marginTop: 8 }}>(Image deleted)</div>}
                  {item.status === "pending" ? (
                    <div className="vr-admin-actions">
                      <button type="button" className="vr-admin-approve" disabled={busyId === item.id} onClick={() => decide(item.id, "approve")}>{busyId === item.id ? "Processing…" : "Approve & Issue Code"}</button>
                      <button type="button" className="vr-admin-reject" disabled={busyId === item.id} onClick={() => decide(item.id, "reject")}>Reject</button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
