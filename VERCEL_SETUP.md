# KAPCS — Vercel Telepítési Útmutató

## Admin védelem beállítása

Az `/api/admin-gate.js` Edge Function védi az admin panelt.
Ahhoz hogy működjön, a Vercel Dashboard-on be kell állítani 2 env változót:

### Lépések:
1. Vercel Dashboard → Project → **Settings** → **Environment Variables**
2. Add hozzá:

| Name | Value | Environment |
|------|-------|-------------|
| `KAPCS_ADMIN_PASSWORD` | `az_uj_jelszo_ide` | Production, Preview |
| `KAPCS_ADMIN_SECRET` | `egy_legalabb_32_karakter_random_string` | Production, Preview |

### Példa secret generálás:
```
openssl rand -hex 32
```
Vagy online: https://generate-secret.vercel.app/32

### Fontos:
- Ha **NEM** állítod be az env változókat, az alapértelmezett `admin2026` jelszó
  és gyenge secret lesz érvényes — **mindig add meg a saját értékeidet!**
- Az admin URL: `https://kapcs.vercel.app/admin` (vagy a te domainedet)
- Az admin.html közvetlenül már **NEM érhető el** — csak `/admin` útvonalon keresztül

## PWA ikonok

Helyezd el az `icons/` mappában:
- `icon-192.png` (192×192 px)
- `icon-512.png` (512×512 px)

Generálás: https://realfavicongenerator.net

## Fájl struktúra

```
ometv/
├── index.html          ← Főoldal
├── admin.html          ← Admin panel (védett, csak /admin URL-en át érhető el)
├── manifest.json       ← PWA manifest
├── sw.js               ← Service Worker
├── vercel.json         ← Vercel routing + security headers
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── api/
    └── admin-gate.js   ← Edge Function — admin hitelesítés
```
