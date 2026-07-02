// Memory Galaxy — the vault + brain rendered as a 3D star map.
// Stars = notes (size ∝ links, brightness = recency), lines = wikilinks,
// dim stars = "ghost" notes referenced but not yet written.

// three UMD is loaded BEFORE 3d-force-graph on purpose: the bundle checks
// window.THREE and adopts it, letting us build custom star/nebula objects
// with the exact same three instance the graph renders with.
const THREE_JS = '/dashboard/lib/three.min.js';
const FG3D_JS = '/dashboard/lib/3d-force-graph.min.js';
const MARKED_JS = '/dashboard/lib/marked.min.js';

const galaxyState = { fg: null, poll: null, flight: null, flightAngle: 0, paused: false };

// radial-gradient canvas texture — the universal "glow" building block
function galaxyGlowTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// per-region hue: vault notes burn warm, brain memory runs violet-blue,
// journal days go magenta — recency drives halo strength, not hue
const GALAXY_HUES = {
  vault: '#ffb27d',
  brain: '#8f7bff',
  journal: '#ff7dc0',
  default: '#9aa3cf',
};

function galaxyStarColor(n) {
  if (n.group === 'ghost') return '#565b78';
  if (n.id && n.id.includes('journal/')) return GALAXY_HUES.journal;
  return GALAXY_HUES[n.group] || GALAXY_HUES.default;
}

function galaxyMakeStar(n) {
  const group = new THREE.Group();
  const ghost = n.group === 'ghost';
  const heat = Math.exp(-(n.age_days || 999) / 7);   // 1 fresh → 0 old
  const color = galaxyStarColor(n);
  const r = Math.max(1.4, 1.4 + (n.degree || 0) * 0.55);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(r, 24, 24),
    new THREE.MeshBasicMaterial({
      color: heat > 0.75 && !ghost ? '#fff3e0' : color,
      transparent: ghost, opacity: ghost ? 0.5 : 1 }));
  group.add(core);

  if (!ghost) {
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: galaxyGlowTexture('rgba(255,255,255,0.9)', color),
      color,
      transparent: true,
      opacity: 0.2 + heat * 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const haloScale = r * (3.2 + heat * 2.6);
    halo.scale.set(haloScale, haloScale, 1);
    group.add(halo);
  }
  return group;
}

function galaxyAddNebula(scene) {
  // distant starfield dust
  const starCount = 2500;
  const pos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 1200 + Math.random() * 1800;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0x9aa0d8, size: 1.6, transparent: true, opacity: 0.7,
    sizeAttenuation: true, depthWrite: false })));

  // soft nebula clouds — big additive billboards in violet/magenta/indigo
  const clouds = [
    ['rgba(148, 90, 255, 0.85)', 'rgba(88, 40, 190, 0.35)'],
    ['rgba(255, 90, 220, 0.7)', 'rgba(160, 40, 190, 0.3)'],
    ['rgba(90, 110, 255, 0.7)', 'rgba(40, 50, 190, 0.3)'],
    ['rgba(190, 90, 255, 0.7)', 'rgba(110, 40, 200, 0.3)'],
    ['rgba(255, 140, 200, 0.55)', 'rgba(180, 60, 160, 0.25)'],
    ['rgba(110, 70, 230, 0.75)', 'rgba(60, 30, 160, 0.3)'],
  ];
  clouds.forEach((c, i) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: galaxyGlowTexture(c[0], c[1]),
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const angle = (i / clouds.length) * Math.PI * 2 + Math.random();
    const dist = 550 + Math.random() * 550;
    sprite.position.set(
      Math.cos(angle) * dist,
      (Math.random() - 0.5) * 500,
      Math.sin(angle) * dist);
    const s = 1300 + Math.random() * 1100;
    sprite.scale.set(s, s * (0.55 + Math.random() * 0.5), 1);
    scene.add(sprite);
  });
}

async function renderGalaxy() {
  await loadScript(THREE_JS);
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
    .backgroundColor('#08051a')
    .showNavInfo(false)
    .nodeLabel(n => `${n.title}${n.group === 'ghost' ? ' (unwritten)' : ''}`)
    .nodeThreeObject(n => galaxyMakeStar(n))
    .linkColor(() => '#7a6fd0')
    .linkOpacity(0.45)
    .linkWidth(0.5)
    .onNodeClick(n => galaxyOpenNote(n))
    .onEngineStop(() => {});
  galaxyState.fg = fg;
  galaxyAddNebula(fg.scene());

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
