/* ============================================================
   GoreTok — front end
   - Age gate (Yes -> enter, No -> leave)
   - Auth gate (login / register) shown after the age gate
   - Vertical video feed built from REAL posts (GET /api/goretok/posts)
   - Empty state when there are no posts
   - URL-based upload (POST /api/goretok/posts)
   - Server-backed likes (POST /api/goretok/like)
   - Profile view from GET /api/goretok/me (role badge, own + liked posts,
     warn/ban status from the MQTT bridge)
   - Shared MQTT moderation bridge (unchanged); login drives the handle.
   ============================================================ */

(function () {
  "use strict";

  const API = window.GoreTokAPI;

  /* -------------------- DOM refs -------------------- */
  const ageGate = document.getElementById("ageGate");
  const authGate = document.getElementById("authGate");
  const app = document.getElementById("app");
  const blocked = document.getElementById("blocked");
  const btnYes = document.getElementById("btnYes");
  const btnNo = document.getElementById("btnNo");
  const btnBack = document.getElementById("btnBack");
  const feed = document.getElementById("feed");
  const pager = document.getElementById("pager");

  const AGE_KEY = "goretok_age_ok";
  const MAX_TAGS = 10;

  /* -------------------- Session state -------------------- */
  // Current logged-in user (from /me). null while a guest / logged out.
  let currentUser = null;
  // Loaded posts + the set of post ids the current user has liked.
  let posts = [];
  let likedSet = new Set();
  let nextCursor = 0;
  let loadingMore = false;
  // Cache of hashtag usage counts ({ tag: count }), refreshed from /tags.
  let tagCounts = {};
  // Active client-side hashtag filter (null when the full feed is shown).
  let activeTag = null;

  /* ============================================================
     AUTH
     ============================================================ */
  let authMode = "login"; // "login" | "register"

  function setAuthMode(mode) {
    authMode = mode;
    const submit = document.getElementById("authSubmit");
    const subtitle = document.getElementById("authSubtitle");
    const prompt = document.getElementById("authTogglePrompt");
    const link = document.getElementById("authToggleLink");
    const pwd = document.getElementById("authPassword");
    if (mode === "register") {
      submit.textContent = "Create account";
      subtitle.textContent = "Create an account to post, like and follow the feed.";
      prompt.textContent = "Already have an account?";
      link.textContent = "Log in";
      if (pwd) pwd.autocomplete = "new-password";
    } else {
      submit.textContent = "Log in";
      subtitle.textContent = "Log in to post, like and follow the feed.";
      prompt.textContent = "New here?";
      link.textContent = "Create an account";
      if (pwd) pwd.autocomplete = "current-password";
    }
    setAuthError("");
  }

  function setAuthError(msg) {
    const el = document.getElementById("authError");
    if (el) el.textContent = msg || "";
  }

  function showAuthGate() {
    if (authGate) authGate.hidden = false;
    const h = document.getElementById("authHandle");
    if (h) setTimeout(() => h.focus(), 50);
  }

  function hideAuthGate() {
    if (authGate) authGate.hidden = true;
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const handle = document.getElementById("authHandle").value.trim();
    const password = document.getElementById("authPassword").value;
    const submit = document.getElementById("authSubmit");
    setAuthError("");
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "Please wait…";
    try {
      if (authMode === "register") {
        await API.register(handle, password);
      } else {
        await API.login(handle, password);
      }
      hideAuthGate();
      await onLoggedIn();
    } catch (err) {
      setAuthError(err.message || "Could not sign in.");
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  }

  function wireAuth() {
    const form = document.getElementById("authForm");
    const link = document.getElementById("authToggleLink");
    if (form) form.addEventListener("submit", handleAuthSubmit);
    if (link) link.addEventListener("click", (e) => {
      e.preventDefault();
      setAuthMode(authMode === "login" ? "register" : "login");
    });
  }

  // Called after the age gate is passed: decide auth vs app.
  async function proceedAfterAge() {
    const sess = await API.session();
    if (sess && sess.valid) {
      hideAuthGate();
      await onLoggedIn();
    } else {
      API.clearToken();
      setAuthMode("login");
      showAuthGate();
    }
  }

  // After a valid session is confirmed / established.
  async function onLoggedIn() {
    try {
      currentUser = await API.me();
    } catch (err) {
      // Token invalid/expired — route back to auth.
      API.clearToken();
      currentUser = null;
      setAuthMode("login");
      showAuthGate();
      return;
    }
    likedSet = new Set(currentUser.likedPosts || []);

    // Moderation identity follows the logged-in handle.
    if (window.GoreTokMod && typeof window.GoreTokMod.setHandle === "function") {
      window.GoreTokMod.setHandle(currentUser.handle);
    }
    updateAccountStatus();
    await loadFeed();
  }

  /* ============================================================
     FEED — real posts + empty state
     ============================================================ */
  async function loadFeed() {
    feed.innerHTML = "";
    posts = [];
    nextCursor = 0;
    hideEmptyState();
    activeTag = null;
    removeFilterBar();
    try {
      await refreshTagCounts();
      const data = await API.listPosts(20, 0);
      posts = data.posts || [];
      nextCursor = data.nextCursor;
      if (posts.length === 0) {
        showEmptyState();
        buildPager();
        return;
      }
      renderPosts(posts, true);
    } catch (err) {
      showEmptyState("Could not load the feed. Try again shortly.");
      buildPager();
    }
  }

  function renderPosts(list, replace) {
    const frag = document.createDocumentFragment();
    const startIndex = replace ? 0 : feed.querySelectorAll(".slide").length;
    list.forEach((p, i) => frag.appendChild(buildSlide(p, startIndex + i)));
    feed.appendChild(frag);
    buildPager();
    wirePlayback();
  }

  // Build one feed slide from a post record.
  function buildSlide(p, index) {
    const slide = document.createElement("section");
    slide.className = "slide";
    slide.dataset.index = index;
    slide.dataset.postId = p.id;

    const media = document.createElement("div");
    media.className = "slide-media";
    media.style.background = "linear-gradient(180deg, #2a0e16 0%, #0a0a0f 100%)";

    const video = document.createElement("video");
    video.className = "slide-video";
    video.src = p.videoUrl;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("webkit-playsinline", "true");
    media.appendChild(video);

    const play = document.createElement("div");
    play.className = "play";

    media.addEventListener("click", () => togglePlay(video, slide));
    play.addEventListener("click", (e) => { e.stopPropagation(); togglePlay(video, slide); });
    video.addEventListener("play", () => slide.classList.add("playing"));
    video.addEventListener("pause", () => slide.classList.remove("playing"));

    // Duration badge (mm:ss) — omitted entirely when unknown. Old posts that
    // still carry a `category` field simply don't get a badge.
    let badge = null;
    const durSec = Number(p.durationSec);
    if (Number.isFinite(durSec) && durSec > 0) {
      badge = document.createElement("div");
      badge.className = "kind-badge";
      badge.textContent = formatDuration(durSec);
    }

    const caption = document.createElement("div");
    caption.className = "caption";
    const tagsHtml = (p.tags || [])
      .map((t) => {
        const c = tagCounts[t];
        const cnt = (typeof c === "number")
          ? ` <span class="tag-count">· ${escapeHtml(countLabel(c))}</span>`
          : "";
        return `<span class="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>${cnt}`;
      })
      .join(" ");
    caption.innerHTML =
      `<div class="user">@${escapeHtml(p.author)}</div>` +
      `<div class="text">${escapeHtml(p.title)} ${tagsHtml}</div>`;
    caption.querySelectorAll(".tag[data-tag]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        filterFeedByTag(el.dataset.tag);
      });
    });

    const liked = likedSet.has(p.id);
    const rail = document.createElement("div");
    rail.className = "rail";
    rail.innerHTML =
      `<button class="like${liked ? " liked" : ""}" title="Like">♥</button>` +
      `<span class="count like-count">${formatCount(p.likeCount || 0)}</span>` +
      `<button class="comment" title="Comments">💬</button>` +
      `<button class="share" title="Share">↗</button>` +
      `<button class="report" title="Report this clip">⚑</button>`;

    rail.querySelector(".like").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLike(p, e.currentTarget);
    });
    rail.querySelector(".report").addEventListener("click", (e) => {
      e.stopPropagation();
      reportSlide(p, e.currentTarget);
    });

    slide.append(media, play, caption, rail);
    if (badge) slide.appendChild(badge);
    return slide;
  }

  function formatCount(n) {
    n = Number(n) || 0;
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  // Seconds -> m:ss (e.g. 67 -> "1:07", 42 -> "0:42").
  function formatDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }

  // "1 video" (singular) vs "N videos".
  function countLabel(n) {
    n = Number(n) || 0;
    return n === 1 ? "1 video" : n + " videos";
  }

  /* -------------------- Empty state -------------------- */
  function emptyStateEl() {
    let el = document.getElementById("feedEmpty");
    if (!el) {
      el = document.createElement("div");
      el.id = "feedEmpty";
      el.className = "feed-empty";
      feed.parentElement.appendChild(el);
    }
    return el;
  }

  function showEmptyState(message) {
    feed.style.display = "none";
    pager.style.display = "none";
    const el = emptyStateEl();
    el.hidden = false;
    el.innerHTML =
      `<div class="fe-card">` +
        `<div class="fe-icon">🎬</div>` +
        `<h2>No posts yet</h2>` +
        `<p>${escapeHtml(message || "Be the first to post a clip to GoreTok.")}</p>` +
        `<button class="btn btn-yes" id="feEmptyUpload">Post a clip</button>` +
      `</div>`;
    const up = document.getElementById("feEmptyUpload");
    if (up) up.addEventListener("click", () => navigateTo("upload"));
  }

  function hideEmptyState() {
    const el = document.getElementById("feedEmpty");
    if (el) el.hidden = true;
    feed.style.display = "";
    pager.style.display = "";
  }

  /* -------------------- Pagination dots -------------------- */
  function buildPager() {
    pager.innerHTML = "";
    const count = feed.querySelectorAll(".slide").length;
    for (let i = 0; i < count; i++) {
      const dot = document.createElement("span");
      dot.className = "dot" + (i === 0 ? " active" : "");
      pager.appendChild(dot);
    }
  }

  function updatePager() {
    const idx = currentIndex();
    pager.querySelectorAll(".dot").forEach((d, i) => {
      d.classList.toggle("active", i === idx);
    });
    maybeLoadMore();
  }

  function currentIndex() {
    if (!feed.clientHeight) return 0;
    return Math.round(feed.scrollTop / feed.clientHeight);
  }

  // Infinite scroll: fetch the next page as the user nears the end.
  async function maybeLoadMore() {
    if (activeTag) return; // filtered view is a client-side subset; don't append
    if (loadingMore || nextCursor == null) return;
    const total = feed.querySelectorAll(".slide").length;
    if (total === 0) return;
    if (currentIndex() < total - 2) return;
    loadingMore = true;
    try {
      const data = await API.listPosts(20, nextCursor);
      nextCursor = data.nextCursor;
      const more = data.posts || [];
      if (more.length) {
        posts = posts.concat(more);
        renderPosts(more, false);
      }
    } catch (_) {
      /* silent — keep what we have */
    } finally {
      loadingMore = false;
    }
  }

  /* -------------------- Likes (server-backed) -------------------- */
  async function toggleLike(post, btn) {
    if (!API.isLoggedIn()) {
      showToast("Log in required", "Please log in to like posts.");
      return;
    }
    const wantLiked = !btn.classList.contains("liked");
    btn.disabled = true;
    try {
      const res = await API.like(post.id, wantLiked);
      btn.classList.toggle("liked", res.liked);
      const countEl = btn.parentElement.querySelector(".like-count");
      if (countEl) countEl.textContent = formatCount(res.likeCount);
      post.likeCount = res.likeCount;
      if (res.liked) likedSet.add(post.id); else likedSet.delete(post.id);
    } catch (err) {
      showToast("Could not update like", err.message || "Try again shortly.");
    } finally {
      btn.disabled = false;
    }
  }

  /* -------------------- Playback -------------------- */
  function togglePlay(video, slide) {
    if (video.paused) {
      feed.querySelectorAll("video.slide-video").forEach((v) => { if (v !== video) v.pause(); });
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  let io = null;
  function wirePlayback() {
    if (!("IntersectionObserver" in window)) return;
    if (!io) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const video = entry.target.querySelector("video.slide-video");
            if (!video) return;
            if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
              feed.querySelectorAll("video.slide-video").forEach((v) => { if (v !== video) v.pause(); });
              video.play().catch(() => {});
            } else {
              video.pause();
            }
          });
        },
        { root: feed, threshold: [0, 0.6, 1] }
      );
    }
    feed.querySelectorAll(".slide").forEach((s) => {
      if (!s.dataset.observed) { io.observe(s); s.dataset.observed = "1"; }
    });
  }

  /* -------------------- Keyboard navigation -------------------- */
  function goTo(index) {
    const count = feed.querySelectorAll(".slide").length;
    const clamped = Math.max(0, Math.min(count - 1, index));
    feed.scrollTo({ top: clamped * feed.clientHeight, behavior: "smooth" });
  }

  function onKey(e) {
    if (app.classList.contains("locked")) return;
    if (authGate && !authGate.hidden) return;
    if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "j") {
      e.preventDefault();
      goTo(currentIndex() + 1);
    } else if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "k") {
      e.preventDefault();
      goTo(currentIndex() - 1);
    }
  }

  /* -------------------- Reporting (shared admin console) -------------------- */
  const reported = new Set();

  function reportSlide(p, btn) {
    const key = p.id;
    if (reported.has(key)) {
      showToast("Already reported", "You reported this clip.");
      return;
    }
    if (!window.GoreTokMod) {
      showToast("Unavailable", "Moderation bridge is not loaded.");
      return;
    }
    const ok = window.GoreTokMod.report({
      user: "@" + p.author,
      text: p.title,
      reason: "Viewer report",
      severity: "MEDIUM",
    });
    if (ok) {
      reported.add(key);
      if (btn) btn.classList.add("reported");
      showToast("Report sent", "A moderator will review this clip.");
    } else {
      showToast("Not connected", "Could not reach moderation. Try again shortly.");
    }
  }

  /* -------------------- Admin toast (broadcast / DM / notices) -------------------- */
  let toastTimer = null;
  function showToast(title, msg) {
    const el = document.getElementById("adminToast");
    if (!el) return;
    document.getElementById("adminToastTitle").textContent = title;
    document.getElementById("adminToastMsg").textContent = msg;
    el.hidden = false;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => { el.hidden = true; }, 300);
    }, 5000);
  }

  /* -------------------- Ban / warn screens -------------------- */
  function showBan(info) {
    const screen = document.getElementById("banScreen");
    if (!screen) return;
    document.getElementById("banReason").textContent =
      info && info.reason ? `Reason: ${info.reason}` : "Your access was suspended by moderation.";
    const exp = document.getElementById("banExpiry");
    if (info && info.expiresAt) {
      const d = new Date(info.expiresAt);
      exp.textContent = "Expires: " + d.toLocaleString();
    } else {
      exp.textContent = info && info.expiresAt === null ? "Permanent ban." : "";
    }
    feed.querySelectorAll("video.slide-video").forEach((v) => v.pause());
    ageGate.classList.add("hidden");
    app.style.display = "none";
    if (blocked) blocked.hidden = true;
    screen.hidden = false;
  }

  function clearBan() {
    const screen = document.getElementById("banScreen");
    if (screen) screen.hidden = true;
    app.style.display = "";
  }

  function showWarn(on) {
    const banner = document.getElementById("warnBanner");
    if (banner) banner.hidden = !on;
    // Reflect in profile if it is open.
    if (currentView === "profile") renderProfile();
  }

  /* -------------------- Wire up the moderation bridge -------------------- */
  function initModeration() {
    if (!window.GoreTokMod) return;
    const mod = window.GoreTokMod;

    const storedBan = mod.getStoredBan();

    mod.on("broadcast", (d) => showToast("📢 Announcement", d.message || ""));
    mod.on("dm", (d) => showToast("💬 Message from moderation", d.message || ""));
    mod.on("warn", (d) => showWarn(d.warned));
    mod.on("ban", (d) => { if (d.banned) showBan(d); else clearBan(); });

    mod.init();

    if (mod.isWarned()) showWarn(true);
    if (storedBan) showBan(storedBan);
  }

  /* ============================================================
     SIDEBAR NAVIGATION + VIEWS
     ============================================================ */
  let currentView = "foryou";

  function wireNav() {
    const items = document.querySelectorAll(".nav-item");
    items.forEach((btn) => {
      btn.addEventListener("click", () => navigateTo(btn.dataset.view));
    });
  }

  function navigateTo(view) {
    const items = document.querySelectorAll(".nav-item");
    items.forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    showView(view);
  }

  function showView(view) {
    currentView = view;
    let placeholder = document.getElementById("viewPlaceholder");

    if (view === "foryou") {
      if (placeholder) placeholder.hidden = true;
      if (posts.length === 0) {
        showEmptyState();
      } else {
        hideEmptyState();
        const current = feed.querySelectorAll(".slide")[currentIndex()];
        const v = current && current.querySelector("video.slide-video");
        if (v) v.play().catch(() => {});
      }
      return;
    }

    // Pause playback, hide feed + empty state while a panel is shown.
    feed.querySelectorAll("video.slide-video").forEach((v) => v.pause());
    feed.style.display = "none";
    pager.style.display = "none";
    const empty = document.getElementById("feedEmpty");
    if (empty) empty.hidden = true;

    if (!placeholder) {
      placeholder = document.createElement("div");
      placeholder.id = "viewPlaceholder";
      placeholder.className = "view-placeholder";
      feed.parentElement.appendChild(placeholder);
    }
    placeholder.hidden = false;

    if (view === "upload") renderUpload(placeholder);
    else if (view === "profile") renderProfile(placeholder);
    else if (view === "discover") renderDiscover(placeholder);
    else renderSimpleView(placeholder, view);
  }

  const SIMPLE_VIEWS = {
    moderation: { icon: "⚑", title: "Moderation", text: "Manual review queue. Every clip is subject to review — real violence or real harm is removed." },
  };

  function renderSimpleView(placeholder, view) {
    const info = SIMPLE_VIEWS[view] || { icon: "•", title: view, text: "" };
    placeholder.innerHTML =
      `<div class="vp-card">` +
        `<div class="vp-icon">${escapeHtml(info.icon)}</div>` +
        `<h2>${escapeHtml(info.title)}</h2>` +
        `<p>${escapeHtml(info.text)}</p>` +
        `<span class="vp-soon">Coming soon</span>` +
      `</div>`;
  }

  /* -------------------- Hashtags: counts cache + Discover -------------------- */
  // Refresh the tag -> count cache from /tags. Best-effort; silent on error.
  async function refreshTagCounts() {
    try {
      const tags = await API.listTags();
      const map = {};
      (tags || []).forEach((t) => { if (t && t.tag != null) map[t.tag] = t.count; });
      tagCounts = map;
    } catch (_) { /* keep the last cache */ }
  }

  function renderDiscover(placeholder) {
    placeholder = placeholder || document.getElementById("viewPlaceholder");
    if (!placeholder) return;
    placeholder.innerHTML =
      `<div class="vp-card wide">` +
        `<div class="vp-icon">⌕</div>` +
        `<h2>Discover hashtags</h2>` +
        `<div id="discoverBody"><p class="vp-loading">Loading hashtags…</p></div>` +
      `</div>`;
    const body = document.getElementById("discoverBody");
    API.listTags().then((tags) => {
      tags = tags || [];
      // Refresh the caption count cache while we're here.
      const map = {};
      tags.forEach((t) => { if (t && t.tag != null) map[t.tag] = t.count; });
      tagCounts = map;
      if (tags.length === 0) {
        body.innerHTML =
          `<div class="discover-empty">No hashtags yet — they appear once people post with them.</div>`;
        return;
      }
      const chips = tags.map((t) =>
        `<button class="tag-chip" data-tag="${escapeHtml(t.tag)}">` +
          `#${escapeHtml(t.tag)} <span class="tag-count">· ${escapeHtml(countLabel(t.count))}</span>` +
        `</button>`
      ).join("");
      body.innerHTML = `<div class="discover-tags">${chips}</div>`;
      body.querySelectorAll(".tag-chip[data-tag]").forEach((el) => {
        el.addEventListener("click", () => filterFeedByTag(el.dataset.tag));
      });
    }).catch(() => {
      if (body) body.innerHTML =
        `<div class="discover-empty">Could not load hashtags. Try again shortly.</div>`;
    });
  }

  // Client-side filter the already-fetched feed to posts carrying `tag`.
  function filterFeedByTag(tag) {
    activeTag = tag;
    const filtered = posts.filter((p) => (p.tags || []).indexOf(tag) !== -1);
    navigateTo("foryou");
    hideEmptyState();
    feed.innerHTML = "";
    if (filtered.length === 0) {
      showEmptyState(`No clips tagged #${tag} yet.`);
    } else {
      renderPosts(filtered, true);
      feed.scrollTo({ top: 0 });
    }
    showFilterBar(tag);
  }

  function clearTagFilter() {
    activeTag = null;
    removeFilterBar();
    feed.innerHTML = "";
    if (posts.length === 0) {
      showEmptyState();
    } else {
      hideEmptyState();
      renderPosts(posts, true);
      feed.scrollTo({ top: 0 });
    }
  }

  function showFilterBar(tag) {
    let bar = document.getElementById("feedFilterBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "feedFilterBar";
      bar.className = "feed-filter-bar";
      feed.parentElement.appendChild(bar);
    }
    bar.hidden = false;
    bar.innerHTML =
      `<span class="ff-label">Showing #${escapeHtml(tag)}</span>` +
      `<button class="ff-clear" id="ffClear">Clear</button>`;
    const clr = document.getElementById("ffClear");
    if (clr) clr.addEventListener("click", clearTagFilter);
  }

  function removeFilterBar() {
    const bar = document.getElementById("feedFilterBar");
    if (bar) bar.hidden = true;
  }

  /* -------------------- Upload view (file + URL) -------------------- */
  // The video file the user picked/dropped (null when posting by URL).
  let pickedFile = null;

  function renderUpload(placeholder) {
    pickedFile = null;
    placeholder.innerHTML =
      `<div class="vp-card wide">` +
        `<div class="vp-icon">▲</div>` +
        `<h2>Upload a clip</h2>` +
        `<form class="upload-form" id="uploadForm">` +
          `<label for="upTitle">Title</label>` +
          `<input type="text" id="upTitle" maxlength="120" placeholder="e.g. Latex wound SFX timelapse" required />` +
          `<label>Video file</label>` +
          `<div class="upload-drop" id="upDrop" tabindex="0" role="button" aria-label="Choose or drop a video file">` +
            `<span class="upload-drop-hint">Drag &amp; drop a video here, or <span class="upload-drop-link">browse</span></span>` +
            `<span class="upload-file-name" id="upFileName" hidden></span>` +
          `</div>` +
          `<input type="file" id="upFile" accept="video/*" hidden />` +
          `<label for="upUrl">…or paste a video URL</label>` +
          `<input type="url" id="upUrl" maxlength="2048" placeholder="https://…/clip.mp4" />` +
          `<label for="upTags">Hashtags</label>` +
          `<input type="text" id="upTags" placeholder="#fx #zombie prosthetic (space or comma)" />` +
          `<div class="upload-duration" id="upDuration" hidden></div>` +
          `<div class="upload-progress" id="upProgress" hidden><div class="bar"></div></div>` +
          `<button type="submit" class="btn btn-yes" id="upSubmit" style="min-width:0;width:100%;">Post clip</button>` +
          `<div class="form-msg" id="upMsg"></div>` +
          `<p class="upload-note">Pick or drop a video file (uploaded via Vercel Blob — needs a linked Blob store), or paste a direct video URL. Either one works.</p>` +
        `</form>` +
      `</div>`;
    const form = document.getElementById("uploadForm");
    if (form) form.addEventListener("submit", handleUpload);
    wireDropzone();
  }

  function wireDropzone() {
    const drop = document.getElementById("upDrop");
    const fileInput = document.getElementById("upFile");
    if (!drop || !fileInput) return;

    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) setPickedFile(fileInput.files[0]);
    });
    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); })
    );
    drop.addEventListener("drop", (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) setPickedFile(dt.files[0]);
    });
  }

  function setPickedFile(file) {
    if (file && file.type && file.type.indexOf("video/") !== 0) {
      const msg = document.getElementById("upMsg");
      if (msg) { msg.className = "form-msg err"; msg.textContent = "Please choose a video file."; }
      return;
    }
    pickedFile = file || null;
    const nameEl = document.getElementById("upFileName");
    const hint = document.querySelector("#upDrop .upload-drop-hint");
    if (pickedFile) {
      if (nameEl) { nameEl.hidden = false; nameEl.textContent = pickedFile.name; }
      if (hint) hint.style.display = "none";
      // Reading duration is browser metadata only — NOT AI/ML.
      showDuration(null);
      probeDuration(pickedFile).then(showDuration);
    } else {
      if (nameEl) nameEl.hidden = true;
      if (hint) hint.style.display = "";
      showDuration(null);
    }
  }

  function showDuration(sec) {
    const el = document.getElementById("upDuration");
    if (!el) return;
    if (Number.isFinite(sec) && sec > 0) {
      el.hidden = false;
      el.textContent = "Duration: " + formatDuration(sec);
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  }

  function updateProgressUI(pct) {
    const wrap = document.getElementById("upProgress");
    if (!wrap) return;
    if (pct == null) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const bar = wrap.querySelector(".bar");
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }

  // Read a video's duration in the browser via a detached <video> + the
  // loadedmetadata event. Resolves a rounded second count, or null when it
  // can't be read (error, timeout, or a non-finite duration). NO AI/ML.
  function probeDuration(src) {
    return new Promise((resolve) => {
      let done = false;
      let objUrl = null;
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      function finish(val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (_) {} }
        v.removeAttribute("src");
        resolve(val);
      }
      const timer = setTimeout(() => finish(null), 8000);
      v.addEventListener("loadedmetadata", () => {
        const d = v.duration;
        finish(Number.isFinite(d) && d > 0 ? Math.round(d) : null);
      });
      v.addEventListener("error", () => finish(null));
      try {
        if (typeof src === "string") {
          v.crossOrigin = "anonymous";
          v.src = src;
        } else {
          objUrl = URL.createObjectURL(src);
          v.src = objUrl;
        }
      } catch (_) {
        finish(null);
      }
    });
  }

  async function handleUpload(e) {
    e.preventDefault();
    const msg = document.getElementById("upMsg");
    const submit = document.getElementById("upSubmit");
    msg.className = "form-msg";
    msg.textContent = "";
    if (!API.isLoggedIn()) {
      msg.className = "form-msg err";
      msg.textContent = "Please log in to post.";
      return;
    }
    const title = document.getElementById("upTitle").value.trim();
    const tagsRaw = document.getElementById("upTags").value;
    const urlVal = document.getElementById("upUrl").value.trim();

    // Normalize hashtags client-side (mirrors the server rules): lowercase,
    // strip leading '#', keep a-z0-9_, dedupe, cap at MAX_TAGS.
    const seen = new Set();
    const tags = [];
    tagsRaw.split(/[\s,]+/).forEach((raw) => {
      const t = raw.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]/g, "").slice(0, 24);
      if (t && !seen.has(t)) { seen.add(t); tags.push(t); }
    });
    if (tags.length > MAX_TAGS) tags.length = MAX_TAGS;

    if (!pickedFile && !urlVal) {
      msg.className = "form-msg err";
      msg.textContent = "Choose a video file or paste a video URL.";
      return;
    }

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = pickedFile ? "Uploading…" : "Posting…";
    try {
      let videoUrl;
      let durationSec = null;
      if (pickedFile) {
        durationSec = await probeDuration(pickedFile);
        updateProgressUI(0);
        videoUrl = await API.uploadVideoFile(pickedFile, (pct) => updateProgressUI(pct));
        updateProgressUI(null);
      } else {
        videoUrl = urlVal;
        durationSec = await probeDuration(urlVal); // best-effort; may be null (CORS)
      }

      submit.textContent = "Posting…";
      const data = await API.createPost({ title, tags, videoUrl, durationSec });
      const post = data.post;
      // Prepend to the in-memory feed and switch to For You.
      posts.unshift(post);
      activeTag = null;
      removeFilterBar();
      navigateTo("foryou");
      hideEmptyState();
      feed.innerHTML = "";
      renderPosts(posts, true);
      feed.scrollTo({ top: 0 });
      showToast("Posted", "Your clip is live at the top of the feed.");
      if (currentUser) {
        currentUser.posts = [post.id].concat(currentUser.posts || []);
      }
      // Refresh hashtag counts so captions/Discover reflect the new post.
      refreshTagCounts();
    } catch (err) {
      updateProgressUI(null);
      msg.className = "form-msg err";
      msg.textContent = err.message || "Could not post.";
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  }

  /* -------------------- Profile view -------------------- */
  function roleBadge(role) {
    const r = (role || "user").toLowerCase();
    const label = r.charAt(0).toUpperCase() + r.slice(1);
    return `<span class="role-badge role-${escapeHtml(r)}">${escapeHtml(label)}</span>`;
  }

  function moderationStatusHtml() {
    const mod = window.GoreTokMod;
    const ban = mod && mod.getStoredBan ? mod.getStoredBan() : null;
    if (ban) {
      return `<div class="profile-status banned">⛔ Banned — ${escapeHtml(ban.reason || "moderation")}</div>`;
    }
    if (mod && mod.isWarned && mod.isWarned()) {
      return `<div class="profile-status warned">⚠ Active warning from moderation</div>`;
    }
    return `<div class="profile-status clear">✓ No active warnings or bans</div>`;
  }

  function postListHtml(ids) {
    if (!ids || ids.length === 0) {
      return `<li class="empty">Nothing yet</li>`;
    }
    const byId = {};
    posts.forEach((p) => { byId[p.id] = p; });
    return ids.map((id) => {
      const p = byId[id];
      let label = escapeHtml(id);
      if (p) {
        const dur = Number(p.durationSec);
        label = escapeHtml(p.title) +
          (Number.isFinite(dur) && dur > 0 ? ` · ${escapeHtml(formatDuration(dur))}` : "");
      }
      return `<li title="${escapeHtml(id)}">${label}</li>`;
    }).join("");
  }

  function renderProfile(placeholder) {
    placeholder = placeholder || document.getElementById("viewPlaceholder");
    if (!placeholder) return;
    if (!currentUser) {
      placeholder.innerHTML =
        `<div class="vp-card"><div class="vp-icon">☗</div><h2>Profile</h2>` +
        `<p>Log in to see your profile.</p></div>`;
      return;
    }
    const u = currentUser;
    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—";
    placeholder.innerHTML =
      `<div class="vp-card wide">` +
        `<div class="profile-view">` +
          `<div class="profile-head">` +
            `<div class="profile-handle">@${escapeHtml(u.handle)}</div>` +
            roleBadge(u.role) +
            `<div class="profile-meta">${u.likes || 0} likes given · joined ${escapeHtml(created)}</div>` +
            moderationStatusHtml() +
          `</div>` +
          `<div class="profile-section-title">Your posts (${(u.posts || []).length})</div>` +
          `<ul class="profile-list">${postListHtml(u.posts)}</ul>` +
          `<div class="profile-section-title">Liked posts (${(u.likedPosts || []).length})</div>` +
          `<ul class="profile-list">${postListHtml(u.likedPosts)}</ul>` +
          `<button class="btn btn-no profile-logout" id="btnLogout">Log out</button>` +
        `</div>` +
      `</div>`;
    const out = document.getElementById("btnLogout");
    if (out) out.addEventListener("click", doLogout);
  }

  async function doLogout() {
    API.logout();
    currentUser = null;
    likedSet = new Set();
    posts = [];
    feed.innerHTML = "";
    navigateTo("foryou");
    updateAccountStatus();
    setAuthMode("login");
    showAuthGate();
  }

  /* -------------------- Right status panel -------------------- */
  function updateAccountStatus() {
    const list = document.querySelector(".status-list");
    if (!list) return;
    if (currentUser) {
      list.innerHTML =
        `<li class="ok">✓ 18+ confirmed</li>` +
        `<li class="ok">✓ Signed in as @${escapeHtml(currentUser.handle)}</li>`;
    } else {
      list.innerHTML =
        `<li class="ok">✓ 18+ confirmed</li>` +
        `<li class="pending">⧗ Not signed in</li>`;
    }
  }

  /* -------------------- Age gate -------------------- */
  function unlock() {
    app.classList.remove("locked");
    app.setAttribute("aria-hidden", "false");
    ageGate.classList.add("hidden");
  }

  function lock() {
    app.classList.add("locked");
    app.setAttribute("aria-hidden", "true");
    ageGate.classList.remove("hidden");
  }

  function enterSite() {
    try { sessionStorage.setItem(AGE_KEY, "1"); } catch (_) {}
    unlock();
    // Age gate passed -> decide auth vs app.
    proceedAfterAge();
  }

  function leaveSite() {
    ageGate.classList.add("hidden");
    app.style.display = "none";
    blocked.hidden = false;
  }

  function goBackToGate() {
    blocked.hidden = true;
    app.style.display = "";
    lock();
  }

  /* -------------------- Utils -------------------- */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function resetToGate() {
    blocked.hidden = true;
    app.style.display = "";
    hideAuthGate();
    lock();
  }

  /* -------------------- Init -------------------- */
  function init() {
    resetToGate();

    btnYes.addEventListener("click", enterSite);
    btnNo.addEventListener("click", leaveSite);
    if (btnBack) btnBack.addEventListener("click", goBackToGate);

    wireAuth();
    setAuthMode("login");
    wireNav();
    initModeration();
    updateAccountStatus();

    feed.addEventListener("scroll", () => {
      window.requestAnimationFrame(updatePager);
    }, { passive: true });

    document.addEventListener("keydown", onKey);

    window.addEventListener("pageshow", (e) => { if (e.persisted) resetToGate(); });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
