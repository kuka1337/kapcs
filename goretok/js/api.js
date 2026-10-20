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

  // ── Hashtags ──────────────────────────────────────────────────────────
  async function listTags() {
    const res = await fetch(BASE + "/tags");
    return parse(res);
  }

  // ── File upload (Vercel Blob, client-side) ──────────────────────────────
  // Two steps: (1) ask our auth-gated /blob-upload-url route to mint a scoped,
  // short-lived Blob client token (it verifies the session + restricts to
  // video/* and a size cap); (2) stream the file straight to Blob with that
  // token. No bundler here, so @vercel/blob/client is loaded from an ESM CDN.
  // onProgress(pct) receives 0..100. Resolves the public blob URL.
  async function uploadVideoFile(file, onProgress) {
    // 1) Mint a scoped client token from our server.
    const tokRes = await fetch(BASE + "/blob-upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: getToken(),
        pathname: file.name,
        contentType: file.type || "video/mp4",
      }),
    });
    const tok = await parse(tokRes); // throws with the server error message on !ok
    if (!tok || !tok.clientToken) throw new Error("Could not start the upload.");

    // 2) Load the client SDK and stream the file using the minted token.
    let upload;
    try {
      ({ upload } = await import("https://esm.sh/@vercel/blob@2/client"));
    } catch (e) {
      throw new Error("Could not load the uploader. Check your connection.");
    }
    try {
      const blob = await upload(tok.pathname || file.name, file, {
        access: "public",
        token: tok.clientToken,
        contentType: file.type || undefined,
        onUploadProgress: function (e) {
          if (onProgress && e && typeof e.percentage === "number") onProgress(e.percentage);
        },
      });
      return blob.url;
    } catch (e) {
      throw new Error((e && e.message) || "Upload failed.");
    }
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
    listTags, uploadVideoFile,
  };
})();
