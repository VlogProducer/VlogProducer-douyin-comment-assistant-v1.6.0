(() => {
  if (window.__douyinCommentSorterLoaded) return;
  window.__douyinCommentSorterLoaded = true;

  const state = {
    comments: new Map(),
    commentsById: new Map(),
    elementKeys: new WeakMap(),
    nextCommentId: 1,
    mode: "hot",
    keywordFilter: "",
    ipFilter: "",
    authorFilter: "",
    host: null,
    shadow: null,
    observer: null,
    observedList: null,
    scrollContainer: null,
    collectTimer: null,
    listWatchTimer: null,
    status: "正在查找评论…",
    position: null,
    size: { width: 380, height: 700 },
    videoId: null,
    autoScroll: false,
    autoTimer: null,
    autoSpeed: 2100,
    autoNoGrowth: 0,
    lastAutoCount: 0,
    autoResumePending: false,
    sessionSnapshot: null,
    sessionRestoredFor: null,
    sessionPersistTimer: null,
    focusedCommentId: null,
    isRefreshing: false,
    lastFilteredCount: 0
  };

  const SESSION_KEY = "douyinCommentAssistantSessionV2";
  const MAX_SESSION_COMMENTS = 2500;

  function normalizeAutoSpeed(value) {
    const speed = Number(value);
    if (speed === 4000 || speed === 2100 || speed === 800) return speed;
    // Preserve sensible behavior for settings stored by v1.5.2.
    if (speed === 2400) return 2100;
    if (speed === 1500) return 800;
    return 2100;
  }

  const ITEM_SELECTORS = [
    '[data-e2e="comment-item"]',
    '[data-e2e*="comment-item"]',
    '[data-testid*="comment-item"]',
    '[class*="comment-item"]',
    '[class*="CommentItem"]',
    '[class*="commentItem"]',
    '[class*="comment_item"]'
  ];

  // A timestamp must begin a metadata line. The boundary after “刚刚/分钟前”
  // prevents ordinary comments such as “刚刚发布的内容” from being mistaken for time.
  const TIME_LINE_PATTERN = /^(?:刚刚(?=\s|[·•|]|$)|\d+\s*(?:秒|分钟|小时|天|周|月|年)前(?=\s|[·•|]|$)|(?:今天|昨天|前天)\s*\d{1,2}:\d{2}|(?:20\d{2}[-/.年])?\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2})?)/;
  const TIME_TOKEN_PATTERN = /(?:刚刚(?=\s|[·•|]|$)|\d+\s*(?:秒|分钟|小时|天|周|月|年)前(?=\s|[·•|]|$)|(?:今天|昨天|前天)(?:\s*\d{1,2}:\d{2})?|(?:20\d{2}[-/.年])?\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2})?)/;

  function compactText(value) {
    return (value || "").replace(/\u200b/g, "").replace(/[ \t]+/g, " ").trim();
  }


  function parseCount(raw) {
    const value = compactText(raw).replace(/,/g, "");
    const match = value.match(/(\d+(?:\.\d+)?)\s*([万wW]?)/);
    if (!match) return 0;
    const multiplier = /万|w/i.test(match[2]) ? 10000 : 1;
    return Math.round(Number(match[1]) * multiplier);
  }

  function parseTime(raw, now = new Date()) {
    const text = compactText(raw);
    let match;
    if (text.includes("刚刚")) return now.getTime();
    if ((match = text.match(/(\d+)\s*秒前/))) return now.getTime() - Number(match[1]) * 1000;
    if ((match = text.match(/(\d+)\s*分钟前/))) return now.getTime() - Number(match[1]) * 60000;
    if ((match = text.match(/(\d+)\s*小时前/))) return now.getTime() - Number(match[1]) * 3600000;
    if ((match = text.match(/(\d+)\s*天前/))) return now.getTime() - Number(match[1]) * 86400000;
    if ((match = text.match(/(\d+)\s*周前/))) return now.getTime() - Number(match[1]) * 7 * 86400000;
    if ((match = text.match(/(\d+)\s*月前/))) return now.getTime() - Number(match[1]) * 30 * 86400000;
    if ((match = text.match(/(\d+)\s*年前/))) return now.getTime() - Number(match[1]) * 365 * 86400000;
    if ((match = text.match(/(今天|昨天|前天)\s*(\d{1,2}):(\d{2})/))) {
      const date = new Date(now);
      const daysAgo = match[1] === "今天" ? 0 : (match[1] === "昨天" ? 1 : 2);
      date.setDate(date.getDate() - daysAgo);
      date.setHours(Number(match[2]), Number(match[3]), 0, 0);
      return date.getTime();
    }
    match = text.match(/(?:(20\d{2})[-/.年])?(\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (match) {
      let year = match[1] ? Number(match[1]) : now.getFullYear();
      let date = new Date(year, Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0));
      if (!match[1] && date.getTime() > now.getTime() + 86400000) {
        date = new Date(year - 1, Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0));
      }
      return date.getTime();
    }
    return 0;
  }

  function findLikeCount(element, lines) {
    const labelled = [...element.querySelectorAll('[aria-label*="赞"], [title*="赞"], [data-e2e*="like"]')];
    for (const node of labelled) {
      const source = [node.getAttribute("aria-label"), node.getAttribute("title"), node.textContent].filter(Boolean).join(" ");
      if (/\d|万|w/i.test(source)) return parseCount(source);
    }
    // A username can be entirely numeric. Only use numeric lines after the
    // first line as a last-resort like count, and prefer the trailing metric.
    const likeLine = [...lines.slice(1)].reverse().find((line) => /^(?:点赞\s*)?\d+(?:\.\d+)?\s*(?:万|w)?$/i.test(line));
    return likeLine ? parseCount(likeLine) : 0;
  }

  function extractAuthorInfo(element) {
    const userLinks = [...element.querySelectorAll('a[href*="/user/"]')];
    if (!userLinks.length) return { name: "", hasUserLink: false };

    const candidates = userLinks.map((link) => {
      const directText = compactText(link.innerText || link.textContent);
      const labels = [...link.querySelectorAll("img[alt], [aria-label], [title]")]
        .map((node) => compactText(node.getAttribute("alt") || node.getAttribute("aria-label") || node.getAttribute("title")))
        .filter((label) => label && label.length <= 100);
      const inlineLabels = labels.filter((label) => !/头像$/i.test(label) && !/^(?:头像|avatar|图片|image)$/i.test(label));
      const avatarNames = labels
        .filter((label) => /头像$/i.test(label))
        .map((label) => compactText(label.replace(/头像$/i, "")))
        .filter(Boolean);

      if (directText) {
        const extras = inlineLabels.filter((label) => !directText.includes(label));
        return { name: compactText(`${directText}${extras.join("")}`), score: 3 };
      }
      if (inlineLabels.length) return { name: compactText(inlineLabels.join("")), score: 2 };
      if (avatarNames.length) return { name: avatarNames[0], score: 1 };
      return { name: "", score: 0 };
    }).filter((candidate) => candidate.name && candidate.name.length <= 100);

    candidates.sort((a, b) => b.score - a.score);
    return { name: candidates[0]?.name || "", hasUserLink: true };
  }

  function parseIpLocation(lines, timeLine) {
    const cleanLocation = (value) => {
      const text = compactText(value).replace(/^IP\s*属地\s*[:：]?\s*/i, "");
      const chinese = text.match(/^([\u3400-\u9fff]{1,12})/u);
      if (chinese?.[1]) return chinese[1];
      const latin = text.match(/^([A-Za-z][A-Za-z .'-]{0,29})/);
      return compactText(latin?.[1] || "");
    };
    const candidates = [...lines.filter((line) => /IP\s*属地/i.test(line)), timeLine].filter(Boolean);
    for (const source of candidates) {
      const labelled = compactText(source).match(/IP\s*属地\s*[:：]?\s*([^·•|，,\s]+)/i);
      if (labelled?.[1]) return cleanLocation(labelled[1]);
    }
    if (!timeLine) return "";
    const timeMatch = compactText(timeLine).match(TIME_TOKEN_PATTERN);
    if (!timeMatch) return "";
    const trailing = compactText(timeLine)
      .slice((timeMatch.index || 0) + timeMatch[0].length)
      .replace(/^[\s·•|，,]+/, "");
    const location = cleanLocation(trailing.split(/[·•|，,]/)[0]);
    return location && location.length <= 30 ? location : "";
  }

  function parseComment(element, index) {
    if (!element || element.closest("douyin-comment-sorter")) return null;
    const raw = compactText(element.innerText);
    if (!raw || raw.length < 3 || raw.length > 15000) return null;

    const lines = (element.innerText || "").split(/\n+/).map(compactText).filter(Boolean);
    const timeLine = lines.find((line) => TIME_LINE_PATTERN.test(line))
      || lines.find((line) => line.length < 120 && TIME_TOKEN_PATTERN.test(line));
    // data-e2e="comment-item" is already a verified Douyin comment. Some videos
    // omit the timestamp from the rendered DOM; keep those comments sortable by
    // heat instead of discarding them entirely.
    const timeText = timeLine?.match(TIME_TOKEN_PATTERN)?.[0] || timeLine || "时间未知";
    const ipLocation = parseIpLocation(lines, timeLine);
    const likes = findLikeCount(element, lines);
    const replyMatch = raw.match(/(?:展开|查看)\s*(\d+)\s*条回复/);
    const replyCount = replyMatch ? Number(replyMatch[1]) : 0;
    const authorInfo = extractAuthorInfo(element);
    const filtered = lines.map((line) => compactText(
      line.replace(/\s*(?:展开|查看)\s*\d+\s*条回复\s*$/g, "")
    )).filter((line, lineIndex) => {
      if (!line) return false;
      if ((timeLine && line === timeLine) || /^IP[属：:]/.test(line)) return false;
      if (/^(?:\.{2,}|…+)$/.test(line)) return false;
      if (/^(?:回复|展开|收起|查看|点赞|分享|举报|作者赞过)(?:\s|$)/.test(line)) return false;
      // Preserve an all-numeric first line because it may be the user's ID.
      if (lineIndex > 0 && /^\d+(?:\.\d+)?\s*(?:万|w)?$/i.test(line)) return false;
      return true;
    });
    const firstLineIsAuthor = Boolean(authorInfo.name && filtered[0]
      && (authorInfo.name === filtered[0] || authorInfo.name.startsWith(filtered[0])));
    const author = authorInfo.name || (authorInfo.hasUserLink ? "抖音用户" : filtered[0]) || "抖音用户";
    const contentLines = authorInfo.hasUserLink
      ? filtered.slice(firstLineIsAuthor ? 1 : 0)
      : filtered.slice(1);
    const content = contentLines.join(" ").slice(0, 1200) || "（未能识别评论正文）";
    const timestamp = parseTime(timeText);
    const key = `${author}|${content}|${timeText}`;

    return { key, author, content, timeText, timestamp, likes, replyCount, ipLocation, element, order: index };
  }

  function activeCommentList() {
    return [...document.querySelectorAll('[data-e2e="comment-list"]')]
      .find((node) => node.offsetParent !== null) || null;
  }

  function likelyFallbackItems(root) {
    const timeNodes = [...root.querySelectorAll("span, div, p")].filter((node) => {
      if (node.children.length > 3) return false;
      const text = compactText(node.textContent);
      return text.length < 100 && TIME_LINE_PATTERN.test(text);
    });
    const candidates = [];
    for (const node of timeNodes) {
      let candidate = node;
      for (let depth = 0; depth < 5 && candidate.parentElement && candidate.parentElement !== root; depth += 1) {
        candidate = candidate.parentElement;
        const text = compactText(candidate.innerText);
        if (text.length >= 15 && text.length <= 2500 && candidate.children.length >= 2) break;
      }
      if (candidate && !candidates.some((item) => item === candidate || item.contains(candidate))) candidates.push(candidate);
    }
    return candidates;
  }

  function findCommentElements() {
    const list = activeCommentList();
    if (!list) return [];
    for (const selector of ITEM_SELECTORS) {
      const items = [...list.querySelectorAll(selector)].filter((node) =>
        node.offsetParent !== null && !node.parentElement?.closest('[data-e2e="comment-item"]')
      );
      if (items.length) return items;
    }
    // Never scan outside the verified comment container. This prevents video
    // descriptions, player controls and related-search text from becoming comments.
    return likelyFallbackItems(list);
  }

  function storageSession() {
    return chrome.storage.session || chrome.storage.local;
  }

  function serializableComment(comment) {
    const { element, ...data } = comment;
    return data;
  }

  function saveSession(videoId = state.videoId, immediate = false) {
    if (!videoId) return;
    const write = () => {
      state.sessionPersistTimer = null;
      const comments = [...state.comments.values()]
        .sort((a, b) => a.order - b.order)
        .slice(-MAX_SESSION_COMMENTS)
        .map(serializableComment);
      storageSession().set({
        [SESSION_KEY]: {
          videoId,
          comments,
          nextCommentId: state.nextCommentId,
          autoScroll: state.autoScroll,
          savedAt: Date.now()
        }
      }).catch(() => {});
    };
    if (immediate) {
      clearTimeout(state.sessionPersistTimer);
      write();
      return;
    }
    // Frequent DOM mutations are expected while loading. Keep normal session
    // writes light; lifecycle events below always force an immediate save.
    if (!state.sessionPersistTimer) state.sessionPersistTimer = setTimeout(write, 3000);
  }

  function restoreSessionForVideo(videoId) {
    const snapshot = state.sessionSnapshot;
    if (!snapshot || snapshot.videoId !== videoId || state.sessionRestoredFor === videoId) return;
    for (const saved of snapshot.comments || []) {
      if (!saved?.key || state.comments.has(saved.key)) continue;
      const comment = { ...saved, element: null };
      state.comments.set(comment.key, comment);
      state.commentsById.set(comment.id, comment);
      state.nextCommentId = Math.max(state.nextCommentId, Number(comment.id) + 1 || 1);
    }
    state.nextCommentId = Math.max(state.nextCommentId, Number(snapshot.nextCommentId) || 1);
    state.autoScroll = Boolean(snapshot.autoScroll);
    state.autoResumePending = state.autoScroll;
    state.sessionRestoredFor = videoId;
    announceSorterState();
  }

  function resumeAutoLoadIfNeeded() {
    if (!state.autoResumePending || state.autoTimer || !activeCommentList()) return;
    state.autoResumePending = false;
    state.autoScroll = true;
    state.autoNoGrowth = 0;
    state.lastAutoCount = state.comments.size;
    state.status = "已恢复自动加载";
    state.autoTimer = setTimeout(autoLoadStep, 500);
    render();
    announceSorterState();
  }

  function restartAutoLoad(delay = 500) {
    if (!state.autoScroll) return;
    clearTimeout(state.autoTimer);
    state.autoTimer = setTimeout(autoLoadStep, delay);
  }

  function announceSorterState() {
    chrome.runtime.sendMessage({ type: "SORTER_ACTIVE", autoScroll: state.autoScroll }).catch(() => {});
  }

  function observeCommentList(list) {
    if (!state.observer || state.observedList === list) return;
    state.observer.disconnect();
    state.observedList = list;
    if (list) state.observer.observe(list, { childList: true, subtree: true });
  }

  function collect({ manual = false, forceRender = false } = {}) {
    const list = activeCommentList();
    if (list && state.scrollContainer !== list) {
      state.scrollContainer?.removeEventListener("scroll", scheduleCollect);
      state.scrollContainer = list;
      state.scrollContainer.addEventListener("scroll", scheduleCollect, { passive: true });
    }
    if (!list && state.scrollContainer) {
      state.scrollContainer.removeEventListener("scroll", scheduleCollect);
      state.scrollContainer = null;
    }
    observeCommentList(list);

    const activeVideo = document.querySelector('[data-e2e="feed-active-video"]');
    const videoId = activeVideo?.getAttribute("data-e2e-vid") || location.href;
    if (state.videoId && state.videoId !== videoId) {
      saveSession(state.videoId, true);
      state.comments.clear();
      state.commentsById.clear();
      state.elementKeys = new WeakMap();
      state.nextCommentId = 1;
      state.autoNoGrowth = 0;
      state.lastAutoCount = 0;
      state.focusedCommentId = null;
    }
    state.videoId = videoId;
    restoreSessionForVideo(videoId);

    const elements = findCommentElements();
    let added = 0;
    let changed = false;
    elements.forEach((element, index) => {
      const comment = parseComment(element, index);
      if (!comment) return;
      const knownKey = state.elementKeys.get(element);
      const known = knownKey ? state.comments.get(knownKey) : null;
      if (known) {
        known.element = element;
        changed ||= known.likes !== comment.likes || known.replyCount !== Math.max(known.replyCount, comment.replyCount)
          || (comment.ipLocation && known.ipLocation !== comment.ipLocation);
        known.likes = comment.likes;
        known.replyCount = Math.max(known.replyCount, comment.replyCount);
        known.ipLocation = comment.ipLocation || known.ipLocation;
        return;
      }
      const duplicate = state.comments.get(comment.key);
      if (duplicate) {
        duplicate.element = element;
        changed ||= duplicate.likes !== comment.likes || duplicate.replyCount !== Math.max(duplicate.replyCount, comment.replyCount)
          || (comment.ipLocation && duplicate.ipLocation !== comment.ipLocation);
        duplicate.likes = comment.likes;
        duplicate.replyCount = Math.max(duplicate.replyCount, comment.replyCount);
        duplicate.ipLocation = comment.ipLocation || duplicate.ipLocation;
        state.elementKeys.set(element, duplicate.key);
        return;
      }
      comment.id = state.nextCommentId++;
      state.comments.set(comment.key, comment);
      state.commentsById.set(comment.id, comment);
      state.elementKeys.set(element, comment.key);
      added += 1;
    });
    state.status = elements.length
      ? `${manual ? "重新扫描完成 · " : ""}已整理 ${state.comments.size} 条已加载评论${added ? `（新增 ${added} 条）` : ""}`
      : "还没找到评论，请先打开右侧评论区并向下滚动";
    state.isRefreshing = false;
    if (forceRender || added || changed) render();
    else updateStatusText();
    if (added || changed || manual) saveSession();
    resumeAutoLoadIfNeeded();
  }

  function scheduleCollect(delay = 800, replacePending = false) {
    // Comment-list mutations arrive in bursts. A slower throttle prevents a
    // full DOM parse for every individual node inserted by the page.
    if (state.collectTimer && !replacePending) return;
    if (replacePending) clearTimeout(state.collectTimer);
    state.collectTimer = setTimeout(() => {
      state.collectTimer = null;
      collect();
    }, delay);
  }

  function sortedComments() {
    const keyword = compactText(state.keywordFilter).toLocaleLowerCase("zh-CN");
    const ip = compactText(state.ipFilter).toLocaleLowerCase("zh-CN");
    const author = compactText(state.authorFilter).toLocaleLowerCase("zh-CN");
    const list = [...state.comments.values()].filter((comment) => {
      if (keyword && !comment.content.toLocaleLowerCase("zh-CN").includes(keyword)) return false;
      if (ip && !comment.ipLocation.toLocaleLowerCase("zh-CN").includes(ip)) return false;
      if (author && !comment.author.toLocaleLowerCase("zh-CN").includes(author)) return false;
      return true;
    });
    if (state.mode === "newest") return list.sort((a, b) => (b.timestamp - a.timestamp) || (a.order - b.order));
    if (state.mode === "oldest") return list.sort((a, b) => ((a.timestamp || Infinity) - (b.timestamp || Infinity)) || (a.order - b.order));
    return list.sort((a, b) => (b.likes - a.likes) || (b.timestamp - a.timestamp) || (a.order - b.order));
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function protectTextInputFromPageShortcuts(element) {
    ["keydown", "keypress", "keyup"].forEach((type) => {
      element.addEventListener(type, (event) => event.stopPropagation());
    });
  }

  function updateStatusText() {
    if (!state.shadow) return;
    const status = state.shadow.querySelector(".status");
    if (!status) return;
    const filtersActive = Boolean(compactText(state.keywordFilter) || compactText(state.ipFilter) || compactText(state.authorFilter));
    status.textContent = filtersActive
      ? `${state.status} · 筛选 ${state.lastFilteredCount}/${state.comments.size} 条`
      : state.status;
  }

  function render() {
    if (!state.shadow) return;
    const list = state.shadow.querySelector(".list");
    const status = state.shadow.querySelector(".status");
    if (!list || !status) return;
    const previousScrollTop = list.scrollTop;
    const filtersActive = Boolean(compactText(state.keywordFilter) || compactText(state.ipFilter) || compactText(state.authorFilter));
    state.shadow.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
    const autoButton = state.shadow.querySelector(".auto-load");
    if (autoButton) {
      autoButton.classList.toggle("active", state.autoScroll);
      autoButton.innerHTML = state.autoScroll ? '<span class="control-icon">Ⅱ</span>暂停加载' : '<span class="control-icon">▶</span>自动加载';
    }
    const refreshButton = state.shadow.querySelector(".refresh");
    if (refreshButton) {
      refreshButton.disabled = state.isRefreshing;
      refreshButton.textContent = state.isRefreshing ? "…" : "↻";
      refreshButton.title = state.isRefreshing ? "正在重新扫描" : "重新扫描当前评论区";
    }
    const comments = sortedComments();
    state.lastFilteredCount = comments.length;
    status.textContent = filtersActive
      ? `${state.status} · 筛选 ${comments.length}/${state.comments.size} 条`
      : state.status;
    list.innerHTML = comments.length
      ? comments.map((comment, index) => `
        <article class="card ${Number(comment.id) === Number(state.focusedCommentId) ? "focused" : ""}" data-comment-id="${comment.id}">
          <div class="rank ${index < 3 ? `rank-${index + 1}` : ""}">${index + 1}</div>
          <div class="body">
            <div class="top"><b>${escapeHtml(comment.author)}</b><span class="likes">♥ ${comment.likes.toLocaleString("zh-CN")}</span></div>
            <p>${escapeHtml(comment.content)}</p>
            <div class="card-foot"><small title="${escapeHtml(`${comment.timeText}${comment.ipLocation ? ` · IP ${comment.ipLocation}` : ""}`)}">${escapeHtml(comment.timeText)}${comment.ipLocation ? ` · IP ${escapeHtml(comment.ipLocation)}` : ""}</small><button class="jump" data-comment-id="${comment.id}">${comment.replyCount ? `查看 ${comment.replyCount} 条回复` : "定位原评论"}<span>↗</span></button></div>
          </div>
        </article>`).join("")
      : filtersActive
        ? '<div class="empty"><strong>没有符合条件的评论</strong><span>换一个关键词、IP 城市或昵称，也可以点击清空筛选。</span></div>'
        : '<div class="empty"><strong>等待评论出现</strong><span>打开视频评论区，选择自动或手动加载。</span></div>';
    list.scrollTop = previousScrollTop;
  }

  function minimizePanel() {
    if (!state.shadow) return;
    state.shadow.querySelector(".panel").style.display = "none";
    state.shadow.querySelector(".bubble").style.display = "grid";
    applyPosition(state.position?.left, state.position?.top);
  }

  function restorePanel() {
    if (!state.shadow) return;
    state.shadow.querySelector(".bubble").style.display = "none";
    state.shadow.querySelector(".panel").style.display = "flex";
    applySize(state.size?.width, state.size?.height);
    applyPosition(state.position?.left, state.position?.top);
  }

  function focusOriginalComment(commentId) {
    const comment = state.commentsById.get(Number(commentId));
    const element = comment?.element;
    if (!element?.isConnected) {
      state.status = "这条评论已离开当前页面，请继续加载后再试";
      render();
      return;
    }
    const replyButton = [...element.querySelectorAll('button, [role="button"]')].find((node) =>
      /(?:展开|查看).*条回复/.test(compactText(node.innerText || node.textContent))
    );
    state.autoScroll = false;
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    state.focusedCommentId = Number(commentId);
    state.status = replyButton ? "正在原评论区展开回复…" : "已定位到抖音原评论";
    render();
    saveSession(state.videoId, true);
    announceSorterState();
    if (replyButton) setTimeout(() => replyButton.click(), 420);
  }

  function ensureCommentList() {
    const list = activeCommentList();
    if (list) return list;
    document.querySelector('[data-e2e="feed-active-video"] [data-e2e="feed-comment-icon"]')?.click();
    return null;
  }

  function refreshComments() {
    if (state.isRefreshing) return;
    state.isRefreshing = true;
    const list = ensureCommentList();
    if (!list) {
      state.status = "正在打开评论区，稍后会自动重新扫描…";
      render();
      setTimeout(() => collect({ manual: true, forceRender: true }), 700);
      return;
    }
    state.status = "正在重新扫描当前评论区…";
    render();
    requestAnimationFrame(() => collect({ manual: true, forceRender: true }));
  }

  function loadMoreOnce() {
    const list = ensureCommentList();
    if (!list) {
      state.status = "正在打开抖音评论区…";
      render();
      return false;
    }
    // Instant positioning avoids repeatedly restarting smooth-scroll animation.
    // The page still performs its normal, visible comment-list loading flow.
    list.scrollTo({ top: Math.max(0, list.scrollHeight - list.clientHeight), behavior: "auto" });
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
    state.status = `正在加载更多评论，目前 ${state.comments.size} 条`;
    updateStatusText();
    scheduleCollect(850);
    return true;
  }

  function stopAutoLoad(message) {
    state.autoScroll = false;
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
    if (message) state.status = message;
    saveSession();
    announceSorterState();
    render();
  }

  function nextAutoDelay() {
    // A small randomized cushion prevents perfectly periodic scrolling while
    // keeping the fast setting responsive. When Douyin stops returning items,
    // the delay is increased below instead of hammering the comment list.
    const backoff = state.autoNoGrowth ? Math.min(state.autoNoGrowth * 350, 2100) : 0;
    const jitter = Math.round(Math.random() * 180);
    return Math.max(800, state.autoSpeed + backoff + jitter);
  }

  function autoLoadStep() {
    if (!state.autoScroll) return;
    if (state.comments.size > state.lastAutoCount) state.autoNoGrowth = 0;
    else state.autoNoGrowth += 1;
    state.lastAutoCount = state.comments.size;
    if (state.autoNoGrowth >= 7) {
      stopAutoLoad(`自动加载已暂停：连续未发现新评论（共 ${state.comments.size} 条）`);
      return;
    }
    loadMoreOnce();
    state.autoTimer = setTimeout(autoLoadStep, nextAutoDelay());
  }

  function toggleAutoLoad() {
    if (state.autoScroll) {
      stopAutoLoad(`已暂停自动加载，目前 ${state.comments.size} 条`);
      return;
    }
    state.autoScroll = true;
    state.autoNoGrowth = 0;
    state.lastAutoCount = Math.max(0, state.comments.size - 1);
    state.status = "自动加载已启动，不会切换视频";
    render();
    saveSession();
    announceSorterState();
    autoLoadStep();
  }

  function applyPosition(left, top, save = false) {
    if (!state.host) return;
    const rect = state.host.getBoundingClientRect();
    const width = rect.width || 390;
    const height = rect.height || 60;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - Math.min(height, window.innerHeight - 16) - 8);
    const position = {
      left: Math.max(8, Math.min(Number(left) || 18, maxLeft)),
      top: Math.max(8, Math.min(Number(top) || 18, maxTop))
    };
    state.host.style.left = `${position.left}px`;
    state.host.style.top = `${position.top}px`;
    state.host.style.right = "auto";
    state.position = position;
    if (save) chrome.storage.local.set({ panelPosition: position });
  }

  function applySize(width, height, save = false) {
    const panel = state.shadow?.querySelector(".panel");
    if (!panel) return;
    const availableWidth = Math.max(300, window.innerWidth - (state.position?.left || 18) - 8);
    const availableHeight = Math.max(360, window.innerHeight - (state.position?.top || 18) - 8);
    const size = {
      width: Math.max(300, Math.min(Number(width) || 380, availableWidth)),
      height: Math.max(360, Math.min(Number(height) || 700, availableHeight))
    };
    panel.style.width = `${size.width}px`;
    panel.style.height = `${size.height}px`;
    state.size = size;
    if (save) chrome.storage.local.set({ panelSize: size });
  }

  function enableResizing(handle) {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const panel = state.shadow.querySelector(".panel");
      const rect = panel.getBoundingClientRect();
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      startWidth = rect.width;
      startHeight = rect.height;
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!resizing) return;
      applySize(startWidth + event.clientX - startX, startHeight + event.clientY - startY);
    });
    const finish = () => {
      if (!resizing) return;
      resizing = false;
      applySize(state.size.width, state.size.height, true);
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  function enableDragging(handle) {
    let dragging = false;
    let moved = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = state.host.getBoundingClientRect();
      dragging = true;
      moved = false;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      moved = true;
      applyPosition(event.clientX - offsetX, event.clientY - offsetY);
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      if (moved && state.position) chrome.storage.local.set({ panelPosition: state.position });
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  function mount() {
    if (state.host) {
      state.host.style.display = "block";
      scheduleCollect();
      announceSorterState();
      return;
    }
    const host = document.createElement("douyin-comment-sorter");
    // Start on the left so the panel does not cover Douyin's right-side comment controls.
    host.style.cssText = "position:fixed;left:18px;top:18px;z-index:2147483647;display:block";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host{--ink:#14151a;--muted:#777b87;--line:#e8e9ee;--purple:#7357ff;--pink:#ff3c67}*{box-sizing:border-box}
        button,select,input{font-family:inherit}.panel{position:relative;width:380px;height:700px;display:flex;flex-direction:column;overflow:hidden;color:var(--ink);background:rgba(247,248,251,.98);border:1px solid rgba(255,255,255,.75);border-radius:22px;box-shadow:0 24px 70px rgba(9,10,18,.28),0 2px 8px rgba(9,10,18,.1);font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;backdrop-filter:blur(18px)}
        header{padding:15px 16px 12px;color:white;background:radial-gradient(circle at 90% 0,rgba(122,85,255,.5),transparent 42%),linear-gradient(145deg,#171822,#25223b)}.title{display:flex;align-items:center;justify-content:space-between;cursor:move;touch-action:none;user-select:none}.heading{display:flex;align-items:center;gap:10px}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,#ff416c,#7657ff);box-shadow:0 7px 18px rgba(117,87,255,.32);font-size:13px;font-weight:900}h2{margin:0;font-size:15px;letter-spacing:.2px}.subtitle{margin-top:2px;color:#aaaabd;font-size:9px}.minimize{width:30px;height:30px;border:1px solid rgba(255,255,255,.08);border-radius:10px;color:white;background:rgba(255,255,255,.09);font-size:18px;line-height:1;cursor:pointer}.minimize:hover{background:rgba(255,255,255,.17)}
        .tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:13px;padding:3px;border:1px solid rgba(255,255,255,.06);border-radius:11px;background:rgba(0,0,0,.18)}.tabs button{padding:8px 4px;border:0;border-radius:8px;color:#b9b9c8;background:transparent;font-size:11px;cursor:pointer;transition:.18s}.tabs button:hover{color:white}.tabs button.active{color:#171822;background:white;box-shadow:0 3px 10px rgba(0,0,0,.18);font-weight:700}
        .scanbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px 7px;background:white}.status-wrap{display:flex;min-width:0;align-items:center;gap:7px}.pulse{flex:none;width:7px;height:7px;border-radius:50%;background:#35c98b;box-shadow:0 0 0 4px rgba(53,201,139,.12)}.status{overflow:hidden;color:#676b76;font-size:10px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.refresh{flex:none;width:28px;height:28px;border:0;border-radius:9px;color:#6754d8;background:#f0edff;font-size:14px;cursor:pointer}.refresh:hover{background:#e8e2ff}
        .filter-controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;gap:6px;padding:5px 12px 7px;background:white}.filter-controls input{min-width:0;height:34px;padding:0 8px;border:1px solid var(--line);border-radius:10px;color:#343640;background:#fafaff;font-size:10px;outline:none;transition:.18s}.filter-controls input::placeholder{color:#9b9eaa}.filter-controls input:focus{border-color:#8b75ff;background:white;box-shadow:0 0 0 3px rgba(115,87,255,.09)}.clear-filters{height:34px;padding:0 9px;border:1px solid var(--line);border-radius:10px;color:#737783;background:white;font-size:10px;font-weight:700;cursor:pointer}.clear-filters:hover{color:#6548ed;border-color:#cfc7ff;background:#faf9ff}
        .loader-controls{display:grid;grid-template-columns:1.25fr 1fr auto;gap:6px;padding:5px 12px 11px;border-bottom:1px solid var(--line);background:white}.loader-controls button{height:34px;border:1px solid var(--line);border-radius:10px;color:#454852;background:white;font-size:10px;font-weight:700;cursor:pointer}.loader-controls button:hover{border-color:#cfc7ff;background:#faf9ff}.loader-controls .auto-load{color:white;border-color:#7357ff;background:linear-gradient(135deg,#8066ff,#6548ed);box-shadow:0 6px 15px rgba(115,87,255,.2)}.loader-controls .auto-load.active{color:#6548ed;background:#eeeaff;box-shadow:none}.control-icon{margin-right:5px;font-size:9px}.speed{width:55px;height:34px;padding:0 5px;border:1px solid var(--line);border-radius:10px;color:#666a75;background:white;font-size:10px;outline:none;cursor:pointer}
        .list{flex:1;min-height:0;overflow:auto;padding:10px 10px 16px;scrollbar-width:thin;scrollbar-color:#cfd1da transparent}.card{display:flex;gap:10px;margin-bottom:8px;padding:12px;border:1px solid rgba(225,227,234,.9);border-radius:15px;background:rgba(255,255,255,.94);box-shadow:0 3px 12px rgba(27,29,40,.035);transition:border-color .18s,transform .18s}.card:hover{border-color:#d8d2ff;transform:translateY(-1px)}.card.focused{border-color:#8b75ff;box-shadow:0 0 0 2px rgba(115,87,255,.14),0 5px 14px rgba(80,64,180,.12)}.rank{display:grid;place-items:center;flex:0 0 27px;height:27px;border-radius:9px;color:#7562d6;background:#f0edff;font-size:10px;font-weight:800}.rank-1{color:#9c6814;background:#fff0bd}.rank-2{color:#636b78;background:#e9edf2}.rank-3{color:#9b5940;background:#f6ded4}.body{min-width:0;flex:1}.top{display:flex;align-items:center;justify-content:space-between;gap:8px}.top b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.likes{flex:none;color:#ff476e;font-size:10px}.body p{margin:7px 0 9px;color:#30323a;font-size:12px;line-height:1.55;word-break:break-word}.card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}.card-foot small{min-width:0;overflow:hidden;color:#9a9da6;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.jump{flex:none;padding:4px 7px;border:0;border-radius:7px;color:#6952df;background:#f0edff;font-size:9px;font-weight:700;cursor:pointer}.jump:hover{color:white;background:#7357ff}.jump span{margin-left:3px}.empty{display:flex;min-height:190px;align-items:center;justify-content:center;flex-direction:column;gap:7px;color:#9699a2;text-align:center}.empty strong{color:#555964;font-size:13px}.empty span{max-width:230px;font-size:11px;line-height:1.5}
        footer{padding:8px 14px;color:#9598a1;background:white;border-top:1px solid var(--line);font-size:9px;line-height:1.4}.resize-handle{position:absolute;right:2px;bottom:2px;width:18px;height:18px;cursor:nwse-resize;touch-action:none}.resize-handle:after{content:"";position:absolute;right:4px;bottom:4px;width:7px;height:7px;border-right:2px solid #a9a4c5;border-bottom:2px solid #a9a4c5;border-radius:1px}
        .bubble{display:none;place-items:center;width:54px;height:54px;border:1px solid rgba(255,255,255,.4);border-radius:18px;color:white;background:radial-gradient(circle at 75% 15%,rgba(255,255,255,.35),transparent 28%),linear-gradient(135deg,#ff416c,#7155f5);box-shadow:0 14px 36px rgba(14,15,23,.3);font-size:17px;font-weight:900;cursor:pointer}
      </style>
      <section class="panel">
        <header><div class="title" title="按住这里拖动"><div class="heading"><span class="brand-mark">评</span><div><h2>抖音评论助手</h2><div class="subtitle">COMMENT ASSISTANT</div></div></div><button class="minimize" title="缩成悬浮按钮">—</button></div><div class="tabs"><button data-mode="hot">热度优先</button><button data-mode="newest">最新评论</button><button data-mode="oldest">最早评论</button></div></header>
        <div class="scanbar"><div class="status-wrap"><span class="pulse"></span><span class="status">正在查找评论…</span></div><button class="refresh" title="重新扫描">↻</button></div>
        <section class="filter-controls"><input class="keyword-filter" type="search" maxlength="80" placeholder="关键词" title="按评论内容筛选"><input class="ip-filter" type="search" maxlength="30" placeholder="IP城市" title="按评论者 IP 属地筛选"><input class="author-filter" type="search" maxlength="80" placeholder="昵称，如芝士松露卷" title="按评论者昵称筛选，支持输入昵称的一部分"><button class="clear-filters" title="清空全部筛选">清空</button></section>
        <section class="loader-controls"><button class="auto-load"><span class="control-icon">▶</span>自动加载</button><button class="manual-load">＋ 手动加载</button><select class="speed" title="自动加载速度"><option value="4000">慢速</option><option value="2100" selected>标准</option><option value="800">快速</option></select></section>
        <main class="list"></main>
        <footer>拖动标题栏移动 · 拖动右下角缩放 · 点击评论可回到原回复区</footer>
        <div class="resize-handle" title="拖动缩放"></div>
      </section>`;
    shadow.innerHTML += '<button class="bubble" title="展开抖音评论助手">评</button>';
    document.documentElement.appendChild(host);
    state.host = host;
    state.shadow = shadow;
    const panel = shadow.querySelector(".panel");
    const bubble = shadow.querySelector(".bubble");
    shadow.querySelector(".minimize").addEventListener("click", minimizePanel);
    bubble.addEventListener("click", restorePanel);
    enableDragging(shadow.querySelector(".title"));
    enableResizing(shadow.querySelector(".resize-handle"));
    const keywordInput = shadow.querySelector(".keyword-filter");
    const ipInput = shadow.querySelector(".ip-filter");
    const authorInput = shadow.querySelector(".author-filter");
    protectTextInputFromPageShortcuts(keywordInput);
    protectTextInputFromPageShortcuts(ipInput);
    protectTextInputFromPageShortcuts(authorInput);
    keywordInput.value = state.keywordFilter;
    ipInput.value = state.ipFilter;
    authorInput.value = state.authorFilter;
    keywordInput.addEventListener("input", () => {
      state.keywordFilter = keywordInput.value;
      chrome.storage.local.set({ commentKeyword: state.keywordFilter });
      render();
    });
    ipInput.addEventListener("input", () => {
      state.ipFilter = ipInput.value;
      chrome.storage.local.set({ ipCity: state.ipFilter });
      render();
    });
    authorInput.addEventListener("input", () => {
      state.authorFilter = authorInput.value;
      chrome.storage.local.set({ commentAuthor: state.authorFilter });
      render();
    });
    shadow.querySelector(".clear-filters").addEventListener("click", () => {
      state.keywordFilter = "";
      state.ipFilter = "";
      state.authorFilter = "";
      keywordInput.value = "";
      ipInput.value = "";
      authorInput.value = "";
      chrome.storage.local.set({ commentKeyword: "", ipCity: "", commentAuthor: "", commentUserId: "" });
      render();
    });
    shadow.querySelector(".speed").value = String(state.autoSpeed);
    shadow.querySelector(".refresh").addEventListener("click", refreshComments);
    shadow.querySelector(".auto-load").addEventListener("click", toggleAutoLoad);
    shadow.querySelector(".manual-load").addEventListener("click", loadMoreOnce);
    shadow.querySelector(".speed").addEventListener("change", (event) => {
      state.autoSpeed = normalizeAutoSpeed(event.target.value);
      chrome.storage.local.set({ autoSpeed: state.autoSpeed });
      if (state.autoScroll) {
        clearTimeout(state.autoTimer);
        state.autoTimer = setTimeout(autoLoadStep, state.autoSpeed);
      }
    });
    shadow.querySelector(".list").addEventListener("click", (event) => {
      const button = event.target.closest(".jump");
      if (button) focusOriginalComment(button.dataset.commentId);
    });
    shadow.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", async () => {
      state.mode = button.dataset.mode;
      await chrome.storage.local.set({ sortMode: state.mode });
      render();
    }));
    state.observer = new MutationObserver(scheduleCollect);
    // Keep the expensive observer inside the comment container. A lightweight
    // check notices when Douyin replaces that container during navigation.
    state.listWatchTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (activeCommentList() !== state.scrollContainer) collect();
    }, 2500);
    requestAnimationFrame(() => {
      applySize(state.size?.width, state.size?.height);
      applyPosition(state.position?.left, state.position?.top);
    });
    render();
    collect();
    announceSorterState();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SHOW_SORTER") {
      if (message.sortMode) state.mode = message.sortMode;
      mount();
    }
    if (message?.type === "BACKGROUND_AUTO_LOAD" && state.autoScroll) {
      // This arrives from Chrome's minimum 30-second alarm while the tab is
      // backgrounded. It uses the same visible-list scroll as the foreground
      // loader and never calls Douyin's internal comment endpoint directly.
      loadMoreOnce();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveSession(state.videoId, true);
      return;
    }
    scheduleCollect();
    restartAutoLoad();
  });
  window.addEventListener("pagehide", () => saveSession(state.videoId, true));
  window.addEventListener("freeze", () => saveSession(state.videoId, true));

  storageSession().get(SESSION_KEY).then((values) => {
    state.sessionSnapshot = values[SESSION_KEY] || null;
    scheduleCollect();
  }).catch(() => {});

  chrome.storage.local.get(["sortMode", "showOnNextPage", "panelPosition", "panelSize", "autoSpeed", "commentKeyword", "ipCity", "commentAuthor"], async (values) => {
    state.mode = values.sortMode || "hot";
    state.position = values.panelPosition || { left: 18, top: 18 };
    state.size = values.panelSize || { width: 380, height: 700 };
    state.autoSpeed = normalizeAutoSpeed(values.autoSpeed);
    state.keywordFilter = values.commentKeyword || "";
    state.ipFilter = values.ipCity || "";
    state.authorFilter = values.commentAuthor || "";
    if (values.showOnNextPage) {
      await chrome.storage.local.set({ showOnNextPage: false });
      mount();
    }
  });
})();
