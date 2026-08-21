# Change Guide — Static PWA + Server-Side Writer Split

What changed in this repo (and in `KnowledgeBase`), why, and how to work with it now.
Read this before touching connection, auth, or graph code — several of the old
assumptions are gone.

---

## 1. The one-line summary

The Python server moved **out** of this repo into `KnowledgeBase/server/kb_server.py`.
`KnowledgeDashboard` is now a pure static PWA with no build step and no server of its
own: it is handed a KB base URL at runtime and talks to that server over HTTP.

```
before                                after
KnowledgeDashboard/                   KnowledgeDashboard/        (static, deployable to Pages)
  server.py      <- the writer          index.html + js/css
  config.json    <- secrets             kb-source.js  <- connection layer
  data.js        <- baked payload     KnowledgeBase/
  index.html + js/css                   server/kb_server.py     <- the single writer
```

Consequences you will hit immediately:

- **There is no `python3 server.py` here any more.** Run the server from the KB repo.
- **No data is committed to this repo.** `data.js` is gone; the payload always arrives
  over the network (or from the IndexedDB cache).
- **No secrets live here.** `firebaseConfig.js` is gone; auth config is fetched from
  the connected KB at runtime.

---

## 2. Connection layer — `kb-source.js`

Everything about "which KB am I talking to" lives in this one file. It owns:

- **Base-URL resolution**, in precedence order:
  1. `?kb=<url>` query param (shareable deep link — also persisted)
  2. `localStorage['kb_base_url']`
  3. the page's own origin (works when the server serves the UI via `--static-dir`)
- **Probing**: `GET /api/health` for a live writer, `GET /kb.json` for a static snapshot.
- **Payload load with a fallback chain**: `/api/notes` → `/kb.json` → IndexedDB cache.
- **Status reporting** into the topbar pill and the sidebar footer.
- **A self-injected settings dialog** (no markup in `index.html` for it).

**How to add a call to the KB:** never write `fetch('./api/…')`. Route through the
source layer so the request follows the configured KB. 14 hardcoded `./api/...`
call sites were converted for exactly this reason.

### Read-only is a property of the connection, not the user

**Guest mode is deleted.** There is no guest/admin split any more:

| Connection | Writable? |
| :--- | :--- |
| Live `/api/*` server | yes |
| `/kb.json` snapshot | no |
| IndexedDB cached payload (offline) | no |

When the payload is not writable the layer sets `body.kb-readonly`, and CSS hides
every control that cannot work. If you add a mutating control, make sure it is
covered by a `.kb-readonly` rule.

---

## 3. Auth — optional and credential-free

`firebaseConfig.js` (hardcoded API key, 4 probe endpoints of which 2 always errored,
plus a dead `urllib`-style path) was replaced by `auth.js`:

1. `auth.js` asks the connected KB for `GET /api/config/auth`.
2. Only if that returns a real config does it lazily load the Firebase SDK.
3. `window.KBAuth` therefore **exists only when auth is configured** — always guard on it.

With no auth configured the Sign In button stays visible and explains why it is
unavailable rather than throwing. Config is supplied server-side via `KB_AUTH_CONFIG`
(env, JSON) or `config.json:auth` in the KB repo; `config.json` is gitignored.

---

## 4. Correctness fixes worth knowing about

- **`bodyContent` → `body` (7 sites).** The payload field is `body`. The old code read
  `undefined`, which blanked the note viewer, opened an *empty* editor that would have
  wiped the note on save, and threw on Share. If you see `bodyContent` anywhere, it is a bug.
- **Rename-note added end to end**: footer button → modal → live slug preview matching
  the server's slug rule → `POST /api/rename-note` → relinked-count toast → reopen the
  note at its new id.
- **Frontmatter block lists** (`related:` followed by `- item` lines) used to parse as
  empty on the server, silently degrading the graph. Fixed, and the parser is now
  BOM-tolerant (107 notes were also de-BOM'd on disk).
- **Payload cache** on the server: `/api/notes` recompiled all notes on every request
  (~20 s over the mapped network drive). Reads now come from an in-memory cache keyed on
  a stat-only fingerprint (file count, newest mtime, total bytes), so out-of-band edits
  (git pull, editor, another agent) are still picked up. `?refresh=1` forces a recompile.
  20 s → 3-4 s.

---

## 5. UI / CSS system

**All colour lives in `styles.css` as custom properties.** There are two token blocks:
`:root` (dark) and `[data-theme="light"]`. Every literal hex/rgba outside those blocks
was removed — 35 call sites. **Do not introduce a raw colour value**; add a token to both
blocks instead. JS that needs a colour reads it back with `getComputedStyle` (that is how
`--topic-accent`, `--cat-accent` and the `--graph-*` tokens reach the canvas).

Other things that bit us and are now load-bearing:

- **`.hidden` is `display: none !important`.** Five component rules further down the file
  declared their own `display` at the same specificity and won on source order, silently
  un-hiding the connect prompt, the notification badge and the profile chip.
- **`.sh-nav-tab { flex-shrink: 0 }`** — topic pills were being squeezed to 2 characters
  at tablet width. The scroller scrolls; the pills do not shrink.
- **Topbar wrap rules live in the `max-width: 900px` breakpoint**, not `640px`. At 768 the
  bar was overlapping itself.
- **Sidebar scroller has `min-height: 0`** (the footer was pushed out of the viewport) and
  the topic-pill scroller has padding (the active pill's focus ring was clipped).
- **PWA `theme-color` follows the theme.** `applyTheme()` writes the resolved `--bg-topbar`
  into the meta tag, otherwise the installed app keeps a dark title bar in light mode.
- **Graph legend**: ranked by note count, capped at `LEGEND_LIMIT` (8) with an explicit
  "+N more not shown" line, ellipsised labels, tabular-aligned counts, `.active` state
  bound to the selected topic. It is sized to show its whole list — a px `max-height`
  sliced the last row in half, which read as a rendering bug.

---

## 6. Graph engine (`graph.js`)

The layout was rebuilt. If you touch the physics, these are the invariants:

- **The simulation has its own world**, larger than the canvas:
  `layoutWorld(n) = { w: max(canvasW, √n·95), h: max(canvasH, √n·95) }`. Gravity, bounds
  and initial placement all use `this.world`, never the canvas size.
- **Springs must apply opposite signs to their two endpoints.** Applying the same sign
  made every edge shove its target outward; 454 of 539 nodes ended up pinned to the world
  wall in straight lines. This was the actual root cause of the "exploded graph" — the
  ring radius, repulsion and wall tweaks around it are secondary.
- **Soft walls** (a 120px push-back band) run before the hard clamp, so nodes decelerate
  instead of sticking.
- **Initial placement is phyllotaxis** (golden angle `2.39996`, `orbitDist = 60 + √i·26`)
  around each topic hub, and `clusterRingRadius` is fitted so the biggest topic's orbit
  still lands inside the world.
- **`centerGraph()` fits the node bounding box** (pad 24, scale clamped 0.15–1.4) rather
  than centring on the world. The sim refits once on settle, but only if
  `this.userAdjustedView` is false — any zoom or pan sets that flag and the camera is
  then left alone.
- **Label level-of-detail**: with 521 notes, drawing every label is unreadable. Labels are
  drawn for the selected/hovered node always; for highlighted nodes when a selection is
  active; for everything only when `nodes.length <= 60 || k >= 1.5`; otherwise hubs only.

---

## 7. PWA & deploy

- `sw.js` cache is at **v10**, the precache list matches the real file set, and it **no
  longer intercepts cross-origin KB traffic** (it was caching API calls to another host).
  **Bump the cache version whenever you change a precached file.**
- `manifest.json` de-branded.
- `.github/workflows/pages.yml`: `node --check` over every JS file, then a no-build Pages
  deploy with `.nojekyll`. There is no bundler — keep it that way, and keep the JS
  parseable by plain Node.

---

## 8. Files deleted from this repo

`server.py`, `config.json`, `data.js`, `__pycache__/`, `server.log`,
`firebaseConfig.js`, and a duplicate root `knowledgebase.svg`.

On the KB side, the old `KnowledgeBase/dashboard/` tree was deleted after a feature
comparison confirmed this dashboard is a strict superset — except
`dashboard/zima_dashboard/`, which was moved to its own repo (`ZimaDashboard`, the
ZimaOS port-7600 homelab launcher).

---

## 9. How to run it now

```bash
# 1. Start the writer from the KnowledgeBase repo
python server/kb_server.py --host 0.0.0.0

# 2a. Point a deployed dashboard at it: open the site and use the connection dialog,
#     or deep-link:  https://<user>.github.io/KnowledgeDashboard/?kb=https://host:7650
# 2b. Or serve the UI from the server itself for local dev:
python server/kb_server.py --static-dir ../KnowledgeDashboard
```

See `KnowledgeBase/server/README.md` for flags, config precedence, the full API table,
Tailscale exposure, and deleted-note recovery.

---

## 10. Verification harness

`tools/cdp_sweep.py` drives headless Chrome over the DevTools protocol against a running
`kb_server.py --static-dir`: it emulates 430x900 / 390x844 / 360x740 / 768x1024,
captures cards / list / graph / light-cards / light-graph per viewport, measures topbar
wrap, horizontal overflow and legend geometry (clipping, wrapping, toolbar overlap), and
harvests console errors and page exceptions.

```bash
pip install websocket-client
python tools/cdp_sweep.py http://127.0.0.1:7650 /tmp/kbshots
```

It is worth running after any CSS or graph change — it caught all four of the layout bugs
listed in section 5, none of which were visible at desktop width.
