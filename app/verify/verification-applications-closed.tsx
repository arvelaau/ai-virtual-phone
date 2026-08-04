"use client";

import { useEffect, useState } from "react";

import { VERIFY_APPLICATIONS_CLOSED_MESSAGE } from "@/lib/verification-availability";

const QUERY_CODE_KEY = "float_verify_query_code";

type StatusResult = {
  status: "pending" | "approved" | "rejected";
  activationCode: string | null;
  note: string | null;
};

export function VerificationApplicationsClosed() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkCode, setCheckCode] = useState("");
  const [statusResult, setStatusResult] = useState<StatusResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = "Float · Eligibility Check";
    try {
      setCheckCode(window.localStorage.getItem(QUERY_CODE_KEY) || "");
    } catch { /* ignore */ }
  }, []);

  async function copyActivationCode() {
    const code = statusResult?.activationCode || "";
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed. Please press and hold to copy manually.");
    }
  }

  async function check() {
    if (busy) return;
    setError("");
    setStatusResult(null);
    const code = checkCode.trim().toUpperCase();
    if (!code) {
      setError("Please enter a query code.");
      return;
    }

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
      <div className="vr-brand-sub">Access Eligibility Check · Adult Verification</div>

      <section className="vr-card">
        <div className="vr-note">{VERIFY_APPLICATIONS_CLOSED_MESSAGE}</div>
        {error ? <div className="vr-error">{error}</div> : null}

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
          {busy ? "Checking…" : "Check Progress"}
        </button>

        {statusResult ? (
          statusResult.status === "approved" ? (
            <div className="vr-status approved">
              Approved 🎉
              <div className="vr-code-box" style={{ margin: "12px 0 0" }}>
                <div className="vr-code-label">Your Activation Code</div>
                <div className="vr-code-value">{statusResult.activationCode}</div>
                <button type="button" className="vr-copy-btn" onClick={copyActivationCode}>
                  {copied ? "✓ Copied" : "Copy Activation Code"}
                </button>
              </div>
              <div style={{ marginTop: 10, fontSize: 12.5 }}>Go back to the login page and enter it when you activate your account.</div>
            </div>
          ) : statusResult.status === "rejected" ? (
            <div className="vr-status rejected">
              Application not approved.
              {statusResult.note ? <div style={{ marginTop: 6 }}>Reason: {statusResult.note}</div> : null}
            </div>
          ) : (
            <div className="vr-status pending">Reviewing...</div>
          )
        ) : null}
      </section>

      <a className="vr-back" href="/">← Back to Login</a>
      <div className="vr-footer">FLOAT · ACCESS STATUS</div>
    </main>
  );
}
