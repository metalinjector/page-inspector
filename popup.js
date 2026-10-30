"use strict";

const statusEl = document.getElementById("status");
const saveAsEl = document.getElementById("saveAs");
const delayEl = document.getElementById("delay");
const probeInput = document.getElementById("probeSel");
const mhtmlEl = document.getElementById("withMhtml");
const devtoolsEl = document.getElementById("withDevtools");
// В отдельном окне попап открывается с ?tab=ID и работает с этой вкладкой.
const pinnedTabId = Number(new URLSearchParams(location.search).get("tab")) || null;

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.classList.remove("ok", "err");
  if (kind) statusEl.classList.add(kind);
}

async function getActiveTab() {
  if (pinnedTabId) return chrome.tabs.get(pinnedTabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

function safeHost(urlStr) {
  try { return new URL(urlStr).hostname.replace(/[^a-z0-9.-]/gi, "_"); }
  catch { return "page"; }
}

async function downloadText(text, filename, mime) {
  await downloadBlob(new Blob([text],{type:mime+';charset=utf-8'}), filename);
}

async function downloadBlob(blob, filename) {
  const url=URL.createObjectURL(blob);
  try {
    const id=await chrome.downloads.download({url,filename,saveAs:!!saveAsEl.checked});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('Время ожидания скачивания истекло. Проверьте загрузки браузера.')),120000);
      function finish(e){clearTimeout(timer);chrome.downloads.onChanged.removeListener(listener);e?reject(e):resolve();}
      function listener(delta){if(delta.id!==id)return;if(delta.state?.current==='complete')finish();else if(delta.state?.current==='interrupted')finish(new Error('Скачивание прервано'));}
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads.search({id}).then(items=>{if(items[0]?.state==='complete')finish();else if(items[0]?.state==='interrupted')finish(new Error('Скачивание прервано'));}).catch(finish);
    });
  } finally { URL.revokeObjectURL(url); }
}

async function runInPage(tabId, func, args) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || [],
    world: "ISOLATED",
  });
  return result;
}

async function maybeDelay() {
  if (delayEl.checked) {
    setStatus("Жду 2 с (lazy-загрузка)…");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ============================================================
// Сбор JSON-снимка в странице. Универсальный — годится для
// любого SPA, плюс сохраняет CoreWise-специфичные buckets.
// ============================================================
function collectSnapshot(opts) {
  const MAX_TEXT = 400;
  const MAX_CHILDREN = 30;
  const MAX_DEPTH = 4;
  const MAX_TESTIDS = 300;
  const MAX_HEADINGS = 200;
  const MAX_LIST = 50;
  const MAX_REPEATED = 40;

  const trunc = (s, n) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…[+" + (s.length - n) + "]" : s;
  };

  const clsStr = (el) => (el.className && typeof el.className === "string")
    ? el.className
    : (el.getAttribute && el.getAttribute("class")) || "";

  const rectMeta = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      offsetParentNull: el.offsetParent === null,
      isVisible:
        el.offsetParent !== null &&
        r.width > 4 && r.height > 4 &&
        cs.visibility !== "hidden" && cs.display !== "none",
    };
  };

  const ancestorChain = (el, depth = 6) => {
    const out = [];
    let cur = el.parentElement;
    while (cur && depth-- > 0) {
      out.push({
        tag: cur.tagName.toLowerCase(),
        cls: clsStr(cur).slice(0, 200),
        id: cur.id || undefined,
        testid: cur.getAttribute && cur.getAttribute("data-testid") || undefined,
      });
      cur = cur.parentElement;
    }
    return out;
  };

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    testid: el.getAttribute("data-testid") || undefined,
    cls: clsStr(el),
    rect: rectMeta(el),
    childCount: el.children.length,
    text: trunc(el.textContent, MAX_TEXT),
    ancestors: ancestorChain(el, 6),
  });

  const queryAll = (sel, root) => {
    try { return Array.from((root || document).querySelectorAll(sel)); }
    catch { return []; }
  };

  const outline = (root, depth = 0) => {
    if (!root || depth > MAX_DEPTH) return null;
    const kids = Array.from(root.children).slice(0, MAX_CHILDREN).map((c) => ({
      tag: c.tagName.toLowerCase(),
      cls: clsStr(c).slice(0, 200),
      id: c.id || undefined,
      testid: c.getAttribute("data-testid") || undefined,
      rect: rectMeta(c),
      childCount: c.children.length,
      textPreview: trunc(c.textContent, 120),
      children: depth < MAX_DEPTH
        ? Array.from(c.children).slice(0, MAX_CHILDREN).map((cc) => ({
            tag: cc.tagName.toLowerCase(),
            cls: clsStr(cc).slice(0, 200),
            testid: cc.getAttribute("data-testid") || undefined,
            childCount: cc.children.length,
            textPreview: trunc(cc.textContent, 80),
          }))
        : undefined,
    }));
    return {
      tag: root.tagName.toLowerCase(),
      cls: clsStr(root).slice(0, 200),
      id: root.id || undefined,
      rect: rectMeta(root),
      childCount: root.children.length,
      children: kids,
    };
  };

  // ---------- Route ----------
  const route = {
    href: location.href,
    origin: location.origin,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    segments: location.pathname.split("/").filter(Boolean),
    query: (() => {
      const o = {};
      try {
        for (const [k, v] of new URLSearchParams(location.search)) o[k] = v;
      } catch {}
      return o;
    })(),
  };

  // ---------- Headings outline ----------
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .slice(0, MAX_HEADINGS)
    .map((h) => ({
      level: parseInt(h.tagName.slice(1), 10),
      text: trunc(h.textContent, 200),
      id: h.id || undefined,
      cls: clsStr(h).slice(0, 160),
      visible: rectMeta(h).isVisible,
    }));

  // ---------- [data-testid] map ----------
  const testidEls = Array.from(document.querySelectorAll("[data-testid]"))
    .slice(0, MAX_TESTIDS);
  const testids = testidEls.map((el) => ({
    id: el.getAttribute("data-testid"),
    tag: el.tagName.toLowerCase(),
    cls: clsStr(el).slice(0, 200),
    rect: rectMeta(el),
    childCount: el.children.length,
    text: trunc(el.textContent, 160),
    childTestids: Array.from(el.querySelectorAll("[data-testid]"))
      .slice(0, 10)
      .map((c) => c.getAttribute("data-testid")),
  }));

  // ---------- ARIA landmarks / active state ----------
  const ariaLandmarks = Array.from(document.querySelectorAll(
    "[role='main'],[role='navigation'],[role='region'],[role='banner']," +
    "[role='complementary'],[role='contentinfo'],[role='search'],main,nav,aside,header,footer"
  )).slice(0, MAX_LIST).map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    label: el.getAttribute("aria-label") || undefined,
    labelledby: el.getAttribute("aria-labelledby") || undefined,
    cls: clsStr(el).slice(0, 160),
    rect: rectMeta(el),
  }));

  const activeStates = Array.from(document.querySelectorAll(
    "[aria-selected='true'],[aria-current],[aria-pressed='true']," +
    "[data-state='active'],[data-state='open'],[data-active='true']"
  )).slice(0, MAX_LIST).map((el) => ({
    text: trunc(el.textContent, 80),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    cls: clsStr(el).slice(0, 160),
    testid: el.getAttribute("data-testid") || undefined,
    ariaSelected: el.getAttribute("aria-selected"),
    ariaCurrent: el.getAttribute("aria-current"),
    ariaPressed: el.getAttribute("aria-pressed"),
    dataState: el.getAttribute("data-state"),
    rect: rectMeta(el),
  }));

  // ---------- Iframes ----------
  const iframes = Array.from(document.querySelectorAll("iframe"))
    .slice(0, MAX_LIST).map((f) => ({
      src: f.src || f.getAttribute("src") || undefined,
      title: f.title || undefined,
      name: f.name || undefined,
      sandbox: f.getAttribute("sandbox") || undefined,
      rect: rectMeta(f),
      crossOrigin: (() => {
        try { void f.contentDocument; return false; } catch { return true; }
      })(),
    }));

  // ---------- Shadow DOM hosts ----------
  const shadowHosts = [];
  (function walk(root) {
    if (!root || shadowHosts.length >= MAX_LIST) return;
    const tree = (root.querySelectorAll
      ? Array.from(root.querySelectorAll("*"))
      : []);
    for (const el of tree) {
      if (el.shadowRoot) {
        shadowHosts.push({
          tag: el.tagName.toLowerCase(),
          cls: clsStr(el).slice(0, 160),
          id: el.id || undefined,
          mode: el.shadowRoot.mode,
          childCount: el.shadowRoot.children.length,
          textPreview: trunc(el.shadowRoot.textContent, 200),
          innerTestids: Array.from(el.shadowRoot.querySelectorAll("[data-testid]"))
            .slice(0, 10).map((x) => x.getAttribute("data-testid")),
          headingCount: el.shadowRoot.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
        });
        walk(el.shadowRoot);
        if (shadowHosts.length >= MAX_LIST) return;
      }
    }
  })(document);

  // ---------- Scroll containers ----------
  const scrollContainers = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const ov = cs.overflowY + " " + cs.overflowX;
    if (!/auto|scroll|overlay/.test(ov)) continue;
    if (el.scrollHeight <= el.clientHeight + 2 &&
        el.scrollWidth <= el.clientWidth + 2) continue;
    scrollContainers.push({
      tag: el.tagName.toLowerCase(),
      cls: clsStr(el).slice(0, 160),
      id: el.id || undefined,
      testid: el.getAttribute("data-testid") || undefined,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      scrollTop: el.scrollTop,
      hiddenBelowPx: el.scrollHeight - el.clientHeight - el.scrollTop,
      rect: rectMeta(el),
    });
    if (scrollContainers.length >= MAX_LIST) break;
  }

  // ---------- Repeated card-groups (≥3 same-shape children) ----------
  const repeatedGroups = [];
  const firstToken = (s) => (s || "").trim().split(/\s+/)[0] || "";
  for (const parent of document.querySelectorAll("*")) {
    const kids = parent.children;
    if (kids.length < 3) continue;
    const sig = new Map();
    for (const k of kids) {
      const key = k.tagName + "|" + firstToken(clsStr(k));
      sig.set(key, (sig.get(key) || 0) + 1);
    }
    for (const [key, count] of sig) {
      if (count < 3) continue;
      const [tagU, firstCls] = key.split("|");
      repeatedGroups.push({
        parent: {
          tag: parent.tagName.toLowerCase(),
          cls: clsStr(parent).slice(0, 160),
          testid: parent.getAttribute("data-testid") || undefined,
        },
        childTag: tagU.toLowerCase(),
        childFirstClass: firstCls,
        count,
        sample: trunc(kids[0].textContent, 120),
        rect: rectMeta(parent),
      });
      if (repeatedGroups.length >= MAX_REPEATED) break;
    }
    if (repeatedGroups.length >= MAX_REPEATED) break;
  }
  repeatedGroups.sort((a, b) => b.count - a.count);

  // ---------- Forms / inputs / contenteditable ----------
  const forms = Array.from(document.querySelectorAll("form"))
    .slice(0, MAX_LIST).map((f) => ({
      id: f.id || undefined,
      name: f.name || undefined,
      action: f.action || undefined,
      method: f.method || undefined,
      inputCount: f.querySelectorAll("input,textarea,select").length,
      rect: rectMeta(f),
    }));
  const inputs = Array.from(document.querySelectorAll(
    "input,textarea,select,[contenteditable='true'],[contenteditable='']"
  )).slice(0, MAX_LIST).map((el) => {
    const tag = el.tagName.toLowerCase();
    const val = "value" in el ? String(el.value || "") : (el.textContent || "");
    return {
      tag,
      type: el.getAttribute("type") || undefined,
      name: el.getAttribute("name") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      testid: el.getAttribute("data-testid") || undefined,
      contenteditable: el.getAttribute("contenteditable"),
      valueLen: val.length,
      valuePreview: trunc(val, 80),
      visible: rectMeta(el).isVisible,
    };
  });

  // ---------- Meta (og:* / twitter:*) ----------
  const metaTags = {};
  for (const m of document.querySelectorAll("meta")) {
    const k = m.getAttribute("property") || m.getAttribute("name");
    if (!k) continue;
    if (!/^(og:|twitter:|description|keywords|author|theme-color|build-version|application-name)/i.test(k)) continue;
    metaTags[k] = trunc(m.getAttribute("content"), 220);
  }

  // ---------- CSS variables on :root ----------
  const themeVars = (() => {
    const out = [];
    try {
      const rootStyle = getComputedStyle(document.documentElement);
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const r of rules) {
          if (!r.style) continue;
          for (const prop of r.style) {
            if (prop.startsWith("--")) {
              const v = rootStyle.getPropertyValue(prop).trim();
              if (v) out.push({ name: prop, value: v.slice(0, 80) });
              if (out.length >= 60) return out;
            }
          }
        }
      }
    } catch {}
    return out;
  })();

  // ---------- Storage key names (no values, no PII) ----------
  const storage = {
    localStorageKeys: (() => {
      try { return Object.keys(localStorage).slice(0, 60); } catch { return []; }
    })(),
    sessionStorageKeys: (() => {
      try { return Object.keys(sessionStorage).slice(0, 60); } catch { return []; }
    })(),
    cookieKeys: document.cookie
      .split(";").map((c) => c.trim().split("=")[0]).filter(Boolean).slice(0, 40),
  };

  // ---------- Focus / selection ----------
  const focused = (() => {
    const f = document.activeElement;
    if (!f || f === document.body) return null;
    return {
      tag: f.tagName.toLowerCase(),
      id: f.id || undefined,
      cls: clsStr(f).slice(0, 160),
      testid: f.getAttribute && f.getAttribute("data-testid") || undefined,
    };
  })();
  const selectionText = (() => {
    try { return trunc(String(window.getSelection() || ""), 200); } catch { return ""; }
  })();

  // ---------- Hidden/visible siblings by class (для SPA табов) ----------
  // Идея: для популярных классов посмотреть, под одним ли родителем лежат
  // несколько экземпляров и сколько из них видимы — типичный паттерн «панель
  // активного таба видима, остальные скрыты класс="hidden"».
  const hiddenSiblingAnalysis = [];
  const classTotals = new Map();
  for (const el of document.querySelectorAll("*")) {
    const cls = clsStr(el);
    if (!cls) continue;
    cls.split(/\s+/).forEach((c) => {
      if (c.length < 4) return;
      if (/^(text-|bg-|p-|m-|mx-|my-|px-|py-|w-|h-|min-|max-|flex|grid|gap-|rounded|border|shadow|transition|hover:|focus:|sm:|md:|lg:|xl:|2xl:|absolute|relative|fixed|static|block|inline|hidden|font-|tracking-|leading-|opacity-|z-|top-|left-|right-|bottom-|cursor-|select-)/.test(c)) return;
      classTotals.set(c, (classTotals.get(c) || 0) + 1);
    });
  }
  // Берём самые "содержательные" классы (встречаются 2-30 раз — это потенциально SPA-панели/карточки)
  const candidateClasses = Array.from(classTotals.entries())
    .filter(([, n]) => n >= 2 && n <= 30)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  for (const [cls] of candidateClasses) {
    let safeCls;
    try { safeCls = '.' + CSS.escape(cls); } catch { continue; }
    const all = queryAll(safeCls);
    if (!all.length) continue;
    const visible = all.filter((el) => rectMeta(el).isVisible).length;
    if (visible === all.length) continue; // нет конфликта — пропускаем
    hiddenSiblingAnalysis.push({
      cls,
      total: all.length,
      visible,
      hidden: all.length - visible,
    });
  }

  // ---------- Class buckets (CoreWise + общие) ----------
  const collect = (sel) => queryAll(sel).map(describe);
  const buckets = {
    "debate-panel": collect(".debate-panel"),
    "debate-critique": collect(".debate-critique"),
    "council-panel-scroll": collect(".council-panel-scroll"),
    "critique-*": collect("[class*='critique-']"),
    "verdict-*": collect("[class*='verdict-']"),
    "model-badge": collect(".model-badge, [class*='model-badge']"),
    "answer-icon": collect(".verdict-answer-icon, [class*='answer-icon']"),
    "deep-article": collect("[class*='deep-article'], [data-testid*='deep-article']"),
  };

  // Кандидаты на «имя модели» — узкий эвристический фильтр.
  const modelNameSpans = queryAll("span[class*='font-semibold'], div[class*='font-semibold']")
    .filter((s) => {
      const cls = clsStr(s);
      if (/uppercase|tracking-/i.test(cls)) return false;
      return /text-(?:[a-z]+)-(?:300|400)\b/i.test(cls);
    })
    .slice(0, MAX_LIST)
    .map(describe);

  // ---------- Активные табы (текстовая эвристика) ----------
  const tabButtons = Array.from(
    document.querySelectorAll("button, [role='tab'], a")
  )
    .filter((b) => {
      const t = (b.textContent || "").trim();
      return t.length > 0 && t.length < 60;
    })
    .filter((b) => {
      const t = (b.textContent || "").trim();
      return /^(Models|Synthesis|Debate|Split\s*View|Run\s*Synthesis|Tab|Sections?)/i.test(t)
        || b.getAttribute("role") === "tab"
        || b.getAttribute("aria-selected") != null
        || b.getAttribute("data-state") === "active";
    })
    .slice(0, MAX_LIST)
    .map((b) => ({
      text: trunc(b.textContent, 60),
      cls: clsStr(b).slice(0, 160),
      role: b.getAttribute("role") || undefined,
      ariaSelected: b.getAttribute("aria-selected"),
      dataState: b.getAttribute("data-state"),
      rect: rectMeta(b),
    }));

  // ---------- Класс-облако (всё что выглядит «прикладным») ----------
  const interestingClasses = (() => {
    const bag = new Map();
    document.querySelectorAll("*").forEach((el) => {
      const cls = clsStr(el);
      if (!cls) return;
      cls.split(/\s+/).forEach((c) => {
        if (/^(council|debate|critique|verdict|model|panel|card|article|note|prose|deep|snapshot|verdict|outline)/i.test(c)) {
          bag.set(c, (bag.get(c) || 0) + 1);
        }
      });
    });
    return Array.from(bag.entries()).sort((a, b) => b[1] - a[1]).slice(0, 80)
      .map(([k, v]) => ({ cls: k, count: v }));
  })();

  // ---------- Top blocks (превью верхних детей <main>) ----------
  const mainRoot = document.querySelector("main") || document.body;
  const mainOutline = outline(mainRoot, 0);
  const topBlocks = Array.from(mainRoot.children).slice(0, 12).map((c, i) => ({
    i,
    tag: c.tagName.toLowerCase(),
    cls: clsStr(c).slice(0, 200),
    testid: c.getAttribute("data-testid") || undefined,
    rect: rectMeta(c),
    headPreview: trunc(c.textContent, 220),
  }));

  return {
    capturedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    documentSizeChars: document.documentElement.outerHTML.length,
    route,
    counts: {
      debatePanel: buckets["debate-panel"].length,
      debateCritique: buckets["debate-critique"].length,
      councilPanelScroll: buckets["council-panel-scroll"].length,
      critiqueAny: buckets["critique-*"].length,
      verdictAny: buckets["verdict-*"].length,
      modelBadge: buckets["model-badge"].length,
      modelNameSpans: modelNameSpans.length,
      deepArticle: buckets["deep-article"].length,
      testids: testids.length,
      headings: headings.length,
      iframes: iframes.length,
      shadowHosts: shadowHosts.length,
      scrollContainers: scrollContainers.length,
      repeatedGroups: repeatedGroups.length,
      forms: forms.length,
      inputs: inputs.length,
      ariaLandmarks: ariaLandmarks.length,
      activeStates: activeStates.length,
    },
    metaTags,
    themeVars,
    storage,
    focused,
    selectionText,
    headings,
    ariaLandmarks,
    activeStates,
    testids,
    iframes,
    shadowHosts,
    scrollContainers,
    repeatedGroups,
    forms,
    inputs,
    hiddenSiblingAnalysis,
    activeTabCandidates: tabButtons,
    modelNameSpans,
    interestingClasses,
    topBlocks,
    buckets,
    mainOutline,
  };
}

// ============================================================
// Selector probe — выполняется в странице с переданным селектором.
// ============================================================
function probeSelectorInPage(selector) {
  const out = { selector, error: null, count: 0, visibleCount: 0, samples: [] };
  let nodes;
  try { nodes = Array.from(document.querySelectorAll(selector)); }
  catch (e) { out.error = String(e?.message || e); return out; }
  out.count = nodes.length;
  const trunc = (s, n) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const isVis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return el.offsetParent !== null && r.width > 4 && r.height > 4 &&
      cs.visibility !== "hidden" && cs.display !== "none";
  };
  for (const el of nodes) {
    const vis = isVis(el);
    if (vis) out.visibleCount++;
    if (out.samples.length < 10) {
      const r = el.getBoundingClientRect();
      out.samples.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        cls: (el.className || "").toString().slice(0, 200),
        testid: el.getAttribute("data-testid") || undefined,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: vis,
        text: trunc(el.textContent, 200),
      });
    }
  }
  return out;
}

// ============================================================
// Действия попапа
// ============================================================
async function snapshotJson(tab) {
  await maybeDelay();
  setStatus("Снимаю JSON…");
  const data = await runInPage(tab.id, collectSnapshot);
  const fname = "inspector_" + safeHost(tab.url) + "_" + tsStamp() + ".json";
  await downloadText(JSON.stringify(data, null, 2), fname, "application/json");
  setStatus(
    "JSON: " + fname +
      "\ntestids: " + data.counts.testids +
      " · headings: " + data.counts.headings +
      " · iframes: " + data.counts.iframes +
      " · shadow: " + data.counts.shadowHosts +
      "\nscroll: " + data.counts.scrollContainers +
      " · repeated groups: " + data.counts.repeatedGroups +
      " · forms: " + data.counts.forms +
      "\nactive states: " + data.counts.activeStates +
      " · landmarks: " + data.counts.ariaLandmarks,
    "ok"
  );
  return data;
}

async function snapshotHtml(tab) {
  await maybeDelay();
  setStatus("Сохраняю полный HTML…");
  const html = await runInPage(tab.id, () => document.documentElement.outerHTML);
  const fname = "inspector_" + safeHost(tab.url) + "_" + tsStamp() + ".html";
  await downloadText(html, fname, "text/html");
  setStatus("HTML: " + fname + "\nразмер: " + html.length + " симв.", "ok");
}

async function snapshotMain(tab) {
  await maybeDelay();
  setStatus("Сохраняю <main>-only HTML…");
  const result = await runInPage(tab.id, () => {
    const m = document.querySelector("main") || document.body;
    return {
      html: m.outerHTML,
      tag: m.tagName.toLowerCase(),
      cls: (m.className || "").toString(),
    };
  });
  const fname = "inspector_main_" + safeHost(tab.url) + "_" + tsStamp() + ".html";
  await downloadText(result.html, fname, "text/html");
  setStatus(
    "Main HTML: " + fname +
      "\n<" + result.tag + "> размер: " + result.html.length + " симв.",
    "ok"
  );
}

async function copyJson(tab) {
  await maybeDelay();
  setStatus("Снимаю JSON для буфера…");
  const data = await runInPage(tab.id, collectSnapshot);
  const text = JSON.stringify(data, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Скопировано в буфер: " + text.length + " символов.", "ok");
  } catch (e) {
    setStatus("Не удалось записать в буфер: " + (e?.message || e), "err");
  }
}

async function probeSelector(tab) {
  const sel = probeInput.value.trim();
  if (!sel) { setStatus("Введите CSS-селектор для probe.", "err"); return; }
  const res = await runInPage(tab.id, probeSelectorInPage, [sel]);
  if (res.error) { setStatus("Ошибка селектора: " + res.error, "err"); return; }
  const lines = [
    `Селектор: ${res.selector}`,
    `Всего: ${res.count} · видимых: ${res.visibleCount}`,
    "",
    ...res.samples.map((s, i) =>
      `[${i}] <${s.tag}${s.id ? "#" + s.id : ""}>` +
      (s.testid ? ` [data-testid="${s.testid}"]` : "") +
      ` ${s.rect.w}×${s.rect.h} ${s.visible ? "visible" : "HIDDEN"}\n` +
      `    cls: ${s.cls.slice(0, 120)}\n` +
      `    text: ${s.text}`
    ),
  ];
  setStatus(lines.join("\n"), res.count ? "ok" : null);
}

function bind(id, handler) {
  document.getElementById(id).addEventListener("click", async () => {
    try {
      const tab = await getActiveTab();
      if (!tab?.id) { setStatus("Нет активной вкладки.", "err"); return; }
      await handler(tab);
    } catch (e) {
      setStatus("Ошибка: " + (e?.message || e), "err");
    }
  });
}

bind("snapshotJson", snapshotJson);
bind("snapshotHtml", snapshotHtml);
bind("snapshotMain", snapshotMain);
bind("snapshotBoth", async (tab) => {
  await snapshotJson(tab);
  await snapshotHtml(tab);
  setStatus("Оба снимка сохранены.", "ok");
});
bind("copyJson", copyJson);
bind("probeBtn", probeSelector);

bind("detach", async (tab) => {
  await chrome.windows.create({ url: chrome.runtime.getURL("popup.html?tab=" + tab.id), type: "popup", width: 430, height: 760 });
  window.close();
});
if (pinnedTabId) document.getElementById("detach").hidden = true;

probeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("probeBtn").click();
});
