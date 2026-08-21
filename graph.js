/**
 * SmartHub Knowledge Base - Multi-Cluster Force Graph Engine
 * Beautiful radial cluster layout for enterprise knowledge graphs
 */

class KnowledgeGraph {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.options = Object.assign({
      onNodeClick: null,
      onNodeDoubleClick: null
    }, options);

    this.canvas = this.container.querySelector('canvas') || document.createElement('canvas');
    this.canvas.classList.add('modern-graph-canvas');
    if (!this.canvas.parentNode) {
      this.container.appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext('2d');

    this.nodes = [];
    this.edges = [];
    this.nodeMap = new Map();
    this.selectedNode = null;
    this.hoveredNode = null;
    this.draggedNode = null;
    this.filterTopic = 'All';
    this.time = 0;
    this.alpha = 1.0;
    this.physicsRunning = true;
    this.animFrame = null;

    this.transform = { x: 0, y: 0, k: 0.85 };
    this.targetTransform = { x: 0, y: 0, k: 0.85 };
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };

    this.particles = [];
    this.palette = this.readPalette();

    this.initCanvasSize();
    this.initEvents();
  }

  // Canvas can't inherit CSS, so the whole graph palette is read out of the
  // --graph-* variables in styles.css. refreshPalette() is called on theme
  // change so the canvas follows the theme like the rest of the DOM.
  readPalette() {
    const styles = getComputedStyle(document.documentElement);
    const v = name => styles.getPropertyValue(name).trim();
    return {
      nodeDefault: v('--graph-node-default'),
      nodeLabel: v('--graph-node-label'),
      nodeHalo: v('--graph-node-halo'),
      nodeActive: v('--graph-node-active'),
      edge: v('--graph-edge'),
      edgeActive: v('--graph-edge-active'),
      edgeRelated: v('--graph-edge-related'),
      particle: v('--graph-particle'),
      particleRelated: v('--graph-particle-related'),
      tooltipBg: v('--graph-tooltip-bg'),
      grid: v('--graph-grid')
    };
  }

  refreshPalette() {
    this.palette = this.readPalette();
  }

  initCanvasSize() {
    if (!this.container) return;
    // clientWidth/Height, not getBoundingClientRect — the container is bordered,
    // and the rect includes the border, which would make the canvas overflow it.
    // Follow the container: a hard minimum wider than the viewport would make the
    // canvas overflow horizontally on phones and tablets.
    this.width = Math.max(280, this.container.clientWidth || 1100);
    this.height = Math.max(320, this.container.clientHeight || 700);

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  onShow() {
    this.initCanvasSize();
    this.filterAndRebuild();
    this.centerGraph(true);
    this.alpha = 1.0;
    this.startSimulation();
  }

  setData(data) {
    if (!data || !data.graph) return;
    this.rawNodes = data.graph.nodes || [];
    this.rawEdges = data.graph.edges || [];
    this.topics = data.topics || [];
    this.filterAndRebuild();
    this.centerGraph(true);
    this.startSimulation();
  }

  filterByTopic(topic) {
    this.filterTopic = topic || 'All';
    this.filterAndRebuild();
    this.alpha = 0.8;
  }

  layoutWorld(nodeCount) {
    const need = Math.sqrt(Math.max(1, nodeCount)) * 95;
    return {
      w: Math.max(this.width || 1100, need),
      h: Math.max(this.height || 700, need)
    };
  }

  filterAndRebuild() {
    if (!this.rawNodes || this.rawNodes.length === 0) return;

    this.nodeMap.clear();

    // Filter nodes
    let activeNodes = this.rawNodes.filter(n => {
      if (this.filterTopic === 'All') return true;
      return n.topic === this.filterTopic;
    });

    // The layout lives in its own world, sized for the node count rather than
    // for the canvas. Clamping 500 nodes into a phone-sized box used to jam
    // them into a ring along the edges; now the world stays roomy and the view
    // zooms to fit it (and the user can pinch/pan in).
    this.world = this.layoutWorld(activeNodes.length);
    const w = this.world.w;
    const h = this.world.h;
    const cx = w / 2;
    const cy = h / 2;

    const activeNodeIds = new Set(activeNodes.map(n => n.id));

    // Filter edges
    let activeEdges = (this.rawEdges || []).filter(e => {
      const src = e.source.id || e.source;
      const tgt = e.target.id || e.target;
      return activeNodeIds.has(src) && activeNodeIds.has(tgt);
    });

    // Compute Distinct Topics for Cluster Anchors
    const activeTopics = Array.from(new Set(activeNodes.map(n => n.topic))).sort();
    const hubAnchors = {};
    // The biggest topic's spiral has to fit between its anchor and the world
    // wall, otherwise its outer notes get clamped and stack up as straight
    // lines along the edges.
    const biggestTopic = Math.max(1, ...activeTopics.map(
      t => activeNodes.filter(n => n.topic === t && !n.isHub).length));
    const maxOrbit = 60 + Math.sqrt(biggestTopic) * 26;
    const clusterRingRadius = activeTopics.length > 1
      ? Math.max(0, Math.min(Math.min(w, h) * 0.38, Math.min(w, h) / 2 - maxOrbit - 40))
      : 0;
    
    activeTopics.forEach((tName, i) => {
      const angle = (i / Math.max(1, activeTopics.length)) * (2 * Math.PI) - (Math.PI / 2);
      hubAnchors[tName] = {
        x: cx + Math.cos(angle) * clusterRingRadius,
        y: cy + Math.sin(angle) * clusterRingRadius
      };
    });

    // Group child nodes per topic to space them nicely in a mini-orbit
    const topicNoteCounters = {};

    this.nodes = activeNodes.map(n => {
      const anchor = hubAnchors[n.topic] || { x: cx, y: cy };
      let initX, initY;

      if (n.isHub) {
        initX = anchor.x;
        initY = anchor.y;
      } else {
        const count = topicNoteCounters[n.topic] || 0;
        topicNoteCounters[n.topic] = count + 1;
        // Golden-angle phyllotaxis: an even spiral around the topic hub whatever
        // the note count, instead of a few fixed orbits that overlap hard once a
        // topic passes ~50 notes.
        const orbitAngle = count * 2.39996;
        const orbitDist = 60 + Math.sqrt(count) * 26;
        initX = anchor.x + Math.cos(orbitAngle) * orbitDist;
        initY = anchor.y + Math.sin(orbitAngle) * orbitDist;
      }

      return {
        id: n.id,
        name: n.name,
        label: n.label,
        type: n.type,
        topic: n.topic,
        noteId: n.noteId,
        radius: n.isHub ? 20 : (n.type === 'hub' ? 13 : 9),
        color: n.color || this.palette.nodeDefault,
        isHub: n.isHub,
        summary: n.summary || '',
        tags: n.tags || [],
        x: Math.max(30, Math.min(w - 30, initX)),
        y: Math.max(30, Math.min(h - 30, initY)),
        vx: 0,
        vy: 0,
        fx: null,
        fy: null
      };
    });

    this.nodes.forEach(n => this.nodeMap.set(n.id, n));

    this.edges = activeEdges.map(e => ({
      source: this.nodeMap.get(e.source.id || e.source),
      target: this.nodeMap.get(e.target.id || e.target),
      type: e.type,
      value: e.value || 1
    })).filter(e => e.source && e.target);

    // Particle flow
    this.particles = [];
    this.edges.forEach(edge => {
      const isRelated = edge.type === 'related';
      if (isRelated || Math.random() < 0.6) {
        this.particles.push({
          edge,
          progress: Math.random(),
          speed: 0.003 + Math.random() * 0.002,
          size: isRelated ? 2.2 : 1.5,
          related: isRelated
        });
      }
    });
  }

  centerGraph(immediate = false) {
    this.userAdjustedView = false;
    const cw = this.width || 1100;
    const ch = this.height || 700;

    // Fit what actually exists: the nodes' bounding box, not the (deliberately
    // roomy) layout world, so a settled graph fills the canvas.
    let minX, minY, maxX, maxY;
    if (this.nodes && this.nodes.length) {
      minX = minY = Infinity;
      maxX = maxY = -Infinity;
      this.nodes.forEach(n => {
        minX = Math.min(minX, n.x - n.radius);
        minY = Math.min(minY, n.y - n.radius);
        maxX = Math.max(maxX, n.x + n.radius);
        maxY = Math.max(maxY, n.y + n.radius);
      });
    } else {
      const world = this.world || { w: cw, h: ch };
      minX = 0; minY = 0; maxX = world.w; maxY = world.h;
    }

    const pad = 24;
    const bw = Math.max(1, maxX - minX) + pad * 2;
    const bh = Math.max(1, maxY - minY) + pad * 2;
    const k = Math.max(0.15, Math.min(1.4, Math.min(cw / bw, ch / bh)));
    const x = cw / 2 - ((minX + maxX) / 2) * k;
    const y = ch / 2 - ((minY + maxY) / 2) * k;

    this.targetTransform.x = x;
    this.targetTransform.y = y;
    this.targetTransform.k = k;
    if (immediate) {
      this.transform.x = x;
      this.transform.y = y;
      this.transform.k = k;
    }
  }

  zoomIn() { this.zoomAt(this.width / 2, this.height / 2, 1.25); }
  zoomOut() { this.zoomAt(this.width / 2, this.height / 2, 0.8); }

  zoomAt(screenX, screenY, factor) {
    this.userAdjustedView = true;
    const newK = Math.max(0.15, Math.min(3.0, this.targetTransform.k * factor));
    const worldX = (screenX - this.targetTransform.x) / this.targetTransform.k;
    const worldY = (screenY - this.targetTransform.y) / this.targetTransform.k;
    this.targetTransform.k = newK;
    this.targetTransform.x = screenX - worldX * newK;
    this.targetTransform.y = screenY - worldY * newK;
  }

  togglePhysics() {
    this.physicsRunning = !this.physicsRunning;
    if (this.physicsRunning) this.alpha = 0.5;
  }

  stopSimulation() {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  onHide() {
    this.stopSimulation();
  }

  startSimulation() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    let idleFrames = 0;
    const loop = () => {
      const isMoving = this.tick();
      this.render();
      if (!isMoving && this.alpha < 0.003 && !this.draggedNode && !this.isPanning) {
        idleFrames++;
        // The layout has stopped moving — refit once so the settled graph is
        // framed, not the spread it happened to have on the first frame.
        if (idleFrames === 1 && !this.userAdjustedView) this.centerGraph();
        if (idleFrames > 40) {
          this.stopSimulation();
          return;
        }
      } else {
        idleFrames = 0;
      }
      this.animFrame = requestAnimationFrame(loop);
    };
    this.animFrame = requestAnimationFrame(loop);
  }

  tick() {
    this.time += 0.02;

    const dx = this.targetTransform.x - this.transform.x;
    const dy = this.targetTransform.y - this.transform.y;
    const dk = this.targetTransform.k - this.transform.k;

    this.transform.x += dx * 0.25;
    this.transform.y += dy * 0.25;
    this.transform.k += dk * 0.25;

    const isTransformMoving = Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || Math.abs(dk) > 0.0005;

    this.particles.forEach(p => {
      p.progress += p.speed;
      if (p.progress > 1) p.progress = 0;
    });

    if (!this.physicsRunning && !this.draggedNode) return isTransformMoving;
    if (this.alpha < 0.001) return isTransformMoving;

    const nodes = this.nodes;
    const edges = this.edges;
    const world = this.world || { w: this.width || 1100, h: this.height || 700 };
    const w = world.w;
    const h = world.h;
    const cx = w / 2;
    const cy = h / 2;

    // 1. Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      const u = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const v = nodes[j];
        const dx = v.x - u.x;
        const dy = v.y - u.y;
        const distSq = dx * dx + dy * dy || 1;
        const dist = Math.sqrt(distSq);

        // Short range: a 140px bubble around each of 300+ sibling notes adds up to
        // more area than any canvas has, and the surplus pressure used to push
        // whole topics out to the world wall.
        if (dist < 70) {
          const force = Math.min(4, 260 / distSq) * this.alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          if (!u.fx && !u.isHub) { u.vx -= fx; u.vy -= fy; }
          if (!v.fx && !v.isHub) { v.vx += fx; v.vy += fy; }
        }
      }
    }

    // 2. Spring attraction along edges
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const u = e.source;
      const v = e.target;
      const dx = v.x - u.x;
      const dy = v.y - u.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetDist = e.type === 'hierarchy' ? 70 : 100;
      const force = (dist - targetDist) * 0.03 * this.alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      // Opposite signs: the spring pulls the two ends together. Applying the
      // same sign to both made every edge shove its target outward instead,
      // which drifted most of the graph into the world wall.
      if (!u.fx && !u.isHub) { u.vx += fx; u.vy += fy; }
      if (!v.fx && !v.isHub) { v.vx -= fx; v.vy -= fy; }
    }

    // 3. Center gravity
    nodes.forEach(n => {
      if (!n.fx && !n.isHub) {
        n.vx += (cx - n.x) * 0.002 * this.alpha;
        n.vy += (cy - n.y) * 0.002 * this.alpha;
      }
    });

    // 4. Damping and bounds
    const damping = 0.85;
    nodes.forEach(n => {
      if (n.fx !== null && n.fx !== undefined) {
        n.x = n.fx;
        n.y = n.fy;
      } else {
        n.vx = Math.max(-10, Math.min(10, n.vx * damping));
        n.vy = Math.max(-10, Math.min(10, n.vy * damping));
        n.x += n.vx;
        n.y += n.vy;

        // Soft walls: push back over the last 120px instead of snapping to the
        // edge, which used to stack escapees into straight lines along the border.
        const soft = 120;
        const lo = n.radius + 15;
        const hiX = w - n.radius - 15;
        const hiY = h - n.radius - 15;
        if (n.x < lo + soft) n.vx += (lo + soft - n.x) * 0.02;
        if (n.x > hiX - soft) n.vx -= (n.x - (hiX - soft)) * 0.02;
        if (n.y < lo + soft) n.vy += (lo + soft - n.y) * 0.02;
        if (n.y > hiY - soft) n.vy -= (n.y - (hiY - soft)) * 0.02;

        n.x = Math.max(lo, Math.min(hiX, n.x));
        n.y = Math.max(lo, Math.min(hiY, n.y));
      }
    });

    this.alpha *= 0.99;
  }

  render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.width || 1100;
    const h = this.height || 700;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.k, this.transform.k);

    this.drawGrid(ctx, w, h);

    const highlightedNodeIds = new Set();
    if (this.hoveredNode || this.selectedNode) {
      const active = this.hoveredNode || this.selectedNode;
      highlightedNodeIds.add(active.id);
      this.edges.forEach(e => {
        if (e.source.id === active.id) highlightedNodeIds.add(e.target.id);
        if (e.target.id === active.id) highlightedNodeIds.add(e.source.id);
      });
    }

    // 1. Edges
    this.edges.forEach(e => {
      const isConnected = highlightedNodeIds.size === 0 || 
        (highlightedNodeIds.has(e.source.id) && highlightedNodeIds.has(e.target.id));

      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);

      if (e.type === 'hierarchy') {
        ctx.strokeStyle = isConnected ? this.palette.edgeActive : this.palette.edge;
        ctx.lineWidth = isConnected ? 1.5 : 0.8;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = isConnected ? this.palette.edgeRelated : this.palette.edge;
        ctx.lineWidth = isConnected ? 1.8 : 0.8;
        ctx.setLineDash([4, 3]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // 2. Flow Particles
    this.particles.forEach(p => {
      const isConnected = highlightedNodeIds.size === 0 || 
        (highlightedNodeIds.has(p.edge.source.id) && highlightedNodeIds.has(p.edge.target.id));

      if (isConnected) {
        const px = p.edge.source.x + (p.edge.target.x - p.edge.source.x) * p.progress;
        const py = p.edge.source.y + (p.edge.target.y - p.edge.source.y) * p.progress;

        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.related ? this.palette.particleRelated : this.palette.particle;
        ctx.fill();
      }
    });

    // 3. Nodes
    const k = this.transform.k;
    const hasActive = highlightedNodeIds.size > 0;
    // A small graph, or a zoomed-in one, can carry every label. Otherwise only
    // hubs (and, while something is hovered/selected, its neighbourhood).
    const labelEverything = this.nodes.length <= 60 || k >= 1.5;
    const showLabel = (n, isSelected, isHovered, isHighlighted) => {
      if (isSelected || isHovered) return true;
      if (hasActive) return isHighlighted;
      if (labelEverything) return true;
      return n.isHub;
    };

    this.nodes.forEach(n => {
      const isHighlighted = highlightedNodeIds.size === 0 || highlightedNodeIds.has(n.id);
      const isSelected = this.selectedNode && this.selectedNode.id === n.id;
      const isHovered = this.hoveredNode && this.hoveredNode.id === n.id;

      ctx.save();
      ctx.globalAlpha = isHighlighted ? 1.0 : 0.2;

      // Outer Glow
      if (isSelected || isHovered || n.isHub) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + (isSelected ? 7 : 4), 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.globalAlpha = isHighlighted ? 0.25 : 0.04;
        ctx.fill();
        ctx.globalAlpha = isHighlighted ? 1.0 : 0.2;
      }

      // Circle Body
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();

      ctx.strokeStyle = isSelected || n.isHub ? this.palette.nodeActive : this.palette.nodeHalo;
      ctx.lineWidth = isSelected ? 3 : (n.isHub ? 2 : 1);
      ctx.stroke();

      if (n.isHub) {
        ctx.fillStyle = this.palette.nodeActive;
        ctx.beginPath();
        ctx.arc(n.x, n.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label text — level of detail. Painting 500 labels at once turns the
      // canvas into a wall of chips (worst on a phone), so labels are earned:
      // hubs and whatever is active always, everything else only once the user
      // has zoomed in or the graph is small enough to be legible.
      if (showLabel(n, isSelected, isHovered, isHighlighted)) {
        ctx.font = n.isHub ? 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif' : '9.5px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const labelY = n.y + n.radius + 9;
        const metrics = ctx.measureText(n.label);
        const bgW = metrics.width + 8;
        const bgH = 14;

        ctx.fillStyle = this.palette.tooltipBg;
        ctx.beginPath();
        ctx.roundRect(n.x - bgW / 2, labelY - bgH / 2, bgW, bgH, 3);
        ctx.fill();

        ctx.fillStyle = isSelected || isHovered ? this.palette.nodeActive : this.palette.nodeLabel;
        ctx.fillText(n.label, n.x, labelY);
      }

      ctx.restore();
    });

    ctx.restore();
  }

  drawGrid(ctx, w, h) {
    const gridSize = 40;
    const startX = Math.floor((-this.transform.x / this.transform.k) / gridSize) * gridSize;
    const endX = startX + (w / this.transform.k) + gridSize * 2;
    const startY = Math.floor((-this.transform.y / this.transform.k) / gridSize) * gridSize;
    const endY = startY + (h / this.transform.k) + gridSize * 2;

    ctx.strokeStyle = this.palette.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let x = startX; x <= endX; x += gridSize) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y += gridSize) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();
  }

  initEvents() {
    window.addEventListener('resize', () => {
      this.initCanvasSize();
      this.render();
    });

    const getPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.clientX || (e.touches && e.touches[0].clientX);
      const clientY = e.clientY || (e.touches && e.touches[0].clientY);
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      const worldX = (screenX - this.transform.x) / this.transform.k;
      const worldY = (screenY - this.transform.y) / this.transform.k;
      return { screenX, screenY, worldX, worldY };
    };

    const findNodeAt = (wx, wy) => {
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const n = this.nodes[i];
        const dx = n.x - wx;
        const dy = n.y - wy;
        if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) {
          return n;
        }
      }
      return null;
    };

    this.canvas.addEventListener('mousedown', (e) => {
      const { screenX, screenY, worldX, worldY } = getPos(e);
      const hitNode = findNodeAt(worldX, worldY);

      if (hitNode) {
        this.draggedNode = hitNode;
        this.draggedNode.fx = hitNode.x;
        this.draggedNode.fy = hitNode.y;
        this.alpha = 0.35;
      } else {
        this.isPanning = true;
        this.userAdjustedView = true;
        this.panStart = { x: screenX - this.targetTransform.x, y: screenY - this.targetTransform.y };
      }
    });

    window.addEventListener('mousemove', (e) => {
      const { screenX, screenY, worldX, worldY } = getPos(e);

      if (this.draggedNode) {
        this.draggedNode.fx = worldX;
        this.draggedNode.fy = worldY;
        this.alpha = 0.3;
      } else if (this.isPanning) {
        this.targetTransform.x = screenX - this.panStart.x;
        this.targetTransform.y = screenY - this.panStart.y;
      } else {
        const hitNode = findNodeAt(worldX, worldY);
        if (hitNode !== this.hoveredNode) {
          this.hoveredNode = hitNode;
          this.canvas.style.cursor = hitNode ? 'pointer' : 'grab';
        }
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.draggedNode) {
        this.draggedNode.fx = null;
        this.draggedNode.fy = null;
        this.draggedNode = null;
      }
      this.isPanning = false;
    });

    this.canvas.addEventListener('click', (e) => {
      const { worldX, worldY } = getPos(e);
      const hitNode = findNodeAt(worldX, worldY);
      this.selectedNode = hitNode;
      if (this.options.onNodeClick) {
        this.options.onNodeClick(hitNode);
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const { worldX, worldY } = getPos(e);
      const hitNode = findNodeAt(worldX, worldY);
      if (hitNode && this.options.onNodeDoubleClick) {
        this.options.onNodeDoubleClick(hitNode);
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      this.zoomAt(screenX, screenY, factor);
    }, { passive: false });
  }
}

window.KnowledgeGraph = KnowledgeGraph;
