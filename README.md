# 🧠 Knowledge Dashboard

A standalone, pluggable Second Brain / LLM wiki front-end. It is a **static PWA — no build
step, no server of its own** — that connects over HTTP to a knowledge-base server and reads
and edits the notes there.

The server lives in the knowledge base it writes:
[`KnowledgeBase/server/kb_server.py`](https://github.com/georgemoraru/KnowledgeBase).

```
GitHub Pages (public, static)          Local host (private)
+---------------------------+          +--------------------------------+
| KnowledgeDashboard        |  HTTPS   | kb_server.py  (single writer)  |
| index.html/css/js + sw.js | -------> | /api/*  read + mutate          |
| PWA, no build step        | Tailscale| writes markdown, then commits  |
+---------------------------+  serve   +--------------------------------+
                                              |
                                       private KnowledgeBase git repo
```

No knowledge data and no credentials are committed to this repo. The dashboard is handed a
KB base URL at runtime and caches the last good payload in IndexedDB, so it still opens
offline (read-only).

---

## 🚀 Deployments

- **GitHub Pages**: [https://georgemoraru.github.io/KnowledgeDashboard/](https://georgemoraru.github.io/KnowledgeDashboard/)
- **Tailscale gateway**: `https://themeanmachine.taild1868e.ts.net/kb/`
- **Local server**: `http://127.0.0.1:7650`

---

## 🛠️ Quick Start

### 1. Start the knowledge-base server (from the `KnowledgeBase` repo)

```bash
python server/kb_server.py                  # 127.0.0.1:7650, serves the KB it lives in
python server/kb_server.py --host 0.0.0.0   # expose to the LAN / Tailscale
```

### 2. Point the dashboard at it — pick one

```bash
# a) Local dev: let the server serve the UI too (same origin, nothing to configure)
python server/kb_server.py --static-dir ../KnowledgeDashboard

# b) Deployed UI: open the site and use the connection dialog (the pill in the topbar)

# c) Deployed UI, shareable deep link:
#    https://<user>.github.io/KnowledgeDashboard/?kb=https://your-host:7650
```

The chosen URL is remembered in `localStorage['kb_base_url']`.

### 3. Read-only / offline

Read-only is a property of the *connection*, not of the user — there is no guest mode. A live
`/api/*` server is writable; a `/kb.json` snapshot or the offline IndexedDB cache is not, and
the UI hides what cannot work.

---

## ✨ Features

- **🔌 Pluggable knowledge base** — mount any markdown vault; categories, domains and taxonomy
  are discovered dynamically, with no hardcoded schema.
- **✏️ In-browser markdown editor** — live editing, Tab indent, word/char counters, frontmatter sync.
- **📜 Git history & diff viewer** — per-note revisions, previous-commit preview, unified diffs.
  Every mutation is one commit on the server side, so git is the audit log.
- **📝 Quick Note templates** — Concept, Procedure, Spec, Reference, ADR, Meeting Notes.
- **🏷️ Rename, retag, recategorise, delete** — renames follow the file with `git mv`, rewrite the
  frontmatter title and a matching `# H1`, and repoint every `[[wikilink]]` aimed at the old name.
- **🔍 Deep conceptual + exact keyword search** — multi-factor ranking over titles, tags,
  summaries and body.
- **🕸️ Force-directed knowledge graph** — canvas physics, topic clustering, label
  level-of-detail, fit-to-content camera, click-to-preview.
- **📱 Installable PWA** — offline cache, mobile-first responsive layout, service-worker updates.
- **🎨 Dark + light themes** — one token set in `styles.css`; the PWA title bar follows the theme.
- **🔒 Optional Google Sign-In** — config is fetched from the connected KB at runtime; no keys
  in this repo. With none configured the app simply runs without sign-in.

---

## 📁 Layout

| Path | Role |
| :--- | :--- |
| `index.html` | markup shell |
| `app.js` | views, search, editor, modals, theme |
| `kb-source.js` | KB connection: URL resolution, probing, payload load, cache, status, settings dialog |
| `auth.js` | optional Firebase auth, configured at runtime |
| `graph.js` | canvas force-directed graph |
| `styles.css` | design tokens (dark + light) and all layout |
| `sw.js`, `manifest.json` | PWA |
| `tools/cdp_sweep.py` | headless-Chrome responsive / regression sweep |
| `docs/CHANGES.md` | what changed in the static-PWA split, and how to work with it |

---

## 🌐 GitHub Pages deployment

`.github/workflows/pages.yml` runs `node --check` over every JS file, then publishes the repo
as-is (with `.nojekyll`) on every push to `main`. There is no bundler — keep the JS plain and
parseable by Node.

1. `Settings` → `Pages` → **Source: GitHub Actions**.
2. Push to `main`; the site lands at `https://<username>.github.io/KnowledgeDashboard/`.

---

## 📄 License

MIT © George Moraru
