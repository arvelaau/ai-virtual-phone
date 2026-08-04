"use client";

import { useEffect, useRef, useState } from "react";

import "./verify.css";

const QUERY_CODE_KEY = "float_verify_query_code";

type StatusResult = {
  status: "pending" | "approved" | "rejected";
  activationCode: string | null;
  note: string | null;
};

export default function VerifyPage() {
  const [tab, setTab] = useState<"apply" | "check">("apply");
  const [contact, setContact] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queryCode, setQueryCode] = useState("");
  const [checkCode, setCheckCode] = useState("");
  const [statusResult, setStatusResult] = useState<StatusResult | null>(null);
  const [copied, setCopied] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function copyText(text: string, key: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopied(key);
      setTimeout(() => setCopied(current => (current === key ? "" : current)), 1800);
    } catch {
      setError("Copy failed. Please press and hold to copy manually.");
    }
  }

  useEffect(() => {
    document.title = "Float · Beta Access Application";
    try {
      const saved = window.localStorage.getItem(QUERY_CODE_KEY) || "";
      if (saved) {
        setCheckCode(saved);
        setTab("check");
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  function pickFile(picked: File | null) {
    setError("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (!picked) { setFile(null); setPreviewUrl(""); return; }
    if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(picked.type)) {
      setError("Only JPG, PNG, and WebP images are supported."); return;
    }
    if (picked.size > 4 * 1024 * 1024) {
      setError("Image is too large. Please compress it to under 4MB before uploading."); return;
    }
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
  }

  async function submit() {
    if (busy) return;
    setError("");
    if (!contact.trim()) { setError("Please enter your Xiaohongshu (Rednote) username."); return; }
    if (!file) { setError("Please upload a proof image."); return; }
    setBusy(true);
    try {
      const formData = new FormData();
      formData.set("contact", contact.trim());
      formData.set("file", file);
      const response = await fetch("/api/verify/submit", { method: "POST", body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "Submission failed. Please try again later.");
      setQueryCode(data.queryCode);
      setCheckCode(data.queryCode);
      try { window.localStorage.setItem(QUERY_CODE_KEY, data.queryCode); } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed. Please try again later.");
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (busy) return;
    setError("");
    setStatusResult(null);
    const code = checkCode.trim().toUpperCase();
    if (!code) { setError("Please enter a query code."); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/verify/status?code=${encodeURIComponent(code)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "Query failed. Please try again later.");
      setStatusResult({ status: data.status, activationCode: data.activationCode, note: data.note });
      try { window.localStorage.setItem(QUERY_CODE_KEY, code); } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed. Please try again later.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="vr-root">
      <div className="vr-brand">Float</div>
      <div className="vr-brand-sub">Beta Access Application · Adult Verification</div>

      <section className="vr-card">
        <div className="vr-tabs">
          <button type="button" className={`vr-tab${tab === "apply" ? " on" : ""}`} onClick={() => { setTab("apply"); setError(""); }}>Submit Application</button>
          <button type="button" className={`vr-tab${tab === "check" ? " on" : ""}`} onClick={() => { setTab("check"); setError(""); }}>Check Progress</button>
        </div>

        {error ? <div className="vr-error">{error}</div> : null}

        {tab === "apply" ? (
          queryCode ? (
            <div>
              <div className="vr-code-box">
                <div className="vr-code-label">Your query code · Please be sure to save it</div>
                <div className="vr-code-value">{queryCode}</div>
                <button type="button" className="vr-copy-btn" onClick={() => copyText(queryCode, "query")}>
                  {copied === "query" ? "✓ Copied" : "Copy Query Code"}
                </button>
              </div>
              <div className="vr-warn">
                ⚠️ Your query code is the <b>only proof</b> needed to claim your activation code. Please <b>copy it and send it to yourself</b> right away (or take a screenshot to save it).
                If you forget your query code, you won&apos;t be able to check your review result and will have to submit a new application.
              </div>
              <div className="vr-note">
                Once the review is complete, come back to this page and enter your query code under &quot;Check Progress&quot; to claim your activation code.
                The query code has been automatically saved in this browser, but if you switch devices or clear your cache, you&apos;ll only be able to recover it from your own saved copy.
              </div>
              <button type="button" className="vr-btn ghost" onClick={() => { setTab("check"); setStatusResult(null); }}>
                Go to Check Progress
              </button>
            </div>
          ) : (
            <div>
              <div className="vr-note">
                To comply with content rating requirements, this app&apos;s beta is open to adults only. Please upload an image that proves you are an adult
                (such as the date-of-birth section of an ID). <b>Please cover up any information unrelated to age (name, ID number, address, etc.)</b>.
                The image will be deleted immediately after review and will not be retained.
              </div>
              <label className="vr-field">
                <span>Xiaohongshu (Rednote) username (helps us match your account during review)</span>
                <input
                  type="text"
                  value={contact}
                  onChange={event => setContact(event.target.value)}
                  placeholder="Enter your Xiaohongshu (Rednote) username"
                  maxLength={120}
                />
              </label>
              <div className="vr-field">
                <span>Proof-of-age image (JPG / PNG / WebP, &le; 4MB)</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: "none" }}
                  onChange={event => pickFile(event.target.files?.[0] ?? null)}
                />
                {previewUrl ? (
                  <img src={previewUrl} alt="Preview" className="vr-preview" onClick={() => fileInputRef.current?.click()} />
                ) : (
                  <div className="vr-pick" onClick={() => fileInputRef.current?.click()}>
                    Click to select an image
                  </div>
                )}
              </div>
              <button type="button" className="vr-btn" disabled={busy} onClick={submit}>
                {busy ? "Submitting…" : "Submit Application"}
              </button>
            </div>
          )
        ) : (
          <div>
            <label className="vr-field">
              <span>Query Code</span>
              <input
                type="text"
                value={checkCode}
                onChange={event => setCheckCode(event.target.value)}
                placeholder="VR-XXXXXXXX"
                maxLength={16}
              />
            </label>
            <button type="button" className="vr-btn" disabled={busy} onClick={check}>
              {busy ? "Checking…" : "Check"}
            </button>
            {statusResult ? (
              statusResult.status === "approved" ? (
                <div className="vr-status approved">
                  Approved 🎉
                  <div className="vr-code-box" style={{ margin: "12px 0 0" }}>
                    <div className="vr-code-label">Your Activation Code</div>
                    <div className="vr-code-value">{statusResult.activationCode}</div>
                    <button type="button" className="vr-copy-btn"
                      onClick={() => copyText(statusResult.activationCode || "", "activation")}>
                      {copied === "activation" ? "✓ Copied" : "Copy Activation Code"}
                    </button>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12.5 }}>Go back to the login page and enter it when you sign up.</div>
                </div>
              ) : statusResult.status === "rejected" ? (
                <div className="vr-status rejected">
                  Application not approved.
                  {statusResult.note ? <div style={{ marginTop: 6 }}>Reason: {statusResult.note}</div> : null}
                  <div style={{ marginTop: 6, fontSize: 12.5 }}>If you have questions, contact the author in the group chat, or submit a new application.</div>
                </div>
              ) : (
                <div className="vr-status pending">Reviewing at lightning speed...</div>
              )
            ) : null}
          </div>
        )}
      </section>

      <a className="vr-back" href="/">← Back to Login</a>
      <div className="vr-footer">FLOAT · LIMITED BETA</div>
    </main>
  );
}
