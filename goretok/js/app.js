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
  const VOLUME_KEY = "goretok_volume";

  /* -------------------- Volume preference (per-slide sound) -------------------- */
  // Persisted {volume:0..1, muted:boolean}. Default muted because browsers
  // block autoplay with sound; the user unmutes with a gesture.
  function getVolumePref() {
    let vol = 1, muted = true;
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && typeof o === "object") {
          if (Number.isFinite(Number(o.volume))) vol = Math.max(0, Math.min(1, Number(o.volume)));
          if (typeof o.muted === "boolean") muted = o.muted;
        }
      }
    } catch (_) { /* fall back to defaults */ }
    return { volume: vol, muted: muted };
  }

  function setVolumePref(pref) {
    const vol = Math.max(0, Math.min(1, Number(pref.volume)));
    const out = { volume: Number.isFinite(vol) ? vol : 1, muted: !!pref.muted };
    try { localStorage.setItem(VOLUME_KEY, JSON.stringify(out)); } catch (_) {}
    return out;
  }

  // Mute every feed video except `keep` (pass null to mute all). Also syncs
  // each slide's "unmuted" CSS flag used by the tap-for-sound hint.
  function muteOtherVideos(keep) {
    feed.querySelectorAll("video.slide-video").forEach((v) => {
      if (v === keep) return;
      v.muted = true;
      const s = v.closest(".slide");
      if (s) s.classList.remove("sound-on");
    });
  }

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
    // Private DM bridge (SEPARATE goretok_v1_* namespace) follows login too.
    if (window.GoreTokDM && typeof window.GoreTokDM.setHandle === "function") {
      window.GoreTokDM.setHandle(currentUser.handle);
    }
    // Seed the current user's own profile into the cache so captions can
    // render their avatar/role without an extra round-trip.
    profileCache[String(currentUser.handle).toLowerCase()] = {
      handle: currentUser.handle,
      role: currentUser.role,
      avatarUrl: currentUser.avatarUrl || null,
      followers: currentUser.followers || 0,
      following: currentUser.following || 0,
      isFollowing: false,
    };
    updateAccountStatus();
    await loadFeed();
    maybeJumpToHashPost();
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

    /* ---- Volume control overlay (per-slide mute + volume slider) ---- */
    const pref = getVolumePref();
    // Keep the video muted for first paint; the stored volume level still
    // applies so unmuting later plays at the preferred loudness.
    video.volume = pref.volume;
    video.muted = true;

    const vol = document.createElement("div");
    vol.className = "vol-control";
    const volBtn = document.createElement("button");
    volBtn.type = "button";
    volBtn.className = "vol-toggle";
    volBtn.title = "Mute / unmute";
    const volRange = document.createElement("input");
    volRange.type = "range";
    volRange.className = "vol-range";
    volRange.min = "0";
    volRange.max = "1";
    volRange.step = "0.05";
    volRange.value = String(pref.volume);
    vol.append(volBtn, volRange);

    function reflectVolUi() {
      const on = !video.muted;
      slide.classList.toggle("sound-on", on);
      volBtn.textContent = (video.muted || video.volume === 0) ? "🔇" : "🔊";
      volRange.value = String(video.volume);
    }
    reflectVolUi();

    volBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const unmute = video.muted;
      if (unmute) {
        // Unmuting this slide mutes all others.
        muteOtherVideos(video);
        video.muted = false;
        if (video.volume === 0) { video.volume = 0.5; volRange.value = "0.5"; }
        video.play().catch(() => {});
      } else {
        video.muted = true;
      }
      setVolumePref({ volume: video.volume, muted: video.muted });
      reflectVolUi();
    });

    // Scrubbing the slider must never toggle play/pause or bubble to media.
    ["click", "pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup"]
      .forEach((ev) => volRange.addEventListener(ev, (e) => e.stopPropagation()));
    volRange.addEventListener("input", (e) => {
      e.stopPropagation();
      const v = Math.max(0, Math.min(1, Number(volRange.value)));
      video.volume = v;
      if (v > 0) {
        // Raising the volume implies the user wants sound here only.
        muteOtherVideos(video);
        video.muted = false;
        video.play().catch(() => {});
      } else {
        video.muted = true;
      }
      setVolumePref({ volume: v, muted: video.muted });
      reflectVolUi();
    });

    // Tap-for-sound hint — a dedicated element so it never collides with the
    // tap-to-play/pause handler on the media body.
    const soundHint = document.createElement("button");
    soundHint.type = "button";
    soundHint.className = "sound-hint";
    soundHint.textContent = "🔊 Tap for sound";
    soundHint.addEventListener("click", (e) => {
      e.stopPropagation();
      muteOtherVideos(video);
      video.muted = false;
      if (video.volume === 0) { video.volume = 0.5; volRange.value = "0.5"; }
      video.play().catch(() => {});
      setVolumePref({ volume: video.volume, muted: false });
      reflectVolUi();
    });

    video.addEventListener("volumechange", reflectVolUi);

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
    const avatarUrl = p.authorAvatar || p.avatar || p.avatarUrl || null;
    const metaBits = [];
    const rel = relativeTime(p.createdAt);
    if (rel) metaBits.push(`<span class="caption-time">${escapeHtml(rel)}</span>`);
    const viewsHtml = `<span class="caption-views" data-views>${escapeHtml(formatCount(p.viewCount || 0))} views</span>`;
    const isOwn = currentUser && currentUser.handle === p.author;
    const followHtml = (currentUser && !isOwn)
      ? `<button class="follow-btn" data-follow-author="${escapeHtml(p.author)}">Follow</button>`
      : "";
    const messageHtml = (currentUser && !isOwn)
      ? `<button class="message-btn" data-message-author="${escapeHtml(p.author)}">Message</button>`
      : "";
    caption.innerHTML =
      `<div class="caption-author">` +
        avatarHtml(p.author, avatarUrl, "caption-avatar") +
        `<div class="user">@${escapeHtml(p.author)}</div>` +
        roleBadge(p.authorRole || p.role || "user") +
        followHtml +
        messageHtml +
      `</div>` +
      `<div class="text">${escapeHtml(p.title)} ${tagsHtml}</div>` +
      `<div class="caption-meta">${metaBits.join(" · ")}${metaBits.length ? " · " : ""}${viewsHtml}</div>`;
    caption.querySelectorAll(".tag[data-tag]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        filterFeedByTag(el.dataset.tag);
      });
    });

    // Lazily hydrate the author avatar + role (+ follow state) from the
    // profile cache; falls back to the initial-circle already rendered.
    hydrateCaptionAuthor(caption, p);

    const fBtn = caption.querySelector(".follow-btn[data-follow-author]");
    if (fBtn) fBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFollow(p.author, fBtn);
    });

    const mBtn = caption.querySelector(".message-btn[data-message-author]");
    if (mBtn) mBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDmWith(p.author);
    });

    const liked = likedSet.has(p.id);
    const canDelete = currentUser &&
      (currentUser.handle === p.author ||
       ["moderator", "admin", "founder"].indexOf((currentUser.role || "").toLowerCase()) !== -1);
    const rail = document.createElement("div");
    rail.className = "rail";
    rail.innerHTML =
      `<button class="like${liked ? " liked" : ""}" title="Like">♥</button>` +
      `<span class="count like-count">${formatCount(p.likeCount || 0)}</span>` +
      `<button class="comment" title="Comments">💬</button>` +
      `<span class="count comment-count">${formatCount(p.commentCount || 0)}</span>` +
      `<button class="share" title="Share">↗</button>` +
      `<button class="report" title="Report this clip">⚑</button>` +
      (canDelete ? `<button class="delete" title="Delete this clip">🗑</button>` : "");

    rail.querySelector(".like").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLike(p, e.currentTarget);
    });
    rail.querySelector(".comment").addEventListener("click", (e) => {
      e.stopPropagation();
      openComments(p, slide);
    });
    rail.querySelector(".share").addEventListener("click", (e) => {
      e.stopPropagation();
      sharePost(p);
    });
    rail.querySelector(".report").addEventListener("click", (e) => {
      e.stopPropagation();
      reportSlide(p, e.currentTarget);
    });
    const delBtn = rail.querySelector(".delete");
    if (delBtn) delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deletePost(p);
    });

    slide.append(media, play, caption, rail, vol, soundHint);
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

  /* -------------------- Author avatar / role hydration -------------------- */
  function hydrateCaptionAuthor(caption, p) {
    if (p.authorAvatar || p.avatar || p.avatarUrl) return; // already have one
    fetchProfile(p.author).then((prof) => {
      if (!prof) return;
      const avWrap = caption.querySelector(".caption-avatar");
      if (avWrap && prof.avatarUrl) {
        avWrap.classList.remove("initial-circle");
        avWrap.innerHTML = `<img src="${escapeHtml(prof.avatarUrl)}" alt="" />`;
      }
      const badgeOld = caption.querySelector(".role-badge");
      if (badgeOld && prof.role) {
        badgeOld.outerHTML = roleBadge(prof.role);
      }
      const fBtn = caption.querySelector(".follow-btn[data-follow-author]");
      if (fBtn && prof.isFollowing) setFollowBtnState(fBtn, true);
    });
  }

  /* -------------------- Follow / Following -------------------- */
  function setFollowBtnState(btn, following) {
    btn.classList.toggle("following", following);
    btn.textContent = following ? "Following" : "Follow";
    btn.dataset.following = following ? "1" : "0";
  }

  async function toggleFollow(target, btn) {
    if (!API.isLoggedIn()) {
      showToast("Log in required", "Please log in to follow people.");
      return;
    }
    const want = btn.dataset.following !== "1";
    btn.disabled = true;
    try {
      const res = await API.follow(target, want);
      setFollowBtnState(btn, !!res.following);
      const key = String(target).toLowerCase();
      if (profileCache[key]) {
        profileCache[key].isFollowing = !!res.following;
        if (typeof res.followers === "number") profileCache[key].followers = res.followers;
      }
    } catch (err) {
      showToast("Could not update follow", err.message || "Try again shortly.");
    } finally {
      btn.disabled = false;
    }
  }

  /* -------------------- Share (deep link) -------------------- */
  function postLink(postId) {
    return "https://kapcs.vercel.app/goretok#post=" + encodeURIComponent(postId);
  }

  async function sharePost(p) {
    const link = postLink(p.id);
    if (navigator.share) {
      try {
        await navigator.share({ title: "GoreTok", text: p.title || "Check out this clip", url: link });
        return;
      } catch (_) { /* user cancelled or unsupported — fall through to copy */ }
    }
    try {
      await navigator.clipboard.writeText(link);
      showToast("Link copied", link);
    } catch (_) {
      showToast("Copy this link", link);
    }
  }

  /* -------------------- Delete a clip -------------------- */
  async function deletePost(p) {
    if (!window.confirm("Delete this clip?")) return;
    try {
      await API.deletevideo(p.id);
      showToast("Deleted", "The clip was removed.");
      // Drop from local caches then reload the feed.
      posts = posts.filter((x) => x.id !== p.id);
      if (currentUser && Array.isArray(currentUser.posts)) {
        currentUser.posts = currentUser.posts.filter((id) => id !== p.id);
      }
      await loadFeed();
    } catch (err) {
      showToast("Could not delete", err.message || "Try again shortly.");
    }
  }

  /* -------------------- Comments sheet -------------------- */
  function commentSheetEl() {
    let el = document.getElementById("commentSheet");
    if (!el) {
      el = document.createElement("div");
      el.id = "commentSheet";
      el.className = "comment-sheet";
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  }

  function closeComments() {
    const el = document.getElementById("commentSheet");
    if (el) { el.hidden = true; el.classList.remove("show"); el.innerHTML = ""; }
  }

  function commentRowHtml(c) {
    return `<div class="comment-row">` +
      avatarHtml(c.author, c.avatarUrl, "comment-avatar") +
      `<div class="comment-body">` +
        `<div class="comment-head">` +
          `<span class="comment-author">@${escapeHtml(c.author)}</span>` +
          `<span class="comment-time">${escapeHtml(relativeTime(c.createdAt))}</span>` +
        `</div>` +
        `<div class="comment-text">${escapeHtml(c.text)}</div>` +
      `</div>` +
    `</div>`;
  }

  function openComments(p, slide) {
    const el = commentSheetEl();
    el.hidden = false;
    el.classList.add("show");
    el.innerHTML =
      `<div class="comment-panel">` +
        `<div class="comment-sheet-head">` +
          `<h3>Comments</h3>` +
          `<button class="comment-close" id="commentClose" title="Close">✕</button>` +
        `</div>` +
        `<div class="comment-list" id="commentList"><p class="vp-loading">Loading comments…</p></div>` +
        (API.isLoggedIn()
          ? `<form class="comment-compose" id="commentForm">` +
              `<input type="text" id="commentInput" maxlength="500" placeholder="Add a comment…" autocomplete="off" />` +
              `<button type="submit" class="btn btn-yes comment-send" id="commentSend">Post</button>` +
            `</form>`
          : `<div class="comment-login">Log in to add a comment.</div>`) +
      `</div>`;

    const close = document.getElementById("commentClose");
    if (close) close.addEventListener("click", closeComments);
    el.addEventListener("click", (e) => { if (e.target === el) closeComments(); });

    const list = document.getElementById("commentList");
    API.listComments(p.id).then((res) => {
      const comments = (res && res.comments) || [];
      if (comments.length === 0) {
        list.innerHTML = `<div class="comment-empty">No comments yet. Be the first.</div>`;
      } else {
        list.innerHTML = comments.map(commentRowHtml).join("");
      }
    }).catch(() => {
      list.innerHTML = `<div class="comment-empty">Could not load comments.</div>`;
    });

    const form = document.getElementById("commentForm");
    if (form) form.addEventListener("submit", (e) => onAddComment(e, p, slide));
  }

  async function onAddComment(e, p, slide) {
    e.preventDefault();
    const input = document.getElementById("commentInput");
    const btn = document.getElementById("commentSend");
    if (!input) return;
    const text = input.value.trim();
    if (text.length < 1 || text.length > 500) return;
    if (btn) btn.disabled = true;
    try {
      const res = await API.addComment(p.id, text);
      const c = res && res.comment;
      if (c) {
        const list = document.getElementById("commentList");
        if (list) {
          const empty = list.querySelector(".comment-empty");
          if (empty) list.innerHTML = "";
          list.insertAdjacentHTML("afterbegin", commentRowHtml(c));
        }
        input.value = "";
        // Bump the rail comment count on the slide.
        p.commentCount = (Number(p.commentCount) || 0) + 1;
        if (slide) {
          const cc = slide.querySelector(".comment-count");
          if (cc) cc.textContent = formatCount(p.commentCount);
        }
      }
    } catch (err) {
      showToast("Could not comment", err.message || "Try again shortly.");
    } finally {
      if (btn) btn.disabled = false;
      input.focus();
    }
  }

  /* -------------------- Open a DM thread with a user -------------------- */
  function openDmWith(handle) {
    if (!API.isLoggedIn()) {
      showToast("Log in required", "Please log in to send messages.");
      return;
    }
    navigateTo("messages");
    // Let showView mount the Messages panel, then open the thread.
    setTimeout(() => {
      if (window.GoreTokDM && typeof window.GoreTokDM.openThread === "function") {
        window.GoreTokDM.openThread(handle);
      }
    }, 30);
  }

  /* -------------------- View counting (once per post per session) ------ */
  const viewedSet = new Set();
  function countView(postId, slide) {
    if (!postId || viewedSet.has(postId)) return;
    viewedSet.add(postId);
    API.incrementView(postId).then((res) => {
      const views = res && res.views;
      if (typeof views === "number") {
        const post = posts.find((x) => x.id === postId);
        if (post) post.viewCount = views;
        if (slide) {
          const v = slide.querySelector(".caption-views");
          if (v) v.textContent = formatCount(views) + " views";
        }
      }
    }).catch(() => { /* non-critical */ });
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
              // Apply the persisted volume to the newly active slide and keep
              // every other slide muted. If the user has unmuted (preference),
              // the active video plays with sound; otherwise it stays muted.
              const pref = getVolumePref();
              video.volume = pref.volume;
              if (pref.muted) {
                video.muted = true;
              } else {
                muteOtherVideos(video);
                video.muted = false;
              }
              video.play().catch(() => {});
              countView(entry.target.dataset.postId, entry.target);
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

  // Parse #post=<id> from the URL and, once the feed is loaded, jump to that
  // slide. If it isn't in the first page, keep loading more pages until found
  // (or we run out). Clears the hash after jumping.
  function parseHashPostId() {
    const m = /(?:^|[#&])post=([^&]+)/.exec(location.hash || "");
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function maybeJumpToHashPost() {
    const id = parseHashPostId();
    if (!id) return;
    let guard = 0;
    while (guard++ < 20) {
      const idx = posts.findIndex((p) => p.id === id);
      if (idx !== -1) {
        navigateTo("foryou");
        // Wait a tick so slides are laid out before scrolling.
        setTimeout(() => goTo(idx), 60);
        break;
      }
      if (nextCursor == null) break; // exhausted the feed
      try {
        const data = await API.listPosts(20, nextCursor);
        nextCursor = data.nextCursor;
        const more = data.posts || [];
        if (!more.length) break;
        posts = posts.concat(more);
        renderPosts(more, false);
      } catch (_) { break; }
    }
    // Clear the hash so a refresh doesn't keep re-jumping.
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
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
    else if (view === "messages") {
      if (window.GoreTokDM && typeof window.GoreTokDM.renderMessages === "function") {
        window.GoreTokDM.renderMessages(placeholder);
      } else {
        renderSimpleView(placeholder, view);
      }
    }
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

  function postListHtml(ids, ownable) {
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
      const del = ownable
        ? `<button class="profile-del" data-del-id="${escapeHtml(id)}" title="Delete this clip">🗑</button>`
        : "";
      return `<li title="${escapeHtml(id)}"><span class="pl-label">${label}</span>${del}</li>`;
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
            `<div class="profile-avatar-wrap">` +
              avatarHtml(u.handle, u.avatarUrl, "profile-avatar") +
            `</div>` +
            `<div class="profile-handle">@${escapeHtml(u.handle)}</div>` +
            roleBadge(u.role) +
            `<div class="profile-counts">` +
              `<span class="pc"><b id="pcFollowers">${formatCount(u.followers || 0)}</b> followers</span>` +
              `<span class="pc"><b id="pcFollowing">${formatCount(u.following || 0)}</b> following</span>` +
            `</div>` +
            `<div class="profile-meta">${u.likes || 0} likes given · joined ${escapeHtml(created)}</div>` +
            `<div class="profile-avatar-edit">` +
              `<button class="btn btn-no" id="btnAvatarFile" style="min-width:0">Upload avatar</button>` +
              `<input type="file" id="avatarFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden />` +
              `<form class="avatar-url-form" id="avatarUrlForm">` +
                `<input type="url" id="avatarUrlInput" maxlength="2048" placeholder="…or paste an image URL" />` +
                `<button type="submit" class="btn btn-no" style="min-width:0">Set</button>` +
              `</form>` +
              `<div class="form-msg" id="avatarMsg"></div>` +
            `</div>` +
            moderationStatusHtml() +
          `</div>` +
          `<div class="profile-section-title">Your posts (${(u.posts || []).length})</div>` +
          `<ul class="profile-list" id="ownPostList">${postListHtml(u.posts, true)}</ul>` +
          `<div class="profile-section-title">Liked posts (${(u.likedPosts || []).length})</div>` +
          `<ul class="profile-list">${postListHtml(u.likedPosts, false)}</ul>` +
          `<button class="btn btn-no profile-logout" id="btnLogout">Log out</button>` +
        `</div>` +
      `</div>`;
    const out = document.getElementById("btnLogout");
    if (out) out.addEventListener("click", doLogout);

    // Avatar: file upload.
    const avBtn = document.getElementById("btnAvatarFile");
    const avFile = document.getElementById("avatarFile");
    if (avBtn && avFile) {
      avBtn.addEventListener("click", () => avFile.click());
      avFile.addEventListener("change", () => {
        if (avFile.files && avFile.files[0]) uploadAvatarFile(avFile.files[0]);
      });
    }
    // Avatar: paste URL.
    const avForm = document.getElementById("avatarUrlForm");
    if (avForm) avForm.addEventListener("submit", onSetAvatarUrl);

    // Delete buttons on own posts.
    placeholder.querySelectorAll(".profile-del[data-del-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.delId;
        const p = posts.find((x) => x.id === id) || { id };
        deletePost(p);
      });
    });
  }

  function setAvatarMsg(cls, text) {
    const el = document.getElementById("avatarMsg");
    if (el) { el.className = "form-msg" + (cls ? " " + cls : ""); el.textContent = text || ""; }
  }

  async function applyAvatar(url) {
    const res = await API.setProfile({ avatarUrl: url });
    const finalUrl = (res && res.avatarUrl) || url;
    if (currentUser) currentUser.avatarUrl = finalUrl;
    const key = String(currentUser.handle).toLowerCase();
    if (profileCache[key]) profileCache[key].avatarUrl = finalUrl;
    // Refresh the profile header avatar.
    const wrap = document.querySelector(".profile-avatar");
    if (wrap) {
      wrap.classList.remove("initial-circle");
      wrap.innerHTML = `<img src="${escapeHtml(finalUrl)}" alt="" />`;
    }
    setAvatarMsg("ok", "Avatar updated.");
  }

  async function uploadAvatarFile(file) {
    if (file && file.type && file.type.indexOf("image/") !== 0) {
      setAvatarMsg("err", "Please choose an image file.");
      return;
    }
    setAvatarMsg("", "Uploading…");
    try {
      const url = await API.uploadImageFile(file);
      await applyAvatar(url);
    } catch (err) {
      setAvatarMsg("err", err.message || "Could not upload avatar.");
    }
  }

  async function onSetAvatarUrl(e) {
    e.preventDefault();
    const input = document.getElementById("avatarUrlInput");
    if (!input) return;
    const url = input.value.trim();
    if (!url) { setAvatarMsg("err", "Paste an image URL first."); return; }
    setAvatarMsg("", "Saving…");
    try {
      await applyAvatar(url);
      input.value = "";
    } catch (err) {
      setAvatarMsg("err", err.message || "Could not set avatar.");
    }
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

  // "3h ago" style relative timestamp from an epoch-ms value.
  function relativeTime(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return "";
    const diff = Math.max(0, Date.now() - t);
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    const d = Math.floor(h / 24);
    if (d < 7) return d + "d ago";
    const w = Math.floor(d / 7);
    if (w < 5) return w + "w ago";
    return new Date(t).toLocaleDateString();
  }

  // First letter of a handle, for the initial-circle avatar fallback.
  function avatarInitial(handle) {
    const h = String(handle || "?").replace(/^@/, "");
    return (h.charAt(0) || "?").toUpperCase();
  }

  // Avatar markup: an <img> when a url is known, else an initial circle.
  function avatarHtml(handle, url, extraClass) {
    const cls = "avatar" + (extraClass ? " " + extraClass : "");
    if (url) {
      return `<span class="${cls}"><img src="${escapeHtml(url)}" alt="" /></span>`;
    }
    return `<span class="${cls} initial-circle">${escapeHtml(avatarInitial(handle))}</span>`;
  }

  /* -------------------- Author profile cache (avatars / follow) -------- */
  // handle(lowercased) -> { avatarUrl, role, followers, following, isFollowing }
  const profileCache = {};
  const profileInflight = {};

  function fetchProfile(handle) {
    const key = String(handle || "").toLowerCase();
    if (!key) return Promise.resolve(null);
    if (profileCache[key]) return Promise.resolve(profileCache[key]);
    if (profileInflight[key]) return profileInflight[key];
    profileInflight[key] = API.getProfile(handle).then((p) => {
      profileCache[key] = p || {};
      delete profileInflight[key];
      return profileCache[key];
    }).catch(() => {
      delete profileInflight[key];
      return null;
    });
    return profileInflight[key];
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
