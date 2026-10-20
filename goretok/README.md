# GoreTok — front-end prototype

A TikTok-style **18+** short-video platform concept for **fictional / FX / gaming / horror**
content only. **Real violence or real harm is strictly banned.**

The front end is now wired to a real Vercel backend (accounts, shared posts, likes,
admin stats/roles — see "Backend" below). Front-end feature overview:

- **Age gate** centered over a blurred feed. `Yes` enters the site, `No` sends the visitor away.
- **Vertical video feed** — scroll with the mouse wheel, swipe on touch, or use `↑`/`↓` (also `j`/`k`) keys. The centered clip autoplays (muted); others pause. Tap to play/pause.
- **Sidebar views** — For You (real feed), Upload (file **or** URL posting), Discover (hashtag browser) and Profile (role badge, own + liked posts) are live; Moderation remains a "coming soon" placeholder.
- **Like + Report** actions on every clip (likes are server-backed, see below).
- **Dark Neon** theme, GoreTok logo, English UI.

## Shared moderation (with KAPCS)

GoreTok plugs into the **same moderation backbone as KAPCS**, so one admin
console (`../admin.html`) moderates both apps. No separate panel, no AI content
recognition on the GoreTok side.

`js/moderation.js` connects to the same MQTT broker and topics (`kapcs_v13_*`) as
`index.html` / `admin.html` and:

- **Presence** — each GoreTok guest appears in the admin User table, tagged
  `GORETOK` (country `GT`) so moderators can tell the two apps apart.
- **Reports** — the ⚑ button on a clip sends a report to the admin Reports tab.
- **Bans** — an admin ban targeting the guest's handle or device id locks the
  feed behind a ban screen; unban/expiry restores access.
- **Warnings** — show a warning banner at the top of the feed.
- **Broadcast / Admin DM** — appear as a toast over the feed.

Login to the admin console is the **same gate** as KAPCS: `api/admin-gate.js`
(HMAC token) protects `admin.html`; GoreTok moderation happens there.

> This is a front-end prototype bridge. A production build must authenticate
> publishers and validate every message server-side — a browser client can
> currently publish any `kapcs_v13_*` message.

## Run it

It is plain HTML/CSS/JS, so just open `index.html` in a browser.

For best results (so the SVG favicon and paths resolve cleanly) serve it locally:

```powershell
# from the goretok folder, pick one:
python -m http.server 5500
# then open http://localhost:5500
```

## Structure

```
goretok/
  index.html           # app shell + age gate + warn banner + ban screen + toast
  css/style.css        # Dark Neon theme, age gate, feed, views, moderation UI
  js/app.js            # age gate, feed, playback, nav, like/report, mod wiring
  js/moderation.js     # shared MQTT bridge to the KAPCS admin console
  assets/logo-mark.svg # GoreTok emblem (also used as favicon)
```

## Backend (Vercel serverless + Vercel KV)

Accounts, the shared post store, likes, hashtags, and admin stats/roles run on
**Vercel Functions** under `../api/goretok/*`, backed by **Vercel KV**
(Upstash Redis via `@vercel/kv`). Video **file upload** uses a **public Vercel
Blob** store via `@vercel/blob`'s `put()` (server upload, Node runtime).
No framework, no build step.

- **Auth** — `POST /api/goretok/register` and `/login` create/verify an account
  (username + password). Passwords are stored **only** as a PBKDF2 hash + per-user
  salt; sessions are HMAC-SHA256 tokens with a 24h TTL (same scheme as
  `api/admin-gate.js`), sent as `Authorization: Bearer <token>`. The age gate is
  shown first; the login/register screen follows it.
- **Feed** — `GET /api/goretok/posts` returns the shared feed (newest first,
  paginated). With zero posts the feed shows a **"no posts yet"** empty state —
  there are no demo clips.
- **Posting** — `POST /api/goretok/posts` adds a post from either a **picked/dropped
  video file** (uploaded to **Vercel Blob** via the upload route, then posted by its
  public URL) **or** a **direct video URL**, plus a title and free-text **hashtags**. The
  old fixed category field is **removed** (hashtags replace it). The clip's
  **duration** is read in the browser from the file/URL metadata (a hidden
  `<video>` element — **not AI**) and stored as `durationSec`, shown as `m:ss`.
- **File upload** — `POST /api/goretok/blob-upload-url` (session-gated, Node
  runtime) accepts the raw video bytes, restricts to `video/*` and ~4.4 MB, and
  `put()`s the file to the **public** Blob store, returning its public URL.
  Bigger clips should use the video-URL field. File upload needs a **linked
  public Blob store**;
  **URL posting works without one.**
- **Hashtags** — there are **no seeded/default tags** — only ones users type. On
  create, each normalized tag increments a usage counter and joins a known-tags
  index. `GET /api/goretok/tags` returns `[{ tag, count }]` (sorted by count); the
  Discover view lists them as `#tag · N videos` (singular `1 video`) with an empty
  state at zero, and clicking a tag filters the feed. Captions show the same count.
- **Likes** — `POST /api/goretok/like` persists likes server-side so counts are
  shared across visitors and reloads (idempotent).
- **Profile** — `GET /api/goretok/me` fills the profile view with the handle, role
  badge, own posts and liked posts; warn/ban status comes from the MQTT bridge.
- **Admin** — `GET /api/goretok/admin/stats` (total users + per-role breakdown) and
  `POST /api/goretok/admin/role` (assign a role, including `founder`) are surfaced
  in `../admin.html`, protected by the **existing** admin HMAC gate.

After login the app calls `window.GoreTokMod.setHandle(handle)` so the moderation
identity follows the real logged-in account (presence stays `country:'GT'
status:'GORETOK'`). **No AI/NSFW recognition** runs on the GoreTok side.

### Environment variables (Vercel)

| Name | Purpose |
|------|---------|
| `GORETOK_AUTH_SECRET` | HMAC key for GoreTok session tokens (≥32 random chars). Local-dev fallback in code, flagged like `admin-gate.js`. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` (+ read-only) | Vercel KV / Upstash connection, injected when a KV store is linked to the project. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token, **auto-injected** when a Blob store is linked. Needed for **file upload** only — URL posting works without it. Never hardcode it. |
| `KAPCS_ADMIN_SECRET` | Existing admin-gate secret, **reused** to verify the admin stats/role endpoints. |

See `../VERCEL_SETUP.md` for the full setup walkthrough.

## What's next (later steps)

- **Upload pipeline:** transcoding + posters on top of the Vercel Blob upload.
- **Comments backend:** posts already carry a `commentCount` field.
- **Account recovery:** email verification / password reset / OAuth / 2FA.

> The age gate here is a simple self-declaration. A production 18+ site needs stronger,
> legally compliant age verification and content moderation.
