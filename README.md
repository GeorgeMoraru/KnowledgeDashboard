# 🧠 Knowledge Dashboard

A modern, standalone, pluggable Second Brain & LLM Wiki Dashboard designed for local homelabs, remote Tailscale meshes, and static web deployments via GitHub Pages.

---

## 🚀 Live Demo & Deployments

- **GitHub Pages Site**: [https://georgemoraru.github.io/KnowledgeDashboard/](https://georgemoraru.github.io/KnowledgeDashboard/)
- **Tailscale Gateway / Tailgate**: `https://themeanmachine.taild1868e.ts.net/kb/`
- **Local Daemon**: `http://127.0.0.1:7650`

---

## ✨ Features

- **🔌 Fully Pluggable Knowledge Base**: Mount any knowledge repository, Obsidian vault, or documentation folder. Auto-discovers categories, domains, and taxonomy dynamically without hardcoded schemas.
- **✏️ In-Browser Live Markdown Note Editor**: Full-featured in-drawer editor supporting live Markdown syntax, auto-indented Tab key support, word and character counters, and frontmatter metadata sync.
- **📜 Git Version History & Diff Viewer**: Track note revisions directly in the dashboard, preview previous commits, and view unified line-by-line diffs.
- **📝 Quick Note (`+ Note`) Modal**: One-click note creation with pre-built templates (*Concept, Procedure, Spec, Reference, ADR, Meeting Notes*).
- **🔍 Deep Conceptual & Exact Keyword Search**: Multi-factor ranked search scoring titles, tags, summaries, and contents.
- **🕸️ Interactive Obsidian-Style Knowledge Graph**: Canvas force-directed graph with physics, domain clustering, and click-to-preview.
- **🗑️ Safe Note & Topic Deletion**: Delete notes and entire topic directories directly from the UI with automated backup snapshots and confirmation dialogs.
- **📱 Installable Progressive Web App (PWA)**: Offline caching, mobile-first responsive layout, and service worker auto-updates.
- **🔒 Google Sign-In & Role Access**: Seamless Google Firebase Authentication with Guest and Admin privilege management.

---

## 🛠️ Quick Start

### 1. Run with Out-of-the-Box Default
```bash
python3 server.py
```
*Access at `http://127.0.0.1:7650`.*

### 2. Plug in Any External Vault or Directory
```bash
# Pass path directly
python3 server.py /path/to/any/obsidian-vault

# Or use CLI flags
python3 server.py --kb-root /path/to/custom/kb --port 7650
```

### 3. Configure via `config.json`
```json
{
  "kb_root": "/DATA/Work/repos/KnowledgeBase",
  "port": 7650,
  "host": "0.0.0.0",
  "proxy_prefix": "/kb",
  "name": "Second Brain Knowledge Base"
}
```

---

## 🌐 GitHub Pages Deployment

The repository includes a GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) that automatically builds and publishes the dashboard to GitHub Pages on every push to `main`.

1. Go to your repository settings on GitHub: `Settings` → `Pages`.
2. Under **Build and deployment** → **Source**, select **GitHub Actions**.
3. Push to `main`, and your site will be live at `https://<username>.github.io/KnowledgeDashboard/`.

---

## 📄 License
MIT © George Moraru
