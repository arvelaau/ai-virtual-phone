"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clapperboard, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { GlassCard, EmptyState, Avatar } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select } from "@/components/ui/form";
import { BottomSheet, ConfirmDialog } from "@/components/ui/modal";
import { StarRating } from "@/components/ui/star-rating";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "@/lib/theme-storage";
import {
  loadReviewTitles,
  upsertReviewTitle,
  deleteReviewTitle,
  loadReviewJournalEntries,
  addReviewJournalEntry,
  deleteReviewJournalEntry,
  getOrCreateReviewDiscussionThread,
  loadReviewDiscussionMessages,
  addReviewDiscussionMessage,
  loadPublishedReviews,
  addPublishedReview,
} from "@/lib/review-storage";
import { makeReviewRating, type ReviewStatus, type ReviewTitle, type ReviewTitleKind } from "@/lib/review-types";
import {
  searchMovies,
  detailMovie,
  fetchMovieReviewSnippet,
  searchBooks,
  detailBook,
  type MediaSearchResult,
} from "@/lib/review-lookup-client";
import { generateReviewDiscussReply, generatePublishedReview, resolveDiscussMode } from "@/lib/review-engine";
import { recordReviewJournalEvent, recordPublishedReviewEvent } from "@/lib/review-memory";

type Screen = "list" | "search" | "detail";

async function urlToBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

function StatusPicker({ status, onChange }: { status: ReviewStatus; onChange: (next: ReviewStatus) => void }) {
  const options: { id: ReviewStatus; label: string }[] = [
    { id: "not_started", label: "Not started" },
    { id: "in_progress", label: "In progress" },
    { id: "finished", label: "Finished" },
  ];
  return (
    <div className="review-status-picker" style={{ display: "flex", gap: 6 }}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className="ui-btn"
          data-active={status === opt.id ? "true" : undefined}
          style={{
            flex: 1,
            background: status === opt.id ? "var(--c-icon-active, #5B8FB9)" : undefined,
            color: status === opt.id ? "#fff" : undefined,
          }}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function TitleCard({ title, coverUrl, onOpen }: { title: ReviewTitle; coverUrl: string | null; onOpen: () => void }) {
  return (
    <button type="button" className="review-title-card" onClick={onOpen} style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 6, border: "none", background: "none", padding: 0, cursor: "pointer" }}>
      <div style={{ width: "100%", aspectRatio: "2/3", borderRadius: 10, overflow: "hidden", background: "var(--c-card, rgba(255,255,255,0.7))" }}>
        {coverUrl ? (
          <img src={coverUrl} alt={title.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Clapperboard size={28} strokeWidth={1.25} />
          </div>
        )}
      </div>
      <div>
        <strong style={{ display: "block", fontSize: 13, lineHeight: 1.3 }}>{title.title}</strong>
        <span style={{ fontSize: 11, opacity: 0.65 }}>
          {title.kind === "movie" ? "Movie" : "Book"}
          {title.year ? ` · ${title.year}` : ""}
        </span>
      </div>
    </button>
  );
}

export function ReviewApp({ onClose }: { onClose: () => void }) {
  const [screen, setScreen] = useState<Screen>("list");
  const [titles, setTitles] = useState<ReviewTitle[]>([]);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [selectedTitleId, setSelectedTitleId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refreshTitles = useCallback(() => {
    setTitles(loadReviewTitles());
  }, []);

  useEffect(() => {
    refreshTitles();
  }, [refreshTitles]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map: Record<string, string> = {};
      for (const title of titles) {
        if (!title.coverAssetId) continue;
        const dataUrl = await getThemeAssetDataUrl(title.coverAssetId);
        if (dataUrl) map[title.id] = dataUrl;
      }
      if (!cancelled) setCoverUrls(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [titles]);

  const selectedTitle = useMemo(() => titles.find((t) => t.id === selectedTitleId) ?? null, [titles, selectedTitleId]);

  const handleAdded = (title: ReviewTitle) => {
    upsertReviewTitle(title);
    refreshTitles();
    setSelectedTitleId(title.id);
    setScreen("detail");
  };

  const handleDelete = async (id: string) => {
    await deleteReviewTitle(id);
    refreshTitles();
    setConfirmDeleteId(null);
    if (selectedTitleId === id) {
      setSelectedTitleId(null);
      setScreen("list");
    }
  };

  const confirmDeleteDialog = confirmDeleteId ? (
    <ConfirmDialog
      title="Delete this title?"
      message="This removes its journal, discussions and published reviews too."
      variant="danger"
      confirmLabel="Delete"
      onConfirm={() => void handleDelete(confirmDeleteId)}
      onCancel={() => setConfirmDeleteId(null)}
    />
  ) : null;

  if (screen === "search") {
    return <ReviewSearchScreen onClose={() => setScreen("list")} onAdded={handleAdded} />;
  }

  if (screen === "detail" && selectedTitle) {
    return (
      <>
        <ReviewTitleDetail
          title={selectedTitle}
          coverUrl={coverUrls[selectedTitle.id] ?? null}
          onBack={() => setScreen("list")}
          onUpdated={refreshTitles}
          onDelete={() => setConfirmDeleteId(selectedTitle.id)}
        />
        {confirmDeleteDialog}
      </>
    );
  }

  return (
    <PageShell
      title="Review"
      onBack={onClose}
      rightAction={
        <Button variant="ghost" aria-label="Add title" onClick={() => setScreen("search")}>
          <Plus size={20} strokeWidth={1.8} />
        </Button>
      }
    >
      {titles.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          message="No titles yet -- add a movie or book to start a journal and discuss it with a character."
          action={
            <Button variant="primary" onClick={() => setScreen("search")}>
              Add a title
            </Button>
          }
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, padding: 12 }}>
          {titles.map((title) => (
            <TitleCard
              key={title.id}
              title={title}
              coverUrl={coverUrls[title.id] ?? null}
              onOpen={() => {
                setSelectedTitleId(title.id);
                setScreen("detail");
              }}
            />
          ))}
        </div>
      )}
      {confirmDeleteDialog}
    </PageShell>
  );
}

function ReviewSearchScreen({ onClose, onAdded }: { onClose: () => void; onAdded: (title: ReviewTitle) => void }) {
  const [kind, setKind] = useState<ReviewTitleKind>("movie");
  const [bookProvider, setBookProvider] = useState<"open_library" | "google_books">("google_books");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingResult, setPendingResult] = useState<MediaSearchResult | null>(null);

  const runSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    const result = kind === "movie" ? await searchMovies(query.trim()) : await searchBooks(query.trim(), bookProvider);
    setLoading(false);
    if (!result.ok) {
      setError(result.error === "missing_tmdb_key" ? "Add your TMDB key in Settings -> Media Lookup to search movies." : result.error);
      setResults([]);
      return;
    }
    setResults(result.data);
  };

  if (pendingResult) {
    return (
      <ReviewGroundingFlow
        pick={pendingResult}
        onBack={() => setPendingResult(null)}
        onDone={onAdded}
      />
    );
  }

  return (
    <PageShell title="Add a Title" onBack={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <Button variant={kind === "movie" ? "primary" : "outline"} onClick={() => { setKind("movie"); setResults([]); }}>
            Movie
          </Button>
          <Button variant={kind === "book" ? "primary" : "outline"} onClick={() => { setKind("book"); setResults([]); }}>
            Book
          </Button>
        </div>
        {kind === "book" && (
          <Select value={bookProvider} onChange={(e) => setBookProvider(e.target.value as "open_library" | "google_books")}>
            <option value="google_books">Google Books</option>
            <option value="open_library">Open Library</option>
          </Select>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={kind === "movie" ? "Search for a movie..." : "Search for a book..."}
            onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
          />
          <Button variant="primary" onClick={() => void runSearch()} disabled={loading}>
            {loading ? "..." : "Search"}
          </Button>
        </div>
        {error && <GlassCard variant="section"><p style={{ fontSize: 13 }}>{error}</p></GlassCard>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {results.map((item) => (
            <GlassCard key={`${item.provider}_${item.externalId}`} onClick={() => setPendingResult(item)}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <div style={{ width: 44, height: 64, borderRadius: 6, overflow: "hidden", flexShrink: 0, background: "var(--c-panel, #fff)" }}>
                  {item.coverUrl && <img src={item.coverUrl} alt={item.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                </div>
                <div>
                  <strong style={{ display: "block", fontSize: 14 }}>{item.title}</strong>
                  <span style={{ fontSize: 12, opacity: 0.65 }}>{item.year ?? ""}</span>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
        <Button variant="outline" onClick={() => setPendingResult({ kind, provider: "tmdb", externalId: "", title: query || "Untitled", creator: "" })}>
          Can&apos;t find it? Add manually
        </Button>
      </div>
    </PageShell>
  );
}

function ReviewGroundingFlow({
  pick,
  onBack,
  onDone,
}: {
  pick: MediaSearchResult;
  onBack: () => void;
  onDone: (title: ReviewTitle) => void;
}) {
  const isManual = !pick.externalId;
  const [loading, setLoading] = useState(!isManual);
  const [manualTitle, setManualTitle] = useState(pick.title);
  const [manualCreator, setManualCreator] = useState(pick.creator);
  const [manualYear, setManualYear] = useState(pick.year ?? "");
  const [overview, setOverview] = useState("");
  const [coverUrl, setCoverUrl] = useState<string | undefined>(pick.coverUrl);
  const [creator, setCreator] = useState(pick.creator);
  const [snippet, setSnippet] = useState<{ sourceLabel: "Review" | "Description"; text: string } | null>(null);
  const [snippetEdited, setSnippetEdited] = useState("");
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    if (isManual) return;
    let cancelled = false;
    (async () => {
      if (pick.kind === "movie") {
        const detail = await detailMovie(pick.externalId);
        if (!cancelled && detail.ok) {
          setOverview(detail.data.overview);
          setCoverUrl(detail.data.coverUrl);
          setCreator(detail.data.creator);
        }
        const review = await fetchMovieReviewSnippet(pick.externalId);
        if (!cancelled && review.ok && review.data) {
          setSnippet({ sourceLabel: "Review", text: review.data.text });
          setSnippetEdited(review.data.text);
        }
      } else {
        const detail = await detailBook(pick.externalId, pick.provider as "open_library" | "google_books");
        if (!cancelled && detail.ok) {
          setOverview(detail.data.detail.overview);
          setCoverUrl(detail.data.detail.coverUrl);
          setCreator(detail.data.detail.creator);
          if (detail.data.grounding) {
            setSnippet({ sourceLabel: "Description", text: detail.data.grounding.text });
            setSnippetEdited(detail.data.grounding.text);
          }
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isManual, pick]);

  const finish = async () => {
    let coverAssetId: string | null = null;
    if (coverUrl) {
      const blob = await urlToBlob(coverUrl);
      if (blob) coverAssetId = await saveThemeAssetFromBlob(blob, "review_cover");
    }
    const now = new Date().toISOString();
    const title: ReviewTitle = {
      id: `review_title_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: pick.kind,
      title: isManual ? manualTitle.trim() || "Untitled" : pick.title,
      year: isManual ? manualYear || undefined : pick.year,
      creator: isManual ? manualCreator : creator,
      overview,
      coverAssetId,
      source: isManual
        ? { kind: pick.kind, provider: "manual" }
        : pick.kind === "movie"
          ? { kind: "movie", provider: "tmdb", externalId: pick.externalId }
          : { kind: "book", provider: pick.provider as "open_library" | "google_books", externalId: pick.externalId },
      status: "not_started",
      grounding: snippet && !cleared
        ? {
            sourceLabel: snippet.sourceLabel,
            status: snippetEdited === snippet.text ? "confirmed" : "edited",
            text: snippetEdited,
            originalText: snippet.text,
            fetchedAt: now,
          }
        : null,
      myRating: null,
      createdAt: now,
      updatedAt: now,
    };
    onDone(title);
  };

  if (isManual) {
    return (
      <PageShell title="Add Manually" onBack={onBack}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
          <label className="menu-desc">Title</label>
          <Input value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} />
          <label className="menu-desc">{pick.kind === "movie" ? "Director" : "Author"}</label>
          <Input value={manualCreator} onChange={(e) => setManualCreator(e.target.value)} />
          <label className="menu-desc">Year</label>
          <Input value={manualYear} onChange={(e) => setManualYear(e.target.value)} />
          <label className="menu-desc">Overview (optional)</label>
          <Textarea value={overview} onChange={(e) => setOverview(e.target.value)} rows={4} />
          <Button variant="primary" onClick={() => void finish()}>Add</Button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title={pick.title} onBack={onBack}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
        {loading ? (
          <p style={{ fontSize: 13, opacity: 0.65 }}>Loading details...</p>
        ) : (
          <>
            <p style={{ fontSize: 13 }}>{overview}</p>
            {snippet && !cleared && (
              <GlassCard variant="section">
                <strong style={{ fontSize: 12, opacity: 0.7 }}>{snippet.sourceLabel} (cached, edit or clear if it looks wrong)</strong>
                <Textarea value={snippetEdited} onChange={(e) => setSnippetEdited(e.target.value)} rows={5} style={{ marginTop: 6 }} />
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <Button variant="ghost" onClick={() => setSnippetEdited(snippet.text)}>Revert to fetched</Button>
                  <Button variant="ghost" onClick={() => setCleared(true)}>Clear</Button>
                </div>
              </GlassCard>
            )}
            {(!snippet || cleared) && (
              <p style={{ fontSize: 12, opacity: 0.6 }}>
                {pick.kind === "movie" ? "No cached review found for this title." : "No description available for this title."}
              </p>
            )}
            <Button variant="primary" onClick={() => void finish()}>Add to my titles</Button>
          </>
        )}
      </div>
    </PageShell>
  );
}

function ReviewTitleDetail({
  title,
  coverUrl,
  onBack,
  onUpdated,
  onDelete,
}: {
  title: ReviewTitle;
  coverUrl: string | null;
  onBack: () => void;
  onUpdated: () => void;
  onDelete: () => void;
}) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [journal, setJournal] = useState(() => loadReviewJournalEntries(title.id));
  const [journalDraft, setJournalDraft] = useState("");
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState(() => loadReviewDiscussionMessages());
  const [discussDraft, setDiscussDraft] = useState("");
  const [discussBusy, setDiscussBusy] = useState(false);
  const [reviews, setReviews] = useState(() => loadPublishedReviews(title.id));
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    const chars = loadCharacters();
    setCharacters(chars);
    if (!selectedCharacterId && chars[0]) setSelectedCharacterId(chars[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedCharacterId) return;
    const thread = getOrCreateReviewDiscussionThread(title.id, selectedCharacterId);
    setThreadId(thread.id);
    setMessages(loadReviewDiscussionMessages(thread.id));
  }, [selectedCharacterId, title.id]);

  const updateTitle = (patch: Partial<ReviewTitle>) => {
    upsertReviewTitle({ ...title, ...patch });
    onUpdated();
  };

  const addJournalEntry = () => {
    if (!journalDraft.trim()) return;
    const entry = addReviewJournalEntry({ titleId: title.id, authorType: "user", authorName: "User", body: journalDraft.trim() });
    if (selectedCharacterId) recordReviewJournalEvent(title, entry, selectedCharacterId);
    setJournal(loadReviewJournalEntries(title.id));
    setJournalDraft("");
  };

  const removeJournalEntry = (id: string) => {
    deleteReviewJournalEntry(id);
    setJournal(loadReviewJournalEntries(title.id));
  };

  const sendDiscussMessage = async () => {
    if (!discussDraft.trim() || !threadId || !selectedCharacterId) return;
    const mode = resolveDiscussMode(title);
    const userMsg = addReviewDiscussionMessage({ threadId, authorType: "user", content: discussDraft.trim(), modeAtSend: mode });
    setMessages(loadReviewDiscussionMessages(threadId));
    setDiscussDraft("");
    setDiscussBusy(true);
    try {
      const priorMessages = loadReviewDiscussionMessages(threadId);
      const result = await generateReviewDiscussReply(title, selectedCharacterId, journal, priorMessages);
      addReviewDiscussionMessage({ threadId, authorType: "character", content: result.content, modeAtSend: result.mode });
      setMessages(loadReviewDiscussionMessages(threadId));
    } catch (err) {
      console.warn("[ReviewApp] discuss generation failed:", err);
    } finally {
      setDiscussBusy(false);
    }
    void userMsg;
  };

  const askForReview = async () => {
    if (!selectedCharacterId) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const priorMessages = threadId ? loadReviewDiscussionMessages(threadId) : [];
      const draft = await generatePublishedReview(title, selectedCharacterId, journal, priorMessages);
      const saved = addPublishedReview(draft);
      recordPublishedReviewEvent(title, saved);
      setReviews(loadPublishedReviews(title.id));
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewBusy(false);
    }
  };

  const selectedCharacter = characters.find((c) => c.id === selectedCharacterId) ?? null;

  return (
    <PageShell
      title={title.title}
      onBack={onBack}
      rightAction={
        <Button variant="ghost" aria-label="Delete title" onClick={onDelete}>
          <Trash2 size={18} strokeWidth={1.8} />
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 12 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ width: 84, height: 124, borderRadius: 10, overflow: "hidden", flexShrink: 0, background: "var(--c-card, rgba(255,255,255,0.7))" }}>
            {coverUrl && <img src={coverUrl} alt={title.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <strong>{title.title}</strong>
            <span style={{ fontSize: 12, opacity: 0.65 }}>{title.creator}{title.year ? ` · ${title.year}` : ""}</span>
            <div style={{ marginTop: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.6 }}>My rating</span>
              <StarRating value={title.myRating?.value ?? 0} onChange={(next) => updateTitle({ myRating: makeReviewRating(next) })} size={16} />
            </div>
          </div>
        </div>

        <StatusPicker status={title.status} onChange={(status) => updateTitle({ status })} />

        {title.grounding && title.grounding.status !== "cleared" && (
          <GlassCard variant="section">
            <strong style={{ fontSize: 12, opacity: 0.7 }}>{title.grounding.sourceLabel}</strong>
            <p style={{ fontSize: 13, marginTop: 4 }}>{title.grounding.text}</p>
          </GlassCard>
        )}

        <GlassCard>
          <strong style={{ fontSize: 13 }}>Journal</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {journal.map((entry) => (
              <div key={entry.id} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <p style={{ fontSize: 13, margin: 0 }}>{entry.body}</p>
                <button type="button" onClick={() => removeJournalEntry(entry.id)} style={{ background: "none", border: "none", opacity: 0.5 }}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <Textarea value={journalDraft} onChange={(e) => setJournalDraft(e.target.value)} placeholder="Write down your thoughts..." rows={2} />
            <Button variant="outline" onClick={addJournalEntry}>Add entry</Button>
          </div>
        </GlassCard>

        <GlassCard>
          <strong style={{ fontSize: 13 }}>Discuss</strong>
          {characters.length === 0 ? (
            <p style={{ fontSize: 12, opacity: 0.6 }}>No characters yet.</p>
          ) : (
            <>
              <Select value={selectedCharacterId} onChange={(e) => setSelectedCharacterId(e.target.value)} style={{ marginTop: 8 }}>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, maxHeight: 260, overflowY: "auto" }}>
                {messages.map((msg, idx) => {
                  const prevMode = idx > 0 ? messages[idx - 1].modeAtSend : msg.modeAtSend;
                  const modeChanged = idx > 0 && prevMode !== msg.modeAtSend;
                  return (
                    <div key={msg.id}>
                      {modeChanged && (
                        <div style={{ fontSize: 10, opacity: 0.5, textAlign: "center", margin: "4px 0" }}>
                          {msg.modeAtSend === "discuss_free" ? "-- now unrestricted (finished) --" : "-- back to spoiler-safe --"}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexDirection: msg.authorType === "user" ? "row-reverse" : "row" }}>
                        {msg.authorType === "character" && <Avatar src={selectedCharacter?.avatar ?? undefined} name={selectedCharacter?.name ?? "?"} size="sm" />}
                        <p style={{ fontSize: 13, background: "var(--c-card, rgba(255,255,255,0.7))", borderRadius: 10, padding: "6px 10px", margin: 0, maxWidth: "78%" }}>
                          {msg.content}
                        </p>
                      </div>
                    </div>
                  );
                })}
                {discussBusy && <p style={{ fontSize: 12, opacity: 0.5 }}>Typing...</p>}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <Input
                  value={discussDraft}
                  onChange={(e) => setDiscussDraft(e.target.value)}
                  placeholder="Say something..."
                  onKeyDown={(e) => { if (e.key === "Enter") void sendDiscussMessage(); }}
                  disabled={discussBusy}
                />
                <Button variant="primary" onClick={() => void sendDiscussMessage()} disabled={discussBusy}>
                  <Send size={16} />
                </Button>
              </div>
            </>
          )}
        </GlassCard>

        <GlassCard>
          <strong style={{ fontSize: 13 }}>Reviews</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
            {reviews.map((review) => (
              <div key={review.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>{review.characterName}</strong>
                  <StarRating value={review.rating.value} readOnly size={14} />
                </div>
                <p style={{ fontSize: 13, fontStyle: "italic", margin: "4px 0" }}>{review.headline}</p>
                {review.body.map((para, i) => (
                  <p key={i} style={{ fontSize: 13, margin: "4px 0" }}>{para}</p>
                ))}
              </div>
            ))}
            {reviewError && <p style={{ fontSize: 12, color: "var(--c-danger)" }}>{reviewError}</p>}
            <Button variant="outline" onClick={() => void askForReview()} disabled={reviewBusy || !selectedCharacterId}>
              {reviewBusy ? (
                <>
                  <RefreshCw size={14} className="animate-spin" /> Writing...
                </>
              ) : (
                `Ask ${selectedCharacter?.name ?? "them"} for their review`
              )}
            </Button>
          </div>
        </GlassCard>
      </div>
    </PageShell>
  );
}
