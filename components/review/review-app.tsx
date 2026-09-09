"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, Film, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/modal";
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

type Screen = "home" | "journal" | "detail";

async function urlToBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

const STATUS_OPTIONS: { id: ReviewStatus; label: string }[] = [
  { id: "not_started", label: "Not started" },
  { id: "in_progress", label: "In progress" },
  { id: "finished", label: "Finished" },
];

function Poster({ url, kind }: { url: string | null; kind?: ReviewTitleKind }) {
  return (
    <div className="review-poster">
      {url ? <img src={url} alt="" /> : <Film size={22} strokeWidth={1.25} />}
      {kind && <span className="review-poster-kind-badge">{kind === "movie" ? "Film" : "Book"}</span>}
    </div>
  );
}

export function ReviewApp({ onClose }: { onClose: () => void }) {
  const [screen, setScreen] = useState<Screen>("home");
  const [titles, setTitles] = useState<ReviewTitle[]>([]);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [selectedTitleId, setSelectedTitleId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [railTab, setRailTab] = useState<"recent" | "all">("recent");

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

  const sortedByRecency = useMemo(
    () => [...titles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [titles],
  );
  const featured = sortedByRecency[0] ?? null;
  const railItems = railTab === "recent" ? sortedByRecency.slice(0, 12) : sortedByRecency;

  const openTitle = (id: string) => {
    setSelectedTitleId(id);
    setScreen("detail");
  };

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
      setScreen("home");
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

  if (screen === "journal") {
    return <ReviewJournalIntake onClose={() => setScreen("home")} onAdded={handleAdded} />;
  }

  if (screen === "detail" && selectedTitle) {
    return (
      <div className="review-app-shell">
        <ReviewTitleDetail
          title={selectedTitle}
          coverUrl={coverUrls[selectedTitle.id] ?? null}
          onBack={() => setScreen("home")}
          onUpdated={refreshTitles}
          onDelete={() => setConfirmDeleteId(selectedTitle.id)}
        />
        {confirmDeleteDialog}
      </div>
    );
  }

  return (
    <div className="review-app-shell">
      <div className="review-app-page">
        <div className="review-topbar">
          <button type="button" className="review-icon-btn" aria-label="Back" onClick={onClose}>
            <ChevronLeft size={20} strokeWidth={1.8} />
          </button>
          <span className="review-topbar-title">Film Archive</span>
          <button type="button" className="review-icon-btn" aria-label="Add title" onClick={() => setScreen("journal")}>
            <Plus size={19} strokeWidth={1.8} />
          </button>
        </div>

        <div className="review-scroll">
          {titles.length === 0 ? (
            <div className="review-empty">
              <p>No titles yet -- add a movie or book to start a journal and discuss it with a character.</p>
              <button type="button" className="review-confirm-btn" style={{ maxWidth: 220, margin: "0 auto" }} onClick={() => setScreen("journal")}>
                Start a Film Journal
              </button>
            </div>
          ) : (
            <>
              <div className="review-home-header">
                <p className="review-home-eyebrow">Recently kept</p>
                <h1 className="review-home-title">MY FILM ARCHIVE</h1>
              </div>

              {featured && (
                <div className="review-hero">
                  <button type="button" className="review-hero-stack" onClick={() => openTitle(featured.id)} style={{ border: "none", background: "none", padding: 0, cursor: "pointer" }}>
                    <span className="review-hero-stack-layer" aria-hidden="true">
                      {coverUrls[featured.id] ? <img src={coverUrls[featured.id]} alt="" /> : <span className="review-hero-stack-placeholder"><Film size={20} /></span>}
                    </span>
                    <span className="review-hero-stack-layer" aria-hidden="true">
                      {coverUrls[featured.id] ? <img src={coverUrls[featured.id]} alt="" /> : <span className="review-hero-stack-placeholder"><Film size={20} /></span>}
                    </span>
                    <span className="review-hero-stack-layer">
                      {coverUrls[featured.id] ? <img src={coverUrls[featured.id]} alt={featured.title} /> : <span className="review-hero-stack-placeholder"><Film size={28} /></span>}
                    </span>
                  </button>
                  <strong className="review-hero-title">{featured.title}</strong>
                  <span className="review-hero-meta">
                    {featured.kind === "movie" ? "Movie" : "Book"}{featured.year ? ` · ${featured.year}` : ""}
                  </span>
                </div>
              )}

              <div className="review-rail-section">
                <div className="review-rail-head">
                  <span className="review-rail-title">All Displayed</span>
                  <div className="review-rail-tabs">
                    <button type="button" className="review-rail-tab" data-active={railTab === "recent" ? "true" : undefined} onClick={() => setRailTab("recent")}>Recent</button>
                    <button type="button" className="review-rail-tab" data-active={railTab === "all" ? "true" : undefined} onClick={() => setRailTab("all")}>All</button>
                  </div>
                </div>
                <div className="review-rail-scroll">
                  {railItems.map((title) => (
                    <button key={title.id} type="button" className="review-rail-card" onClick={() => openTitle(title.id)}>
                      <Poster url={coverUrls[title.id] ?? null} kind={title.kind} />
                      <span className="review-rail-card-title">{title.title}</span>
                      <span className="review-rail-card-meta">{title.year ?? ""}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <button type="button" className="review-fab" aria-label="New Film Journal" onClick={() => setScreen("journal")}>
          <Plus size={24} strokeWidth={2} />
        </button>
      </div>
      {confirmDeleteDialog}
    </div>
  );
}

/* ── "New Film Journal": merged search + manual add flow ── */
function ReviewJournalIntake({ onClose, onAdded }: { onClose: () => void; onAdded: (title: ReviewTitle) => void }) {
  const [mode, setMode] = useState<"search" | "manual">("search");
  const [kind, setKind] = useState<ReviewTitleKind>("movie");
  const [bookProvider, setBookProvider] = useState<"open_library" | "google_books">("google_books");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingResult, setPendingResult] = useState<MediaSearchResult | null>(null);

  // Manual-entry fields
  const [manualTitle, setManualTitle] = useState("");
  const [manualCreator, setManualCreator] = useState("");
  const [manualYear, setManualYear] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [manualFile, setManualFile] = useState<File | null>(null);
  const [manualSaving, setManualSaving] = useState(false);

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

  const finishManual = async () => {
    if (!manualTitle.trim()) return;
    setManualSaving(true);
    try {
      let coverAssetId: string | null = null;
      if (manualFile) coverAssetId = await saveThemeAssetFromBlob(manualFile, "review_cover");
      const now = new Date().toISOString();
      const title: ReviewTitle = {
        id: `review_title_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind,
        title: manualTitle.trim(),
        year: manualYear.trim() || undefined,
        creator: manualCreator.trim(),
        overview: manualNotes.trim(),
        coverAssetId,
        source: { kind, provider: "manual" },
        status: "not_started",
        grounding: null,
        myRating: null,
        createdAt: now,
        updatedAt: now,
      };
      onAdded(title);
    } finally {
      setManualSaving(false);
    }
  };

  if (pendingResult) {
    return <ReviewGroundingFlow pick={pendingResult} onBack={() => setPendingResult(null)} onDone={onAdded} />;
  }

  return (
    <div className="review-app-shell">
      <div className="review-app-page">
        <div className="review-topbar">
          <button type="button" className="review-icon-btn" aria-label="Back" onClick={onClose}>
            <ChevronLeft size={20} strokeWidth={1.8} />
          </button>
          <span className="review-topbar-title">New Film Journal</span>
          <span style={{ width: 38 }} />
        </div>

        <div className="review-scroll">
          <div className="review-journal-hero">
            <p className="review-journal-tagline">Find a film worth keeping.</p>
            <div className="review-mode-toggle">
              <button type="button" className="review-mode-toggle-btn" data-active={mode === "search" ? "true" : undefined} onClick={() => setMode("search")}>
                <span className="review-mode-toggle-dot" />Search
              </button>
              <button type="button" className="review-mode-toggle-btn" data-active={mode === "manual" ? "true" : undefined} onClick={() => setMode("manual")}>
                <span className="review-mode-toggle-dot" />Manual
              </button>
            </div>
          </div>

          <div className="review-kind-row">
            <button type="button" className="review-kind-chip" data-active={kind === "movie" ? "true" : undefined} onClick={() => { setKind("movie"); setResults([]); }}>Movie</button>
            <button type="button" className="review-kind-chip" data-active={kind === "book" ? "true" : undefined} onClick={() => { setKind("book"); setResults([]); }}>Book</button>
          </div>

          {mode === "search" ? (
            <>
              {kind === "book" && (
                <div className="review-provider-row">
                  <select className="review-select" value={bookProvider} onChange={(e) => setBookProvider(e.target.value as "open_library" | "google_books")}>
                    <option value="google_books">Google Books</option>
                    <option value="open_library">Open Library</option>
                  </select>
                </div>
              )}
              <div className="review-search-row">
                <input
                  className="review-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Foreign title, original title, or keyword"
                  onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
                />
                <button type="button" className="review-search-btn" onClick={() => void runSearch()} disabled={loading}>
                  {loading ? "..." : "Search"}
                </button>
              </div>
              {error && <p className="review-error-note">{error}</p>}
              <div className="review-result-list">
                {results.map((item) => (
                  <button key={`${item.provider}_${item.externalId}`} type="button" className="review-result-row" onClick={() => setPendingResult(item)}>
                    <span className="review-result-poster">
                      {item.coverUrl && <img src={item.coverUrl} alt="" />}
                    </span>
                    <span>
                      <span className="review-result-title">{item.title}</span>
                      <span className="review-result-sub">
                        {item.creator ? `${kind === "movie" ? "Director" : "Author"}: ${item.creator}` : ""}
                        {item.year ? `  ·  ${item.year}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="review-manual-link">
                <button type="button" onClick={() => setMode("manual")}>Can&apos;t find it? Add manually</button>
              </div>
            </>
          ) : (
            <div className="review-form">
              <div>
                <label className="review-field-label">Title<sup>*</sup></label>
                <input className="review-input" style={{ width: "100%" }} value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} placeholder="Title" />
              </div>
              <div>
                <label className="review-field-label">{kind === "movie" ? "Director" : "Author"}</label>
                <input className="review-input" style={{ width: "100%" }} value={manualCreator} onChange={(e) => setManualCreator(e.target.value)} placeholder={kind === "movie" ? "Director" : "Author"} />
              </div>
              <div>
                <label className="review-field-label">Year</label>
                <input className="review-input" style={{ width: "100%" }} value={manualYear} onChange={(e) => setManualYear(e.target.value)} placeholder="Year" />
              </div>
              <div>
                <label className="review-field-label">Notes</label>
                <textarea
                  className="review-textarea"
                  rows={3}
                  value={manualNotes}
                  onChange={(e) => setManualNotes(e.target.value)}
                  placeholder="A word beyond the one-line summary..."
                />
              </div>
              <div>
                <label className="review-field-label">Cover</label>
                <div className="review-file-picker">
                  <label className="review-file-picker-btn">
                    Choose file
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => setManualFile(e.target.files?.[0] ?? null)} />
                  </label>
                  <span className="review-file-picker-name">{manualFile ? manualFile.name : "No file chosen"}</span>
                </div>
              </div>
              <button type="button" className="review-confirm-btn" onClick={() => void finishManual()} disabled={!manualTitle.trim() || manualSaving}>
                {manualSaving ? "Saving..." : "Confirm & Collect Film"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
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
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState("");
  const [coverUrl, setCoverUrl] = useState<string | undefined>(pick.coverUrl);
  const [creator, setCreator] = useState(pick.creator);
  const [snippet, setSnippet] = useState<{ sourceLabel: "Review" | "Description"; text: string } | null>(null);
  const [snippetEdited, setSnippetEdited] = useState("");
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
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
  }, [pick]);

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
      title: pick.title,
      year: pick.year,
      creator,
      overview,
      coverAssetId,
      source: pick.kind === "movie"
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

  return (
    <div className="review-app-shell">
      <div className="review-app-page">
        <div className="review-topbar">
          <button type="button" className="review-icon-btn" aria-label="Back" onClick={onBack}>
            <ChevronLeft size={20} strokeWidth={1.8} />
          </button>
          <span className="review-topbar-title">{pick.title}</span>
          <span style={{ width: 38 }} />
        </div>
        <div className="review-scroll">
          {loading ? (
            <p style={{ textAlign: "center", padding: 40, color: "var(--rv-sub)", fontSize: 13 }}>Loading details...</p>
          ) : (
            <>
              <div className="review-ground-cover">
                {coverUrl ? <img src={coverUrl} alt={pick.title} /> : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rv-faint)" }}><Film size={28} /></div>}
              </div>
              <p className="review-ground-overview">{overview}</p>
              {snippet && !cleared ? (
                <div className="review-snippet-card">
                  <span className="review-snippet-label">{snippet.sourceLabel}</span>
                  <span className="review-snippet-hint">cached -- edit or clear if it looks wrong</span>
                  <textarea className="review-textarea" style={{ marginTop: 8 }} rows={5} value={snippetEdited} onChange={(e) => setSnippetEdited(e.target.value)} />
                  <div className="review-snippet-actions">
                    <button type="button" className="review-link-btn" onClick={() => setSnippetEdited(snippet.text)}>Revert to fetched</button>
                    <button type="button" className="review-link-btn" onClick={() => setCleared(true)}>Clear</button>
                  </div>
                </div>
              ) : (
                <p style={{ padding: "0 22px", fontSize: 12, color: "var(--rv-faint)" }}>
                  {pick.kind === "movie" ? "No cached review found for this title." : "No description available for this title."}
                </p>
              )}
              <div style={{ padding: "18px 22px 0" }}>
                <button type="button" className="review-confirm-btn" onClick={() => void finish()}>Add to My Archive</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
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
    addReviewDiscussionMessage({ threadId, authorType: "user", content: discussDraft.trim(), modeAtSend: mode });
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
    <div className="review-app-page">
      <div className="review-detail-hero">
        {coverUrl && <img src={coverUrl} alt={title.title} />}
        <div className="review-detail-hero-gradient" />
        <div className="review-detail-hero-bar">
          <button type="button" className="review-icon-btn" aria-label="Back" onClick={onBack}>
            <ChevronLeft size={20} strokeWidth={1.8} />
          </button>
          <button type="button" className="review-icon-btn" aria-label="Delete title" onClick={onDelete}>
            <Trash2 size={17} strokeWidth={1.8} />
          </button>
        </div>
        <div className="review-detail-hero-title-wrap">
          <p className="review-detail-title">{title.title}</p>
          <p className="review-detail-meta">{title.creator}{title.year ? ` · ${title.year}` : ""}</p>
        </div>
      </div>

      <div className="review-scroll">
        <div className="review-detail-body">
          <div className="review-rating-row">
            <span className="review-rating-label">My Rating</span>
            <StarRating value={title.myRating?.value ?? 0} onChange={(next) => updateTitle({ myRating: makeReviewRating(next) })} size={18} />
          </div>

          <div className="review-status-row">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="review-status-chip"
                data-active={title.status === opt.id ? "true" : undefined}
                onClick={() => updateTitle({ status: opt.id })}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {title.grounding && title.grounding.status !== "cleared" && (
            <div className="review-panel">
              <span className="review-snippet-label">{title.grounding.sourceLabel}</span>
              <p style={{ fontSize: 13, marginTop: 6, lineHeight: 1.55, color: "var(--rv-sub)" }}>{title.grounding.text}</p>
            </div>
          )}

          <div className="review-panel">
            <p className="review-panel-title">Journal</p>
            {journal.map((entry) => (
              <div key={entry.id} className="review-journal-entry">
                <p>{entry.body}</p>
                <button type="button" className="review-journal-entry-del" onClick={() => removeJournalEntry(entry.id)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <textarea
              className="review-textarea"
              style={{ marginTop: 10 }}
              value={journalDraft}
              onChange={(e) => setJournalDraft(e.target.value)}
              placeholder="Write down your thoughts..."
              rows={2}
            />
            <button type="button" className="review-ask-btn" style={{ marginTop: 8 }} onClick={addJournalEntry}>Add entry</button>
          </div>

          <div className="review-panel">
            <p className="review-panel-title">Discuss</p>
            {characters.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--rv-faint)" }}>No characters yet.</p>
            ) : (
              <>
                <select className="review-select" value={selectedCharacterId} onChange={(e) => setSelectedCharacterId(e.target.value)}>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <div className="review-discuss-thread">
                  {messages.map((msg, idx) => {
                    const prevMode = idx > 0 ? messages[idx - 1].modeAtSend : msg.modeAtSend;
                    const modeChanged = idx > 0 && prevMode !== msg.modeAtSend;
                    return (
                      <div key={msg.id}>
                        {modeChanged && (
                          <div className="review-discuss-divider">
                            {msg.modeAtSend === "discuss_free" ? "— now unrestricted (finished) —" : "— back to spoiler-safe —"}
                          </div>
                        )}
                        <div className="review-discuss-row" data-mine={msg.authorType === "user" ? "true" : undefined}>
                          <p className="review-discuss-bubble">{msg.content}</p>
                        </div>
                      </div>
                    );
                  })}
                  {discussBusy && <p style={{ fontSize: 12, color: "var(--rv-faint)" }}>Typing...</p>}
                </div>
                <div className="review-discuss-input-row">
                  <input
                    className="review-input"
                    value={discussDraft}
                    onChange={(e) => setDiscussDraft(e.target.value)}
                    placeholder="Say something..."
                    onKeyDown={(e) => { if (e.key === "Enter") void sendDiscussMessage(); }}
                    disabled={discussBusy}
                  />
                  <button type="button" className="review-send-btn" onClick={() => void sendDiscussMessage()} disabled={discussBusy}>
                    <Send size={16} />
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="review-panel">
            <p className="review-panel-title">Reviews</p>
            {reviews.map((review) => (
              <div key={review.id} className="review-published">
                <div className="review-published-head">
                  <span className="review-published-name">{review.characterName}</span>
                  <StarRating value={review.rating.value} readOnly size={14} />
                </div>
                <p className="review-published-headline">{review.headline}</p>
                {review.body.map((para, i) => (
                  <p key={i} className="review-published-body">{para}</p>
                ))}
              </div>
            ))}
            {reviewError && <p style={{ fontSize: 12, color: "var(--rv-danger)" }}>{reviewError}</p>}
            <button type="button" className="review-ask-btn" onClick={() => void askForReview()} disabled={reviewBusy || !selectedCharacterId}>
              {reviewBusy ? (
                <>
                  <RefreshCw size={14} className="review-spin" /> Writing...
                </>
              ) : (
                `Ask ${selectedCharacter?.name ?? "them"} for their review`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
