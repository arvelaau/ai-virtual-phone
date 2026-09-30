"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Image as PhotoIcon, Plus, Trash2, X, Maximize2, Play, Download, Upload } from "lucide-react";
import { TextExpandModal } from "@/components/ui/modal";
import { CustomStatusFrame } from "@/components/chat/custom-status-frame";
import { StoryPaginationManager, type StoryBranchCreateInput } from "@/components/story/story-pagination-manager";
import { downloadFile } from "@/lib/download-utils";
import type { Character } from "@/lib/character-types";
import type { PresetConfig } from "@/lib/settings-types";
import type { StoryCharacterSettings, StoryGroup, StoryProseStyleScheme, StoryQuickInputScheme, StorySchemeRepository, StorySession, StoryTailScheme, StoryUiPrefs } from "@/lib/story-storage";
import {
  STORY_DEFAULT_STATUS_RENDER,
  STORY_DEFAULT_THEATER_RENDER,
  STORY_DEFAULT_QUICK_INPUT_OPTIONS,
} from "@/lib/story-storage";

// Backward-compat re-export (story-app-base imports the render-canvas constants from here).
export { STORY_DEFAULT_STATUS_RENDER, STORY_DEFAULT_THEATER_RENDER };

type StorySettingsPageProps = {
  characters: Character[];
  activeCharacterId: string;
  activeGroupId: string;
  groups: StoryGroup[];
  ownerSessions: StorySession[];
  activeSessionId: string;
  userName: string;
  uiPrefs: StoryUiPrefs;
  settings: StoryCharacterSettings;
  /** Shared scheme repository: the definitions of prose-style/status-bar/mini-theater/quick-input schemes (shared across every character). */
  schemeRepo: StorySchemeRepository;
  boundPreset: PresetConfig | null;
  foldTags: string;
  contextExcludedTags: string;
  onClose: () => void;
  onCharacterChange: (characterId: string) => void;
  onGroupSelect: (groupId: string) => void;
  onGroupCreate: (characterIds: string[], name: string) => void;
  onGroupRename: (groupId: string, name: string) => void;
  onGroupDelete: (groupId: string) => void;
  onSessionSelect: (sessionId: string) => void;
  onBranchCreate: (input: StoryBranchCreateInput) => void;
  onBranchDelete: (sessionIds: string[]) => void;
  onSessionUpdate: (sessionId: string, updates: Partial<StorySession>) => void;
  onExportSession: (sessionId: string) => void;
  onExportAll: () => void;
  onUiPrefsChange: (prefs: StoryUiPrefs) => void;
  onSettingsChange: (settings: StoryCharacterSettings) => void;
  /** Edits a scheme definition in the shared repository (add/delete/rename/edit content all persist through here). */
  onSchemeRepoChange: (repo: StorySchemeRepository) => void;
  onTagsChange: (foldTags: string, contextExcludedTags: string) => void;
  onOpenCss: () => void;
  onRebuildCache: () => void;
};

function normalizeSettings(value: StoryCharacterSettings, repo: StorySchemeRepository): StoryCharacterSettings {
  return {
    ...value,
    presetName: value.presetName || "Default Story",
    minChars: value.minChars ?? 800,
    maxChars: value.maxChars ?? 1500,
    userPerspective: value.userPerspective || "second",
    // Fall back when the enabled choice falls outside the repository: old id -> match by the
    // old prose-style name -> the first scheme.
    activeProseStyleSchemeId: repo.proseStyleSchemes.some((item) => item.id === value.activeProseStyleSchemeId)
      ? value.activeProseStyleSchemeId
      : repo.proseStyleSchemes.find((item) => item.name === value.proseStyle)?.id || repo.proseStyleSchemes[0].id,
    activeStatusSchemeId: repo.statusSchemes.some((item) => item.id === value.activeStatusSchemeId)
      ? value.activeStatusSchemeId
      : repo.statusSchemes[0].id,
    activeTheaterSchemeId: repo.theaterSchemes.some((item) => item.id === value.activeTheaterSchemeId)
      ? value.activeTheaterSchemeId
      : repo.theaterSchemes[0].id,
  };
}

function ProseStyleEditor({
  schemes,
  activeId,
  onChange,
}: {
  schemes: StoryProseStyleScheme[];
  activeId: string;
  onChange: (schemes: StoryProseStyleScheme[], activeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = schemes.find((item) => item.id === activeId) || schemes[0];
  const updateActive = (updates: Partial<StoryProseStyleScheme>) => {
    onChange(schemes.map((item) => item.id === active.id ? { ...item, ...updates } : item), active.id);
  };

  return (
    <div className="story-scheme-editor story-prose-style-editor">
      <div className="story-settings-label-row"><label>Prose style scheme</label><span>Shared across every character; the current character just chooses which one is enabled</span></div>
      <div className="story-settings-inline story-settings-inline-with-save">
        <select value={active.id} onChange={(event) => onChange(schemes, event.target.value)}>
          {schemes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" aria-label="Add a new prose style scheme" onClick={() => {
          const id = `story-style-${Date.now()}`;
          const next = [...schemes, { id, name: `Prose Style ${schemes.length + 1}`, prompt: "" }];
          onChange(next, id);
        }}><Plus width={15} /></button>
        <button type="button" aria-label="Delete this prose style scheme" disabled={schemes.length <= 1} onClick={() => {
          if (schemes.length <= 1) return;
          const next = schemes.filter((item) => item.id !== active.id);
          onChange(next, next[0].id);
        }}><Trash2 width={14} /></button>
        <button type="button" className="story-scheme-save" onClick={() => onChange(schemes, active.id)}>Save</button>
      </div>
      <input value={active.name} onChange={(event) => updateActive({ name: event.target.value })} placeholder="Prose style scheme name" />
      <div className="story-prompt-textarea-wrap">
        <textarea
          value={active.prompt}
          onChange={(event) => updateActive({ prompt: event.target.value })}
          placeholder="Write the prose-style requirements for the AI -- pacing, word choice, what to emphasize when describing things"
        />
        <button type="button" className="story-prompt-expand" onClick={() => setExpanded(true)} aria-label="Expand to edit the prose style prompt" title="Expand to edit">
          <Maximize2 size={14} />
        </button>
      </div>
      <p className="story-settings-note">Prose style schemes are saved in the shared repository -- every character shares the same set; editing one affects every character.</p>
      {expanded ? (
        <TextExpandModal
          title={`${active.name || "Prose Style"} · Style requirements`}
          value={active.prompt}
          onChange={(prompt) => updateActive({ prompt })}
          placeholder="Write the prose-style requirements for the AI. No need to describe the status bar, mini theater, or any other tail-output format here."
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </div>
  );
}

// Story character-count input: allowed to be cleared/selected-and-retyped while editing, with
// no forced correction; it only commits on blur or Enter.
// A value of 0 or above 10000 is kept exactly as the user typed it; the generation engine
// clamps it to 50-10000 in the prompt.
function CharLimitInput({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  const commitDraft = () => {
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? NaN : Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    onCommit(Math.trunc(parsed));
    setDraft(String(Math.trunc(parsed)));
  };
  const outOfRange = value < 50 || value > 10000;
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={50}
        max={10000}
        inputMode="numeric"
        value={draft}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commitDraft(); }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
      <small className="story-char-limit-hint" data-out={outOfRange ? "true" : undefined}>{outOfRange ? `Saved as ${value}; generation clamps it to 50-10000` : "Range: 50-10000"}</small>
    </label>
  );
}

function SettingCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="story-settings-card">
      <div className="story-settings-card-head">
        <div>
          <h2>{title}</h2>
          {hint ? <p>{hint}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function ToggleRow({ title, detail, checked, onChange }: { title: string; detail?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="story-settings-toggle-row">
      <span><strong>{title}</strong>{detail ? <small>{detail}</small> : null}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SchemeEditor({
  label,
  schemes,
  activeId,
  tag,
  contextNote,
  onChange,
}: {
  label: string;
  schemes: StoryTailScheme[];
  activeId: string;
  tag: string;
  contextNote: string;
  onChange: (schemes: StoryTailScheme[], activeId: string) => void;
}) {
  const active = schemes.find((item) => item.id === activeId) || schemes[0];
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftSchemes, setDraftSchemes] = useState<StoryTailScheme[]>(schemes);
  const [draftId, setDraftId] = useState(active.id);
  const draft = draftSchemes.find((item) => item.id === draftId) || draftSchemes[0] || active;
  const [previewHtml, setPreviewHtml] = useState(draft.renderHtml || "");
  const [expandedField, setExpandedField] = useState<"prompt" | "render" | null>(null);
  useEffect(() => {
    if (editorOpen) return;
    setDraftSchemes(schemes);
    setDraftId(active.id);
    setPreviewHtml(active.renderHtml || "");
  }, [active.id, active.renderHtml, editorOpen, schemes]);

  const updateDraft = (updates: Partial<StoryTailScheme>) => {
    setDraftSchemes((items) => items.map((item) => item.id === draft.id ? { ...item, ...updates } : item));
  };
  const openEditor = () => {
    setDraftSchemes(schemes.map((item) => ({ ...item })));
    setDraftId(active.id);
    setPreviewHtml(active.renderHtml || "");
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    setExpandedField(null);
  };

  // -- scheme import/export --
  // Export: every scheme of the current kind is packaged into one JSON file (the local id is
  // stripped and regenerated on import).
  // Import: recognizes an export file / a scheme array / a single scheme object, merges it into
  // the editing list, and auto-numbers any name collision.
  const kind = tag === "story_theater" ? "theater" : "status";
  const kindLabel = tag === "story_theater" ? "Mini Theater" : "Status Bar";
  const fileRef = useRef<HTMLInputElement | null>(null);

  const exportSchemes = async () => {
    try {
      const payload = {
        type: "ai-phone-story-scheme",
        version: 1,
        kind,
        schemes: draftSchemes.map((item) => ({ name: item.name, prompt: item.prompt, renderHtml: item.renderHtml || "", preview: item.preview || "" })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      await downloadFile(blob, `Story ${kindLabel} Schemes.json`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Export failed, please try again");
    }
  };

  const importSchemes = async (file: File) => {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error("That file isn't valid JSON -- make sure it's a scheme export file"); }
      let incoming: unknown[];
      if (Array.isArray(parsed)) incoming = parsed;
      else if (parsed && typeof parsed === "object") {
        const wrapper = parsed as { kind?: string; schemes?: unknown; name?: unknown; prompt?: unknown; renderHtml?: unknown };
        // A file tagged with a kind that was imported into the wrong editor is rejected
        // outright, so status-bar and mini-theater schemes can't cross-contaminate.
        if (typeof wrapper.kind === "string" && wrapper.kind !== kind) {
          throw new Error(`This is a "${wrapper.kind === "theater" ? "Mini Theater" : "Status Bar"}" scheme file -- import it from that editor instead`);
        }
        if (Array.isArray(wrapper.schemes)) incoming = wrapper.schemes;
        else if (typeof wrapper.name === "string" || typeof wrapper.prompt === "string" || typeof wrapper.renderHtml === "string") incoming = [wrapper];
        else throw new Error("No valid schemes found (a scheme needs a name, an output contract, or render HTML)");
      } else throw new Error("That file's contents aren't valid scheme data");

      const sanitize = (raw: unknown): StoryTailScheme | null => {
        if (!raw || typeof raw !== "object") return null;
        const item = raw as Record<string, unknown>;
        const name = typeof item.name === "string" ? item.name.trim().slice(0, 40) : "";
        const prompt = typeof item.prompt === "string" ? item.prompt : "";
        const renderHtml = typeof item.renderHtml === "string" ? item.renderHtml : "";
        const preview = typeof item.preview === "string" ? item.preview : "";
        if (!name && !prompt.trim() && !renderHtml.trim()) return null;
        return { id: `${tag}-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: name || "Imported Scheme", prompt, renderHtml, preview };
      };
      const imported = incoming.map(sanitize).filter((item): item is StoryTailScheme => item !== null);
      if (!imported.length) throw new Error("No valid schemes found (a scheme needs a name, an output contract, or render HTML)");

      const existing = new Set(draftSchemes.map((item) => item.name));
      const renamed = imported.map((item) => {
        if (!existing.has(item.name)) { existing.add(item.name); return item; }
        let n = 2;
        while (existing.has(`${item.name} ${n}`)) n += 1;
        const name = `${item.name} ${n}`;
        existing.add(name);
        return { ...item, name };
      });
      setDraftSchemes((items) => [...items, ...renamed]);
      setDraftId(renamed[0].id);
      setPreviewHtml(renamed[0].renderHtml || "");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Import failed, please try again");
    }
  };

  return (
    <div className="story-scheme-editor">
      <button type="button" className="story-tail-editor-entry" onClick={openEditor}>
        <span><strong>{label}</strong><small>{active.name} &middot; {contextNote}</small></span>
        <ChevronLeft width={17} style={{ transform: "rotate(180deg)" }} />
      </button>

      {editorOpen ? (
        <div className="story-tail-editor-overlay" onClick={closeEditor}>
          <section className="story-tail-editor-modal" role="dialog" aria-modal="true" aria-label={`Customize ${label}`} onClick={(event) => event.stopPropagation()}>
            <header className="story-tail-editor-header">
              <strong>Customize {tag === "story_theater" ? "Mini Theater" : "Status Bar"}</strong>
              <button type="button" onClick={closeEditor} aria-label="Close"><X width={19} /></button>
            </header>

            <div className="story-tail-editor-scroll">
              <div className="story-tail-scheme-row">
                <select value={draft.id} onChange={(event) => {
                  const next = draftSchemes.find((item) => item.id === event.target.value);
                  setDraftId(event.target.value);
                  setPreviewHtml(next?.renderHtml || "");
                }}>
                  {draftSchemes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <button type="button" aria-label={`Add a new ${label}`} onClick={() => {
                  const id = `${tag}-${Date.now()}`;
                  const next: StoryTailScheme = { id, name: `${label} ${draftSchemes.length + 1}`, prompt: `Output <${tag}>...</${tag}> at the end of the prose.`, renderHtml: "", preview: "" };
                  setDraftSchemes((items) => [...items, next]);
                  setDraftId(id);
                  setPreviewHtml("");
                }}><Plus width={16} /></button>
                <button type="button" aria-label={`Delete this ${label}`} disabled={draftSchemes.length <= 1} onClick={() => {
                  if (draftSchemes.length <= 1) return;
                  const next = draftSchemes.filter((item) => item.id !== draft.id);
                  setDraftSchemes(next);
                  setDraftId(next[0].id);
                  setPreviewHtml(next[0].renderHtml || "");
                }}><Trash2 width={15} /></button>
                <button type="button" aria-label={`Export ${label}`} title={`Export every ${label} to a file`} onClick={() => void exportSchemes()}><Download size={15} /></button>
                <button type="button" aria-label={`Import ${label}`} title={`Import ${label} from a file`} onClick={() => fileRef.current?.click()}><Upload size={15} /></button>
              </div>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importSchemes(file);
                event.target.value = "";
              }} />
              <p className="story-tail-io-note">Export saves every {kindLabel} scheme as one JSON file; import appends the file's schemes to the list (a name collision gets an automatic number), and takes effect once you click "Save &amp; enable."</p>
              <input className="story-tail-name-input" value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="Scheme name" />

              <div className="story-tail-field-head"><strong>Output contract</strong><small>The whole section is written into the prompt</small></div>
              <div className="story-prompt-textarea-wrap">
                <textarea value={draft.prompt} onChange={(event) => updateDraft({ prompt: event.target.value })} placeholder={`The output contract given to the AI, requiring it to use the <${tag}> tag`} />
                <button type="button" className="story-prompt-expand" onClick={() => setExpandedField("prompt")} aria-label="Expand to edit the output contract"><Maximize2 size={14} /></button>
              </div>

              <div className="story-tail-field-head"><strong>Output render</strong><small>HTML &middot; runs sandboxed</small></div>
              <div className="story-prompt-textarea-wrap">
                <textarea className="story-render-textarea" value={draft.renderHtml || ""} onChange={(event) => updateDraft({ renderHtml: event.target.value })} placeholder="Write HTML/CSS/JS; use {{RAW}} or window.STORY_RAW to read the raw output" spellCheck={false} />
                <button type="button" className="story-prompt-expand" onClick={() => setExpandedField("render")} aria-label="Expand to edit the output render"><Maximize2 size={14} /></button>
              </div>

              <div className="story-settings-preview">
                <div className="story-tail-preview-head"><span><strong>Preview</strong><small>The example data can be edited</small></span><button type="button" onClick={() => setPreviewHtml(draft.renderHtml || "")} aria-label="Run preview" title="Run preview"><Play size={15} /></button></div>
                <textarea value={draft.preview} onChange={(event) => updateDraft({ preview: event.target.value })} placeholder="Edit the preview content here" />
                {previewHtml.trim() ? <div className="story-tail-preview-frame"><CustomStatusFrame key={`${draft.id}:${previewHtml}:${draft.preview}`} html={previewHtml} raw={draft.preview} kind={tag === "story_theater" ? "theater" : "status"} title={`${label} preview`} /></div> : <div className="story-tail-preview-empty">Fill in the output render, then click play to preview</div>}
              </div>
            </div>

            <footer className="story-tail-editor-footer">
              <button type="button" onClick={closeEditor}>Cancel</button>
              <button type="button" className="story-tail-editor-save" onClick={() => { onChange(draftSchemes, draft.id); closeEditor(); }}>Save &amp; enable</button>
            </footer>

            {expandedField ? <TextExpandModal
              title={`${draft.name || label} · ${expandedField === "prompt" ? "Output contract" : "Output render"}`}
              value={expandedField === "prompt" ? draft.prompt : draft.renderHtml || ""}
              onChange={(value) => updateDraft(expandedField === "prompt" ? { prompt: value } : { renderHtml: value })}
              placeholder={expandedField === "prompt" ? `Require the AI to output content using the <${tag}> tag` : "Write HTML/CSS/JS; use window.STORY_RAW to read the raw text"}
              onClose={() => setExpandedField(null)}
            /> : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function QuickOptionsEditor({
  options,
  onChange,
}: {
  options: string[];
  onChange: (options: string[]) => void;
}) {
  const updateOption = (index: number, value: string) => {
    onChange(options.map((item, i) => (i === index ? value : item)));
  };
  const removeOption = (index: number) => {
    onChange(options.filter((_, i) => i !== index));
  };

  return (
    <div className="story-quick-options-editor">
      <div className="story-settings-subhead">
        <strong>Quick options</strong>
        <button className="story-settings-mini-add" type="button" onClick={() => onChange([...options, ""])}><Plus width={13} />Add</button>
      </div>
      <div className="story-quick-options">
        {options.map((option, index) => (
          <div key={index} className="story-quick-option-item">
            <input
              value={option}
              maxLength={16}
              placeholder="Symbol or phrase"
              onChange={(event) => updateOption(index, event.target.value)}
            />
            <button
              type="button"
              aria-label="Delete this quick option"
              disabled={options.length <= 1}
              onClick={() => removeOption(index)}
            >
              <Trash2 width={13} />
            </button>
          </div>
        ))}
        {!options.length ? <p className="story-settings-empty">No options yet -- click "Add" to create one.</p> : null}
      </div>
      <p className="story-settings-note">Blank options are hidden from the panel; deleting them all falls back to the default options {STORY_DEFAULT_QUICK_INPUT_OPTIONS.join(" ")}.</p>
    </div>
  );
}

export function StorySettingsPage(props: StorySettingsPageProps) {
  const normalized = useMemo(() => normalizeSettings(props.settings, props.schemeRepo), [props.settings, props.schemeRepo]);
  const repo = props.schemeRepo;
  // Scheme definitions -> the shared repository. Which one is enabled -> the current
  // character's own settings.
  const patchRepo = (updates: Partial<StorySchemeRepository>) => {
    props.onSchemeRepoChange({ ...repo, ...updates });
  };
  const quickInputActive = repo.quickInputSchemes.find((item) => item.id === props.uiPrefs.activeQuickInputSchemeId) || repo.quickInputSchemes[0];
  const updateQuickInputScheme = (updates: Partial<StoryQuickInputScheme>) => {
    if (!quickInputActive) return;
    patchRepo({ quickInputSchemes: repo.quickInputSchemes.map((item) => item.id === quickInputActive.id ? { ...item, ...updates } : item) });
  };
  const [wallpaperOpen, setWallpaperOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fontFileRef = useRef<HTMLInputElement | null>(null);
  const [fontUrlDraft, setFontUrlDraft] = useState(props.uiPrefs.customFontUrl || "");
  useEffect(() => {
    setFontUrlDraft(props.uiPrefs.customFontUrl || "");
  }, [props.activeSessionId, props.uiPrefs.customFontUrl]);
  const availablePrompts = useMemo(
    () => (props.boundPreset?.prompts || []).filter((item) => !item.marker && item.content?.trim()),
    [props.boundPreset],
  );
  const selectedPromptIds = normalized.enabledPresetPromptIds ?? availablePrompts.filter((item) => item.enabled).map((item) => item.identifier);

  const patchSettings = (updates: Partial<StoryCharacterSettings>) => {
    props.onSettingsChange({ ...normalized, ...updates });
  };

  const readWallpaper = (file?: File) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => props.onUiPrefsChange({ ...props.uiPrefs, wallpaper: typeof reader.result === "string" ? reader.result : undefined });
    reader.readAsDataURL(file);
  };

  const readCustomFont = (file?: File) => {
    if (!file) return;
    const supported = /\.(?:ttf|otf|woff2?)$/i.test(file.name) || file.type.startsWith("font/") || file.type === "application/font-woff";
    if (!supported) {
      window.alert("Please choose a TTF, OTF, WOFF, or WOFF2 font file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      window.alert("The font file can't be larger than 8MB -- try a trimmed-down WOFF2 font");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setFontUrlDraft("");
      props.onUiPrefsChange({
        ...props.uiPrefs,
        customFontDataUrl: reader.result,
        customFontUrl: undefined,
        customFontName: file.name,
      });
    };
    reader.readAsDataURL(file);
  };

  const applyCustomFontUrl = () => {
    const value = fontUrlDraft.trim();
    if (value && !/^https?:\/\//i.test(value)) {
      window.alert("Please enter a direct font link starting with http:// or https://");
      return;
    }
    props.onUiPrefsChange({
      ...props.uiPrefs,
      customFontDataUrl: undefined,
      customFontUrl: value || undefined,
      customFontName: value ? "URL Font" : undefined,
    });
  };

  if (wallpaperOpen) {
    return (
      <div className="story-settings-page story-wallpaper-page">
        <header className="story-settings-header">
          <button type="button" onClick={() => setWallpaperOpen(false)} aria-label="Back to story settings"><ChevronLeft width={19} /></button>
          <strong>Background wallpaper</strong><span />
        </header>
        <main className="story-wallpaper-main">
          <div className="story-wallpaper-preview" style={props.uiPrefs.wallpaper ? { backgroundImage: `url(${props.uiPrefs.wallpaper})` } : undefined}>
            {!props.uiPrefs.wallpaper ? <><PhotoIcon width={30} /><span>No story wallpaper set yet</span></> : null}
          </div>
          <input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => readWallpaper(event.target.files?.[0])} />
          <button className="story-settings-primary" type="button" onClick={() => fileRef.current?.click()}>Choose from your photos</button>
          {props.uiPrefs.wallpaper ? <button className="story-settings-danger" type="button" onClick={() => props.onUiPrefsChange({ ...props.uiPrefs, wallpaper: undefined })}>Clear the current wallpaper</button> : null}
          <p>The wallpaper only applies to this story's own page -- it doesn't affect chat, the home screen, or other characters.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="story-settings-page">
      <header className="story-settings-header">
        <button type="button" onClick={props.onClose} aria-label="Back to story"><ChevronLeft width={19} /></button>
        <strong>Story settings</strong>
        <button type="button" onClick={props.onClose} aria-label="Close settings"><X width={17} /></button>
      </header>
      <main className="story-settings-scroll">
        <StoryPaginationManager
          characters={props.characters}
          activeCharacterId={props.activeCharacterId}
          activeGroupId={props.activeGroupId}
          groups={props.groups}
          sessions={props.ownerSessions}
          activeSessionId={props.activeSessionId}
          userName={props.userName}
          onCharacterChange={props.onCharacterChange}
          onGroupSelect={props.onGroupSelect}
          onGroupCreate={props.onGroupCreate}
          onGroupRename={props.onGroupRename}
          onGroupDelete={props.onGroupDelete}
          onSessionSelect={props.onSessionSelect}
          onBranchCreate={props.onBranchCreate}
          onBranchDelete={props.onBranchDelete}
          onSessionUpdate={props.onSessionUpdate}
          onExportSession={props.onExportSession}
          onExportAll={props.onExportAll}
        />

        <SettingCard title="Story preset settings" hint="Consider building a dedicated preset just for the Story app, so it doesn't affect other apps">
          <label className="story-settings-field"><span>This character's dedicated preset name</span><input value={normalized.presetName} onChange={(event) => patchSettings({ presetName: event.target.value })} /></label>
          <label className="story-settings-field"><span>Extra story requirements</span><textarea value={normalized.extraPrompt || ""} onChange={(event) => patchSettings({ extraPrompt: event.target.value })} placeholder="Used only when generating this character's story" /></label>
          <div className="story-settings-subhead"><strong>Dedicated preset entries</strong><button className="story-settings-mini-add" type="button" onClick={() => patchSettings({ customPromptEntries: [...(normalized.customPromptEntries || []), { id: `story-entry-${Date.now()}`, name: `New Entry ${(normalized.customPromptEntries?.length || 0) + 1}`, content: "", enabled: true }] })}><Plus width={13} />Add</button></div>
          <div className="story-custom-entry-list">
            {(normalized.customPromptEntries || []).map((entry) => (
              <div key={entry.id}>
                <label className="story-custom-entry-title"><input type="checkbox" checked={entry.enabled} onChange={(event) => patchSettings({ customPromptEntries: normalized.customPromptEntries!.map((item) => item.id === entry.id ? { ...item, enabled: event.target.checked } : item) })} /><input value={entry.name} onChange={(event) => patchSettings({ customPromptEntries: normalized.customPromptEntries!.map((item) => item.id === entry.id ? { ...item, name: event.target.value } : item) })} /><button type="button" onClick={() => patchSettings({ customPromptEntries: normalized.customPromptEntries!.filter((item) => item.id !== entry.id) })}><Trash2 width={13} /></button></label>
                <textarea value={entry.content} onChange={(event) => patchSettings({ customPromptEntries: normalized.customPromptEntries!.map((item) => item.id === entry.id ? { ...item, content: event.target.value } : item) })} placeholder="Write this story-specific prompt entry" />
              </div>
            ))}
            {!normalized.customPromptEntries?.length ? <p className="story-settings-empty">No dedicated entries yet -- add one if you need it; it only affects this character's story.</p> : null}
          </div>
          <div className="story-settings-subhead"><strong>Bound preset entries</strong><small>{props.boundPreset?.name || "No preset bound"}</small></div>
          {availablePrompts.length ? (
            <div className="story-preset-prompt-list">
              {availablePrompts.map((prompt) => (
                <label key={prompt.identifier}>
                  <input type="checkbox" checked={selectedPromptIds.includes(prompt.identifier)} onChange={(event) => {
                    const next = event.target.checked ? [...selectedPromptIds, prompt.identifier] : selectedPromptIds.filter((id) => id !== prompt.identifier);
                    patchSettings({ enabledPresetPromptIds: Array.from(new Set(next)) });
                  }} />
                  <span><strong>{prompt.name || prompt.identifier}</strong><small>{prompt.content.slice(0, 70)}</small></span>
                </label>
              ))}
            </div>
          ) : <p className="story-settings-empty">Bind a preset to the Story app first, under Settings -&gt; Binding Manager.</p>}
        </SettingCard>

        <SettingCard title="Generation settings" hint="Check whether a preset entry duplicates anything here">
          <div className="story-number-grid">
            <CharLimitInput label="Minimum length" value={normalized.minChars ?? 800} onCommit={(minChars) => patchSettings({ minChars })} />
            <CharLimitInput label="Maximum length" value={normalized.maxChars ?? 1500} onCommit={(maxChars) => patchSettings({ maxChars })} />
          </div>
          <label className="story-settings-field"><span>User perspective</span><select value={normalized.userPerspective} onChange={(event) => patchSettings({ userPerspective: event.target.value as StoryCharacterSettings["userPerspective"] })}><option value="second">Second person ("you")</option><option value="third">Third person ("they")</option><option value="username">By name ("{props.userName}")</option></select></label>
          <ProseStyleEditor schemes={repo.proseStyleSchemes} activeId={normalized.activeProseStyleSchemeId!} onChange={(proseStyleSchemes, activeProseStyleSchemeId) => { patchRepo({ proseStyleSchemes }); patchSettings({ activeProseStyleSchemeId }); }} />
        </SettingCard>

        <SettingCard title="Voice & playback">
          <ToggleRow title="Enable voice" detail="Turns on this character's voice, bound to the Story app; doesn't start reading automatically" checked={Boolean(props.uiPrefs.voiceEnabled)} onChange={(value) => props.onUiPrefsChange({ ...props.uiPrefs, voiceEnabled: value })} />
          {props.activeGroupId ? <p className="story-settings-note">A multiplayer story's characters don't share one voice -- it may default to the first character's voice.</p> : null}
          <p className="story-settings-note">The overall play button plays the next line each time it's pressed; the small button at the end of each line of dialogue still plays that line on its own.</p>
        </SettingCard>

        <SettingCard title="Custom font" hint="Applies only to this story session; upload a font file or enter a direct font link">
          <input
            ref={fontFileRef}
            hidden
            type="file"
            accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
            onChange={(event) => {
              readCustomFont(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button className="story-font-upload-button" type="button" onClick={() => fontFileRef.current?.click()}>
            <span><strong>Upload a font file</strong><small>{props.uiPrefs.customFontDataUrl ? `${props.uiPrefs.customFontName || "Font uploaded"} · applied automatically` : "TTF / OTF / WOFF / WOFF2, up to 8MB"}</small></span>
            <Upload size={16} />
          </button>
          <label className="story-settings-field">
            <span>Font URL</span>
            <input value={fontUrlDraft} onChange={(event) => setFontUrlDraft(event.target.value)} placeholder="https://example.com/font.woff2" />
          </label>
          <div className="story-font-actions">
            <button type="button" className="story-font-apply" onClick={applyCustomFontUrl}>Apply font URL</button>
            {(props.uiPrefs.customFontDataUrl || props.uiPrefs.customFontUrl) ? (
              <button type="button" className="story-font-reset" onClick={() => {
                setFontUrlDraft("");
                props.onUiPrefsChange({ ...props.uiPrefs, customFontDataUrl: undefined, customFontUrl: undefined, customFontName: undefined });
              }}>Reset to default font</button>
            ) : null}
          </div>
          <p className="story-settings-note">A remote font must be a directly-accessible font file that allows cross-origin loading; otherwise the browser falls back to the default story font.</p>
        </SettingCard>

        <SettingCard title="Auto-read" hint="Once enabled, an auto-scroll button appears next to Continue, for hands-free reading">
          <ToggleRow title="Enable auto-read" detail="Can start from the newest character message or the current page position" checked={Boolean(props.uiPrefs.autoReadingEnabled)} onChange={(value) => props.onUiPrefsChange({ ...props.uiPrefs, autoReadingEnabled: value })} />
          {props.uiPrefs.autoReadingEnabled ? (
            <label className="story-auto-reading-speed">
              <span><strong>Reading speed</strong><small>{props.uiPrefs.autoReadingSpeed ?? 36} px/sec</small></span>
              <input
                type="range"
                min={12}
                max={120}
                step={4}
                value={props.uiPrefs.autoReadingSpeed ?? 36}
                onChange={(event) => props.onUiPrefsChange({ ...props.uiPrefs, autoReadingSpeed: Number(event.target.value) })}
              />
              <div><small>Slow</small><small>Fast</small></div>
            </label>
          ) : null}
        </SettingCard>

        <SettingCard title="Quick-input panel" hint='Once enabled, an "Input" button appears next to Continue; schemes are saved in the shared repository, shared across every character'>
          <ToggleRow
            title="Enable the quick-input panel"
            detail="Expands a narrow banner above the input box; tapping an option inserts it into the input box, and you can swipe left/right if there are too many options"
            checked={Boolean(props.uiPrefs.quickInputEnabled)}
            onChange={(value) => props.onUiPrefsChange({ ...props.uiPrefs, quickInputEnabled: value })}
          />
          {props.uiPrefs.quickInputEnabled && quickInputActive ? (
            <>
              <div className="story-settings-label-row"><label>Input scheme</label><span>Shared across every character; the current character just chooses which one is enabled</span></div>
              <div className="story-settings-inline">
                <select value={quickInputActive.id} onChange={(event) => props.onUiPrefsChange({ ...props.uiPrefs, activeQuickInputSchemeId: event.target.value })}>
                  {repo.quickInputSchemes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <button type="button" aria-label="Add a new quick-input scheme" onClick={() => {
                  const id = `quick-${Date.now()}`;
                  patchRepo({ quickInputSchemes: [...repo.quickInputSchemes, { id, name: `Input Scheme ${repo.quickInputSchemes.length + 1}`, options: [...STORY_DEFAULT_QUICK_INPUT_OPTIONS], cursor: "middle" as const }] });
                  props.onUiPrefsChange({ ...props.uiPrefs, activeQuickInputSchemeId: id });
                }}><Plus width={15} /></button>
                <button type="button" aria-label="Delete this quick-input scheme" disabled={repo.quickInputSchemes.length <= 1} onClick={() => {
                  if (repo.quickInputSchemes.length <= 1) return;
                  const next = repo.quickInputSchemes.filter((item) => item.id !== quickInputActive.id);
                  patchRepo({ quickInputSchemes: next });
                  props.onUiPrefsChange({ ...props.uiPrefs, activeQuickInputSchemeId: next[0].id });
                }}><Trash2 width={14} /></button>
              </div>
              <div className="story-quick-cursor-row">
                <span className="story-quick-cursor-label">Cursor position after inserting</span>
                <div className="story-quick-cursor-options" role="radiogroup" aria-label="Cursor position after inserting">
                  {([["left", "Left of the option"], ["middle", "Middle of the option"], ["right", "Right of the option"]] as const).map(([value, label]) => {
                    const active = (quickInputActive.cursor ?? "middle") === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        data-active={active ? "true" : undefined}
                        onClick={() => updateQuickInputScheme({ cursor: value })}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <QuickOptionsEditor
                options={quickInputActive.options}
                onChange={(options) => updateQuickInputScheme({ options })}
              />
              <p className="story-settings-note">Tapping a panel option inserts it with the cursor landing at the position set above; "Middle of the option" suits paired quotes, landing the cursor right in the middle of them. Schemes are saved in the shared repository -- editing one affects every character.</p>
            </>
          ) : null}
        </SettingCard>

        <SettingCard title="Story tail" hint="Status-bar and mini-theater schemes are saved in the shared repository, shared across every character; each character chooses its own which one to enable">
          <SchemeEditor label="Status bar scheme" schemes={repo.statusSchemes} activeId={normalized.activeStatusSchemeId!} tag="story_status" contextNote="enters context" onChange={(schemes, activeStatusSchemeId) => { patchRepo({ statusSchemes: schemes }); patchSettings({ activeStatusSchemeId }); }} />
          <SchemeEditor label="Mini theater scheme" schemes={repo.theaterSchemes} activeId={normalized.activeTheaterSchemeId!} tag="story_theater" contextNote="does not enter context by default" onChange={(schemes, activeTheaterSchemeId) => { patchRepo({ theaterSchemes: schemes }); patchSettings({ activeTheaterSchemeId }); }} />
        </SettingCard>

        <SettingCard title="Floating phone" hint="Once enabled, a floating phone bubble appears to the side of the story prose">
          <ToggleRow title="Enable the floating phone" detail="Opens a narrow phone view centered on screen, showing this character's live online chat history" checked={Boolean(normalized.floatingPhoneEnabled)} onChange={(value) => patchSettings({ floatingPhoneEnabled: value })} />
          <ToggleRow title="Bridge live chat into story context" detail="Brings the floating phone's most recent online messages into story generation" checked={Boolean(normalized.floatingPhoneInContext)} onChange={(value) => patchSettings({ floatingPhoneInContext: value })} />
        </SettingCard>

        <SettingCard title="Tags & advanced settings">
          <label className="story-settings-field"><span>Fold tags</span><input value={props.foldTags} onChange={(event) => props.onTagsChange(event.target.value, props.contextExcludedTags)} placeholder="think,thinking,story_status,story_theater" /></label>
          <label className="story-settings-field"><span>Context-excluded tags</span><input value={props.contextExcludedTags} onChange={(event) => props.onTagsChange(props.foldTags, event.target.value)} placeholder="think,thinking,story_theater" /></label>
          <button className="story-settings-row-button" type="button" onClick={() => setWallpaperOpen(true)}><span><strong>Background wallpaper</strong><small>{props.uiPrefs.wallpaper ? "Set · this character only" : "Not set"}</small></span><ChevronLeft width={17} style={{ transform: "rotate(180deg)" }} /></button>
          <button className="story-settings-row-button" type="button" onClick={props.onOpenCss}><span><strong>Page CSS style</strong><small>Open the full style editor page</small></span><ChevronLeft width={17} style={{ transform: "rotate(180deg)" }} /></button>
          <button className="story-settings-row-button" type="button" onClick={props.onRebuildCache}><span><strong>Rebuild story render cache</strong><small>Use after a scheme or tag changes</small></span><ChevronLeft width={17} style={{ transform: "rotate(180deg)" }} /></button>
        </SettingCard>
      </main>
    </div>
  );
}
