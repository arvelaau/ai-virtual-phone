"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  Archive,
  Brain,
  Database,
  Download,
  Loader2,
  MessageCircle,
  Palette,
  Share2,
  ShieldCheck,
  Settings2,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { DATA_MODULES, getLightModuleIds } from "@/lib/data-management/modules";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";
import { Input, Select, Toggle } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/modal";
import { CloudUpload } from "lucide-react";
import {
  DEFAULT_CLOUD_BACKUP_CONFIG,
  isCloudBackupConfigured,
  loadCloudBackupConfig,
  saveCloudBackupConfig,
  type CloudBackupConfig,
} from "@/lib/cloud-backup/config";
import { testCloudBackupConnection } from "@/lib/cloud-backup/storage-client";
import { listCloudBackups, loadCloudBackupState, restoreFromCloudManifest, runCloudBackup, type CloudBackupListItem, type CloudBackupState } from "@/lib/cloud-backup/engine";
import { CloudDownload } from "lucide-react";
import {
  clearModules,
  createBackupBlob,
  downloadBackupBlob,
  formatBytes,
  importBackupBlob,
  inspectData,
  readBackupBlob,
} from "@/lib/data-management/backup";
import {
  cleanupOrphanThemeAssets,
  DEFAULT_MEDIA_MAINTENANCE_CONFIG,
  formatMediaMaintenanceResult,
  loadMediaMaintenanceConfig,
  loadMediaMaintenanceState,
  runMediaMaintenance,
  saveMediaMaintenanceConfig,
  type MediaMaintenanceConfig,
  type MediaMaintenanceState,
} from "@/lib/media-maintenance";
import { isAndroidBrowser, isIOSBrowser } from "@/lib/download-utils";
import type { BackupEnvelope, BackupManifest, DataModuleId, DataSnapshot, ImportResult, ModuleStats } from "@/lib/data-management/types";

type PendingImport = {
  file: File;
  envelope: BackupEnvelope;
};

type PendingExport = {
  blob: Blob;
  manifest: BackupManifest;
};

type PendingCloudRestore = {
  item: CloudBackupListItem;
  overwrite: boolean;
};

type ConfirmRequest =
  | { type: "export"; moduleIds: DataModuleId[]; labels: string }
  | { type: "import"; moduleIds: DataModuleId[]; labels: string; overwrite: boolean }
  | { type: "clear"; moduleIds: DataModuleId[]; labels: string }
  | { type: "media-maintenance" }
  | { type: "orphan-theme" };

type DataManagementProps = {
  onNotice?: (message: string) => void;
};

const ALL_MODULE_IDS = DATA_MODULES.map((module) => module.id);

const MODULE_ICONS: Record<DataModuleId, LucideIcon> = {
  chat: MessageCircle,
  settings: Settings2,
  characters: UserRound,
  desktop: Palette,
  memory: Brain,
  social: UsersRound,
  apps: Smartphone,
  creative: Sparkles,
  cache: Archive,
};

const MODULE_ACCENTS: Record<DataModuleId, string> = {
  chat: CONTENT_APP_ACCENTS.chat,
  settings: BINDING_ACCENTS.api,
  characters: BINDING_ACCENTS.preset,
  desktop: BINDING_ACCENTS.voice,
  memory: BINDING_ACCENTS.memory,
  social: CONTENT_APP_ACCENTS.moments,
  apps: CONTENT_APP_ACCENTS.calendar,
  creative: CONTENT_APP_ACCENTS.story,
  cache: BINDING_ACCENTS.regex,
};

const iconStyle = (color: string): CSSProperties => ({
  "--icon-color": color,
} as CSSProperties);

function DataSettingsIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
  return (
    <span className="card-icon" style={iconStyle(color)}>
      <Icon size={22} strokeWidth={1.75} />
    </span>
  );
}

function DataSectionTitle({ children }: { children: string }) {
  return (
    <div className="flex justify-between items-center gap-3">
      <p className="settings-menu-section-title">{children}</p>
    </div>
  );
}

type ModuleChipItem = {
  id: DataModuleId;
  label: string;
  meta?: string;
};

function ModuleChipSelector({
  items,
  selectedIds,
  onChange,
  ariaLabel,
}: {
  items: ModuleChipItem[];
  selectedIds: DataModuleId[];
  onChange: (ids: DataModuleId[]) => void;
  ariaLabel: string;
}) {
  return (
    <div className="data-module-chip-grid" role="group" aria-label={ariaLabel}>
      {items.map((item) => {
        const selected = selectedIds.includes(item.id);
        const Icon = MODULE_ICONS[item.id];
        return (
          <button
            key={item.id}
            type="button"
            className="data-module-chip"
            aria-pressed={selected}
            style={iconStyle(MODULE_ACCENTS[item.id])}
            {...(selected ? { "data-selected": "" } : {})}
            onClick={() => {
              if (selected) onChange(selectedIds.filter((id) => id !== item.id));
              else onChange([...selectedIds, item.id]);
            }}
          >
            <span className="data-chip-mark" aria-hidden="true">
              <Icon size={13} strokeWidth={2} />
            </span>
            <span className="data-chip-main">
              <span className="data-chip-label">{item.label}</span>
              {item.meta && <span className="data-chip-meta">{item.meta}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ModulePieChart({ modules, totalBytes }: { modules: ModuleStats[]; totalBytes: number }) {
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const visibleModules = modules.filter((module) => module.bytes > 0);
  let offset = 0;

  return (
    <div className="data-pie-panel" aria-label="Module data breakdown">
      <div className="data-pie-chart">
        <svg viewBox="0 0 120 120" role="img" aria-label="Module breakdown pie chart">
          <circle className="data-pie-track" cx="60" cy="60" r={radius} />
          {visibleModules.length > 0 ? visibleModules.map((module) => {
            const length = totalBytes > 0 ? (module.bytes / totalBytes) * circumference : 0;
            const gap = visibleModules.length > 1 ? Math.min(1.2, length * 0.2) : 0;
            const dash = Math.max(0, length - gap);
            const segment = (
              <circle
                key={module.moduleId}
                className="data-pie-segment"
                cx="60"
                cy="60"
                r={radius}
                stroke={MODULE_ACCENTS[module.moduleId]}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += length;
            return segment;
          }) : null}
        </svg>
        <div className="data-pie-center">
          <span>{formatBytes(totalBytes)}</span>
          <small>Total</small>
        </div>
      </div>
      <div className="data-pie-legend">
        {modules.map((module) => (
          <div key={module.moduleId} className="data-pie-legend-item">
            <span className="data-pie-dot" style={{ background: MODULE_ACCENTS[module.moduleId] }} />
            <span className="data-pie-name">{module.label}</span>
            <span className="data-pie-value">{module.percent}% · {formatBytes(module.bytes)}</span>
            {module.details && module.details.length > 0 && (
              <span className="data-pie-detail">
                {module.details.slice(0, 3).map((detail) => `${detail.label}: ${formatBytes(detail.bytes)}`).join(" / ")}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function moduleLabel(id: DataModuleId): string {
  return DATA_MODULES.find((module) => module.id === id)?.label ?? id;
}

function formatTime(value?: string): string {
  if (!value) return "No record";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function DataManagement({ onNotice }: DataManagementProps) {
  const [snapshot, setSnapshot] = useState<DataSnapshot | null>(null);
  const [selectedExportModules, setSelectedExportModules] = useState<DataModuleId[]>(ALL_MODULE_IDS);
  const [selectedImportModules, setSelectedImportModules] = useState<DataModuleId[]>([]);
  const [selectedClearModules, setSelectedClearModules] = useState<DataModuleId[]>([]);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [pendingExport, setPendingExport] = useState<PendingExport | null>(null);
  const [exportSaving, setExportSaving] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [persistSupported, setPersistSupported] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [cloudConfig, setCloudConfig] = useState<CloudBackupConfig>(DEFAULT_CLOUD_BACKUP_CONFIG);
  const [cloudTesting, setCloudTesting] = useState(false);
  const [cloudTestMsg, setCloudTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cloudBackingUp, setCloudBackingUp] = useState(false);
  const [cloudProgress, setCloudProgress] = useState<{ percent: number; detail: string } | null>(null);
  const [cloudState, setCloudState] = useState<CloudBackupState>({});
  const [showRestore, setShowRestore] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreList, setRestoreList] = useState<CloudBackupListItem[]>([]);
  const [restoreOverwrite, setRestoreOverwrite] = useState(false);
  const [restorePending, setRestorePending] = useState<PendingCloudRestore | null>(null);
  const [mediaConfig, setMediaConfig] = useState<MediaMaintenanceConfig>(DEFAULT_MEDIA_MAINTENANCE_CONFIG);
  const [mediaState, setMediaState] = useState<MediaMaintenanceState>({});

  useEffect(() => {
    setCloudConfig(loadCloudBackupConfig());
    setCloudState(loadCloudBackupState());
  }, []);

  useEffect(() => {
    setMediaConfig(loadMediaMaintenanceConfig());
    setMediaState(loadMediaMaintenanceState());
    const handleUpdate = () => setMediaState(loadMediaMaintenanceState());
    window.addEventListener("media-maintenance-updated", handleUpdate);
    return () => window.removeEventListener("media-maintenance-updated", handleUpdate);
  }, []);

  const runBackupNow = async () => {
    if (cloudBackingUp) return;
    setCloudBackingUp(true);
    setCloudTestMsg(null);
    try {
      saveCloudBackupConfig(cloudConfig);
      // Cloud uploads are chunked → large media is fine; always back up in full (incl. images).
      const result = await runCloudBackup(cloudConfig, { force: true, excludeMedia: false, onProgress: setCloudProgress });
      setCloudState(loadCloudBackupState());
      if (result.status === "anomaly") {
        onNotice?.("Data shrank significantly; saved as a pending-review backup and kept the previous backup.");
      } else if (result.status === "skipped") {
        onNotice?.("No changes detected; this backup was skipped.");
      } else {
        onNotice?.(`Backed up: uploaded ${result.uploadedModules} module(s), ${formatBytes(result.totalBytes)}.`);
      }
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Backup failed.");
      setCloudState(loadCloudBackupState());
    } finally {
      setCloudBackingUp(false);
      setCloudProgress(null);
    }
  };

  const openRestore = async () => {
    const next = !showRestore;
    setShowRestore(next);
    if (!next) return;
    setRestoreLoading(true);
    try {
      saveCloudBackupConfig(cloudConfig);
      setRestoreList(await listCloudBackups(cloudConfig));
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Failed to load the cloud backup list.");
      setRestoreList([]);
    } finally {
      setRestoreLoading(false);
    }
  };

  const confirmRestore = (pending: PendingCloudRestore) => runAction("Restoring", async () => {
    try {
      // Cloud restore is a recovery path: "merge" keeps extra local records, but
      // same-ID conflicts should still prefer the backup so partial/empty local
      // shells cannot block a complete cloud backup from coming back.
      const result = await restoreFromCloudManifest(cloudConfig, pending.item.name, { overwrite: true, onProgress: setCloudProgress });
      setRestorePending(null);
      setShowRestore(false);
      if (result.errors.length > 0) {
        console.warn("[DataManagement] cloud restore errors:", result.errors);
      }
      const errorNote = result.errors.length > 0 ? `, ${result.errors.length} item(s) failed` : "";
      const firstError = result.errors[0] ? `First error: ${result.errors[0]}. ` : "";
      return `Restored from cloud: added ${result.added}, overwritten ${result.overwritten}, skipped ${result.skipped}${errorNote}. ${firstError}Please refresh the app to reload the cache.`;
    } finally {
      setCloudProgress(null);
    }
  });

  const updateCloud = (patch: Partial<CloudBackupConfig>) => {
    setCloudConfig((prev) => {
      const next = { ...prev, ...patch };
      saveCloudBackupConfig(next);
      return next;
    });
    setCloudTestMsg(null);
  };

  const updateMediaMaintenance = (enabled: boolean) => {
    const next = saveMediaMaintenanceConfig({ enabled });
    setMediaConfig(next);
  };

  const testCloud = async () => {
    if (cloudTesting) return;
    setCloudTesting(true);
    setCloudTestMsg(null);
    try {
      saveCloudBackupConfig(cloudConfig);
      const result = await testCloudBackupConnection(cloudConfig);
      setCloudTestMsg(result.ok
        ? { ok: true, text: "Connection succeeded; the backup bucket is ready." }
        : { ok: false, text: result.error });
    } catch (error) {
      setCloudTestMsg({ ok: false, text: error instanceof Error ? error.message : "Test failed." });
    } finally {
      setCloudTesting(false);
    }
  };

  const moduleChipItems = useMemo<ModuleChipItem[]>(
    () => DATA_MODULES.map((module) => ({ id: module.id, label: module.label })),
    [],
  );
  const pendingImportItems = useMemo<ModuleChipItem[]>(
    () => pendingImport?.envelope.manifest.modules.map((module) => ({
      id: module.id,
      label: module.label,
      meta: `${module.records} item(s) · ${formatBytes(module.bytes)}`,
    })) ?? [],
    [pendingImport],
  );
  const reloadStats = async () => {
    const nextSnapshot = await inspectData();
    setSnapshot(nextSnapshot);
    setPersisted(nextSnapshot.storage?.persisted ?? null);
  };

  useEffect(() => {
    setPersistSupported(typeof navigator !== "undefined" && Boolean(navigator.storage?.persist));
    void reloadStats().catch((error) => {
      onNotice?.("Failed to load data statistics.");
      console.warn("[DataManagement] inspect failed:", error);
    });
  }, [onNotice]);

  const runAction = async (label: string, action: () => Promise<string | void>) => {
    setBusy(label);
    try {
      const message = await action();
      if (message) onNotice?.(message);
      await reloadStats();
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Action failed, please try again later.");
      console.warn("[DataManagement] action failed:", error);
    } finally {
      setBusy(null);
    }
  };

  const handleExport = (moduleIds: DataModuleId[]) => {
    if (moduleIds.length === 0) {
      onNotice?.("Please select the modules to export.");
      return;
    }
    const labels = moduleIds.map(moduleLabel).join(", ");
    setConfirmRequest({ type: "export", moduleIds, labels });
  };

  const executeExport = (moduleIds: DataModuleId[]) => runAction("Exporting", async () => {
    const { blob, manifest } = await createBackupBlob(moduleIds, { excludeMedia: cloudConfig.excludeMedia });
    const note = manifest.mediaExcluded ? " (excludes images/media)" : "";
    if (isIOSBrowser() || isAndroidBrowser()) {
      setPendingExport({ blob, manifest });
      return `Backup file created: ${manifest.modules.length} module(s), ${formatBytes(manifest.totalBytes)}${note}. Tap "Save Backup File".`;
    }
    await downloadBackupBlob(blob, manifest, { disableNativeShare: true });
    return `Exported ${manifest.modules.length} module(s), ${formatBytes(manifest.totalBytes)}${note}.`;
  });

  const savePendingExport = async () => {
    if (!pendingExport || exportSaving) return;
    setExportSaving(true);
    try {
      const useNativeShare = isIOSBrowser();
      await downloadBackupBlob(pendingExport.blob, pendingExport.manifest, useNativeShare ? { nativeShareOnly: true } : { disableNativeShare: true });
      setPendingExport(null);
      onNotice?.(useNativeShare ? "Opened the system share sheet; choose \"Save to Files\"." : "Started downloading the backup file.");
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Couldn't open the system share sheet, please try again later.");
    } finally {
      setExportSaving(false);
    }
  };

  const handleFileSelected = async (file: File | undefined) => {
    if (!file) return;
    await runAction("Reading backup", async () => {
      const envelope = await readBackupBlob(file);
      setPendingImport({ file, envelope });
      setSelectedImportModules(envelope.manifest.modules.map((module) => module.id));
      return `Backup loaded: ${envelope.manifest.modules.map((module) => module.label).join(", ")}`;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImport = (overwrite = false) => {
    if (!pendingImport) {
      onNotice?.("Please select a backup file first.");
      return;
    }
    if (selectedImportModules.length === 0) {
      onNotice?.("Please select the modules to import.");
      return;
    }
    const labels = selectedImportModules.map(moduleLabel).join(", ");
    setConfirmRequest({ type: "import", moduleIds: selectedImportModules, labels, overwrite });
  };

  const executeImport = (moduleIds: DataModuleId[], overwrite = false) => runAction("Importing", async () => {
    if (!pendingImport) return "Please select a backup file first.";
    const result: ImportResult = await importBackupBlob(pendingImport.file, moduleIds, { overwrite });
    setPendingImport(null);
    const summary = `Import complete: added ${result.added}, skipped ${result.skipped}, overwritten ${result.overwritten}`;
    if (result.errors.length > 0) {
      const firstError = result.errors[0] ? `First error: ${result.errors[0]}. ` : "";
      return `${summary}. ${result.errors.length} error(s), ${firstError}we recommend refreshing and checking.`;
    }
    return `${summary}. Please refresh the app to reload the cache.`;
  });

  const handlePersist = () => runAction("Requesting protection", async () => {
    if (!navigator.storage?.persist) return "This browser doesn't support requesting persistent storage.";
    const ok = await navigator.storage.persist();
    setPersisted(ok);
    return ok ? "Browser persistent storage protection enabled." : "The browser didn't grant persistent protection; you can still use file backups.";
  });

  const handlePersistToggle = (next: boolean) => {
    if (next) {
      void handlePersist();
      return;
    }
    void runAction("Updating protection", async () => "Browsers don't allow web pages to disable persistent protection directly; revoke or clear site data in your browser's site settings.");
  };

  const handleClearSelected = () => {
    if (selectedClearModules.length === 0) {
      onNotice?.("Please select the modules to clean up.");
      return;
    }
    const labels = selectedClearModules.map(moduleLabel).join(", ");
    setConfirmRequest({ type: "clear", moduleIds: selectedClearModules, labels });
  };

  const executeClearSelected = (moduleIds: DataModuleId[]) => runAction("Cleaning", async () => {
    const result = await clearModules(moduleIds);
    setSelectedClearModules([]);
    if (result.errors.length > 0) return `Cleaned up ${result.removed} item(s), with ${result.errors.length} error(s).`;
    return `Cleaned up ${result.removed} item(s). Please refresh the app to reload the cache.`;
  });

  const executeMediaMaintenance = () => runAction("Cleaning media", async () => {
    const result = await runMediaMaintenance({ force: true });
    setMediaState(loadMediaMaintenanceState());
    return formatMediaMaintenanceResult(result);
  });

  const executeOrphanThemeCleanup = () => runAction("Cleaning orphaned assets", async () => {
    const result = await cleanupOrphanThemeAssets();
    setMediaState(loadMediaMaintenanceState());
    if (result.deletedAssets === 0) return "No definitely unreferenced theme assets were found.";
    return `Deleted ${result.deletedAssets} unreferenced theme asset(s), freeing an estimated ${formatBytes(result.freedBytes)}.`;
  });

  const handleConfirmRequest = () => {
    if (!confirmRequest) return;
    const request = confirmRequest;
    setConfirmRequest(null);
    if (request.type === "export") {
      void executeExport(request.moduleIds);
      return;
    }
    if (request.type === "import") {
      void executeImport(request.moduleIds, request.overwrite);
      return;
    }
    if (request.type === "media-maintenance") {
      void executeMediaMaintenance();
      return;
    }
    if (request.type === "orphan-theme") {
      void executeOrphanThemeCleanup();
      return;
    }
    void executeClearSelected(request.moduleIds);
  };

  return (
    <div className="page-menu data-management-menu" style={{ padding: 0 }}>
      <div className="data-section">
        <DataSectionTitle>Module Breakdown</DataSectionTitle>
        <div className="menu-group">
          {snapshot?.modules.length ? (
            <div className="menu-item data-readonly-item data-pie-item">
              <ModulePieChart modules={snapshot.modules} totalBytes={snapshot.totalBytes} />
            </div>
          ) : (
            <div className="menu-item data-readonly-item">
              <DataSettingsIcon icon={Database} color={BINDING_ACCENTS.api} />
              <div className="menu-label-group">
                <span className="menu-label">Calculating</span>
                <span className="menu-desc">Reading local storage</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="data-section">
        <DataSectionTitle>Local Protection</DataSectionTitle>
        <div className="menu-group">
          <div className="menu-item data-readonly-item">
            <DataSettingsIcon icon={ShieldCheck} color={persisted ? BINDING_ACCENTS.embedding : BINDING_ACCENTS.regex} />
            <div className="menu-label-group">
              <span className="menu-label">Browser Persistent Storage Protection</span>
              <span className="menu-desc">{persistSupported ? persisted ? "Enabled; disabling requires revoking it in your browser's site settings" : "Reduces the chance of automatic cleanup, but doesn't replace backups" : "This browser doesn't support persistence requests; rely on file backups instead"}</span>
            </div>
            <span className="menu-right">
              <Toggle checked={Boolean(persisted)} onChange={handlePersistToggle} disabled={!persistSupported || Boolean(busy && !persisted)} />
            </span>
          </div>
        </div>
      </div>

      <div className="data-section">
        <DataSectionTitle>Media Cleanup</DataSectionTitle>
        <div className="menu-group">
          <div className="menu-item data-readonly-item">
            <DataSettingsIcon icon={Archive} color={CONTENT_APP_ACCENTS.moments} />
            <div className="menu-label-group">
              <span className="menu-label">Automatic Image/Media Compression &amp; Cleanup</span>
              <span className="menu-desc">When enabled, runs at most once per day: compresses chat, Moments, and Xiaohongshu post images older than 4 days; cleans up chat images, Moments/Xiaohongshu original images, and local music older than 7 days. Persistent resources like wallpapers, icons, the dock, and fonts are not included in automatic cleanup.</span>
            </div>
            <span className="menu-right">
              <Toggle checked={mediaConfig.enabled} onChange={updateMediaMaintenance} disabled={Boolean(busy)} />
            </span>
          </div>
          <div className="menu-item data-readonly-item">
            <div className="menu-label-group">
              <span className="menu-label">Cleanup Status</span>
              <span className="menu-desc">
                {mediaState.lastRunAt ? `Last run: ${formatTime(mediaState.lastRunAt)}.` : "Not run yet."}
                {mediaState.lastResult ? formatMediaMaintenanceResult(mediaState.lastResult) : ""}
                {mediaState.lastError ? ` Last error: ${mediaState.lastError}` : ""}
              </span>
            </div>
          </div>
          <div className="data-menu-actions">
            <button
              type="button"
              className={`ui-btn ui-btn-primary ${busy === "Cleaning media" ? "is-busy" : ""}`}
              onClick={() => setConfirmRequest({ type: "media-maintenance" })}
              disabled={Boolean(busy)}
            >
              {busy === "Cleaning media" ? <><Loader2 size={16} className="animate-spin" /> Running…</> : <><Archive size={16} /> Run Now</>}
            </button>
            <button
              type="button"
              className={`ui-btn ui-btn-outline ${busy === "Cleaning orphaned assets" ? "is-busy" : ""}`}
              onClick={() => setConfirmRequest({ type: "orphan-theme" })}
              disabled={Boolean(busy)}
            >
              {busy === "Cleaning orphaned assets" ? <><Loader2 size={16} className="animate-spin" /> Cleaning…</> : <><Trash2 size={16} /> Clean Up Unreferenced Theme Assets</>}
            </button>
          </div>
        </div>
      </div>

      <div className="data-section">
        <DataSectionTitle>Export & Import</DataSectionTitle>
        <div className="menu-group">
          <div className="menu-item data-readonly-item">
            <div className="menu-label-group">
              <span className="menu-label">Local Export · Excludes Images/Media</span>
              <span className="menu-desc">Only applies to "Local Export Backup File": removes large files like wallpapers, chat images, and Moments images (character avatars are kept), making the file smaller and export faster. Cloud backup already supports chunked uploads and backs up images in full, unaffected by this toggle.</span>
            </div>
            <span className="menu-right">
              <Toggle checked={cloudConfig.excludeMedia} onChange={(checked) => updateCloud({ excludeMedia: checked })} />
            </span>
          </div>
          <div className="menu-item data-readonly-item">
            <div className="menu-label-group">
              <span className="menu-label">Export Modules</span>
              <span className="menu-desc">Selected {selectedExportModules.length} / {DATA_MODULES.length} modules</span>
            </div>
            <div className="menu-right data-inline-actions">
              <button type="button" className="ui-btn ui-btn-outline py-1 px-3 ts-12" onClick={() => setSelectedExportModules(ALL_MODULE_IDS)}>
                Select All
              </button>
              <button type="button" className="ui-btn ui-btn-outline py-1 px-3 ts-12" onClick={() => setSelectedExportModules(getLightModuleIds())}>
                Light
              </button>
            </div>
          </div>
          <div className="data-chip-panel">
            <ModuleChipSelector
              items={moduleChipItems}
              selectedIds={selectedExportModules}
              onChange={setSelectedExportModules}
              ariaLabel="Select modules to export"
            />
          </div>
          <div className="data-menu-actions">
            <button type="button" className={`ui-btn ui-btn-primary ${busy === "Exporting" ? "is-busy" : ""}`} onClick={() => handleExport(selectedExportModules)} disabled={Boolean(busy)}>
              {busy === "Exporting" ? <><Loader2 size={16} className="animate-spin" /> Exporting…</> : <><Download size={16} /> Export Backup</>}
            </button>
            <button type="button" className={`ui-btn ui-btn-outline ${busy === "Reading backup" ? "is-busy" : ""}`} onClick={() => fileInputRef.current?.click()} disabled={Boolean(busy)}>
              {busy === "Reading backup" ? <><Loader2 size={16} className="animate-spin" /> Reading…</> : <><Upload size={16} /> Import Backup</>}
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".aiphone,.zip,application/zip"
            className="hidden"
            onChange={(event) => void handleFileSelected(event.target.files?.[0])}
          />
        </div>
      </div>

      <div className="data-section">
        <DataSectionTitle>Cloud Backup</DataSectionTitle>
        <div className="menu-group">
          <div className="menu-item data-readonly-item">
            <DataSettingsIcon icon={CloudUpload} color={BINDING_ACCENTS.api} />
            <div className="menu-label-group">
              <span className="menu-label">Back Up to Your Supabase</span>
              <span className="menu-desc">Enter your own Supabase URL and service_role key. Clicking Test Connection will automatically create the backup bucket (no manual setup needed).</span>
            </div>
          </div>

          <div className="data-cloud-form">
            <label className="data-cloud-field">
              <span className="menu-desc ml-1">Supabase URL</span>
              <Input
                value={cloudConfig.url}
                onChange={(e) => updateCloud({ url: e.target.value })}
                placeholder="https://xxxx.supabase.co"
                spellCheck={false}
              />
            </label>
            <label className="data-cloud-field">
              <span className="menu-desc ml-1">service_role key</span>
              <Input
                type="password"
                value={cloudConfig.key}
                onChange={(e) => updateCloud({ key: e.target.value })}
                placeholder="eyJhbGci..."
                spellCheck={false}
              />
            </label>

            <div className="data-cloud-actions">
              <button
                type="button"
                className={`ui-btn ui-btn-outline ${cloudTesting ? "is-busy" : ""}`}
                onClick={() => void testCloud()}
                disabled={cloudTesting || cloudBackingUp || !isCloudBackupConfigured(cloudConfig)}
              >
                {cloudTesting ? <><Loader2 size={16} className="animate-spin" /> Testing…</> : "Test Connection"}
              </button>
              <button
                type="button"
                className={`ui-btn ui-btn-primary ${cloudBackingUp ? "is-busy" : ""}`}
                onClick={() => void runBackupNow()}
                disabled={cloudTesting || cloudBackingUp || !isCloudBackupConfigured(cloudConfig)}
              >
                {cloudBackingUp ? <><Loader2 size={16} className="animate-spin" /> Backing up…</> : <><CloudUpload size={16} /> Back Up Now</>}
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-ghost"
                onClick={() => void openRestore()}
                disabled={cloudBackingUp || !isCloudBackupConfigured(cloudConfig)}
              >
                <CloudDownload size={16} /> {showRestore ? "Collapse" : "Cloud Restore"}
              </button>
            </div>

            {cloudBackingUp && cloudProgress && (
              <div className="data-cloud-progress" role="status">
                <div className="data-cloud-progress-track">
                  <div className="data-cloud-progress-fill" style={{ width: `${Math.min(100, Math.round(cloudProgress.percent))}%` }} />
                </div>
                <span className="data-cloud-progress-text">{cloudProgress.detail} · {Math.round(cloudProgress.percent)}%</span>
              </div>
            )}

            {cloudTestMsg && (
              <div className={`data-cloud-result ${cloudTestMsg.ok ? "is-ok" : "is-err"}`} role="status">
                {cloudTestMsg.text}
              </div>
            )}

            {cloudState.lastCreatedAt && (
              <div className="data-cloud-status">
                Last backup: {formatTime(cloudState.lastCreatedAt)}
                {typeof cloudState.lastTotalBytes === "number" ? ` · ${formatBytes(cloudState.lastTotalBytes)}` : ""}
                {cloudState.lastResult === "anomaly" ? " · ⚠️ Pending review (data shrank abnormally)" : ""}
                {cloudState.lastResult === "skipped" ? " · Skipped, no changes" : ""}
              </div>
            )}

            {showRestore && (
              <div className="data-cloud-restore">
                <label className="data-cloud-restore-overwrite">
                  <input type="checkbox" checked={restoreOverwrite} onChange={(e) => setRestoreOverwrite(e.target.checked)} />
                  <span>Overwrite restore (leave unchecked to merge; same-ID items still follow the cloud version)</span>
                </label>
                {busy === "Restoring" ? (
                  <div className="data-cloud-progress" role="status">
                    <div className="data-cloud-progress-track">
                      <div className="data-cloud-progress-fill" style={{ width: `${Math.min(100, Math.round(cloudProgress?.percent ?? 0))}%` }} />
                    </div>
                    <span className="data-cloud-progress-text">
                      {cloudProgress ? `${cloudProgress.detail} · ${Math.round(cloudProgress.percent)}%` : "Restoring from the cloud, please wait…"}
                    </span>
                  </div>
                ) : restoreLoading ? (
                  <div className="data-cloud-status"><Loader2 size={14} className="animate-spin" /> Loading cloud backups…</div>
                ) : restoreList.length === 0 ? (
                  <div className="data-cloud-status">No backups in the cloud yet.</div>
                ) : (
                  <ul className="data-cloud-restore-list">
                    {restoreList.map((item) => (
                      <li key={item.name} className="data-cloud-restore-item">
                        <div className="menu-label-group">
                          <span className="menu-label">{formatTime(item.createdAt)}{item.quarantine ? " · Pending review" : ""}</span>
                          <span className="menu-desc">{formatBytes(item.totalBytes)} · {item.totalRecords} item(s)</span>
                        </div>
                        <button
                          type="button"
                          className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                          onClick={() => setRestorePending({ item, overwrite: restoreOverwrite })}
                          disabled={Boolean(busy)}
                        >
                          Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="menu-item data-readonly-item">
            <div className="menu-label-group">
              <span className="menu-label">Automatic Backup</span>
              <span className="menu-desc">When enabled, backs up silently in the background at the set interval.</span>
            </div>
            <span className="menu-right">
              <Toggle
                checked={cloudConfig.enabled}
                onChange={(checked) => updateCloud({ enabled: checked })}
                disabled={!isCloudBackupConfigured(cloudConfig)}
              />
            </span>
          </div>

          <div className="data-cloud-options">
            <label className="data-cloud-field">
              <span className="menu-desc ml-1">Backup Interval</span>
              <Select
                value={String(cloudConfig.intervalHours)}
                onChange={(e) => updateCloud({ intervalHours: Number(e.target.value) })}
                disabled={!cloudConfig.enabled}
              >
                <option value="0.5">Every 30 minutes</option>
                <option value="1">Every hour</option>
                <option value="6">Every 6 hours</option>
                <option value="12">Every 12 hours</option>
                <option value="24">Every day</option>
              </Select>
            </label>
            <label className="data-cloud-field">
              <span className="menu-desc ml-1">Backups to Keep</span>
              <Select
                value={String(cloudConfig.keepCount)}
                onChange={(e) => updateCloud({ keepCount: Number(e.target.value) })}
                disabled={!cloudConfig.enabled}
              >
                <option value="2">2 copies</option>
                <option value="3">3 copies</option>
              </Select>
            </label>
          </div>
        </div>
      </div>

      {pendingExport && (
        <div className="modal-overlay" data-ui="modal" onClick={() => { if (!exportSaving) setPendingExport(null); }}>
          <div className="modal-dialog data-import-modal" data-ui="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header" data-ui="modal-header">
              <h3 className="modal-title">Save Backup File</h3>
            </div>
            <div className="modal-body" data-ui="modal-body" style={{ textAlign: "left", width: "100%" }}>
              <p className="menu-desc" style={{ marginBottom: 12 }}>
                {pendingExport.manifest.modules.length} module(s) · {formatBytes(pendingExport.manifest.totalBytes)}
                {pendingExport.manifest.mediaExcluded ? " · Excludes images/media" : ""}
              </p>
              <p className="menu-desc">
                {isIOSBrowser()
                  ? 'iOS requires saving the backup file from the system share panel. Tap the button below, then choose "Save to Files".'
                  : "The backup file is ready. Tap the button below to download it."}
              </p>
            </div>
            <div className="modal-footer" data-ui="modal-footer" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" className="ui-btn ui-btn-primary" style={{ width: "100%", whiteSpace: "nowrap" }} onClick={() => void savePendingExport()} disabled={exportSaving}>
                {exportSaving
                  ? <><Loader2 size={16} className="animate-spin" /> {isIOSBrowser() ? "Opening…" : "Downloading…"}</>
                  : isIOSBrowser()
                    ? <><Share2 size={16} /> Share / Save File</>
                    : <><Download size={16} /> Download Backup File</>}
              </button>
              <button type="button" className="ui-btn ui-btn-outline" style={{ width: "100%", whiteSpace: "nowrap" }} onClick={() => setPendingExport(null)} disabled={exportSaving}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {pendingImport && (
        <div className="modal-overlay" data-ui="modal" onClick={() => { if (!busy) setPendingImport(null); }}>
          <div className="modal-dialog data-import-modal" data-ui="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header" data-ui="modal-header">
              <h3 className="modal-title">Import Backup</h3>
            </div>
            <div className="modal-body" data-ui="modal-body" style={{ textAlign: "left", width: "100%" }}>
              <p className="menu-desc" style={{ marginBottom: 12 }}>
                {formatTime(pendingImport.envelope.manifest.createdAt)} · {formatBytes(pendingImport.envelope.manifest.totalBytes)}
                {pendingImport.envelope.manifest.mediaExcluded ? " · Excludes images" : ""}
              </p>
              <div className="data-inline-actions" style={{ marginBottom: 10 }}>
                <span className="menu-desc" style={{ marginRight: "auto" }}>Select modules to import ({selectedImportModules.length} / {pendingImportItems.length})</span>
                <button type="button" className="ui-btn ui-btn-outline py-1 px-3 ts-12" onClick={() => setSelectedImportModules(pendingImportItems.map((item) => item.id))}>Select All</button>
                <button type="button" className="ui-btn ui-btn-outline py-1 px-3 ts-12" onClick={() => setSelectedImportModules([])}>Clear</button>
              </div>
              <div className="data-chip-panel">
                <ModuleChipSelector
                  items={pendingImportItems}
                  selectedIds={selectedImportModules}
                  onChange={setSelectedImportModules}
                  ariaLabel="Select modules to import"
                />
              </div>
            </div>
            <div className="modal-footer" data-ui="modal-footer" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" className="ui-btn ui-btn-primary" style={{ width: "100%", whiteSpace: "nowrap" }} onClick={() => handleImport(false)} disabled={Boolean(busy)}>
                {busy === "Importing" ? <Loader2 size={16} className="animate-spin" /> : null} Merge Import
              </button>
              <button type="button" className="ui-btn ui-btn-outline" style={{ width: "100%", whiteSpace: "nowrap" }} onClick={() => handleImport(true)} disabled={Boolean(busy)}>
                {busy === "Importing" ? <Loader2 size={16} className="animate-spin" /> : null} Overwrite Import
              </button>
              <button type="button" className="ui-btn ui-btn-outline" style={{ width: "100%", whiteSpace: "nowrap" }} onClick={() => setPendingImport(null)} disabled={Boolean(busy)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="data-section data-cleanup-section">
        <DataSectionTitle>Module Cleanup</DataSectionTitle>
        <div className="data-danger-alert" role="note" aria-label="Dangerous action notice">
          <span className="data-danger-icon" aria-hidden="true">
            <AlertTriangle size={17} strokeWidth={2.1} />
          </span>
          <div className="data-danger-copy">
            <span>Dangerous Action</span>
            <p>Cleanup will delete local data for the selected modules. Export a backup first — accidental deletion can only be undone by restoring from a backup file.</p>
          </div>
        </div>
        <div className="menu-group">
          <div className="menu-item data-readonly-item">
            <DataSettingsIcon icon={Trash2} color="#E5484D" />
            <div className="menu-label-group">
              <span className="menu-label">Clean Up Modules</span>
              <span className="menu-desc">Selected {selectedClearModules.length} / {DATA_MODULES.length} modules; a backup will be attempted before cleanup</span>
            </div>
            <div className="menu-right data-inline-actions">
              <button type="button" className="ui-btn ui-btn-outline py-1 px-3 ts-12" onClick={() => setSelectedClearModules([])}>
                Clear
              </button>
            </div>
          </div>
          <div className="data-chip-panel">
            <ModuleChipSelector
              items={moduleChipItems}
              selectedIds={selectedClearModules}
              onChange={setSelectedClearModules}
              ariaLabel="Select modules to clean up"
            />
          </div>
          <div className="data-menu-actions data-menu-actions-single">
            <button type="button" className="ui-btn ui-btn-danger" onClick={handleClearSelected} disabled={Boolean(busy)}>
              <Trash2 size={16} /> Clean Up Selected Modules
            </button>
          </div>
        </div>
      </div>

      {confirmRequest && (
        <ConfirmDialog
          title={
            confirmRequest.type === "export"
              ? "Confirm export backup?"
              : confirmRequest.type === "import"
                ? confirmRequest.overwrite ? "Confirm overwrite import?" : "Confirm merge import?"
                : confirmRequest.type === "media-maintenance"
                  ? "Confirm clean up media now?"
                  : confirmRequest.type === "orphan-theme"
                    ? "Confirm cleanup of unreferenced theme assets?"
                    : "Confirm module cleanup?"
          }
          message={
            confirmRequest.type === "export"
              ? `The following modules will be exported: ${confirmRequest.labels}. Continue?`
              : confirmRequest.type === "import"
                ? confirmRequest.overwrite
                  ? `Overwrite import will replace data in the selected modules with the backup's data: ${confirmRequest.labels}. We recommend exporting your current data first. Continue?`
                  : `The following modules will be merge-imported: ${confirmRequest.labels}. List-type data will be deduplicated and merged by ID; items with the same ID will follow the backup. Continue?`
                : confirmRequest.type === "media-maintenance"
                  ? "This will compress/clean up expired media per the rules: compress images older than 4 days, clean up chat images, Moments/Xiaohongshu original images, and local music older than 7 days, and remove old theme assets confirmed to be unreferenced. Persistent resources still in use, like wallpapers, icons, the dock, and fonts, will not be deleted. Continue?"
                  : confirmRequest.type === "orphan-theme"
                    ? "This will scan for theme assets still in use and only delete old images, fonts, dock, and icon skins confirmed to be unreferenced. Continue?"
                    : `Cleaning up ${confirmRequest.labels} will delete the corresponding data. We recommend backing up first. Continue?`
          }
          icon={confirmRequest.type === "export" ? Download : confirmRequest.type === "import" ? Upload : confirmRequest.type === "media-maintenance" ? Archive : AlertTriangle}
          variant={confirmRequest.type === "clear" || confirmRequest.type === "media-maintenance" || confirmRequest.type === "orphan-theme" || (confirmRequest.type === "import" && confirmRequest.overwrite) ? "danger" : "action"}
          confirmLabel={
            confirmRequest.type === "export"
              ? "Confirm Export"
              : confirmRequest.type === "import"
                ? confirmRequest.overwrite ? "Confirm Overwrite" : "Confirm Import"
                : confirmRequest.type === "media-maintenance"
                  ? "Run Now"
                  : "Confirm Cleanup"
          }
          onConfirm={handleConfirmRequest}
          onCancel={() => setConfirmRequest(null)}
        />
      )}

      {restorePending && (
        <ConfirmDialog
          title={restorePending.overwrite ? "Confirm overwrite restore?" : "Confirm merge restore?"}
          message={
            restorePending.overwrite
              ? `This will overwrite local data with matching IDs using the cloud backup from ${formatTime(restorePending.item.createdAt)}. We recommend running "Back Up Now" on your current data first. Continue?`
              : `This will merge the cloud backup from ${formatTime(restorePending.item.createdAt)} into local data; data not present locally will be added, and items with the same ID will follow the backup. Continue?`
          }
          icon={CloudDownload}
          variant={restorePending.overwrite ? "danger" : "action"}
          confirmLabel={restorePending.overwrite ? "Confirm Overwrite" : "Confirm Merge"}
          onConfirm={() => { const pending = restorePending; setRestorePending(null); if (pending) void confirmRestore(pending); }}
          onCancel={() => setRestorePending(null)}
        />
      )}
    </div>
  );
}
