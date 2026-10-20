/* ============================================================
   GoreTok — private Messages (DM)
   ------------------------------------------------------------
   A completely SEPARATE real-time bridge from moderation.js.
   - Owns its OWN mqtt client on the SAME public broker.
   - Topics live ONLY on the goretok_v1_* namespace (never the
     moderation topic namespace used by moderation.js).
   - Message history is persisted server-side (POST /api/goretok/social
     dm.send / dm.list); mqtt is used purely for instant delivery to
     a recipient who is online.

   Topic shape:  goretok_v1_dm_<handle>  (one inbox topic per handle)
   Payload:      { from, to, text, ts }

   Only logged-in users get a bridge. Text is validated 1..2000 chars
   client-side (the server validates again).
   ============================================================ */

window.GoreTokDM = (function () {
  "use strict";

  const API = window.GoreTokAPI;
  const BROKER = "wss://broker.emqx.io:8084/mqtt";
  const TOPIC_PREFIX = "goretok_v1_dm_"; // separate from the moderation namespace
  const MAX_TEXT = 2000;

  function topicFor(handle) {
    return TOPIC_PREFIX + String(handle || "").trim().replace(/^@/, "").toLowerCase();
  }

  /* -------------------- State -------------------- */
  let client = null;
  let connected = false;
  let myHandle = null;         // current logged-in handle (lowercased)
  let openWith = null;         // handle of the currently-open thread (or null)
  let panel = null;            // the placeholder element we render into
  let threadMessages = [];     // messages for the open thread (newest-first)
  const listeners = [];        // incoming-message callbacks

  /* -------------------- MQTT (own client, separate from moderation) ----- */
  function connect() {
    if (client || typeof mqtt === "undefined" || !myHandle) return;
    client = mqtt.connect(BROKER);

    client.on("connect", () => {
      connected = true;
      client.subscribe(topicFor(myHandle));
    });
    client.on("offline", () => { connected = false; });
    client.on("disconnect", () => { connected = false; });

    client.on("message", (topic, message) => {
      let data;
      try { data = JSON.parse(message.toString()); } catch (_) { return; }
      handleIncoming(data);
    });
  }

  function handleIncoming(msg) {
    if (!msg || typeof msg.text !== "string" || !msg.from) return;
    const from = String(msg.from).toLowerCase();
    // Only care about messages addressed to me.
    if (msg.to && String(msg.to).toLowerCase() !== myHandle) return;

    // Live-append when the sender's thread is the one on screen.
    if (openWith && from === openWith) {
      threadMessages.unshift({ from: msg.from, to: msg.to, text: msg.text, ts: msg.ts || Date.now() });
      appendBubble({ from: msg.from, text: msg.text, ts: msg.ts || Date.now() });
    }
    listeners.forEach((fn) => { try { fn(msg); } catch (_) {} });
  }

  function publish(to, payload) {
    if (!client || !connected) return false;
    try { client.publish(topicFor(to), JSON.stringify(payload)); return true; }
    catch (_) { return false; }
  }

  /* -------------------- Lifecycle wiring (called from app.js) ----------- */
  // Called on login / restored session with the real handle.
  function setHandle(handle) {
    const clean = String(handle || "").trim().replace(/^@/, "").toLowerCase();
    if (!clean) return;
    if (myHandle === clean && client) return;
    myHandle = clean;
    if (!client) connect();
    else if (connected) client.subscribe(topicFor(myHandle));
  }

  function init(handle) { setHandle(handle); return pub; }

  /* -------------------- Small view helpers -------------------- */
  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function initial(handle) {
    const h = String(handle || "?").replace(/^@/, "");
    return (h.charAt(0) || "?").toUpperCase();
  }

  function avatarHtml(handle, url) {
    if (url) {
      return `<span class="avatar"><img src="${esc(url)}" alt="" /></span>`;
    }
    return `<span class="avatar initial-circle">${esc(initial(handle))}</span>`;
  }

  function relTime(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return "";
    const d = Math.max(0, Date.now() - t);
    const m = Math.floor(d / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    const days = Math.floor(h / 24);
    return days + "d ago";
  }

  /* -------------------- Messages view -------------------- */
  // Render the Messages screen (conversation list). placeholder is the
  // shared #viewPlaceholder element app.js hands us.
  function renderMessages(placeholder) {
    panel = placeholder || document.getElementById("viewPlaceholder");
    if (!panel) return;
    openWith = null;
    threadMessages = [];

    if (!API || !API.isLoggedIn()) {
      panel.innerHTML =
        `<div class="vp-card"><div class="vp-icon">✉</div><h2>Messages</h2>` +
        `<p>Log in to send and read private messages.</p></div>`;
      return;
    }

    panel.innerHTML =
      `<div class="vp-card wide">` +
        `<div class="dm-wrap">` +
          `<div class="dm-header"><div class="vp-icon dm-icon">✉</div><h2>Messages</h2></div>` +
          `<div class="dm-body" id="dmBody"><p class="vp-loading">Loading conversations…</p></div>` +
        `</div>` +
      `</div>`;

    loadThreads();
  }

  function loadThreads() {
    const body = document.getElementById("dmBody");
    if (!body) return;
    API.listThreads().then((res) => {
      const threads = (res && res.threads) || [];
      if (threads.length === 0) {
        body.innerHTML =
          `<div class="dm-empty">No conversations yet. Open a profile and tap “Message” to start one.</div>`;
        return;
      }
      const rows = threads.map((h) =>
        `<button class="dm-thread" data-handle="${esc(h)}">` +
          avatarHtml(h, null) +
          `<span class="dm-thread-handle">@${esc(h)}</span>` +
        `</button>`
      ).join("");
      body.innerHTML = `<div class="dm-threads">${rows}</div>`;
      body.querySelectorAll(".dm-thread[data-handle]").forEach((el) => {
        el.addEventListener("click", () => openThread(el.dataset.handle));
      });
    }).catch(() => {
      body.innerHTML = `<div class="dm-empty">Could not load conversations. Try again shortly.</div>`;
    });
  }

  // Open (or create) a thread with `handle`. Safe to call from a profile's
  // "Message" button — it switches to the Messages view first.
  function openThread(handle) {
    const clean = String(handle || "").trim().replace(/^@/, "").toLowerCase();
    if (!clean) return;
    if (!API || !API.isLoggedIn()) return;
    if (clean === myHandle) return; // no self-DM

    // Make sure the Messages screen is mounted.
    if (!panel) panel = document.getElementById("viewPlaceholder");
    if (!panel) return;

    openWith = clean;
    threadMessages = [];
    panel.innerHTML =
      `<div class="vp-card wide">` +
        `<div class="dm-wrap">` +
          `<div class="dm-thread-head">` +
            `<button class="dm-back" id="dmBack" title="Back">‹</button>` +
            avatarHtml(clean, null) +
            `<span class="dm-thread-handle">@${esc(clean)}</span>` +
          `</div>` +
          `<div class="dm-messages" id="dmMessages"><p class="vp-loading">Loading…</p></div>` +
          `<form class="dm-compose" id="dmCompose">` +
            `<input type="text" id="dmInput" maxlength="${MAX_TEXT}" placeholder="Message @${esc(clean)}…" autocomplete="off" />` +
            `<button type="submit" class="btn btn-yes dm-send" id="dmSend">Send</button>` +
          `</form>` +
        `</div>` +
      `</div>`;

    const back = document.getElementById("dmBack");
    if (back) back.addEventListener("click", renderMessages.bind(null, panel));
    const form = document.getElementById("dmCompose");
    if (form) form.addEventListener("submit", onSend);

    loadHistory(clean);
  }

  function loadHistory(handle) {
    const box = document.getElementById("dmMessages");
    if (!box) return;
    API.listDm(handle).then((res) => {
      threadMessages = (res && res.messages) || [];
      renderThreadMessages();
    }).catch(() => {
      box.innerHTML = `<div class="dm-empty">Could not load this conversation.</div>`;
    });
  }

  function renderThreadMessages() {
    const box = document.getElementById("dmMessages");
    if (!box) return;
    if (!threadMessages.length) {
      box.innerHTML = `<div class="dm-empty">No messages yet. Say hello.</div>`;
      return;
    }
    // Stored newest-first; render oldest-first (chat order).
    const ordered = threadMessages.slice().reverse();
    box.innerHTML = ordered.map(bubbleHtml).join("");
    box.scrollTop = box.scrollHeight;
  }

  function bubbleHtml(m) {
    const mine = String(m.from || "").toLowerCase() === myHandle;
    return `<div class="dm-bubble ${mine ? "mine" : "theirs"}">` +
      `<span class="dm-text">${esc(m.text)}</span>` +
      `<span class="dm-time">${esc(relTime(m.ts))}</span>` +
    `</div>`;
  }

  function appendBubble(m) {
    const box = document.getElementById("dmMessages");
    if (!box) return;
    const empty = box.querySelector(".dm-empty");
    if (empty) box.innerHTML = "";
    box.insertAdjacentHTML("beforeend", bubbleHtml(m));
    box.scrollTop = box.scrollHeight;
  }

  async function onSend(e) {
    e.preventDefault();
    const input = document.getElementById("dmInput");
    const btn = document.getElementById("dmSend");
    if (!input || !openWith) return;
    const text = input.value.trim();
    if (text.length < 1 || text.length > MAX_TEXT) return;
    if (btn) btn.disabled = true;
    try {
      const res = await API.sendDm(openWith, text);
      const msg = (res && res.message) || { from: myHandle, to: openWith, text, ts: Date.now() };
      threadMessages.unshift(msg);
      appendBubble(msg);
      input.value = "";
      // Instant delivery to the recipient if they're online.
      publish(openWith, { from: myHandle, to: openWith, text: msg.text, ts: msg.ts });
    } catch (_) {
      // leave the text in the box so the user can retry
    } finally {
      if (btn) btn.disabled = false;
      input.focus();
    }
  }

  /* -------------------- Public API -------------------- */
  const pub = {
    init: init,
    setHandle: setHandle,
    renderMessages: renderMessages,
    openThread: openThread,
    on: function (fn) { if (typeof fn === "function") listeners.push(fn); return pub; },
  };
  return pub;
})();
