const urlInput = document.querySelector("#videoUrl");
const status = document.querySelector("#status");

chrome.storage.local.get(["sortMode", "lastVideoUrl"], (values) => {
  if (values.lastVideoUrl) urlInput.value = values.lastVideoUrl;
  const radio = document.querySelector(`input[value="${values.sortMode || "hot"}"]`);
  if (radio) radio.checked = true;
});

function selectedMode() {
  return document.querySelector('input[name="sortMode"]:checked').value;
}

function normalizeDouyinUrl(raw) {
  const match = raw.trim().match(/https?:\/\/[^\s]+/i);
  if (!match) throw new Error("请粘贴完整的视频链接");
  const url = new URL(match[0]);
  if (!/(^|\.)douyin\.com$/i.test(url.hostname)) throw new Error("这不是抖音链接");
  return url.href;
}

document.querySelector("#openButton").addEventListener("click", async () => {
  try {
    const url = normalizeDouyinUrl(urlInput.value);
    const sortMode = selectedMode();
    await chrome.storage.local.set({ sortMode, lastVideoUrl: url, showOnNextPage: true });
    await chrome.tabs.create({ url });
    window.close();
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector("#currentButton").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let isDouyinPage = false;
  try {
    isDouyinPage = /(^|\.)douyin\.com$/i.test(new URL(tab?.url).hostname);
  } catch {}
  if (!isDouyinPage) {
    status.textContent = "请先打开一个抖音视频页面";
    return;
  }
  const sortMode = selectedMode();
  await chrome.storage.local.set({ sortMode });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SHOW_SORTER", sortMode });
    window.close();
  } catch {
    status.textContent = "请刷新抖音页面后再试一次";
  }
});
