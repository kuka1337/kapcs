/* ============================================================
   GoreTok — shared moderation bridge
   ------------------------------------------------------------
   Connects GoreTok to the SAME moderation backbone as KAPCS so
   a single admin console (admin.html) moderates both apps.

   - Same MQTT broker + topics as index.html / admin.html
   - Reports a GoreTok guest as an online user (presence pulse)
   - Lets a viewer report a clip -> shows up in the admin Reports tab
   - Listens for ban / warn / broadcast / admin-DM from the console

   NO AI content recognition here (that stays in KAPCS only).
   This is a front-end prototype bridge; a production build would
   authenticate publishers and validate messages server-side.
   ============================================================ */

window.GoreTokMod = (function () {
  "use strict";

  /* -------------------- Shared MQTT config -------------------- */
  // Identical broker + topic names as KAPCS (index.html / admin.html)
  // so both apps share one moderation console.
  const BROKER = "wss://broker.emqx.io:8084/mqtt";
  const T = {
    USERS:     "kapcs_v13_users",
    REPORTS:   "kapcs_v13_reports",
    BANS:      "kapcs_v13_bans",
    WARNS:     "kapcs_v13_warns",
    BROADCAST: "kapcs_v13_broadcast",
    ADMIN_DM:  "kapcs_v13_admin_dm",
    ROLES:     "kapcs_v13_roles",
  };

  /* -------------------- Local identity -------------------- */
  // A GoreTok guest gets a stable device id + handle so bans/warns
  // from the admin console can target them across reloads.
  const DEV_KEY  = "goretok_device_id";
  const NAME_KEY = "goretok_handle";
  const BAN_KEY  = "goretok_ban_info";
  const WARN_KEY = "goretok_warned";

  function getDeviceId() {
    let id = localStorage.getItem(DEV_KEY);
    if (!id) {
      id = "GT-" + Math.random().toString(36).slice(2, 8).toUpperCase() +
                   Math.random().toString(36).slice(2, 6).toUpperCase();
      localStorage.setItem(DEV_KEY, id);
    }
    return id;
  }

  function getHandle() {
    let h = localStorage.getItem(NAME_KEY);
    if (!h) {
      h = "gt_guest_" + Math.random().toString(36).slice(2, 7);
      localStorage.setItem(NAME_KEY, h);
    }
    return h;
  }

  const deviceId = getDeviceId();
  let handle = getHandle();
  let warned = localStorage.getItem(WARN_KEY) === "true";
  let banned = false;

  /* -------------------- State / callbacks -------------------- */
  let client = null;
  let connected = false;
  const listeners = { status: [], broadcast: [], dm: [], ban: [], warn: [] };

  function emit(type, payload) {
    (listeners[type] || []).forEach((fn) => {
      try { fn(payload); } catch (_) {}
    });
  }

  /* -------------------- Connect -------------------- */
  function connect() {
    if (client || typeof mqtt === "undefined") return;

    client = mqtt.connect(BROKER);

    client.on("connect", () => {
      connected = true;
      emit("status", { connected: true });
      client.subscribe([T.BANS, T.WARNS, T.BROADCAST, T.ADMIN_DM, T.USERS, T.ROLES]);
      // Announce ourselves right away, then on a heartbeat.
      pulse();
    });

    client.on("offline",    () => { connected = false; emit("status", { connected: false }); });
    client.on("disconnect", () => { connected = false; emit("status", { connected: false }); });

    client.on("message", (topic, message) => {
      let data;
      try { data = JSON.parse(message.toString()); } catch { return; }
      handleMessage(topic, data);
    });

    // Presence heartbeat (same ~8s cadence as KAPCS).
    setInterval(pulse, 8000);
  }

  /* -------------------- Presence -------------------- */
  // Appears in the admin User table exactly like a KAPCS user,
  // tagged so moderators can tell it is a GoreTok guest.
  function pulse() {
    if (!client || !connected || banned) return;
    client.publish(T.USERS, JSON.stringify({
      action: "presence_pulse",
      username: handle,
      deviceId: deviceId,
      likes: 0,
      country: "GT",
      countryName: "GoreTok",
      role: "none",
      warned: warned,
      status: "GORETOK",
    }));
  }

  /* -------------------- Reporting -------------------- */
  // Called by the feed UI when a viewer reports a clip.
  // Lands in the admin console's Reports tab.
  function reportClip(info) {
    if (!client || !connected) return false;
    const reportedUser = (info.user || "unknown").replace(/^@/, "");
    client.publish(T.REPORTS, JSON.stringify({
      severity: info.severity || "MEDIUM",
      category: "GoreTok clip report",
      reason: info.reason ? `${info.reason} — "${info.text || ""}"` : (info.text || "Reported clip"),
      reportedUser: reportedUser,
      reportedDevId: info.deviceId || ("GT-CLIP-" + reportedUser),
      time: new Date().toLocaleTimeString(),
    }));
    return true;
  }

  /* -------------------- Incoming admin actions -------------------- */
  function handleMessage(topic, data) {
    const myName = handle.toLowerCase();

    // Admin requests everyone to re-announce presence.
    if (topic === T.USERS && data.action === "request_presence") {
      pulse();
      return;
    }

    // Broadcast to all online users.
    if (topic === T.BROADCAST && data.action === "admin_broadcast") {
      emit("broadcast", { message: data.message, time: data.time });
      return;
    }

    // Private admin DM targeted at this guest.
    if (topic === T.ADMIN_DM && (data.target || "").toLowerCase() === myName) {
      emit("dm", { message: data.message, time: data.time });
      return;
    }

    // Warnings targeted at this guest.
    if (topic === T.WARNS && (data.targetUser || "").toLowerCase() === myName) {
      if (data.action === "add") {
        warned = true; localStorage.setItem(WARN_KEY, "true");
      } else if (data.action === "remove") {
        warned = false; localStorage.removeItem(WARN_KEY);
      }
      emit("warn", { warned: warned });
      pulse();
      return;
    }

    // Bans / unbans targeted at this guest (by device id or handle).
    if (topic === T.BANS) {
      const devMatch  = data.targetDev === deviceId;
      const nameMatch = (data.targetName || "").replace(/^@/, "").toLowerCase() === myName;
      if (!devMatch && !nameMatch) return;

      if (data.action === "unban") {
        banned = false;
        localStorage.removeItem(BAN_KEY);
        emit("ban", { banned: false });
      } else if (data.action === "ban") {
        banned = true;
        const info = { reason: data.reason || "Moderation", expiresAt: data.expiresAt || null };
        localStorage.setItem(BAN_KEY, JSON.stringify(info));
        emit("ban", { banned: true, reason: info.reason, expiresAt: info.expiresAt });
      }
      return;
    }
  }

  /* -------------------- Ban persistence across reloads -------------------- */
  function checkStoredBan() {
    try {
      const raw = localStorage.getItem(BAN_KEY);
      if (!raw) return null;
      const info = JSON.parse(raw);
      // Expired ban clears itself.
      if (info.expiresAt && Date.now() > info.expiresAt) {
        localStorage.removeItem(BAN_KEY);
        return null;
      }
      banned = true;
      return info;
    } catch (_) { return null; }
  }

  /* -------------------- Moderation identity follows login -------------------- */
  // Called by app.js after a successful login/register (or on a restored
  // session) so the admin console sees the real logged-in handle. Presence
  // shape stays identical (country:'GT' status:'GORETOK').
  function setHandle(newHandle) {
    if (!newHandle || typeof newHandle !== "string") return handle;
    const clean = newHandle.trim().replace(/^@/, "");
    if (!clean || clean === handle) return handle;
    handle = clean;
    try { localStorage.setItem(NAME_KEY, handle); } catch (_) {}
    pulse();
    return handle;
  }

  /* -------------------- Public API -------------------- */
  return {
    init: function () { checkStoredBan(); connect(); return this; },
    on: function (type, fn) { if (listeners[type]) listeners[type].push(fn); return this; },
    report: reportClip,
    setHandle: setHandle,
    getStoredBan: checkStoredBan,
    isWarned: function () { return warned; },
    identity: function () { return { handle: handle, deviceId: deviceId }; },
  };
})();
