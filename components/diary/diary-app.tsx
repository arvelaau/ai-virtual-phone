"use client";

import { useState } from "react";
import { BookOpenText, ChevronLeft, StickyNote } from "lucide-react";

import { DiaryEntriesApp } from "./diary-entries-app";
import { NoteWallApp } from "./note-wall-app";

type DiaryAppProps = {
  onClose: () => void;
  onNotice?: (message: string) => void;
};

type DiaryView = "home" | "entries" | "notewall";

const NOTE_WALL_UI_ENABLED = false;

export function DiaryApp({ onClose, onNotice }: DiaryAppProps) {
  const [view, setView] = useState<DiaryView>("home");
  const todayLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
  }).format(new Date()).toUpperCase();

  if (NOTE_WALL_UI_ENABLED && view === "notewall") {
    return <NoteWallApp onBack={() => setView("home")} onNotice={onNotice} />;
  }

  if (view === "entries") {
    return <DiaryEntriesApp onBack={() => setView("home")} onNotice={onNotice} />;
  }

  return (
    <section className="diary-app">
      <header className="diary-app-header">
        <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="Back to desktop">
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>Journal</h1>
          <p>Words your characters leave behind</p>
        </div>
        <span className="diary-header-spacer" />
      </header>

      <main className="diary-home">
        <button type="button" className="diary-feature-card diary-feature-card-entry" onClick={() => setView("entries")}>
          <span className="diary-feature-punches diary-feature-punches-left" aria-hidden="true" />
          <span className="diary-feature-punches diary-feature-punches-right" aria-hidden="true" />
          <span className="diary-feature-card-head">
            <span className="diary-feature-label">DIARY</span>
            <span className="diary-feature-number">{todayLabel}</span>
          </span>
          <span className="diary-feature-main">
            <span className="diary-feature-icon">
              <BookOpenText size={20} strokeWidth={1.55} />
            </span>
            <span>
              <strong>Diary</strong>
              <em>Pages and fragments written by your characters</em>
            </span>
          </span>
          <span className="diary-feature-bottom" aria-hidden="true">
            <span className="diary-feature-barcode" />
            <span className="diary-feature-weather">SUNNY 24C / HUM 62%</span>
          </span>
        </button>

        {NOTE_WALL_UI_ENABLED ? (
          <button type="button" className="diary-feature-card diary-feature-card-primary" onClick={() => setView("notewall")}>
            <span className="diary-feature-punches diary-feature-punches-left" aria-hidden="true" />
            <span className="diary-feature-punches diary-feature-punches-right" aria-hidden="true" />
            <span className="diary-feature-card-head">
              <span className="diary-feature-label">NOTES</span>
              <span className="diary-feature-number">{todayLabel}</span>
            </span>
            <span className="diary-feature-main">
              <span className="diary-feature-icon">
                <StickyNote size={20} strokeWidth={1.55} />
              </span>
              <span>
                <strong>Note Wall</strong>
                <em>Moods and messages posted publicly</em>
              </span>
            </span>
            <span className="diary-feature-bottom" aria-hidden="true">
              <span className="diary-feature-barcode" />
              <span className="diary-feature-weather">CLOUDY 22C / HUM 68%</span>
            </span>
          </button>
        ) : null}
      </main>
    </section>
  );
}
