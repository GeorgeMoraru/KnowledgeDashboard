# AGENTS.md - Multi-Agent System Directives

## Project Overview
**KnowledgeDashboard**: a static, no-build Progressive Web App front-end for a markdown
knowledge base — force-directed knowledge graph, search, in-browser editor, optional Google
Sign-In. It has **no server of its own**: the writer is `server/kb_server.py` in the
`KnowledgeBase` repo, reached over HTTP at a base URL chosen at runtime.

Read `docs/CHANGES.md` before changing connection, auth, CSS-token or graph code — it records
the invariants that replaced the old assumptions.

## Core Commands & Verification
- **Run the KB server** (from the `KnowledgeBase` repo): `python server/kb_server.py` (port 7650)
- **Serve this UI locally**: `python server/kb_server.py --static-dir ../KnowledgeDashboard`
- **Syntax gate** (what CI runs): `node --check` on every `.js` file
- **Responsive / regression sweep**: `python tools/cdp_sweep.py http://127.0.0.1:7650 /tmp/kbshots`
- **Health check**: `GET /api/health` — **Recompile payload**: `POST /api/rebuild` —
  **Git pull + recompile**: `POST /api/sync`

## Architectural Guidelines
1. **No build step, no bundler.** Plain ES that Node can `--check`. Do not add a toolchain.
2. **Never `fetch('./api/...')` directly** — route every KB call through `kb-source.js` so it
   follows the configured base URL.
3. **No colour literals outside the token blocks in `styles.css`.** Add the token to both
   `:root` and `[data-theme="light"]`; JS reads values back via `getComputedStyle`.
4. **No credentials or knowledge data in this repo.** Auth config arrives at runtime from
   `GET /api/config/auth`; `window.KBAuth` exists only when auth is configured, so guard on it.
5. **Read-only is a connection property.** Snapshot/cached payloads set `body.kb-readonly`;
   any new mutating control must be covered by a `.kb-readonly` rule. There is no guest mode.
6. **Bump the `sw.js` cache version** whenever a precached file changes, and never let the
   service worker intercept cross-origin KB traffic.
7. **Keep the UI fast**: debounce DOM mutations, pause the graph simulation when off-canvas,
   use CSS containment, and keep the graph's label level-of-detail intact (500+ notes).
8. **Content stays decoupled**: notes live in `KnowledgeBase`; only the front-end lives here.
