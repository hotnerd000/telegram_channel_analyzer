(() => {
  const D = globalThis.JobDedupe;
  const DEFAULTS = {
    enabled: true,
    hideDuplicates: true,
    onlyNew: false,
    threshold: 0.72,
    panelOpen: true,
  };
  const MIN_NORMALIZED = 18;
  const MAX_SEEN = 1500;
  const MAX_PENDING = 400;
  const MESSAGE_SELECTORS = [
    ".message-list-item[data-message-id]",
    ".Message[data-message-id]",
    ".bubble[data-mid]",
    "[data-mid].bubble",
    ".message[data-message-id]",
  ];
  const CONTENT_SELECTORS = [
    ".text-content",
    ".translatable-message",
    ".message-content",
    ".content-inner",
  ];
  const NOISE_SELECTORS = [
    ".tjf-chip",
    ".message-time",
    ".time",
    ".MessageMeta",
    ".message-meta",
    ".reactions",
    ".Reactions",
    ".message-reactions",
    ".CommentButton",
    ".replies",
    ".views",
    ".avatar",
    "time",
    ".message-status",
  ];

  const state = {
    settings: { ...DEFAULTS },
    chatKey: "",
    seen: [],
    pending: [],
    hiddenDupes: 0,
    ready: false,
  };

  let root = null;
  let scanTimer = 0;
  let saveTimer = 0;
  let chatTimer = 0;
  let observer = null;
  let stopped = false;

  function contextAlive() {
    try {
      if (!chrome.runtime?.id) return false;
      chrome.runtime.getManifest();
      return true;
    } catch {
      return false;
    }
  }

  function contextGone(error) {
    return /Extension context invalidated/i.test(String(error?.message || error));
  }

  function stopWatching() {
    if (stopped) return;
    stopped = true;
    clearTimeout(scanTimer);
    clearTimeout(saveTimer);
    clearInterval(chatTimer);
    observer?.disconnect();
    window.removeEventListener("scroll", scheduleScan, true);
    window.removeEventListener("hashchange", onHashChange);
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!contextAlive()) {
        stopWatching();
        resolve({});
        return;
      }
      try {
        chrome.storage.local.get(keys, (data) => {
          try {
            if (chrome.runtime.lastError) {
              stopWatching();
              resolve({});
              return;
            }
            resolve(data || {});
          } catch {
            stopWatching();
            resolve({});
          }
        });
      } catch {
        stopWatching();
        resolve({});
      }
    });
  }

  function storageSet(payload) {
    if (stopped || !contextAlive()) {
      stopWatching();
      return;
    }
    try {
      const pending = chrome.storage.local.set(payload);
      if (pending && typeof pending.catch === "function") pending.catch(() => stopWatching());
    } catch {
      stopWatching();
    }
  }

  function sendBadge(count) {
    if (stopped || !contextAlive()) {
      stopWatching();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "badge", count }, () => {
        try {
          if (chrome.runtime.lastError) stopWatching();
        } catch {
          stopWatching();
        }
      });
    } catch {
      stopWatching();
    }
  }

  function storageKey(chatKey) {
    return `chat:${chatKey}`;
  }

  const TARGET_USERNAME = globalThis.TJF_CONFIG.username;
  const TARGET_TITLE = globalThis.TJF_CONFIG.title;

  function getChatTitle() {
    const scopes = [
      document.querySelector("#column-center"),
      document.querySelector(".Transition_slide-active"),
      document.querySelector(".messages-layout"),
      document.querySelector("main"),
      document,
    ].filter(Boolean);
    const selectors = [
      ".ChatInfo .title",
      ".chat-info .peer-title",
      ".TopBar .fullName",
      "h3.fullName",
      ".chat-title",
    ];
    for (const scope of scopes) {
      for (const sel of selectors) {
        const t = scope.querySelector(sel)?.innerText?.trim();
        if (t && t.length < 80) return t;
      }
    }
    return document.title.replace(/^\(\d+\)\s*/, "").replace(/\s+[–-]\s+Telegram.*$/i, "").trim();
  }

  function isTargetChat() {
    const hash = (location.hash || "").toLowerCase();
    if (hash.includes(TARGET_USERNAME.toLowerCase())) return true;
    const title = getChatTitle();
    const blob = `${title} ${document.title}`;
    if (blob.includes(TARGET_TITLE) || /haiwaiitjob/i.test(blob)) return true;
    const peerOnly = /^-?\d{5,}(?:\?.*)?$/.test((location.hash || "").replace(/^#/, ""));
    if (state.chatKey === TARGET_USERNAME && peerOnly) return !title || blob.includes(TARGET_TITLE);
    return false;
  }

  function channelUrl() {
    const base = location.pathname.startsWith("/k") ? "/k/" : "/a/";
    return `${location.origin}${base}#@${TARGET_USERNAME}`;
  }

  function openTargetChannel() {
    const next = channelUrl();
    if (location.href !== next) location.assign(next);
  }

  function getChatKey() {
    if (isTargetChat()) return TARGET_USERNAME;
    const hash = (location.hash || "").replace(/^#/, "");
    const peer = hash.match(/-?\d{5,}/);
    if (peer) return peer[0];
    const slug = hash.split("?")[0];
    if (slug) return slug;
    return `title:${getChatTitle() || "unknown"}`;
  }

  function isDarkTheme() {
    const bg = getComputedStyle(document.body).backgroundColor || "";
    const parts = bg.match(/\d+/g);
    if (!parts || parts.length < 3) return true;
    const [r, g, b] = parts.map(Number);
    return (r * 299 + g * 587 + b * 114) / 1000 < 140;
  }

  async function loadSettings() {
    const data = await storageGet("settings");
    state.settings = { ...DEFAULTS, ...(data.settings || {}) };
    return state.settings;
  }

  async function loadChat(chatKey) {
    const data = await storageGet(storageKey(chatKey));
    const stored = data[storageKey(chatKey)] || {};
    state.seen = Array.isArray(stored.seen) ? stored.seen : [];
    state.pending = Array.isArray(stored.pending) ? stored.pending : [];
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (stopped || !state.chatKey) return;
      const payload = {};
      payload[storageKey(state.chatKey)] = {
        seen: state.seen.slice(-MAX_SEEN),
        pending: state.pending.slice(-MAX_PENDING),
      };
      storageSet(payload);
    }, 400);
  }

  function saveSettings(partial) {
    state.settings = { ...state.settings, ...partial };
    storageSet({ settings: state.settings });
  }

  function collectMessages() {
    const found = [];
    const seenNodes = new Set();
    for (const sel of MESSAGE_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        if (seenNodes.has(el) || el.closest("#tjf-root")) return;
        seenNodes.add(el);
        found.push(el);
      });
    }
    return found.filter((el) => !found.some((other) => other !== el && other.contains(el)));
  }

  function messageIdOf(el) {
    return (
      el.getAttribute("data-message-id") ||
      el.getAttribute("data-mid") ||
      el.id ||
      ""
    );
  }

  function isServiceMessage(el) {
    const cls = String(el.className || "");
    return /service|ActionMessage|unread-separator/i.test(cls);
  }

  function messagePostedAt(el) {
    const timeEl = el.querySelector("time[datetime], .message-time, .time, time");
    if (!timeEl) return "";
    const datetime = timeEl.getAttribute("datetime");
    if (datetime) {
      const parsed = Date.parse(datetime);
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      }
    }
    const titled = (
      timeEl.getAttribute("title") ||
      timeEl.querySelector("[title]")?.getAttribute("title") ||
      ""
    ).replace(/\s+/g, " ").trim();
    if (titled) return titled;
    return (timeEl.innerText || "").replace(/\s+/g, " ").trim();
  }

  function messageText(el) {
    let source = null;
    for (const sel of CONTENT_SELECTORS) {
      source = el.querySelector(sel);
      if (source) break;
    }
    const node = (source || el).cloneNode(true);
    node.querySelectorAll(NOISE_SELECTORS.join(",")).forEach((n) => n.remove());
    return (node.innerText || "").replace(/\u00a0/g, " ").trim();
  }

  function firstLine(text) {
    const line = text.split(/\n+/).map((s) => s.trim()).find(Boolean) || text;
    return line.length > 72 ? `${line.slice(0, 72)}…` : line;
  }

  function previewText(text) {
    const clean = text.replace(/\s+\n/g, "\n").trim();
    return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean;
  }

  function knownEntries() {
    const entries = [];
    for (const item of state.seen) {
      if (!item.norm) continue;
      entries.push({ ...item, grams: D.gramsOf(item.norm), status: "seen" });
    }
    for (const item of state.pending) {
      if (!item.norm) continue;
      entries.push({ ...item, grams: D.gramsOf(item.norm), status: "pending" });
    }
    return entries;
  }

  function classify(text, known) {
    const norm = D.normalizeJobText(text);
    if (norm.length < MIN_NORMALIZED) return null;
    const grams = D.gramsOf(norm);
    const match = D.findMatch(norm, grams, known, state.settings.threshold);
    return { norm, grams, match };
  }

  function rememberPending(record) {
    if (state.pending.some((item) => item.norm === record.norm)) return;
    state.pending.push({
      norm: record.norm,
      messageId: record.messageId,
      title: record.title,
      text: record.text,
      postedAt: record.postedAt || "",
      at: Date.now(),
    });
    if (state.pending.length > MAX_PENDING) {
      const overflow = state.pending.splice(0, state.pending.length - MAX_PENDING);
      for (const item of overflow) {
        if (!state.seen.some((entry) => entry.norm === item.norm)) {
          state.seen.push({ norm: item.norm, title: item.title, at: item.at || Date.now() });
        }
      }
      if (state.seen.length > MAX_SEEN) state.seen.splice(0, state.seen.length - MAX_SEEN);
    }
    scheduleSave();
  }

  function layoutIsStatic(el) {
    const pos = getComputedStyle(el).position;
    return pos !== "absolute" && pos !== "fixed";
  }

  function clearMark(el) {
    el.classList.remove("tjf-new", "tjf-dup", "tjf-seen", "tjf-collapsed-msg", "tjf-rel");
    el.querySelector(":scope > .tjf-chip")?.remove();
  }

  function applyMark(el, status) {
    clearMark(el);
    const dimDup = status === "dup" && state.settings.hideDuplicates;
    const dimSeen = status === "seen" && state.settings.onlyNew;
    if (status !== "new" && !dimDup && !dimSeen) return;

    const chip = document.createElement("div");
    chip.className = "tjf-chip";
    if (status === "new") {
      el.classList.add("tjf-new");
      chip.textContent = "新";
    } else if (dimDup) {
      el.classList.add("tjf-dup");
      chip.textContent = "重复";
      if (layoutIsStatic(el)) el.classList.add("tjf-collapsed-msg");
    } else if (dimSeen) {
      el.classList.add("tjf-seen");
      chip.textContent = "已读";
      if (layoutIsStatic(el)) el.classList.add("tjf-collapsed-msg");
    }
    if (getComputedStyle(el).position === "static") el.classList.add("tjf-rel");
    el.appendChild(chip);
  }

  function scan() {
    if (stopped) return;
    try {
      scanNow();
    } catch (error) {
      if (contextGone(error) || !contextAlive()) {
        stopWatching();
        return;
      }
      throw error;
    }
  }

  function scanNow() {
    if (!contextAlive()) {
      stopWatching();
      return;
    }
    if (!state.ready || !state.settings.enabled || !isTargetChat()) {
      document.querySelectorAll(".tjf-new, .tjf-dup, .tjf-seen").forEach(clearMark);
      state.hiddenDupes = 0;
      renderPanel();
      if (!isTargetChat()) {
        sendBadge(0);
      }
      return;
    }

    const messages = collectMessages();
    const known = knownEntries();
    const claimed = new Set();
    let hidden = 0;

    for (const el of messages) {
      if (isServiceMessage(el)) {
        clearMark(el);
        continue;
      }
      const id = messageIdOf(el);
      const text = messageText(el);
      if (!text) {
        clearMark(el);
        continue;
      }
      const result = classify(text, known);
      if (!result) {
        clearMark(el);
        continue;
      }

      let status = "new";
      if (result.match) {
        const key = result.match.entry.norm;
        if (claimed.has(key)) {
          status = "dup";
        } else {
          claimed.add(key);
          status = result.match.entry.status === "seen" ? "seen" : "new";
          if (status === "new") {
            const stored = state.pending.find((item) => item.norm === key);
            if (stored) {
              let dirty = false;
              if (id && !stored.messageId) {
                stored.messageId = id;
                dirty = true;
              }
              if (!stored.postedAt) {
                const postedAt = messagePostedAt(el);
                if (postedAt) {
                  stored.postedAt = postedAt;
                  dirty = true;
                }
              }
              if (dirty) scheduleSave();
            }
          }
        }
      } else {
        status = "new";
        claimed.add(result.norm);
        known.push({ norm: result.norm, grams: result.grams, status: "pending", messageId: id });
        rememberPending({
          norm: result.norm,
          messageId: id,
          title: firstLine(text),
          text: previewText(text),
          postedAt: messagePostedAt(el),
        });
      }

      if (status === "dup") hidden++;
      applyMark(el, status);
    }

    state.hiddenDupes = hidden;
    renderPanel();
    sendBadge(state.pending.length);
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function visiblePending() {
    const q = (root?.querySelector(".tjf-search")?.value || "").trim().toLowerCase();
    const items = state.pending.slice();
    if (!q) return items;
    return items.filter((item) => `${item.title}\n${item.text}`.toLowerCase().includes(q));
  }

  function jumpTo(messageId) {
    if (!messageId) return;
    const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(messageId) : messageId;
    const el = document.querySelector(
      `[data-message-id="${safe}"], [data-mid="${safe}"], #${safe}`
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const stats = root?.querySelector(".tjf-stats");
    if (stats) stats.textContent = "That post is not loaded. Scroll the channel, then try again.";
  }

  function markRead(index) {
    const item = state.pending[index];
    if (!item) return;
    state.pending.splice(index, 1);
    if (!state.seen.some((entry) => entry.norm === item.norm)) {
      state.seen.push({ norm: item.norm, title: item.title, at: Date.now() });
      if (state.seen.length > MAX_SEEN) state.seen.splice(0, state.seen.length - MAX_SEEN);
    }
    scheduleSave();
    scheduleScan();
  }

  function markAllRead() {
    for (const item of state.pending) {
      if (!state.seen.some((entry) => entry.norm === item.norm)) {
        state.seen.push({ norm: item.norm, title: item.title, at: Date.now() });
      }
    }
    state.pending = [];
    if (state.seen.length > MAX_SEEN) state.seen.splice(0, state.seen.length - MAX_SEEN);
    scheduleSave();
    scheduleScan();
  }

  function resetChat() {
    state.pending = [];
    state.seen = [];
    scheduleSave();
    scheduleScan();
  }

  async function copyPending() {
    const text = visiblePending()
      .map((item) => item.text)
      .join("\n\n----------\n\n");
    try {
      await navigator.clipboard.writeText(text);
      const stats = root.querySelector(".tjf-stats");
      if (stats) {
        stats.dataset.lock = "1";
        stats.textContent = `Copied ${visiblePending().length} jobs.`;
        setTimeout(() => {
          delete stats.dataset.lock;
          renderPanel();
        }, 1600);
      }
    } catch {
      const stats = root.querySelector(".tjf-stats");
      if (stats) stats.textContent = "Clipboard permission was blocked by the page.";
    }
  }

  function renderPanel() {
    if (!root) return;
    const inChannel = isTargetChat();
    root.classList.toggle("tjf-dark", isDarkTheme());
    root.classList.toggle("tjf-collapsed", !state.settings.panelOpen);
    root.classList.toggle("tjf-wrong-chat", !inChannel);
    root.hidden = !state.settings.enabled;
    const titleEl = root.querySelector(".tjf-title");
    if (titleEl) titleEl.textContent = inChannel ? "New jobs" : `@${TARGET_USERNAME}`;

    const count = root.querySelector(".tjf-count");
    if (count) count.textContent = String(state.pending.length);

    const hideDup = root.querySelector('[data-setting="hideDuplicates"]');
    const onlyNew = root.querySelector('[data-setting="onlyNew"]');
    const threshold = root.querySelector(".tjf-range");
    const thresholdLabel = root.querySelector(".tjf-range-label");
    if (hideDup) {
      hideDup.checked = state.settings.hideDuplicates;
      hideDup.closest(".tjf-toggle")?.classList.toggle("tjf-on", state.settings.hideDuplicates);
    }
    if (onlyNew) {
      onlyNew.checked = state.settings.onlyNew;
      onlyNew.closest(".tjf-toggle")?.classList.toggle("tjf-on", state.settings.onlyNew);
    }
    if (threshold && document.activeElement !== threshold) {
      threshold.value = String(Math.round(state.settings.threshold * 100));
    }
    if (thresholdLabel) thresholdLabel.textContent = `${Math.round(state.settings.threshold * 100)}%`;

    const stats = root.querySelector(".tjf-stats");
    if (stats && !stats.dataset.lock) {
      const title = getChatTitle();
      stats.textContent = state.settings.enabled
        ? `${title ? `${title} · ` : ""}${state.pending.length} new · ${state.hiddenDupes} repeats in view`
        : "Paused";
    }

    const list = root.querySelector(".tjf-list");
    if (!list || !inChannel) return;
    const items = state.settings.enabled ? visiblePending() : [];
    const listKey = `${state.settings.enabled ? "1" : "0"}:${items
      .map((item) => `${item.messageId || ""}:${item.title}:${item.text.length}:${item.postedAt || ""}`)
      .join("|")}`;
    if (list.dataset.key === listKey) return;
    list.dataset.key = listKey;
    if (!items.length) {
      list.innerHTML = `<div class="tjf-empty">${
        state.settings.enabled
          ? "No new jobs yet. Scroll the channel so posts load. Mark all read to set a baseline — later posts and repeats of old ones stay out of this list."
          : "Filtering is paused."
      }</div>`;
      return;
    }
    list.innerHTML = items
      .map(
        (item) => `<article class="tjf-card tjf-card-new">
          <div class="tjf-card-title">${escapeHtml(item.title || "Job")}</div>
          ${item.postedAt ? `<div class="tjf-card-time">${escapeHtml(item.postedAt)}</div>` : ""}
          <div class="tjf-card-text">${escapeHtml(item.text || "")}</div>
          <div class="tjf-card-actions">
            <button type="button" data-act="jump" data-id="${escapeHtml(item.messageId || "")}">Show in chat</button>
            <button type="button" data-act="read" data-idx="${state.pending.indexOf(item)}">Mark read</button>
          </div>
        </article>`
      )
      .join("");
  }

  function buildPanel() {
    root = document.createElement("aside");
    root.id = "tjf-root";
    root.innerHTML = `
      <div class="tjf-header">
        <div class="tjf-title">New jobs</div>
        <span class="tjf-count">0</span>
        <button type="button" class="tjf-icon-btn" data-act="collapse" title="Collapse">–</button>
      </div>
      <div class="tjf-body">
        <div class="tjf-gate">
          <p>This filter follows <b>${escapeHtml(TARGET_TITLE)}</b>, the channel @${escapeHtml(TARGET_USERNAME)}.</p>
          <button type="button" class="tjf-btn" data-act="open">Open channel</button>
        </div>
        <div class="tjf-app">
        <div class="tjf-controls">
          <label class="tjf-toggle"><input type="checkbox" data-setting="hideDuplicates" /> Hide repeats</label>
          <label class="tjf-toggle"><input type="checkbox" data-setting="onlyNew" /> Hide read</label>
        </div>
        <label class="tjf-slider">
          <span>Match <b class="tjf-range-label">72%</b></span>
          <input class="tjf-range" type="range" min="65" max="95" step="1" value="72" />
        </label>
        <input class="tjf-search" type="search" placeholder="Filter titles and text" />
        <div class="tjf-actions">
          <button type="button" class="tjf-btn" data-act="read-all">Mark all read</button>
          <button type="button" class="tjf-btn" data-act="copy">Copy list</button>
          <button type="button" class="tjf-btn" data-act="reset" title="Forget every job remembered for this chat">Forget chat</button>
        </div>
        <div class="tjf-stats"></div>
        <div class="tjf-list"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(root);

    let drag = null;
    root.querySelector(".tjf-header").addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = root.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      root.querySelector(".tjf-header").setPointerCapture(event.pointerId);
    });
    root.querySelector(".tjf-header").addEventListener("pointermove", (event) => {
      if (!drag) return;
      root.style.left = `${Math.max(8, event.clientX - drag.dx)}px`;
      root.style.top = `${Math.max(8, event.clientY - drag.dy)}px`;
      root.style.right = "auto";
    });
    root.querySelector(".tjf-header").addEventListener("pointerup", () => {
      drag = null;
    });

    root.addEventListener("change", (event) => {
      const setting = event.target.getAttribute("data-setting");
      if (setting) {
        event.target.closest(".tjf-toggle")?.classList.toggle("tjf-on", event.target.checked);
        saveSettings({ [setting]: event.target.checked });
        scheduleScan();
      }
    });
    root.addEventListener("input", (event) => {
      if (event.target.classList.contains("tjf-range")) {
        const value = Number(event.target.value) / 100;
        saveSettings({ threshold: value });
        scheduleScan();
      } else if (event.target.classList.contains("tjf-search")) {
        renderPanel();
      }
    });
    root.addEventListener("click", (event) => {
      const btn = event.target.closest("button");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      if (act === "open") {
        openTargetChannel();
      } else if (act === "collapse") {
        saveSettings({ panelOpen: !state.settings.panelOpen });
        renderPanel();
      } else if (act === "read-all") {
        markAllRead();
      } else if (act === "copy") {
        copyPending();
      } else if (act === "jump") {
        jumpTo(btn.getAttribute("data-id"));
      } else if (act === "read") {
        markRead(Number(btn.getAttribute("data-idx")));
      } else if (act === "reset") {
        resetChat();
      }
    });
  }

  function onHashChange() {
    onChatMaybeChanged();
  }

  async function onChatMaybeChanged() {
    if (!contextAlive()) {
      stopWatching();
      return;
    }
    const key = getChatKey();
    if (key === state.chatKey) return;
    state.chatKey = key;
    state.hiddenDupes = 0;
    await loadChat(key);
    scheduleScan();
  }

  async function start() {
    await loadSettings();
    buildPanel();
    state.chatKey = getChatKey();
    await loadChat(state.chatKey);
    state.ready = true;
    renderPanel();
    scheduleScan();

    observer = new MutationObserver((mutations) => {
      if (stopped) return;
      try {
      for (const mutation of mutations) {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        if (!target || target.closest("#tjf-root") || target.closest(".tjf-chip")) continue;
        if (mutation.type === "childList") {
          const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
          const onlyOurs = nodes.length > 0 && nodes.every((node) => {
            if (node.nodeType !== 1) return false;
            return node.id === "tjf-root" || node.classList?.contains("tjf-chip") || node.closest?.("#tjf-root");
          });
          if (onlyOurs) continue;
        }
        scheduleScan();
        return;
      }
      } catch (error) {
        if (contextGone(error) || !contextAlive()) {
          stopWatching();
          return;
        }
        throw error;
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-message-id", "data-mid", "id"],
    });
    window.addEventListener("scroll", scheduleScan, true);
    window.addEventListener("hashchange", onHashChange);
    chatTimer = setInterval(onChatMaybeChanged, 1500);

    if (!contextAlive()) {
      stopWatching();
      return;
    }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (stopped || area !== "local" || !changes.settings) return;
        state.settings = { ...DEFAULTS, ...changes.settings.newValue };
        scheduleScan();
      });

      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type !== "open-channel") return;
        openTargetChannel();
        sendResponse({ ok: true });
      });
    } catch {
      stopWatching();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
