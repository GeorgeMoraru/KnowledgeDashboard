# SmartHub Knowledge Base Dashboard

An interactive dashboard for searching, browsing, and visualizing the **Work Second Brain** knowledge base with the look and feel of **SmartHub**.

---

## 🌟 Key Features

1. **Dark & Light Themes**:
   - Dark palette after the *NeuroBank* dashboard, light palette after the *CRM Dashboard* one.
   - Toggle in the top bar, remembered in `localStorage` (`sh_kb_theme`); the graph canvas follows.
   - High-contrast typography, clear hierarchy, fluid layout, and metadata badges.
2. **Instant Search & Query Highlighting**:
   - Fast keyword matching across titles, summaries, tags, and full Markdown content.
   - Matched keyword highlights (`<mark>`) in titles and snippets.
   - Keyboard shortcut `/` to quickly jump to the search bar, `Esc` to clear or close.
3. **Sidebar Facets**:
   - Category, topic, and tag facets with live asset counters, all built from `data.js` —
     a new category or domain folder appears without a code change.
4. **Card View & List View Toggle**:
   - **Card View (Default)**: Visual cards with topic pill, type badge, highlighted snippet, clickable tag chips, last updated date, and quick action.
   - **List View**: High-density tabular view with sortable layout, compact metadata, and direct open buttons.
5. **Interactive Knowledge Graph**:
   - Force-directed physics network visualization with Canvas rendering.
   - Topic Hub nodes and individual note nodes with topic-coded colors and connection weights.
   - Visualizes both topic hierarchies and cross-wiki `[[related]]` references.
   - Full drag, pan, wheel zoom, zoom controls (`+`, `−`, `⛶`), physics simulation toggle, and legend.
   - Hover tooltips and click-to-inspect node panel. Double-click node to open full note reader!
6. **Full Note Reader / Preview Modal**:
   - Full Markdown renderer (headers, code snippets with syntax style, tables, bullet points, blockquotes).
   - Interactive `[[wikilinks]]` navigation between connected notes.
   - Metadata strip (Topic, Type, Status, Word count, Date).
   - "Copy Path" button for quick file access.
7. **Universal Share & Knowledge Base Ingestion System**:
   - **Deep Linking**: Shareable URL parameters (`?note=<noteId>`, `?topic=<topic>`, `?q=<search>`) that directly open notes or filter views.
   - **Markdown Ingest Bundle**: Complete Karpathy-compliant YAML frontmatter + content ready to save into any second brain (`knowledge/`, Obsidian, Logseq, Notion).
   - **AI / LLM Ingestion Prompt**: Pre-formulated prompt for Claude Code, Cursor, ChatGPT, or `/kb-ingest` to scaffold domain folders and reconcile wikilinks.
   - **JSON Schema Ingest**: Standard schema payload for automated ETL, vector databases, and RAG pipelines.
   - **One-Click Actions**: Quick copy buttons and direct `.md` / `.json` file downloads.

---

## 🚀 How to Run

The dashboard needs `server.py` running — it serves the static files and provides the
`/api/*` endpoints used for ingestion, tag edits, and moving notes between topics:

```powershell
python3 dashboard/server.py
```

Then open <http://localhost:7650/> (or `/kb/` when reached through the Tailscale proxy).
`meta/scripts/kb_sync_inbox.py` starts the same server automatically.

Opening `index.html` straight off disk also works, but only as a read-only view of the
last generated `data.js` — every write action needs the API.

---

## 🔄 Updating Data

`server.py` rebuilds `data.js` from `knowledge/**/*.md` on startup, and again whenever
`POST /api/rebuild` is called (the dashboard fires this after any ingest or edit). New
domain folders under `knowledge/<category>/` are discovered automatically — no code
change is needed to add a topic.

---

## 🎨 Where Colours Live

Every colour lives in `styles.css` — `server.py` emits none, and no JS file carries a hex.
Both themes declare the same variable names: the dark set in `:root`, the light set in the
`[data-theme="light"]` block.

| Variable group | Used for |
| --- | --- |
| `--topic-<slugified-domain>` | per-topic accent; a folder with no entry gets one of `--topic-auto-*` by name hash |
| `--cat-<slugified-category>` | per-category accent, including `--cat-all` for the "All Knowledge" row |
| `--graph-*` | canvas colours, read by `graph.js` via `getComputedStyle` and re-read on theme change |

`app.js` resolves those variables and passes the result down as `--topic-accent`,
`--card-accent` and `--cat-accent` on the element it renders, so the category rules in the
CSS are generic — a new category needs no rule of its own, only an optional `--cat-*` entry.

---

## 📱 Responsive Layout

Grids and modals size themselves with `auto-fit` / `min()` / `clamp()`, so the four
breakpoints (1100 / 900 / 640 / 420px) only carry what layout maths can't express: the
off-canvas sidebar, the top bar folding its search onto a second row, the list-view
columns dropping out in order (tags → type + updated → topic → category), and touch-target
sizing.

