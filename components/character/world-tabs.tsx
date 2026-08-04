"use client";

// World case-file tab strip + case editor sheet + new case sheet
// Visual metaphor: each world = a manila case file, the active tab is "the one flipped open",
// merging seamlessly with the canvas paper; in edit mode, Polaroids can be dragged onto a tab to "file" them into another world.

import { useState } from "react";
import type { CharacterWorldGroup } from "@/lib/character-world-storage";
import { DEFAULT_CHARACTER_WORLD_ID } from "@/lib/character-world-storage";

export function WorldTabStrip({
  groups,
  currentWorldId,
  memberCounts,
  dropTargetWorldId,
  onSelect,
  onOpenEditor,
  onOpenCreate,
}: {
  groups: CharacterWorldGroup[];
  currentWorldId: string;
  memberCounts: Map<string, number>;
  /** The tab currently hovered while dragging a Polaroid (highlighted as filing target) */
  dropTargetWorldId: string | null;
  onSelect: (worldId: string) => void;
  /** Tapping the currently active tab again -> opens the case editor */
  onOpenEditor: () => void;
  onOpenCreate: () => void;
}) {
  return (
    <div className="wt-strip" role="tablist" aria-label="World case files">
      {groups.map(group => {
        const active = group.id === currentWorldId;
        const dropping = group.id === dropTargetWorldId;
        return (
          <button
            key={group.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-world-tab-id={group.id}
            className={`wt-tab ${active ? "wt-tab-active" : ""} ${dropping ? "wt-tab-drop" : ""}`}
            onClick={() => (active ? onOpenEditor() : onSelect(group.id))}
            title={active ? "Tap to edit this case file" : `Open "${group.name}"`}
          >
            <span className="wt-tab-name">{group.name}</span>
            <span className="wt-tab-count">{memberCounts.get(group.id) ?? 0}</span>
            {active && <span className="wt-tab-edit" aria-hidden>✎</span>}
          </button>
        );
      })}
      <button type="button" className="wt-tab wt-tab-new" onClick={onOpenCreate} aria-label="New world">
        +
      </button>
    </div>
  );
}

/** Case file editor: rename / worldview description / delete (characters merge back into the default world) */
export function WorldCaseSheet({
  group,
  onRename,
  onUpdateDescription,
  onDelete,
  onClose,
}: {
  group: CharacterWorldGroup;
  onRename: (name: string) => void;
  onUpdateDescription: (description: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDefault = group.id === DEFAULT_CHARACTER_WORLD_ID;

  const save = () => {
    if (name.trim() && name.trim() !== group.name) onRename(name.trim());
    if (description.trim() !== group.description) onUpdateDescription(description.trim());
    onClose();
  };

  return (
    <div className="wt-modal" onClick={save}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-tape" aria-hidden />
        <div className="wt-paper-kicker">CASE FILE</div>
        <label className="wt-paper-label">Case name</label>
        <input
          className="wt-paper-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="World name"
          disabled={isDefault}
        />
        {isDefault && <p className="wt-paper-hint">The default world can't be renamed or deleted; characters return here when other worlds are deleted.</p>}
        <label className="wt-paper-label">Worldview description (injected into the context of all characters in this world)</label>
        <textarea
          className="wt-paper-textarea"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Describe this world's background, era, faction boundaries, shared knowledge, or premises for character interaction…"
        />
        <div className="wt-paper-actions">
          {!isDefault && (
            confirmDelete ? (
              <>
                <span className="wt-paper-confirm">Confirm delete? Characters will merge back into the default world</span>
                <button type="button" className="wt-btn wt-btn-danger" onClick={onDelete}>Delete</button>
                <button type="button" className="wt-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </>
            ) : (
              <button type="button" className="wt-btn wt-btn-danger" onClick={() => setConfirmDelete(true)}>Delete Case File</button>
            )
          )}
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-primary" onClick={save}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** New case file */
export function NewWorldSheet({
  onCreate,
  onClose,
}: {
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim());
  };
  return (
    <div className="wt-modal" onClick={onClose}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-tape" aria-hidden />
        <div className="wt-paper-kicker">NEW CASE</div>
        <label className="wt-paper-label">New case name</label>
        <input
          className="wt-paper-input"
          value={name}
          autoFocus
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder="e.g. Modern City / Xianxia Realm"
        />
        <div className="wt-paper-actions">
          <button type="button" className="wt-btn" onClick={onClose}>Cancel</button>
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-primary" disabled={!name.trim()} onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  );
}
