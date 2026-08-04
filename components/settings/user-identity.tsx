"use client";

import { useState, useEffect, useCallback, useContext } from "react";
import { Plus, User, Trash2, FileEdit, AlertCircle, Camera, Link, X, Check } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import { loadUserIdentities, saveUserIdentities } from "@/lib/settings-storage";
import { Input } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/modal";

export type UserIdentity = {
    id: string;
    name: string;
    avatarUrl?: string;
    bio: string;
    gender: string;
    age: string;
    occupation: string;
    customSettings: string;
};

const DEFAULT_IDENTITIES: UserIdentity[] = [
    {
        id: "identity-1",
        name: "Alex",
        bio: "An ordinary office worker who likes reading at cafes on weekends.",
        gender: "Male",
        age: "26",
        occupation: "Programmer",
        customSettings: "Mild-mannered, speaks with a touch of rational logic.",
    },
    {
        id: "identity-2",
        name: "Anonymous User",
        bio: "A mysterious passerby.",
        gender: "保密",
        age: "Unknown",
        occupation: "Freelancer",
        customSettings: "Speaks briefly, with a mysterious flair.",
    }
];

function fileToDataUrl(file: File, maxSize = 400, quality = 0.8): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/webp", quality));
            };
            img.onerror = reject;
            img.src = reader.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export function UserIdentitySettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [identities, setIdentitiesRaw] = useState<UserIdentity[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewIdentity, setIsNewIdentity] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    useEffect(() => {
        const saved = loadUserIdentities();
        if (saved.length > 0) {
            setIdentitiesRaw(saved);
        } else {
            setIdentitiesRaw(DEFAULT_IDENTITIES);
            saveUserIdentities(DEFAULT_IDENTITIES);
        }
    }, []);

    const setIdentities = useCallback((next: UserIdentity[]) => {
        setIdentitiesRaw(next);
        saveUserIdentities(next);
    }, []);

    const addIdentity = useCallback(() => {
        const newIdentity: UserIdentity = {
            id: `identity-${Date.now()}`,
            name: "New Identity",
            bio: "",
            gender: "保密",
            age: "",
            occupation: "",
            customSettings: "",
        };
        const next = [newIdentity, ...identities];
        setIdentities(next);
        setIsNewIdentity(true);
        setEditingId(newIdentity.id);
    }, [identities, setIdentities]);

    useEffect(() => {
        setSubpageRightAction("identity",
            <button
                onClick={addIdentity}
                className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
            >
                <Plus size={15} strokeWidth={1.8} />
                <span>New Identity</span>
            </button>
        );
        return () => setSubpageRightAction("identity", null);
    }, [addIdentity, setSubpageRightAction]);

    const updateIdentity = (id: string, updates: Partial<UserIdentity>) => {
        setIdentities(identities.map(i => i.id === id ? { ...i, ...updates } : i));
    };

    const removeIdentity = (id: string) => {
        const next = identities.filter(i => i.id !== id);
        setIdentities(next);
        if (editingId === id) {
            setEditingId(null);
            setIsNewIdentity(false);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">User Identity</h2>
            </div>

            {identities.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <User size={24} />
                    </div>
                    <span className="menu-label font-semibold">No identity cards yet</span>
                    <span className="menu-desc max-w-[240px]">
                        Manage your personal identity info here so the AI can get to know you better.
                    </span>
                    <button onClick={addIdentity} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> Add Identity
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {identities.map(identity => (
                        <div
                            key={identity.id}
                            className="ui-config-card min-w-0 cursor-pointer overflow-hidden"
                            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                            role="button"
                            tabIndex={0}
                            aria-label={`Edit ${identity.name || "Identity"}`}
                            onClick={() => setEditingId(identity.id)}
                            onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setEditingId(identity.id);
                                }
                            }}
                        >
                            <div className="min-w-0 flex flex-col gap-1">
                                <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{identity.name || "Unnamed Identity"}</span>
                                <span className="menu-desc truncate">{identity.occupation || identity.bio || identity.gender || "No identity info filled in"}</span>
                            </div>
                            <div className="flex items-end justify-between gap-2">
                                {identity.avatarUrl ? (
                                    <img src={identity.avatarUrl} alt={identity.name} className="h-9 w-9 rounded-full object-cover shrink-0" />
                                ) : (
                                    <div className="h-9 w-9 rounded-full bg-[var(--c-page-body-bg)] text-[var(--c-icon)] grid place-items-center shrink-0">
                                        <User size={18} />
                                    </div>
                                )}

                                <div className="flex gap-2 shrink-0 items-center">
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setEditingId(identity.id);
                                        }}
                                        className="ui-link-btn"
                                    >
                                        <FileEdit size={18} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setConfirmDeleteId(identity.id);
                                        }}
                                        className="ui-link-btn"
                                        data-variant="danger"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={() => { if (isNewIdentity && editingId) removeIdentity(editingId); setIsNewIdentity(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewIdentity ? "Add Identity" : "Edit Identity"}</span>
                            <button onClick={() => { setIsNewIdentity(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                            {(() => {
                                const identity = identities.find(c => c.id === editingId);
                                if (!identity) return null;
                                return (
                                    <>
                                        {/* Avatar upload + URL */}
                                        <div className="flex flex-col items-center gap-2">
                                            <div
                                                onClick={() => {
                                                    const input = document.createElement("input");
                                                    input.type = "file";
                                                    input.accept = "image/*";
                                                    input.onchange = async () => {
                                                        const file = input.files?.[0];
                                                        if (!file) return;
                                                        try {
                                                            const dataUrl = await fileToDataUrl(file);
                                                            updateIdentity(identity.id, { avatarUrl: dataUrl });
                                                        } catch { /* ignore */ }
                                                    };
                                                    input.click();
                                                }}
                                                className="ui-avatar-upload"
                                            >
                                                {identity.avatarUrl ? (
                                                    <>
                                                        <img src={identity.avatarUrl} alt="" className="w-full h-full object-cover" />
                                                        <div className="absolute bottom-0 left-0 right-0 flex justify-center ui-avatar-upload-overlay">
                                                            <Camera size={14} color="#fff" />
                                                        </div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <User size={28} className="text-[var(--c-icon-active)]" />
                                                        <span className="ts-10 mt-[2px] text-[var(--c-icon-active)]">Tap to upload</span>
                                                    </>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-[6px] w-full max-w-[280px]">
                                                <Link size={14} className="shrink-0 text-[var(--c-text)]" />
                                                <Input
                                                    type="text"
                                                    value={identity.avatarUrl?.startsWith("data:") ? "" : (identity.avatarUrl || "")}
                                                    onChange={(e) => updateIdentity(identity.id, { avatarUrl: e.target.value })}
                                                    placeholder="Or paste an image URL..."
                                                    className="flex-1 ts-12 px-[10px] py-[6px]"
                                                />
                                            </div>
                                        </div>

                                        <div className="flex gap-3">
                                            <div className="flex flex-col gap-1 flex-1 min-w-0">
                                                <label className="menu-desc ml-1">Name</label>
                                                <Input
                                                    type="text"
                                                    value={identity.name}
                                                    onChange={(e) => updateIdentity(identity.id, { name: e.target.value })}
                                                    placeholder="What would you like the AI to call you..."
                                                    className="font-medium"
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1 w-[90px] shrink-0">
                                                <label className="menu-desc ml-1">Gender</label>
                                                <select
                                                    value={identity.gender}
                                                    onChange={(e) => updateIdentity(identity.id, { gender: e.target.value })}
                                                    className="ui-select"
                                                >
                                                    {/* "保密" (undisclosed) must stay in this exact Chinese string -- lib/llm-prompt-assembler.ts,
                                                        lib/calendar-engine.ts, and lib/custom-app-host-api.ts compare identity.gender !== "保密"
                                                        to decide whether to include gender in AI prompts. */}
                                                    <option value="保密">Prefer not to say</option>
                                                    <option value="Male">Male</option>
                                                    <option value="Female">Female</option>
                                                    <option value="Other">Other</option>
                                                </select>
                                            </div>
                                        </div>

                                        <div className="flex gap-3">
                                            <div className="flex flex-col gap-1 flex-1 min-w-0">
                                                <label className="menu-desc ml-1">Age</label>
                                                <input
                                                    type="text"
                                                    value={identity.age}
                                                    onChange={(e) => updateIdentity(identity.id, { age: e.target.value })}
                                                    placeholder="e.g. 24, Unknown"
                                                    className="ui-input"
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1 flex-1 min-w-0">
                                                <label className="menu-desc ml-1">Occupation</label>
                                                <input
                                                    type="text"
                                                    value={identity.occupation}
                                                    onChange={(e) => updateIdentity(identity.id, { occupation: e.target.value })}
                                                    placeholder="e.g. Student, Freelancer"
                                                    className="ui-input"
                                                />
                                            </div>
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">Bio</label>
                                            <textarea
                                                value={identity.bio}
                                                onChange={(e) => updateIdentity(identity.id, { bio: e.target.value })}
                                                placeholder="Briefly describe yourself; this will be the AI's basic background info about you..."
                                                rows={3}
                                                className="ui-textarea"
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">Custom Settings</label>
                                            <textarea
                                                value={identity.customSettings}
                                                onChange={(e) => updateIdentity(identity.id, { customSettings: e.target.value })}
                                                placeholder="Deeper personality/interests, special conversation requirements, etc..."
                                                rows={4}
                                                className="ui-textarea"
                                            />
                                        </div>
                                    </>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="Confirm deletion?"
                    message="Deleting an identity card cannot be undone. Continue?"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="Confirm delete"
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        removeIdentity(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
