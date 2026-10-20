/* ============================================================
   GoreTok — API client
   Thin wrapper over the /api/goretok/* serverless routes.
   Holds the session token in localStorage (goretok_session).
   ============================================================ */

window.GoreTokAPI = (function () {
  "use strict";

  const BASE = "/api/goretok";
  const TOKEN_KEY = "goretok_session";

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (_) { return null; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); } catch (_) {}
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = getToken();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  async function parse(res) {
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = (data && data.error) || ("Request failed (" + res.status + ")");
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── Auth ──────────────────────────────────────────────────────────────
  async function register(handle, password) {
    const res = await fetch(BASE + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, password }),
    });
    const data = await parse(res);
    if (data && data.token) setToken(data.token);
    return data;
  }

  async function login(handle, password) {
    const res = await fetch(BASE + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, password }),
    });
    const data = await parse(res);
    if (data && data.token) setToken(data.token);
    return data;
  }

  // Returns { valid, handle } without throwing on 401.
  async function session() {
    const t = getToken();
    if (!t) return { valid: false };
    try {
      const res = await fetch(BASE + "/session", { headers: authHeaders() });
      if (!res.ok) return { valid: false };
      return await res.json();
    } catch (_) {
      return { valid: false };
    }
  }

  async function me() {
    const res = await fetch(BASE + "/me", { headers: authHeaders() });
    return parse(res);
  }

  function logout() { clearToken(); }

  // ── Posts ─────────────────────────────────────────────────────────────
  async function listPosts(limit, cursor) {
    const qs = new URLSearchParams();
    if (limit != null) qs.set("limit", String(limit));
    if (cursor != null) qs.set("cursor", String(cursor));
    const res = await fetch(BASE + "/posts?" + qs.toString());
    return parse(res);
  }

  async function createPost(payload) {
    const res = await fetch(BASE + "/posts", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    return parse(res);
  }

  // ── Likes ─────────────────────────────────────────────────────────────
  async function like(postId, liked) {
    const res = await fetch(BASE + "/like", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ postId, like: liked }),
    });
    return parse(res);
  }

  return {
    getToken, clearToken,
    isLoggedIn: function () { return !!getToken(); },
    register, login, session, me, logout,
    listPosts, createPost, like,
  };
})();
