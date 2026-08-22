/**
 * SmartHub Knowledge Base Dashboard - Ultra-Fast Controller
 * Authentic SmartHub UI, Deep Linking & Universal Knowledge Ingestion System
 */

(function () {
  'use strict';

  const state = {
    notes: [],
    topics: [],
    types: [],
    tags: [],
    categories: [], // [{id, name}] from the payload — never hardcoded
    defaultCategory: 'general',
    selectedCategory: 'all', // 'all' or any category id
    selectedTopic: 'All',
    selectedType: 'All',
    selectedTag: null,
    searchQuery: '',
    viewMode: 'card', // 'card' | 'list' | 'graph'
    currentNote: null,
    theme: 'dark',
    activeShareTab: 'link',
    shareData: null,
    taxonomy: {}
  };

  const el = {};

  const AUTO_TOPIC_COLORS = 12;
  const topicColorCache = new Map();

  function slugify(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Colours are declared in styles.css as --topic-<slug> / --cat-<slug>; anything
  // unmapped hashes into --topic-auto-N so a newly created folder or category
  // still gets a stable colour with no code change.
  function autoColor(slug) {
    let hash = 0;
    for (let i = 0; i < slug.length; i++) hash = (hash + slug.charCodeAt(i)) % AUTO_TOPIC_COLORS;
    return cssVar(`--topic-auto-${hash}`);
  }

  function topicColor(domain) {
    if (!domain) return cssVar('--topic-auto-0');
    if (topicColorCache.has(domain)) return topicColorCache.get(domain);

    const slug = slugify(domain);
    const color = cssVar(`--topic-${slug}`) || autoColor(slug);
    topicColorCache.set(domain, color);
    return color;
  }

  function categoryColor(categoryId) {
    const slug = slugify(categoryId);
    return cssVar(`--cat-${slug}`) || autoColor(slug);
  }

  function categoryIds() {
    return state.categories.map(c => c.id);
  }

  function categoryName(categoryId) {
    if (categoryId === 'all') return 'All Knowledge';
    const hit = state.categories.find(c => c.id === categoryId);
    return hit ? hit.name : capitalize(categoryId || '');
  }

  function categoryOptionsHtml(selected) {
    return state.categories
      .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Domain pick-lists come from the server payload (state.taxonomy) so the
  // dashboard never carries a second copy of the topic map.
  function domainsFor(category) {
    return state.taxonomy[category] || [];
  }

  function findDomain(domainId) {
    for (const cat of categoryIds()) {
      const hit = domainsFor(cat).find(d => d.id === domainId);
      if (hit) return { ...hit, category: cat };
    }
    return null;
  }

  // All server traffic goes through KBSource, which knows which knowledge base is
  // connected and prefixes the configured base URL. These wrappers keep the rest of
  // the app free of that concern, and degrade to same-origin if the layer is absent.
  function apiFetch(path, options) {
    if (window.KBSource) return window.KBSource.fetch(path, options);
    return fetch(path, options);
  }

  function postJson(url, body) {
    if (window.KBSource) {
      return window.KBSource.post(url, body).then(data => {
        if (!data || !data.success) throw new Error((data && data.error) || 'Request failed');
        return data;
      });
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(res => res.json())
      .then(data => {
        if (!data || !data.success) throw new Error((data && data.error) || 'Request failed');
        return data;
      });
  }

  /** True when the connected knowledge base accepts writes. */
  function isReadOnly() {
    return !!(window.KBSource && window.KBSource.getStatus().mode !== 'live');
  }

  function readOnlyReason() {
    const status = window.KBSource ? window.KBSource.getStatus() : null;
    if (!status) return 'This knowledge base is read-only.';
    if (status.mode === 'cache') return 'Offline — showing a cached copy. Reconnect to the knowledge base server to make changes.';
    if (status.mode === 'snapshot') return 'This knowledge base is a static snapshot. Connect to a knowledge base server to make changes.';
    if (!status.mode) return 'No knowledge base connected.';
    return 'This knowledge base is read-only.';
  }

  /** Blocks a mutation when the source cannot accept writes. Returns true if blocked. */
  function blockIfReadOnly() {
    if (!isReadOnly()) return false;
    if (window.showToast) window.showToast(readOnlyReason(), 4500);
    return true;
  }

  function init() {
    cacheDom();
    initTheme();
    bindEvents();
    loadData();
  }

  function cacheDom() {
    el.searchInput = document.getElementById('searchInput');
    el.searchModePill = document.getElementById('searchModePill');
    el.searchClear = document.getElementById('searchClear');
    el.topicScopeSelect = document.getElementById('topicScopeSelect');
    el.topicFacetList = document.getElementById('topicFacetList');
    el.topicTotalCount = document.getElementById('topicTotalCount');
    el.categoryBar = document.getElementById('categoryBar');
    el.topicTabs = document.getElementById('topicTabs');
    el.typeFacetList = document.getElementById('typeFacetList');
    el.tagFacetList = document.getElementById('tagFacetList');

    el.metricsGrid = document.getElementById('metricsGrid');

    el.toggleLayoutBtn = document.getElementById('toggleLayoutBtn');
    el.layoutToggleIcon = document.getElementById('layoutToggleIcon');
    el.layoutToggleLabel = document.getElementById('layoutToggleLabel');
    el.viewGraphBtn = document.getElementById('viewGraphBtn');

    el.cardsView = document.getElementById('cardsView');
    el.listView = document.getElementById('listView');
    el.graphView = document.getElementById('graphView');
    el.resultsCount = document.getElementById('resultsCount');
    el.activeFilters = document.getElementById('activeFilters');
    el.shareTopicBtn = document.getElementById('shareTopicBtn');
    el.shareTopicBtnLabel = document.getElementById('shareTopicBtnLabel');
    el.deleteTopicBtn = document.getElementById('deleteTopicBtn');
    el.deleteTopicBtnLabel = document.getElementById('deleteTopicBtnLabel');

    // Note Modal & Drawer Panes
    el.modalBackdrop = document.getElementById('noteModal');
    el.modalClose = document.getElementById('modalClose');
    el.modalTitle = document.getElementById('modalTitle');
    el.modalPath = document.getElementById('modalPath');
    el.modalMeta = document.getElementById('modalMeta');
    el.modalTagEditor = document.getElementById('modalTagEditor');
    el.modalBody = document.getElementById('modalBody');
    el.modalBodyEdit = document.getElementById('modalBodyEdit');
    el.modalBodyHistory = document.getElementById('modalBodyHistory');
    el.modalViewFooter = document.getElementById('modalViewFooter');
    el.modalRelated = document.getElementById('modalRelated');
    el.copyPathBtn = document.getElementById('copyPathBtn');
    el.modalShareBtn = document.getElementById('modalShareBtn');
    el.modalDeleteHeaderBtn = document.getElementById('modalDeleteHeaderBtn');

    // Note Editor Fields
    el.noteEditTitle = document.getElementById('noteEditTitle');
    el.noteEditSummary = document.getElementById('noteEditSummary');
    el.noteEditType = document.getElementById('noteEditType');
    el.noteEditContent = document.getElementById('noteEditContent');
    el.noteEditWordCount = document.getElementById('noteEditWordCount');
    el.historyCommitsList = document.getElementById('historyCommitsList');
    el.historyDiffViewer = document.getElementById('historyDiffViewer');

    // Quick Note Modal Elements
    el.quickNoteModal = document.getElementById('quickNoteModal');
    el.quickNoteTitle = document.getElementById('quickNoteTitle');
    el.quickNoteCategory = document.getElementById('quickNoteCategory');
    el.quickNoteDomain = document.getElementById('quickNoteDomain');
    el.quickNoteType = document.getElementById('quickNoteType');
    el.quickNoteTags = document.getElementById('quickNoteTags');
    el.quickNoteSummary = document.getElementById('quickNoteSummary');
    el.quickNoteContent = document.getElementById('quickNoteContent');

    // Confirm Modal Elements
    el.confirmModal = document.getElementById('confirmModal');
    el.confirmModalClose = document.getElementById('confirmModalClose');
    el.confirmModalTitle = document.getElementById('confirmModalTitle');
    el.confirmModalBadge = document.getElementById('confirmModalBadge');
    el.confirmModalMessage = document.getElementById('confirmModalMessage');
    el.confirmModalPreview = document.getElementById('confirmModalPreview');
    el.confirmModalSubmitBtn = document.getElementById('confirmModalSubmitBtn');

    // Share Modal Elements
    el.shareModal = document.getElementById('shareModal');
    el.shareModalClose = document.getElementById('shareModalClose');
    el.shareModalTitle = document.getElementById('shareModalTitle');
    el.shareModalSubtitle = document.getElementById('shareModalSubtitle');
    el.shareWebLinkInput = document.getElementById('shareWebLinkInput');
    el.shareMarkdownPreview = document.getElementById('shareMarkdownPreview');
    el.sharePromptPreview = document.getElementById('sharePromptPreview');
    el.shareJsonPreview = document.getElementById('shareJsonPreview');

    // Toast Feedback
    el.toast = document.getElementById('shToast');

    el.totalNotesStat = document.getElementById('totalNotesStat');
    el.activeBreadcrumb = document.getElementById('activeBreadcrumb');

    el.themeIcon = document.getElementById('themeIcon');
    el.themeLabel = document.getElementById('themeLabel');

    el.graphZoomIn = document.getElementById('graphZoomIn');
    el.graphZoomOut = document.getElementById('graphZoomOut');
    el.graphCenter = document.getElementById('graphCenter');
    el.graphPhysics = document.getElementById('graphPhysics');
    el.graphDetailsCard = document.getElementById('graphDetailsCard');
  }

  function initTheme() {
    state.theme = localStorage.getItem('sh_kb_theme') || 'dark';
    applyTheme(state.theme);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (el.themeIcon) el.themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
    if (el.themeLabel) el.themeLabel.textContent = theme === 'dark' ? 'Dark' : 'Light';
    localStorage.setItem('sh_kb_theme', theme);
    // The PWA chrome (status bar / title bar) is painted from this meta tag, so
    // it has to follow the theme or the installed app keeps a dark bar in light mode.
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      const appBg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-topbar').trim();
      if (appBg) themeMeta.setAttribute('content', appBg);
    }
    // Each theme declares its own taxonomy and canvas colours, so every value
    // resolved from CSS has to be dropped and read again.
    topicColorCache.clear();
    if (window.graphEngine) window.graphEngine.refreshPalette();
  }

  window.toggleTheme = function () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(state.theme);
    if (state.notes.length) {
      renderCategoryNav();
      renderMetricCards();
      render();
      pushGraphData();
    }
  };

  let deepLinkApplied = false;

  function showAppLoading(title = 'Logging in…', subtitle = 'Connecting to Knowledge Base') {
    const screen = document.getElementById('appLoadingScreen');
    const titleEl = document.getElementById('appLoadingTitle');
    const subEl = document.getElementById('appLoadingSubtitle');
    if (titleEl && title) titleEl.textContent = title;
    if (subEl && subtitle) subEl.textContent = subtitle;
    if (screen) {
      screen.classList.remove('hidden');
      screen.style.opacity = '1';
    }
  }

  function hideAppLoading() {
    const screen = document.getElementById('appLoadingScreen');
    if (screen) {
      screen.style.opacity = '0';
      setTimeout(() => {
        screen.classList.add('hidden');
      }, 280);
    }
  }

  async function loadData() {
    showAppLoading('Loading…', 'Connecting to your Knowledge Base');
    try {
      if (!window.KB_DATA && window.KBSource) {
        const result = await window.KBSource.loadPayload();
        if (result.payload) {
          window.KB_DATA = result.payload;
          if (result.offline && window.showToast) {
            window.showToast('Offline — showing the last cached copy of this knowledge base.', 5000);
          }
        }
      }
      updateSourceUI();

      if (!window.KB_DATA || !window.KB_DATA.notes || window.KB_DATA.notes.length === 0) {
        document.body.classList.add('kb-empty');
        if (el.topicTotalCount) el.topicTotalCount.textContent = '0';
        if (el.totalNotesStat) el.totalNotesStat.textContent = '0';
        return;
      }
      document.body.classList.remove('kb-empty');

      state.notes = (window.KB_DATA.notes || []).map(n => ({
        ...n,
        tags: [...(n.tags || [])],
        _searchStr: `${n.title} ${n.summary} ${(n.tags || []).join(' ')} ${n.topic} ${n.type} ${n.category}`.toLowerCase()
      }));

      state.topics = window.KB_DATA.topics || [];
      state.types = window.KB_DATA.types || [];
      state.tags = window.KB_DATA.tags || [];
      state.taxonomy = window.KB_DATA.taxonomy || {};
      state.categories = window.KB_DATA.categories || [];
      state.defaultCategory = window.KB_DATA.defaultCategory || (state.categories[0] && state.categories[0].id) || 'general';

      if (el.totalNotesStat) el.totalNotesStat.textContent = state.notes.length;

      renderCategoryNav();
      renderFacets();
      initGraph();

      // Deep-link only on first load — a reload after a write must not reopen a stale note id
      if (!deepLinkApplied) {
        deepLinkApplied = true;
        parseUrlDeepLink();
      }

      setViewMode(state.viewMode || 'card');
      render();
    } finally {
      hideAppLoading();
    }
  }

  // Parse deep-link query parameters on page load
  function parseUrlDeepLink() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const hash = window.location.hash.replace(/^#/, '');

      let noteIdToOpen = urlParams.get('note') || urlParams.get('id');
      if (!noteIdToOpen && hash.startsWith('note=')) {
        noteIdToOpen = hash.substring(5);
      } else if (!noteIdToOpen && hash.startsWith('note/')) {
        noteIdToOpen = hash.substring(5);
      }

      const catParam = urlParams.get('cat') || urlParams.get('category');
      const topicParam = urlParams.get('topic');
      const typeParam = urlParams.get('type');
      const tagParam = urlParams.get('tag');
      const queryParam = urlParams.get('q') || urlParams.get('query') || urlParams.get('search');

      const cat = catParam && catParam.toLowerCase();
      if (cat && (cat === 'all' || categoryIds().includes(cat))) {
        state.selectedCategory = cat;
      }
      if (topicParam && state.topics.includes(topicParam)) {
        state.selectedTopic = topicParam;
      }
      if (typeParam && state.types.includes(typeParam)) {
        state.selectedType = typeParam;
      }
      if (tagParam && state.tags.includes(tagParam)) {
        state.selectedTag = tagParam;
      }
      if (queryParam) {
        state.searchQuery = queryParam;
        if (el.searchInput) el.searchInput.value = queryParam;
        if (el.searchClear) el.searchClear.classList.remove('hidden');
      }

      if (noteIdToOpen) {
        setTimeout(() => {
          openNote(noteIdToOpen);
        }, 50);
      }
    } catch (e) {
      console.warn('[URL Deep Link]', e);
    }
  }

  // Update browser address bar dynamically for shareable URLs
  function syncBrowserUrl() {
    try {
      const params = new URLSearchParams();
      if (state.currentNote) {
        params.set('note', state.currentNote.id);
      } else {
        if (state.selectedCategory && state.selectedCategory !== 'all') {
          params.set('cat', state.selectedCategory);
        }
        if (state.selectedTopic && state.selectedTopic !== 'All') {
          params.set('topic', state.selectedTopic);
        }
        if (state.selectedType && state.selectedType !== 'All') {
          params.set('type', state.selectedType);
        }
        if (state.selectedTag) {
          params.set('tag', state.selectedTag);
        }
        if (state.searchQuery) {
          params.set('q', state.searchQuery);
        }
      }

      const queryString = params.toString();
      const newUrl = queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    } catch (e) {
      // Ignored for local restricted file:// environments
    }
  }

  function getBaseUrl() {
    const loc = window.location;
    if (loc.protocol === 'file:') {
      return loc.href.split('?')[0].split('#')[0];
    }
    return loc.origin + loc.pathname;
  }

  // Sidebar nav and metric cards are built from the payload categories, so a new
  // top-level category shows up everywhere without touching markup or CSS.
  function renderCategoryNav() {
    if (!el.categoryBar) return;

    const item = (id, label) => `
      <button class="nav-cat-item" data-cat="${id}" onclick="window.selectCategory('${id}')" style="--cat-accent:${categoryColor(id)};">
        <div class="nav-cat-left">
          <span class="cat-dot"></span>
          <span>${escapeHtml(label)}</span>
        </div>
        <span class="nav-cat-badge" data-count="${id}">0</span>
      </button>
    `;

    el.categoryBar.innerHTML = item('all', 'All Knowledge') +
      state.categories.map(c => item(c.id, c.name)).join('');
  }

  function renderMetricCards() {
    if (!el.metricsGrid) return;

    const totalCard = `
      <div class="metric-card metric-primary" onclick="window.selectCategory('all')">
        <div class="metric-header">
          <span class="metric-title">Total Knowledge Assets</span>
          <div class="metric-icon-box">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            </svg>
          </div>
        </div>
        <div class="metric-body">
          <div class="metric-value" data-metric="all">—</div>
          <div class="metric-trend trend-up">
            <span class="trend-label">Indexed, linked & searchable</span>
          </div>
        </div>
      </div>
    `;

    const categoryCards = state.categories.map(c => {
      const domains = domainsFor(c.id).map(d => d.name);
      const caption = domains.length > 1 ? domains.slice(0, 3).join(' • ') : (domains[0] || c.name);
      return `
        <div class="metric-card" onclick="window.selectCategory('${c.id}')" style="--cat-accent:${categoryColor(c.id)};">
          <div class="metric-header">
            <span class="metric-title">${escapeHtml(c.name)}</span>
            <div class="metric-icon-box">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                <polyline points="2 17 12 22 22 17"></polyline>
                <polyline points="2 12 12 17 22 12"></polyline>
              </svg>
            </div>
          </div>
          <div class="metric-body">
            <div class="metric-value" data-metric="${c.id}">—</div>
            <div class="metric-trend">
              <span class="badge-pill">${escapeHtml(caption)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    el.metricsGrid.innerHTML = totalCard + categoryCards;
  }

  function renderFacets() {
    const q = state.searchQuery.toLowerCase();

    // Notes filtered by search query
    const searchFilteredNotes = q 
      ? state.notes.filter(n => n._searchStr.includes(q))
      : state.notes;

    // 0. Update Category Bar Button Counts & Active States
    const catCounts = { all: searchFilteredNotes.length };
    state.categories.forEach(c => {
      catCounts[c.id] = searchFilteredNotes.filter(n => n.category === c.id).length;
    });

    const topicCounts = {};
    searchFilteredNotes.forEach(n => {
      if (n.topic) {
        topicCounts[n.topic] = (topicCounts[n.topic] || 0) + 1;
      }
    });

    if (el.categoryBar) {
      el.categoryBar.querySelectorAll('.nav-cat-item').forEach(btn => {
        const id = btn.dataset.cat;
        btn.classList.toggle('active', id === state.selectedCategory);
        const badge = btn.querySelector('.nav-cat-badge');
        if (badge) badge.textContent = catCounts[id] || 0;
      });
    }

    if (el.metricsGrid) {
      el.metricsGrid.querySelectorAll('.metric-value').forEach(box => {
        const id = box.dataset.metric;
        box.textContent = id === 'all' ? state.notes.length : (catCounts[id] || 0);
      });
    }

    if (el.activeBreadcrumb) {
      el.activeBreadcrumb.textContent = state.selectedTopic !== 'All'
        ? `${categoryName(state.selectedCategory)} / ${state.selectedTopic}`
        : categoryName(state.selectedCategory);
    }

    // Notes filtered by Category
    const catFilteredNotes = searchFilteredNotes.filter(n => {
      if (state.selectedCategory !== 'all' && n.category !== state.selectedCategory) return false;
      return true;
    });

    // Notes filtered by search query AND category AND topic
    const topicFilteredNotes = catFilteredNotes.filter(n => {
      if (state.selectedTopic !== 'All') {
        const tLower = state.selectedTopic.toLowerCase();
        const noteTopic = (n.topic || '').toLowerCase();
        const noteDomain = (n.domain || '').toLowerCase();
        const noteTopicName = (n.topicName || '').toLowerCase();
        if (noteTopic !== tLower && noteDomain !== tLower && noteTopicName !== tLower) return false;
      }
      return true;
    });

    // 1. Dynamic Topic Dropdown Selectors (both sidebar and controls ribbon)
    const allTopics = Array.from(new Set(state.notes.map(n => n.topic).filter(Boolean))).sort();
    let topicOptionsHtml = `<option value="All">All Topics (${catFilteredNotes.length})</option>`;
    allTopics.forEach(t => {
      const tLower = t.toLowerCase();
      const countInCat = catFilteredNotes.filter(n => (n.topic || '').toLowerCase() === tLower || (n.domain || '').toLowerCase() === tLower || (n.topicName || '').toLowerCase() === tLower).length;
      const countTotal = searchFilteredNotes.filter(n => (n.topic || '').toLowerCase() === tLower || (n.domain || '').toLowerCase() === tLower || (n.topicName || '').toLowerCase() === tLower).length;
      const isSelected = (state.selectedTopic || '').toLowerCase() === tLower;
      const displayLabel = state.selectedCategory === 'all' ? `${t} (${countTotal})` : (countInCat > 0 ? `${t} (${countInCat})` : `${t} (${countTotal})`);
      topicOptionsHtml += `<option value="${escapeHtml(t)}"${isSelected ? ' selected' : ''}>${escapeHtml(displayLabel)}</option>`;
    });

    const topicSelectDropdown = document.getElementById('topicSelectDropdown');
    if (topicSelectDropdown) {
      topicSelectDropdown.innerHTML = topicOptionsHtml;
      topicSelectDropdown.value = state.selectedTopic;
    }

    const sidebarTopicSelect = document.getElementById('sidebarTopicSelect');
    if (sidebarTopicSelect) {
      sidebarTopicSelect.innerHTML = topicOptionsHtml;
      sidebarTopicSelect.value = state.selectedTopic;
    }

    if (el.topicScopeSelect) {
      el.topicScopeSelect.innerHTML = topicOptionsHtml;
      el.topicScopeSelect.value = state.selectedTopic;
    }

    if (el.topicTotalCount) {
      el.topicTotalCount.textContent = allTopics.length;
    }

    // Dynamic Graph Legend — the 8 biggest topics, then an explicit count of
    // what was left out so the legend never silently under-reports the graph.
    const graphLegend = document.getElementById('graphLegend');
    if (graphLegend) {
      const LEGEND_LIMIT = 8;
      const ranked = state.topics
        .slice()
        .sort((a, b) => (topicCounts[b] || 0) - (topicCounts[a] || 0));
      const shown = ranked.slice(0, LEGEND_LIMIT);
      const hidden = ranked.length - shown.length;

      const itemsHtml = shown.map(t => {
        const sample = state.notes.find(n => n.topic === t);
        const col = topicColor(sample && sample.domain);
        const count = topicCounts[t] || 0;
        const active = state.selectedTopic === t ? ' active' : '';
        return `
          <div class="sh-graph-legend-item${active}" onclick="window.selectTopic('${escapeHtml(t)}'); if(typeof showGraphTopicCard === 'function') showGraphTopicCard('${escapeHtml(t)}');" style="--topic-accent:${col};" title="${escapeHtml(t)} — ${count} notes">
            <span class="legend-dot"></span>
            <span class="legend-label">${escapeHtml(t)}</span>
            <span class="legend-count">${count}</span>
          </div>
        `;
      }).join('');

      graphLegend.innerHTML = shown.length
        ? `<div class="graph-legend-title">Topics</div>${itemsHtml}` +
          (hidden > 0 ? `<div class="graph-legend-more">+${hidden} more not shown</div>` : '')
        : '';
    }

    // 2. Type Facets
    if (el.typeFacetList) {
      const typeCounts = {};
      topicFilteredNotes.forEach(n => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });

      let typeHtml = `
        <div class="sh-facet-item ${state.selectedType === 'All' ? 'active' : ''}" onclick="window.selectType('All')">
          <div class="sh-facet-label-group">
            <input type="radio" class="sh-facet-checkbox" name="facet_type" ${state.selectedType === 'All' ? 'checked' : ''}>
            <span>All Types</span>
          </div>
          <span class="sh-facet-count">${topicFilteredNotes.length}</span>
        </div>
      `;

      state.types.forEach(tp => {
        const count = typeCounts[tp] || 0;
        const isActive = state.selectedType === tp;
        typeHtml += `
          <div class="sh-facet-item ${isActive ? 'active' : ''}" onclick="window.selectType('${escapeHtml(tp)}')">
            <div class="sh-facet-label-group">
              <input type="radio" class="sh-facet-checkbox" name="facet_type" ${isActive ? 'checked' : ''}>
              <span>${capitalize(tp)}</span>
            </div>
            <span class="sh-facet-count">${count}</span>
          </div>
        `;
      });
      el.typeFacetList.innerHTML = typeHtml;
    }

    // 3. Tag Cloud Facets
    if (el.tagFacetList) {
      const tagCounts = {};
      topicFilteredNotes.forEach(n => {
        n.tags.forEach(tg => { tagCounts[tg] = (tagCounts[tg] || 0) + 1; });
      });

      const sortedTags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]).slice(0, 14);
      el.tagFacetList.innerHTML = sortedTags.map(tg => `
        <span class="sh-facet-tag ${state.selectedTag === tg ? 'active' : ''}" onclick="window.toggleTag('${escapeHtml(tg)}')">
          #${escapeHtml(tg)} (${tagCounts[tg]})
        </span>
      `).join('');
    }

    // Update Share Topic button label
    if (el.shareTopicBtnLabel) {
      el.shareTopicBtnLabel.textContent = state.selectedTopic === 'All' ? 'Share All Topics' : `Share ${state.selectedTopic}`;
    }

    // Update Delete Topic button visibility and label
    if (el.deleteTopicBtn) {
      const hasTopic = state.selectedTopic && state.selectedTopic !== 'All';
      el.deleteTopicBtn.classList.toggle('hidden', !hasTopic);
      if (el.deleteTopicBtnLabel && hasTopic) {
        el.deleteTopicBtnLabel.textContent = `Delete ${state.selectedTopic}`;
      }
    }
  }

  function initGraph() {
    if (!el.graphView) return;
    window.graphEngine = new KnowledgeGraph('graphView', {
      onNodeClick: (node) => {
        if (!node) {
          if (el.graphDetailsCard) el.graphDetailsCard.classList.remove('active');
          return;
        }
        if (node.isHub) {
          window.selectTopic(node.topic);
          showGraphTopicCard(node.topic || node.name);
        } else {
          showGraphNodeCard(node);
        }
      },
      onNodeDoubleClick: (node) => {
        if (node) {
          if (node.isHub) {
            window.selectTopic(node.topic || node.name);
            window.switchView(state.currentLayout || 'card');
          } else if (node.noteId) {
            openNote(node.noteId);
          }
        }
      }
    });

    pushGraphData();
  }

  // Node colours are resolved from the CSS taxonomy palette, so they are stamped
  // here rather than shipped in the payload — and restamped on theme change.
  function pushGraphData() {
    if (!window.graphEngine) return;
    const graph = window.KB_DATA.graph || { nodes: [], edges: [] };
    window.graphEngine.setData({
      ...window.KB_DATA,
      graph: {
        nodes: graph.nodes.map(n => ({ ...n, color: topicColor(n.domain) })),
        edges: graph.edges
      }
    });
  }

  function showGraphTopicCard(topicName) {
    if (!el.graphDetailsCard) return;
    const tLower = (topicName || '').toLowerCase();
    const topicNotes = state.notes.filter(n => 
      (n.topic || '').toLowerCase() === tLower || 
      (n.domain || '').toLowerCase() === tLower || 
      (n.topicName || '').toLowerCase() === tLower
    );
    const sample = topicNotes[0];
    const col = topicColor(sample && sample.domain);

    const notesListHtml = topicNotes.slice(0, 8).map(n => `
      <div class="graph-topic-note-item" onclick="window.openNoteById('${n.id}')" title="${escapeHtml(n.title)}">
        <span class="graph-topic-note-title">📄 ${escapeHtml(n.title)}</span>
        <span class="sh-type-pill">${escapeHtml(n.type || 'note')}</span>
      </div>
    `).join('');

    const moreHtml = topicNotes.length > 8 
      ? `<div class="graph-topic-more">+${topicNotes.length - 8} more notes</div>` 
      : '';

    el.graphDetailsCard.innerHTML = `
      <div class="graph-detail-title">${escapeHtml(topicName)}</div>
      <div class="graph-detail-badges">
        <span class="sh-topic-badge" style="--topic-accent:${col};">${topicNotes.length} Notes</span>
        <span class="sh-type-pill">Topic Hub</span>
      </div>
      <p class="graph-detail-summary">Topic cluster containing <strong>${topicNotes.length}</strong> knowledge assets.</p>
      <div class="graph-topic-notes-list">
        ${notesListHtml || '<div style="color:var(--text-muted); font-size:12px;">No notes found</div>'}
        ${moreHtml}
      </div>
      <div class="graph-detail-actions">
        <button class="btn-node-open" onclick="window.selectTopic('${escapeHtml(topicName)}'); window.switchView('card');">View Notes ↗</button>
        <button class="btn-node-share" onclick="window.openShareModal('topic', '${escapeHtml(topicName)}')" title="Share & Ingest Topic">🔗</button>
      </div>
    `;
    el.graphDetailsCard.classList.add('active');
  }

  function showGraphNodeCard(node) {
    if (!el.graphDetailsCard) return;
    const note = state.notes.find(n => n.id === node.noteId);
    if (!note) return;

    el.graphDetailsCard.innerHTML = `
      <div class="graph-detail-title">${escapeHtml(note.title)}</div>
      <div class="graph-detail-badges">
        <span class="sh-topic-badge" style="--topic-accent:${topicColor(note.domain)};">${note.topic}</span>
        <span class="sh-type-pill">${note.type}</span>
      </div>
      <p class="graph-detail-summary">${escapeHtml(note.summary)}</p>
      <div class="graph-detail-actions">
        <button class="btn-node-open" onclick="window.openNoteById('${note.id}')">Open Note</button>
        <button class="btn-node-share" onclick="window.openShareModal('note', '${note.id}')" title="Share & Ingest Note">🔗</button>
      </div>
    `;
    el.graphDetailsCard.classList.add('active');
  }

  function bindEvents() {
    // Search input (instant debounced)
    let searchTimer = null;
    if (el.searchInput) {
      el.searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (el.searchClear) {
          el.searchClear.classList.toggle('hidden', !val);
        }
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          state.searchQuery = val.trim();
          syncBrowserUrl();
          render(true);
        }, 40);
      });
    }

    if (el.searchClear) {
      el.searchClear.addEventListener('click', () => {
        state.searchQuery = '';
        el.searchInput.value = '';
        el.searchClear.classList.add('hidden');
        el.searchInput.focus();
        syncBrowserUrl();
        render();
      });
    }

    // Top Navigation Tabs
    if (el.topicTabs) {
      el.topicTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.sh-nav-tab');
        if (!tab) return;
        window.selectTopic(tab.dataset.topic);
      });
    }

    // Rename dialog: live filename preview, Enter submits
    const renameTitleInput = document.getElementById('renameNoteTitle');
    const renameToggle = document.getElementById('renameNoteFileToggle');
    if (renameTitleInput) {
      renameTitleInput.addEventListener('input', updateRenamePreview);
      renameTitleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          window.submitRenameNote();
        }
      });
    }
    if (renameToggle) renameToggle.addEventListener('change', updateRenamePreview);

    const renameBackdrop = document.getElementById('renameNoteModal');
    if (renameBackdrop) {
      renameBackdrop.addEventListener('click', (e) => {
        if (e.target === renameBackdrop) window.closeRenameNoteModal();
      });
    }

    // Keyboard shortcut: '/' focuses search, 'Escape' closes modal/search
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== el.searchInput && !document.activeElement.matches('input, textarea') && !state.currentNote && !isShareModalOpen() && !isConfirmModalOpen() && !isQuickNoteModalOpen()) {
        e.preventDefault();
        el.searchInput.focus();
      } else if (e.key === 'Escape') {
        const notifDrawer = document.getElementById('notifDrawer');
        if (notifDrawer && notifDrawer.classList.contains('open')) {
          window.closeNotificationDrawer();
        } else if (isRenameModalOpen()) {
          window.closeRenameNoteModal();
        } else if (isConfirmModalOpen()) {
          window.closeConfirmModal();
        } else if (isQuickNoteModalOpen()) {
          window.closeQuickNoteModal();
        } else if (isShareModalOpen()) {
          window.closeShareModal();
        } else if (state.currentNote) {
          closeModal();
        } else if (state.searchQuery) {
          state.searchQuery = '';
          el.searchInput.value = '';
          if (el.searchClear) el.searchClear.classList.add('hidden');
          syncBrowserUrl();
          render();
        }
      }
    });

    // Editor tab indentation support
    const handleTextareaTab = (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = e.target.selectionStart;
        const end = e.target.selectionEnd;
        e.target.value = e.target.value.substring(0, start) + '  ' + e.target.value.substring(end);
        e.target.selectionStart = e.target.selectionEnd = start + 2;
        updateEditorWordCount();
      }
    };
    if (el.noteEditContent) {
      el.noteEditContent.addEventListener('keydown', handleTextareaTab);
      el.noteEditContent.addEventListener('input', updateEditorWordCount);
    }
    if (el.quickNoteContent) {
      el.quickNoteContent.addEventListener('keydown', handleTextareaTab);
    }

    // Graph Controls
    if (el.graphZoomIn) el.graphZoomIn.addEventListener('click', () => window.graphEngine && window.graphEngine.zoomIn());
    if (el.graphZoomOut) el.graphZoomOut.addEventListener('click', () => window.graphEngine && window.graphEngine.zoomOut());
    if (el.graphCenter) el.graphCenter.addEventListener('click', () => window.graphEngine && window.graphEngine.centerGraph());
    if (el.graphPhysics) el.graphPhysics.addEventListener('click', () => window.graphEngine && window.graphEngine.togglePhysics());

    // Modal Close
    if (el.modalClose) el.modalClose.addEventListener('click', closeModal);
    if (el.modalBackdrop) {
      el.modalBackdrop.addEventListener('click', (e) => {
        if (e.target === el.modalBackdrop) closeModal();
      });
    }

    // Quick Note Modal Backdrop click
    if (el.quickNoteModal) {
      el.quickNoteModal.addEventListener('click', (e) => {
        if (e.target === el.quickNoteModal) window.closeQuickNoteModal();
      });
    }

    // Confirm Modal events
    if (el.confirmModalClose) el.confirmModalClose.addEventListener('click', window.closeConfirmModal);
    if (el.confirmModal) {
      el.confirmModal.addEventListener('click', (e) => {
        if (e.target === el.confirmModal) window.closeConfirmModal();
      });
    }
    if (el.confirmModalSubmitBtn) {
      el.confirmModalSubmitBtn.addEventListener('click', () => {
        if (typeof confirmCallback === 'function') {
          confirmCallback();
        }
      });
    }

    // Copy Relative Path
    if (el.copyPathBtn) {
      el.copyPathBtn.addEventListener('click', () => {
        if (state.currentNote) {
          navigator.clipboard.writeText(state.currentNote.relPath).then(() => {
            window.showToast(`Copied relative path: ${state.currentNote.relPath}`);
          });
        }
      });
    }

    // Note Modal Title click -> quick edit
    if (el.modalTitle) {
      el.modalTitle.setAttribute('title', 'Click to edit title & note content');
      el.modalTitle.addEventListener('click', () => {
        if (state.currentNote && !isReadOnly()) {
          window.switchNoteModalMode('edit');
          setTimeout(() => el.noteEditTitle && el.noteEditTitle.focus(), 60);
        }
      });
    }

    // Note Modal Share trigger
    if (el.modalShareBtn) {
      el.modalShareBtn.addEventListener('click', () => {
        if (state.currentNote) window.openShareModal('note', state.currentNote.id);
      });
    }

    // Share Modal Backdrop click
    if (el.shareModal) {
      el.shareModal.addEventListener('click', (e) => {
        if (e.target === el.shareModal) window.closeShareModal();
      });
    }
  }

  function isShareModalOpen() {
    return el.shareModal && el.shareModal.classList.contains('active');
  }

  function isConfirmModalOpen() {
    return el.confirmModal && el.confirmModal.classList.contains('active');
  }

  window.selectCategory = function (category) {
    state.selectedCategory = category.toLowerCase();
    state.selectedTopic = 'All'; // reset topic when changing category
    syncBrowserUrl();
    renderFacets();
    render();
  };

  window.selectTopic = function (topic) {
    state.selectedTopic = topic || 'All';

    // If selecting a specific topic, check if current category contains this topic; if not, reset category to 'all' so notes are visible
    if (state.selectedTopic !== 'All') {
      const topicLower = state.selectedTopic.toLowerCase();
      if (state.selectedCategory !== 'all') {
        const hasMatchingNoteInCat = state.notes.some(n => 
          (n.category || '').toLowerCase() === state.selectedCategory.toLowerCase() && 
          ((n.topic || '').toLowerCase() === topicLower || (n.domain || '').toLowerCase() === topicLower || (n.topicName || '').toLowerCase() === topicLower)
        );
        if (!hasMatchingNoteInCat) {
          state.selectedCategory = 'all';
        }
      }

      // Reset tag/type filters if they don't match any note in this topic to avoid empty list
      if (state.selectedTag) {
        const hasTagInTopic = state.notes.some(n =>
          ((n.topic || '').toLowerCase() === topicLower || (n.domain || '').toLowerCase() === topicLower || (n.topicName || '').toLowerCase() === topicLower) &&
          (n.tags || []).includes(state.selectedTag)
        );
        if (!hasTagInTopic) state.selectedTag = null;
      }
      if (state.selectedType !== 'All') {
        const hasTypeInTopic = state.notes.some(n =>
          ((n.topic || '').toLowerCase() === topicLower || (n.domain || '').toLowerCase() === topicLower || (n.topicName || '').toLowerCase() === topicLower) &&
          (n.type || '').toLowerCase() === state.selectedType.toLowerCase()
        );
        if (!hasTypeInTopic) state.selectedType = 'All';
      }
    }

    if (window.graphEngine) {
      window.graphEngine.filterByTopic(state.selectedTopic);
    }

    syncBrowserUrl();
    renderFacets();
    render();
  };

  window.selectType = function (type) {
    state.selectedType = type;
    syncBrowserUrl();
    renderFacets();
    render();
  };

  window.toggleTag = function (tag) {
    state.selectedTag = state.selectedTag === tag ? null : tag;
    syncBrowserUrl();
    renderFacets();
    render();
  };

  window.toggleCardListView = function () {
    if (state.viewMode === 'graph') {
      setViewMode(state.currentLayout || 'card');
    } else if (state.viewMode === 'card') {
      setViewMode('list');
    } else {
      setViewMode('card');
    }
  };

  window.toggleGraphView = function () {
    if (state.viewMode === 'graph') {
      setViewMode(state.currentLayout || 'card');
    } else {
      setViewMode('graph');
    }
  };

  window.switchView = function (mode) {
    setViewMode(mode);
  };

  function setViewMode(mode) {
    state.viewMode = mode;
    if (mode === 'card' || mode === 'list') {
      state.currentLayout = mode;
    }

    const isGraph = mode === 'graph';
    const isList = mode === 'list';
    const isCard = mode === 'card';

    // Update Single Toggle Button
    if (el.toggleLayoutBtn) {
      el.toggleLayoutBtn.classList.toggle('active', !isGraph);
      if (el.layoutToggleLabel) {
        el.layoutToggleLabel.textContent = isCard ? 'List View' : 'Cards View';
      }
      if (el.layoutToggleIcon) {
        if (isCard) {
          el.layoutToggleIcon.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          `;
        } else {
          el.layoutToggleIcon.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
            </svg>
          `;
        }
      }
    }

    // Update Knowledge Graph Button
    if (el.viewGraphBtn) {
      el.viewGraphBtn.classList.toggle('active', isGraph);
    }

    if (el.cardsView) el.cardsView.classList.toggle('hidden', !isCard);
    if (el.listView) el.listView.classList.toggle('hidden', !isList);
    if (el.graphView) el.graphView.classList.toggle('hidden', !isGraph);

    if (window.graphEngine) {
      if (isGraph) {
        window.graphEngine.onShow();
      } else {
        window.graphEngine.onHide();
      }
    }

    render();
  }

  window.toggleSearchMode = function () {
    state.searchMode = state.searchMode === 'deep' ? 'keyword' : 'deep';
    if (el.searchModePill) {
      el.searchModePill.textContent = state.searchMode === 'deep' ? 'Deep' : 'Key';
      el.searchModePill.classList.toggle('active', state.searchMode === 'deep');
      el.searchModePill.title = state.searchMode === 'deep'
        ? 'Deep Conceptual Search: Matches semantic tokens, tags, and titles with ranking'
        : 'Keyword Search: Exact substring match';
    }
    window.showToast(`🔍 Search Mode: ${state.searchMode === 'deep' ? 'Deep Concept Ranking' : 'Exact Keyword'}`, 2000);
    render();
  };

  function getFilteredNotes() {
    const q = state.searchQuery.toLowerCase().trim();

    let filtered = state.notes.filter(note => {
      if (state.selectedCategory !== 'all') {
        const cLower = state.selectedCategory.toLowerCase();
        const noteCat = (note.category || '').toLowerCase();
        const noteCatName = (note.categoryName || '').toLowerCase();
        if (noteCat !== cLower && noteCatName !== cLower) return false;
      }
      if (state.selectedTopic !== 'All') {
        const tLower = state.selectedTopic.toLowerCase();
        const noteTopic = (note.topic || '').toLowerCase();
        const noteDomain = (note.domain || '').toLowerCase();
        const noteTopicName = (note.topicName || '').toLowerCase();
        if (noteTopic !== tLower && noteDomain !== tLower && noteTopicName !== tLower) return false;
      }
      if (state.selectedType !== 'All') {
        const tpLower = state.selectedType.toLowerCase();
        if ((note.type || '').toLowerCase() !== tpLower) return false;
      }
      if (state.selectedTag && !note.tags.includes(state.selectedTag)) return false;
      if (!q) return true;

      if (state.searchMode === 'keyword') {
        return note._searchStr.includes(q);
      }

      // Deep / Conceptual Search: Match any token or fuzzy terms
      const tokens = q.split(/\s+/).filter(Boolean);
      return tokens.some(tok => note._searchStr.includes(tok));
    });

    if (q && state.searchMode === 'deep') {
      const tokens = q.split(/\s+/).filter(Boolean);
      // Multi-factor conceptual scoring & ranking
      filtered = filtered.map(note => {
        let score = 0;
        const titleLower = note.title.toLowerCase();
        const summaryLower = (note.summary || '').toLowerCase();
        const tagsLower = note.tags.map(t => t.toLowerCase());

        tokens.forEach(tok => {
          if (titleLower === tok) score += 25;
          else if (titleLower.includes(tok)) score += 12;
          if (tagsLower.includes(tok)) score += 10;
          if (note.topic.toLowerCase().includes(tok)) score += 8;
          if (summaryLower.includes(tok)) score += 5;
          if (note._searchStr.includes(tok)) score += 2;
        });

        return { note, score };
      }).sort((a, b) => b.score - a.score).map(item => item.note);
    }

    return filtered;
  }

  function render(skipFacets = false) {
    const filtered = getFilteredNotes();

    if (el.resultsCount) {
      el.resultsCount.innerHTML = `Showing <strong>${filtered.length}</strong> of <strong>${state.notes.length}</strong> knowledge assets`;
    }

    renderActiveFilters();

    if (!skipFacets) {
      renderFacets();
    }

    if (state.viewMode === 'card') {
      renderCards(filtered);
    } else if (state.viewMode === 'list') {
      renderList(filtered);
    }
  }

  function renderActiveFilters() {
    if (!el.activeFilters) return;
    const chips = [];

    if (state.selectedCategory !== 'all') {
      chips.push(`Category: <strong>${escapeHtml(categoryName(state.selectedCategory))}</strong> <span class="sh-filter-chip-del" onclick="window.selectCategory('all')">✕</span>`);
    }
    if (state.selectedTopic !== 'All') {
      chips.push(`Topic: <strong>${state.selectedTopic}</strong> <span class="sh-filter-chip-del" onclick="window.selectTopic('All')">✕</span>`);
    }
    if (state.selectedType !== 'All') {
      chips.push(`Type: <strong>${capitalize(state.selectedType)}</strong> <span class="sh-filter-chip-del" onclick="window.selectType('All')">✕</span>`);
    }
    if (state.selectedTag) {
      chips.push(`Tag: <strong>#${state.selectedTag}</strong> <span class="sh-filter-chip-del" onclick="window.toggleTag('${state.selectedTag}')">✕</span>`);
    }
    if (state.searchQuery) {
      chips.push(`Query: <strong>"${escapeHtml(state.searchQuery)}"</strong> <span class="sh-filter-chip-del" onclick="window.clearSearch()">✕</span>`);
    }

    el.activeFilters.innerHTML = chips.map(c => `<span class="sh-filter-chip">${c}</span>`).join('');
  }

  window.clearSearch = function () {
    state.searchQuery = '';
    if (el.searchInput) el.searchInput.value = '';
    if (el.searchClear) el.searchClear.classList.add('hidden');
    syncBrowserUrl();
    render();
  };

  window.clearAllFilters = function () {
    state.selectedCategory = 'all';
    state.selectedTopic = 'All';
    state.selectedType = 'All';
    state.selectedTag = null;
    state.searchQuery = '';
    if (el.searchInput) el.searchInput.value = '';
    if (el.searchClear) el.searchClear.classList.add('hidden');
    if (window.graphEngine) window.graphEngine.filterByTopic('All');
    syncBrowserUrl();
    renderFacets();
    render();
  };

  // 1. Render Cards View
  function renderCards(notes) {
    if (!el.cardsView) return;

    if (notes.length === 0) {
      el.cardsView.innerHTML = `
        <div class="sh-empty-view">
          <h3>No matching knowledge assets found</h3>
          <p>Try clearing filters or refining your search term.</p>
        </div>
      `;
      return;
    }

    el.cardsView.innerHTML = notes.map(note => {
      const color = topicColor(note.domain);
      const highlightedTitle = highlightText(note.title, state.searchQuery);
      const highlightedSummary = highlightText(note.summary, state.searchQuery);

      const tagsHtml = note.tags.slice(0, 4).map(t => 
        `<span class="sh-card-tag-item" onclick="event.stopPropagation(); window.toggleTag('${escapeHtml(t)}')">#${escapeHtml(t)}</span>`
      ).join('');

      return `
        <div class="sh-result-card" onclick="window.openNoteById('${note.id}')" style="--card-accent: ${color}; --topic-accent: ${color}; --cat-accent: ${categoryColor(note.category)};">
          <div>
            <div class="sh-card-top">
              <div class="sh-card-badges">
                <span class="sh-badge-category" onclick="event.stopPropagation(); window.selectCategory('${escapeHtml(note.category || '')}')" title="Filter by category: ${escapeHtml(note.categoryName || categoryName(note.category))}">● ${escapeHtml(note.categoryName || categoryName(note.category))}</span>
                <span class="sh-topic-badge" onclick="event.stopPropagation(); window.selectTopic('${escapeHtml(note.topic || '')}')" title="Filter by topic: ${escapeHtml(note.topic || '')}">${escapeHtml(note.topic || '')}</span>
              </div>
              <span class="sh-type-pill" onclick="event.stopPropagation(); window.selectType('${escapeHtml(note.type || '')}')" title="Filter by type: ${escapeHtml(note.type || '')}">${escapeHtml(note.type || 'note')}</span>
            </div>
            <h3 class="sh-card-title">${highlightedTitle}</h3>
            <p class="sh-card-snippet">${highlightedSummary}</p>
          </div>
          <div>
            <div class="sh-card-tags-list">${tagsHtml}</div>
            <div class="sh-card-bottom">
              <span>Updated: ${escapeHtml(note.updated || '')}</span>
              <div class="sh-card-actions">
                <button class="sh-card-delete-btn" onclick="event.stopPropagation(); window.promptDeleteNoteById('${note.id}')" title="Delete Note">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
                <button class="sh-card-share-btn" onclick="event.stopPropagation(); window.openShareModal('note', '${note.id}')" title="Share & Ingest Note">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle>
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
                  </svg>
                  <span>Share</span>
                </button>
                <div class="sh-card-open-link">
                  <span>View</span>
                  <span>→</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // 2. Render List View
  function renderList(notes) {
    if (!el.listView) return;

    if (notes.length === 0) {
      el.listView.innerHTML = `
        <div class="sh-empty-view">
          <h3>No matching knowledge assets found</h3>
          <p>Try clearing filters or refining your search term.</p>
        </div>
      `;
      return;
    }

    const rows = notes.map(note => {
      const color = topicColor(note.domain);
      const highlightedTitle = highlightText(note.title, state.searchQuery);
      const tagsHtml = note.tags.slice(0, 3).map(t => `<span class="sh-card-tag-item">#${escapeHtml(t)}</span>`).join(' ');

      return `
        <tr onclick="window.openNoteById('${note.id}')" style="--topic-accent: ${color}; --cat-accent: ${categoryColor(note.category)};">
          <td>
            <div class="sh-table-title">${highlightedTitle}</div>
            <div class="sh-table-path">${escapeHtml(note.relPath || '')}</div>
          </td>
          <td class="col-category"><span class="sh-badge-category" onclick="event.stopPropagation(); window.selectCategory('${escapeHtml(note.category || '')}')" title="Filter by category">● ${escapeHtml(note.categoryName || categoryName(note.category))}</span></td>
          <td class="col-topic"><span class="sh-topic-badge" onclick="event.stopPropagation(); window.selectTopic('${escapeHtml(note.topic || '')}')" title="Filter by topic">${escapeHtml(note.topic || '')}</span></td>
          <td class="col-type"><span class="sh-type-pill" onclick="event.stopPropagation(); window.selectType('${escapeHtml(note.type || '')}')" title="Filter by type">${note.type}</span></td>
          <td class="col-tags">${tagsHtml}</td>
          <td class="col-updated">${note.updated}</td>
          <td class="col-actions">
            <button class="btn-row-delete" onclick="event.stopPropagation(); window.promptDeleteNoteById('${note.id}')" title="Delete Note">Delete</button>
            <button class="btn-row-share" onclick="event.stopPropagation(); window.openShareModal('note', '${note.id}')" title="Share & Ingest Note">Share</button>
            <button class="btn-row-open">Open</button>
          </td>
        </tr>
      `;
    }).join('');

    el.listView.innerHTML = `
      <table class="sh-data-table">
        <thead>
          <tr>
            <th>Title & Path</th>
            <th class="col-category">Category</th>
            <th class="col-topic">Topic</th>
            <th class="col-type">Type</th>
            <th class="col-tags">Tags</th>
            <th class="col-updated">Updated</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }

  // Note Modal (SmartPreview Drawer)
  function openNote(noteId) {
    const note = state.notes.find(n => n.id === noteId);
    if (!note) return;

    state.currentNote = note;
    syncBrowserUrl();
    window.switchNoteModalMode('view');

    if (el.modalTitle) el.modalTitle.textContent = note.title;
    if (el.modalPath) el.modalPath.textContent = note.relPath;

    if (el.modalMeta) {
      const topicSelectHtml = state.categories.map(cat => `
        <optgroup label="${escapeHtml(cat.name)}">
          ${domainsFor(cat.id).map(d => `
            <option value="${d.id}" ${note.domain === d.id ? 'selected' : ''}>● ${escapeHtml(d.name)}</option>
          `).join('')}
        </optgroup>
      `).join('');

      el.modalMeta.innerHTML = `
        <div class="sh-category-picker-group" title="Manually change note category">
          <span class="sh-cat-picker-label">Category:</span>
          <select class="sh-cat-picker-select" onchange="window.changeNoteCategory('${note.id}', this.value)">
            ${categoryOptionsHtml(note.category)}
          </select>
        </div>
        <div class="sh-category-picker-group" title="Manually change note topic / domain">
          <span class="sh-cat-picker-label">Topic:</span>
          <select class="sh-cat-picker-select" onchange="window.changeNoteTopic('${note.id}', this.value)">
            ${topicSelectHtml}
          </select>
        </div>
        <span>Type: <strong>${note.type}</strong></span>
        <span>Status: <strong>${note.status}</strong></span>
        <span>Words: <strong>${note.wordCount}</strong></span>
        <span>Updated: <strong>${note.updated}</strong></span>
      `;
    }

    renderModalTags(note);

    if (el.modalBody) {
      el.modalBody.innerHTML = `
        <div id="modalCategoryMovePanel"></div>
        <div class="sh-markdown-content">
          ${renderMarkdown(note.body)}
        </div>
      `;
    }

    if (el.modalRelated) {
      if (note.related && note.related.length > 0) {
        el.modalRelated.innerHTML = note.related.map(rel => {
          const cleanRel = rel.replace(/^\[\[/, '').replace(/\]\]$/, '');
          const target = state.notes.find(n => 
            n.filename.replace(/\.md$/, '').toLowerCase() === cleanRel.toLowerCase() ||
            n.title.toLowerCase() === cleanRel.toLowerCase() ||
            n.relPath.toLowerCase().includes(cleanRel.toLowerCase())
          );
          if (target) {
            return `<a class="sh-related-pill-link" href="javascript:void(0)" onclick="window.openNoteById('${target.id}')">📄 ${escapeHtml(target.title)}</a>`;
          }
          return `<span class="sh-type-pill">[[${escapeHtml(cleanRel)}]]</span>`;
        }).join('');
      } else {
        el.modalRelated.innerHTML = '';
      }
    }

    if (el.modalBackdrop) {
      el.modalBackdrop.classList.add('active');
    }
  }

  // =========================================================================
  // Tag Editor Rendering & Management
  // =========================================================================

  function renderModalTags(note) {
    if (!el.modalTagEditor) return;
    const readOnly = isReadOnly();
    const tags = note.tags || [];

    if (readOnly) {
      const tagsHtml = tags.map(tg => `
        <span class="sh-tag-edit-pill">
          #${escapeHtml(tg)}
        </span>
      `).join('');
      el.modalTagEditor.innerHTML = `
        <span class="sh-tag-editor-label">Tags:</span>
        ${tagsHtml || '<span style="color:var(--text-muted); font-size:12px;">No tags</span>'}
        <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">Read-only</span>
      `;
      return;
    }

    const tagsHtml = tags.map(tg => `
      <span class="sh-tag-edit-pill">
        #${escapeHtml(tg)}
        <span class="sh-tag-del-btn" onclick="window.removeNoteTag('${note.id}', '${escapeHtml(tg)}')" title="Remove tag">✕</span>
      </span>
    `).join('');

    el.modalTagEditor.innerHTML = `
      <span class="sh-tag-editor-label">Tags:</span>
      ${tagsHtml}
      <div class="sh-tag-add-group">
        <input type="text" id="newTagInput" class="sh-tag-add-input" placeholder="Add tag..." onkeydown="if(event.key==='Enter'){window.addNoteTag('${note.id}');}" />
        <button class="sh-tag-add-btn" onclick="window.addNoteTag('${note.id}')">+ Add</button>
      </div>
    `;
  }

  window.addNoteTag = function (noteId) {
    const note = state.notes.find(n => n.id === noteId);
    if (!note) return;

    const input = document.getElementById('newTagInput');
    if (!input) return;

    const rawVal = input.value.trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    if (!rawVal) return;

    input.value = '';
    if (note.tags.includes(rawVal)) return;

    saveNoteTags(note, note.tags.concat(rawVal), `Tag added: #${rawVal}`);
  };

  window.removeNoteTag = function (noteId, tagToRemove) {
    const note = state.notes.find(n => n.id === noteId);
    if (!note) return;

    saveNoteTags(note, note.tags.filter(t => t !== tagToRemove), `Tag removed: #${tagToRemove}`);
  };

  // The markdown file is the source of truth: apply optimistically, then revert
  // the in-memory note if the server rejects the write.
  function saveNoteTags(note, tags, successMessage) {
    const previous = note.tags;
    applyNoteTags(note, tags);

    postJson('./api/update-tags', { relPath: note.relPath, tags })
      .then(() => window.showToast(successMessage))
      .catch(err => {
        applyNoteTags(note, previous);
        window.showToast(`Could not save tags: ${err.message}`, 4000);
      });
  }

  function applyNoteTags(note, tags) {
    note.tags = tags;
    note._searchStr = `${note.title} ${note.summary} ${tags.join(' ')} ${note.topic} ${note.type} ${note.category}`.toLowerCase();
    state.tags = [...new Set(state.notes.flatMap(n => n.tags))].sort();
    renderModalTags(note);
    renderFacets();
    render(true);
  }

  // =========================================================================
  // Manual Topic & Category Change & File Move Mechanism
  // =========================================================================

  window.changeNoteTopic = function (noteId, newDomain) {
    const note = state.notes.find(n => n.id === noteId);
    const target = findDomain(newDomain);
    if (!note || !target) return;

    moveNote(note, target.category, newDomain, `Topic changed to "${target.name}"`);
  };

  window.changeNoteCategory = function (noteId, newCategory) {
    const note = state.notes.find(n => n.id === noteId);
    if (!note || note.category === newCategory) return;

    const keepsDomain = domainsFor(newCategory).some(d => d.id === note.domain);
    moveNote(note, newCategory, keepsDomain ? note.domain : '', `Category changed to "${categoryName(newCategory)}"`);
  };

  // The server rewrites the frontmatter, moves the file and rebuilds the payload,
  // so reload from it instead of patching the note in place — the id changes too.
  function moveNote(note, category, domain, successMessage) {
    const dir = domain && domain !== category ? `knowledge/${category}/${domain}` : `knowledge/${category}`;

    postJson('./api/change-category', {
      oldPath: note.relPath,
      newPath: `${dir}/${note.filename}`,
      category: category,
      domain: domain
    })
      .then(data => {
        window.showToast(`${successMessage} — now at ${data.path}`, 3500);
        window.reloadKnowledgeData(() => openNote(data.note_id));
      })
      .catch(err => window.showToast(`Could not move note: ${err.message}`, 4000));
  }

  window.copyText = function (text) {
    navigator.clipboard.writeText(text).then(() => {
      window.showToast('Copied to clipboard!');
    });
  };

  window.openNoteById = function (id) {
    openNote(id);
  };

  function isQuickNoteModalOpen() {
    return el.quickNoteModal && el.quickNoteModal.classList.contains('active');
  }

  function closeModal() {
    state.currentNote = null;
    syncBrowserUrl();
    if (el.modalBackdrop) {
      el.modalBackdrop.classList.remove('active');
    }
  }

  // =========================================================================
  // Note Modal Mode Switcher (View / Live Edit / Git History)
  // =========================================================================

  window.switchNoteModalMode = function (mode) {
    if (!state.currentNote) return;
    state.modalMode = mode;

    const viewTab = document.getElementById('modalModeViewBtn');
    const editTab = document.getElementById('modalModeEditBtn');
    const histTab = document.getElementById('modalModeHistoryBtn');

    if (viewTab) viewTab.classList.toggle('active', mode === 'view');
    if (editTab) editTab.classList.toggle('active', mode === 'edit');
    if (histTab) histTab.classList.toggle('active', mode === 'history');

    if (el.modalBody) el.modalBody.classList.toggle('hidden', mode !== 'view');
    if (el.modalBodyEdit) el.modalBodyEdit.classList.toggle('hidden', mode !== 'edit');
    if (el.modalBodyHistory) el.modalBodyHistory.classList.toggle('hidden', mode !== 'history');
    if (el.modalViewFooter) el.modalViewFooter.classList.toggle('hidden', mode !== 'view');

    if (mode === 'edit') {
      if (isReadOnly()) {
        window.showToast(readOnlyReason(), 4500);
        window.switchNoteModalMode('view');
        return;
      }
      if (el.noteEditTitle) el.noteEditTitle.value = state.currentNote.title;
      if (el.noteEditSummary) el.noteEditSummary.value = state.currentNote.summary || '';
      if (el.noteEditType) el.noteEditType.value = state.currentNote.type || 'concept';
      if (el.noteEditContent) {
        el.noteEditContent.value = state.currentNote.body || '';
        updateEditorWordCount();
      }
      setTimeout(() => {
        if (el.noteEditTitle) el.noteEditTitle.focus();
      }, 50);
    } else if (mode === 'history') {
      fetchNoteHistory(state.currentNote.relPath);
    }
  };

  function updateEditorWordCount() {
    if (!el.noteEditContent || !el.noteEditWordCount) return;
    const text = el.noteEditContent.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    el.noteEditWordCount.textContent = `${words} words • ${text.length} chars`;
  }

  window.saveCurrentNoteEdits = async function () {
    if (!state.currentNote) return;
    if (blockIfReadOnly()) return;

    const title = el.noteEditTitle ? el.noteEditTitle.value.trim() : state.currentNote.title;
    const summary = el.noteEditSummary ? el.noteEditSummary.value.trim() : state.currentNote.summary;
    const docType = el.noteEditType ? el.noteEditType.value : state.currentNote.type;
    const content = el.noteEditContent ? el.noteEditContent.value : state.currentNote.body;

    if (!title) {
      window.showToast('⚠️ Note Title cannot be empty.', 2500);
      return;
    }

    const btn = document.getElementById('saveNoteBtn');
    if (btn) btn.disabled = true;
    window.showToast('⏳ Saving note changes...', 2000);

    try {
      const res = await postJson('./api/save-note', {
        relPath: state.currentNote.relPath,
        title,
        summary,
        type: docType,
        content
      });

      if (btn) btn.disabled = false;
      if (res.success) {
        window.showToast('✅ Note saved successfully!', 3000);
        await window.reloadKnowledgeData(() => {
          if (res.note) {
            openNote(res.note.id);
          }
        });
        window.switchNoteModalMode('view');
      } else {
        window.showToast(`❌ Error: ${res.error || 'Failed to save note'}`, 4000);
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      window.showToast(`❌ Error: ${err.message}`, 4000);
    }
  };

  async function fetchNoteHistory(relPath) {
    if (!el.historyCommitsList) return;
    el.historyCommitsList.innerHTML = '<div class="notif-empty">⏳ Loading commit log...</div>';
    if (el.historyDiffViewer) el.historyDiffViewer.textContent = 'Select a commit revision above to view diff / content.';

    try {
      const res = await apiFetch(`./api/note-history?relPath=${encodeURIComponent(relPath)}`);
      if (!res.ok) throw new Error('Failed to load history');
      const data = await res.json();
      const commits = data.commits || [];

      if (commits.length === 0) {
        el.historyCommitsList.innerHTML = '<div class="notif-empty">No git commits recorded yet for this note.</div>';
        return;
      }

      el.historyCommitsList.innerHTML = commits.map((c, i) => `
        <div class="history-commit-item ${i === 0 ? 'active' : ''}" onclick="window.loadCommitRevision('${escapeHtml(c.hash)}', this)">
          <div class="commit-item-left">
            <div class="commit-message">${escapeHtml(c.message)}</div>
            <div class="commit-meta">${escapeHtml(c.author)} • ${escapeHtml(c.date)}</div>
          </div>
          <span class="commit-hash">${escapeHtml(c.hash)}</span>
        </div>
      `).join('');

      if (commits[0]) {
        window.loadCommitRevision(commits[0].hash);
      }
    } catch (err) {
      el.historyCommitsList.innerHTML = `<div class="notif-empty">⚠️ Could not load history: ${escapeHtml(err.message)}</div>`;
    }
  }

  window.loadCommitRevision = async function (commitHash, targetEl) {
    if (!state.currentNote || !el.historyDiffViewer) return;

    if (targetEl) {
      document.querySelectorAll('.history-commit-item').forEach(item => item.classList.remove('active'));
      targetEl.classList.add('active');
    }

    const titleEl = document.getElementById('historyDiffTitle');
    if (titleEl) titleEl.textContent = `Revision ${commitHash}: Preview & Snapshot`;
    el.historyDiffViewer.textContent = '⏳ Loading revision content...';

    try {
      const res = await apiFetch(`./api/note-diff?relPath=${encodeURIComponent(state.currentNote.relPath)}&commit=${encodeURIComponent(commitHash)}`);
      if (!res.ok) throw new Error('Could not fetch revision');
      const data = await res.json();
      el.historyDiffViewer.textContent = data.content || 'No content found for this revision.';
    } catch (err) {
      el.historyDiffViewer.textContent = `⚠️ Error reading revision: ${err.message}`;
    }
  };

  // =========================================================================
  // Quick Note Creation Modal Controller
  // =========================================================================

  window.openQuickNoteModal = function () {
    if (blockIfReadOnly()) return;

    if (el.quickNoteCategory) {
      el.quickNoteCategory.innerHTML = categoryOptionsHtml(state.selectedCategory !== 'all' ? state.selectedCategory : state.defaultCategory);
    }
    window.updateQuickNoteDomains();
    window.applyNoteTemplate('concept');

    if (el.quickNoteModal) {
      el.quickNoteModal.classList.add('active');
      if (el.quickNoteTitle) el.quickNoteTitle.focus();
    }
  };

  window.closeQuickNoteModal = function () {
    if (el.quickNoteModal) {
      el.quickNoteModal.classList.remove('active');
    }
  };

  window.updateQuickNoteDomains = function () {
    if (!el.quickNoteCategory || !el.quickNoteDomain) return;
    const cat = el.quickNoteCategory.value || state.defaultCategory;
    const doms = domainsFor(cat);
    const currentTopicObj = doms.find(d => d.name.toLowerCase() === state.selectedTopic.toLowerCase() || d.id === state.selectedTopic.toLowerCase());
    const defaultDomainId = currentTopicObj ? currentTopicObj.id : (doms[0] ? doms[0].id : cat);

    el.quickNoteDomain.innerHTML = doms.map(d => `
      <option value="${d.id}" ${d.id === defaultDomainId ? 'selected' : ''}>● ${escapeHtml(d.name)}</option>
    `).join('');
  };

  const NOTE_TEMPLATES = {
    concept: {
      type: 'concept',
      tags: 'concept, fundamental, design',
      summary: 'Core foundational principles and architectural concepts.',
      content: '## Overview\n\nExplain the foundational concept here.\n\n## Key Mechanics\n- Mechanism 1: Core behavior\n- Mechanism 2: Data propagation\n\n## Related Knowledge\n- [[INDEX]]\n'
    },
    procedure: {
      type: 'procedure',
      tags: 'how-to, runbook, guide',
      summary: 'Step-by-step procedure and execution runbook.',
      content: '## Objective\n\nClear summary of what this procedure achieves.\n\n## Prerequisites\n- Required tools or permissions\n- Dependencies verified\n\n## Step-by-Step Execution\n1. Run initialization command\n2. Verify health responses\n3. Complete validation\n'
    },
    spec: {
      type: 'spec',
      tags: 'specification, architecture, rfc',
      summary: 'Technical architecture specification and interface contract.',
      content: '## Context & Problem Statement\n\nProblem description and requirements.\n\n## Architecture Design\n```\n[Client] -> [API Gateway] -> [Knowledge Store]\n```\n\n## API Contract\n| Endpoint | Method | Description |\n| :--- | :--- | :--- |\n| `/api/resource` | POST | Resource operation |\n'
    },
    reference: {
      type: 'reference',
      tags: 'cheatsheet, reference, api',
      summary: 'Quick syntax reference and lookup tables.',
      content: '## Quick Reference Cheat Sheet\n\n| Command | Syntax | Output |\n| :--- | :--- | :--- |\n| Quick check | `check --all` | Status summary |\n'
    },
    adr: {
      type: 'decision',
      tags: 'adr, architecture, decision',
      summary: 'Architecture Decision Record evaluating options and trade-offs.',
      content: '## Status\nAccepted\n\n## Context\nWhy this decision is required.\n\n## Decision\nChosen architecture and rationale.\n\n## Consequences\n- Positive trade-offs\n- Known limitations\n'
    },
    meeting: {
      type: 'concept',
      tags: 'meeting, scratchpad, notes',
      summary: 'Discussion notes, action items, and sync log.',
      content: '## Date & Participants\n- Date: Today\n- Participants: Lead Engineer\n\n## Key Topics Discussed\n1. System architecture updates\n2. Performance and caching\n\n## Action Items\n- [ ] Task 1\n- [ ] Task 2\n'
    }
  };

  window.applyNoteTemplate = function (templateKey) {
    const tpl = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.concept;
    document.querySelectorAll('.template-pill').forEach(btn => {
      btn.classList.toggle('active', btn.textContent.toLowerCase().includes(templateKey));
    });

    if (el.quickNoteType) el.quickNoteType.value = tpl.type;
    if (el.quickNoteTags && (!el.quickNoteTags.value || el.quickNoteTags.value.includes('concept') || el.quickNoteTags.value.includes('how-to'))) {
      el.quickNoteTags.value = tpl.tags;
    }
    if (el.quickNoteSummary && !el.quickNoteSummary.value) {
      el.quickNoteSummary.value = tpl.summary;
    }
    if (el.quickNoteContent) {
      el.quickNoteContent.value = tpl.content;
    }
  };

  window.submitQuickNote = async function () {
    if (blockIfReadOnly()) return;

    const title = el.quickNoteTitle ? el.quickNoteTitle.value.trim() : '';
    const category = el.quickNoteCategory ? el.quickNoteCategory.value : state.defaultCategory;
    const domain = el.quickNoteDomain ? el.quickNoteDomain.value : '';
    const docType = el.quickNoteType ? el.quickNoteType.value : 'concept';
    const tags = el.quickNoteTags ? el.quickNoteTags.value.split(',').map(s => s.trim()).filter(Boolean) : [];
    const summary = el.quickNoteSummary ? el.quickNoteSummary.value.trim() : title;
    const content = el.quickNoteContent ? el.quickNoteContent.value.trim() : '';

    if (!title || !domain) {
      window.showToast('⚠️ Note Title and Topic/Domain are required.', 3000);
      return;
    }

    const btn = document.getElementById('btnSubmitQuickNote');
    if (btn) btn.disabled = true;
    window.showToast(`⏳ Creating note "${title}"...`, 2000);

    try {
      const res = await postJson('./api/create-note', {
        title,
        category,
        domain,
        type: docType,
        tags,
        summary,
        content
      });

      if (btn) btn.disabled = false;
      if (res.success) {
        window.showToast(`✅ Created note "${title}"!`, 3500);
        window.closeQuickNoteModal();
        if (el.quickNoteTitle) el.quickNoteTitle.value = '';
        await window.reloadKnowledgeData(() => {
          if (res.note_id) {
            openNote(res.note_id);
          }
        });
      } else {
        window.showToast(`❌ Error: ${res.error || 'Failed to create note'}`, 4000);
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      window.showToast(`❌ Error: ${err.message}`, 4000);
    }
  };

  // =========================================================================
  // Reload Data & Confirmation Modal Controller
  // =========================================================================

  let confirmCallback = null;

  window.openConfirmModal = function ({ title, badge, message, previewHtml, confirmLabel, onConfirm }) {
    confirmCallback = onConfirm || null;
    if (el.confirmModalTitle) el.confirmModalTitle.textContent = title || 'Confirm Action';
    if (el.confirmModalBadge) el.confirmModalBadge.textContent = badge || 'Action';
    if (el.confirmModalMessage) el.confirmModalMessage.textContent = message || 'Are you sure you want to proceed?';
    if (el.confirmModalPreview) {
      if (previewHtml) {
        el.confirmModalPreview.innerHTML = previewHtml;
        el.confirmModalPreview.classList.remove('hidden');
      } else {
        el.confirmModalPreview.innerHTML = '';
        el.confirmModalPreview.classList.add('hidden');
      }
    }
    if (el.confirmModalSubmitBtn) {
      el.confirmModalSubmitBtn.textContent = confirmLabel || 'Delete';
    }
    if (el.confirmModal) {
      el.confirmModal.classList.add('active');
    }
  };

  window.closeConfirmModal = function () {
    confirmCallback = null;
    if (el.confirmModal) {
      el.confirmModal.classList.remove('active');
    }
  };

  window.reloadKnowledgeData = async function (callback) {
    try {
      const res = await apiFetch('./api/notes');
      if (res.ok) {
        window.KB_DATA = await res.json();
        loadData();
      }
      fetchNotifications();
      if (typeof callback === 'function') {
        callback(window.KB_DATA);
      }
    } catch (e) {
      console.warn('Could not reload knowledge data:', e);
    }
  };

  /* ==========================================================================
     Rename Note — retitles the note and the file backing it
     ========================================================================== */

  function isRenameModalOpen() {
    const modal = document.getElementById('renameNoteModal');
    return !!(modal && modal.classList.contains('active'));
  }

  /** Mirrors the server's slug rule so the preview matches what lands on disk. */
  function slugifyTitle(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }

  function updateRenamePreview() {
    const note = state.currentNote;
    const titleInput = document.getElementById('renameNoteTitle');
    const toggle = document.getElementById('renameNoteFileToggle');
    const toPathEl = document.getElementById('renameNoteToPath');
    if (!note || !titleInput || !toPathEl) return;

    const dir = note.relPath.includes('/') ? note.relPath.slice(0, note.relPath.lastIndexOf('/') + 1) : '';
    const currentFile = note.relPath.slice(dir.length);
    const slug = slugifyTitle(titleInput.value);
    const willRename = toggle ? toggle.checked : true;
    const target = willRename && slug ? `${slug}.md` : currentFile;

    toPathEl.textContent = dir + target;
    toPathEl.classList.toggle('is-unchanged', target === currentFile);
  }

  window.openRenameNoteModal = function () {
    if (!state.currentNote) return;
    if (blockIfReadOnly()) return;

    const modal = document.getElementById('renameNoteModal');
    const titleInput = document.getElementById('renameNoteTitle');
    const fromPathEl = document.getElementById('renameNoteFromPath');
    const toggle = document.getElementById('renameNoteFileToggle');
    if (!modal || !titleInput) return;

    titleInput.value = state.currentNote.title || '';
    if (fromPathEl) fromPathEl.textContent = state.currentNote.relPath;
    if (toggle) toggle.checked = true;
    updateRenamePreview();

    modal.classList.add('active');
    titleInput.focus();
    titleInput.select();
  };

  window.closeRenameNoteModal = function () {
    const modal = document.getElementById('renameNoteModal');
    if (modal) modal.classList.remove('active');
  };

  window.submitRenameNote = async function () {
    const note = state.currentNote;
    if (!note) return;
    if (blockIfReadOnly()) return;

    const titleInput = document.getElementById('renameNoteTitle');
    const toggle = document.getElementById('renameNoteFileToggle');
    const submitBtn = document.getElementById('renameNoteSubmitBtn');
    const newTitle = titleInput ? titleInput.value.trim() : '';

    if (!newTitle) {
      window.showToast('A note title is required.', 2500);
      return;
    }
    const renameFile = toggle ? toggle.checked : true;
    if (newTitle === note.title && !renameFile) {
      window.closeRenameNoteModal();
      return;
    }
    if (renameFile && !slugifyTitle(newTitle)) {
      window.showToast('That title produces an empty filename. Use at least one letter or number.', 4000);
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Renaming…';
    }

    try {
      const data = await postJson('./api/rename-note', {
        relPath: note.relPath,
        title: newTitle,
        renameFile: renameFile
      });

      window.closeRenameNoteModal();
      const relinked = (data.relinked || []).length;
      window.showToast(
        `Renamed to "${newTitle}"` + (relinked ? ` — repointed ${relinked} link${relinked === 1 ? '' : 's'}.` : '.'),
        3500
      );

      // The note id is derived from its path, so re-open under the new identity.
      const newId = data.noteId;
      window.reloadKnowledgeData(() => {
        const fresh = state.notes.find(n => n.id === newId) || state.notes.find(n => n.relPath === data.relPath);
        if (fresh) openNote(fresh.id);
        else closeModal();
      });
    } catch (err) {
      window.showToast(`Could not rename note: ${err.message}`, 4500);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Rename';
      }
    }
  };

  window.promptDeleteCurrentNote = function () {
    if (!state.currentNote) return;
    window.promptDeleteNoteById(state.currentNote.id);
  };

  window.promptDeleteNoteById = function (noteId) {
    if (blockIfReadOnly()) return;

    const note = state.notes.find(n => n.id === noteId);
    if (!note) return;

    window.openConfirmModal({
      title: 'Delete Knowledge Note',
      badge: 'Permanent Deletion',
      message: `Are you sure you want to permanently delete this note? This action cannot be undone.`,
      previewHtml: `
        <div><strong>Title:</strong> ${escapeHtml(note.title)}</div>
        <div style="font-family:monospace; margin-top:4px; font-size:12px; color:var(--text-muted);">${escapeHtml(note.relPath)}</div>
      `,
      confirmLabel: 'Delete Note',
      onConfirm: async () => {
        window.closeConfirmModal();
        window.showToast(`🗑️ Deleting note "${note.title}"...`, 2000);
        try {
          const res = await postJson('./api/delete-note', { relPath: note.relPath });
          if (res.success) {
            window.showToast(`✅ Note deleted successfully`, 3000);
            if (state.currentNote && state.currentNote.id === note.id) {
              closeModal();
            }
            await window.reloadKnowledgeData();
          } else {
            window.showToast(`❌ Error: ${res.error || 'Failed to delete note'}`, 4000);
          }
        } catch (err) {
          window.showToast(`❌ Could not delete note: ${err.message}`, 4000);
        }
      }
    });
  };

  window.promptDeleteCurrentTopic = function () {
    if (!state.selectedTopic || state.selectedTopic === 'All') return;
    window.promptDeleteTopic(state.selectedTopic);
  };

  window.promptDeleteTopic = function (topicName) {
    if (!topicName || topicName === 'All') return;

    if (blockIfReadOnly()) return;

    const targetNotes = state.notes.filter(n => n.topic.toLowerCase() === topicName.toLowerCase());
    const sample = targetNotes[0];
    const domain = sample ? sample.domain : topicName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const category = sample ? sample.category : (state.selectedCategory !== 'all' ? state.selectedCategory : state.defaultCategory);

    window.openConfirmModal({
      title: `Delete Topic: ${topicName}`,
      badge: 'Irreversible Action',
      message: `Are you sure you want to delete the entire topic "${topicName}"? All ${targetNotes.length} note(s) inside "knowledge/${category}/${domain}" will be permanently removed.`,
      previewHtml: `
        <div><strong>Topic:</strong> ${escapeHtml(topicName)} (Domain: <code>${escapeHtml(domain)}</code>)</div>
        <div style="margin-top:4px;"><strong>Contains:</strong> ${targetNotes.length} markdown note asset(s)</div>
        <div style="font-family:monospace; margin-top:4px; font-size:12px; color:var(--text-muted);">Folder: knowledge/${category}/${domain}/</div>
      `,
      confirmLabel: `Delete All in ${topicName}`,
      onConfirm: async () => {
        window.closeConfirmModal();
        window.showToast(`🗑️ Deleting topic "${topicName}" and ${targetNotes.length} note(s)...`, 2500);
        try {
          const res = await postJson('./api/delete-topic', {
            topic: topicName,
            domain: domain,
            category: category
          });
          if (res.success) {
            window.showToast(`✅ Topic "${topicName}" deleted successfully`, 3500);
            if (state.selectedTopic === topicName) {
              state.selectedTopic = 'All';
            }
            if (state.currentNote && targetNotes.some(n => n.id === state.currentNote.id)) {
              closeModal();
            }
            await window.reloadKnowledgeData();
          } else {
            window.showToast(`❌ Error: ${res.error || 'Failed to delete topic'}`, 4000);
          }
        } catch (err) {
          window.showToast(`❌ Could not delete topic: ${err.message}`, 4000);
        }
      }
    });
  };

  // =========================================================================
  // Share & Knowledge Base Ingestion System
  // =========================================================================

  function generateNoteSharePayload(note) {
    const baseUrl = getBaseUrl();
    const deepLink = `${baseUrl}?note=${encodeURIComponent(note.id)}`;

    // 1. Standard YAML Frontmatter + Markdown Body
    const tagsYaml = note.tags && note.tags.length ? `\ntags:\n${note.tags.map(t => `  - "${t}"`).join('\n')}` : '\ntags: []';
    const relatedYaml = note.related && note.related.length ? `\nrelated:\n${note.related.map(r => `  - "${r}"`).join('\n')}` : '\nrelated: []';

    const markdownPayload = `---
title: "${note.title.replace(/"/g, '\\"')}"
domain: "${note.domain}"
type: "${note.type}"${tagsYaml}
created: ${note.created}
updated: ${note.updated}
status: ${note.status}
summary: "${(note.summary || '').replace(/"/g, '\\"')}"
source_rel_path: "${note.relPath}"
source_url: "${deepLink}"${relatedYaml}
---

# ${note.title}

${note.body.trim()}
`;

    // 2. AI / LLM Ingestion Prompt
    const aiPromptPayload = `You are an AI Knowledge Base Librarian and Second Brain Assistant.
Please ingest and synthesize the following knowledge asset into the target knowledge base under domain "${note.domain}".

============================================================
ASSET METADATA:
- Title: ${note.title}
- Domain: ${note.domain} (${note.topic})
- Type: ${note.type}
- Status: ${note.status}
- Tags: ${(note.tags || []).join(', ')}
- Relative Path: ${note.relPath}
- Source Web Link: ${deepLink}
============================================================

MARKDOWN CONTENT WITH FRONTMATTER:

${markdownPayload}

============================================================
INGESTION INSTRUCTIONS:
1. Save this note into the knowledge base under "knowledge/${note.domain}/${note.filename}".
2. Preserve the full YAML frontmatter for context retrieval.
3. Update the domain Map of Content ("knowledge/${note.domain}/INDEX.md") and root index.
4. Establish bi-directional links for all referenced [[wikilinks]].
============================================================`;

    // 3. JSON Ingest Schema
    const jsonPayload = JSON.stringify({
      schema: "https://schema.org/DigitalDocument",
      ingestFormat: "KarpathyLLMWiki",
      id: note.id,
      title: note.title,
      domain: note.domain,
      topic: note.topic,
      type: note.type,
      status: note.status,
      created: note.created,
      updated: note.updated,
      summary: note.summary,
      tags: note.tags,
      related: note.related,
      relPath: note.relPath,
      shareUrl: deepLink,
      wordCount: note.wordCount,
      body: note.body
    }, null, 2);

    return {
      type: 'note',
      title: note.title,
      subtitle: `Note • ${note.relPath}`,
      filename: note.filename,
      deepLink,
      markdown: markdownPayload,
      prompt: aiPromptPayload,
      json: jsonPayload
    };
  }

  function generateTopicSharePayload(topicName) {
    const baseUrl = getBaseUrl();
    const isAll = topicName === 'All';
    const deepLink = isAll ? baseUrl : `${baseUrl}?topic=${encodeURIComponent(topicName)}`;

    const targetNotes = isAll 
      ? state.notes 
      : state.notes.filter(n => n.topic.toLowerCase() === topicName.toLowerCase());

    const titleStr = isAll ? 'Complete Knowledge Base' : `Topic: ${topicName}`;
    const filename = isAll ? 'knowledge-base-full-digest.md' : `${topicName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-topic-digest.md`;

    // Build Map of Content Table
    let mocTable = '| Note Title | Type | Status | Summary | Path |\n| :--- | :--- | :--- | :--- | :--- |\n';
    targetNotes.forEach(n => {
      const cleanSumm = (n.summary || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 100);
      mocTable += `| [[${n.title}]] | \`${n.type}\` | ${n.status} | ${cleanSumm}... | \`${n.relPath}\` |\n`;
    });

    // Build Combined Multi-Note Markdown Digest
    let notesMarkdownBody = '';
    targetNotes.forEach((n, idx) => {
      const noteDeepLink = `${baseUrl}?note=${encodeURIComponent(n.id)}`;
      notesMarkdownBody += `\n\n---\n\n## Note ${idx + 1}/${targetNotes.length}: ${n.title}\n\n`;
      notesMarkdownBody += `> **Metadata**: Domain: \`${n.domain}\` | Type: \`${n.type}\` | Tags: ${n.tags.map(t => `\`#${t}\``).join(', ')} | Path: \`${n.relPath}\`\n`;
      notesMarkdownBody += `> **Direct Link**: ${noteDeepLink}\n\n`;
      notesMarkdownBody += `${n.body.trim()}\n`;
    });

    const markdownPayload = `---
title: "${titleStr} Knowledge Digest"
topic: "${topicName}"
type: "hub"
total_notes: ${targetNotes.length}
generated: "${new Date().toISOString()}"
source_url: "${deepLink}"
---

# ${titleStr} — Knowledge Digest & Map of Content

This document is a unified compilation of **${targetNotes.length} knowledge assets** from the **${topicName}** domain. It is structured for rapid ingestion into other LLM second brains, Obsidian, Logseq, or enterprise AI indexes.

## Map of Content (MOC)

${mocTable}

## Knowledge Asset Payloads

${notesMarkdownBody}
`;

    // 2. AI / LLM Topic Ingestion Prompt
    const aiPromptPayload = `You are an AI Knowledge Base Librarian and Second Brain Assistant.
Please ingest and scaffold the entire "${topicName}" domain (containing ${targetNotes.length} notes) into the target knowledge base.

============================================================
TOPIC INGESTION BUNDLE:
- Domain/Topic: ${topicName}
- Total Notes: ${targetNotes.length}
- Source Web Link: ${deepLink}
============================================================

FULL TOPIC DIGEST WITH ALL NOTES:

${markdownPayload}

============================================================
INGESTION INSTRUCTIONS:
1. Create/update the domain folder for "${topicName}".
2. Extract each individual note into its corresponding markdown file with full YAML frontmatter.
3. Generate the domain "INDEX.md" Map of Content linking to each note.
4. Verify all bi-directional [[wikilinks]] across the domain.
============================================================`;

    // 3. JSON Topic Digest
    const jsonPayload = JSON.stringify({
      schema: "https://schema.org/Collection",
      ingestFormat: "KarpathyLLMWikiTopicDigest",
      topic: topicName,
      totalNotes: targetNotes.length,
      generatedAt: new Date().toISOString(),
      shareUrl: deepLink,
      notes: targetNotes.map(n => ({
        id: n.id,
        title: n.title,
        domain: n.domain,
        topic: n.topic,
        type: n.type,
        status: n.status,
        tags: n.tags,
        summary: n.summary,
        relPath: n.relPath,
        shareUrl: `${baseUrl}?note=${encodeURIComponent(n.id)}`,
        body: n.body
      }))
    }, null, 2);

    return {
      type: 'topic',
      title: titleStr,
      subtitle: `${targetNotes.length} Assets • ${topicName} Domain`,
      filename,
      deepLink,
      markdown: markdownPayload,
      prompt: aiPromptPayload,
      json: jsonPayload
    };
  }

  window.openCurrentTopicShare = function () {
    window.openShareModal('topic', state.selectedTopic);
  };

  window.openShareModal = function (type, targetIdOrName) {
    let payload = null;

    if (type === 'note') {
      const note = state.notes.find(n => n.id === targetIdOrName) || state.currentNote;
      if (!note) return;
      payload = generateNoteSharePayload(note);
    } else {
      const topic = targetIdOrName || state.selectedTopic || 'All';
      payload = generateTopicSharePayload(topic);
    }

    state.shareData = payload;

    if (el.shareModalTitle) el.shareModalTitle.textContent = `Share: ${payload.title}`;
    if (el.shareModalSubtitle) el.shareModalSubtitle.textContent = payload.subtitle;
    if (el.shareWebLinkInput) el.shareWebLinkInput.value = payload.deepLink;
    if (el.shareMarkdownPreview) el.shareMarkdownPreview.value = payload.markdown;
    if (el.sharePromptPreview) el.sharePromptPreview.value = payload.prompt;
    if (el.shareJsonPreview) el.shareJsonPreview.value = payload.json;

    // Default to 'link' tab
    window.switchShareTab('link');

    if (el.shareModal) {
      el.shareModal.classList.add('active');
    }
  };

  window.closeShareModal = function () {
    if (el.shareModal) {
      el.shareModal.classList.remove('active');
    }
  };

  window.switchShareTab = function (tabName) {
    state.activeShareTab = tabName;

    // Update Tab Buttons
    if (el.shareModal) {
      el.shareModal.querySelectorAll('.subtab-btn').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
      });

      // Update Tab Panes
      const tabPanes = {
        'link': document.getElementById('shareTabContentLink'),
        'markdown': document.getElementById('shareTabContentMarkdown'),
        'prompt': document.getElementById('shareTabContentPrompt'),
        'json': document.getElementById('shareTabContentJson')
      };

      Object.keys(tabPanes).forEach(k => {
        if (tabPanes[k]) {
          tabPanes[k].classList.toggle('active', k === tabName);
        }
      });
    }
  };

  // Copy Web Link
  window.copyShareWebLink = function () {
    if (!state.shareData) return;
    navigator.clipboard.writeText(state.shareData.deepLink).then(() => {
      window.showToast('Shareable link copied to clipboard!');
    }).catch(() => {
      if (el.shareWebLinkInput) {
        el.shareWebLinkInput.select();
        document.execCommand('copy');
        window.showToast('Shareable link copied to clipboard!');
      }
    });
  };

  // Test Open Link
  window.testOpenShareLink = function () {
    if (!state.shareData) return;
    window.open(state.shareData.deepLink, '_blank');
  };

  // Copy Markdown
  window.copyShareMarkdown = function () {
    if (!state.shareData) return;
    navigator.clipboard.writeText(state.shareData.markdown).then(() => {
      window.showToast('Markdown ingestion bundle copied to clipboard!');
    }).catch(() => {
      if (el.shareMarkdownPreview) {
        el.shareMarkdownPreview.select();
        document.execCommand('copy');
        window.showToast('Markdown ingestion bundle copied to clipboard!');
      }
    });
  };

  // Copy AI Prompt
  window.copySharePrompt = function () {
    if (!state.shareData) return;
    navigator.clipboard.writeText(state.shareData.prompt).then(() => {
      window.showToast('AI Ingestion Prompt copied to clipboard!');
    }).catch(() => {
      if (el.sharePromptPreview) {
        el.sharePromptPreview.select();
        document.execCommand('copy');
        window.showToast('AI Ingestion Prompt copied to clipboard!');
      }
    });
  };

  // Copy JSON
  window.copyShareJson = function () {
    if (!state.shareData) return;
    navigator.clipboard.writeText(state.shareData.json).then(() => {
      window.showToast('JSON schema payload copied to clipboard!');
    }).catch(() => {
      if (el.shareJsonPreview) {
        el.shareJsonPreview.select();
        document.execCommand('copy');
        window.showToast('JSON schema payload copied to clipboard!');
      }
    });
  };

  // Download Markdown File
  window.downloadShareMarkdown = function () {
    if (!state.shareData) return;
    const blob = new Blob([state.shareData.markdown], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, state.shareData.filename || 'knowledge-asset.md');
    window.showToast(`Downloaded ${state.shareData.filename}`);
  };

  // Download JSON File
  window.downloadShareJson = function () {
    if (!state.shareData) return;
    const jsonFilename = (state.shareData.filename || 'knowledge-asset').replace(/\.md$/, '') + '.json';
    const blob = new Blob([state.shareData.json], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, jsonFilename);
    window.showToast(`Downloaded ${jsonFilename}`);
  };

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // Toast Notification Helper (Material Snackbar)
  let toastTimer = null;
  window.showToast = function (message, duration) {
    if (!el.toast) return;
    el.toast.innerHTML = `<span class="md-toast-text">${message}</span>`;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
    }, duration || 2600);
  };

  // Material Design 3 Pointer Ripple Effect
  function attachMaterialRipples() {
    document.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('.btn-action, .btn-modal-primary, .btn-modal-secondary, .sh-nav-tab, .nav-cat-item, .subtab-btn, .notif-item');
      if (!target) return;

      const rect = target.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'md-ripple-effect';
      const size = Math.max(rect.width, rect.height) * 2;
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top - size / 2;

      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;

      target.appendChild(ripple);

      setTimeout(() => {
        ripple.remove();
      }, 550);
    });
  }

  // Markdown renderer
  function renderMarkdown(md) {
    if (!md) return '';
    let html = escapeHtml(md);

    // Code blocks
    html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (m, lang, code) => `<pre><code>${code}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Wikilinks
    html = html.replace(/\[\[(.*?)\]\]/g, (match, p1) => {
      const clean = p1.trim();
      const target = state.notes.find(n => 
        n.filename.replace(/\.md$/, '').toLowerCase() === clean.toLowerCase() ||
        n.title.toLowerCase() === clean.toLowerCase()
      );
      if (target) {
        return `<a class="wikilink-ref" href="javascript:void(0)" onclick="window.openNoteById('${target.id}')">[[${escapeHtml(clean)}]]</a>`;
      }
      return `<code>[[${escapeHtml(clean)}]]</code>`;
    });

    // Tables
    const tableRegex = /((?:\|[^\n]+\|\r?\n)+)/g;
    html = html.replace(tableRegex, match => {
      const lines = match.trim().split('\n');
      if (lines.length < 2) return match;
      let tHtml = '<table>';
      lines.forEach((line, idx) => {
        if (line.includes('---')) return;
        const cols = line.split('|').filter((c, i, arr) => i > 0 && i < arr.length - 1);
        if (cols.length === 0) return;
        if (idx === 0) {
          tHtml += '<thead><tr>' + cols.map(c => `<th>${c.trim()}</th>`).join('') + '</tr></thead><tbody>';
        } else {
          tHtml += '<tr>' + cols.map(c => `<td>${c.trim()}</td>`).join('') + '</tr>';
        }
      });
      tHtml += '</tbody></table>';
      return tHtml;
    });

    html = html.replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    html = html.replace(/\n\n/g, '</p><p>');

    return `<p>${html}</p>`;
  }

  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function highlightText(text, query) {
    if (!query || !text) return escapeHtml(text);
    const escapedText = escapeHtml(text);
    const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    return escapedText.replace(regex, '<mark>$1</mark>');
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /* ==========================================================================
     Knowledge Ingestion & PWA Controller Methods
     ========================================================================== */

  let cachedRawFiles = [];

  window.toggleMobileSidebar = function (event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const sidebar = document.getElementById('facetsSidebar');
    const backdrop = document.getElementById('mobileSidebarBackdrop');
    if (!sidebar) return;

    const isOpen = sidebar.classList.toggle('mobile-open');
    if (backdrop) backdrop.classList.toggle('active', isOpen);
    document.body.classList.toggle('mobile-sidebar-open', isOpen);
  };

  window.toggleSidebarCollapse = function () {
    if (window.innerWidth <= 992) {
      window.toggleMobileSidebar();
      return;
    }
    const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
    try {
      localStorage.setItem('kb_sidebar_collapsed', isCollapsed ? '1' : '0');
    } catch (e) {}
    if (window.graphEngine && typeof window.graphEngine.resize === 'function') {
      setTimeout(() => window.graphEngine.resize(), 260);
    }
  };

  try {
    if (window.innerWidth > 992 && localStorage.getItem('kb_sidebar_collapsed') === '1') {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch (e) {}

  window.openIngestModal = function () {
    if (blockIfReadOnly()) return;
    const modal = document.getElementById('ingestModal');
    if (modal) {
      modal.classList.add('active');
      window.updateDomainOptions('raw');
      window.updateDomainOptions('manual');
      window.refreshRawFiles();
      window.updateManualPreview();
    }
  };

  window.closeIngestModal = function () {
    const modal = document.getElementById('ingestModal');
    if (modal) {
      modal.classList.remove('active');
    }
  };

  window.switchIngestMode = function (mode) {
    const tabRaw = document.getElementById('ingestTabRaw');
    const tabManual = document.getElementById('ingestTabManual');
    const paneRaw = document.getElementById('ingestModeRaw');
    const paneManual = document.getElementById('ingestModeManual');

    if (mode === 'raw') {
      tabRaw.classList.add('active');
      tabManual.classList.remove('active');
      paneRaw.classList.add('active');
      paneManual.classList.remove('active');
    } else {
      tabManual.classList.add('active');
      tabRaw.classList.remove('active');
      paneManual.classList.add('active');
      paneRaw.classList.remove('active');
      window.updateManualPreview();
    }
  };

  window.updateDomainOptions = function (mode) {
    const catSelect = document.getElementById(mode === 'raw' ? 'rawIngestCategory' : 'manualIngestCategory');
    const domainSelect = document.getElementById(mode === 'raw' ? 'rawIngestDomain' : 'manualIngestDomain');
    if (!catSelect || !domainSelect) return;

    if (!catSelect.options.length) {
      catSelect.innerHTML = categoryOptionsHtml(state.defaultCategory);
    }

    const cat = catSelect.value || state.defaultCategory;
    domainSelect.innerHTML = domainsFor(cat)
      .map(d => `<option value="${d.id}">${escapeHtml(d.name)} (${d.id})</option>`)
      .join('');

    if (mode === 'manual') {
      window.updateManualPreview();
    }
  };

  window.refreshRawFiles = function () {
    const dropdown = document.getElementById('rawFileDropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '<option value="">-- Fetching raw inbox files... --</option>';

    apiFetch('./api/raw-files')
      .then(res => {
        if (!res.ok) throw new Error('API offline');
        return res.json();
      })
      .then(data => {
        cachedRawFiles = data.files || [];
        if (cachedRawFiles.length === 0) {
          dropdown.innerHTML = '<option value="">No raw files found in raw/ inbox</option>';
          return;
        }
        dropdown.innerHTML = '<option value="">-- Select a file to ingest (' + cachedRawFiles.length + ' available) --</option>' +
          cachedRawFiles.map(f => `<option value="${f.name}">${f.name} (${f.size_kb} KB - ${f.modified})</option>`).join('');
      })
      .catch(() => {
        dropdown.innerHTML = '<option value="">⚠️ Backend API offline (Use Manual Capture)</option>';
      });
  };

  window.onRawFileSelected = function (filename) {
    const previewBox = document.getElementById('rawFilePreviewBox');
    const previewMeta = document.getElementById('rawFileMetaText');
    const previewArea = document.getElementById('rawFileContentPreview');
    const titleInput = document.getElementById('rawIngestTitle');
    const summaryInput = document.getElementById('rawIngestSummary');

    if (!filename) {
      if (previewBox) previewBox.classList.add('hidden');
      return;
    }

    if (previewBox) previewBox.classList.remove('hidden');
    if (previewMeta) previewMeta.textContent = `Loading ${filename}...`;

    apiFetch(`./api/raw-file?name=${encodeURIComponent(filename)}`)
      .then(res => res.json())
      .then(data => {
        if (data.content) {
          if (previewArea) previewArea.value = data.content;
          if (previewMeta) previewMeta.textContent = `📄 ${filename} (${Math.round(data.content.length / 1024 * 10) / 10} KB)`;

          // Auto-guess title
          const cleanTitle = filename.replace(/^.*\//, '').replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
          if (titleInput && !titleInput.value) {
            titleInput.value = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
          }

          // Auto-guess summary from first paragraphs
          if (summaryInput && !summaryInput.value) {
            const firstLines = data.content.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 2).join(' ');
            summaryInput.value = firstLines.slice(0, 160) + (firstLines.length > 160 ? '...' : '');
          }
        }
      })
      .catch(err => {
        if (previewMeta) previewMeta.textContent = `❌ Could not read ${filename}`;
      });
  };

  window.updateManualPreview = function () {
    const title = (document.getElementById('manualIngestTitle')?.value || 'Untitled Note').trim();
    const category = document.getElementById('manualIngestCategory')?.value || state.defaultCategory;
    const domain = document.getElementById('manualIngestDomain')?.value || '';
    const type = document.getElementById('manualIngestType')?.value || 'concept';
    const tags = (document.getElementById('manualIngestTags')?.value || 'ai, second-brain').split(',').map(s => s.trim()).filter(Boolean);
    const summary = (document.getElementById('manualIngestSummary')?.value || 'Dense summary of this note.').trim();
    const previewEl = document.getElementById('manualFrontmatterPreview');

    const today = new Date().toISOString().split('T')[0];
    const fm = `---
title: "${title}"
domain: "${domain}"
category: "${category}"
type: "${type}"
tags: ${JSON.stringify(tags)}
created: ${today}
updated: ${today}
status: active
summary: "${summary}"
related:
  - "[[INDEX]]"
---`;

    if (previewEl) {
      previewEl.textContent = fm;
    }
  };

  window.submitRawIngestion = function () {
    const filename = document.getElementById('rawFileDropdown')?.value;
    const category = document.getElementById('rawIngestCategory')?.value || state.defaultCategory;
    const domain = document.getElementById('rawIngestDomain')?.value;
    const title = document.getElementById('rawIngestTitle')?.value;
    const type = document.getElementById('rawIngestType')?.value || 'concept';
    const tags = (document.getElementById('rawIngestTags')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const summary = document.getElementById('rawIngestSummary')?.value;
    const content = document.getElementById('rawFileContentPreview')?.value;
    const archiveSource = document.getElementById('rawArchiveCheckbox')?.checked || false;
    const btn = document.getElementById('btnSubmitRawIngest');

    if (!title) {
      showToast('⚠️ Please enter a Note Title before ingesting.', 3000);
      return;
    }

    if (btn) btn.disabled = true;
    showToast('⏳ Ingesting and compiling into Second Brain...', 2000);

    apiFetch('./api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        category,
        domain,
        type,
        tags,
        summary,
        content,
        source_file: filename,
        archive_source: archiveSource
      })
    })
      .then(res => res.json())
      .then(data => {
        if (btn) btn.disabled = false;
        if (data.success) {
          showToast(`✅ Ingested: ${title}`, 3500);
          window.closeIngestModal();
          window.reloadKnowledgeData();
        } else {
          showToast(`❌ Error: ${data.error || 'Ingest failed'}`, 4000);
        }
      })
      .catch(err => {
        if (btn) btn.disabled = false;
        showToast('❌ Server error during ingestion.', 4000);
      });
  };

  window.submitManualIngestion = function () {
    const category = document.getElementById('manualIngestCategory')?.value || state.defaultCategory;
    const domain = document.getElementById('manualIngestDomain')?.value;
    const title = document.getElementById('manualIngestTitle')?.value;
    const type = document.getElementById('manualIngestType')?.value || 'concept';
    const tags = (document.getElementById('manualIngestTags')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const summary = document.getElementById('manualIngestSummary')?.value;
    const body = document.getElementById('manualIngestBody')?.value;
    const btn = document.getElementById('btnSubmitManualIngest');

    if (!title) {
      showToast('⚠️ Please enter a Note Title.', 3000);
      return;
    }

    if (btn) btn.disabled = true;
    showToast('⏳ Saving note and updating index...', 2000);

    apiFetch('./api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        category,
        domain,
        type,
        tags,
        summary,
        content: body
      })
    })
      .then(res => res.json())
      .then(data => {
        if (btn) btn.disabled = false;
        if (data.success) {
          showToast(`✅ Note saved: ${title}`, 3500);
          window.closeIngestModal();
          window.reloadKnowledgeData();
        } else {
          showToast(`❌ Error: ${data.error || 'Save failed'}`, 4000);
        }
      })
      .catch(err => {
        if (btn) btn.disabled = false;
        showToast('❌ Server error during save.', 4000);
      });
  };

  /* ============================  /** Reflects the current connection in the UI and Settings menu. */
  function updateSourceUI() {
    const pill = document.getElementById('kbSourcePill');
    const label = document.getElementById('kbSourceLabel');
    const dot = document.getElementById('kbSourceDot');
    if (!window.KBSource) return;

    const status = window.KBSource.getStatus();
    const text = {
      live: status.kbName || status.label,
      snapshot: `${status.kbName || status.label} (snapshot)`,
      cache: `${status.kbName || status.label} (offline)`,
      '': 'Not connected'
    }[status.mode] || status.label;

    const dotState = {
      live: 'is-live',
      snapshot: 'is-readonly',
      cache: 'is-offline',
      '': 'is-error'
    }[status.mode] || 'is-error';

    if (label) label.textContent = text;
    if (dot) dot.className = `kb-source-dot ${dotState}`;
    if (pill) {
      pill.classList.toggle('is-readonly', status.mode !== 'live');
      pill.title = status.mode === 'live'
        ? `Connected to ${status.label} — read/write. Click to change.`
        : `${readOnlyReason()} Click to change.`;
    }

    // Sidebar footer status button (KB Connected / KB Not Connected)
    const sidebarBtn = document.getElementById('sidebarKbStatusBtn');
    const footerDot = document.getElementById('footerStatusDot');
    const footerTitle = document.getElementById('footerStatusTitle');
    const footerSub = document.getElementById('footerStatusSubtitle');
    const isLive = status.mode === 'live';
    const hasData = !!(window.KB_DATA && window.KB_DATA.notes && window.KB_DATA.notes.length > 0);
    document.body.classList.toggle('kb-empty', !hasData);

    if (sidebarBtn) {
      sidebarBtn.className = `footer-system-status ${isLive ? 'status-connected' : 'status-disconnected'}`;
    }
    if (footerTitle) {
      footerTitle.textContent = isLive ? 'KB Connected' : 'KB Not Connected';
    }
    if (footerSub) {
      footerSub.textContent = isLive
        ? (status.label || (status.baseUrl ? status.baseUrl.replace(/^https?:\/\//, '') : 'Local Server'))
        : 'Click to configure';
    }
    if (footerDot) {
      footerDot.className = `status-indicator-dot ${isLive ? 'is-live' : 'is-error'}`;
    }

    if (el.topicTotalCount && !hasData) {
      el.topicTotalCount.textContent = '0';
    }

    document.body.classList.toggle('kb-readonly', isReadOnly());
    if (state.currentNote) renderModalTags(state.currentNote);
  }

  function hideConnectPrompt() {
    const prompt = document.getElementById('kbConnectPrompt');
    if (prompt) prompt.classList.add('hidden');
  }

  window.openKbSourceSettings = function () {
    if (window.KBSource) window.KBSource.openSettings();
  };

  // Reconnecting swaps the whole knowledge base out, so drop everything and reload.
  window.addEventListener('kb:source_reconnect', async () => {
    window.KB_DATA = null;
    state.currentNote = null;
    if (window.showToast) window.showToast('Connecting to knowledge base…', 2500);
    await loadData();
    if (window.KB_DATA && window.showToast) {
      window.showToast(`Loaded ${state.notes.length} notes.`, 2500);
    }
  });

  if (window.KBSource) window.KBSource.onChange(updateSourceUI);

  /* ==========================================================================
     Google Authentication & Auth Gate Controller
     ========================================================================== */

  function updateAuthUI(user) {
    const authGate = document.getElementById('authGateScreen');
    const menuAvatar = document.getElementById('settingsUserAvatar');
    const menuName = document.getElementById('settingsUserName');
    const menuEmail = document.getElementById('settingsUserEmail');
    const logoutBtn = document.getElementById('settingsLogoutBtn');

    if (user) {
      if (authGate) authGate.classList.add('hidden');
      if (menuAvatar) {
        menuAvatar.src = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || 'User')}&background=8b5cf6&color=fff`;
      }
      const name = user.displayName || (user.email ? user.email.split('@')[0] : 'User');
      if (menuName) menuName.textContent = user.displayName || name;
      if (menuEmail) menuEmail.textContent = user.email || '';
      if (logoutBtn) logoutBtn.classList.remove('hidden');
      if (!window.KB_DATA || !window.KB_DATA.notes || window.KB_DATA.notes.length === 0) {
        loadData();
      } else {
        hideAppLoading();
      }
    } else {
      hideAppLoading();
      if (authGate) authGate.classList.remove('hidden');
      if (menuAvatar) {
        menuAvatar.src = `https://ui-avatars.com/api/?name=User&background=6b7280&color=fff`;
      }
      if (menuName) menuName.textContent = 'Not Signed In';
      if (menuEmail) menuEmail.textContent = 'Sign in with Google';
      if (logoutBtn) logoutBtn.classList.add('hidden');
    }
  }

  window.handleGoogleLogin = async function () {
    if (!window.KBAuth) {
      const statusEl = document.getElementById('authGateStatus');
      if (statusEl) statusEl.textContent = 'Initializing authentication... please retry in a moment.';
      if (window.showToast) window.showToast('Signing in with Google…', 3000);
      try {
        if (typeof firebase !== 'undefined' && firebase.auth) {
          const provider = new firebase.auth.GoogleAuthProvider();
          provider.setCustomParameters({ prompt: 'select_account' });
          await firebase.auth().signInWithPopup(provider);
          return;
        }
      } catch (e) {}
      return;
    }
    try {
      showToast('Signing in with Google…', 2500);
      await window.KBAuth.loginWithGoogle();
    } catch (err) {
      console.error('Login error:', err);
      const statusEl = document.getElementById('authGateStatus');
      if (statusEl) statusEl.textContent = 'Sign-in error: ' + (err.message || 'Please try again.');
    }
  };

  window.handleGoogleLogout = async function () {
    if (!window.KBAuth) return;
    try {
      await window.KBAuth.logout();
      showToast('Signed out.', 2500);
      closeSettingsMenu();
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  /* Settings Menu Controller */
  window.toggleSettingsMenu = function (e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('settingsDropdownMenu') || document.getElementById('topbarMoreMenu');
    const btn = document.getElementById('topbarSettingsBtn') || document.getElementById('topbarMoreBtn');
    if (!menu) return;
    const isOpening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !isOpening);
    if (btn) btn.setAttribute('aria-expanded', isOpening ? 'true' : 'false');
    
    // Close notification panel if open
    const notifDropdown = document.getElementById('notifPanelDropdown');
    if (notifDropdown && !notifDropdown.classList.contains('hidden')) {
      notifDropdown.classList.add('hidden');
    }
  };

  window.toggleTopbarMore = window.toggleSettingsMenu;

  function closeSettingsMenu() {
    const menu = document.getElementById('settingsDropdownMenu') || document.getElementById('topbarMoreMenu');
    const btn = document.getElementById('topbarSettingsBtn') || document.getElementById('topbarMoreBtn');
    if (menu && !menu.classList.contains('hidden')) menu.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  window.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-container') && !e.target.closest('.topbar-more')) {
      closeSettingsMenu();
    }
    const notifDropdown = document.getElementById('notifPanelDropdown');
    if (notifDropdown && !notifDropdown.classList.contains('hidden') && !e.target.closest('.notification-container')) {
      notifDropdown.classList.add('hidden');
    }
  });

  window.addEventListener('kb:auth_changed', (e) => {
    updateAuthUI(e.detail ? e.detail.user : null);
  });

  let activeNotifFilter = 'all';
  let cachedNotificationsList = [];

  window.toggleNotificationDrawer = function (event) {
    if (event) event.stopPropagation();
    const drawer = document.getElementById('notifDrawer');
    const backdrop = document.getElementById('notifDrawerBackdrop');
    const bellBtn = document.getElementById('notifBellBtn');
    if (!drawer) return;

    const isOpen = drawer.classList.contains('open');
    closeSettingsMenu();

    if (!isOpen) {
      drawer.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
      document.body.classList.add('notif-drawer-open');
      if (bellBtn) bellBtn.classList.add('active');
      fetchNotifications();
    } else {
      window.closeNotificationDrawer();
    }
  };

  window.toggleNotificationPanel = window.toggleNotificationDrawer;
  window.openNotificationDrawer = window.toggleNotificationDrawer;

  window.closeNotificationDrawer = function () {
    const drawer = document.getElementById('notifDrawer');
    const backdrop = document.getElementById('notifDrawerBackdrop');
    const bellBtn = document.getElementById('notifBellBtn');
    if (drawer) drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    document.body.classList.remove('notif-drawer-open');
    if (bellBtn) bellBtn.classList.remove('active');
  };

  window.filterNotifDrawer = function (type) {
    activeNotifFilter = type || 'all';
    ['notifTabAll', 'notifTabNewsletters', 'notifTabWip'].forEach(id => {
      const tab = document.getElementById(id);
      if (tab) tab.classList.remove('active');
    });
    if (type === 'newsletter') {
      const t = document.getElementById('notifTabNewsletters');
      if (t) t.classList.add('active');
    } else if (type === 'wip') {
      const t = document.getElementById('notifTabWip');
      if (t) t.classList.add('active');
    } else {
      const t = document.getElementById('notifTabAll');
      if (t) t.classList.add('active');
    }
    renderNotifications(cachedNotificationsList);
  };

  window.markAllNotificationsRead = function () {
    const badge = document.getElementById('notifBadge');
    if (badge) badge.classList.add('hidden');
    try {
      localStorage.setItem('kb_notifs_last_read', String(Date.now()));
    } catch (e) {}
    renderNotifications(cachedNotificationsList);
    showToast('✓ All notifications marked as read', 2000);
  };

  async function fetchNotifications() {
    let items = [];
    try {
      const res = await apiFetch('./api/notifications');
      if (res.ok) {
        const data = await res.json();
        items = data.notifications || [];
      }
    } catch (e) {
      console.warn('Could not load notifications from API:', e);
    }

    // Merge with latest KB_DATA notes to give full rich feed across all environments
    if (window.KB_DATA && Array.isArray(window.KB_DATA.notes)) {
      const noteMap = new Map();
      items.forEach(i => { if (i.noteId) noteMap.set(i.noteId, i); });

      const sortedNotes = [...window.KB_DATA.notes].sort((a, b) => {
        const ta = a.updated || a.created || '';
        const tb = b.updated || b.created || '';
        return tb.localeCompare(ta);
      });

      let newsletterCount = 0;
      sortedNotes.forEach(n => {
        const isNewsletter = (n.tags && n.tags.some(t => t.includes('newsletter') || t.includes('opinion-ai') || t.includes('emerging-ai')));
        if (isNewsletter) newsletterCount++;
        if (!noteMap.has(n.id)) {
          const isWip = (n.category === 'work-in-progress' || (n.tags && n.tags.includes('wip')));
          noteMap.set(n.id, {
            title: n.title,
            noteId: n.id,
            relPath: n.relPath,
            timestamp: n.updated || n.created || 'Recent',
            type: isNewsletter ? 'newsletter' : isWip ? 'wip' : 'note',
            summary: n.summary || (n.content ? n.content.replace(/^---[\s\S]*?---\s*/, '').slice(0, 140) : '')
          });
        }
      });

      const countEl = document.getElementById('notifTabNewsletterCount');
      if (countEl) countEl.textContent = String(newsletterCount);

      cachedNotificationsList = Array.from(noteMap.values());
    } else {
      cachedNotificationsList = items;
    }

    renderNotifications(cachedNotificationsList);
  }

  function renderNotifications(notifs) {
    const listEl = document.getElementById('notifDrawerList') || document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    if (!listEl) return;

    if (!notifs || notifs.length === 0) {
      listEl.innerHTML = '<div class="notif-empty">No recent ingestions or activity recorded yet.</div>';
      if (badge) badge.classList.add('hidden');
      return;
    }

    let lastReadTime = 0;
    try {
      lastReadTime = parseInt(localStorage.getItem('kb_notifs_last_read') || '0', 10);
    } catch (e) {}

    let unreadCount = 0;
    let filtered = notifs;
    if (activeNotifFilter === 'newsletter') {
      filtered = notifs.filter(n => n.type === 'newsletter');
    } else if (activeNotifFilter === 'wip') {
      filtered = notifs.filter(n => n.type === 'wip' || n.type === 'note');
    }

    const itemsHtml = filtered.map(n => {
      let badgeClass = '';
      let badgeText = 'Note';
      if (n.type === 'newsletter') {
        badgeClass = 'badge-newsletter';
        badgeText = 'Opinion AI';
      } else if (n.type === 'sync') {
        badgeClass = 'badge-sync';
        badgeText = 'Drive Sync';
      } else if (n.type === 'wip') {
        badgeClass = 'badge-wip';
        badgeText = 'WIP';
      }

      const itemTimeMs = new Date(n.timestamp).getTime() || Date.now();
      const isUnread = itemTimeMs > lastReadTime;
      if (isUnread) unreadCount++;

      return `
        <div class="notif-card ${isUnread ? 'unread' : ''}" onclick="window.openNotificationNote('${escapeHtml(n.noteId || '')}')">
          <div class="notif-card-top">
            <span class="notif-card-badge ${badgeClass}">${badgeText}</span>
            <span class="notif-card-time">${escapeHtml(n.timestamp || '')}</span>
          </div>
          <div class="notif-card-title">${escapeHtml(n.title || 'Untitled Note')}</div>
          <div class="notif-card-summary">${escapeHtml(n.summary || '')}</div>
          ${n.relPath ? `<div class="notif-card-path">📄 ${escapeHtml(n.relPath)}</div>` : ''}
        </div>
      `;
    }).join('');

    listEl.innerHTML = itemsHtml || '<div class="notif-empty">No items matching this category.</div>';

    if (badge) {
      if (unreadCount > 0) {
        badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  }

  window.openNotificationNote = function (noteId) {
    window.closeNotificationDrawer();
    if (noteId) {
      window.openNoteById(noteId);
    }
  };

  /* ==========================================================================
     Sync Controller — asks the KB server to pull from git and recompile
     ========================================================================== */

  window.triggerGoogleDriveSync = async function () {
    if (blockIfReadOnly()) return;

    const btn = document.getElementById('syncDriveBtn');
    const txt = document.getElementById('syncBtnText');
    const topbarBtn = document.getElementById('topbarSyncDriveBtn');
    const topbarTxt = document.getElementById('topbarSyncBtnText');

    if (btn) btn.classList.add('syncing');
    if (txt) txt.textContent = 'Syncing…';
    if (topbarBtn) topbarBtn.classList.add('syncing');
    if (topbarTxt) topbarTxt.textContent = 'Syncing…';

    try {
      const res = await apiFetch('/api/sync', { method: 'POST' });
      await res.json().catch(() => ({}));

      // Poll sync status until complete (up to 15 seconds)
      let finalResult = null;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 600));
        const statusRes = await apiFetch('/api/sync/status').catch(() => null);
        if (statusRes && statusRes.ok) {
          const statusData = await statusRes.json();
          if (!statusData.is_syncing) {
            finalResult = statusData.last_result;
            break;
          }
        }
      }

      const notesRes = await apiFetch('/api/notes?refresh=1');
      if (notesRes.ok) {
        window.KB_DATA = await notesRes.json();
        loadData();
      }
      fetchNotifications();

      let msg = `✅ Synced — ${state.notes.length} notes indexed.`;
      if (finalResult && finalResult.newsletter_feeds && finalResult.newsletter_feeds.new_articles > 0) {
        msg = `✅ Synced — Ingested ${finalResult.newsletter_feeds.new_articles} new Opinion AI articles (${state.notes.length} total notes).`;
      }
      showToast(msg, 4000);
    } catch (err) {
      showToast('⚠️ Sync failed: ' + (err && err.message ? err.message : 'server unreachable'), 4000);
    } finally {
      if (btn) btn.classList.remove('syncing');
      if (txt) txt.textContent = 'Sync now';
      if (topbarBtn) topbarBtn.classList.remove('syncing');
      if (topbarTxt) topbarTxt.textContent = 'Sync';
    }
  };

  window.triggerKbConsolidation = async function () {
    if (blockIfReadOnly()) return;

    const topbarBtn = document.getElementById('topbarConsolidateBtn');
    const topbarTxt = document.getElementById('topbarConsolidateBtnText');

    if (topbarBtn) topbarBtn.classList.add('consolidating');
    if (topbarTxt) topbarTxt.textContent = 'Consolidating…';

    try {
      const res = await apiFetch('/api/consolidate', { method: 'POST' });
      const data = await res.json().catch(() => ({}));

      const notesRes = await apiFetch('/api/notes?refresh=1');
      if (notesRes.ok) {
        window.KB_DATA = await notesRes.json();
        loadData();
      }
      fetchNotifications();

      const msg = data.message || `🪄 Consolidation complete — ${state.notes.length} notes indexed.`;
      showToast(msg, 5000);
    } catch (err) {
      showToast('⚠️ Consolidation failed: ' + (err && err.message ? err.message : 'server unreachable'), 4000);
    } finally {
      if (topbarBtn) topbarBtn.classList.remove('consolidating');
      if (topbarTxt) topbarTxt.textContent = 'Consolidate';
    }
  };

  /* ==========================================================================
     Progressive Web App (PWA) Install Controller
     ========================================================================== */

  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const installBtn = document.getElementById('pwaInstallBtn');
    if (installBtn) {
      installBtn.classList.remove('hidden');
    }
  });

  window.installPWA = async function () {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      console.log('[PWA] User choice:', outcome);
      deferredInstallPrompt = null;
      const installBtn = document.getElementById('pwaInstallBtn');
      if (installBtn) installBtn.classList.add('hidden');
    } else {
      showToast('📱 To install: tap Share or Menu in your browser and select "Add to Home Screen".', 4000);
    }
  };

  window.addEventListener('appinstalled', () => {
    console.log('[PWA] Knowledge Base app installed successfully.');
    const installBtn = document.getElementById('pwaInstallBtn');
    if (installBtn) installBtn.classList.add('hidden');
    showToast('🎉 Knowledge Base installed as app!', 3500);
  });

  const bootstrap = () => {
    init();
    attachMaterialRipples();
    fetchNotifications();
    if (window.KBAuth) {
      const user = window.KBAuth.getCurrentUser();
      updateAuthUI(user);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

})();


