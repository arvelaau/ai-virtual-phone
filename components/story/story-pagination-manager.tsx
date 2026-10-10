"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/primitives";
import type { Character } from "@/lib/character-types";
import type { StoryGroup, StorySession } from "@/lib/story-storage";
import { fileToUserAvatarDataUrl } from "@/lib/user-avatar-image";

export type StoryBranchCreateInput = {
  name: string;
  inheritRecentMemory: boolean;
  independentStory: boolean;
};

type StoryPaginationManagerProps = {
  characters: Character[];
  activeCharacterId: string;
  activeGroupId: string;
  groups: StoryGroup[];
  sessions: StorySession[];
  activeSessionId: string;
  userName: string;
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
};

function AvatarCollage({ characters, large = false, customAvatar }: { characters: Character[]; large?: boolean; customAvatar?: string }) {
  if (customAvatar) {
    return <span className={`story-custom-avatar${large ? " is-large" : ""}`}><img src={customAvatar} alt="Story avatar" /></span>;
  }
  const visible = characters.slice(0, 4);
  if (visible.length <= 1) {
    const character = visible[0];
    return <Avatar src={character?.avatar || undefined} name={character?.name || "Story"} size="lg" />;
  }
  return (
    <div className={`story-group-avatar-grid${large ? " is-large" : ""}`} data-count={Math.min(visible.length, 4)}>
      {visible.map((character) => (
        <span key={character.id}><Avatar src={character.avatar || undefined} name={character.name} size={large ? "lg" : "sm"} /></span>
      ))}
    </div>
  );
}

export function StoryPaginationManager(props: StoryPaginationManagerProps) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [inheritRecentMemory, setInheritRecentMemory] = useState(false);
  const [independentStory, setIndependentStory] = useState(false);
  const [deleteSelection, setDeleteSelection] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const storyAvatarInputRef = useRef<HTMLInputElement>(null);

  const activeGroup = props.groups.find((group) => group.id === props.activeGroupId) || null;
  const activeOwnerCharacters = useMemo(() => {
    const ids = activeGroup?.characterIds || [props.activeCharacterId];
    return ids.map((id) => props.characters.find((character) => character.id === id)).filter((item): item is Character => Boolean(item));
  }, [activeGroup, props.activeCharacterId, props.characters]);
  const mainSession = props.sessions.find((session) => (session.branchId || "main") === "main") || props.sessions[0] || null;
  const activeSession = props.sessions.find((session) => session.id === props.activeSessionId) || mainSession;
  const title = activeGroup?.name || activeOwnerCharacters[0]?.name || "Story";
  const pairText = activeGroup
    ? `${activeOwnerCharacters.map((character) => character.name).join(" x ")} x ${props.userName}`
    : `${activeOwnerCharacters[0]?.name || "char"} x ${props.userName}`;
  const tags = mainSession?.catalogTags || [];

  useEffect(() => {
    setDeleteSelection((current) => current.filter((id) => props.sessions.some((session) => session.id === id && (session.branchId || "main") !== "main")));
  }, [props.sessions]);

  const openGroupModal = () => {
    setSelectedCharacterIds([]);
    setGroupName("");
    setGroupModalOpen(true);
  };

  const createGroup = () => {
    if (selectedCharacterIds.length < 2) return;
    const fallbackName = selectedCharacterIds
      .map((id) => props.characters.find((character) => character.id === id)?.name)
      .filter(Boolean)
      .join(", ");
    props.onGroupCreate(selectedCharacterIds, groupName.trim() || fallbackName || "Multiplayer Story");
    setGroupModalOpen(false);
  };

  const createBranch = () => {
    const name = branchName.trim();
    if (!name) return;
    props.onBranchCreate({
      name,
      inheritRecentMemory: independentStory ? false : inheritRecentMemory,
      independentStory,
    });
    setBranchName("");
    setInheritRecentMemory(false);
    setIndependentStory(false);
    setBranchModalOpen(false);
  };

  const addTag = () => {
    const tag = tagDraft.trim();
    if (!tag || !mainSession) return;
    props.onSessionUpdate(mainSession.id, { catalogTags: Array.from(new Set([...tags, tag])) });
    setTagDraft("");
  };

  const changeStoryAvatar = async (file?: File) => {
    if (!file || !mainSession) return;
    try {
      const avatar = await fileToUserAvatarDataUrl(file);
      props.onSessionUpdate(mainSession.id, { storyAvatar: avatar });
    } catch {
      window.alert("Couldn't process that story avatar -- try a different image.");
    }
  };

  return (
    <>
      <section className="story-settings-card">
        <div className="story-settings-card-head">
          <div><h2>Choose who to meet</h2><p>Tap a character to jump to where you last left off with them</p></div>
        </div>
        <div className="story-meeting-characters">
          {props.characters.map((character) => (
            <button
              key={character.id}
              type="button"
              data-active={!props.activeGroupId && character.id === props.activeCharacterId ? "true" : undefined}
              onClick={() => props.onCharacterChange(character.id)}
            >
              <Avatar src={character.avatar || undefined} name={character.name} size="lg" />
              <span>{character.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="story-settings-card">
        <button type="button" className="story-group-heading" onClick={openGroupModal}>
          <span><strong>Choose a multiplayer meeting</strong><small>Select multiple characters to start an independent multiplayer story with its own branches</small></span>
          <ChevronRight width={17} />
        </button>
        {props.groups.length ? (
          <div className="story-group-list">
            {props.groups.map((group) => {
              const members = group.characterIds
                .map((id) => props.characters.find((character) => character.id === id))
                .filter((item): item is Character => Boolean(item));
              return (
                <div key={group.id} className="story-group-card" data-active={group.id === props.activeGroupId ? "true" : undefined}>
                  <button type="button" className="story-group-select" onClick={() => props.onGroupSelect(group.id)}>
                    <AvatarCollage characters={members} />
                    <span><strong>{group.name}</strong><small>{members.map((item) => item.name).join(", ")}</small></span>
                  </button>
                  <div className="story-group-card-actions">
                    <button type="button" onClick={() => {
                      const next = window.prompt("Rename this meeting", group.name)?.trim();
                      if (next) props.onGroupRename(group.id, next);
                    }}>Rename</button>
                    <button type="button" aria-label={`Delete ${group.name}`} onClick={() => {
                      if (window.confirm(`Delete "${group.name}" and all of its story branches? This cannot be undone.`)) props.onGroupDelete(group.id);
                    }}><Trash2 width={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="story-settings-card story-owner-avatar-card">
        <div className="story-owner-avatar-preview">
          <AvatarCollage characters={activeOwnerCharacters} customAvatar={mainSession?.storyAvatar} />
        </div>
        <button type="button" className="story-owner-avatar-pick" onClick={() => storyAvatarInputRef.current?.click()}>
          <span><strong>Set a dedicated avatar for this {activeGroup ? "meeting" : "character"}</strong><small>Pick a photo; it's used only for this story</small></span>
          <ChevronRight width={17} />
        </button>
        {mainSession?.storyAvatar ? <button type="button" className="story-owner-avatar-reset" onClick={() => props.onSessionUpdate(mainSession.id, { storyAvatar: undefined })}>Reset to default</button> : null}
        <input ref={storyAvatarInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => {
          void changeStoryAvatar(event.target.files?.[0]);
          event.target.value = "";
        }} />
      </section>

      <section className="story-settings-card">
        <div className="story-settings-card-head">
          <div><h2>Story branch settings</h2><p>The main branch is always the first chapter; each branch keeps its own message progress</p></div>
        </div>
        <div className="story-pagination-summary">
          <button
            type="button"
            data-active={(activeSession?.branchId || "main") === "main" ? "true" : undefined}
            onClick={() => mainSession && props.onSessionSelect(mainSession.id)}
          >
            <span><strong>Main story</strong><small>Default &middot; cannot be deleted</small></span>
            <ChevronRight width={16} />
          </button>
          <button type="button" onClick={() => setCatalogOpen(true)}>
            <span><strong>Story branches</strong><small>{Math.max(0, props.sessions.length - 1)} branches &middot; open the catalog</small></span>
            <ChevronRight width={16} />
          </button>
        </div>
      </section>

      {catalogOpen ? (
        <div className="story-catalog-overlay">
          <header className="story-settings-header">
            <button type="button" onClick={() => setCatalogOpen(false)} aria-label="Back to story settings"><ChevronLeft width={19} /></button>
            <strong>Story catalog</strong>
            <button type="button" onClick={() => setCatalogOpen(false)} aria-label="Close catalog"><X width={17} /></button>
          </header>
          <main className="story-catalog-scroll">
            <section className="story-book-hero">
              <div className="story-book-cover"><AvatarCollage characters={activeOwnerCharacters} large customAvatar={mainSession?.storyAvatar} /></div>
              <div className="story-book-meta">
                <h1>{title}</h1>
                <p>{props.sessions.length} chapter{props.sessions.length === 1 ? "" : "s"} total</p>
                <p>{pairText}</p>
                <div className="story-book-tags">
                  {tags.map((tag) => (
                    <button key={tag} type="button" onClick={() => mainSession && props.onSessionUpdate(mainSession.id, { catalogTags: tags.filter((item) => item !== tag) })}>
                      {tag}<X width={10} />
                    </button>
                  ))}
                  <label><input value={tagDraft} maxLength={12} placeholder="Add a tag" onChange={(event) => setTagDraft(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); addTag(); }
                  }} /><Plus width={12} /></label>
                </div>
              </div>
            </section>

            <section className="story-directory">
              <div className="story-directory-head">
                <h2>Catalog</h2>
                <div>
                  <button type="button" onClick={props.onExportAll}><Download width={14} />Export all</button>
                  <button type="button" onClick={() => setBranchModalOpen(true)}><Plus width={14} />Add branch</button>
                  <button
                    type="button"
                    disabled={!deleteSelection.length}
                    onClick={() => {
                      if (!deleteSelection.length) return;
                      if (window.confirm(`Delete the selected ${deleteSelection.length} branch${deleteSelection.length === 1 ? "" : "es"}? Their messages will be deleted too.`)) {
                        props.onBranchDelete(deleteSelection);
                        setDeleteSelection([]);
                      }
                    }}
                  ><Trash2 width={14} />Delete</button>
                </div>
              </div>
              <div className="story-directory-list">
                {props.sessions.map((session, index) => {
                  const isMain = (session.branchId || "main") === "main";
                  const isSelected = deleteSelection.includes(session.id);
                  return (
                    <div key={session.id} className="story-directory-row" data-active={session.id === props.activeSessionId ? "true" : undefined}>
                      <label className="story-directory-check">
                        <input
                          type="checkbox"
                          disabled={isMain}
                          checked={!isMain && isSelected}
                          onChange={(event) => setDeleteSelection((current) => event.target.checked ? [...current, session.id] : current.filter((id) => id !== session.id))}
                        />
                      </label>
                      <div className="story-directory-open" role="button" tabIndex={0} onClick={() => {
                        props.onSessionSelect(session.id);
                        setCatalogOpen(false);
                      }} onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          props.onSessionSelect(session.id);
                          setCatalogOpen(false);
                        }
                      }}>
                        <span className="story-directory-number">Chapter {index + 1}</span>
                        <span>
                          {isMain ? <strong>Main story</strong> : (
                            <input
                              value={session.branchName || "Story Branch"}
                              aria-label="Branch name"
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                              onChange={(event) => props.onSessionUpdate(session.id, { branchName: event.target.value })}
                            />
                          )}
                          <small>
                            {isMain ? "Default main branch · cannot rename or delete" : [
                              session.independentStory ? "Independent story" : "Character memory",
                              session.inheritRecentMemory ? "Inherited recent memory" : "Starts from creation",
                            ].join(" · ")}
                          </small>
                          <small className="story-directory-date">Last chat: {session.lastMessageAt || session.lastMessageId ? new Date(session.lastMessageAt || session.updatedAt).toLocaleString() : "No messages yet"}</small>
                        </span>
                      </div>
                      <div className="story-directory-actions">
                        {!isMain && session.independentStory && !session.includedInMemoryAt ? (
                          <button type="button" className="story-branch-memory" onClick={() => {
                            if (window.confirm("End this independent story and fold its summary into the character's memory?")) {
                              const now = new Date().toISOString();
                              props.onSessionUpdate(session.id, { endedAt: now, includedInMemoryAt: now });
                            }
                          }}>End &amp; add to memory</button>
                        ) : null}
                        <button type="button" className="story-branch-export" aria-label={`Export ${session.branchName || "story"}`} onClick={() => props.onExportSession(session.id)}><Download width={14} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </main>
        </div>
      ) : null}

      {groupModalOpen ? (
        <div className="story-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setGroupModalOpen(false);
        }}>
          <section className="story-dialog" role="dialog" aria-modal="true" aria-label="Choose a multiplayer meeting">
            <header><strong>Choose a multiplayer meeting</strong><button type="button" onClick={() => setGroupModalOpen(false)}><X width={16} /></button></header>
            <label className="story-settings-field"><span>Meeting name</span><input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="e.g. Weekend Crew" /></label>
            <div className="story-group-picker">
              {props.characters.map((character) => {
                const checked = selectedCharacterIds.includes(character.id);
                return (
                  <label key={character.id} data-selected={checked ? "true" : undefined}>
                    <input type="checkbox" checked={checked} onChange={(event) => setSelectedCharacterIds((current) => event.target.checked ? [...current, character.id] : current.filter((id) => id !== character.id))} />
                    <Avatar src={character.avatar || undefined} name={character.name} size="md" />
                    <span>{character.name}</span>
                  </label>
                );
              })}
            </div>
            <p className="story-settings-note">Select at least two characters. A meeting keeps its own main story, branches, and messages, separate from any 1:1 story.</p>
            <footer><button type="button" onClick={() => setGroupModalOpen(false)}>Cancel</button><button type="button" className="story-settings-primary" disabled={selectedCharacterIds.length < 2} onClick={createGroup}>Create meeting</button></footer>
          </section>
        </div>
      ) : null}

      {branchModalOpen ? (
        <div className="story-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setBranchModalOpen(false);
        }}>
          <section className="story-dialog" role="dialog" aria-modal="true" aria-label="Add branch">
            <header><strong>Add branch</strong><button type="button" onClick={() => setBranchModalOpen(false)}><X width={16} /></button></header>
            <label className="story-settings-field"><span>Branch name</span><input autoFocus value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="e.g. After the Storm" /></label>
            <label className="story-settings-toggle-row">
              <span><strong>Inherit recent memory</strong><small>Carries over short-term memory from before this branch was created; irreversible once chosen</small></span>
              <input type="checkbox" checked={inheritRecentMemory} disabled={independentStory} onChange={(event) => setInheritRecentMemory(event.target.checked)} />
            </label>
            <label className="story-settings-toggle-row">
              <span><strong>Independent story</strong><small>Off by default; when on, this branch draws on no character memory, and can be manually folded back in when it ends</small></span>
              <input type="checkbox" checked={independentStory} onChange={(event) => {
                setIndependentStory(event.target.checked);
                if (event.target.checked) setInheritRecentMemory(false);
              }} />
            </label>
            <footer><button type="button" onClick={() => setBranchModalOpen(false)}>Cancel</button><button type="button" className="story-settings-primary" disabled={!branchName.trim()} onClick={createBranch}>Create branch</button></footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
