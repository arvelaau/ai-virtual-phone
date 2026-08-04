"use client";

import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Loader2, LogIn } from "lucide-react";

import { AccountProvider } from "@/lib/account-context";
import { ACCOUNT_NETWORK_ERROR, fetchCurrentAccount, loginAccount, logoutAccount, type AccountProfile } from "@/lib/account-client";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";
import { VERIFY_APPLICATIONS_CLOSED_MESSAGE, VERIFY_APPLICATIONS_OPEN } from "@/lib/verification-availability";

type AccountGateProps = {
  children: ReactNode;
};

type GateStatus = "checking" | "ready" | "signed-out" | "unreachable";

const SELF_HOSTED_ACCOUNT: AccountProfile = {
  id: "local_user",
  username: "local_user",
  displayName: "Local User",
  status: "active",
};

// Inline fallback: on a weak/offline network the SW may fall back to stale HTML, and the linked
// CSS may fail to load (old hash 404s). In that case the whole page is unstyled and "Verifying
// account" would render bare in the top-left corner. Inline styles don't depend on external CSS, so centering is guaranteed.
const gateRootFallbackStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const gatePanelFallbackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  textAlign: "center",
};

export function AccountGate({ children }: AccountGateProps) {
  const selfHostedMode = isSelfHostedModeEnabled();
  const [status, setStatus] = useState<GateStatus>(selfHostedMode ? "ready" : "checking");
  const [account, setAccount] = useState<AccountProfile | null>(selfHostedMode ? SELF_HOSTED_ACCOUNT : null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refreshAccount() {
    if (selfHostedMode) {
      setAccount(SELF_HOSTED_ACCOUNT);
      setStatus("ready");
      setError("");
      return;
    }

    let result: Awaited<ReturnType<typeof fetchCurrentAccount>>;
    try {
      result = await fetchCurrentAccount();
    } catch {
      result = { ok: false, account: null, error: ACCOUNT_NETWORK_ERROR };
    }
    if (result.ok && result.account) {
      setAccount(result.account);
      setStatus("ready");
      setError("");
      return;
    }
    // Network-layer failure (timeout/disconnect/network switch): the session cookie is still there,
    // so we shouldn't log out -- give the user a retry entry point
    if (result.error === ACCOUNT_NETWORK_ERROR) {
      setStatus("unreachable");
      return;
    }
    setAccount(null);
    setStatus("signed-out");
    if (result.error && !/账号状态读取失败/.test(result.error)) setError(result.error);
  }

  useEffect(() => {
    if (selfHostedMode) {
      setAccount(SELF_HOSTED_ACCOUNT);
      setStatus("ready");
      setError("");
      return;
    }

    void refreshAccount();
    // Automatically retry verification when the network recovers (including after a WiFi<->cellular switch)
    const onOnline = () => {
      setStatus(current => {
        if (current === "checking" || current === "unreachable") {
          void refreshAccount();
        }
        return current;
      });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfHostedMode]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await loginAccount({
        username,
        password,
        activationCode: activationCode.trim() || undefined,
      });
      if (!result.ok || !result.account) {
        setError(result.error || "Login failed.");
        return;
      }
      setAccount(result.account);
      setStatus("ready");
      setPassword("");
      setActivationCode("");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (selfHostedMode) {
      setAccount(SELF_HOSTED_ACCOUNT);
      setStatus("ready");
      return;
    }

    await logoutAccount();
    setAccount(null);
    setStatus("signed-out");
  }

  const serviceError = error && /账号表尚未创建|Supabase 环境变量/.test(error);

  if (status === "unreachable") {
    return (
      <main className="app-root account-gate-root" style={gateRootFallbackStyle}>
        <section className="account-gate-card account-gate-loading" style={gatePanelFallbackStyle}>
          <span>Poor network connection, account verification failed</span>
          <button
            type="button"
            className="account-gate-retry-btn"
            onClick={() => { setStatus("checking"); void refreshAccount(); }}
          >
            Retry
          </button>
        </section>
      </main>
    );
  }

  if (status === "checking") {
    return (
      <main className="app-root account-gate-root" style={gateRootFallbackStyle}>
        <section className="account-gate-panel" aria-live="polite" style={gatePanelFallbackStyle}>
          <Loader2 className="account-gate-spinner" size={24} />
          <span>Verifying account...</span>
        </section>
      </main>
    );
  }

  if (status === "ready" && account) {
    return (
      <AccountProvider account={account} refreshAccount={refreshAccount} logout={handleLogout}>
        {children}
      </AccountProvider>
    );
  }

  return (
    <main className="app-root account-gate-root" style={gateRootFallbackStyle}>
      <section className="account-gate-card" aria-label="Account Login">
        <div className="account-gate-copy">
          <span>AI PHONE ACCESS</span>
          {serviceError ? <p>Account service is not ready yet</p> : null}
        </div>

        <form className="account-gate-form" onSubmit={handleSubmit}>
          <label>
            <span>Account</span>
            <input
              value={username}
              onChange={event => setUsername(event.target.value)}
              autoComplete="username"
              inputMode="text"
              placeholder="e.g. user001"
            />
          </label>
          <label>
            <span>Password</span>
            <input
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete="current-password"
              type="password"
              placeholder="At least 6 characters"
            />
          </label>
          <label>
            <span>Activation Code</span>
            <input
              value={activationCode}
              onChange={event => setActivationCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="text"
              placeholder="Fill in the first time you use this account"
            />
            {VERIFY_APPLICATIONS_OPEN ? (
              <a className="account-gate-verify-link" href="/verify" target="_blank" rel="noreferrer">
                No activation code? Apply for beta access &rarr;
              </a>
            ) : (
              <span className="account-gate-verify-link" aria-disabled="true">
                {VERIFY_APPLICATIONS_CLOSED_MESSAGE}
              </span>
            )}
          </label>
          {error ? <div className="account-gate-error" role="alert">{error}</div> : null}
          <button type="submit" disabled={busy}>
            {busy ? <Loader2 size={18} className="account-gate-spinner" /> : <LogIn size={18} />}
            <span>{busy ? "Processing" : "Log In / Activate"}</span>
          </button>
        </form>
      </section>
    </main>
  );
}
