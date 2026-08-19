#!/usr/bin/env python3
"""
Knowledge Base Dashboard Server, Sync Engine & Notification Hub
Serves the Knowledge Base Web App / PWA on port 7650 (and via Tailscale /kb route).
Handles data compilation, Google Drive auto-sync, notification tracking, and guest mode security.
"""

import os
import re
import sys
import json
import time
import shutil
import socket
import logging
import argparse
import threading
import subprocess
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
CONFIG_FILE = os.path.join(DASHBOARD_DIR, "config.json")

# Load configuration file if present
config_data = {}
if os.path.isfile(CONFIG_FILE):
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config_data = json.load(f)
    except Exception as e:
        logger.warning(f"Could not load config.json: {e}")

# Resolve KB_ROOT_DIR from env, config, or default fallback
env_kb_dir = os.environ.get("KB_ROOT_DIR") or config_data.get("kb_root")
if env_kb_dir and os.path.exists(env_kb_dir):
    KB_ROOT_DIR = os.path.abspath(env_kb_dir)
elif os.path.exists("/DATA/Work/repos/KnowledgeBase"):
    KB_ROOT_DIR = "/DATA/Work/repos/KnowledgeBase"
elif os.path.exists(os.path.abspath(os.path.join(DASHBOARD_DIR, "..", "KnowledgeBase"))):
    KB_ROOT_DIR = os.path.abspath(os.path.join(DASHBOARD_DIR, "..", "KnowledgeBase"))
else:
    KB_ROOT_DIR = os.path.abspath(os.path.join(DASHBOARD_DIR, ".."))

PORT = int(os.environ.get("KB_PORT") or config_data.get("port") or 7650)
HOST = os.environ.get("KB_HOST") or config_data.get("host") or "0.0.0.0"
PROXY_PREFIX = os.environ.get("PROXY_PREFIX") or config_data.get("proxy_prefix") or "/kb"

def get_effective_knowledge_dir():
    """Returns the directory containing markdown knowledge notes."""
    sub_kb = os.path.join(KB_ROOT_DIR, "knowledge")
    if os.path.isdir(sub_kb):
        return sub_kb
    return KB_ROOT_DIR

KNOWLEDGE_DIR = get_effective_knowledge_dir()
RAW_DIR = os.path.join(KB_ROOT_DIR, "raw")
META_DIR = os.path.join(KB_ROOT_DIR, "meta")
DATA_JS_FILE = os.path.join(DASHBOARD_DIR, "data.js")
ACTIVITY_LOG_FILE = os.path.join(KB_ROOT_DIR, "meta", "activity_log.json")

def set_kb_root(new_path: str):
    """Dynamically switch the active Knowledge Base root."""
    global KB_ROOT_DIR, KNOWLEDGE_DIR, RAW_DIR, META_DIR, ACTIVITY_LOG_FILE
    abs_path = os.path.abspath(new_path)
    if not os.path.isdir(abs_path):
        raise ValueError(f"Knowledge Base directory not found: {new_path}")
    KB_ROOT_DIR = abs_path
    KNOWLEDGE_DIR = get_effective_knowledge_dir()
    RAW_DIR = os.path.join(KB_ROOT_DIR, "raw")
    META_DIR = os.path.join(KB_ROOT_DIR, "meta")
    ACTIVITY_LOG_FILE = os.path.join(META_DIR, "activity_log.json")
    discover_categories()
    logger.info(f"Switched active Knowledge Base root to: {KB_ROOT_DIR} (knowledge dir: {KNOWLEDGE_DIR})")

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

# Base OOB category labels — extensible for any pluggable KB
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

    # Work Topics
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


def load_activity_log():
    """Loads activity / notification log from disk."""
    if os.path.exists(ACTIVITY_LOG_FILE):
        try:
            with open(ACTIVITY_LOG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []


def save_activity_log(activities):
    """Saves activity / notification log to disk, keeping the latest 50 entries."""
    try:
        os.makedirs(os.path.dirname(ACTIVITY_LOG_FILE), exist_ok=True)
        with open(ACTIVITY_LOG_FILE, "w", encoding="utf-8") as f:
            json.dump(activities[:50], f, indent=2)
    except Exception as e:
        logger.warning(f"Could not save activity log: {e}")


def record_activity(event_type, title, summary, source="System", note_id=None, rel_path=None):
    """Appends a new event to the activity notification log."""
    activities = load_activity_log()
    item = {
        "id": f"act_{int(time.time()*1000)}",
        "type": event_type,
        "title": title,
        "summary": summary[:250] if summary else "",
        "source": source,
        "noteId": note_id or "",
        "relPath": rel_path or "",
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "timeAgo": "Just now"
    }
    activities.insert(0, item)
    save_activity_log(activities)
    return item


def initialize_recent_activities_if_empty(notes):
    """Seed activity log from existing recent notes if empty."""
    activities = load_activity_log()
    if not activities and notes:
        sorted_notes = sorted(notes, key=lambda n: n.get("updated") or n.get("created") or "", reverse=True)
        for n in sorted_notes[:10]:
            activities.append({
                "id": f"act_{n['id']}",
                "type": "ingest" if "newsletter" not in n.get("tags", []) else "newsletter",
                "title": n["title"],
                "summary": n.get("summary", ""),
                "source": "Knowledge Base Intake",
                "noteId": n["id"],
                "relPath": n.get("relPath", ""),
                "timestamp": n.get("updated") or n.get("created") or time.strftime("%Y-%m-%d %H:%M:%S"),
                "timeAgo": "Recently"
            })
        save_activity_log(activities)


def discover_categories():
    """Dynamically discovers all categories and subfolders in the active knowledge base."""
    k_dir = get_effective_knowledge_dir()
    discovered = {}

    # Seed with base known categories
    for cat, cfg in CATEGORY_CONFIG.items():
        discovered[cat] = cfg.copy()

    if os.path.isdir(k_dir):
        for entry in os.listdir(k_dir):
            full_p = os.path.join(k_dir, entry)
            if os.path.isdir(full_p) and not entry.startswith(".") and entry not in ["meta", "raw", "node_modules", ".git", ".gemini"]:
                slug_cat = entry.lower()
                if slug_cat not in discovered:
                    display_name = entry.replace("-", " ").replace("_", " ").title()
                    discovered[slug_cat] = {"name": display_name}

    if not discovered:
        discovered[DEFAULT_CATEGORY] = {"name": "General"}

    CATEGORY_CONFIG.clear()
    CATEGORY_CONFIG.update(discovered)
    return discovered


def resolve_topic(domain: str, category: str) -> str:
    """Display name for a domain folder."""
    for key, cfg in TOPIC_CONFIG.items():
        if key.lower() == domain.lower():
            return cfg["name"]
    if domain == category:
        return CATEGORY_CONFIG.get(category, {"name": category.replace("-", " ").replace("_", " ").title()})["name"]
    return domain.replace("-", " ").replace("_", " ").title()


def note_folder(category: str, domain: str) -> str:
    """Folder a note belongs in, relative to knowledge directory."""
    return category if not domain or domain == category else f"{category}/{domain}"


def discover_domains():
    """Domain folders present under knowledge/<category>/."""
    k_dir = get_effective_knowledge_dir()
    cats = discover_categories()
    found = {}

    for cat in cats:
        cat_dir = os.path.join(k_dir, cat)
        if os.path.isdir(cat_dir):
            subdirs = [
                d for d in os.listdir(cat_dir)
                if os.path.isdir(os.path.join(cat_dir, d)) and not d.startswith(".") and d not in ["meta", "raw", "node_modules", ".git", ".gemini"]
            ]
            found[cat] = sorted(subdirs) if subdirs else [cat]
        else:
            found[cat] = [cat]
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
    """Compiles all knowledge markdown notes, taxonomy, and graph dynamically for any connected knowledge base."""
    discover_categories()
    k_dir = get_effective_knowledge_dir()
    notes = []
    domain_set = set()
    topic_domains = {}
    type_set = set()
    tag_set = set()
    category_counts = {cat: 0 for cat in CATEGORY_CONFIG}

    if not os.path.exists(k_dir):
        logger.warning(f"Knowledge directory not found: {k_dir}")
        return {"notes": [], "topics": [], "totalCount": 0}

    for root, dirs, files in os.walk(k_dir):
        # Exclude hidden directories and special folders
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ["meta", "raw", "node_modules", ".git", ".gemini", "__pycache__"]]

        for f in files:
            if not f.endswith(".md"):
                continue

            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, KB_ROOT_DIR).replace("\\", "/")
            rel_to_k = os.path.relpath(full_path, k_dir).replace("\\", "/")
            parts = rel_to_k.split("/")

            try:
                with open(full_path, "r", encoding="utf-8", errors="replace") as file:
                    content = file.read()
            except Exception as e:
                logger.error(f"Error reading file {full_path}: {e}")
                continue

            fm, body = parse_frontmatter(content)

            # Determine category & domain dynamically:
            category = (fm.get("category") or "").strip().lower()
            domain = (fm.get("domain") or "").strip()

            if not category:
                if len(parts) > 1 and parts[0].lower() in CATEGORY_CONFIG:
                    category = parts[0].lower()
                elif len(parts) > 1:
                    category = parts[0].lower()
                else:
                    category = DEFAULT_CATEGORY

            if category not in CATEGORY_CONFIG:
                CATEGORY_CONFIG[category] = {"name": category.replace("-", " ").replace("_", " ").title()}

            if not domain:
                if len(parts) > 2:
                    domain = parts[1]
                elif len(parts) == 2:
                    domain = parts[0]
                else:
                    domain = category

            if domain not in TOPIC_CONFIG:
                TOPIC_CONFIG[domain] = {
                    "name": domain.replace("-", " ").replace("_", " ").title(),
                    "category": category
                }

            title = fm.get("title")
            if not title:
                h1_match = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
                title = h1_match.group(1).strip() if h1_match else f.replace(".md", "").replace("-", " ").title()

            doc_type = fm.get("type", "concept")
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
            note_id = rel_path.replace(".md", "").replace("/", "__").replace("\\", "__")

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
        "kbRoot": KB_ROOT_DIR,
        "kbName": config_data.get("name") or os.path.basename(KB_ROOT_DIR),
        "stats": {
            "totalNotes": len(notes),
            "totalTopics": len(topics_list),
            "totalTypes": len(type_set),
            "totalTags": len(tag_set),
            "totalEdges": len(edges),
            "categoryCounts": category_counts
        },
        "categories": [{"id": cat, "name": cfg.get("name", cat.capitalize())} for cat, cfg in CATEGORY_CONFIG.items()],
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

    # Initialize activity log if needed
    initialize_recent_activities_if_empty(notes)

    # Write out data.js for offline cached execution
    breakdown = " | ".join(f"{CATEGORY_CONFIG.get(cat, {}).get('name', cat.title())}: {count}" for cat, count in category_counts.items() if count > 0)
    js_content = f"/**\n * SmartHub Knowledge Base - Compiled Data Payload\n * Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n * KB Root: {KB_ROOT_DIR}\n * Total Assets: {len(notes)} | Topics: {len(topics_list)} | {breakdown}\n */\nwindow.KB_DATA = {json.dumps(payload, indent=2)};\n"
    with open(DATA_JS_FILE, "w", encoding="utf-8") as f:
        f.write(js_content)

    logger.info(f"Knowledge Base compiled: {len(notes)} notes across {len(topics_list)} topics (KB Root: {KB_ROOT_DIR}).")
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

            # Record sync activity if new items were consumed or articles found
            consumed = res.get("inbox", {}).get("consumed", 0)
            feeds = res.get("feeds", {}).get("new_articles", 0)
            synced = res.get("notebooks", {}).get("new_synced", 0)
            if consumed > 0 or feeds > 0 or synced > 0:
                record_activity(
                    "sync",
                    f"Google Drive Sync ({consumed} inboxed, {feeds} feeds, {synced} synced)",
                    f"Automated ingestion processed {consumed} raw items and {feeds} newsletter articles.",
                    "Google Drive Sync Engine"
                )
        else:
            logger.warning(f"Sync script not found at {sync_script}")
            res = {"error": "Sync script not found"}
    except Exception as e:
        logger.error(f"Sync exception: {e}")
        res = {"error": str(e)}
    finally:
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
    time.sleep(10)
    while True:
        try:
            trigger_sync()
        except Exception as e:
            logger.error(f"Background sync error: {e}")
        time.sleep(300)


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except (AttributeError, OSError):
            pass
        super().server_bind()


class KBServerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email, X-User-Role")

    def send_json(self, status, payload, send_body=True):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_cors_headers()
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def do_HEAD(self):
        self.handle_get(send_body=False)

    def do_GET(self):
        self.handle_get(send_body=True)

    def handle_get(self, send_body=True):
        parsed_url = urlparse(self.path)
        path = strip_proxy_prefix(parsed_url.path)

        # API: Health Check
        if path == "/api/health":
            self.send_json(200, {
                "status": "ok",
                "port": PORT,
                "service": "KnowledgeBase Dashboard",
                "kb_root": KB_ROOT_DIR,
                "kb_name": config_data.get("name") or os.path.basename(KB_ROOT_DIR),
                "knowledge_dir": KNOWLEDGE_DIR,
                "proxy_prefix": PROXY_PREFIX,
                "last_sync": SYNC_STATE["last_sync_time"],
                "is_syncing": SYNC_STATE["is_syncing"]
            }, send_body=send_body)
            return

        # API: Auth Configuration (dynamically retrieved from ProjectsProxi)
        if path in ["/api/config/auth", "/api/config/kb", "/api/config"]:
            cfg = dict(AUTH_CONFIG)
            try:
                req = urllib.request.Request("http://127.0.0.1:8765/api/config/kb", headers={"User-Agent": "KB-Dashboard/1.0"})
                with urllib.request.urlopen(req, timeout=1.5) as resp:
                    if resp.status == 200:
                        remote_cfg = json.loads(resp.read().decode("utf-8"))
                        if remote_cfg and remote_cfg.get("apiKey"):
                            cfg = remote_cfg
            except Exception:
                pass
            self.send_json(200, cfg, send_body=send_body)
            return

        # API: Activity / Ingestion Notifications
        if path in ["/api/notifications", "/api/activity"]:
            activities = load_activity_log()
            self.send_json(200, {
                "notifications": activities,
                "total": len(activities),
                "last_sync": SYNC_STATE["last_sync_time"]
            }, send_body=send_body)
            return

        # API: Sync Status
        if path == "/api/sync/status":
            self.send_json(200, {
                "last_sync": SYNC_STATE["last_sync_time"],
                "is_syncing": SYNC_STATE["is_syncing"],
                "total_syncs": SYNC_STATE["total_syncs"],
                "last_result": SYNC_STATE["last_sync_result"]
            }, send_body=send_body)
            return

        # API: Get compiled notes payload
        if path == "/api/notes":
            self.send_json(200, build_knowledge_data(), send_body=send_body)
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
            self.send_json(200, {"files": raw_files, "total": len(raw_files)}, send_body=send_body)
            return

        # API: Read specific raw file content
        if path.startswith("/api/raw-file"):
            params = parse_qs(parsed_url.query)
            target = safe_join(RAW_DIR, unquote(params.get("name", [""])[0]))
            if not target or not os.path.isfile(target):
                self.send_json(404, {"error": "File not found"}, send_body=send_body)
                return

            try:
                with open(target, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                self.send_json(200, {"filename": os.path.relpath(target, RAW_DIR).replace("\\", "/"), "content": content}, send_body=send_body)
            except Exception as e:
                self.send_json(500, {"error": str(e)}, send_body=send_body)
            return

        # API: Note Git History
        if path.startswith("/api/note-history"):
            params = parse_qs(parsed_url.query)
            rel_path = unquote(params.get("relPath", params.get("path", [""]))[0])
            target = safe_join(KB_ROOT_DIR, rel_path)
            if not target or not os.path.isfile(target):
                self.send_json(404, {"error": "Note not found"}, send_body=send_body)
                return

            try:
                rel_git_path = os.path.relpath(target, KB_ROOT_DIR)
                cmd = ["git", "-C", KB_ROOT_DIR, "log", "-n", "15", "--pretty=format:%h|%an|%ad|%s", "--date=short", "--", rel_git_path]
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                commits = []
                if res.returncode == 0 and res.stdout.strip():
                    for line in res.stdout.strip().split("\n"):
                        parts = line.split("|", 3)
                        if len(parts) == 4:
                            commits.append({
                                "hash": parts[0],
                                "author": parts[1],
                                "date": parts[2],
                                "message": parts[3]
                            })
                self.send_json(200, {"commits": commits, "relPath": rel_path}, send_body=send_body)
            except Exception as e:
                self.send_json(500, {"error": str(e)}, send_body=send_body)
            return

        # API: Note Git Diff / Show revision
        if path.startswith("/api/note-diff"):
            params = parse_qs(parsed_url.query)
            rel_path = unquote(params.get("relPath", params.get("path", [""]))[0])
            commit_hash = unquote(params.get("commit", [""])[0]).strip()
            target = safe_join(KB_ROOT_DIR, rel_path)
            if not target or not os.path.isfile(target):
                self.send_json(404, {"error": "Note not found"}, send_body=send_body)
                return

            try:
                rel_git_path = os.path.relpath(target, KB_ROOT_DIR)
                if commit_hash:
                    cmd = ["git", "-C", KB_ROOT_DIR, "show", f"{commit_hash}:{rel_git_path}"]
                else:
                    cmd = ["git", "-C", KB_ROOT_DIR, "diff", "HEAD", "--", rel_git_path]
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                self.send_json(200, {
                    "content": res.stdout,
                    "commit": commit_hash,
                    "relPath": rel_path
                }, send_body=send_body)
            except Exception as e:
                self.send_json(500, {"error": str(e)}, send_body=send_body)
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
            if send_body:
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
            if send_body:
                with open(index_file, "rb") as f:
                    self.wfile.write(f.read())
            return

        self.send_response(404)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        if send_body:
            self.wfile.write(b"404 Not Found")

    def do_POST(self):
        path = strip_proxy_prefix(urlparse(self.path).path)

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            req_data = json.loads(body)
        except Exception:
            req_data = {}

        # Guest mode restriction check on mutation endpoints
        user_role = self.headers.get("X-User-Role", "").lower()
        is_guest_req = req_data.get("is_guest", False) or user_role == "guest"

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

        # API: Switch active Knowledge Base directory dynamically
        if path == "/api/switch-kb":
            new_path = req_data.get("path", "").strip()
            if not new_path:
                self.send_json(400, {"error": "Path is required"})
                return
            try:
                set_kb_root(new_path)
                payload = build_knowledge_data()
                self.send_json(200, {
                    "success": True,
                    "message": f"Successfully connected to Knowledge Base at '{KB_ROOT_DIR}'",
                    "kbRoot": KB_ROOT_DIR,
                    "totalCount": payload["totalCount"],
                    "categories": payload["categories"],
                    "topics": payload["topics"]
                })
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        # Mutation endpoints: Block if explicitly in guest mode
        if path in ["/api/update-tags", "/api/move-topic", "/api/ingest", "/api/change-category", "/api/delete-note", "/api/delete-topic", "/api/save-note", "/api/create-note"]:
            if is_guest_req:
                self.send_json(403, {
                    "error": "Guest Mode is read-only. Please sign in with Google to edit, create, or delete data.",
                    "code": "GUEST_READ_ONLY"
                })
                return

        # API: Save Note Content / Edit Note
        if path == "/api/save-note":
            rel_path = req_data.get("relPath", "").strip()
            target = safe_join(KB_ROOT_DIR, rel_path)
            if not target or not os.path.isfile(target) or not target.endswith(".md"):
                self.send_json(404, {"error": "Note file not found"})
                return

            raw_body = req_data.get("content", "")
            title = req_data.get("title", "").strip()
            summary = req_data.get("summary", "").strip()
            doc_type = req_data.get("type", "").strip()
            status_val = req_data.get("status", "").strip()

            try:
                with open(target, "r", encoding="utf-8") as f:
                    existing = f.read()

                # If full document with frontmatter was sent
                if raw_body.startswith("---"):
                    new_file_content = raw_body
                    today_str = time.strftime("%Y-%m-%d")
                    new_file_content = set_frontmatter_value(new_file_content, "updated", today_str)
                else:
                    today_str = time.strftime("%Y-%m-%d")
                    existing = set_frontmatter_value(existing, "updated", today_str)
                    if title:
                        existing = set_frontmatter_value(existing, "title", f'"{title}"')
                    if summary:
                        existing = set_frontmatter_value(existing, "summary", f'"{summary}"')
                    if doc_type:
                        existing = set_frontmatter_value(existing, "type", f'"{doc_type}"')
                    if status_val:
                        existing = set_frontmatter_value(existing, "status", f'"{status_val}"')

                    # Replace markdown body
                    fm_match = re.match(r"^---\n(.*?)\n---\n*(.*)$", existing, re.DOTALL)
                    if fm_match:
                        fm_str = fm_match.group(1)
                        new_file_content = f"---\n{fm_str}\n---\n\n{raw_body.strip()}\n"
                    else:
                        new_file_content = raw_body

                with open(target, "w", encoding="utf-8") as f:
                    f.write(new_file_content)

                payload = build_knowledge_data()
                found_note = None
                for n in payload.get("notes", []):
                    if n.get("relPath") == rel_path or os.path.abspath(os.path.join(KB_ROOT_DIR, n.get("relPath", ""))) == os.path.abspath(target):
                        found_note = n
                        break

                record_activity("edit_note", f"Edited note: {title or os.path.basename(target)}", f"Saved changes to {rel_path}", "User Edit")
                logger.info(f"Saved note edits: {rel_path}")
                self.send_json(200, {
                    "success": True,
                    "message": "Note saved successfully",
                    "note": found_note,
                    "relPath": rel_path
                })
            except Exception as e:
                logger.error(f"Error saving note {rel_path}: {e}")
                self.send_json(500, {"error": str(e)})
            return

        # API: Create Quick Note
        if path == "/api/create-note":
            title = req_data.get("title", "").strip()
            category = req_data.get("category", DEFAULT_CATEGORY).strip()
            domain = req_data.get("domain", "").strip()
            doc_type = req_data.get("type", "concept").strip()
            tags = req_data.get("tags", [])
            summary = req_data.get("summary", "").strip()
            content = req_data.get("content", "").strip()

            if not title or not domain:
                self.send_json(400, {"error": "Title and Topic/Domain are required"})
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
                f'summary: "{summary or title}"',
                "related:",
                '  - "[[INDEX]]"',
                "---",
                "",
                f"# {title}",
                "",
                content or f"Notes and concept overview for {title}."
            ]

            file_content = "\n".join(fm_lines) + "\n"
            target_rel = f"knowledge/{category}/{domain}/{slug}.md" if domain != category else f"knowledge/{category}/{slug}.md"
            target_abs = safe_join(KB_ROOT_DIR, target_rel)
            if not target_abs:
                self.send_json(400, {"error": "Invalid destination path"})
                return

            if os.path.exists(target_abs):
                slug = f"{slug}-{int(time.time()) % 10000}"
                target_rel = f"knowledge/{category}/{domain}/{slug}.md" if domain != category else f"knowledge/{category}/{slug}.md"
                target_abs = safe_join(KB_ROOT_DIR, target_rel)

            try:
                os.makedirs(os.path.dirname(target_abs), exist_ok=True)
                with open(target_abs, "w", encoding="utf-8") as f:
                    f.write(file_content)

                payload = build_knowledge_data()
                found_note = None
                for n in payload.get("notes", []):
                    if os.path.abspath(os.path.join(KB_ROOT_DIR, n.get("relPath", ""))) == os.path.abspath(target_abs):
                        found_note = n
                        break

                record_activity("create_note", f"Created note: {title}", f"Created at {target_rel}", "User Action")
                logger.info(f"Created new note: {target_rel}")
                self.send_json(200, {
                    "success": True,
                    "message": f"Successfully created note '{title}'",
                    "note": found_note,
                    "note_id": found_note["id"] if found_note else None,
                    "relPath": target_rel
                })
            except Exception as e:
                logger.error(f"Error creating note {target_abs}: {e}")
                self.send_json(500, {"error": str(e)})
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
                record_activity("tag_update", f"Updated tags on {os.path.basename(target)}", f"New tags: {', '.join(tags)}", "User Edit")
                self.send_json(200, {"success": True, "message": "Tags updated", "tags": tags})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        # API: Move a note to another category/domain folder and update its frontmatter
        if path == "/api/change-category":
            source = safe_join(KB_ROOT_DIR, req_data.get("oldPath", ""))
            destination = safe_join(KB_ROOT_DIR, req_data.get("newPath", ""))
            category = req_data.get("category", "")
            domain = req_data.get("domain", "")
            if not source or not os.path.isfile(source):
                self.send_json(404, {"error": "Note not found"})
                return
            if not destination or category not in CATEGORY_CONFIG:
                self.send_json(400, {"error": "Invalid destination"})
                return
            try:
                with open(source, "r", encoding="utf-8") as f:
                    content = f.read()
                content = set_frontmatter_value(content, "category", f'"{category}"')
                if domain:
                    content = set_frontmatter_value(content, "domain", f'"{domain}"')

                os.makedirs(os.path.dirname(destination), exist_ok=True)
                with open(destination, "w", encoding="utf-8") as f:
                    f.write(content)
                if os.path.abspath(source) != os.path.abspath(destination):
                    os.remove(source)

                payload = build_knowledge_data()
                rel_target = os.path.relpath(destination, KB_ROOT_DIR).replace("\\", "/")
                logger.info(f"Note moved: {req_data.get('oldPath')} -> {rel_target}")
                self.send_json(200, {
                    "success": True,
                    "path": rel_target,
                    "note_id": rel_target.replace(".md", "").replace("/", "__"),
                    "totalCount": payload["totalCount"]
                })
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        # API: Delete Note
        if path == "/api/delete-note":
            rel_path = req_data.get("relPath", "").strip()
            if not rel_path:
                self.send_json(400, {"error": "Missing relPath parameter"})
                return

            target = safe_join(KB_ROOT_DIR, rel_path)
            knowledge_root = os.path.abspath(KNOWLEDGE_DIR)
            if not target or not target.startswith(knowledge_root + os.sep) or not os.path.isfile(target) or not target.endswith(".md"):
                self.send_json(404, {"error": "Note file not found or invalid path"})
                return

            try:
                # Read title from frontmatter for activity log
                title = os.path.basename(target).replace(".md", "")
                try:
                    with open(target, "r", encoding="utf-8", errors="replace") as f:
                        fm, _ = parse_frontmatter(f.read())
                        title = fm.get("title", title)
                except Exception:
                    pass

                os.remove(target)
                payload = build_knowledge_data()
                record_activity("delete_note", f"Deleted note: {title}", f"Removed note at {rel_path}", "User Action")
                logger.info(f"Deleted note: {rel_path}")
                self.send_json(200, {
                    "success": True,
                    "message": f"Successfully deleted note '{title}'",
                    "totalCount": payload["totalCount"]
                })
            except Exception as e:
                logger.error(f"Error deleting note {rel_path}: {e}")
                self.send_json(500, {"error": str(e)})
            return

        # API: Delete Topic (Domain folder & its notes)
        if path == "/api/delete-topic":
            topic_name = req_data.get("topic", "").strip()
            domain = req_data.get("domain", "").strip()
            category = req_data.get("category", "").strip().lower()

            target_dir = None
            # 1. If domain and category are explicitly provided
            if category and domain and category in CATEGORY_CONFIG:
                candidate = safe_join(KNOWLEDGE_DIR, category, domain)
                if candidate and os.path.isdir(candidate):
                    target_dir = candidate

            # 2. If not found by explicit category/domain, search across categories
            if not target_dir and domain:
                for cat in CATEGORY_CONFIG:
                    candidate = safe_join(KNOWLEDGE_DIR, cat, domain)
                    if candidate and os.path.isdir(candidate):
                        target_dir = candidate
                        category = cat
                        break

            # 3. If not found yet, lookup domain by topic_name
            if not target_dir and topic_name:
                for d_key, d_cfg in TOPIC_CONFIG.items():
                    if d_cfg.get("name", "").lower() == topic_name.lower() or d_key.lower() == topic_name.lower():
                        cat = d_cfg.get("category", DEFAULT_CATEGORY)
                        candidate = safe_join(KNOWLEDGE_DIR, cat, d_key)
                        if candidate and os.path.isdir(candidate):
                            target_dir = candidate
                            domain = d_key
                            category = cat
                            break

                if not target_dir:
                    # Search folders matching slugified topic_name
                    slug_topic = re.sub(r"[^a-zA-Z0-9_-]", "-", topic_name.lower()).strip("-")
                    for cat in CATEGORY_CONFIG:
                        cat_dir = os.path.join(KNOWLEDGE_DIR, cat)
                        if os.path.isdir(cat_dir):
                            for d in os.listdir(cat_dir):
                                if d.lower() == slug_topic.lower() or d.lower() == topic_name.lower():
                                    candidate = os.path.join(cat_dir, d)
                                    if os.path.isdir(candidate):
                                        target_dir = candidate
                                        domain = d
                                        category = cat
                                        break
                            if target_dir:
                                break

            if not target_dir:
                self.send_json(404, {"error": f"Topic folder not found for '{topic_name or domain}'"})
                return

            knowledge_root = os.path.abspath(KNOWLEDGE_DIR)
            target_abs = os.path.abspath(target_dir)

            # Safety check: Never delete root KNOWLEDGE_DIR or top-level category directories
            category_roots = [os.path.abspath(os.path.join(KNOWLEDGE_DIR, cat)) for cat in CATEGORY_CONFIG]
            if target_abs == knowledge_root or target_abs in category_roots or not target_abs.startswith(knowledge_root + os.sep):
                self.send_json(400, {"error": "Cannot delete top-level category or root knowledge directory."})
                return

            try:
                # Count files deleted
                deleted_notes_count = sum(len([f for f in files if f.endswith(".md")]) for _, _, files in os.walk(target_abs))
                shutil.rmtree(target_abs)

                # Clean in-memory TOPIC_CONFIG if present
                if domain in TOPIC_CONFIG:
                    TOPIC_CONFIG.pop(domain, None)

                payload = build_knowledge_data()
                display_title = topic_name or (domain.replace("-", " ").replace("_", " ").title())
                record_activity("delete_topic", f"Deleted topic: {display_title}", f"Removed domain '{domain}' and {deleted_notes_count} note(s)", "User Action")
                logger.info(f"Deleted topic folder: {target_abs} ({deleted_notes_count} notes removed)")
                self.send_json(200, {
                    "success": True,
                    "message": f"Successfully deleted topic '{display_title}' and {deleted_notes_count} note(s)",
                    "totalCount": payload["totalCount"]
                })
            except Exception as e:
                logger.error(f"Error deleting topic {target_abs}: {e}")
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
            note_id = rel_target.replace(".md", "").replace("/", "__")
            record_activity("ingest", title, summary or "New synthesized note", "Manual Ingest", note_id, rel_target)
            logger.info(f"Ingested note: {rel_target}")

            self.send_json(200, {
                "success": True,
                "message": f"Successfully ingested '{title}'",
                "path": rel_target,
                "noteId": note_id,
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
    httpd = ThreadedHTTPServer(server_address, KBServerHandler, bind_and_activate=False)
    httpd.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        httpd.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except (AttributeError, OSError):
        pass
    httpd.server_bind()
    httpd.server_activate()
    logger.info(f"Knowledge Base Dashboard Server listening on http://0.0.0.0:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pluggable Knowledge Base Dashboard Server & PWA")
    parser.add_argument("kb_path", nargs="?", default=None, help="Path to Knowledge Base root directory")
    parser.add_argument("--kb-root", dest="kb_root", default=None, help="Path to Knowledge Base root directory")
    parser.add_argument("--port", "-p", dest="port", type=int, default=None, help="Port to listen on (default: 7650)")
    parser.add_argument("--host", "-H", dest="host", default=None, help="Host/IP to bind (default: 0.0.0.0)")
    parser.add_argument("--proxy-prefix", dest="proxy_prefix", default=None, help="Tailscale / reverse proxy prefix (default: /kb)")
    args = parser.parse_args()

    target_kb = args.kb_root or args.kb_path or os.environ.get("KB_ROOT_DIR") or config_data.get("kb_root")
    if target_kb:
        set_kb_root(target_kb)

    if args.port:
        PORT = args.port
    if args.host:
        HOST = args.host
    if args.proxy_prefix:
        PROXY_PREFIX = args.proxy_prefix

    run_server()
