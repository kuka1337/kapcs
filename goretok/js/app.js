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
  const CATEGORIES = ["Fiction", "FX", "Gaming", "Horror"];

  /* -------------------- Session state -------------------- */
  // Current logged-in user (from /me). null while a guest / logged out.
  let currentUser = null;
  // Loaded posts + the set of post ids the current user has liked.
  let posts = [];
  let likedSet = new Set();
  let nextCursor = 0;
  let loadingMore = false;

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
    try {
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

    const badge = document.createElement("div");
    badge.className = "kind-badge";
    badge.textContent = p.category;

    const play = document.createElement("div");
    play.className = "play";

    media.addEventListener("click", () => togglePlay(video, slide));
    play.addEventListener("click", (e) => { e.stopPropagation(); togglePlay(video, slide); });
    video.addEventListener("play", () => slide.classList.add("playing"));
    video.addEventListener("pause", () => slide.classList.remove("playing"));

    const caption = document.createElement("div");
    caption.className = "caption";
    const tagsHtml = (p.tags || [])
      .map((t) => `<span class="tag">#${escapeHtml(t)}</span>`)
      .join(" ");
    caption.innerHTML =
      `<div class="user">@${escapeHtml(p.author)}</div>` +
      `<div class="text">${escapeHtml(p.title)} ${tagsHtml}</div>`;

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

    slide.append(media, badge, play, caption, rail);
    return slide;
  }

  function formatCount(n) {
    n = Number(n) || 0;
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
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
    else renderSimpleView(placeholder, view);
  }

  const SIMPLE_VIEWS = {
    discover:   { icon: "⌕", title: "Discover", text: "Browse trending FX, horror and gaming clips by tag. Search lands here in a later step." },
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

  /* -------------------- Upload view (URL-based) -------------------- */
  function renderUpload(placeholder) {
    const options = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
    placeholder.innerHTML =
      `<div class="vp-card wide">` +
        `<div class="vp-icon">▲</div>` +
        `<h2>Upload a clip</h2>` +
        `<form class="upload-form" id="uploadForm">` +
          `<label for="upTitle">Title</label>` +
          `<input type="text" id="upTitle" maxlength="120" placeholder="e.g. Latex wound SFX timelapse" required />` +
          `<label for="upCategory">Category</label>` +
          `<select id="upCategory">${options}</select>` +
          `<label for="upTags">Tags</label>` +
          `<input type="text" id="upTags" placeholder="fx horror makeup (space or comma)" />` +
          `<label for="upUrl">Video URL</label>` +
          `<input type="url" id="upUrl" maxlength="2048" placeholder="https://…/clip.mp4" required />` +
          `<button type="submit" class="btn btn-yes" id="upSubmit" style="min-width:0;width:100%;">Post clip</button>` +
          `<div class="form-msg" id="upMsg"></div>` +
          `<p class="upload-note">Direct file upload (Vercel Blob) is coming in a later step. For now, paste a direct video URL.</p>` +
        `</form>` +
      `</div>`;
    const form = document.getElementById("uploadForm");
    if (form) form.addEventListener("submit", handleUpload);
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
    const category = document.getElementById("upCategory").value;
    const tagsRaw = document.getElementById("upTags").value;
    const videoUrl = document.getElementById("upUrl").value.trim();
    const tags = tagsRaw.split(/[\s,]+/).map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "Posting…";
    try {
      const data = await API.createPost({ title, category, tags, videoUrl });
      const post = data.post;
      // Prepend to the in-memory feed and switch to For You.
      posts.unshift(post);
      navigateTo("foryou");
      hideEmptyState();
      // Rebuild the feed with the new post on top.
      feed.innerHTML = "";
      renderPosts(posts, true);
      feed.scrollTo({ top: 0 });
      showToast("Posted", "Your clip is live at the top of the feed.");
      if (currentUser) {
        currentUser.posts = [post.id].concat(currentUser.posts || []);
      }
    } catch (err) {
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
      const label = p ? `${escapeHtml(p.title)} · ${escapeHtml(p.category)}` : escapeHtml(id);
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
