"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, CreditCard, Plus, Trash2, WalletCards, Wifi } from "lucide-react";

import { ConfirmDialog } from "@/components/ui";
import { PageShell } from "@/components/ui/page-shell";
import {
  adjustWalletCardAccount,
  createWalletCard,
  deleteWalletCard,
  formatWalletAmount,
  getWalletBalance,
  loadWalletState,
  transferCardToWalletBalance,
  transferWalletBalanceToCard,
  WALLET_UPDATED_EVENT,
} from "@/lib/wallet-storage";
import type { WalletCard, WalletCardStyle, WalletState } from "@/lib/wallet-types";

type WalletPanelProps = {
  onBack: () => void;
};

const WALLET_STYLE_OPTIONS: Array<{ id: WalletCardStyle; label: string }> = [
  { id: "obsidian", label: "Obsidian" },
  { id: "graphite", label: "Graphite" },
  { id: "silver", label: "Silver" },
];

function formatWalletTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getDisplayCardNumber(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "**** **** **** 0000";
  const tail = normalized.replace(/\D/g, "").slice(-4);
  if (!tail) return normalized;
  return `**** **** **** ${tail}`;
}

function WalletBankCard({
  card,
  active,
}: {
  card: WalletCard;
  active: boolean;
}) {
  return (
    <div
      data-account-id={card.id}
      className={`cp-premium-bank-card cp-premium-bank-card--${card.cardStyle} ${active ? "is-active" : ""}`}
      aria-current={active ? "true" : undefined}
    >
      <div className="cp-card-texture"></div>
      <div className="cp-card-dots"></div>
      <div className="cp-card-overlay-shine"></div>

      <div className="cp-card-top-row">
        <div className="cp-card-bank-header">
          <div className="cp-card-logo-mark">
            <WalletCards size={20} strokeWidth={1.5} />
          </div>
          <div className="cp-card-bank-text">
            <span className="cp-card-bank-name">{card.bankLabel}</span>
            <span className="cp-card-bank-sub">REAL BALANCE</span>
          </div>
        </div>
        <div className="cp-card-top-right">
          <span className="cp-card-custom-label">{card.accentLabel}</span>
        </div>
      </div>

      <div className="cp-card-mid-row">
        <div className="cp-card-chip">
          <div className="cp-chip-line cp-chip-line-1"></div>
          <div className="cp-chip-line cp-chip-line-2"></div>
          <div className="cp-chip-line cp-chip-line-3"></div>
          <div className="cp-chip-line cp-chip-line-4"></div>
          <div className="cp-chip-line-center"></div>
        </div>
        <Wifi size={22} className="cp-card-nfc" />
      </div>

      <div className="cp-card-number">{getDisplayCardNumber(card.maskedNumber)}</div>

      <div className="cp-card-bottom-row">
        <div className="cp-card-holder-group">
          <div className="cp-card-holder">
            <span>CARD NAME</span>
            <strong>{card.title}</strong>
          </div>
          <div className="cp-card-expiry">
            <span>BALANCE</span>
            <strong>{formatWalletAmount(card.balance)}</strong>
          </div>
        </div>
        <div className="cp-card-brand-box">
          <div className="cp-card-brand-label">BANK</div>
          <strong>PAY</strong>
        </div>
      </div>
    </div>
  );
}

export function WalletPanel({ onBack }: WalletPanelProps) {
  const [wallet, setWallet] = useState<WalletState>(() => loadWalletState());
  const [activeCardId, setActiveCardId] = useState(() => wallet.defaultCardId || wallet.cards[0]?.id || "");
  const [balanceTransferMode, setBalanceTransferMode] = useState<"deposit" | "withdraw" | null>(null);
  const [transferScope, setTransferScope] = useState<"balance" | "card">("balance");
  const [transferCardId, setTransferCardId] = useState(() => wallet.defaultCardId || wallet.cards[0]?.id || "");
  const [transferLockedCardId, setTransferLockedCardId] = useState<string | null>(null);
  const [transferAmount, setTransferAmount] = useState("100");
  const [addOpen, setAddOpen] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState("Savings Card");
  const [newCardTail, setNewCardTail] = useState("");
  const [newCardBalance, setNewCardBalance] = useState("0");
  const [newCardStyle, setNewCardStyle] = useState<WalletCardStyle>("graphite");
  const [deleteCardId, setDeleteCardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cardStackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const syncWallet = () => {
      const next = loadWalletState();
      setWallet(next);
      setActiveCardId(current => next.cards.some(card => card.id === current)
        ? current
        : next.defaultCardId || next.cards[0]?.id || "");
      setTransferCardId(current => next.cards.some(card => card.id === current)
        ? current
        : next.defaultCardId || next.cards[0]?.id || "");
      setTransferLockedCardId(current => current && next.cards.some(card => card.id === current) ? current : null);
    };
    window.addEventListener(WALLET_UPDATED_EVENT, syncWallet);
    return () => window.removeEventListener(WALLET_UPDATED_EVENT, syncWallet);
  }, []);

  const activeCard = useMemo(
    () => wallet.cards.find(card => card.id === activeCardId) ?? wallet.cards[0],
    [activeCardId, wallet.cards],
  );
  const selectedTransferCard = useMemo(
    () => wallet.cards.find(card => card.id === transferCardId) ?? wallet.cards[0],
    [transferCardId, wallet.cards],
  );
  const walletBalance = useMemo(() => getWalletBalance(wallet), [wallet]);
  const recentTransactions = useMemo(
    () => wallet.transactions.slice(0, 60),
    [wallet.transactions],
  );

  useEffect(() => {
    const container = cardStackRef.current;
    if (!container) return;

    let ticking = false;
    const syncActiveCardFromScroll = () => {
      ticking = false;
      const cards = Array.from(container.querySelectorAll<HTMLElement>(".cp-premium-bank-card"));
      if (cards.length === 0) return;

      const containerCenter = container.scrollLeft + container.clientWidth / 2;
      let nearestId = "";
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (const card of cards) {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        const distance = Math.abs(cardCenter - containerCenter);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestId = card.dataset.accountId ?? "";
        }
      }

      if (nearestId) {
        setActiveCardId(current => current === nearestId ? current : nearestId);
      }
    };

    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(syncActiveCardFromScroll);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    syncActiveCardFromScroll();
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [wallet.cards.length]);

  function refresh(next: WalletState) {
    setWallet(next);
    setActiveCardId(current => next.cards.some(card => card.id === current)
      ? current
      : next.defaultCardId || next.cards[0]?.id || "");
    setTransferCardId(current => next.cards.some(card => card.id === current)
      ? current
      : next.defaultCardId || next.cards[0]?.id || "");
    setTransferLockedCardId(current => current && next.cards.some(card => card.id === current) ? current : null);
  }

  function openBalanceTransfer(mode: "deposit" | "withdraw", options?: { scope?: "balance" | "card" }) {
    const nextCardId = activeCard?.id || wallet.defaultCardId || wallet.cards[0]?.id || "";
    setTransferCardId(nextCardId);
    setTransferScope(options?.scope ?? "balance");
    setTransferLockedCardId(options?.scope === "card" ? nextCardId : null);
    setTransferAmount("100");
    setError(null);
    setBalanceTransferMode(mode);
  }

  function closeBalanceTransfer() {
    setBalanceTransferMode(null);
    setTransferScope("balance");
    setTransferLockedCardId(null);
  }

  function handleBalanceTransfer() {
    if (!selectedTransferCard || !balanceTransferMode) return;
    const result = transferScope === "card"
      ? adjustWalletCardAccount(selectedTransferCard.id, Number(transferAmount), balanceTransferMode === "deposit" ? "in" : "out")
      : balanceTransferMode === "deposit"
        ? transferCardToWalletBalance(selectedTransferCard.id, Number(transferAmount))
        : transferWalletBalanceToCard(selectedTransferCard.id, Number(transferAmount));
    if (!result.ok) {
      setError(result.error ?? (
        transferScope === "card"
          ? balanceTransferMode === "deposit" ? "Failed to transfer into account." : "Failed to transfer out of account."
          : balanceTransferMode === "deposit" ? "Deposit failed." : "Withdrawal failed."
      ));
      return;
    }
    setError(null);
    refresh(result.state);
    closeBalanceTransfer();
  }

  function handleAddCard() {
    const tail = newCardTail.replace(/\D/g, "").slice(-4);
    const next = createWalletCard({
      title: newCardTitle,
      maskedNumber: tail ? `**** **** **** ${tail}` : undefined,
      balance: Number(newCardBalance),
      cardStyle: newCardStyle,
      bankLabel: "CHAT WALLET",
      accentLabel: "SAVINGS",
      note: "用户手动添加的银行卡",
    });
    setError(null);
    setWallet(next);
    setActiveCardId(next.cards[0]?.id ?? next.defaultCardId);
    setTransferCardId(next.cards[0]?.id ?? next.defaultCardId);
    setAddOpen(false);
    setNewCardTitle("Savings Card");
    setNewCardTail("");
    setNewCardBalance("0");
    setNewCardStyle("graphite");
  }

  function handleDeleteCard() {
    if (!deleteCardId) return;
    const result = deleteWalletCard(deleteCardId);
    if (!result.ok) {
      setError(result.error ?? "Delete failed.");
      setDeleteCardId(null);
      return;
    }
    setError(null);
    refresh(result.state);
    setDeleteCardId(null);
  }

  const transferCardLocked = transferScope === "card" || Boolean(transferLockedCardId);
  const transferTitle = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? "Transfer Out" : "Transfer In"
    : balanceTransferMode === "withdraw" ? "Withdraw to Bank Card" : "Deposit from Bank Card";
  const transferInputLabel = transferScope === "card"
    ? "Amount"
    : balanceTransferMode === "withdraw" ? "Withdrawal Amount" : "Deposit Amount";
  const transferConfirmLabel = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? "Confirm Transfer Out" : "Confirm Transfer In"
    : balanceTransferMode === "withdraw" ? "Confirm Withdrawal" : "Confirm Deposit";
  const transferLimit = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? selectedTransferCard?.balance : undefined
    : balanceTransferMode === "withdraw" ? walletBalance : selectedTransferCard?.balance;

  return (
    <PageShell title="Balance Management" onBack={onBack} className="wallet-page-root">
      <style>{`
        .wallet-page-root {
          background: var(--c-page-body-bg) !important;
        }
        .wallet-page-root .page-body {
          overflow-y: auto;
        }
        .wallet-card-stack {
          padding-inline: 7%;
          scroll-padding-inline: 7%;
        }
        .wallet-card-stack .cp-premium-bank-card {
          flex: 0 0 86%;
          min-width: 0;
          cursor: grab;
          box-shadow: 0 16px 34px rgba(0, 0, 0, 0.26), inset 0 1px 1px rgba(255, 255, 255, 0.1);
        }
        .wallet-card-stack .cp-premium-bank-card:active {
          cursor: grabbing;
        }
        .wallet-card-stack .cp-premium-bank-card.is-active {
          opacity: 1;
        }
        .wallet-balance-action {
          min-height: 34px;
          padding: 0 12px;
          border-radius: 999px;
          background: rgba(255,255,255,0.72);
          border: 1px solid rgba(255,255,255,0.82);
          color: #246bfd;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: calc(12px*var(--app-text-scale,1));
          font-weight: 700;
        }
        .wallet-bank-action {
          min-height: 42px;
          border-radius: 16px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-size: calc(12px*var(--app-text-scale,1));
          font-weight: 700;
        }
      `}</style>

      <div className="p-4 flex flex-col gap-4 pb-24">
        <section className="rounded-2xl p-5 overflow-hidden relative min-h-[156px] flex flex-col justify-between" style={{ background: "#eaf5ff", boxShadow: "0 8px 24px rgba(0,0,0,0.025)", border: "1px solid rgba(255,255,255,0.72)", color: "#172033" }}>
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <div className="ts-11 font-semibold opacity-70 tracking-[0.18em] uppercase">Real Balance</div>
              <div className="ts-34 font-semibold mt-2" style={{ fontFamily: "Georgia, serif" }}>{formatWalletAmount(walletBalance)}</div>
              <div className="ts-12 opacity-70 mt-1">Red envelopes, transfers, and balance payments use this by default</div>
            </div>
            <span className="ts-11 font-semibold opacity-70 tracking-[0.18em] shrink-0">{wallet.cards.length} bank cards</span>
          </div>
          <div className="relative flex items-end justify-between gap-3">
            <span className="ts-12 opacity-70">{wallet.transactions.length} transactions</span>
            <div className="flex items-center gap-2">
              <button type="button" className="wallet-balance-action" onClick={() => openBalanceTransfer("deposit")}>
                <ArrowDownToLine size={14} />
                Deposit
              </button>
              <button type="button" className="wallet-balance-action" onClick={() => openBalanceTransfer("withdraw")}>
                <ArrowUpFromLine size={14} />
                Withdraw
              </button>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="ts-15 font-bold text-[var(--c-text-title)]">Bank Cards</h2>
            <button type="button" onClick={() => setAddOpen(true)} className="min-h-[36px] px-3 rounded-full flex items-center gap-1.5 ts-12 font-semibold" style={{ background: "var(--c-icon-active)", color: "#fff" }}>
              <Plus size={15} />
              Add Card
            </button>
          </div>

          <div className="cp-premium-card-stack wallet-card-stack" aria-label="Bank Cards" ref={cardStackRef}>
            {wallet.cards.map(card => (
              <WalletBankCard
                key={card.id}
                card={card}
                active={activeCard?.id === card.id}
              />
            ))}
          </div>
        </section>

        {activeCard ? (
          <section className="rounded-2xl bg-[var(--c-card)] p-4 flex flex-col gap-4" style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.025)" }}>
            <div className="min-w-0">
              <div className="ts-11 text-[var(--c-text)] opacity-60">Current Card Balance</div>
              <div className="ts-26 font-bold text-[var(--c-text-title)] mt-1">{formatWalletAmount(activeCard.balance)}</div>
              <div className="ts-12 text-[var(--c-text)] opacity-65 mt-1">{activeCard.title} · {getDisplayCardNumber(activeCard.maskedNumber)}</div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => openBalanceTransfer("deposit", { scope: "card" })}
                className="wallet-bank-action text-[var(--c-success)]"
                style={{ background: "color-mix(in srgb, var(--c-success) 10%, var(--c-card))" }}
              >
                <ArrowDownToLine size={15} />
                Transfer In
              </button>
              <button
                type="button"
                onClick={() => openBalanceTransfer("withdraw", { scope: "card" })}
                className="wallet-bank-action text-[var(--c-icon-active)]"
                style={{ background: "color-mix(in srgb, var(--c-icon-active) 10%, var(--c-card))" }}
              >
                <ArrowUpFromLine size={15} />
                Transfer Out
              </button>
              <button
                type="button"
                onClick={() => setDeleteCardId(activeCard.id)}
                className="wallet-bank-action text-[var(--c-danger)]"
                style={{ background: "color-mix(in srgb, var(--c-danger) 10%, var(--c-card))" }}
              >
                <Trash2 size={15} />
                Delete
              </button>
            </div>

            {error ? <div className="ts-12 text-[var(--c-danger)]">{error}</div> : null}
          </section>
        ) : null}

        <section className="rounded-2xl bg-[var(--c-card)] px-4 py-2 flex flex-col" style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.025)" }}>
          <div className="py-3 flex items-center justify-between">
            <h2 className="ts-15 font-bold text-[var(--c-text-title)]">Transactions</h2>
            <span className="ts-11 text-[var(--c-text)] opacity-55">Balance, bank cards, and purchases sync in real time</span>
          </div>
          {recentTransactions.length === 0 ? (
            <div className="py-8 text-center ts-12 text-[var(--c-text)] opacity-60">No transactions yet</div>
          ) : (
            recentTransactions.map(transaction => {
              const outgoing = transaction.amount < 0;
              const TransactionIcon = transaction.kind === "payment"
                ? CreditCard
                : transaction.kind === "transfer_out"
                  ? ArrowUpFromLine
                  : ArrowDownToLine;
              return (
                <div key={transaction.id} className="py-3 flex items-center gap-3 border-t border-[color-mix(in_srgb,var(--c-card-border)_22%,transparent)]">
                  <div className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0" style={{ background: outgoing ? "color-mix(in srgb, var(--c-danger) 12%, var(--c-card))" : "color-mix(in srgb, var(--c-success) 12%, var(--c-card))", color: outgoing ? "var(--c-danger)" : "var(--c-success)" }}>
                    <TransactionIcon size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="ts-13 font-semibold text-[var(--c-text-title)] truncate">{transaction.title}</div>
                    <div className="ts-11 text-[var(--c-text)] opacity-60 truncate">{formatWalletTimeLabel(transaction.createdAt)} · {transaction.detail}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`ts-13 font-bold ${outgoing ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}`}>
                      {outgoing ? "-" : "+"}{formatWalletAmount(Math.abs(transaction.amount))}
                    </div>
                    <div className="ts-10 text-[var(--c-text)] opacity-50">Bal. {formatWalletAmount(transaction.balanceAfter)}</div>
                  </div>
                </div>
              );
            })
          )}
        </section>
      </div>

      {balanceTransferMode && selectedTransferCard ? (
        <div className="absolute inset-0 z-[80] flex items-end" style={{ background: "rgba(0,0,0,0.35)" }} role="presentation" onClick={closeBalanceTransfer}>
          <div className="w-full rounded-t-[24px] bg-[var(--c-page-body-bg)] p-4 flex flex-col gap-4" style={{ paddingBottom: "calc(18px + env(safe-area-inset-bottom, 0px))" }} role="dialog" aria-modal="true" aria-label={transferTitle} onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <strong className="ts-16 text-[var(--c-text-title)]">{transferTitle}</strong>
              <span className="ts-12 text-[var(--c-text)] opacity-60">
                {transferScope === "card" ? `Current Card ${formatWalletAmount(selectedTransferCard.balance)}` : `Balance ${formatWalletAmount(walletBalance)}`}
              </span>
            </div>
            {transferCardLocked ? (
              <div className="min-h-[58px] rounded-2xl px-3 flex items-center gap-3 text-left border border-[var(--c-card-border)] bg-[var(--c-card)]">
                <WalletCards size={18} className="text-[var(--c-icon)]" />
                <span className="flex-1 min-w-0">
                  <span className="block ts-12 text-[var(--c-text)] opacity-60">Current Card</span>
                  <span className="block ts-13 font-semibold text-[var(--c-text-title)] truncate">{selectedTransferCard.title}</span>
                  <span className="block ts-11 text-[var(--c-text)] opacity-60 truncate">{getDisplayCardNumber(selectedTransferCard.maskedNumber)} · {formatWalletAmount(selectedTransferCard.balance)}</span>
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="ts-12 font-semibold text-[var(--c-text-title)]">Select Bank Card</span>
                <div className="grid gap-2 max-h-[28vh] overflow-y-auto">
                  {wallet.cards.map(card => {
                    const active = selectedTransferCard.id === card.id;
                    return (
                      <button
                        key={card.id}
                        type="button"
                        onClick={() => setTransferCardId(card.id)}
                        className="min-h-[54px] rounded-2xl px-3 flex items-center gap-3 text-left"
                        style={{ border: active ? "1px solid var(--c-icon-active)" : "1px solid var(--c-card-border)", background: active ? "color-mix(in srgb, var(--c-icon-active) 8%, var(--c-card))" : "var(--c-card)" }}
                      >
                        <WalletCards size={18} className="text-[var(--c-icon)]" />
                        <span className="flex-1 min-w-0">
                          <span className="block ts-13 font-semibold text-[var(--c-text-title)] truncate">{card.title}</span>
                          <span className="block ts-11 text-[var(--c-text)] opacity-60 truncate">{getDisplayCardNumber(card.maskedNumber)} · {formatWalletAmount(card.balance)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label className="flex flex-col gap-2">
              <span className="ts-12 font-semibold text-[var(--c-text-title)]">{transferInputLabel}</span>
              <input className="ui-input" type="number" min={0.01} max={transferLimit} step={0.01} value={transferAmount} onChange={event => setTransferAmount(event.target.value)} />
            </label>
            {error ? <div className="ts-12 text-[var(--c-danger)]">{error}</div> : null}
            <button type="button" onClick={handleBalanceTransfer} className="h-12 rounded-2xl text-white ts-14 font-bold" style={{ background: "var(--c-icon-active)" }}>{transferConfirmLabel}</button>
          </div>
        </div>
      ) : null}

      {addOpen ? (
        <div className="absolute inset-0 z-[80] flex items-end" style={{ background: "rgba(0,0,0,0.35)" }} role="presentation" onClick={() => setAddOpen(false)}>
          <div className="w-full rounded-t-[24px] bg-[var(--c-page-body-bg)] p-4 flex flex-col gap-4" style={{ paddingBottom: "calc(18px + env(safe-area-inset-bottom, 0px))" }} role="dialog" aria-modal="true" aria-label="Add Bank Card" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <strong className="ts-16 text-[var(--c-text-title)]">Add Bank Card</strong>
              <span className="ts-12 text-[var(--c-text)] opacity-60">Balance cannot be negative</span>
            </div>
            <label className="flex flex-col gap-2">
              <span className="ts-12 font-semibold text-[var(--c-text-title)]">Card Name</span>
              <input className="ui-input" value={newCardTitle} onChange={event => setNewCardTitle(event.target.value)} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-2 min-w-0">
                <span className="ts-12 font-semibold text-[var(--c-text-title)]">Last 4 Digits</span>
                <input className="ui-input" inputMode="numeric" maxLength={4} value={newCardTail} onChange={event => setNewCardTail(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="0000" />
              </label>
              <label className="flex flex-col gap-2 min-w-0">
                <span className="ts-12 font-semibold text-[var(--c-text-title)]">Initial Balance</span>
                <input className="ui-input" type="number" min={0} step={0.01} value={newCardBalance} onChange={event => setNewCardBalance(event.target.value)} />
              </label>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {WALLET_STYLE_OPTIONS.map(option => (
                <button key={option.id} type="button" onClick={() => setNewCardStyle(option.id)} className="h-10 rounded-2xl ts-12 font-semibold" style={{ border: newCardStyle === option.id ? "none" : "1px solid var(--c-card-border)", background: newCardStyle === option.id ? "var(--c-icon-active)" : "var(--c-card)", color: newCardStyle === option.id ? "#fff" : "var(--c-text-title)" }}>
                  {option.label}
                </button>
              ))}
            </div>
            <button type="button" onClick={handleAddCard} className="h-12 rounded-2xl text-white ts-14 font-bold" style={{ background: "var(--c-icon-active)" }}>Add Bank Card</button>
          </div>
        </div>
      ) : null}

      {deleteCardId ? (
        <ConfirmDialog
          title="Delete this bank card?"
          message="Deleting it will remove this card's balance and transaction history from Balance Management."
          variant="danger"
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={handleDeleteCard}
          onCancel={() => setDeleteCardId(null)}
        />
      ) : null}
    </PageShell>
  );
}
