"use client";

// lib/mixology/mechanism-runtime.ts
// House Special -- the sandbox host for mechanism hooks.
//
// Isolation rests on three layers and needs all three:
// 1. sandbox="allow-scripts" WITHOUT allow-same-origin, so the sandbox gets an opaque
//    origin: it cannot touch the host page's DOM, localStorage or IndexedDB, and cannot
//    read any other iframe.
// 2. A CSP declared in the document with default-src 'none', which cuts every outbound
//    route -- fetch, XHR, WebSocket, image beacons. Layer 1 stops it READING the host;
//    this layer stops it SENDING anything out. A mechanism can see the conversation; it
//    must not be able to ship that anywhere.
// 3. A timeout breaker. No result by the deadline and it is cut off, and the turn proceeds
//    as if there were no mechanism. An infinite loop cannot drag the session down.
//
// Exactly one thing travels the channel: the app hands in a payload, the sandbox hands
// back a result. There are no other commands.

import {
    normalizeHookResult,
    type MixHook,
    type MixHookPayload,
    type MixHookResult,
} from "./mechanism-protocol";

/** Ceiling for a single hook call: cut it off on timeout and treat the turn as having no
 *  mechanism */
export const MIX_HOOK_TIMEOUT_MS = 2_000;
/** How long a sandbox may sit idle before it is reclaimed. Several turns in a row use the
 *  same one, so there is no need to rebuild it every turn. */
const IDLE_DISPOSE_MS = 120_000;

type PendingCall = {
    resolve: (result: MixHookResult) => void;
    timer: number;
};

/**
 * The bootstrap code that runs inside the sandbox.
 * A mechanism author writes a few optional functions:
 *   function onSessionStart(ctx) {}
 *   function onBeforeSend(ctx) { return { text: ... } }
 *   function onAfterReply(ctx) { return { state: { affection: 61 } } }
 *   function onSessionEnd(ctx) {}
 * The return value has to be a plain structured-cloneable object. Anything else -- a
 * function, a DOM node, a circular reference -- is rejected by postMessage, which is caught
 * here and treated as "returned nothing".
 */
/** A </script in the author's code would close the tag early, so escape it */
function escapeScriptEnd(code: string): string {
    return code.replace(/<\/(script)/gi, "<\\/$1");
}

/** The inner Worker's timeout, deliberately a notch shorter than the host's, so that
 *  "kill it and answer" happens before the host's own fallback fires */
const WORKER_TIMEOUT_MS = 1_500;

/**
 * The sandbox is two layers nested, each with one job:
 * - The outer iframe: sandbox="allow-scripts" with no same-origin (an opaque origin that
 *   cannot reach the host), plus a CSP cutting all outbound traffic. It only isolates and
 *   forwards; it never runs the author's code itself.
 * - The inner Worker: where the author's code actually runs. A Worker is used because it
 *   can be forcibly killed with terminate(). A while(true) inside an iframe keeps running
 *   even after the iframe is pulled out of the DOM, burning CPU and dragging down every
 *   later call -- a Worker is the only way to genuinely cut an infinite loop off.
 */
function buildBootstrap(script: string): string {
    const tag = "script";
    // What runs inside the Worker: the author's code plus a dispatcher. The author's code is
    // spliced in as its own section, so a syntax error only stops the Worker from starting --
    // the outer channel stays alive.
    // Networking is deleted BEFORE the author's code runs. Measured: a CSP's connect-src does
    // not reliably inherit into a blob: Worker (fetch still gets out), so the CSP cannot be
    // relied on alone.
    // A Worker has no DOM and therefore no way to obtain a fresh realm, so deleting these is
    // genuinely deleting them. That is another reason to run the author's code in a Worker
    // rather than the iframe: inside an iframe you can open a second iframe and steal the
    // pristine functions back, and in a Worker there is no such route. Nested Workers have to
    // be blocked for the same reason.
    const lockdown = `(function(){
  var gone = ["fetch","XMLHttpRequest","WebSocket","EventSource","importScripts",
              "Worker","SharedWorker","BroadcastChannel","indexedDB","caches",
              "Request","Response","openDatabase"];
  for (var i = 0; i < gone.length; i++) {
    try { delete self[gone[i]]; } catch (e) {}
    try { Object.defineProperty(self, gone[i], { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  try { delete self.navigator.sendBeacon; } catch (e) {}
  try { Object.defineProperty(self.navigator, "sendBeacon", { value: undefined, configurable: false, writable: false }); } catch (e) {}
})();`;
    const workerSource = `${lockdown}
${script}
;self.onmessage = function (event) {
  var data = event.data || {};
  var names = { sessionStart: "onSessionStart", beforeSend: "onBeforeSend", afterReply: "onAfterReply", sessionEnd: "onSessionEnd" };
  var fn = self[names[data.hook]];
  if (typeof fn !== "function") { self.postMessage({ callId: data.callId, json: "" }); return; }
  function done(value) {
    var json = "";
    // Always via JSON: functions, undefined and DOM leftovers fall away naturally, and a
    // circular reference throws right here
    try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { json = ""; }
    self.postMessage({ callId: data.callId, json: json || "" });
  }
  var out = null;
  try { out = fn(data.payload); } catch (err) { self.postMessage({ callId: data.callId, json: "" }); return; }
  if (out && typeof out.then === "function") { out.then(done, function () { done(null); }); return; }
  done(out);
};`;
    const boot = `(function(){"use strict";
  var worker = null, url = "", timers = {};
  function spawn(){
    try{
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], {type:"text/javascript"}));
      worker = new Worker(url);
      worker.onmessage = function(e){
        var d = e.data || {};
        if (timers[d.callId]) { clearTimeout(timers[d.callId]); delete timers[d.callId]; }
        reply(d.callId, d.json);
      };
      worker.onerror = function(){ /* author code failed to start: every later call falls through to the timeout */ };
    }catch(err){ worker = null; }
  }
  function reply(callId, json){
    var result = null;
    try{ result = json ? JSON.parse(json) : null; }catch(e){ result = null; }
    try{ parent.postMessage({source:"mix-mechanism",callId:callId,result:result},"*"); }catch(e){}
  }
  function kill(){
    try{ worker && worker.terminate(); }catch(e){}
    try{ url && URL.revokeObjectURL(url); }catch(e){}
    worker = null;
    spawn();
  }
  window.addEventListener("message", function(event){
    var data = event.data;
    if(!data || data.source !== "mix-mechanism-host" || typeof data.callId !== "number") return;
    if(!worker){ reply(data.callId, ""); return; }
    timers[data.callId] = setTimeout(function(){
      delete timers[data.callId];
      // No answer by the deadline, which usually means an infinite loop. Kill it and respawn
      // immediately so the next call still works.
      kill();
      reply(data.callId, "");
    }, ${WORKER_TIMEOUT_MS});
    try{ worker.postMessage({ callId: data.callId, hook: data.hook, payload: data.payload }); }
    catch(e){ clearTimeout(timers[data.callId]); delete timers[data.callId]; reply(data.callId, ""); }
  });
  spawn();
  parent.postMessage({source:"mix-mechanism",ready:true},"*");
})();`;
    return [
        '<!doctype html><html><head><meta charset="utf-8"/>',
        // default-src 'none' cuts every outbound route (fetch / XHR / WebSocket / image
        // beacons); only blob: scripts and workers are additionally allowed, without which the
        // inner Worker cannot start.
        // Note there is no 'unsafe-eval': the author's code is handed to the Worker as script
        // text, so eval is never needed.
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' blob:; worker-src blob:; child-src blob:; style-src \'unsafe-inline\'"/>',
        "</head><body>",
        `<${tag}>var WORKER_SOURCE = ${JSON.stringify(workerSource)};</${tag}>`,
        `<${tag}>${escapeScriptEnd(boot)}</${tag}>`,
        "</body></html>",
    ].join("");
}

/** One mechanism's sandbox instance within one session */
class MechanismSandbox {
    private frame: HTMLIFrameElement | null = null;
    private pending = new Map<number, PendingCall>();
    private nextCallId = 1;
    private idleTimer = 0;
    /** The signal that the sandbox has finished booting. A postMessage sent before the srcdoc
     *  has parsed is simply lost, so we have to wait for it to speak first. */
    private ready: Promise<void> | null = null;
    private markReady: (() => void) | null = null;
    private readonly onMessage: (event: MessageEvent) => void;

    constructor(private readonly script: string) {
        this.onMessage = (event: MessageEvent) => {
            if (!this.frame || event.source !== this.frame.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "mix-mechanism") return;
            if (data.ready === true) { this.markReady?.(); return; }
            const callId = Number(data.callId);
            const call = this.pending.get(callId);
            if (!call) return;
            this.pending.delete(callId);
            window.clearTimeout(call.timer);
            call.resolve(normalizeHookResult(data.result));
        };
    }

    private ensureFrame(): HTMLIFrameElement {
        if (this.frame) return this.frame;
        this.ready = new Promise<void>((resolve) => { this.markReady = resolve; });
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("aria-hidden", "true");
        frame.style.cssText = "position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px";
        frame.srcdoc = buildBootstrap(this.script);
        document.body.appendChild(frame);
        window.addEventListener("message", this.onMessage);
        this.frame = frame;
        return frame;
    }

    private touch(): void {
        window.clearTimeout(this.idleTimer);
        this.idleTimer = window.setTimeout(() => this.dispose(), IDLE_DISPOSE_MS);
    }

    async invoke(hook: MixHook, payload: MixHookPayload): Promise<MixHookResult> {
        if (typeof window === "undefined" || typeof document === "undefined") return {};
        const frame = this.ensureFrame();
        this.touch();
        const callId = this.nextCallId++;
        return new Promise<MixHookResult>((resolve) => {
            const timer = window.setTimeout(() => {
                this.pending.delete(callId);
                // A timeout usually means an infinite loop, so the sandbox is already spent --
                // dispose of it entirely and rebuild on the next call
                this.dispose();
                resolve({});
            }, MIX_HOOK_TIMEOUT_MS);
            this.pending.set(callId, { resolve, timer });
            // Do NOT read frame.contentWindow.document: the sandbox has no same-origin, so
            // that access throws a cross-origin error and the whole call silently degrades to
            // "there is no mechanism".
            void (this.ready ?? Promise.resolve()).then(() => {
                try {
                    frame.contentWindow?.postMessage({ source: "mix-mechanism-host", callId, hook, payload }, "*");
                } catch {
                    // If it cannot be handed in, treat it as having no mechanism; the timeout
                    // is the backstop
                }
            });
        });
    }

    dispose(): void {
        window.clearTimeout(this.idleTimer);
        for (const call of this.pending.values()) {
            window.clearTimeout(call.timer);
            call.resolve({});
        }
        this.pending.clear();
        window.removeEventListener("message", this.onMessage);
        this.frame?.remove();
        this.frame = null;
        this.ready = null;
        this.markReady = null;
    }
}

/** session x mechanism -> sandbox. Consecutive turns in one session reuse the same instance. */
const sandboxes = new Map<string, MechanismSandbox>();

function sandboxKey(sessionId: string, materialId: string): string {
    return `${sessionId}::${materialId}`;
}

/** Run one hook, building the sandbox if it does not exist yet. Any exception collapses to
 *  an empty result. */
export async function runMixHook(
    sessionId: string,
    materialId: string,
    script: string,
    hook: MixHook,
    payload: MixHookPayload,
): Promise<MixHookResult> {
    if (!script.trim()) return {};
    const key = sandboxKey(sessionId, materialId);
    let sandbox = sandboxes.get(key);
    if (!sandbox) {
        sandbox = new MechanismSandbox(script);
        sandboxes.set(key, sandbox);
    }
    try {
        return await sandbox.invoke(hook, payload);
    } catch {
        return {};
    }
}

/** Tear down every sandbox belonging to a session when it is left */
export function disposeMixSandboxes(sessionId: string): void {
    for (const [key, sandbox] of [...sandboxes.entries()]) {
        if (!key.startsWith(`${sessionId}::`)) continue;
        sandbox.dispose();
        sandboxes.delete(key);
    }
}

/** After a material is edited the old sandbox is still running the old code, so clear it on
 *  save */
export function disposeMixSandboxesForMaterial(materialId: string): void {
    for (const [key, sandbox] of [...sandboxes.entries()]) {
        if (!key.endsWith(`::${materialId}`)) continue;
        sandbox.dispose();
        sandboxes.delete(key);
    }
}
