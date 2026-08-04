"use client";

import { useState, useRef } from "react";
import { saveModel } from "./model-db";

interface Props {
  open: boolean;
  categories: string[];
  onClose: () => void;
  onModelAdded: () => void;
}

export default function ImportModal({ open, categories, onClose, onModelAdded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [modelName, setModelName] = useState("");
  const [category, setCategory] = useState("Import");
  const [customCat, setCustomCat] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleImport() {
    if (!file) return;
    const cat = customCat.trim() || category;
    const blob = new Blob([await file.arrayBuffer()], { type: "model/gltf-binary" });
    await saveModel({ name: modelName || file.name.replace(/\.\w+$/, ""), category: cat, blob });
    onModelAdded();
    reset();
  }

  function reset() {
    setFile(null);
    setModelName("");
    setCategory("Import");
    setCustomCat("");
    onClose();
  }

  if (!open) return null;

  return (
    <div className="wb-modal-overlay" onClick={reset}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb-modal-header">
          <span>Import Model</span>
          <button className="wb-float-close" onClick={reset}>✕</button>
        </div>

        <div className="wb-modal-section">
          <input
            ref={fileRef}
            type="file"
            accept=".glb,.gltf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFile(f);
                setModelName(f.name.replace(/\.\w+$/, ""));
              }
            }}
          />
          <button className="wb-modal-btn" onClick={() => fileRef.current?.click()}>
            {file ? file.name : "Choose GLB / GLTF file"}
          </button>
        </div>

        {file && (
          <>
            <div className="wb-modal-section">
              <label className="wb-modal-label">Model Name</label>
              <input
                className="wb-modal-input"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
              />
            </div>

            <div className="wb-modal-section">
              <label className="wb-modal-label">Category</label>
              <div className="wb-modal-cat-list">
                {[...categories, "Custom"].map((c) => (
                  <button
                    key={c}
                    className={`wb-modal-cat ${category === c ? "active" : ""}`}
                    onClick={() => { setCategory(c); if (c !== "Custom") setCustomCat(""); }}
                  >{c}</button>
                ))}
              </div>
              {category === "Custom" && (
                <input
                  className="wb-modal-input"
                  placeholder="Enter new category name"
                  value={customCat}
                  onChange={(e) => setCustomCat(e.target.value)}
                  style={{ marginTop: 6 }}
                />
              )}
            </div>

            <div className="wb-modal-actions">
              <button className="wb-modal-btn wb-modal-primary" onClick={handleImport}>Add to Library</button>
              <button className="wb-modal-btn" onClick={reset}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
