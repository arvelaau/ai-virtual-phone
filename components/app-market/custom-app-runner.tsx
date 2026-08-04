"use client";

import { useCallback, useMemo, useRef, useState, useEffect, useLayoutEffect } from "react";
import { CheckCircle2, Circle, FileJson, Layers, LoaderCircle, MoreHorizontal, RefreshCw, Sparkles, Trash2, X } from "lucide-react";

import type { InstalledCustomApp } from "@/lib/custom-app-types";
import {
  readCustomAppCollection,
  uninstallCustomAppAsync,
  writeCustomAppCollection,
} from "@/lib/custom-app-storage";
import { formatCustomAppRegistrationRemovalSummary, removeCustomAppRegistrationsAsync } from "@/lib/custom-app-registration";
import { permissionLabelWithContext } from "@/lib/custom-app-permission-labels";
import { registerCustomAppToolExecutor, type CustomAppToolExecutorPayload } from "@/lib/custom-app-tool-runtime";
import { updateInstalledCustomAppFromMarket } from "@/lib/custom-app-market-update";
import { loadCharacters } from "@/lib/character-storage";
import { OnlineRoomConnection, onlineCloudApi } from "@/lib/online-room-client";
import { submitContentReport } from "@/lib/moderation-client";
import { hydrateKvDb } from "@/lib/kv-db";
import { ensureSettingsStorageHydrated } from "@/lib/settings-storage";
import {
  addChatContact,
  CHAT_MESSAGE_PUSHED_EVENT,
  createOrGetSession,
  hydrateChatStorage,
  loadChatContacts,
  loadChatSessions,
  type ChatMessage,
} from "@/lib/chat-storage";
import { deleteMediaRef, isMediaStoreRef, loadMediaBlob, storeMediaBase64 } from "@/lib/media-cache-storage";
import {
  addCustomAppMemory,
  addCustomAppTimelineEvent,
  activateCustomAppWorld,
  cancelCustomAppTask,
  cloneCustomAppVoice,
  createCustomAppNotification,
  deleteCustomAppTimelineEvent,
  fetchCustomAppNetwork,
  generateCustomAppGroupText,
  generateCustomAppImage,
  generateCustomAppText,
  isCustomAppGroupGenerateRecord,
  getCustomAppBadge,
  getWalletSnapshot,
  incrementCustomAppBadge,
  loadCustomAppNotifications,
  loadCustomAppTasks,
  markCustomAppNotificationsRead,
  payCustomAppWallet,
  readCustomAppCalendar,
  readCustomAppChatHistory,
  readCustomAppCharacterRelations,
  readCustomAppCharacterState,
  readCustomAppCoreMemory,
  readCustomAppLongTermMemory,
  readCustomAppShortTermMemory,
  readCustomAppUserPersona,
  readCustomAppUserPreferences,
  readCustomAppUserProfile,
  readCustomAppVoiceProfiles,
  readCustomAppWorld,
  recognizeCustomAppSpeech,
  requestCustomAppReply,
  runCustomAppAiChat,
  runCustomAppAiClassify,
  runCustomAppAiEmbed,
  searchCustomAppMemory,
  sendCustomAppTextMessage,
  scheduleCustomAppTask,
  sendCustomAppCard,
  saveCustomAppMedia,
  setCustomAppBadge,
  setCustomAppChatContactState,
  suggestCustomAppMemory,
  synthesizeCustomAppSpeech,
  updateCustomAppCard,
  writeCustomAppCalendar,
  writeCustomAppHistoryMessage,
  writeCustomAppCharacterState,
  writeCustomAppWorld,
} from "@/lib/custom-app-host-api";

type CustomAppRunnerProps = {
  app: InstalledCustomApp;
  onClose: () => void;
  onNotice?: (message: string) => void;
  launchContext?: Record<string, unknown> | null;
  embedded?: boolean;
  backgroundEvent?: {
    runId: string;
    eventName: string;
    payload: Record<string, unknown>;
    timeoutMs?: number;
  };
  onBackgroundEventComplete?: (runId: string, result: { ok: boolean; reason: string; errors?: string[] }) => void;
  backgroundTool?: {
    runId: string;
    payload: CustomAppToolExecutorPayload;
    timeoutMs?: number;
  };
  onBackgroundToolComplete?: (runId: string, result: { ok: boolean; reason: string; result?: unknown; error?: string }) => void;
};

type BridgeResult = unknown;

const EMPTY_CUSTOM_APP_SRC_DOC = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";
const CUSTOM_APP_BACKGROUND_RUNNER_TIMEOUT_MS = 5 * 60_000;

function normalizeAssetRef(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "");
}

function rewriteAssetRefs(html: string, app: InstalledCustomApp): string {
  let next = html;
  for (const asset of Object.values(app.assets)) {
    const escapedPath = asset.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dataUrl = asset.dataUrl.replace(/"/g, "&quot;");
    next = next.replace(new RegExp(`(src|href)=["'](?:\\./|/)?${escapedPath}["']`, "g"), `$1="${dataUrl}"`);
    next = next.replace(new RegExp(`url\\((["']?)(?:\\./|/)?${escapedPath}\\1\\)`, "g"), `url("${dataUrl}")`);
  }
  return next;
}

function createCustomAppSrcDoc(app: InstalledCustomApp, frameId: string, launchContext?: Record<string, unknown> | null, embedded = false): string {
  const body = rewriteAssetRefs(app.entryHtml.trim(), app);
  const base = /<html[\s>]/i.test(body)
    ? body
    : `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>${app.name}</title>
</head>
<body>
${body}
</body>
</html>`;

  const bridge = `<style id="ai-phone-app-host-style">
:root {
  --ai-phone-app-safe-top: ${embedded ? "0px" : "88px"};
  --ai-phone-app-safe-bottom: ${embedded ? "0px" : "24px"};
  --ai-phone-app-safe-left: ${embedded ? "0px" : "16px"};
  --ai-phone-app-safe-right: ${embedded ? "0px" : "16px"};
}
html, body { min-height: 100%; }
* { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
</style>
<script>
(function(){
  var frameId = ${JSON.stringify(frameId)};
  var appId = ${JSON.stringify(app.id)};
  var launchContext = ${JSON.stringify(launchContext ?? null)};
  var pending = {};
  var eventHandlers = {};
  var toolHandlers = {};
  var seq = 0;
  function request(action, payload){
    var requestId = frameId + '_' + (++seq);
    parent.postMessage({ source:'ai-phone-custom-app-frame', type:'request', frameId:frameId, appId:appId, requestId:requestId, action:action, payload:payload || {} }, '*');
    return new Promise(function(resolve, reject){
      pending[requestId] = { resolve: resolve, reject: reject };
    });
  }
  window.addEventListener('message', function(event){
    var data = event.data || {};
    if (data.source !== 'ai-phone-custom-app-host' || data.frameId !== frameId) return;
    if (data.type === 'tool.invoke' && data.toolRequestId) {
      var handlerKey = String(data.handler || data.toolId || data.toolName || '').trim();
      var handler = toolHandlers[handlerKey] || toolHandlers[String(data.toolId || '')] || toolHandlers[String(data.toolName || '')];
      Promise.resolve()
        .then(function(){
          if (typeof handler !== 'function') throw new Error('AiPhone tool handler not found: ' + handlerKey);
          return handler(data.args || {}, data.context || {});
        })
        .then(function(result){
          parent.postMessage({ source:'ai-phone-custom-app-frame', type:'tool.result', frameId:frameId, appId:appId, toolRequestId:data.toolRequestId, ok:true, result:result }, '*');
        })
        .catch(function(err){
          parent.postMessage({ source:'ai-phone-custom-app-frame', type:'tool.result', frameId:frameId, appId:appId, toolRequestId:data.toolRequestId, ok:false, error: err && err.message ? err.message : String(err) }, '*');
        });
      return;
    }
    if (data.type === 'event' && data.event) {
      var list = eventHandlers[data.event] || [];
      var wildcard = eventHandlers['*'] || [];
      var handlers = list.concat(wildcard);
      var jobs = handlers.map(function(handler){
        return Promise.resolve().then(function(){ return handler(data.payload, data.event); });
      });
      if (data.backgroundRunId) {
        Promise.allSettled(jobs).then(function(results){
          var errors = results.filter(function(item){ return item.status === 'rejected'; }).map(function(item){
            var reason = item.reason;
            return reason && reason.message ? reason.message : String(reason);
          });
          parent.postMessage({
            source:'ai-phone-custom-app-frame',
            type:'event.complete',
            frameId:frameId,
            appId:appId,
            backgroundRunId:data.backgroundRunId,
            event:data.event,
            ok:errors.length === 0,
            errors:errors
          }, '*');
        });
      } else {
        jobs.forEach(function(job){
          job.catch(function(err){ setTimeout(function(){ throw err; }, 0); });
        });
      }
      return;
    }
    if (!data.requestId) return;
    var item = pending[data.requestId];
    if (!item) return;
    delete pending[data.requestId];
    if (data.ok) item.resolve(data.result);
    else item.reject(new Error(data.error || 'AiPhone request failed'));
  });
  function onEvent(eventName, handler){
    var key = String(eventName || '').trim();
    if (!key) throw new Error('AiPhone.on requires an eventName');
    if (typeof handler !== 'function') throw new Error('AiPhone.on requires a handler function');
    if (!eventHandlers[key]) eventHandlers[key] = [];
    eventHandlers[key].push(handler);
    request('events.subscribe', { event: key }).catch(function(err){
      if (typeof console !== 'undefined' && console.warn) console.warn(err);
    });
    return function(){ offEvent(key, handler); };
  }
  function offEvent(eventName, handler){
    var key = String(eventName || '').trim();
    if (!key || !eventHandlers[key]) return false;
    if (typeof handler === 'function') {
      eventHandlers[key] = eventHandlers[key].filter(function(item){ return item !== handler; });
    } else {
      eventHandlers[key] = [];
    }
    if (eventHandlers[key].length === 0) {
      delete eventHandlers[key];
      request('events.unsubscribe', { event: key }).catch(function(){});
    }
    return true;
  }
  var api = {
    on: onEvent,
    off: offEvent,
    app: {
      getManifest: function(){ return request('app.getManifest'); },
      getCapabilities: function(){ return request('app.getCapabilities'); },
      getLaunchContext: function(){ return Promise.resolve(launchContext); },
      getAssetUrl: function(path){ return request('app.getAssetUrl', { path: path }); },
      close: function(){ return request('app.close'); }
    },
    db: {
      create: function(collection, data){ return request('db.create', { collection: collection, data: data }); },
      update: function(collection, id, patch){ return request('db.update', { collection: collection, id: id, patch: patch }); },
      get: function(collection, id){ return request('db.get', { collection: collection, id: id }); },
      list: function(collection, query){ return request('db.list', { collection: collection, query: query || {} }); },
      delete: function(collection, id){ return request('db.delete', { collection: collection, id: id }); }
    },
    ai: {
      generate: function(payload){ return request('ai.generate', payload || {}); },
      generateImage: function(payload){ return request('ai.generateImage', payload || {}); },
      chat: function(payload){ return request('ai.chat', payload || {}); },
      embed: function(payload){ return request('ai.embed', payload || {}); },
      classify: function(payload){ return request('ai.classify', payload || {}); }
    },
    user: {
      getProfile: function(payload){ return request('user.getProfile', payload || {}); },
      getPersona: function(payload){ return request('user.getPersona', payload || {}); },
      getPreferences: function(payload){ return request('user.getPreferences', payload || {}); }
    },
    network: {
      fetch: function(payload){ return request('network.fetch', payload || {}); }
    },
    voice: {
      readProfiles: function(payload){ return request('voice.readProfiles', payload || {}); },
      tts: function(payload){ return request('voice.tts', payload || {}); },
      stt: function(payload){ return request('voice.stt', payload || {}); },
      clone: function(payload){ return request('voice.clone', payload || {}); },
      play: function(payload){ return request('voice.play', payload || {}); },
      stopPlayback: function(payload){ return request('voice.stopPlayback', payload || {}); },
      pausePlayback: function(payload){ return request('voice.pausePlayback', payload || {}); },
      resumePlayback: function(payload){ return request('voice.resumePlayback', payload || {}); }
    },
    calendar: {
      read: function(payload){ return request('calendar.read', payload || {}); },
      list: function(payload){ return request('calendar.read', payload || {}); },
      write: function(payload){ return request('calendar.write', payload || {}); },
      create: function(payload){ return request('calendar.write', Object.assign({}, payload || {}, { operation: 'upsert' })); },
      update: function(payload){ return request('calendar.write', Object.assign({}, payload || {}, { operation: 'upsert' })); },
      delete: function(payload){ return request('calendar.write', Object.assign({}, payload || {}, { operation: 'delete' })); },
      replaceWeek: function(payload){ return request('calendar.write', Object.assign({}, payload || {}, { operation: 'replace' })); }
    },
    world: {
      read: function(payload){ return request('world.read', payload || {}); },
      list: function(payload){ return request('world.read', payload || {}); },
      get: function(id){ return request('world.read', { id: id }); },
      write: function(payload){ return request('world.write', payload || {}); },
      create: function(payload){ return request('world.write', Object.assign({}, payload || {}, { operation: 'create' })); },
      update: function(payload){ return request('world.write', Object.assign({}, payload || {}, { operation: 'upsert' })); },
      delete: function(payload){ return request('world.write', Object.assign({}, payload || {}, { operation: 'delete' })); },
      activate: function(payload){ return request('world.activate', payload || {}); }
    },
    media: {
      pick: function(payload){ return request('media.pick', payload || {}); },
      save: function(payload){ return request('media.save', payload || {}); },
      put: function(payload){ return request('media.put', payload || {}); },
      get: function(payload){ return request('media.get', payload || {}); },
      revoke: function(payload){ return request('media.revoke', payload || {}); },
      delete: function(payload){ return request('media.delete', payload || {}); }
    },
    geo: {
      get: function(payload){ return request('geo.get', payload || {}); },
      watch: function(payload){ return request('geo.watch.start', payload || {}); },
      clearWatch: function(){ return request('geo.watch.stop', {}); }
    },
    tools: {
      handle: function(name, handler){
        var key = String(name || '').trim();
        if (!key) throw new Error('AiPhone.tools.handle requires a tool name or tool id');
        if (typeof handler !== 'function') throw new Error('AiPhone.tools.handle requires a handler function');
        toolHandlers[key] = handler;
        request('tools.registerHandler', { name: key }).catch(function(err){
          if (typeof console !== 'undefined' && console.warn) console.warn(err);
        });
        return function(){
          if (toolHandlers[key] === handler) delete toolHandlers[key];
          request('tools.unregisterHandler', { name: key }).catch(function(){});
        };
      },
      invoke: function(name, args, context){ return request('tools.invoke', { name: name, args: args || {}, context: context || {} }); },
      list: function(){ return request('tools.list'); }
    },
    events: {
      subscribe: function(eventName){ return request('events.subscribe', { event: eventName }); },
      unsubscribe: function(eventName){ return request('events.unsubscribe', { event: eventName }); }
    },
    chat: {
      getCurrentSession: function(){ return request('chat.getCurrentSession'); },
      readHistory: function(payload){ return request('chat.readHistory', payload || {}); },
      sendMessage: function(payload){ return request('chat.sendMessage', payload || {}); },
      sendCard: function(payload){ return request('chat.sendCard', payload || {}); },
      updateCard: function(payload){ return request('chat.updateCard', payload || {}); },
      writeHistory: function(payload){ return request('chat.history', payload || {}); },
      pushHistory: function(payload){ return request('chat.history', payload || {}); },
      requestReply: function(payload){ return request('chat.requestReply', payload || {}); },
      openConversation: function(payload){ return request('chat.openConversation', payload || {}); },
      setContactState: function(payload){ return request('chat.setContactState', payload || {}); },
      block: function(characterId){ return request('chat.setContactState', { characterId: characterId, isBlacklisted: true }); },
      unblock: function(characterId){ return request('chat.setContactState', { characterId: characterId, isBlacklisted: false }); },
      mute: function(characterId){ return request('chat.setContactState', { characterId: characterId, isMuted: true }); },
      unmute: function(characterId){ return request('chat.setContactState', { characterId: characterId, isMuted: false }); }
    },
    characters: {
      list: function(){ return request('characters.list'); },
      get: function(id){ return request('characters.get', { id: id }); },
      readState: function(payload){ return request('characters.state.read', payload || {}); },
      writeState: function(payload){ return request('characters.state.write', payload || {}); },
      readRelations: function(payload){ return request('characters.relations.read', payload || {}); }
    },
    ui: {
      toast: function(message){ return request('ui.toast', { message: message }); },
      showNotification: function(payload){ return request('ui.showNotification', payload || {}); },
      showSmsThread: function(payload){ return request('ui.showSmsThread', payload || {}); },
      showCallScreen: function(payload){ return request('ui.showCallScreen', payload || {}); },
      confirm: function(payload){ return request('ui.confirm', payload || {}); }
    },
    notifications: {
      create: function(payload){ return request('notifications.create', payload || {}); },
      list: function(payload){ return request('notifications.list', payload || {}); },
      markRead: function(id){ return request('notifications.markRead', { id: id }); },
      markAllRead: function(){ return request('notifications.markAllRead'); },
      getBadge: function(){ return request('notifications.getBadge'); },
      setBadge: function(count){ return request('notifications.setBadge', { count: count }); },
      incrementBadge: function(delta){ return request('notifications.incrementBadge', { delta: delta }); },
      clearBadge: function(){ return request('notifications.setBadge', { count: 0 }); }
    },
    tasks: {
      schedule: function(payload){ return request('tasks.schedule', payload || {}); },
      list: function(){ return request('tasks.list'); },
      cancel: function(id){ return request('tasks.cancel', { id: id }); }
    },
    wallet: {
      get: function(){ return request('wallet.get'); },
      pay: function(payload){ return request('wallet.pay', payload || {}); }
    },
    room: {
      create: function(payload){ return request('room.create', payload || {}); },
      join: function(payload){ return request('room.join', payload || {}); },
      current: function(){ return request('room.current'); },
      send: function(payload){ return request('room.send', { payload: payload }); },
      setState: function(state){ return request('room.setState', { state: state }); },
      getState: function(){ return request('room.getState'); },
      players: function(){ return request('room.players'); },
      kick: function(userId){ return request('room.kick', { userId: userId }); },
      close: function(){ return request('room.close'); },
      leave: function(){ return request('room.leave'); },
      report: function(reason){ return request('room.report', { reason: reason }); }
    },
    cloud: {
      put: function(payload){ return request('cloud.put', payload || {}); },
      get: function(payload){ return request('cloud.get', typeof payload === 'string' ? { id: payload } : (payload || {})); },
      list: function(payload){ return request('cloud.list', payload || {}); },
      update: function(payload){ return request('cloud.update', payload || {}); },
      delete: function(payload){ return request('cloud.delete', typeof payload === 'string' ? { id: payload } : (payload || {})); },
      takeRandom: function(payload){ return request('cloud.takeRandom', payload || {}); },
      report: function(payload){ return request('cloud.report', payload || {}); }
    },
    memory: {
      readCore: function(payload){ return request('memory.readCore', payload || {}); },
      readLongTerm: function(payload){ return request('memory.readLongTerm', payload || {}); },
      readShortTerm: function(payload){ return request('memory.readShortTerm', payload || {}); },
      search: function(payload){ return request('memory.search', payload || {}); },
      add: function(payload){ return request('memory.add', payload || {}); },
      addTimeline: function(payload){ return request('memory.addTimeline', payload || {}); },
      deleteTimeline: function(payload){ return request('memory.deleteTimeline', payload || {}); },
      removeTimeline: function(payload){ return request('memory.deleteTimeline', payload || {}); },
      suggest: function(payload){ return request('memory.suggest', payload || {}); }
    }
  };
  window.AiPhone = Object.assign({}, window.AiPhone || {}, api);
  window.AiPhoneApp = window.AiPhone;
})();
</script>`;

  const safeBridge = bridge;
  if (/<head[\s>]/i.test(base)) {
    return base.replace(/<head([^>]*)>/i, `<head$1>${safeBridge}`);
  }
  if (/<body[\s>]/i.test(base)) {
    return base.replace(/<body([^>]*)>/i, `<body$1>${safeBridge}`);
  }
  return `${safeBridge}${base}`;
}

function hasPermission(app: InstalledCustomApp, permission: string): boolean {
  return app.permissions.includes(permission as never);
}

function collectionName(value: unknown): string {
  const text = String(value ?? "").trim().replace(/[^\w.-]+/g, "_").slice(0, 80);
  if (!text) throw new Error("collection cannot be empty.");
  return text;
}

function recordId(value?: unknown): string {
  const text = String(value ?? "").trim().slice(0, 120);
  return text || `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Media library (media.*) ──
// App audio/images are stored as Blobs in IndexedDB (reusing the chat media
// library); db records only store media-store:// references. A Blob is a
// disk-backed handle that doesn't occupy the JS heap and doesn't enter kv's
// full in-memory cache — this is the fundamental fix that keeps large voice
// libraries from crushing the page. Legacy dataURL data is left as-is and
// continues to be used as a string.
const CUSTOM_APP_MEDIA_REFS_COLLECTION = "__media_refs";
// Per-item media cap (based on base64 length, roughly 25MB), to prevent a
// single write from crashing the host process
const CUSTOM_APP_MEDIA_MAX_BASE64_LENGTH = 34_000_000;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Failed to read media"));
    reader.readAsDataURL(blob);
  });
}

// ── Host-side playback (voice.play) ──
// An <audio> element inside the app's sandboxed iframe would bind the iOS
// lock-screen media card to about:srcdoc (tapping it navigates the PWA to a
// blank page); meanwhile Web Audio output gets cut by the iOS mute switch.
// So playback must be handled by an <audio> element owned by the host page:
// the media card binds to the site itself, taps are harmless, and the mute
// switch doesn't affect the media element.
type FrameAudioChannel = { el: HTMLAudioElement; settle: (() => void) | null; objectUrl: string | null };

const FRAME_AUDIO_UNLOCK_WAV = "data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA";

function normalizeFrameAudioChannelName(value: unknown): string {
  return String(value ?? "voice") === "ambience" ? "ambience" : "voice";
}

function cleanupFrameAudioChannel(entry: FrameAudioChannel): void {
  const el = entry.el;
  el.onended = null;
  el.onerror = null;
  el.loop = false;
  // Clear src so iOS dismisses the lock-screen media card
  try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
  if (entry.objectUrl) {
    try { URL.revokeObjectURL(entry.objectUrl); } catch { /* ignore */ }
    entry.objectUrl = null;
  }
}

// iOS tracks playback unlock per element: play it once muted within the
// user-gesture window, and only then will a programmatic play() call avoid
// being blocked by the autoplay policy.
function unlockFrameAudioEl(el: HTMLAudioElement): void {
  if (el.dataset.unlocked === "1") return;
  try {
    el.muted = true;
    el.src = FRAME_AUDIO_UNLOCK_WAV;
    const p = el.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
        el.muted = false;
        el.dataset.unlocked = "1";
      }).catch(() => { el.muted = false; });
    } else {
      el.muted = false;
      el.dataset.unlocked = "1";
    }
  } catch { /* Unlock failure doesn't block anything; the app side still has a fallback on playback */ }
}

function ensureCharacterSession(characterId: string) {
  const contacts = loadChatContacts();
  if (!contacts.some(contact => contact.characterId === characterId)) {
    addChatContact(characterId);
  }
  return createOrGetSession(characterId);
}

function bridgeActionNeedsChatStorage(action: string): boolean {
  return action === "characters.state.read"
    || action === "characters.state.write"
    || action === "ai.generate"
    || action === "memory.readShortTerm"
    || action === "chat.readHistory"
    || action === "chat.sendMessage"
    || action === "chat.history"
    || action === "chat.writeHistory"
    || action === "chat.pushHistory"
    || action === "chat.sendCard"
    || action === "chat.updateCard"
    || action === "chat.openConversation"
    || action === "chat.requestReply"
    || action === "chat.setContactState";
}

function bridgeActionNeedsSettingsStorage(action: string): boolean {
  return action === "ai.generate"
    || action.startsWith("world.");
}

function bridgeActionNeedsKvStorage(action: string): boolean {
  return action.startsWith("db.")
    || action.startsWith("notifications.")
    || action.startsWith("tasks.")
    || action.startsWith("wallet.")
    || action.startsWith("memory.")
    || action.startsWith("calendar.")
    || action.startsWith("world.")
    || action.startsWith("voice.")
    || action.startsWith("ai.")
    || action === "user.getProfile"
    || action === "user.getPersona"
    || action === "user.getPreferences"
    || action === "chat.sendMessage"
    || action === "chat.history"
    || action === "chat.writeHistory"
    || action === "chat.pushHistory"
    || action === "chat.sendCard"
    || action === "chat.updateCard"
    || action === "chat.requestReply"
    || action === "chat.setContactState";
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

async function pickCustomAppMedia(record: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    // iOS's Files app often greys out specific files for broad audio/* / video/* accept
    // types, so add common extensions as a fallback
    let accept = typeof record.accept === "string" ? record.accept : "";
    if (accept === "audio/*") accept = "audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac,.opus";
    else if (accept === "video/*") accept = "video/*,.mp4,.mov,.m4v,.webm";
    input.accept = accept;
    input.multiple = record.multiple === true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "-9999px";
    document.body.appendChild(input);
    const cleanup = () => {
      input.remove();
      window.removeEventListener("focus", handleFocus);
    };
    const handleFocus = () => {
      window.setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          cleanup();
          resolve({ canceled: true, files: [] });
        }
      }, 600);
    };
    input.onchange = async () => {
      try {
        const files = Array.from(input.files ?? []);
        const limit = Math.max(1, Math.min(20, Number(record.limit ?? files.length) || files.length || 1));
        const picked = await Promise.all(files.slice(0, limit).map(async file => ({
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl: await fileToDataUrl(file),
        })));
        cleanup();
        resolve({ canceled: false, files: picked, file: picked[0] ?? null });
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    window.addEventListener("focus", handleFocus);
    input.click();
  });
}

function serializeBridgeChatMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: String(message.content ?? "").slice(0, 4000),
    createdAt: message.createdAt,
    status: message.status,
    senderName: message.senderName,
    mediaType: message.mediaType,
    mediaData: message.mediaData && typeof message.mediaData === "object" ? message.mediaData : undefined,
    isRetracted: message.isRetracted === true,
  };
}

function getCustomAppDeclaredEventNames(app: InstalledCustomApp): Set<string> {
  const canonical = app.manifest.extensions?.events ?? [];
  const legacy = app.manifest.events ?? [];
  const events = canonical.length > 0 ? canonical : legacy;
  return new Set(events.map(item => String(item.event ?? "").trim()).filter(Boolean));
}

function getCustomAppDeclaredToolKeys(app: InstalledCustomApp): Set<string> {
  const canonical = app.manifest.extensions?.tools ?? [];
  const legacy = app.manifest.extensions?.chat?.tools ?? app.manifest.chatExtensions?.tools ?? [];
  const tools = canonical.length > 0 ? canonical : legacy;
  const keys = new Set<string>();
  for (const tool of tools) {
    for (const value of [tool.id, tool.name, tool.handler, tool.entry]) {
      const key = String(value ?? "").trim();
      if (key) keys.add(key);
    }
  }
  return keys;
}

function buildLaunchEventPayload(app: InstalledCustomApp, launchContext?: Record<string, unknown> | null): Record<string, unknown> {
  return {
    appId: app.id,
    appName: app.name,
    launchContext: launchContext ?? null,
    launchedAt: new Date().toISOString(),
  };
}

function toolInvocationKeys(payload: CustomAppToolExecutorPayload): string[] {
  return Array.from(new Set([
    payload.tool.handler,
    payload.tool.entry,
    payload.tool.id,
    payload.tool.name,
  ].map(value => String(value ?? "").trim()).filter(Boolean)));
}

function serializeToolContext(context: CustomAppToolExecutorPayload["context"]): Record<string, unknown> {
  if (!context) return {};
  return {
    appId: context.appId,
    sessionId: context.sessionId,
    characterId: context.characterId,
    sourceEngine: context.sourceEngine,
  };
}

export function CustomAppRunner({
  app,
  onClose,
  onNotice,
  launchContext,
  embedded = false,
  backgroundEvent,
  onBackgroundEventComplete,
  backgroundTool,
  onBackgroundToolComplete,
}: CustomAppRunnerProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const subscribedEventsRef = useRef<Set<string>>(new Set());
  const geoWatchIdRef = useRef<number | null>(null);
  const backgroundEventSentRef = useRef(false);
  const backgroundEventCompletedRef = useRef(false);
  const backgroundToolSentRef = useRef(false);
  const backgroundToolCompletedRef = useRef(false);
  const pendingToolInvocationsRef = useRef<Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>>(new Map());
  const registeredToolHandlersRef = useRef<Set<string>>(new Set());
  const frameAudioChannelsRef = useRef<Map<string, FrameAudioChannel>>(new Map());
  const frameObjectUrlsRef = useRef<Set<string>>(new Set());
  const onlineRoomRef = useRef<OnlineRoomConnection | null>(null);

  // The online room follows the app's lifecycle: closing the app leaves the room (host leaving = closing the room)
  useEffect(() => () => {
    onlineRoomRef.current?.leave();
    onlineRoomRef.current = null;
  }, []);
  const [frameId] = useState(() => `custom_app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const [bridgeReady, setBridgeReady] = useState(false);
  const isBackgroundRunner = Boolean(backgroundEvent || backgroundTool);
  const effectiveEmbedded = embedded || isBackgroundRunner;
  const srcDoc = useMemo(() => createCustomAppSrcDoc(app, frameId, launchContext, effectiveEmbedded), [app, frameId, launchContext, effectiveEmbedded]);
  const declaredEvents = useMemo(() => getCustomAppDeclaredEventNames(app), [app]);
  const declaredToolKeys = useMemo(() => getCustomAppDeclaredToolKeys(app), [app]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [menuActionError, setMenuActionError] = useState("");
  const launchSource = launchContext && typeof launchContext === "object" ? String(launchContext.source ?? "") : "";
  const closeLabel = launchSource === "chat_plus_action" || launchSource === "chat_card" || launchSource === "chat_directive"
    ? "Back to Chat"
    : "Back to Home";

  const getFrameAudioChannel = useCallback((name: string): FrameAudioChannel => {
    let entry = frameAudioChannelsRef.current.get(name);
    if (!entry) {
      const el = new Audio();
      el.setAttribute("playsinline", "");
      entry = { el, settle: null, objectUrl: null };
      frameAudioChannelsRef.current.set(name, entry);
    }
    return entry;
  }, []);

  // Mounting happens within the task of the "open app" click (useLayoutEffect runs
  // synchronously), so we unlock the playback elements while inside the gesture
  // window; any later touch on the host layer (e.g. the back capsule) will also
  // re-trigger the unlock.
  useLayoutEffect(() => {
    const unlockAll = () => {
      unlockFrameAudioEl(getFrameAudioChannel("voice").el);
      unlockFrameAudioEl(getFrameAudioChannel("ambience").el);
    };
    unlockAll();
    window.addEventListener("pointerdown", unlockAll, { passive: true });
    window.addEventListener("touchend", unlockAll, { passive: true });
    const channels = frameAudioChannelsRef.current;
    const objectUrls = frameObjectUrlsRef.current;
    return () => {
      window.removeEventListener("pointerdown", unlockAll);
      window.removeEventListener("touchend", unlockAll);
      for (const entry of channels.values()) {
        const settle = entry.settle;
        entry.settle = null;
        cleanupFrameAudioChannel(entry);
        settle?.();
      }
      channels.clear();
      for (const url of objectUrls) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }
      objectUrls.clear();
    };
  }, [getFrameAudioChannel]);

  const handleUninstall = useCallback(async (deleteData: boolean) => {
    const removal = await removeCustomAppRegistrationsAsync(app.id, { deleteResources: deleteData });
    const removalText = formatCustomAppRegistrationRemovalSummary(removal);
    await uninstallCustomAppAsync(app.id, { deleteData });
    const base = deleteData ? `Uninstalled "${app.name}" and deleted its data` : `Uninstalled "${app.name}"`;
    onNotice?.(removalText ? `${base}，${removalText}` : base);
    onClose();
  }, [app, onNotice, onClose]);

  const updateCurrentApp = useCallback(async () => {
    if (updating) return;
    setUpdating(true);
    setMenuActionError("");
    try {
      const result = await updateInstalledCustomAppFromMarket(app);
      setMenuOpen(false);
      onNotice?.(result.previousVersion === result.installed.version
        ? `Synced "${result.installed.name}"`
        : `Updated "${result.installed.name}" to v${result.installed.version}`);
    } catch (err) {
      setMenuActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  }, [app, onNotice, updating]);

  const postResponse = useCallback((requestId: string, ok: boolean, result?: BridgeResult, error?: string) => {
    iframeRef.current?.contentWindow?.postMessage({
      source: "ai-phone-custom-app-host",
      type: "response",
      frameId,
      requestId,
      ok,
      result,
      error,
    }, "*");
  }, [frameId]);

  const completeBackgroundEvent = useCallback((result: { ok: boolean; reason: string; errors?: string[] }) => {
    if (!backgroundEvent || backgroundEventCompletedRef.current) return;
    backgroundEventCompletedRef.current = true;
    onBackgroundEventComplete?.(backgroundEvent.runId, result);
  }, [backgroundEvent, onBackgroundEventComplete]);

  const completeBackgroundTool = useCallback((result: { ok: boolean; reason: string; result?: unknown; error?: string }) => {
    if (!backgroundTool || backgroundToolCompletedRef.current) return;
    backgroundToolCompletedRef.current = true;
    onBackgroundToolComplete?.(backgroundTool.runId, result);
  }, [backgroundTool, onBackgroundToolComplete]);

  const postBackgroundEventIfReady = useCallback(() => {
    if (!backgroundEvent || backgroundEventSentRef.current) return;
    if (!subscribedEventsRef.current.has(backgroundEvent.eventName) && !subscribedEventsRef.current.has("*")) return;
    backgroundEventSentRef.current = true;
    iframeRef.current?.contentWindow?.postMessage({
      source: "ai-phone-custom-app-host",
      type: "event",
      frameId,
      event: backgroundEvent.eventName,
      payload: backgroundEvent.payload,
      backgroundRunId: backgroundEvent.runId,
    }, "*");
  }, [backgroundEvent, frameId]);

  // Stop location watching when the app closes/unmounts the runner, to avoid wasting battery in the background
  useEffect(() => () => {
    if (geoWatchIdRef.current != null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(geoWatchIdRef.current);
    }
    geoWatchIdRef.current = null;
  }, []);

  const postHostEvent = useCallback((eventName: string, payload: Record<string, unknown>) => {
    if (!subscribedEventsRef.current.has(eventName) && !subscribedEventsRef.current.has("*")) return;
    iframeRef.current?.contentWindow?.postMessage({
      source: "ai-phone-custom-app-host",
      type: "event",
      frameId,
      event: eventName,
      payload,
    }, "*");
  }, [frameId]);

  const invokeOpenAppTool = useCallback((payload: CustomAppToolExecutorPayload) => (
    new Promise<unknown>((resolve, reject) => {
      const toolRequestId = `${frameId}_tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      pendingToolInvocationsRef.current.set(toolRequestId, { resolve, reject });
      iframeRef.current?.contentWindow?.postMessage({
        source: "ai-phone-custom-app-host",
        type: "tool.invoke",
        frameId,
        toolRequestId,
        toolId: payload.tool.id,
        toolName: payload.tool.name,
        handler: payload.tool.handler || payload.tool.entry || payload.tool.id,
        args: payload.args,
        context: serializeToolContext(payload.context),
      }, "*");
    })
  ), [frameId]);

  const postBackgroundToolIfReady = useCallback(() => {
    if (!backgroundTool || backgroundToolSentRef.current) return;
    const keys = toolInvocationKeys(backgroundTool.payload);
    if (!keys.some(key => registeredToolHandlersRef.current.has(key))) return;
    backgroundToolSentRef.current = true;
    void invokeOpenAppTool(backgroundTool.payload)
      .then(result => completeBackgroundTool({ ok: true, reason: "completed", result }))
      .catch(err => completeBackgroundTool({
        ok: false,
        reason: "failed",
        error: err instanceof Error ? err.message : String(err),
      }));
  }, [backgroundTool, completeBackgroundTool, invokeOpenAppTool]);

  const requirePermission = useCallback((permission: string) => {
    if (!hasPermission(app, permission)) {
      throw new Error(`App has not declared permission: ${permission}`);
    }
  }, [app]);

  const requireAnyPermission = useCallback((permissions: string[]) => {
    if (permissions.some(permission => hasPermission(app, permission))) return;
    throw new Error(`App has not declared permission: ${permissions.join(" or ")}`);
  }, [app]);

  const handleBridgeRequest = useCallback(async (action: string, payload: unknown): Promise<BridgeResult> => {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const launchRecord = launchContext && typeof launchContext === "object" ? launchContext : {};
    const backgroundRecord = launchRecord.origin === "custom_app_background" && !record.origin
      ? { ...record, origin: "custom_app_background" }
      : record;
    if (bridgeActionNeedsKvStorage(action)) {
      await hydrateKvDb();
    }
    if (bridgeActionNeedsSettingsStorage(action)) {
      await ensureSettingsStorageHydrated();
    }
    if (bridgeActionNeedsChatStorage(action)) {
      await hydrateChatStorage();
    }

    if (action === "app.getManifest") return app.manifest;
    if (action === "app.getCapabilities") {
      return {
        sdkVersion: app.manifest.sdkVersion || "1.0",
        permissions: app.permissions,
        resources: app.manifest.resources ?? {},
        extensions: app.manifest.extensions ?? {},
        promptProfiles: app.manifest.extensions?.prompt?.profiles ?? app.manifest.promptProfiles ?? [],
        events: app.manifest.extensions?.events ?? app.manifest.events ?? [],
        network: app.manifest.network ?? {},
        sdk: {
          app: ["getManifest", "getCapabilities", "getLaunchContext", "getAssetUrl", "close"],
          ai: ["generate", "chat", "embed", "classify"],
          user: ["getProfile", "getPersona", "getPreferences"],
          network: ["fetch"],
          voice: ["readProfiles", "tts", "stt", "clone", "play", "stopPlayback", "pausePlayback", "resumePlayback"],
          calendar: ["read", "list", "write", "create", "update", "delete", "replaceWeek"],
          world: ["read", "list", "get", "write", "create", "update", "delete", "activate"],
          media: ["pick", "save", "put", "get", "revoke", "delete"],
          characters: ["list", "get", "readState", "writeState", "readRelations"],
          chat: ["getCurrentSession", "readHistory", "sendMessage", "sendCard", "updateCard", "writeHistory", "requestReply", "openConversation", "setContactState"],
          memory: ["readCore", "readLongTerm", "readShortTerm", "search", "add", "addTimeline", "deleteTimeline", "removeTimeline", "suggest"],
          notifications: ["create", "list", "markRead", "markAllRead", "getBadge", "setBadge", "incrementBadge", "clearBadge"],
          tasks: ["schedule", "list", "cancel"],
          wallet: ["get", "pay"],
          geo: ["get", "watch", "clearWatch"],
        },
      };
    }
    if (action === "app.close") {
      onClose();
      return true;
    }
    if (action === "app.getAssetUrl") {
      const path = normalizeAssetRef(String(record.path ?? ""));
      return app.assets[path]?.dataUrl ?? "";
    }

    if (action === "events.subscribe") {
      const eventName = String(record.event ?? record.name ?? "").trim();
      if (!eventName) throw new Error("events.subscribe is missing event.");
      if (!declaredEvents.has(eventName) && !declaredEvents.has("*")) {
        throw new Error(`manifest.extensions.events does not declare event: ${eventName}`);
      }
      if (eventName === "chat.message.created") requireAnyPermission(["chat.read", "chat.read.background"]);
      subscribedEventsRef.current.add(eventName);
      if (eventName === "app.launched") {
        window.setTimeout(() => postHostEvent("app.launched", buildLaunchEventPayload(app, launchContext)), 0);
      }
      if (backgroundEvent && (eventName === backgroundEvent.eventName || eventName === "*")) {
        window.setTimeout(postBackgroundEventIfReady, 0);
      }
      return { ok: true, event: eventName };
    }

    if (action === "events.unsubscribe") {
      const eventName = String(record.event ?? record.name ?? "").trim();
      if (!eventName) return true;
      subscribedEventsRef.current.delete(eventName);
      return true;
    }

    if (action === "tools.registerHandler") {
      requirePermission("chat.tools");
      const toolKey = String(record.name ?? record.id ?? record.tool ?? "").trim();
      if (!toolKey) throw new Error("tools.registerHandler is missing a tool name.");
      if (declaredToolKeys.size > 0 && !declaredToolKeys.has(toolKey)) {
        throw new Error(`manifest.extensions.tools does not declare tool handler: ${toolKey}`);
      }
      registeredToolHandlersRef.current.add(toolKey);
      if (backgroundTool) window.setTimeout(postBackgroundToolIfReady, 0);
      return { ok: true, name: toolKey };
    }

    if (action === "tools.unregisterHandler") {
      const toolKey = String(record.name ?? record.id ?? record.tool ?? "").trim();
      if (toolKey) registeredToolHandlersRef.current.delete(toolKey);
      return true;
    }

    if (action === "tools.list") {
      requirePermission("chat.tools");
      const { getEnabledTools } = await import("@/lib/tool-storage");
      return getEnabledTools(`custom_app:${app.id}`).map(tool => ({
        name: tool.name,
        description: tool.description,
        source: tool.source,
        sourceId: tool.sourceId,
        parameterSchema: tool.parameterSchema,
      }));
    }

    if (action === "tools.invoke") {
      requirePermission("chat.tools");
      const name = String(record.name ?? record.tool ?? "").trim();
      if (!name) throw new Error("tools.invoke is missing a tool name.");
      const args = record.args && typeof record.args === "object" && !Array.isArray(record.args)
        ? record.args as Record<string, unknown>
        : {};
      const rawContext = record.context && typeof record.context === "object" && !Array.isArray(record.context)
        ? record.context as Record<string, unknown>
        : {};
      const launch = launchContext && typeof launchContext === "object" ? launchContext : {};
      const characterId = String(rawContext.characterId ?? record.characterId ?? launch.characterId ?? "").trim() || undefined;
      const sessionId = String(rawContext.sessionId ?? record.sessionId ?? launch.sessionId ?? "").trim() || undefined;
      const { executeToolCalls } = await import("@/lib/tool-executor");
      const [result] = await executeToolCalls([{ name, args }], {
        appId: `custom_app:${app.id}`,
        sessionId,
        characterId,
        sourceEngine: "custom_app",
      });
      return result ?? { name, success: false, error: "Tool returned no result." };
    }

    if (action.startsWith("room.") || action.startsWith("cloud.")) {
      requirePermission("online.play");
      const namespace = `custom_app:${app.id}`;

      if (action.startsWith("cloud.")) {
        const cloudAction = action.slice("cloud.".length);
        if (cloudAction === "report") {
          const reportId = String(record.id ?? "").trim();
          if (!reportId) throw new Error("cloud.report is missing id.");
          await submitContentReport({
            contentType: "online_doc",
            contentId: reportId,
            reason: String(record.reason ?? "").slice(0, 500),
          });
          return true;
        }
        if (!["put", "get", "list", "update", "delete", "takeRandom"].includes(cloudAction)) {
          throw new Error(`Unknown cloud action: ${action}`);
        }
        const response = await onlineCloudApi({
          action: cloudAction,
          namespace,
          collection: record.collection,
          id: record.id,
          data: record.data,
          sortKey: record.sortKey,
          limit: record.limit,
          mine: record.mine,
          orderBy: record.orderBy,
        });
        if (cloudAction === "list") return response.docs;
        if (cloudAction === "delete") return { deleted: response.deleted === true };
        return response.doc ?? null;
      }

      const publicRoomInfo = (connection: OnlineRoomConnection) => ({
        id: connection.info.id,
        code: connection.info.code,
        title: connection.info.title,
        maxPlayers: connection.info.maxPlayers,
        meta: connection.info.meta,
        hostUserId: connection.info.hostUserId,
        hostName: connection.info.hostName,
        isHost: connection.info.isHost,
        selfUserId: connection.selfUserId,
        selfName: connection.selfName,
        players: connection.players(),
      });
      const current = onlineRoomRef.current && !onlineRoomRef.current.isClosed ? onlineRoomRef.current : null;

      if (action === "room.create" || action === "room.join") {
        if (current) {
          current.leave();
          onlineRoomRef.current = null;
        }
        const events = {
          onMessage: (message: { from: { userId: string; name: string }; payload: unknown; sentAt: number }) => {
            postHostEvent("room.message", { from: message.from, payload: message.payload, sentAt: message.sentAt });
          },
          onPlayers: (players: unknown[]) => postHostEvent("room.players", { players }),
          onState: (state: Record<string, unknown>) => postHostEvent("room.state", { state }),
          onClosed: (reason: string) => {
            onlineRoomRef.current = null;
            postHostEvent("room.closed", { reason });
          },
        };
        const connection = action === "room.create"
          ? await OnlineRoomConnection.create({
            namespace,
            title: typeof record.title === "string" ? record.title : "",
            maxPlayers: Number(record.maxPlayers ?? 8) || 8,
            meta: record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
              ? record.meta as Record<string, unknown>
              : {},
          }, events)
          : await OnlineRoomConnection.join({ namespace, code: String(record.code ?? "") }, events);
        onlineRoomRef.current = connection;
        return publicRoomInfo(connection);
      }

      if (action === "room.current") {
        return current ? { ...publicRoomInfo(current), state: current.state() } : null;
      }
      if (action === "room.leave") {
        if (current) {
          current.leave();
          onlineRoomRef.current = null;
        }
        return true;
      }
      if (!current) throw new Error("No online room is currently connected. Call room.create or room.join first.");
      if (action === "room.report") {
        await submitContentReport({
          contentType: "online_room",
          contentId: current.info.id,
          reason: String(record.reason ?? "").slice(0, 500),
        });
        return true;
      }
      if (action === "room.send") {
        await current.send(record.payload ?? record.data ?? record.message ?? null);
        return true;
      }
      if (action === "room.setState") {
        const state = record.state ?? record.data;
        if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("room.setState requires an object state.");
        await current.setState(state as Record<string, unknown>);
        return true;
      }
      if (action === "room.getState") return current.state();
      if (action === "room.players") return current.players();
      if (action === "room.kick") {
        await current.kick(String(record.userId ?? ""));
        return true;
      }
      if (action === "room.close") {
        await current.close();
        onlineRoomRef.current = null;
        return true;
      }
      throw new Error(`Unknown online action: ${action}`);
    }

    if (action.startsWith("db.")) {
      if (action === "db.list" || action === "db.get") requirePermission("app.data.read");
      else requirePermission("app.data.write");
      const collection = collectionName(record.collection);
      const rows = readCustomAppCollection(app.id, collection);
      if (action === "db.create") {
        const row = {
          ...(record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {}),
          id: recordId((record.data as Record<string, unknown> | undefined)?.id),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        writeCustomAppCollection(app.id, collection, [row, ...rows]);
        return row;
      }
      if (action === "db.update") {
        const id = recordId(record.id);
        const patch = record.patch && typeof record.patch === "object" ? record.patch as Record<string, unknown> : {};
        let updated: Record<string, unknown> | null = null;
        writeCustomAppCollection(app.id, collection, rows.map(row => {
          if (String(row.id) !== id) return row;
          updated = { ...row, ...patch, id, updatedAt: new Date().toISOString() };
          return updated;
        }));
        return updated;
      }
      if (action === "db.get") {
        const id = recordId(record.id);
        return rows.find(row => String(row.id) === id) ?? null;
      }
      if (action === "db.list") {
        const limit = Math.max(1, Math.min(500, Number((record.query as Record<string, unknown> | undefined)?.limit ?? 100) || 100));
        return rows.slice(0, limit);
      }
      if (action === "db.delete") {
        const id = recordId(record.id);
        writeCustomAppCollection(app.id, collection, rows.filter(row => String(row.id) !== id));
        return true;
      }
    }

    if (action === "user.getProfile") {
      requirePermission("user.profile.read");
      return readCustomAppUserProfile(app, record);
    }
    if (action === "user.getPersona") {
      requirePermission("user.persona.read");
      return readCustomAppUserPersona(app, record);
    }
    if (action === "user.getPreferences") {
      requirePermission("user.preferences.read");
      return readCustomAppUserPreferences(app, record);
    }
    if (action === "network.fetch") {
      requirePermission("network.fetch");
      return fetchCustomAppNetwork(app, record);
    }

    if (action === "voice.play") {
      requirePermission("voice.tts");
      const channel = normalizeFrameAudioChannelName(record.channel);
      const rawSrc = String(record.dataUrl ?? record.src ?? record.ref ?? "");
      let src = rawSrc;
      let mediaObjectUrl: string | null = null;
      if (isMediaStoreRef(rawSrc)) {
        // Media library reference: the host reads the Blob directly and converts it to an
        // objectURL, so audio data doesn't cross the bridge
        const media = await loadMediaBlob(rawSrc);
        if (!media) throw new Error("voice.play could not find the media, it may have been deleted.");
        mediaObjectUrl = URL.createObjectURL(media.blob);
        src = mediaObjectUrl;
      } else if (!src.startsWith("data:audio/") && !src.startsWith("blob:")) {
        throw new Error("voice.play requires an audio dataUrl or a media-store:// reference.");
      }
      const entry = getFrameAudioChannel(channel);
      const prevSettle = entry.settle;
      entry.settle = null;
      cleanupFrameAudioChannel(entry);
      prevSettle?.();
      const el = entry.el;
      entry.objectUrl = mediaObjectUrl;
      el.loop = record.loop === true;
      const volume = Number(record.volume);
      el.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
      el.src = src;
      if (el.loop) {
        try { await el.play(); } catch (err) {
          cleanupFrameAudioChannel(entry);
          throw new Error(`Host audio playback was blocked: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { ok: true, loop: true };
      }
      return await new Promise((resolve, reject) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (entry.settle === settle) entry.settle = null;
          cleanupFrameAudioChannel(entry);
          resolve({ ok: true });
        };
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          if (entry.settle === settle) entry.settle = null;
          cleanupFrameAudioChannel(entry);
          reject(new Error(message));
        };
        entry.settle = settle;
        el.onended = settle;
        el.onerror = () => fail("Host audio decoding or playback failed");
        const p = el.play();
        if (p && typeof p.catch === "function") {
          p.catch(err => fail(`Host audio playback was blocked: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    }
    if (action === "media.put") {
      requirePermission("app.data.write");
      const dataUrl = String(record.dataUrl ?? "");
      let base64 = String(record.base64 ?? "");
      let declaredMime = String(record.mime ?? "").trim() || undefined;
      if (dataUrl.startsWith("data:")) {
        const comma = dataUrl.indexOf(",");
        if (comma < 0) throw new Error("media.put dataUrl format is invalid.");
        declaredMime = declaredMime || dataUrl.slice(5, comma).split(";")[0] || undefined;
        base64 = dataUrl.slice(comma + 1);
      }
      if (!base64) throw new Error("media.put requires dataUrl or base64.");
      if (base64.length > CUSTOM_APP_MEDIA_MAX_BASE64_LENGTH) {
        throw new Error("media.put: a single media file cannot exceed 25MB.");
      }
      const stored = await storeMediaBase64(base64, declaredMime);
      const refRows = readCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION);
      writeCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION, [
        { id: stored.ref, mime: stored.mime, category: stored.category, createdAt: new Date().toISOString() },
        ...refRows,
      ]);
      return { ref: stored.ref, mime: stored.mime, category: stored.category };
    }
    if (action === "media.get") {
      requirePermission("app.data.read");
      const ref = String(record.ref ?? record.id ?? "");
      if (!isMediaStoreRef(ref)) throw new Error("media.get requires a media-store:// reference.");
      const refRows = readCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION);
      if (!refRows.some(row => String(row.id) === ref)) {
        throw new Error("media.get can only read media stored by this app.");
      }
      const media = await loadMediaBlob(ref);
      if (!media) return null;
      // Always return a dataURL: a blob objectURL created by the host would be rejected
      // by same-origin rules inside the sandboxed iframe (opaque origin), so the app
      // couldn't use it at all. Audio playback goes through voice.play (host self-plays)
      // and doesn't pass through here, so the only remaining memory concern is "the
      // image currently being displayed," which is acceptable.
      return { ref, mime: media.mimeType, dataUrl: await blobToDataUrl(media.blob) };
    }
    if (action === "media.revoke") {
      requirePermission("app.data.read");
      const url = String(record.url ?? record.objectUrl ?? "");
      if (frameObjectUrlsRef.current.has(url)) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        frameObjectUrlsRef.current.delete(url);
      }
      return { ok: true };
    }
    if (action === "media.delete") {
      requirePermission("app.data.write");
      const ref = String(record.ref ?? record.id ?? "");
      if (!isMediaStoreRef(ref)) return { ok: true };
      const refRows = readCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION);
      if (refRows.some(row => String(row.id) === ref)) {
        writeCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION, refRows.filter(row => String(row.id) !== ref));
        await deleteMediaRef(ref);
      }
      return { ok: true };
    }
    if (action === "voice.stopPlayback") {
      requirePermission("voice.tts");
      const entry = frameAudioChannelsRef.current.get(normalizeFrameAudioChannelName(record.channel));
      if (entry) {
        const settle = entry.settle;
        entry.settle = null;
        cleanupFrameAudioChannel(entry);
        settle?.();
      }
      return { ok: true };
    }
    if (action === "voice.pausePlayback") {
      requirePermission("voice.tts");
      const entry = frameAudioChannelsRef.current.get(normalizeFrameAudioChannelName(record.channel));
      if (entry) { try { entry.el.pause(); } catch { /* ignore */ } }
      return { ok: true };
    }
    if (action === "voice.resumePlayback") {
      requirePermission("voice.tts");
      const entry = frameAudioChannelsRef.current.get(normalizeFrameAudioChannelName(record.channel));
      if (entry && entry.el.src) { void entry.el.play().catch(() => { /* ignore */ }); }
      return { ok: true };
    }

    if (action === "voice.readProfiles") {
      requirePermission("voice.readProfiles");
      return readCustomAppVoiceProfiles(app, record);
    }
    if (action === "voice.tts") {
      requirePermission("voice.tts");
      return synthesizeCustomAppSpeech(app, record);
    }
    if (action === "voice.stt") {
      requirePermission("voice.stt");
      return recognizeCustomAppSpeech(app, record);
    }
    if (action === "voice.clone") {
      requirePermission("voice.clone");
      return cloneCustomAppVoice(app, record);
    }

    if (action === "calendar.read") {
      requirePermission("calendar.read");
      return readCustomAppCalendar(record);
    }
    if (action === "calendar.write") {
      requirePermission("calendar.write");
      return writeCustomAppCalendar(record);
    }

    if (action === "world.read") {
      requirePermission("world.read");
      return readCustomAppWorld(record);
    }
    if (action === "world.write") {
      requirePermission("world.write");
      return writeCustomAppWorld(app, record);
    }
    if (action === "world.activate") {
      requirePermission("world.activate");
      return activateCustomAppWorld(app, record);
    }

    if (action === "media.pick") {
      requirePermission("media.pick");
      return pickCustomAppMedia(record);
    }
    if (action === "media.save") {
      requirePermission("media.save");
      return saveCustomAppMedia(record);
    }

    // Geolocation: the sandboxed iframe is an opaque origin and can't get navigator.geolocation
    // permission, so the host page proxies it
    if (action === "geo.get") {
      requirePermission("geo.read");
      return new Promise((resolve, reject) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          reject(new Error("Location is not supported on this device or environment."));
          return;
        }
        navigator.geolocation.getCurrentPosition(
          pos => resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp,
          }),
          err => reject(new Error(err?.message ? `Location failed: ${err.message}` : "Location failed or was not authorized.")),
          {
            enableHighAccuracy: record.highAccuracy !== false,
            timeout: Math.min(30000, Math.max(1000, Number(record.timeoutMs) || 10000)),
            maximumAge: Math.max(0, Number(record.maximumAgeMs) || 30000),
          },
        );
      });
    }
    if (action === "geo.watch.start") {
      requirePermission("geo.watch");
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        throw new Error("Location is not supported on this device or environment.");
      }
      if (geoWatchIdRef.current != null) navigator.geolocation.clearWatch(geoWatchIdRef.current);
      geoWatchIdRef.current = navigator.geolocation.watchPosition(
        pos => postHostEvent("geo.position", {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }),
        err => postHostEvent("geo.error", { message: err?.message ?? "Location failed" }),
        { enableHighAccuracy: record.highAccuracy !== false, maximumAge: Math.max(0, Number(record.maximumAgeMs) || 5000) },
      );
      return { ok: true };
    }
    if (action === "geo.watch.stop") {
      if (geoWatchIdRef.current != null && typeof navigator !== "undefined" && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoWatchIdRef.current);
      }
      geoWatchIdRef.current = null;
      return true;
    }

    if (action === "characters.list") {
      requirePermission("characters.read");
      return loadCharacters().map(character => ({
        id: character.id,
        name: character.name,
        avatar: character.avatar,
        persona: character.persona,
        personality: character.personality,
      }));
    }
    if (action === "characters.get") {
      requirePermission("characters.read");
      return loadCharacters().find(character => character.id === String(record.id ?? "")) ?? null;
    }
    if (action === "characters.state.read") {
      requirePermission("characters.state.read");
      return readCustomAppCharacterState(record);
    }
    if (action === "characters.state.write") {
      requirePermission("characters.state.write");
      return writeCustomAppCharacterState(app, record);
    }
    if (action === "characters.relations.read") {
      requirePermission("characters.relations.read");
      return readCustomAppCharacterRelations(record);
    }

    if (action === "chat.getCurrentSession") {
      requireAnyPermission(["chat.read", "chat.read.background"]);
      return launchContext && typeof launchContext === "object" ? launchContext : null;
    }

    if (action === "chat.readHistory") {
      requireAnyPermission(["chat.read", "chat.read.background"]);
      const mergedRecord = {
        ...launchRecord,
        ...record,
      };
      return readCustomAppChatHistory(mergedRecord);
    }

    if (action === "chat.sendMessage") {
      requireAnyPermission(["chat.write", "chat.sendMessage"]);
      const result = sendCustomAppTextMessage(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, ...result };
    }

    if (action === "chat.history" || action === "chat.writeHistory" || action === "chat.pushHistory") {
      requireAnyPermission(["chat.write", "chat.sendMessage"]);
      const result = writeCustomAppHistoryMessage(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, ...result };
    }

    if (action === "chat.sendCard") {
      requirePermission("chat.sendCard");
      const result = sendCustomAppCard(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, sessionId: result.sessionId, messageId: result.messageId };
    }

    if (action === "chat.updateCard") {
      requireAnyPermission(["chat.write", "chat.sendCard"]);
      const result = updateCustomAppCard(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, ...result };
    }

    if (action === "chat.openConversation") {
      const characterId = String(record.characterId ?? "").trim();
      if (!characterId) throw new Error("chat.openConversation is missing characterId.");
      const session = ensureCharacterSession(characterId);
      window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "chat", sessionId: session.id } }));
      return { sessionId: session.id };
    }

    if (action === "chat.requestReply") {
      requirePermission("chat.requestReply");
      const result = await requestCustomAppReply(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, ...result };
    }

    if (action === "chat.setContactState") {
      requirePermission("chat.contacts.write");
      return setCustomAppChatContactState(record);
    }

    if (action === "ai.generate") {
      requirePermission("ai.generate");
      // Routing only looks at params explicitly passed by the app, to avoid the sessionId
      // in launchContext accidentally triggering group chat mode
      return isCustomAppGroupGenerateRecord(record)
        ? generateCustomAppGroupText(app, { ...launchRecord, ...record })
        : generateCustomAppText(app, { ...launchRecord, ...record });
    }
    if (action === "ai.generateImage") {
      requirePermission("ai.generateImage");
      return generateCustomAppImage(app, { ...launchRecord, ...record });
    }
    if (action === "ai.chat") {
      requirePermission("ai.chat");
      return runCustomAppAiChat(app, { ...launchRecord, ...record });
    }
    if (action === "ai.embed") {
      requirePermission("ai.embed");
      return runCustomAppAiEmbed(app, { ...launchRecord, ...record });
    }
    if (action === "ai.classify") {
      requirePermission("ai.classify");
      return runCustomAppAiClassify(app, { ...launchRecord, ...record });
    }

    if (action === "ui.toast") {
      requirePermission("ui.toast");
      onNotice?.(String(record.message ?? "Done"));
      return true;
    }

    if (action === "ui.showNotification") {
      requirePermission("ui.notification");
      return createCustomAppNotification(app, record, onNotice);
    }

    if (action === "ui.showSmsThread") {
      requirePermission("ui.sms");
      onNotice?.("SMS screen triggered (MVP shows this as a notification for now).");
      return true;
    }

    if (action === "ui.showCallScreen") {
      requirePermission("ui.call");
      onNotice?.("Call screen triggered (MVP shows this as a notification for now).");
      return true;
    }

    if (action === "ui.confirm") {
      const message = String(record.message ?? record.title ?? "Confirm action?");
      return window.confirm(message);
    }

    if (action === "memory.readCore") {
      requirePermission("memory.readCore");
      return readCustomAppCoreMemory(record);
    }
    if (action === "memory.readLongTerm") {
      requirePermission("memory.readLongTerm");
      return readCustomAppLongTermMemory(record);
    }
    if (action === "memory.readShortTerm") {
      requirePermission("memory.readShortTerm");
      const mergedRecord = {
        ...(launchContext && typeof launchContext === "object" ? launchContext : {}),
        ...record,
      };
      return readCustomAppShortTermMemory(app, mergedRecord);
    }
    if (action === "memory.search") {
      requirePermission("memory.search");
      return searchCustomAppMemory(record);
    }

    if (action === "memory.add") {
      requirePermission("memory.write");
      return addCustomAppMemory(app, record);
    }
    if (action === "memory.addTimeline") {
      requirePermission("memory.write");
      return addCustomAppTimelineEvent(app, record);
    }
    if (action === "memory.deleteTimeline" || action === "memory.removeTimeline") {
      requirePermission("memory.write");
      return deleteCustomAppTimelineEvent(app, record);
    }
    if (action === "memory.suggest") {
      requirePermission("memory.suggest");
      return suggestCustomAppMemory(app, record);
    }

    if (action === "notifications.create") {
      requirePermission("notifications.write");
      return createCustomAppNotification(app, record, onNotice);
    }
    if (action === "notifications.list") {
      requirePermission("notifications.read");
      const unreadOnly = record.unreadOnly === true;
      const limit = Math.max(1, Math.min(200, Number(record.limit ?? 100) || 100));
      return loadCustomAppNotifications(app.id).filter(item => !unreadOnly || !item.readAt).slice(0, limit);
    }
    if (action === "notifications.markRead") {
      requirePermission("notifications.write");
      return markCustomAppNotificationsRead(app.id, String(record.id ?? ""));
    }
    if (action === "notifications.markAllRead") {
      requirePermission("notifications.write");
      return markCustomAppNotificationsRead(app.id);
    }
    if (action === "notifications.getBadge") {
      requirePermission("notifications.read");
      return getCustomAppBadge(app.id);
    }
    if (action === "notifications.setBadge") {
      requirePermission("notifications.write");
      return setCustomAppBadge(app.id, Number(record.count ?? 0) || 0);
    }
    if (action === "notifications.incrementBadge") {
      requirePermission("notifications.write");
      return incrementCustomAppBadge(app.id, Number(record.delta ?? 1) || 1);
    }

    if (action === "tasks.schedule") {
      requirePermission("tasks.schedule");
      return scheduleCustomAppTask(app, record);
    }
    if (action === "tasks.list") {
      requirePermission("tasks.schedule");
      return loadCustomAppTasks(app.id);
    }
    if (action === "tasks.cancel") {
      requirePermission("tasks.schedule");
      return cancelCustomAppTask(app.id, String(record.id ?? ""));
    }

    if (action === "wallet.get") {
      requirePermission("wallet.read");
      return getWalletSnapshot();
    }
    if (action === "wallet.pay") {
      requirePermission("wallet.pay");
      return payCustomAppWallet(app, record);
    }

    throw new Error(`Unknown AiPhone action: ${action}`);
  }, [app, backgroundEvent, backgroundTool, declaredEvents, declaredToolKeys, getFrameAudioChannel, launchContext, onClose, onNotice, postBackgroundEventIfReady, postBackgroundToolIfReady, postHostEvent, requireAnyPermission, requirePermission]);

  useEffect(() => {
    if (isBackgroundRunner) return undefined;
    const handleChatMessagePushed = (event: Event) => {
      if (!hasPermission(app, "chat.read") && !hasPermission(app, "chat.read.background")) return;
      if (!subscribedEventsRef.current.has("chat.message.created") && !subscribedEventsRef.current.has("*")) return;
      const message = (event as CustomEvent<{ message?: ChatMessage }>).detail?.message;
      if (!message) return;
      const session = loadChatSessions().find(item => item.id === message.sessionId);
      postHostEvent("chat.message.created", {
        sessionId: message.sessionId,
        characterId: session?.contactId ?? "",
        isGroup: session?.isGroup === true,
        message: serializeBridgeChatMessage(message),
      });
    };
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, handleChatMessagePushed);
    return () => window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, handleChatMessagePushed);
  }, [app, isBackgroundRunner, postHostEvent]);

  useEffect(() => {
    if (isBackgroundRunner || !hasPermission(app, "chat.tools")) return undefined;
    return registerCustomAppToolExecutor(app.id, invokeOpenAppTool);
  }, [app, invokeOpenAppTool, isBackgroundRunner]);

  useEffect(() => {
    if (!backgroundEvent) return undefined;
    const timeout = window.setTimeout(() => {
      completeBackgroundEvent({
        ok: false,
        reason: backgroundEventSentRef.current ? "timeout" : "not_subscribed",
      });
    }, Math.max(1000, backgroundEvent.timeoutMs ?? CUSTOM_APP_BACKGROUND_RUNNER_TIMEOUT_MS));
    return () => window.clearTimeout(timeout);
  }, [backgroundEvent, completeBackgroundEvent]);

  useEffect(() => {
    if (!backgroundTool) return undefined;
    const timeout = window.setTimeout(() => {
      completeBackgroundTool({
        ok: false,
        reason: backgroundToolSentRef.current ? "timeout" : "handler_not_registered",
        error: backgroundToolSentRef.current
          ? `AiPhone tool timeout: ${backgroundTool.payload.tool.name}`
          : `App has not registered tool handler: ${toolInvocationKeys(backgroundTool.payload).join(" / ")}`,
      });
    }, Math.max(1000, backgroundTool.timeoutMs ?? CUSTOM_APP_BACKGROUND_RUNNER_TIMEOUT_MS));
    return () => window.clearTimeout(timeout);
  }, [backgroundTool, completeBackgroundTool]);

  useEffect(() => (
    () => {
      for (const [requestId, pending] of pendingToolInvocationsRef.current.entries()) {
        pending.reject(new Error(`AiPhone tool canceled: ${requestId}`));
      }
      pendingToolInvocationsRef.current.clear();
    }
  ), []);

  useLayoutEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record.source !== "ai-phone-custom-app-frame" || record.frameId !== frameId) return;
      if (record.type === "event.complete") {
        if (!backgroundEvent || record.backgroundRunId !== backgroundEvent.runId) return;
        const rawErrors = Array.isArray(record.errors) ? record.errors.map(item => String(item)).filter(Boolean) : [];
        completeBackgroundEvent({
          ok: record.ok !== false && rawErrors.length === 0,
          reason: "completed",
          errors: rawErrors.length > 0 ? rawErrors : undefined,
        });
        return;
      }
      if (record.type === "tool.result") {
        const toolRequestId = String(record.toolRequestId ?? "");
        const pending = pendingToolInvocationsRef.current.get(toolRequestId);
        if (!pending) return;
        pendingToolInvocationsRef.current.delete(toolRequestId);
        if (record.ok) pending.resolve(record.result);
        else pending.reject(new Error(String(record.error ?? "AiPhone tool failed")));
        return;
      }
      if (record.type !== "request") return;
      const requestId = String(record.requestId ?? "");
      const action = String(record.action ?? "");
      if (!requestId || !action) return;
      void Promise.resolve(handleBridgeRequest(action, record.payload))
        .then(result => postResponse(requestId, true, result))
        .catch(err => postResponse(requestId, false, undefined, err instanceof Error ? err.message : String(err)));
    };
    window.addEventListener("message", handleMessage);
    setBridgeReady(true);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [backgroundEvent, completeBackgroundEvent, frameId, handleBridgeRequest, postResponse]);

  return (
    <div className={`custom-app-runner${embedded ? " custom-app-runner-embedded" : ""}`}>
      {!embedded ? (
        <div className="custom-app-runner-capsule">
          <button type="button" className="cap-btn" onClick={() => { setMenuActionError(""); setMenuOpen(true); }} aria-label="App menu">
            <MoreHorizontal size={15} strokeWidth={2.4} />
          </button>
          <span className="cap-divider" />
          <button type="button" className="cap-btn" onClick={onClose} aria-label={closeLabel}>
            <Circle size={13} strokeWidth={2.4} />
          </button>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        title={app.name}
        className="custom-app-runner-frame"
        sandbox="allow-scripts allow-downloads"
        allow="autoplay"
        srcDoc={bridgeReady ? srcDoc : EMPTY_CUSTOM_APP_SRC_DOC}
      />

      {menuOpen ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={() => setMenuOpen(false)}>
          <div className="app-market-sheet app-market-detail-sheet" role="dialog" aria-modal="true" aria-label="App details" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>App Details</strong>
              <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <div className="app-market-preview-row">
                <span className="app-market-app-icon large">
                  {app.iconDataUrl ? <img src={app.iconDataUrl} alt="" /> : <Layers size={28} />}
                </span>
                <div>
                  <strong>{app.name}</strong>
                  <p>{app.description || "Local custom app"}</p>
                  <span>{app.author || "Local author"} · v{app.version}</span>
                </div>
              </div>
              <div className="app-market-declaration-strip">
                {[
                  { file: "presets.json", label: "Presets", Icon: Layers },
                  { file: "regex.json", label: "Regex", Icon: Sparkles },
                  { file: "worldbooks.json", label: "World Book", Icon: FileJson },
                  { file: "bindings.json", label: "Default Bindings", Icon: CheckCircle2 },
                ].map(item => {
                  const Icon = item.Icon;
                  const active = Object.values(app.assets).some(asset => asset.path.toLowerCase() === item.file);
                  return (
                    <span key={item.file} data-active={active}>
                      <Icon size={15} />
                      {item.label}
                    </span>
                  );
                })}
              </div>
              <div className="app-market-permissions">
                <span>Granted Permissions</span>
                {app.permissions.length === 0 ? (
                  <p>No special permissions declared.</p>
                ) : (
                  <ul>
                    {app.permissions.map(permission => (
                      <li key={permission}>{permissionLabelWithContext(permission, app.manifest)}</li>
                    ))}
                  </ul>
                )}
              </div>
              {menuActionError ? <div className="app-market-error" role="alert">{menuActionError}</div> : null}
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-secondary" onClick={() => void updateCurrentApp()} disabled={updating}>
                  {updating ? <LoaderCircle className="am-spin" size={18} /> : <RefreshCw size={18} />}
                  <span>{updating ? "Updating" : "Update"}</span>
                </button>
                <button type="button" className="app-market-danger" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }} disabled={updating}>
                  <Trash2 size={18} />
                  <span>Uninstall</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="app-market-overlay" role="presentation" onClick={() => setConfirmDelete(false)}>
          <div className="app-market-sheet" role="dialog" aria-modal="true" aria-label="Uninstall App" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>Uninstall "{app.name}"?</strong>
              <button type="button" onClick={() => setConfirmDelete(false)} aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-delete-copy">
                This will remove the home screen icon, permission grants, and runtime files. App cards in chat history will be kept.
              </p>
              <div className="app-market-sheet-actions stacked">
                <button type="button" className="app-market-secondary" onClick={() => void handleUninstall(false)}>
                  Uninstall and Keep Data
                </button>
                <button type="button" className="app-market-danger" onClick={() => void handleUninstall(true)}>
                  Uninstall and Delete Data
                </button>
                <button type="button" className="app-market-secondary" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
