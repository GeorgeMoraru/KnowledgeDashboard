# AGENTS.md - Multi-Agent System Directives

## Project Overview
**KnowledgeDashboard**: High-performance Progressive Web App (PWA) with Google Authentication, Interactive Force-Directed Knowledge Graph, and Automated Google Drive Synchronization for the SmartHub Knowledge Base.

## Core Commands & Verification
- **Run Dashboard Server**: `python3 server.py` (Port 7650)
- **Trigger Google Drive Sync**: `POST /api/sync`
- **Recompile Knowledge Payload**: `POST /api/rebuild`
- **Health Check**: `GET /api/health`

## Architectural Guidelines
1. Keep the UI blazing fast: avoid non-debounced DOM mutations, pause simulation loops when off-canvas, use CSS containment.
2. Zero unvalidated placeholders: built-in credentials must be valid production credentials for seamless offline/cold loads.
3. Keep the content decoupled: notes stay in `KnowledgeBase` repository, dashboard frontend and server stay in `KnowledgeDashboard`.
