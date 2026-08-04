"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Palette, Trash2, Type } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import { ColorInput, Select, Slider } from "@/components/ui/form";
import type { ReadingAppearance } from "@/lib/reading-appearance";
import { READING_FONT_OPTIONS } from "@/lib/reading-appearance";

type Props = {
    appearance: ReadingAppearance;
    backgroundUrl: string | null;
    onClose: () => void;
    onSave: (
        appearance: ReadingAppearance,
        options: { backgroundFile: File | null; clearBackground: boolean; customFontFile: File | null; clearCustomFont: boolean }
    ) => Promise<void>;
};

export function ReadingAppearanceDialog({ appearance, backgroundUrl, onClose, onSave }: Props) {
    const [draft, setDraft] = useState<ReadingAppearance>(appearance);
    const [backgroundFile, setBackgroundFile] = useState<File | null>(null);
    const [customFontFile, setCustomFontFile] = useState<File | null>(null);
    const [clearBackground, setClearBackground] = useState(false);
    const [clearCustomFont, setClearCustomFont] = useState(false);
    const [saving, setSaving] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(backgroundUrl);
    const fileRef = useRef<HTMLInputElement>(null);
    const fontFileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setDraft(appearance);
        setBackgroundFile(null);
        setCustomFontFile(null);
        setClearBackground(false);
        setClearCustomFont(false);
        setPreviewUrl(backgroundUrl);
    }, [appearance, backgroundUrl]);

    useEffect(() => {
        if (!backgroundFile) return;
        const url = URL.createObjectURL(backgroundFile);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [backgroundFile]);

    const hasPreview = useMemo(() => Boolean(previewUrl) && !clearBackground, [previewUrl, clearBackground]);

    const handleSave = async () => {
        try {
            setSaving(true);
            await onSave(draft, { backgroundFile, clearBackground, customFontFile, clearCustomFont });
            onClose();
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to save reading appearance");
        } finally {
            setSaving(false);
        }
    };

    return (
        <ContentDialog
            title="Reading Appearance"
            confirmLabel={saving ? "Saving..." : "Save"}
            cancelLabel="Cancel"
            onConfirm={() => { if (!saving) void handleSave(); }}
            onCancel={() => { if (!saving) onClose(); }}
        >
            <div className="reading-settings-grid">
                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Type size={15} />
                        <span>Body Text Style</span>
                    </div>
                    <label className="reading-settings-label">
                        <span>Font</span>
                        <Select
                            value={draft.fontFamily}
                            onChange={(e) => setDraft((prev) => ({ ...prev, fontFamily: e.target.value as ReadingAppearance["fontFamily"] }))}
                        >
                            {READING_FONT_OPTIONS.map((option) => (
                                option.id === "custom" && !draft.customFontName ? null :
                                <option key={option.id} value={option.id}>{option.label}</option>
                            ))}
                        </Select>
                    </label>
                    <div className="reading-settings-inline-note">
                        <span>Custom Font</span>
                        <span>{draft.customFontName ? `Selected . ${draft.customFontName}` : "Not uploaded"}</span>
                    </div>
                    <div className="reading-settings-actions">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => fontFileRef.current?.click()}
                            disabled={saving}
                        >
                            <Type size={14} />
                            <span>{draft.customFontName ? "Change Font" : "Upload Font"}</span>
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            onClick={() => {
                                setCustomFontFile(null);
                                setClearCustomFont(true);
                                setDraft((prev) => ({
                                    ...prev,
                                    customFontName: undefined,
                                    fontFamily: prev.fontFamily === "custom" ? "system" : prev.fontFamily,
                                }));
                            }}
                            disabled={saving || !draft.customFontName}
                        >
                            <Trash2 size={14} />
                            <span>Clear</span>
                        </button>
                    </div>
                    <input
                        ref={fontFileRef}
                        type="file"
                        accept=".ttf,.otf,.woff,.woff2"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            e.target.value = "";
                            if (!file) return;
                            setCustomFontFile(file);
                            setClearCustomFont(false);
                            setDraft((prev) => ({
                                ...prev,
                                fontFamily: "custom",
                                customFontName: file.name,
                            }));
                        }}
                    />
                    <Slider
                        label="Font Size"
                        min={14}
                        max={28}
                        step={1}
                        value={draft.fontSize}
                        onChange={(e) => setDraft((prev) => ({ ...prev, fontSize: Number(e.target.value) }))}
                        displayValue={`${draft.fontSize}px`}
                    />
                    <Slider
                        label="Line Height"
                        min={1.4}
                        max={2.4}
                        step={0.1}
                        value={draft.lineHeight}
                        onChange={(e) => setDraft((prev) => ({ ...prev, lineHeight: Number(e.target.value) }))}
                        displayValue={draft.lineHeight.toFixed(1)}
                    />
                    <div className="reading-settings-color-row">
                        <span className="reading-settings-label-inline">Text Color</span>
                        <ColorInput value={draft.textColor} onChange={(textColor) => setDraft((prev) => ({ ...prev, textColor }))} />
                    </div>
                </section>

                <section className="reading-settings-group">
                    <div className="reading-settings-heading">
                        <Palette size={15} />
                        <span>Fullscreen Background</span>
                    </div>
                    <div
                        className="reading-bg-preview"
                        style={hasPreview ? { backgroundImage: `url("${previewUrl}")` } : undefined}
                    >
                        {!hasPreview && <span>Shared background for the shelf and reading pages</span>}
                    </div>
                    <div className="reading-settings-actions">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => fileRef.current?.click()}
                            disabled={saving}
                        >
                            <ImagePlus size={14} />
                            <span>{hasPreview ? "Change Background" : "Choose Background"}</span>
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            onClick={() => {
                                setBackgroundFile(null);
                                setClearBackground(true);
                                setPreviewUrl(null);
                            }}
                            disabled={saving || (!hasPreview && !backgroundFile)}
                        >
                            <Trash2 size={14} />
                            <span>Clear</span>
                        </button>
                    </div>
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            e.target.value = "";
                            if (!file) return;
                            setBackgroundFile(file);
                            setClearBackground(false);
                        }}
                    />
                </section>
            </div>
        </ContentDialog>
    );
}
