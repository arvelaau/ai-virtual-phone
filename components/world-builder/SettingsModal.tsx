"use client";

import { useEffect, useState } from "react";
import { kvGet, kvSet } from "@/lib/kv-db";

export interface SceneSettings {
  shadows: boolean;
  hdri: boolean;
  doubleSide: boolean;
  snap: boolean;
  bloom: boolean;
  /** Character avatar wandering animation (can be disabled on weak devices; at most 3 avatars active on-screen at once) */
  avatarMotion?: boolean;
  globalBrightness: number;
  globalWarmth: number;
  theme: string;
}

export const THEMES: { name: string; bg: string; light: boolean }[] = [
  { name: "Cream", bg: "radial-gradient(circle at 50% 50%, #fff 0%, #f5f0eb 50%, #e8e0d8 100%)", light: true },
  { name: "Deep Space", bg: "radial-gradient(circle at 50% 50%, #706560 0%, #4a4540 40%, #353030 100%)", light: false },
];

export function isLightTheme(theme: string): boolean {
  return THEMES.find((t) => t.bg === theme)?.light ?? false;
}

const STORAGE_KEY = "wb-settings";

const DEFAULT_SETTINGS: SceneSettings = {
  // Heavy-load options (shadows/environment reflection) are off by default so weak devices don't crash;
  // users who want better visuals can enable them in preferences.
  // Double-sided rendering stays on: it isn't a big VRAM cost, and turning it off can cause broken faces/holes on some models.
  shadows: false,
  hdri: false,
  doubleSide: true,
  snap: false,
  bloom: false,
  avatarMotion: true,
  globalBrightness: 1.0,
  globalWarmth: 0.3,
  theme: THEMES[1].bg,
};

export function useSceneSettings() {
  const [settings, setSettings] = useState<SceneSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    try {
      const stored = kvGet(STORAGE_KEY);
      if (stored) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(stored) });
    } catch {}
  }, []);

  function update(changes: Partial<SceneSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...changes };
      kvSet(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  return { settings, update };
}

interface Props {
  open: boolean;
  settings: SceneSettings;
  onUpdate: (changes: Partial<SceneSettings>) => void;
  onClose: () => void;
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="wb-setting-row">
      <span>{label}</span>
      <button
        className={`wb-setting-toggle ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
      >
        <span className="wb-setting-knob" />
      </button>
    </div>
  );
}

export default function SettingsModal({ open, settings, onUpdate, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="wb-modal-overlay" onClick={onClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb-modal-header">
          <span>Preferences</span>
          <button className="wb-float-close" onClick={onClose}>✕</button>
        </div>

        <div className="wb-modal-section">
          <label className="wb-modal-label">Theme Color</label>
          <div className="wb-theme-list">
            {THEMES.map((t) => (
              <button
                key={t.name}
                className={`wb-theme-btn ${settings.theme === t.bg ? "active" : ""}`}
                style={{ background: t.bg }}
                onClick={() => onUpdate({ theme: t.bg })}
                title={t.name}
              />
            ))}
          </div>
        </div>

        <Toggle label="Shadows" value={settings.shadows} onChange={(v) => onUpdate({ shadows: v })} />
        <Toggle label="Avatar Wandering" value={settings.avatarMotion !== false} onChange={(v) => onUpdate({ avatarMotion: v })} />
        <Toggle label="Environment Reflection" value={settings.hdri} onChange={(v) => onUpdate({ hdri: v })} />
        <Toggle label="Double-Sided Rendering" value={settings.doubleSide} onChange={(v) => onUpdate({ doubleSide: v })} />
        <Toggle label="Object Snapping" value={settings.snap} onChange={(v) => onUpdate({ snap: v })} />
        <Toggle label="Bloom Effect" value={settings.bloom} onChange={(v) => onUpdate({ bloom: v })} />

        <div className="wb-setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <span>Brightness {settings.globalBrightness.toFixed(1)}</span>
          <input type="range" className="wb-scale-slider" min={0.3} max={3} step="any"
            value={settings.globalBrightness}
            onChange={(e) => onUpdate({ globalBrightness: parseFloat(e.target.value) })}
          />
        </div>

        <div className="wb-setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <span>Color Temperature {settings.globalWarmth > 0 ? "Warm" : settings.globalWarmth < 0 ? "Cool" : "Neutral"}</span>
          <input type="range" className="wb-scale-slider" min={-1} max={1} step="any"
            value={settings.globalWarmth}
            onChange={(e) => onUpdate({ globalWarmth: parseFloat(e.target.value) })}
          />
        </div>

        <div className="wb-modal-hint" style={{ marginTop: 12 }}>
          Turning off options can improve performance
        </div>
      </div>
    </div>
  );
}
