#!/usr/bin/env python3
"""
Knowledge Base Dashboard Server & Sync Engine
Serves the Knowledge Base Web App / PWA on port 7650 (and via Tailscale /kb route).
Handles data compilation, Google Drive auto-sync, raw inbox ingestion, and API routes.
"""

import os
import re
import sys
import json
import time
import shutil
import logging
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs, unquote

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("kb_dashboard")

DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))
# Check KB_ROOT_DIR from env or fallback paths
env_kb_dir = os.environ.get("KB_ROOT_DIR")
if env_kb_dir and os.path.exists(env_kb_dir):
    KB_ROOT_DIR = os.path.abspath(env_kb_dir)
elif os.path.exists("/DATA/Work/repos/KnowledgeBase"):
    KB_ROOT_DIR = "/DATA/Work/repos/KnowledgeBase"
else:
    KB_ROOT_DIR = os.path.abspath(os.path.join(DASHBOARD_DIR, ".."))

KNOWLEDGE_DIR = os.path.join(KB_ROOT_DIR, "knowledge")
RAW_DIR = os.path.join(KB_ROOT_DIR, "raw")
META_DIR = os.path.join(KB_ROOT_DIR, "meta")
DATA_JS_FILE = os.path.join(DASHBOARD_DIR, "data.js")

PORT = int(os.environ.get("KB_PORT", 7650))
PROXY_PREFIX = "/kb"

# Firebase Auth Configuration for Google Sign-In
AUTH_CONFIG = {
    "apiKey": "AIzaSy_PROJECTSPROXI_MANAGED_KEY",
    "authDomain": "blanketdesign-6f376.firebaseapp.com",
    "projectId": "blanketdesign-6f376",
    "storageBucket": "blanketdesign-6f376.firebasestorage.app",
    "messagingSenderId": "261589505266",
    "appId": "1:261589505266:web:f7c64f79a3e34171686c6b",
    "measurementId": "G-3BQN0NXE6K"
}

# Sync State Tracker
SYNC_STATE = {
    "last_sync_time": None,
    "last_sync_result": None,
    "is_syncing": False,
    "total_syncs": 0
}

# Display names only — styling colors live in styles.css
CATEGORY_CONFIG = {
    "general": {"name": "General"},
    "work": {"name": "Work"},
    "projects": {"name": "Projects"},
    "prompt-engineering": {"name": "Prompt Engineering"}
}

DEFAULT_CATEGORY = "general"

TOPIC_CONFIG = {
    # General Topics
    "ai-and-intelligent-systems": {"name": "AI & Intelligent Systems", "category": "general"},
    "engineering-practices": {"name": "Engineering Practices", "category": "general"},
    "software-engineering-and-architecture": {"name": "Software Architecture", "category": "general"},
    "homelab-and-cloud-infrastructure": {"name": "Homelab & Infra", "category": "general"},
    "business-and-monetization": {"name": "Business & Monetization", "category": "general"},
    "business-and-strategy": {"name": "Business & Strategy", "category": "general"},

    # Work Topics (BA Insight / SmartHub Platform)
    "smarthub": {"name": "SmartHub", "category": "work"},
    "connectivity-hub": {"name": "Connectivity Hub", "category": "work"},
    "autoclassifier": {"name": "AutoClassifier", "category": "work"},
    "smartpreviews": {"name": "SmartPreviews", "category": "work"},
    "ba-insight": {"name": "BA Insight Platform", "category": "work"},

    # Projects Topics
    "BlanketDesignGenerator": {"name": "BlanketDesignGenerator", "category": "projects"},
    "FoodEx": {"name": "FoodEx", "category": "projects"},
    "georgemoraru.github.io": {"name": "Portfolio & Web", "category": "projects"},
    "rules": {"name": "Governance & Rules", "category": "projects"},
    "skills": {"name": "SOPs & Skills", "category": "projects"},

    # Flat category
    "prompt-engineering": {"name": "Prompt Engineering", "category": "prompt-engineering"}
}


def resolve_topic(domain: str, category: str) -> str:
    """Display name for a domain folder."""
    for key, cfg in TOPIC_CONFIG.items():
        if key.lower() == domain.lower():
            return cfg["name"]
    if domain == category:
        return CATEGORY_CONFIG.get(category, CATEGORY_CONFIG["general"])["name"]
    return domain.replace("-", " ").replace("_", " ").title()


def note_folder(category: str, domain: str) -> str:
    """Folder a note belongs in, relative to knowledge/."""
    return category if not domain or domain == category else f"{category}/{domain}"


def discover_domains():
    """Domain folders present under knowledge/<category>/."""
    found = {}
    for cat in CATEGORY_CONFIG:
        cat_dir = os.path.join(KNOWLEDGE_DIR, cat)
        found[cat] = sorted(
            d for d in os.listdir(cat_dir)
            if os.path.isdir(os.path.join(cat_dir, d))
        ) if os.path.isdir(cat_dir) else []
    return found


def build_taxonomy():
    """Maps categories to their domains with display names."""
    taxonomy = {}
    for cat, domains in discover_domains().items():
        taxonomy[cat] = [
            {"id": d, "name": resolve_topic(d, cat)}
            for d in domains
        ]
    return taxonomy


def strip_proxy_prefix(path: str) -> str:
    """Strips proxy path prefix for Tailscale routing."""
    if path == PROXY_PREFIX or path.startswith(PROXY_PREFIX + "/"):
        stripped = path[len(PROXY_PREFIX):]
        return stripped if stripped.startswith("/") else "/" + stripped
    return path


def safe_join(base: str, *paths: str) -> str:
    """Safely joins paths ensuring result stays within base directory."""
    final_path = os.path.abspath(os.path.join(base, *paths))
    base_abs = os.path.abspath(base)
    if not (final_path == base_abs or final_path.startswith(base_abs + os.sep)):
        return None
    return final_path


def parse_frontmatter(content: str):
    """Extracts YAML frontmatter and body from Markdown content."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if not match:
        return {}, content

    fm_raw = match.group(1)
    body = match.group(2).strip()
    fm = {}

    for line in fm_raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()

            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            elif val.startswith("[") and val.endswith("]"):
                try:
                    val = json.loads(val)
                except Exception:
                    val = [v.strip().strip("'\"") for v in val[1:-1].split(",") if v.strip()]

            fm[key] = val

    return fm, body


def set_frontmatter_value(content: str, key: str, value_str: str) -> str:
    """Updates a frontmatter key in place or inserts it into the YAML block."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if not match:
        return f"---\n{key}: {value_str}\n---\n\n{content}"

    fm_raw = match.group(1)
    body = match.group(2)

    pattern = re.compile(rf"^{re.escape(key)}\s*:.*$", re.MULTILINE)
    if pattern.search(fm_raw):
        new_fm = pattern.sub(f"{key}: {value_str}", fm_raw)
    else:
        new_fm = f"{fm_raw}\n{key}: {value_str}"

    return f"---\n{new_fm.strip()}\n---\n{body}"


def build_knowledge_data():
    """Compiles all knowledge markdown notes, taxonomy, and graph without redundant bloat."""
    notes = []
    domain_set = set()
    topic_domains = {}
    type_set = set()
    tag_set = set()
    category_counts = {cat: 0 for cat in CATEGORY_CONFIG}

    if not os.path.exists(KNOWLEDGE_DIR):
        logger.warning(f"Knowledge directory not found: {KNOWLEDGE_DIR}")
        return {"notes": [], "topics": [], "totalCount": 0}

    for root, dirs, files in os.walk(KNOWLEDGE_DIR):
        for f in files:
            if not f.endswith(".md"):
                continue

            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, KB_ROOT_DIR).replace("\\", "/")
            parts = rel_path.split("/")

            category = parts[1] if len(parts) > 1 and parts[1] in CATEGORY_CONFIG else DEFAULT_CATEGORY
            domain = parts[2] if len(parts) > 3 else (parts[1] if len(parts) > 2 else category)

            try:
                with open(full_path, "r", encoding="utf-8", errors="replace") as file:
                    content = file.read()
            except Exception as e:
                logger.error(f"Error reading file {full_path}: {e}")
                continue

            fm, body = parse_frontmatter(content)

            title = fm.get("title")
            if not title:
                h1_match = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
                title = h1_match.group(1).strip() if h1_match else f.replace(".md", "").replace("-", " ").title()

            doc_type = fm.get("type", "note")
            status = fm.get("status", "active")
            tags = fm.get("tags", [])
            if isinstance(tags, str):
                tags = [t.strip().strip("'\"") for t in tags.split(",") if t.strip()]

            summary = fm.get("summary", "")
            if not summary:
                clean_body = re.sub(r"[#*`>_\[\]]", "", body).strip()
                summary = clean_body[:200] + ("..." if len(clean_body) > 200 else "")

            created = fm.get("created", time.strftime("%Y-%m-%d", time.localtime(os.path.getctime(full_path))))
            updated = fm.get("updated", time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(full_path))))
            related = fm.get("related", [])

            topic = resolve_topic(domain, category)
            topic_domains[topic] = domain
            domain_set.add(domain)
            type_set.add(doc_type)
            for t in tags:
                tag_set.add(t)

            category_counts[category] = category_counts.get(category, 0) + 1
            note_id = rel_path.replace(".md", "").replace("/", "__")

            # Single body field to avoid payload bloat
            notes.append({
                "id": note_id,
                "filename": f,
                "relPath": rel_path,
                "path": rel_path,
                "title": title,
                "category": category,
                "categoryName": CATEGORY_CONFIG.get(category, {}).get("name", category.capitalize()),
                "domain": domain,
                "topic": topic,
                "topicName": topic,
                "type": doc_type,
                "status": status,
                "created": str(created),
                "updated": str(updated),
                "summary": summary,
                "tags": tags,
                "related": related,
                "wordCount": len(body.split()),
                "body": body
            })

    notes.sort(key=lambda x: x["title"].lower())

    # Build Graph
    nodes = []
    edges = []
    node_map = {}
    topics_list = sorted(topic_domains.keys())

    for t in topics_list:
        hub_id = f"topic__{t.replace(' ', '_')}"
        node_obj = {
            "id": hub_id,
            "name": t,
            "label": t,
            "type": "topic-hub",
            "topic": t,
            "domain": topic_domains[t],
            "radius": 24,
            "isHub": True
        }
        nodes.append(node_obj)
        node_map[hub_id] = node_obj

    for note in notes:
        label = note["title"][:22] + "…" if len(note["title"]) > 24 else note["title"]
        node_obj = {
            "id": note["id"],
            "name": note["title"],
            "label": label,
            "type": note["type"],
            "topic": note["topic"],
            "domain": note["domain"],
            "category": note["category"],
            "noteId": note["id"],
            "relPath": note["relPath"],
            "tags": note["tags"],
            "summary": note["summary"],
            "radius": 16 if note["type"] == "hub" else 11,
            "isHub": False
        }
        nodes.append(node_obj)
        node_map[note["id"]] = node_obj

        hub_id = f"topic__{note['topic'].replace(' ', '_')}"
        if hub_id in node_map:
            edges.append({
                "source": hub_id,
                "target": note["id"],
                "type": "hierarchy",
                "value": 1
            })

    edge_set = set()
    for note in notes:
        all_rels = list(note["related"] or [])
        body_wikis = re.findall(r'\[\[(.*?)\]\]', note["body"])
        for w in body_wikis:
            all_rels.append(w)

        for rel_raw in all_rels:
            clean_rel = rel_raw.replace("[[", "").replace("]]", "").strip().lower()
            if not clean_rel:
                continue

            target_note = None
            for n in notes:
                if n["filename"].replace(".md", "").lower() == clean_rel or \
                   n["title"].lower() == clean_rel or \
                   clean_rel in n["id"].lower():
                    target_note = n
                    break

            if target_note and target_note["id"] != note["id"]:
                edge_key = "<->".join(sorted([note["id"], target_note["id"]]))
                if edge_key not in edge_set:
                    edge_set.add(edge_key)
                    edges.append({
                        "source": note["id"],
                        "target": target_note["id"],
                        "type": "related",
                        "value": 2
                    })

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "stats": {
            "totalNotes": len(notes),
            "totalTopics": len(topics_list),
            "totalTypes": len(type_set),
            "totalTags": len(tag_set),
            "totalEdges": len(edges),
            "categoryCounts": category_counts
        },
        "categories": [{"id": cat, "name": cfg["name"]} for cat, cfg in CATEGORY_CONFIG.items()],
        "categoryCounts": category_counts,
        "defaultCategory": DEFAULT_CATEGORY,
        "taxonomy": build_taxonomy(),
        "domains": sorted(list(domain_set)),
        "topics": topics_list,
        "types": sorted(list(type_set)),
        "tags": sorted(list(tag_set)),
        "notes": notes,
        "graph": {
            "nodes": nodes,
            "edges": edges
        },
        "totalCount": len(notes)
    }

    # Write out data.js for ultra-fast offline cached execution
    breakdown = " | ".join(f"{CATEGORY_CONFIG[cat]['name']}: {count}" for cat, count in category_counts.items())
    js_content = f"/**\n * SmartHub Knowledge Base - Compiled Data Payload\n * Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n * Total Assets: {len(notes)} | Topics: {len(topics_list)} | {breakdown}\n */\nwindow.KB_DATA = {json.dumps(payload, indent=2)};\n"
    with open(DATA_JS_FILE, "w", encoding="utf-8") as f:
        f.write(js_content)

    logger.info(f"Knowledge Base compiled: {len(notes)} notes across {len(topics_list)} topics.")
    return payload


# Google Drive & Ingestion Sync Routine
def trigger_sync():
    """Executes the full sync engine from meta/scripts/kb_sync_inbox.py."""
    global SYNC_STATE
    if SYNC_STATE["is_syncing"]:
        return {"status": "busy", "message": "Sync already in progress"}

    SYNC_STATE["is_syncing"] = True
    start_time = time.time()
    logger.info("=== Starting Knowledge Base & Google Drive Sync ===")

    sync_script = os.path.join(KB_ROOT_DIR, "meta", "scripts", "kb_sync_inbox.py")
    res = {}

    try:
        if os.path.exists(sync_script):
            sys.path.insert(0, os.path.dirname(sync_script))
            import kb_sync_inbox
            res = kb_sync_inbox.run_full_sync()
        else:
            logger.warning(f"Sync script not found at {sync_script}")
            res = {"error": "Sync script not found"}
    except Exception as e:
        logger.error(f"Sync exception: {e}")
        res = {"error": str(e)}
    finally:
        # Always recompile dataset after sync
        try:
            build_knowledge_data()
        except Exception as e:
            logger.error(f"Rebuild error after sync: {e}")

        duration = round(time.time() - start_time, 2)
        SYNC_STATE["is_syncing"] = False
        SYNC_STATE["last_sync_time"] = time.strftime("%Y-%m-%d %H:%M:%S")
        SYNC_STATE["last_sync_result"] = res
        SYNC_STATE["total_syncs"] += 1
        logger.info(f"=== Sync completed in {duration}s ===")

    return {
        "status": "success",
        "duration": duration,
        "last_sync": SYNC_STATE["last_sync_time"],
        "result": res
    }


def background_sync_worker():
    """Periodic worker syncing Google Drive and feeds every 5 minutes."""
    time.sleep(10) # Initial brief delay
    while True:
        try:
            trigger_sync()
        except Exception as e:
            logger.error(f"Background sync error: {e}")
        time.sleep(300) # 5 minutes interval


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class KBServerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = strip_proxy_prefix(parsed_url.path)

        # API: Health Check
        if path == "/api/health":
            self.send_json(200, {
                "status": "ok",
                "port": PORT,
                "service": "KnowledgeBase Dashboard",
                "kb_root": KB_ROOT_DIR,
                "last_sync": SYNC_STATE["last_sync_time"],
                "is_syncing": SYNC_STATE["is_syncing"]
            })
            return

        # API: Auth Configuration
        if path in ["/api/config/auth", "/api/config/kb", "/api/config"]:
            self.send_json(200, AUTH_CONFIG)
            return

        # API: Sync Status
        if path == "/api/sync/status":
            self.send_json(200, {
                "last_sync": SYNC_STATE["last_sync_time"],
                "is_syncing": SYNC_STATE["is_syncing"],
                "total_syncs": SYNC_STATE["total_syncs"],
                "last_result": SYNC_STATE["last_sync_result"]
            })
            return

        # API: Get compiled notes payload
        if path == "/api/notes":
            self.send_json(200, build_knowledge_data())
            return

        # API: List Raw Inbox Files
        if path == "/api/raw-files":
            raw_files = []
            if os.path.exists(RAW_DIR):
                for root, _, files in os.walk(RAW_DIR):
                    for f in files:
                        if not f.startswith(".") and not f.endswith(".json"):
                            full_p = os.path.join(root, f)
                            rel_p = os.path.relpath(full_p, RAW_DIR).replace("\\", "/")
                            size_kb = round(os.path.getsize(full_p) / 1024, 1)
                            mtime = time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(full_p)))
                            raw_files.append({
                                "name": rel_p,
                                "filename": f,
                                "size_kb": size_kb,
                                "modified": mtime
                            })
            raw_files.sort(key=lambda x: x["modified"], reverse=True)
            self.send_json(200, {"files": raw_files, "total": len(raw_files)})
            return

        # API: Read specific raw file content
        if path.startswith("/api/raw-file"):
            params = parse_qs(parsed_url.query)
            target = safe_join(RAW_DIR, unquote(params.get("name", [""])[0]))
            if not target or not os.path.isfile(target):
                self.send_json(404, {"error": "File not found"})
                return

            try:
                with open(target, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                self.send_json(200, {"filename": os.path.relpath(target, RAW_DIR).replace("\\", "/"), "content": content})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        # Serve static files from dashboard directory
        target_file = safe_join(DASHBOARD_DIR, path.lstrip("/") or "index.html")
        if target_file and os.path.isfile(target_file):
            content_type = "text/plain"
            if target_file.endswith(".html"):
                content_type = "text/html; charset=utf-8"
            elif target_file.endswith(".css"):
                content_type = "text/css; charset=utf-8"
            elif target_file.endswith(".js"):
                content_type = "application/javascript; charset=utf-8"
            elif target_file.endswith(".json"):
                content_type = "application/json"
            elif target_file.endswith(".svg"):
                content_type = "image/svg+xml"
            elif target_file.endswith(".png"):
                content_type = "image/png"
            elif target_file.endswith(".ico"):
                content_type = "image/x-icon"
            elif target_file.endswith(".woff2"):
                content_type = "font/woff2"

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-cache, must-revalidate")
            self.send_cors_headers()
            self.end_headers()
            with open(target_file, "rb") as f:
                self.wfile.write(f.read())
            return

        # Fallback to index.html for SPA routing
        index_file = os.path.join(DASHBOARD_DIR, "index.html")
        if os.path.exists(index_file):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_cors_headers()
            self.end_headers()
            with open(index_file, "rb") as f:
                self.wfile.write(f.read())
            return

        self.send_response(404)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"404 Not Found")

    def do_POST(self):
        path = strip_proxy_prefix(urlparse(self.path).path)

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            req_data = json.loads(body)
        except Exception:
            req_data = {}

        # API: Trigger Google Drive Sync & Feed Ingestion
        if path == "/api/sync":
            threading.Thread(target=trigger_sync, daemon=True).start()
            self.send_json(200, {
                "success": True,
                "message": "Sync initiated in background",
                "status": "running"
            })
            return

        # API: Rebuild Knowledge Base Data
        if path == "/api/rebuild":
            payload = build_knowledge_data()
            self.send_json(200, {"success": True, "message": "Knowledge data rebuilt", "total": payload["totalCount"]})
            return

        # API: Rewrite a note's frontmatter tags in place
        if path == "/api/update-tags":
            target = safe_join(KB_ROOT_DIR, req_data.get("relPath", ""))
            tags = req_data.get("tags", [])
            if not target or not os.path.isfile(target):
                self.send_json(404, {"error": "Note not found"})
                return
            try:
                with open(target, "r", encoding="utf-8") as f:
                    content = f.read()
                with open(target, "w", encoding="utf-8") as f:
                    f.write(set_frontmatter_value(content, "tags", json.dumps(tags)))
                payload = build_knowledge_data()
                self.send_json(200, {"success": True, "message": "Tags updated", "tags": tags})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        # API: Ingest raw note
        if path == "/api/ingest":
            title = req_data.get("title", "").strip()
            category = req_data.get("category", DEFAULT_CATEGORY).strip()
            domain = req_data.get("domain", "").strip()
            doc_type = req_data.get("type", "concept").strip()
            summary = req_data.get("summary", "").strip()
            content = req_data.get("content", "").strip()
            tags = req_data.get("tags", [])
            source_file = req_data.get("source_file", "").strip()

            if not title or not domain:
                self.send_json(400, {"error": "Title and domain/topic are required."})
                return

            slug = re.sub(r"[^a-zA-Z0-9_-]", "-", title.lower()).strip("-")
            slug = re.sub(r"-+", "-", slug)[:60]
            if not slug:
                slug = f"note-{int(time.time())}"

            today_str = time.strftime("%Y-%m-%d")
            tags_json = json.dumps(tags)
            fm_lines = [
                "---",
                f'title: "{title}"',
                f'domain: "{domain}"',
                f'category: "{category}"',
                f'type: "{doc_type}"',
                f'tags: {tags_json}',
                f'created: {today_str}',
                f'updated: {today_str}',
                'status: active',
                f'summary: "{summary}"',
                "related:"
            ]
            related = req_data.get("related", [])
            if isinstance(related, str):
                related = [r.strip() for r in related.split(",") if r.strip()]
            if related:
                for r in related:
                    fm_lines.append(f'  - "{r}"')
            else:
                fm_lines.append(f'  - "[[INDEX]]"')
            fm_lines.append("---")
            fm_lines.append("")
            fm_lines.append(f"# {title}")
            fm_lines.append("")
            fm_lines.append(content or summary)

            file_body = "\n".join(fm_lines)
            target_file = safe_join(KNOWLEDGE_DIR, f"{note_folder(category, domain)}/{slug}.md")
            if not target_file:
                self.send_json(400, {"error": "Invalid domain"})
                return
            os.makedirs(os.path.dirname(target_file), exist_ok=True)

            with open(target_file, "w", encoding="utf-8") as f:
                f.write(file_body)

            updated_payload = build_knowledge_data()

            if source_file and req_data.get("archive_source", False):
                raw_src = os.path.join(RAW_DIR, source_file)
                if os.path.exists(raw_src):
                    archive_dir = os.path.join(KB_ROOT_DIR, "archive")
                    os.makedirs(archive_dir, exist_ok=True)
                    try:
                        shutil.move(raw_src, os.path.join(archive_dir, os.path.basename(raw_src)))
                    except Exception as e:
                        logger.warning(f"Could not move raw file to archive: {e}")

            rel_target = os.path.relpath(target_file, KB_ROOT_DIR).replace("\\", "/")
            logger.info(f"Ingested note: {rel_target}")

            self.send_json(200, {
                "success": True,
                "message": f"Successfully ingested '{title}'",
                "path": rel_target,
                "totalCount": updated_payload["totalCount"]
            })
            return

        self.send_json(404, {"error": "Endpoint not found"})


def run_server():
    # Initial build of data.js
    build_knowledge_data()

    # Start background sync worker thread
    sync_thread = threading.Thread(target=background_sync_worker, daemon=True)
    sync_thread.start()

    server_address = ("0.0.0.0", PORT)
    httpd = ThreadedHTTPServer(server_address, KBServerHandler)
    logger.info(f"Knowledge Base Dashboard Server listening on http://0.0.0.0:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run_server()
