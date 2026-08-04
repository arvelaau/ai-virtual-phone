"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Upload } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/modal";

const MAX_CSS_IMPORT_SIZE = 512 * 1024;
const SUPPORTED_EXTENSIONS = new Set(["css", "txt", "docx"]);

const defaultButtonStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  border: "1px solid var(--c-input-border, #ddd)",
  background: "var(--c-input, #f7f7f7)",
  color: "var(--c-icon, #999)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
  padding: 0,
};

type PendingImport = {
  fileName: string;
  css: string;
};

type CSSImportButtonProps = {
  onImport: (css: string) => void;
  buttonStyle?: CSSProperties;
};

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeImportedCSS(value: string): string {
  const normalized = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();

  const fencedBlocks = [...normalized.matchAll(/```(?:css)?\s*\n([\s\S]*?)```/gi)];
  const css = fencedBlocks.length > 0
    ? fencedBlocks.map((match) => match[1].trim()).filter(Boolean).join("\n\n")
    : normalized;

  if (!css) throw new Error("No importable CSS content found in the file");
  return css;
}

async function readDocxText(file: File): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) throw new Error("Unable to read this DOCX file");

  return decodeXmlText(documentXml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, ""));
}

async function readCSSImportFile(file: File): Promise<string> {
  const extension = getExtension(file.name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    if (extension === "doc") {
      throw new Error("Legacy .doc is not supported yet. Please save as .docx or .txt before importing");
    }
    throw new Error("Only .css, .txt, and .docx files are supported");
  }
  if (file.size > MAX_CSS_IMPORT_SIZE) {
    throw new Error("File must not exceed 512 KB");
  }

  const content = extension === "docx" ? await readDocxText(file) : await file.text();
  return normalizeImportedCSS(content);
}

function showNotice(message: string): void {
  window.dispatchEvent(new CustomEvent("global-notice", { detail: message }));
}

export function CSSImportButton({ onImport, buttonStyle }: CSSImportButtonProps) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;

    setPortalTarget(marker.closest<HTMLElement>(".phone-shell") ?? document.body);

    const slot = marker
      .closest<HTMLElement>(".page-shell")
      ?.querySelector<HTMLElement>(".page-header-right") ?? null;
    setHeaderSlot(slot);

    if (!slot) return;
    const placeholder = slot.querySelector<HTMLElement>(":scope > span");
    if (!placeholder || placeholder.childElementCount > 0) return;

    const previousDisplay = placeholder.style.display;
    placeholder.style.display = "none";
    return () => {
      placeholder.style.display = previousDisplay;
    };
  }, []);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const css = await readCSSImportFile(file);
      setPendingImport({ fileName: file.name, css });
    } catch (error) {
      console.error("[CSSImport] import failed:", error);
      showNotice(error instanceof Error ? error.message : "Failed to read CSS file");
    }
  }, []);

  const confirmImport = useCallback(() => {
    if (!pendingImport) return;
    onImport(pendingImport.css);
    setPendingImport(null);
    showNotice("CSS imported. Please review it, then click \"Apply\"");
  }, [onImport, pendingImport]);

  const renderButton = (inHeader: boolean) => (
    <button
      type="button"
      data-css-import-button=""
      className={inHeader ? "page-back-btn" : undefined}
      aria-label="Import CSS file"
      title="Import CSS file"
      style={inHeader ? undefined : { ...defaultButtonStyle, ...buttonStyle }}
      onClick={() => fileInputRef.current?.click()}
    >
      <Upload size={inHeader ? 21 : 15} strokeWidth={1.6} />
    </button>
  );

  return (
    <>
      <span ref={markerRef} style={{ display: "contents" }} />
      {!headerSlot && renderButton(false)}
      <input
        ref={fileInputRef}
        type="file"
        accept=".css,.txt,.docx,text/css,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={handleFileChange}
      />
      {headerSlot ? createPortal(renderButton(true), headerSlot) : null}
      {pendingImport && portalTarget ? createPortal(
        <ConfirmDialog
          title="Import CSS"
          message={`This will import "${pendingImport.fileName}" and overwrite the existing content in the input field. Continue?`}
          icon={Upload}
          variant="action"
          confirmLabel="Confirm Import"
          cancelLabel="Cancel"
          onConfirm={confirmImport}
          onCancel={() => setPendingImport(null)}
        />,
        portalTarget
      ) : null}
    </>
  );
}
