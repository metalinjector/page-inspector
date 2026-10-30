"use strict";
// Максимальный снимок: всё, что доступно расширению, вместе со значениями.
// В отличие от detailed.js здесь ничего не маскируется: значения cookie
// (включая HttpOnly), local/sessionStorage, IndexedDB, Cache Storage, OPFS,
// полей форм, тексты скриптов и глобальные переменные страницы.

// ============================================================
// Сбор в изолированном мире каждого фрейма. Функция автономна:
// браузер сериализует её текст, внешние переменные недоступны.
// ============================================================
async function collectFull(options) {
  const started = performance.now();
  const limits = {
    nodes: 200000, domMs: 30000, text: 30000000, html: 30000000, css: 10000000,
    resources: 50000, idbRecordsPerStore: 20000, idbChars: 30000000,
    cacheEntries: 5000, cacheBodyChars: 10000000, cacheBodyMax: 2000000,
    opfsChars: 10000000, opfsFileMax: 1000000, canvases: 20, canvasPixels: 16000000,
  };
  const issues = [];
  const error = (section, e) => issues.push({ section, reason: String(e?.message || e) });
  const counts = { nodes: 0, textChars: 0, shadowRoots: 0, closedShadowRoots: 0, canvases: 0 };

  const takeText = (s) => {
    s = String(s ?? "");
    const left = Math.max(0, limits.text - counts.textChars);
    const t = s.slice(0, left);
    counts.textChars += t.length;
    if (t.length < s.length && !issues.some((x) => x.section === "text")) error("text", "Достигнут общий лимит текста");
    return t;
  };

  const toBase64 = (bytes, max) => {
    const view = bytes.subarray(0, max);
    let bin = "";
    for (let i = 0; i < view.length; i += 0x8000) bin += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  // Структурированные значения (IndexedDB) -> JSON с пометками типов.
  const toPlain = (value, budget) => {
    const seen = new Map();
    const walk = (v, path, depth) => {
      if (budget.chars <= 0) return { $truncated: "budget" };
      if (v === undefined) return { $undefined: true };
      if (v === null || typeof v === "boolean") return v;
      if (typeof v === "number") return Number.isFinite(v) ? v : { $number: String(v) };
      if (typeof v === "string") { budget.chars -= v.length; return v; }
      if (typeof v === "bigint") return { $bigint: v.toString() };
      if (typeof v !== "object") return { $type: typeof v };
      if (seen.has(v)) return { $ref: seen.get(v) };
      if (depth > 40) return { $truncated: "depth" };
      seen.set(v, path);
      budget.chars -= 2;
      if (v instanceof Date) return { $date: isNaN(v) ? String(v) : v.toISOString() };
      if (v instanceof RegExp) return { $regexp: String(v) };
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
        const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        const b64 = toBase64(bytes, Math.max(0, Math.floor(budget.chars * 0.75)));
        budget.chars -= b64.length;
        return { $binary: v.constructor?.name || "ArrayBuffer", byteLength: bytes.length, base64: b64, truncated: b64.length * 0.75 < bytes.length - 2 };
      }
      if (typeof Blob !== "undefined" && v instanceof Blob) return { $blob: { type: v.type, size: v.size, name: v.name, lastModified: v.lastModified } };
      if (v instanceof Map) return { $map: [...v].map(([k, x], i) => [walk(k, path + ".<key" + i + ">", depth + 1), walk(x, path + ".<val" + i + ">", depth + 1)]) };
      if (v instanceof Set) return { $set: [...v].map((x, i) => walk(x, path + "<" + i + ">", depth + 1)) };
      if (v instanceof Error) return { $error: { name: v.name, message: v.message, stack: v.stack } };
      if (Array.isArray(v)) return v.map((x, i) => walk(x, path + "[" + i + "]", depth + 1));
      const out = {};
      for (const k of Object.keys(v)) { budget.chars -= k.length; out[k] = walk(v[k], path + "." + k, depth + 1); }
      return out;
    };
    return walk(value, "$", 0);
  };

  // ---------- Ожидание тишины DOM ----------
  let stable = false;
  if (options.wait) {
    stable = await new Promise((resolve) => {
      let quiet, hard, done = false;
      const finish = (v) => { if (done) return; done = true; observer.disconnect(); clearTimeout(quiet); clearTimeout(hard); resolve(v); };
      const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(() => finish(true), 700); });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      quiet = setTimeout(() => finish(true), 700);
      hard = setTimeout(() => finish(false), 4000);
    });
  }

  // ---------- DOM: плоское дерево, включая закрытые shadow roots ----------
  const nodes = [], nodeIds = new Map(), shadowRoots = [];
  const openOrClosed = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    try { return chrome.dom?.openOrClosedShadowRoot?.(el) || null; } catch { return null; }
  };
  const pseudo = (el, which) => {
    try {
      const c = getComputedStyle(el, which).content;
      return c && c !== "none" && c !== "normal" ? c : undefined;
    } catch { return undefined; }
  };
  const stack = [{ node: document.documentElement, parent: null, kind: "document" }];
  let pendingBranches = 0;
  while (stack.length) {
    if (counts.nodes >= limits.nodes || performance.now() - started > limits.domMs) {
      pendingBranches = stack.length;
      error("dom", "Достигнут лимит узлов или времени; pendingBranches — число незавершённых ветвей");
      break;
    }
    const { node: n, parent, kind } = stack.pop();
    if (!n) continue;
    const id = nodes.length;
    const rec = { id, parent, kind, type: n.nodeType };
    nodes.push(rec); nodeIds.set(n, id); counts.nodes++;
    if (n.nodeType === 3 || n.nodeType === 4 || n.nodeType === 8) { rec.text = takeText(n.nodeValue); continue; }
    if (n.nodeType === 7) { rec.target = n.target; rec.text = takeText(n.data); continue; }
    if (n.nodeType !== 1 && n.nodeType !== 11) continue;
    if (n.nodeType === 11 && kind === "shadowRoot") {
      rec.mode = n.mode; rec.delegatesFocus = n.delegatesFocus; rec.slotAssignment = n.slotAssignment;
      try { rec.adoptedStyleSheets = n.adoptedStyleSheets?.length || 0; } catch {}
    }
    if (n.nodeType === 1) {
      rec.tag = n.localName;
      if (n.namespaceURI !== "http://www.w3.org/1999/xhtml") rec.ns = n.namespaceURI;
      rec.attributes = {};
      for (const a of n.attributes) rec.attributes[a.name] = takeText(a.value);
      try {
        const r = n.getBoundingClientRect(), s = getComputedStyle(n);
        rec.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
        rec.style = {
          display: s.display, visibility: s.visibility, opacity: s.opacity, position: s.position,
          zIndex: s.zIndex, overflowX: s.overflowX, overflowY: s.overflowY, pointerEvents: s.pointerEvents,
          transform: s.transform === "none" ? undefined : s.transform, contentVisibility: s.contentVisibility,
        };
        if (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth) {
          rec.scroll = { top: n.scrollTop, left: n.scrollLeft, width: n.scrollWidth, height: n.scrollHeight, clientWidth: n.clientWidth, clientHeight: n.clientHeight };
        }
        const before = pseudo(n, "::before"), after = pseudo(n, "::after");
        if (before || after) rec.pseudo = { before, after };
      } catch (e) { error("geometry", e); }
      if (n.matches("input,textarea,select,button,output")) {
        const c = rec.control = { type: n.type, name: n.name, disabled: n.disabled };
        if ("value" in n) c.value = takeText(n.value);
        if ("defaultValue" in n && n.defaultValue !== n.value) c.defaultValue = takeText(n.defaultValue);
        if ("checked" in n) { c.checked = n.checked; c.defaultChecked = n.defaultChecked; c.indeterminate = n.indeterminate; }
        if ("required" in n) c.required = n.required;
        if ("readOnly" in n) c.readOnly = n.readOnly;
        if (n.localName === "select") {
          c.selectedIndex = n.selectedIndex;
          c.selected = [...n.selectedOptions].map((o) => ({ value: o.value, text: takeText(o.text) }));
        }
        if (n.files) c.files = [...n.files].map((f) => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified }));
        if ("selectionStart" in n) try { c.selection = { start: n.selectionStart, end: n.selectionEnd, direction: n.selectionDirection }; } catch {}
        if (n.validity) c.validity = { valid: n.validity.valid, message: n.validationMessage || undefined };
      }
      if (n.matches("details,dialog")) rec.open = n.open;
      try { if (n.hasAttribute("popover")) rec.popoverOpen = n.matches(":popover-open"); } catch {}
      if (n.isContentEditable && n.getAttribute("contenteditable") !== null) rec.contentEditable = true;
      if (n.matches("video,audio")) {
        rec.media = {
          currentSrc: n.currentSrc, currentTime: n.currentTime, duration: Number.isFinite(n.duration) ? n.duration : null,
          paused: n.paused, ended: n.ended, muted: n.muted, volume: n.volume, playbackRate: n.playbackRate,
          readyState: n.readyState, networkState: n.networkState, loop: n.loop,
          videoWidth: n.videoWidth, videoHeight: n.videoHeight,
          textTracks: [...(n.textTracks || [])].map((t) => ({ kind: t.kind, label: t.label, language: t.language, mode: t.mode })),
        };
      }
      if (n.localName === "canvas") {
        rec.canvas = { width: n.width, height: n.height };
        if (counts.canvases < limits.canvases && n.width * n.height > 0 && n.width * n.height <= limits.canvasPixels) {
          try { rec.canvas.dataUrl = n.toDataURL("image/png"); counts.canvases++; }
          catch (e) { rec.canvas.error = String(e.message); }
        }
      }
      if (n.localName === "img") rec.image = { currentSrc: n.currentSrc, naturalWidth: n.naturalWidth, naturalHeight: n.naturalHeight, complete: n.complete, loading: n.loading };
      if (n.matches("iframe,frame,object,embed")) {
        let accessible = false;
        try { accessible = !!(n.contentDocument || n.getSVGDocument?.())?.documentElement; } catch {}
        rec.frame = { src: n.src || n.data, name: n.name, accessibleFromParent: accessible };
      }
      const sr = openOrClosed(n);
      if (sr) {
        counts.shadowRoots++;
        if (sr.mode === "closed") counts.closedShadowRoots++;
        shadowRoots.push(sr);
        stack.push({ node: sr, parent: id, kind: "shadowRoot" });
      }
      if (n.localName === "template") stack.push({ node: n.content, parent: id, kind: "templateContent" });
      if (n.localName === "slot") try { rec.assigned = n.assignedNodes({ flatten: true }).length; } catch {}
    }
    for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push({ node: n.childNodes[i], parent: id, kind: "child" });
    if (counts.nodes % 1000 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  // ---------- Полный HTML фрейма (с shadow DOM, в т.ч. закрытым) ----------
  let html = null;
  try {
    const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + "\n" : "";
    const root = document.documentElement;
    let body;
    if (typeof root.getHTML === "function") {
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const attrs = [...root.attributes].map((a) => " " + a.name + '="' + esc(a.value) + '"').join("");
      body = "<" + root.localName + attrs + ">" + root.getHTML({ serializableShadowRoots: true, shadowRoots }) + "</" + root.localName + ">";
    } else body = root.outerHTML;
    html = doctype + body;
    if (html.length > limits.html) { error("html", "HTML обрезан до " + limits.html + " символов (исходно " + html.length + ")"); html = html.slice(0, limits.html); }
  } catch (e) { error("html", e); }

  // ---------- Фокус и выделение ----------
  const interaction = {};
  try {
    let a = document.activeElement;
    const chain = [];
    while (a) { chain.push(nodeIds.get(a) ?? null); const sr = openOrClosed(a); a = sr?.activeElement || null; }
    interaction.activeElementIds = chain;
    const sel = getSelection();
    interaction.selection = sel ? {
      text: String(sel), type: sel.type, rangeCount: sel.rangeCount,
      anchorNodeId: nodeIds.get(sel.anchorNode) ?? null, anchorOffset: sel.anchorOffset,
      focusNodeId: nodeIds.get(sel.focusNode) ?? null, focusOffset: sel.focusOffset,
    } : null;
    interaction.fullscreenElementId = document.fullscreenElement ? nodeIds.get(document.fullscreenElement) ?? null : null;
    interaction.pointerLockElementId = document.pointerLockElement ? nodeIds.get(document.pointerLockElement) ?? null : null;
  } catch (e) { error("interaction", e); }

  // ---------- Хранилища ----------
  const storage = {};
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      const st = window[name], items = {};
      for (let i = 0; i < st.length; i++) { const k = st.key(i); items[k] = st.getItem(k); }
      storage[name] = { count: st.length, items };
    } catch (e) { error(name, e); }
  }
  try {
    const raw = document.cookie;
    storage.documentCookie = {
      raw,
      parsed: raw.split(";").map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf("="); return i < 0 ? { name: "", value: s } : { name: s.slice(0, i), value: s.slice(i + 1) }; }),
      note: "Только то, что видно через document.cookie (без HttpOnly). Полный список с атрибутами — в cookies отчёта.",
    };
  } catch (e) { error("documentCookie", e); }
  try {
    if (navigator.storage) {
      storage.estimate = await navigator.storage.estimate();
      storage.persisted = await navigator.storage.persisted();
    }
  } catch (e) { error("storageEstimate", e); }

  // IndexedDB: структура и записи.
  const indexedDBDump = [];
  const idbBudget = { chars: limits.idbChars };
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    const list = indexedDB.databases ? await indexedDB.databases() : null;
    if (!list) error("indexedDB", "Перечисление баз недоступно");
    for (const info of list || []) {
      const entry = { name: info.name, version: info.version, stores: [] };
      indexedDBDump.push(entry);
      let db;
      try {
        db = await new Promise((res, rej) => {
          const r = indexedDB.open(info.name);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error("Открытие заблокировано другим соединением"));
          // База уже существует, поэтому upgrade не ожидается; если случится — отменяем.
          r.onupgradeneeded = () => { r.transaction.abort(); };
        });
        db.onversionchange = () => db.close();
        for (const storeName of db.objectStoreNames) {
          const tx = db.transaction(storeName, "readonly"), store = tx.objectStore(storeName);
          const s = {
            name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
            indexes: [...store.indexNames].map((ix) => { const i = store.index(ix); return { name: i.name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; }),
            count: null, records: [],
          };
          entry.stores.push(s);
          try {
            s.count = await req(store.count());
            await new Promise((resolve, reject) => {
              const cur = store.openCursor();
              cur.onerror = () => reject(cur.error);
              cur.onsuccess = () => {
                const c = cur.result;
                if (!c) return resolve();
                if (s.records.length >= limits.idbRecordsPerStore || idbBudget.chars <= 0) { s.truncated = true; return resolve(); }
                s.records.push({ key: toPlain(c.primaryKey, idbBudget), value: toPlain(c.value, idbBudget) });
                c.continue();
              };
            });
          } catch (e) { s.error = String(e?.message || e); }
        }
      } catch (e) { entry.error = String(e?.message || e); }
      finally { try { db?.close(); } catch {} }
    }
    if (idbBudget.chars <= 0) error("indexedDB", "Достигнут лимит объёма IndexedDB");
  } catch (e) { error("indexedDB", e); }

  // Cache Storage: запросы, заголовки ответов и текстовые тела.
  const cacheStorage = [];
  try {
    if (window.caches) {
      let entriesLeft = limits.cacheEntries, bodyLeft = limits.cacheBodyChars;
      for (const name of await caches.keys()) {
        const cache = await caches.open(name), requests = await cache.keys();
        const c = { name, count: requests.length, entries: [] };
        cacheStorage.push(c);
        for (const rq of requests) {
          if (entriesLeft-- <= 0) { c.truncated = true; break; }
          const e = { url: rq.url, method: rq.method };
          try {
            const resp = await cache.match(rq);
            if (resp) {
              e.response = { status: resp.status, statusText: resp.statusText, type: resp.type, url: resp.url, headers: [...resp.headers] };
              const ct = resp.headers.get("content-type") || "";
              if (/^text\/|json|xml|javascript|ecmascript|svg|x-www-form-urlencoded/i.test(ct) && bodyLeft > 0) {
                const text = await resp.text();
                const max = Math.min(limits.cacheBodyMax, bodyLeft);
                e.body = text.slice(0, max); bodyLeft -= e.body.length;
                if (text.length > max) e.bodyTruncated = text.length;
              } else e.bodySize = (await resp.blob()).size;
            }
          } catch (x) { e.error = String(x?.message || x); }
          c.entries.push(e);
        }
      }
    }
  } catch (e) { error("cacheStorage", e); }

  // Origin Private File System.
  let opfs = null;
  try {
    if (navigator.storage?.getDirectory) {
      let left = limits.opfsChars;
      const walkDir = async (dir) => {
        const out = { name: dir.name, kind: "directory", children: [] };
        for await (const h of dir.values()) {
          if (h.kind === "directory") out.children.push(await walkDir(h));
          else {
            const f = await h.getFile();
            const item = { name: h.name, kind: "file", size: f.size, type: f.type, lastModified: f.lastModified };
            if (f.size <= limits.opfsFileMax && f.size * 1.34 <= left) {
              item.base64 = toBase64(new Uint8Array(await f.arrayBuffer()), f.size);
              left -= item.base64.length;
            }
            out.children.push(item);
          }
        }
        return out;
      };
      opfs = await walkDir(await navigator.storage.getDirectory());
    }
  } catch (e) { error("opfs", e); }

  // Service workers.
  let serviceWorkers = null;
  try {
    if (navigator.serviceWorker) {
      const w = (x) => x ? { scriptURL: x.scriptURL, state: x.state } : null;
      serviceWorkers = {
        controller: w(navigator.serviceWorker.controller),
        registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => ({
          scope: r.scope, updateViaCache: r.updateViaCache, active: w(r.active), waiting: w(r.waiting), installing: w(r.installing),
        })),
      };
    }
  } catch (e) { error("serviceWorker", e); }

  // ---------- CSS (включая @import и adoptedStyleSheets) ----------
  const stylesheets = [];
  let cssChars = 0;
  const readSheet = (sheet, origin) => {
    const entry = {
      origin, href: sheet.href, title: sheet.title || undefined, disabled: sheet.disabled,
      media: sheet.media?.mediaText || undefined, ownerNodeId: sheet.ownerNode ? nodeIds.get(sheet.ownerNode) ?? null : null, rules: [],
    };
    stylesheets.push(entry);
    try {
      for (const rule of sheet.cssRules) {
        if (cssChars + rule.cssText.length > limits.css) { entry.truncated = true; break; }
        entry.rules.push(rule.cssText); cssChars += rule.cssText.length;
        if (rule.styleSheet) readSheet(rule.styleSheet, "import");
      }
    } catch (e) { entry.error = String(e.message) + " (кросс-доменный CSS: тело доступно в режиме DevTools)"; }
  };
  for (const root of [document, ...shadowRoots]) {
    for (const sheet of root.styleSheets || []) readSheet(sheet, root === document ? "document" : "shadowRoot");
    try { for (const sheet of root.adoptedStyleSheets || []) readSheet(sheet, root === document ? "adopted" : "shadowRootAdopted"); } catch {}
  }
  const fonts = [];
  try { for (const f of document.fonts) fonts.push({ family: f.family, style: f.style, weight: f.weight, stretch: f.stretch, unicodeRange: f.unicodeRange, display: f.display, status: f.status }); }
  catch (e) { error("fonts", e); }

  // ---------- Performance ----------
  const perf = { timeOrigin: performance.timeOrigin };
  const plainEntries = (list) => list.map((e) => JSON.parse(JSON.stringify(e)));
  try {
    const res = performance.getEntriesByType("resource");
    perf.resources = plainEntries(res.slice(0, limits.resources));
    if (res.length > limits.resources) error("resources", "Список ресурсов обрезан");
    for (const t of ["navigation", "paint", "mark", "measure"]) perf[t] = plainEntries(performance.getEntriesByType(t));
    if (performance.memory) perf.memory = { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit };
    // Эти типы отдаются только через PerformanceObserver с buffered.
    const types = ["largest-contentful-paint", "layout-shift", "longtask", "long-animation-frame", "first-input", "event", "element"]
      .filter((t) => (PerformanceObserver.supportedEntryTypes || []).includes(t));
    perf.observed = await new Promise((resolve) => {
      const out = {};
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) (out[e.entryType] ||= []).push(JSON.parse(JSON.stringify(e))); });
      for (const type of types) try { po.observe({ type, buffered: true }); } catch {}
      setTimeout(() => { po.disconnect(); resolve(out); }, 150);
    });
  } catch (e) { error("performance", e); }

  // ---------- Окружение ----------
  const environment = {};
  try {
    const nav = navigator;
    environment.navigator = {
      userAgent: nav.userAgent, platform: nav.platform, vendor: nav.vendor, language: nav.language, languages: [...nav.languages],
      online: nav.onLine, cookieEnabled: nav.cookieEnabled, doNotTrack: nav.doNotTrack, webdriver: nav.webdriver,
      hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, maxTouchPoints: nav.maxTouchPoints, pdfViewerEnabled: nav.pdfViewerEnabled,
      connection: nav.connection ? { effectiveType: nav.connection.effectiveType, rtt: nav.connection.rtt, downlink: nav.connection.downlink, saveData: nav.connection.saveData, type: nav.connection.type } : undefined,
    };
    if (nav.userAgentData) {
      try { environment.navigator.userAgentData = await nav.userAgentData.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "fullVersionList", "wow64", "formFactors"]); }
      catch { environment.navigator.userAgentData = nav.userAgentData.toJSON(); }
    }
    environment.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, orientation: screen.orientation?.type };
    environment.intl = Intl.DateTimeFormat().resolvedOptions();
    environment.timezoneOffset = new Date().getTimezoneOffset();
    environment.media = {};
    for (const q of ["(prefers-color-scheme: dark)", "(prefers-reduced-motion: reduce)", "(prefers-contrast: more)", "(forced-colors: active)", "(pointer: coarse)", "(hover: hover)", "print", "(display-mode: standalone)"]) environment.media[q] = matchMedia(q).matches;
  } catch (e) { error("environment", e); }
  try {
    environment.permissions = {};
    for (const name of ["geolocation", "notifications", "camera", "microphone", "clipboard-read", "clipboard-write", "persistent-storage", "midi", "background-sync", "storage-access", "local-fonts", "screen-wake-lock"]) {
      try { environment.permissions[name] = (await navigator.permissions.query({ name })).state; } catch {}
    }
  } catch (e) { error("permissions", e); }

  const isHttp = /^https?:$/.test(location.protocol);
  return {
    schemaVersion: "full-1",
    capturedAt: new Date().toISOString(),
    url: location.href,
    cookieUrl: isHttp ? location.origin + location.pathname : null,
    origin: location.origin,
    ancestorOrigins: location.ancestorOrigins ? [...location.ancestorOrigins] : undefined,
    isTop: window === top,
    windowName: window.name,
    title: document.title,
    document: {
      readyState: document.readyState, contentType: document.contentType, characterSet: document.characterSet,
      compatMode: document.compatMode, doctype: document.doctype?.name || null, lastModified: document.lastModified,
      referrer: document.referrer, baseURI: document.baseURI, dir: document.dir, designMode: document.designMode,
      visibilityState: document.visibilityState, hasFocus: document.hasFocus(), historyLength: history.length,
      historyState: (() => { try { return JSON.parse(JSON.stringify(history.state)); } catch { return "[не сериализуется]"; } })(),
      isSecureContext, crossOriginIsolated: window.crossOriginIsolated,
    },
    viewport: { width: innerWidth, height: innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, scrollX, scrollY, visualViewport: window.visualViewport ? { scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, width: visualViewport.width, height: visualViewport.height } : undefined },
    documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    environment,
    interaction,
    html,
    nodes,
    stylesheets,
    fonts,
    storage,
    indexedDB: indexedDBDump,
    cacheStorage,
    opfs,
    serviceWorkers,
    performance: perf,
    coverage: {
      limits, counts, pendingBranches, waitRequested: options.wait, quietWindowObserved: stable,
      cssChars, idbCharsUsed: limits.idbChars - idbBudget.chars, elapsedMs: Math.round(performance.now() - started), issues,
    },
  };
}

// ============================================================
// Глобальные переменные страницы. Выполняется в MAIN-мире
// (контексте самой страницы), т.к. изолированный мир их не видит.
// ============================================================
function collectPageGlobals(builtins) {
  const limits = { perGlobal: 2000000, total: 20000000, depth: 12, items: 5000 };
  let totalLeft = limits.total;
  const issues = [];
  const fnToString = Function.prototype.toString;
  const isNative = (f) => { try { return /\{\s*\[native code\]\s*\}\s*$/.test(fnToString.call(f)); } catch { return false; } };
  const describeFn = (f) => ({ $function: f.name || "(anonymous)", length: f.length, native: isNative(f) });

  const toPlain = (value, budget) => {
    const seen = new Map();
    const walk = (v, path, depth) => {
      if (budget.chars <= 0) return { $truncated: "budget" };
      if (v === undefined) return { $undefined: true };
      if (v === null || typeof v === "boolean") return v;
      if (typeof v === "number") return Number.isFinite(v) ? v : { $number: String(v) };
      if (typeof v === "string") { const s = v.slice(0, budget.chars); budget.chars -= s.length; return s.length < v.length ? { $string: s, length: v.length } : s; }
      if (typeof v === "bigint") return { $bigint: v.toString() };
      if (typeof v === "symbol") return { $symbol: v.toString() };
      if (typeof v === "function") return describeFn(v);
      if (seen.has(v)) return { $ref: seen.get(v) };
      seen.set(v, path);
      budget.chars -= 2;
      try {
        if (v === window || v === document) return { $global: v === window ? "window" : "document" };
        if (typeof Window !== "undefined" && v instanceof Window) return { $window: true };
        if (typeof Node !== "undefined" && v instanceof Node) return { $node: v.nodeName, id: v.id || undefined };
        if (v instanceof Date) return { $date: isNaN(v) ? String(v) : v.toISOString() };
        if (v instanceof RegExp) return { $regexp: String(v) };
        if (v instanceof Error) return { $error: { name: v.name, message: v.message, stack: v.stack } };
        if (v instanceof Promise) return { $promise: true };
        if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { $binary: v.constructor?.name, byteLength: v.byteLength };
        if (typeof Blob !== "undefined" && v instanceof Blob) return { $blob: { type: v.type, size: v.size } };
        if (depth > limits.depth) return { $truncated: "depth", ctor: v.constructor?.name };
        if (v instanceof Map) return { $map: [...v].slice(0, limits.items).map(([k, x], i) => [walk(k, path + "<k" + i + ">", depth + 1), walk(x, path + "<v" + i + ">", depth + 1)]), size: v.size };
        if (v instanceof Set) return { $set: [...v].slice(0, limits.items).map((x, i) => walk(x, path + "<" + i + ">", depth + 1)), size: v.size };
        if (Array.isArray(v)) {
          const arr = v.slice(0, limits.items).map((x, i) => walk(x, path + "[" + i + "]", depth + 1));
          return v.length > limits.items ? { $array: arr, length: v.length } : arr;
        }
        const out = {};
        const proto = Object.getPrototypeOf(v);
        if (proto && proto !== Object.prototype && proto.constructor?.name) out.$class = proto.constructor.name;
        let n = 0;
        // Только собственные свойства; геттеры не вызываем, чтобы не провоцировать побочные эффекты.
        for (const k of Object.getOwnPropertyNames(v)) {
          if (n++ >= limits.items) { out.$truncatedKeys = true; break; }
          const d = Object.getOwnPropertyDescriptor(v, k);
          budget.chars -= k.length;
          out[k] = d && "value" in d ? walk(d.value, path + "." + k, depth + 1) : { $accessor: true };
        }
        return out;
      } catch (e) { return { $error: String(e?.message || e) }; }
    };
    return walk(value, "$", 0);
  };

  // builtins — имена стандартных свойств window из чистого окна расширения.
  const skip = new Set([...builtins, "window", "self", "globalThis", "chrome", "undefined", "NaN", "Infinity"]);
  const globals = {};
  for (const name of Object.getOwnPropertyNames(window)) {
    if (skip.has(name) || /^\d+$/.test(name)) continue;
    let d;
    try { d = Object.getOwnPropertyDescriptor(window, name); } catch { continue; }
    if (!d || !("value" in d)) continue;
    const v = d.value;
    if (typeof v === "function" && isNative(v)) continue;
    if (name.startsWith("on") && v === null) continue;
    if (totalLeft <= 0) { issues.push({ section: "globals", reason: "Достигнут общий лимит, переменная пропущена: " + name }); globals[name] = { $truncated: "total" }; continue; }
    const budget = { chars: Math.min(limits.perGlobal, totalLeft) };
    globals[name] = toPlain(v, budget);
    totalLeft -= Math.min(limits.perGlobal, totalLeft) - budget.chars;
  }
  return { url: location.href, globals, limits, issues };
}

// ============================================================
// Cookie через chrome.cookies: все атрибуты, HttpOnly, partitioned.
// ============================================================
async function collectCookies(tab, urls) {
  const out = { storeId: null, hosts: [], cookies: [], errors: [] };
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    out.storeId = stores.find((s) => s.tabIds.includes(tab.id))?.id ?? null;
  } catch (e) { out.errors.push("getAllCookieStores: " + e.message); }
  const hosts = new Set();
  for (const u of urls) { try { const x = new URL(u); if (/^https?:$/.test(x.protocol)) hosts.add(x.hostname); } catch {} }
  out.hosts = [...hosts];
  const base = out.storeId ? { storeId: out.storeId } : {};
  let all;
  try { all = await chrome.cookies.getAll({ ...base, partitionKey: {} }); }
  catch { // Старые версии Chrome не знают partitionKey.
    try { all = await chrome.cookies.getAll(base); } catch (e) { out.errors.push("getAll: " + e.message); all = []; }
  }
  // Cookie, которые относятся к хостам страницы: родительские домены (Domain=.example.com)
  // и поддомены. Путь не учитываем, чтобы не терять cookie других разделов сайта.
  const related = (c) => {
    const d = c.domain.replace(/^\./, "");
    const topSite = c.partitionKey?.topLevelSite ? new URL(c.partitionKey.topLevelSite).hostname : null;
    for (const h of hosts) {
      if (h === d || h.endsWith("." + d) || d.endsWith("." + h)) return true;
      if (topSite && (h === topSite || h.endsWith("." + topSite))) return true;
    }
    return false;
  };
  out.cookies = all.filter(related).map((c) => ({
    ...c,
    expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : "session",
  }));
  return out;
}

// ============================================================
// Тела всех ресурсов через DevTools Protocol (chrome.debugger).
// ============================================================
async function captureResources(tabId, onProgress) {
  const limits = { perResource: 50000000, total: 300000000 };
  let used = 0;
  const root = { tabId };
  const out = { capturedAt: new Date().toISOString(), targets: [], cookies: null, issues: [] };
  const sessions = [];
  const listener = (source, method, params) => {
    if (source.tabId === tabId && method === "Target.attachedToTarget") sessions.push({ sessionId: params.sessionId, targetInfo: params.targetInfo });
  };
  await chrome.debugger.attach(root, "1.3");
  chrome.debugger.onEvent.addListener(listener);
  try {
    const send = (target, method, params) => chrome.debugger.sendCommand(target, method, params || {});
    // Кросс-доменные iframe живут в отдельных процессах (OOPIF) — подключаемся к ним отдельно.
    try {
      await send(root, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) { out.issues.push("Target.setAutoAttach: " + e.message); }

    const dumpTarget = async (target, info) => {
      const t = { type: info?.type || "page", url: info?.url, frames: [] };
      out.targets.push(t);
      await send(target, "Page.enable");
      const { frameTree } = await send(target, "Page.getResourceTree");
      const visit = async (node, parentId) => {
        const f = node.frame;
        const frame = { id: f.id, parentId, name: f.name, url: f.url + (f.urlFragment || ""), securityOrigin: f.securityOrigin, mimeType: f.mimeType, resources: [] };
        t.frames.push(frame);
        const list = [{ url: f.url, type: "Document", mimeType: f.mimeType }, ...(node.resources || [])];
        for (const r of list) {
          const item = { url: r.url, type: r.type, mimeType: r.mimeType, contentSize: r.contentSize, lastModified: r.lastModified, failed: r.failed, canceled: r.canceled };
          frame.resources.push(item);
          if (used >= limits.total) { item.skipped = "Достигнут общий лимит"; continue; }
          try {
            onProgress?.(r.url);
            const c = await send(target, "Page.getResourceContent", { frameId: f.id, url: r.url });
            if (c.content.length > limits.perResource) { item.skipped = "Ресурс больше лимита: " + c.content.length; continue; }
            item.base64Encoded = c.base64Encoded;
            item.content = c.content;
            used += c.content.length;
          } catch (e) { item.error = e.message; }
        }
        for (const child of node.childFrames || []) await visit(child, f.id);
      };
      await visit(frameTree, null);
    };

    await dumpTarget(root, null);
    for (const s of sessions) {
      if (!["iframe", "page"].includes(s.targetInfo.type)) continue;
      try { await dumpTarget({ tabId, sessionId: s.sessionId }, s.targetInfo); }
      catch (e) { out.issues.push("Цель " + s.targetInfo.url + ": " + e.message); }
    }
    try { out.cookies = (await send(root, "Network.getCookies")).cookies; }
    catch (e) { out.issues.push("Network.getCookies: " + e.message); }
    out.bytesOfContent = used;
    return out;
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    await chrome.debugger.detach(root).catch(() => {});
  }
}

// ============================================================
// Действие попапа
// ============================================================
async function fullExport(tab) {
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const stamp = tsStamp(), host = safeHost(tab.url), saved = [], warnings = [];
    const options = { wait: !!delayEl.checked };

    setStatus("Собираю DOM, хранилища, IndexedDB, Cache Storage во всех фреймах…");
    let results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "ISOLATED", func: collectFull, args: [options] });
    } catch (e) {
      warnings.push("Сбор всех фреймов не выполнен: " + e.message + "; собран только основной фрейм.");
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "ISOLATED", func: collectFull, args: [options] });
    }

    setStatus("Собираю глобальные переменные страницы…");
    let globals = [];
    try {
      // Встроенные глобалы браузера берём из окна попапа; наши собственные функции (не native) в список не попадают.
      const isNative = (f) => /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(f));
      const builtins = Object.getOwnPropertyNames(window).filter((n) => { try { return typeof window[n] !== "function" || isNative(window[n]); } catch { return true; } });
      globals = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", func: collectPageGlobals, args: [builtins] });
    } catch (e) { warnings.push("Глобальные переменные не собраны: " + e.message); }
    const globalsByDoc = new Map(globals.map((g) => [g.documentId ?? g.frameId, g]));

    // Полный список фреймов вкладки, включая те, куда внедрение не удалось.
    let navFrames = [];
    try { navFrames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }) || []; }
    catch (e) { warnings.push("webNavigation.getAllFrames: " + e.message); }

    const frames = results.map((r) => {
      const g = globalsByDoc.get(r.documentId ?? r.frameId);
      const nav = navFrames.find((f) => f.frameId === r.frameId);
      return {
        frameId: r.frameId, documentId: r.documentId, parentFrameId: nav?.parentFrameId,
        data: r.result || null, pageGlobals: g?.result || null,
        error: r.error ? String(r.error) : r.result ? null : "Нет результата",
      };
    });
    const answered = new Set(results.map((r) => r.frameId));
    const missedFrames = navFrames.filter((f) => !answered.has(f.frameId))
      .map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url, errorOccurred: f.errorOccurred }));

    setStatus("Читаю cookie (включая HttpOnly)…");
    const urls = [tab.url, ...frames.map((f) => f.data?.cookieUrl), ...navFrames.map((f) => f.url)].filter(Boolean);
    const cookies = await collectCookies(tab, urls).catch((e) => ({ errors: [e.message] }));

    const report = {
      extensionVersion: chrome.runtime.getManifest().version,
      mode: "full",
      capturedAt: new Date().toISOString(),
      tab: { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, incognito: tab.incognito, status: tab.status, width: tab.width, height: tab.height },
      warnings,
      cookies,
      frameTree: navFrames,
      missedFrames,
      frames,
      notice: "ПОЛНЫЙ снимок со значениями cookie, хранилищ и полей. Файл эквивалентен доступу к вашей сессии — не передавайте его посторонним.",
    };
    const name = "inspector_full_" + host + "_" + stamp + ".json";
    setStatus("Сохраняю " + name + "…");
    await downloadText(JSON.stringify(report), name, "application/json");
    saved.push(name);

    if (mhtmlEl.checked) {
      setStatus("Сохраняю MHTML (страница с картинками и стилями)…");
      try {
        const blob = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id });
        const mname = "inspector_page_" + host + "_" + stamp + ".mhtml";
        await downloadBlob(blob, mname);
        saved.push(mname);
      } catch (e) { warnings.push("MHTML: " + e.message); }
    }

    if (devtoolsEl.checked) {
      setStatus("Подключаюсь через DevTools Protocol, выгружаю тела ресурсов…");
      try {
        const res = await captureResources(tab.id, (u) => setStatus("Ресурс: " + u.slice(0, 200)));
        const rname = "inspector_resources_" + host + "_" + stamp + ".json";
        await downloadText(JSON.stringify(res), rname, "application/json");
        saved.push(rname);
      } catch (e) { warnings.push("DevTools: " + e.message); }
    }

    const totalNodes = frames.reduce((s, f) => s + (f.data?.coverage?.counts?.nodes || 0), 0);
    setStatus(
      "Сохранено:\n" + saved.join("\n") +
      "\n\nФреймов: " + frames.length + (missedFrames.length ? " (недоступно: " + missedFrames.length + ")" : "") +
      " · узлов: " + totalNodes +
      " · cookie: " + (cookies.cookies?.length ?? 0) +
      (warnings.length ? "\n\nПредупреждения:\n" + warnings.join("\n") : ""),
      warnings.length ? null : "ok"
    );
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
bind("snapshotFull", fullExport);
