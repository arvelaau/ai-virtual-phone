"use client";

import { useState, useEffect } from "react";
import { saveScene, loadScene, getAllScenes, deleteScene, type SavedScene } from "./scene-db";
import type { SceneObject } from "./scene-store";

interface Props {
  open: boolean;
  mode: "save" | "load";
  currentObjects: SceneObject[];
  onLoad: (objects: SceneObject[]) => void;
  onClose: () => void;
}

export default function SceneSaveLoadModal({ open, mode, currentObjects, onLoad, onClose }: Props) {
  const [scenes, setScenes] = useState<SavedScene[]>([]);
  const [saveName, setSaveName] = useState("");

  useEffect(() => {
    if (open) {
      getAllScenes()
        .then((s) => setScenes(s.sort((a, b) => b.updatedAt - a.updatedAt)))
        .catch((error) => {
          console.warn("Failed to load world builder scenes", error);
          setScenes([]);
        });
    }
  }, [open]);

  async function handleSave() {
    if (!saveName.trim()) return;
    await saveScene(saveName.trim(), currentObjects);
    onClose();
  }

  async function handleOverwrite(scene: SavedScene) {
    await saveScene(scene.name, currentObjects, scene.id);
    onClose();
  }

  async function handleLoad(scene: SavedScene) {
    const result = await loadScene(scene.id);
    if (result) {
      onLoad(result.objects);
    }
    onClose();
  }

  async function handleDelete(id: string) {
    await deleteScene(id);
    setScenes((prev) => prev.filter((s) => s.id !== id));
  }

  if (!open) return null;

  return (
    <div className="wb-modal-overlay" onClick={onClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb-modal-header">
          <span>{mode === "save" ? "Save Scene" : "Load Scene"}</span>
          <button className="wb-float-close" onClick={onClose}>✕</button>
        </div>

        {mode === "save" && (
          <div className="wb-modal-section">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="wb-modal-input"
                style={{ flex: 1 }}
                placeholder="Enter scene name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
              />
              <button
                className="wb-modal-btn wb-modal-primary"
                style={{ width: "auto", padding: "8px 16px" }}
                onClick={handleSave}
                disabled={!saveName.trim()}
              >
                Save
              </button>
            </div>
          </div>
        )}

        {scenes.length > 0 && (
          <div className="wb-modal-section">
            <label className="wb-modal-label">
              {mode === "save" ? "Overwrite existing save" : "Select a save"}
            </label>
            <div className="wb-scene-list">
              {scenes.map((s) => (
                <div key={s.id} className="wb-scene-item">
                  <div className="wb-scene-info">
                    <span className="wb-scene-name">{s.name}</span>
                    <span className="wb-scene-meta">
                      {s.objects.length} objects · {new Date(s.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="wb-scene-actions">
                    {mode === "save" ? (
                      <button className="wb-scene-btn" onClick={() => handleOverwrite(s)}>Overwrite</button>
                    ) : (
                      <button className="wb-scene-btn wb-scene-btn-primary" onClick={() => handleLoad(s)}>Load</button>
                    )}
                    <button className="wb-scene-btn wb-scene-btn-danger" onClick={() => handleDelete(s.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {scenes.length === 0 && mode === "load" && (
          <div className="wb-modal-hint" style={{ textAlign: "center", padding: 20 }}>
No saves yet
          </div>
        )}
      </div>
    </div>
  );
}
