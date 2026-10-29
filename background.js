chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "badge") return;
  const count = Number(msg.count) || 0;
  chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? "99+" : String(count)) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2f9e44" });
  sendResponse({ ok: true });
});
