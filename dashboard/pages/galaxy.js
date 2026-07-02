// Memory Galaxy — the vault + brain rendered as a 3D star map.
// Stars = notes (size ∝ links, brightness = recency), lines = wikilinks,
// dim stars = "ghost" notes referenced but not yet written.

const FG3D_JS = 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.79.0/dist/3d-force-graph.min.js';
const MARKED_JS = 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js';

const galaxyState = { fg: null, poll: null, flight: null, flightAngle: 0, paused: false };

async function renderGalaxy() {
  await loadScript(FG3D_JS);
  await loadScript(MARKED_JS);
  galaxyDestroy();

  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="galaxy-wrap">
      <div class="galaxy-hud">
        <span id="galaxyStats" class="galaxy-stats">…</span>
        <span class="galaxy-hud-actions">
          <button class="btn btn-sm" id="galaxyFlightBtn" onclick="galaxyToggleFlight()">✈ Auto-flight</button>
          <span class="galaxy-hint">drag to orbit · scroll to zoom · click a star to read · Space pauses flight</span>
        </span>
      </div>
      <div id="galaxy3d" class="galaxy-canvas"></div>
      <aside class="galaxy-drawer" id="galaxyDrawer">
        <div class="galaxy-drawer-head">
          <span id="galaxyNoteTitle"></span>
          <button class="btn btn-sm" onclick="galaxyCloseNote()">✕</button>
        </div>
        <div class="galaxy-drawer-body" id="galaxyNoteBody"></div>
      </aside>
    </div>`;

  const el = document.getElementById('galaxy3d');
  const themeAccent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#6c5ce7';

  const fg = ForceGraph3D()(el)
    .backgroundColor('#05060f')
    .showNavInfo(false)
    .nodeLabel(n => `${n.title}${n.group === 'ghost' ? ' (unwritten)' : ''}`)
    .nodeColor(n => galaxyColor(n, themeAccent))
    .nodeVal(n => Math.max(1.5, 1.5 + n.degree * 1.2))
    .nodeOpacity(0.95)
    .linkColor(() => '#3d4470')
    .linkOpacity(0.35)
    .linkWidth(0.4)
    .onNodeClick(n => galaxyOpenNote(n))
    .onEngineStop(() => {});
  galaxyState.fg = fg;

  const fitSize = () => {
    fg.width(el.clientWidth);
    fg.height(el.clientHeight);
  };
  fitSize();
  window.addEventListener('resize', fitSize);

  await galaxyLoad(true);
  galaxyState.poll = setInterval(async () => {
    if (!document.getElementById('galaxy3d')) { galaxyDestroy(); return; }
    await galaxyLoad(false);
  }, 4000);

  window.addEventListener('keydown', galaxyKeyHandler);
}

function galaxyKeyHandler(e) {
  if (e.code === 'Space' && document.getElementById('galaxy3d') &&
      galaxyState.flight) {
    e.preventDefault();
    galaxyState.paused = !galaxyState.paused;
  }
}

function galaxyColor(n, accent) {
  if (n.group === 'ghost') return '#3a3f55';
  // recency → brightness: fresh notes burn warm-bright, old ones cool down
  const heat = Math.exp(-(n.age_days || 999) / 7);
  if (n.age_days < 2) return '#ffe9c9';          // <48h: bright halo star
  if (heat > 0.3) return accent;
  if (n.group === 'brain') return '#7a86c2';
  return '#9aa3cf';
}

let galaxyGeneration = null;

async function galaxyLoad(first) {
  try {
    const g = await api.get('/api/vault/graph');
    const stats = document.getElementById('galaxyStats');
    if (stats) stats.textContent =
      `⭐ ${g.counts.notes} notes · ${g.counts.links} links · ${g.counts.ghosts} unwritten`;
    const sig = JSON.stringify([g.counts, g.nodes.map(n => [n.id, n.mtime]).sort()]);
    if (!first && sig === galaxyGeneration) return;   // nothing changed
    galaxyGeneration = sig;
    galaxyState.fg.graphData({
      nodes: g.nodes.map(n => ({ ...n })),
      links: g.links.map(l => ({ ...l })),
    });
  } catch (e) { /* transient */ }
}

async function galaxyOpenNote(n) {
  if (n.group === 'ghost') {
    showToast(`"${n.title}" is referenced but not written yet`, 'info');
    return;
  }
  try {
    const note = await api.get(`/api/vault/note?id=${encodeURIComponent(n.id)}`);
    document.getElementById('galaxyNoteTitle').textContent = note.title;
    const body = document.getElementById('galaxyNoteBody');
    let html = marked.parse(note.markdown);
    // wikilinks → clickable spans that fly to that star
    html = html.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g,
      (m, target, label) =>
        `<a href="#" class="galaxy-wikilink" data-target="${escapeHtml(target.trim())}">${escapeHtml(label || target)}</a>`);
    body.innerHTML = html;
    body.querySelectorAll('.galaxy-wikilink').forEach(a =>
      a.addEventListener('click', ev => {
        ev.preventDefault();
        galaxyFlyTo(a.dataset.target);
      }));
    document.getElementById('galaxyDrawer').classList.add('open');
    // fly the camera to the clicked star
    const d = 60;
    const ratio = 1 + d / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
    galaxyState.fg.cameraPosition(
      { x: n.x * ratio, y: n.y * ratio, z: n.z * ratio }, n, 900);
  } catch (e) {
    showToast(`Could not open note: ${e.message}`, 'error');
  }
}

function galaxyFlyTo(title) {
  const { nodes } = galaxyState.fg.graphData();
  const t = title.toLowerCase();
  const node = nodes.find(n =>
    n.title.toLowerCase() === t || n.id.toLowerCase().includes(t));
  if (node) galaxyOpenNote(node);
}

function galaxyCloseNote() {
  document.getElementById('galaxyDrawer').classList.remove('open');
}

function galaxyToggleFlight() {
  const btn = document.getElementById('galaxyFlightBtn');
  if (galaxyState.flight) {
    clearInterval(galaxyState.flight);
    galaxyState.flight = null;
    if (btn) btn.classList.remove('btn-primary');
    return;
  }
  galaxyState.paused = false;
  if (btn) btn.classList.add('btn-primary');
  galaxyState.flight = setInterval(() => {
    if (galaxyState.paused || !galaxyState.fg) return;
    galaxyState.flightAngle += 0.0035;
    const r = 320;
    galaxyState.fg.cameraPosition({
      x: r * Math.sin(galaxyState.flightAngle),
      y: 55 * Math.sin(galaxyState.flightAngle / 3),
      z: r * Math.cos(galaxyState.flightAngle),
    });
  }, 40);
}

function galaxyDestroy() {
  clearInterval(galaxyState.poll);
  clearInterval(galaxyState.flight);
  galaxyState.poll = galaxyState.flight = null;
  window.removeEventListener('keydown', galaxyKeyHandler);
  if (galaxyState.fg) { try { galaxyState.fg._destructor(); } catch (e) {} }
  galaxyState.fg = null;
  galaxyGeneration = null;
}

window.renderGalaxy = renderGalaxy;
