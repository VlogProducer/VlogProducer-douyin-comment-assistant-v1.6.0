// Content scripts save a short-lived recovery snapshot before a background
// page is frozen. session storage is restricted by default, so allow this
// extension's content scripts to access only that in-memory extension store.
chrome.storage.session?.setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })?.catch(() => {});

const AUTO_LOAD_ALARM = "douyin-comment-assistant-auto-load";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["sortMode", "panelSize", "autoSpeed"], (values) => {
    chrome.storage.local.set({
      sortMode: values.sortMode || "hot",
      panelSize: values.panelSize || { width: 380, height: 700 },
      autoSpeed: values.autoSpeed || 2100
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "OPEN_SORTER" && sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { type: "SHOW_SORTER" }).catch(() => {});
  }
  if (message?.type === "SORTER_ACTIVE" && sender.tab?.id) {
    chrome.storage.session.set({
      douyinCommentAssistantActiveTabId: sender.tab.id,
      douyinCommentAssistantAutoLoading: Boolean(message.autoScroll)
    }).catch(() => {});
    if (message.autoScroll) {
      // Chrome clamps extension alarms to a 30-second minimum. That cadence is
      // deliberately much slower than the foreground loader and is only a
      // best-effort recovery tick for a backgrounded tab.
      chrome.alarms.create(AUTO_LOAD_ALARM, { periodInMinutes: 0.5 });
    } else {
      chrome.alarms.clear(AUTO_LOAD_ALARM);
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOAD_ALARM) return;
  chrome.storage.session.get(["douyinCommentAssistantActiveTabId", "douyinCommentAssistantAutoLoading"], (values) => {
    if (!values.douyinCommentAssistantAutoLoading || !Number.isInteger(values.douyinCommentAssistantActiveTabId)) return;
    chrome.tabs.sendMessage(values.douyinCommentAssistantActiveTabId, { type: "BACKGROUND_AUTO_LOAD" }).catch(() => {});
  });
});

// If Chrome discards and later reloads the video tab, restore the assistant
// after the content script is available. The actual comment data and loading
// choice are saved by the content script in session storage.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !/(^|\.)douyin\.com$/i.test(new URL(tab.url || "https://invalid.example").hostname)) return;
  chrome.storage.session.get(["douyinCommentAssistantActiveTabId", "douyinCommentAssistantAutoLoading"], (values) => {
    if (values.douyinCommentAssistantActiveTabId !== tabId) return;
    chrome.tabs.sendMessage(tabId, { type: "SHOW_SORTER" }).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.get("douyinCommentAssistantActiveTabId", (values) => {
    if (values.douyinCommentAssistantActiveTabId === tabId) {
      chrome.storage.session.remove(["douyinCommentAssistantActiveTabId", "douyinCommentAssistantAutoLoading"]);
      chrome.alarms.clear(AUTO_LOAD_ALARM);
    }
  });
});
