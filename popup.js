const CHANNEL = globalThis.TJF_CONFIG;

const DEFAULTS = {
  enabled: true,
  hideDuplicates: true,
  onlyNew: false,
  threshold: 0.72,
  panelOpen: true,
};

const enabled = document.getElementById("enabled");
const hideDuplicates = document.getElementById("hideDuplicates");
const onlyNew = document.getElementById("onlyNew");
const threshold = document.getElementById("threshold");
const thresholdLabel = document.getElementById("thresholdLabel");

function apply(settings) {
  const s = { ...DEFAULTS, ...settings };
  enabled.checked = s.enabled;
  hideDuplicates.checked = s.hideDuplicates;
  onlyNew.checked = s.onlyNew;
  threshold.value = String(Math.round(s.threshold * 100));
  thresholdLabel.textContent = `${threshold.value}%`;
}

function save(partial) {
  chrome.storage.local.get("settings", ({ settings }) => {
    chrome.storage.local.set({ settings: { ...DEFAULTS, ...settings, ...partial } });
  });
}

document.getElementById("channelHint").innerHTML =
  `Follows <b>${CHANNEL.title}</b> (@${CHANNEL.username}). Open that channel in Telegram Web, scroll once, then mark the current posts as read.`;
document.getElementById("open").textContent = `Open @${CHANNEL.username}`;

chrome.storage.local.get("settings", ({ settings }) => apply(settings));

document.getElementById("open").addEventListener("click", () => {
  const fallback = `https://web.telegram.org/a/#@${CHANNEL.username}`;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) {
      chrome.tabs.create({ url: fallback });
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "open-channel" }, () => {
      if (!chrome.runtime.lastError) return;
      if (tab.url && tab.url.includes("web.telegram.org")) {
        const path = tab.url.includes("/k/") ? "/k/" : "/a/";
        chrome.tabs.update(tab.id, { url: `https://web.telegram.org${path}#@${CHANNEL.username}` });
        return;
      }
      chrome.tabs.create({ url: fallback });
    });
  });
});

enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
hideDuplicates.addEventListener("change", () => save({ hideDuplicates: hideDuplicates.checked }));
onlyNew.addEventListener("change", () => save({ onlyNew: onlyNew.checked }));
threshold.addEventListener("input", () => {
  thresholdLabel.textContent = `${threshold.value}%`;
  save({ threshold: Number(threshold.value) / 100 });
});
