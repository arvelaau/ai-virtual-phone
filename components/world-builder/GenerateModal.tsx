"use client";

import { useState, useRef, useEffect } from "react";
import { saveModel } from "./model-db";
import { optimizeModelBlob } from "./model-optimize";
import { kvGet, kvSet } from "@/lib/kv-db";
import type { Character } from "@/lib/character-types";

interface Props {
  open: boolean;
  categories: string[];
  /** Character library (used by Character Avatar mode) */
  characters?: Character[];
  onClose: () => void;
  onModelAdded: () => void;
}

const API_KEY_STORAGE = "wb-tripo-api-key";

export default function GenerateModal({ open, categories, characters = [], onClose, onModelAdded }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"" | "checking" | "ok" | "fail">("");
  const [mode, setMode] = useState<"text" | "image" | "avatar">("text");
  // Character Avatar mode: selected character + image source (character avatar / uploaded artwork)
  const [avatarCharacterId, setAvatarCharacterId] = useState("");
  const [avatarSource, setAvatarSource] = useState<"avatar" | "upload">("upload");
  // Auto rig + walk animation after generation (extra quota cost; lets the avatar walk around the scene)
  const [animateAvatar, setAnimateAvatar] = useState(true);
  const avatarCharacter = characters.find((c) => c.id === avatarCharacterId) ?? null;
  const [prompt, setPrompt] = useState("");
  const [faceLimit, setFaceLimit] = useState<number>(0);
  const [simplifyRatio, setSimplifyRatio] = useState<number>(15); // stored as an integer percentage to avoid floating-point issues
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "failed">("idle");
  const [progress, setProgress] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [modelName, setModelName] = useState("");
  const [category, setCategory] = useState("Import");
  const [customCat, setCustomCat] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = kvGet(API_KEY_STORAGE);
    if (stored) setApiKey(stored);
  }, []);

  function saveApiKey(key: string) {
    setApiKey(key);
    setKeyStatus("");
    kvSet(API_KEY_STORAGE, key);
  }

  async function verifyApiKey() {
    if (!apiKey.trim()) return;
    setKeyStatus("checking");
    try {
      const res = await fetch("/api/tripo/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      setKeyStatus(data.ok ? "ok" : "fail");
      if (data.ok && data.balance != null) {
        setProgress(`Balance: ${data.balance}`);
      }
    } catch {
      setKeyStatus("fail");
    }
  }

  const STATUS_TEXT: Record<string, string> = {
    queued: "Queued", running: "Generating", success: "Done", failed: "Failed", pending: "Pending",
  };

  /** Poll task status (8s interval to save function calls; pauses when the tab is backgrounded). Returns the result on success (including the direct Tripo model URL), throws on failure. */
  async function pollTaskStatus(taskId: string, stageLabel: string): Promise<{ modelUrl?: string }> {
    let consecutiveErrors = 0;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 8000));
      if (typeof document !== "undefined" && document.hidden) { i--; continue; }
      const res = await fetch(`/api/tripo/status/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      if (data.status === "success") return data;
      if (data.status === "failed" || data.status === "cancelled" || data.status === "banned" || data.status === "expired") {
        throw new Error(data.error || `${stageLabel} failed (${data.status})`);
      }
      // Missing status / query error: don't fake "pending" forever — report the real reason after 3 consecutive misses
      // (a just-created task may have a few seconds of query lag, so give it some grace)
      if (!data.status) {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          throw new Error(`${stageLabel} status query failed: ${data.error || `HTTP ${res.status}`}`);
        }
        setProgress(`${stageLabel} - retrying status query...`);
        continue;
      }
      consecutiveErrors = 0;
      const label = STATUS_TEXT[data.status] || data.status;
      const elapsed = Math.round(((i + 1) * 8) / 60 * 10) / 10;
      setProgress(data.progress > 0 ? `${stageLabel} - ${label} ${data.progress}%` : `${stageLabel} - ${label} (waited ${elapsed} min)`);
    }
    throw new Error(`${stageLabel} timed out`);
  }

  /** Download the model via a direct browser connection to Tripo + client-side decimation/texture downscale (bypasses the server, saves Netlify quota). */
  async function downloadAndOptimize(modelUrl: string, hasAnimation: boolean): Promise<Blob> {
    setProgress("Downloading model...");
    const glbRes = await fetch(modelUrl);
    if (!glbRes.ok) throw new Error("Model download failed");
    const raw = await glbRes.blob();
    return optimizeModelBlob(raw, {
      ratio: simplifyRatio / 100,
      textureSize: 512,
      hasAnimation,
      onProgress: setProgress,
    });
  }

  async function pollAndDownload(taskId: string) {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 8000));
      if (typeof document !== "undefined" && document.hidden) { i--; continue; }
      const res = await fetch(`/api/tripo/status/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      const s = data.status || "pending";
      const statusText: Record<string, string> = {
        queued: "Queued",
        running: "Generating",
        success: "Done",
        failed: "Failed",
        pending: "Pending",
      };
      const label = statusText[s] || s;
      const pct = data.progress;
      setProgress(pct != null && pct > 0 ? `${label} ${pct}%` : label);

      if (data.status === "success" && data.modelUrl) {
        // Download via a direct browser connection to Tripo + client-side optimization; falls back to manual download if CORS is blocked
        try {
          const blob = await downloadAndOptimize(data.modelUrl, false);
          setResultBlob(blob);
          setStatus("done");
          return;
        } catch {
          setResultUrl(data.modelUrl);
          setStatus("failed");
          setProgress("Automatic download failed. Please download it manually and add it via \"Import Model\"");
          return;
        }
      }
      if (data.status === "failed" || data.status === "cancelled") {
        setStatus("failed");
        setProgress(data.error || "Generation failed");
        return;
      }
    }
    setStatus("failed");
    setProgress("Timed out");
  }

  async function handleGenerate() {
    if (!apiKey.trim()) { setProgress("Please enter an API Key first"); return; }
    setStatus("generating");
    setProgress("Submitting...");

    try {
      if (mode === "avatar") {
        if (!avatarCharacter) { setProgress("Please select a character first"); setStatus("idle"); return; }
        let files: File[] = imageFiles;
        if (avatarSource === "avatar") {
          if (!avatarCharacter.avatar) { setProgress("This character has no avatar. Please upload artwork instead"); setStatus("idle"); return; }
          const imgRes = await fetch(avatarCharacter.avatar);
          if (!imgRes.ok) throw new Error("Failed to read avatar. Please upload artwork instead");
          const blob = await imgRes.blob();
          files = [new File([blob], "avatar.png", { type: blob.type || "image/png" })];
        }
        if (files.length === 0) { setProgress("Please upload full-body artwork for this character"); setStatus("idle"); return; }
        setModelName(`${avatarCharacter.name || "Character"} Avatar`);
        const form = new FormData();
        files.forEach((f) => form.append("files", f));
        form.append("apiKey", apiKey);
        form.append("faceLimit", String(faceLimit));
        const res = await fetch("/api/tripo/generate", { method: "POST", body: form });
        const data = await res.json();
        if (!data.taskId) throw new Error(data.error || "Submission failed");
        if (animateAvatar) {
          // Animation chain: base model (not saved) -> auto-rig -> apply walk animation (skips decimation to protect the skeleton)
          await pollTaskStatus(data.taskId, "Base model");
          setProgress("Submitting auto-rig...");
          const rigRes = await fetch("/api/tripo/animate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "rig", taskId: data.taskId, apiKey }),
          });
          const rigData = await rigRes.json();
          if (!rigData.taskId) throw new Error(rigData.error || "Rig submission failed");
          await pollTaskStatus(rigData.taskId, "Auto-rig");
          setProgress("Submitting walk animation...");
          const retRes = await fetch("/api/tripo/animate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "retarget", taskId: rigData.taskId, apiKey, animation: "preset:walk" }),
          });
          const retData = await retRes.json();
          if (!retData.taskId) throw new Error(retData.error || "Animation submission failed");
          const finalData = await pollTaskStatus(retData.taskId, "Walk animation");
          if (!finalData.modelUrl) throw new Error("Animated model download failed");
          // Animated models skip geometry operations (to protect the skeleton/skinning) and only downscale textures
          setResultBlob(await downloadAndOptimize(finalData.modelUrl, true));
          setStatus("done");
        } else {
          setProgress("Generating...");
          await pollAndDownload(data.taskId);
        }
      } else if (mode === "text") {
        if (!prompt.trim()) { setProgress("Please enter a description"); setStatus("idle"); return; }
        setModelName(prompt.trim());
        const res = await fetch("/api/tripo/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompt.trim(), apiKey, faceLimit }),
        });
        const data = await res.json();
        if (!data.taskId) throw new Error(data.error || "Submission failed");
        setProgress("Generating...");
        await pollAndDownload(data.taskId);
      } else {
        if (imageFiles.length === 0) { setProgress("Please select an image"); setStatus("idle"); return; }
        setModelName(imageFiles[0].name.replace(/\.\w+$/, ""));
        const form = new FormData();
        imageFiles.forEach((f) => form.append("files", f));
        form.append("apiKey", apiKey);
        form.append("faceLimit", String(faceLimit));
        const res = await fetch("/api/tripo/generate", { method: "POST", body: form });
        const data = await res.json();
        if (!data.taskId) throw new Error(data.error || "Submission failed");
        setProgress("Generating...");
        await pollAndDownload(data.taskId);
      }
    } catch (e: any) {
      setStatus("failed");
      setProgress(e.message);
    }
  }

  async function handleAddToLibrary() {
    if (!resultBlob) return;
    const isAvatar = mode === "avatar" && !!avatarCharacter;
    const cat = isAvatar ? "Character" : (customCat.trim() || category);
    await saveModel({
      name: modelName || "Unnamed",
      category: cat,
      blob: resultBlob,
      ...(isAvatar ? { characterId: avatarCharacter.id } : {}),
    });
    onModelAdded();
    resetAndClose();
  }

  function resetAndClose() {
    setStatus("idle");
    setProgress("");
    setResultUrl(null);
    setResultBlob(null);
    setPrompt("");
    setImageFiles([]);
    setModelName("");
    setCustomCat("");
    setAvatarCharacterId("");
    setAvatarSource("upload");
    setAnimateAvatar(true);
    onClose();
  }

  if (!open) return null;

  return (
    <div className="wb-modal-overlay" onClick={resetAndClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb-modal-header">
          <span>Generate Model</span>
          <button className="wb-float-close" onClick={resetAndClose}>✕</button>
        </div>

        {/* API Key */}
        <div className="wb-modal-section">
          <label className="wb-modal-label">API Key</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="wb-modal-input"
              style={{ flex: 1 }}
              type="password"
              placeholder="Enter Tripo API Key"
              value={apiKey}
              onChange={(e) => saveApiKey(e.target.value)}
            />
            <button
              className="wb-modal-btn"
              style={{ width: "auto", padding: "8px 12px", flexShrink: 0 }}
              onClick={verifyApiKey}
              disabled={!apiKey.trim() || keyStatus === "checking"}
            >
              {keyStatus === "checking" ? "Verifying" : "Verify"}
            </button>
          </div>
          {keyStatus === "ok" && <span className="wb-modal-hint" style={{ color: "rgba(100,220,140,0.8)" }}>Connected</span>}
          {keyStatus === "fail" && <span className="wb-modal-hint" style={{ color: "rgba(255,120,100,0.8)" }}>Connection failed, please check the Key</span>}
        </div>

        {/* Mode switch */}
        <div className="wb-modal-section">
          <div className="wb-modal-tabs">
            <button className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>Text to Model</button>
            <button className={mode === "image" ? "active" : ""} onClick={() => setMode("image")}>Image to Model</button>
            <button
              className={mode === "avatar" ? "active" : ""}
              onClick={() => {
                setMode("avatar");
                // Avatars skip post-process decimation (to protect skeleton/skinning), so face_limit is the only way to control face count;
                // with no limit, Tripo's raw output is 200k+ faces, which is too heavy for real-time skeletal animation — default to 40k
                if (faceLimit === 0) setFaceLimit(40000);
              }}
            >Character Avatar</button>
          </div>
        </div>

        {/* Face count control */}
        <div className="wb-modal-section">
          <label className="wb-modal-label">Face count (0 = unlimited)</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              className="wb-scale-slider"
              type="range"
              min={0}
              max={50000}
              step={1000}
              value={faceLimit}
              onChange={(e) => setFaceLimit(parseInt(e.target.value))}
            />
            <span className="wb-scale-value" style={{ minWidth: 40 }}>{faceLimit || "Unlimited"}</span>
          </div>
        </div>

        <div className="wb-modal-section">
          <label className="wb-modal-label">Retopology retain ratio ({simplifyRatio}%)</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              className="wb-scale-slider"
              type="range"
              min={5}
              max={100}
              step={5}
              value={simplifyRatio}
              onChange={(e) => setSimplifyRatio(parseInt(e.target.value))}
            />
            <span className="wb-scale-value">{simplifyRatio}%</span>
          </div>
        </div>

        {/* Input */}
        <div className="wb-modal-section">
          {mode === "avatar" ? (
            <>
              <label className="wb-modal-label">Select Character</label>
              <select
                className="wb-modal-input"
                value={avatarCharacterId}
                onChange={(e) => setAvatarCharacterId(e.target.value)}
                disabled={status === "generating"}
              >
                <option value="">Please select...</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name || "Unnamed Character"}</option>
                ))}
              </select>
              <div className="wb-modal-tabs" style={{ marginTop: 8 }}>
                <button
                  className={avatarSource === "upload" ? "active" : ""}
                  onClick={() => setAvatarSource("upload")}
                  disabled={status === "generating"}
                >Upload Artwork (Recommended)</button>
                <button
                  className={avatarSource === "avatar" ? "active" : ""}
                  onClick={() => setAvatarSource("avatar")}
                  disabled={status === "generating"}
                >Use Character Avatar</button>
              </div>
              {avatarSource === "upload" ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      if (files.length) setImageFiles((prev) => [...prev, ...files]);
                    }}
                  />
                  <button
                    className="wb-modal-btn"
                    style={{ marginTop: 8 }}
                    onClick={() => fileRef.current?.click()}
                    disabled={status === "generating"}
                  >
                    Select Artwork Images (multi-select for multiple angles)
                  </button>
                  {imageFiles.length > 0 && (
                    <div className="wb-modal-images">
                      {imageFiles.map((f, i) => (
                        <div key={i} className="wb-modal-img-item">
                          <img src={URL.createObjectURL(f)} alt={f.name} />
                          <button onClick={() => setImageFiles((prev) => prev.filter((_, j) => j !== i))}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                avatarCharacter?.avatar
                  ? <div className="wb-modal-images" style={{ marginTop: 8 }}><div className="wb-modal-img-item"><img src={avatarCharacter.avatar} alt="" /></div></div>
                  : <span className="wb-modal-hint" style={{ marginTop: 8 }}>This character has no avatar. Please upload artwork instead</span>
              )}
              <label className="wb-modal-hint" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={animateAvatar}
                  onChange={(e) => setAnimateAvatar(e.target.checked)}
                  disabled={status === "generating"}
                />
                Auto rig + walk animation after generation (uses more quota; lets the avatar walk around the scene)
              </label>
              <span className="wb-modal-hint">
                Artwork tips: full body, natural standing pose/T-pose, unobstructed — headshots will produce odd half-body models
              </span>
            </>
          ) : mode === "text" ? (
            <input
              className="wb-modal-input"
              placeholder="Describe the object you want..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && status === "idle" && handleGenerate()}
              disabled={status === "generating"}
            />
          ) : (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length) setImageFiles((prev) => [...prev, ...files]);
                }}
              />
              <button
                className="wb-modal-btn"
                onClick={() => fileRef.current?.click()}
                disabled={status === "generating"}
              >
                Select Images (multi-select)
              </button>
              {imageFiles.length > 0 && (
                <div className="wb-modal-images">
                  {imageFiles.map((f, i) => (
                    <div key={i} className="wb-modal-img-item">
                      <img src={URL.createObjectURL(f)} alt={f.name} />
                      <button onClick={() => setImageFiles((prev) => prev.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <span className="wb-modal-hint">
                1 image = single-view generation, multiple = multi-view generation (better results)
              </span>
            </>
          )}
        </div>

        {/* Generate button */}
        {status === "idle" && (
          <button className="wb-modal-btn wb-modal-primary" onClick={handleGenerate}>
            Start Generating
          </button>
        )}

        {/* Progress */}
        {progress && <div className="wb-modal-progress">{progress}</div>}

        {/* Download failure hint */}
        {status === "failed" && resultUrl && (
          <a href={resultUrl} target="_blank" rel="noreferrer" className="wb-modal-link">
            Download Model Manually
          </a>
        )}

        {/* Generation complete: add to library */}
        {status === "done" && resultBlob && (
          <div className="wb-modal-result">
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
              <button className="wb-modal-btn wb-modal-primary" onClick={handleAddToLibrary}>Add to Library</button>
              <button className="wb-modal-btn" onClick={resetAndClose}>Discard</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
