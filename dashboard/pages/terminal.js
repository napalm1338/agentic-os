// Terminal page — live interactive CLI agents (freebuff, Claude Code, any
// registered CLI) streamed over WebSocket into xterm.js.

const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
const XTERM_JS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js';
const XTERM_FIT = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js';

const termState = {
  panels: {},        // panelId -> {term, fit, ws, agent, state}
  active: null,
};

async function ensureXterm() {
  if (window.Terminal) return;
  if (!document.querySelector(`link[href="${XTERM_CSS}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = XTERM_CSS;
    document.head.appendChild(link);
  }
  await loadScript(XTERM_JS);
  await loadScript(XTERM_FIT);
}

async function renderTerminal() {
  await ensureXterm();
  // Page DOM is rebuilt on every navigation — drop stale xterm instances;
  // panels live on server-side, termReattachPanels restores them via replay.
  for (const p of Object.values(termState.panels)) {
    try { p.ws.close(); } catch (e) {}
    try { p.term.dispose(); } catch (e) {}
  }
  termState.panels = {};
  termState.active = null;
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="terminal-page">
      <div class="terminal-toolbar">
        <div class="terminal-launchers" id="termLaunchers"></div>
        <div class="terminal-actions">
          <button class="btn btn-sm" onclick="termInterrupt()" title="Send Ctrl+C">⛔ Ctrl+C</button>
          <button class="btn btn-sm btn-danger" onclick="termKill()" title="Kill panel">✕ Kill</button>
        </div>
      </div>
      <div class="terminal-tabs" id="termTabs"></div>
      <div class="terminal-host" id="termHost">
        <div class="empty-state">
          <div class="empty-state-icon">🖥</div>
          <div class="empty-state-title">No terminal open</div>
          <div class="empty-state-desc">Launch a CLI agent above — it runs live on a real PTY.</div>
        </div>
      </div>
      <div class="terminal-taskbar">
        <input type="text" id="termTaskInput" placeholder="Describe a task — sent via file handoff to the active agent…"
               onkeydown="if(event.key==='Enter')termSendTask()">
        <button class="btn btn-primary" onclick="termSendTask()">Send task</button>
      </div>
      <div class="terminal-banner" id="termBanner" style="display:none"></div>
    </div>`;
  await termRefreshLaunchers();
  await termReattachPanels();
}

async function termRefreshLaunchers() {
  const data = await api.get('/api/terminals');
  const box = document.getElementById('termLaunchers');
  if (!box) return;
  box.innerHTML = data.agents.map(a => `
    <button class="btn btn-sm ${a.installed ? '' : 'btn-disabled'}"
            ${a.installed ? '' : 'disabled title="CLI not installed"'}
            onclick="termOpen('${a.id}')">▶ ${escapeHtml(a.label)}</button>`).join('');
  return data;
}

async function termReattachPanels() {
  const data = await api.get('/api/terminals');
  for (const p of data.panels) {
    if (!termState.panels[p.id]) termAttach(p.id, p.agent, p.label);
  }
}

async function termOpen(agentId) {
  try {
    const p = await api.post('/api/terminals', { agent: agentId });
    termAttach(p.id, p.agent, p.label);
  } catch (e) {
    showToast(`Failed to open ${agentId}: ${e.message}`, 'error');
  }
}

function termAttach(panelId, agent, label) {
  const host = document.getElementById('termHost');
  const empty = host.querySelector('.empty-state');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'terminal-pane';
  div.id = `pane-${panelId}`;
  div.style.display = 'none';
  host.appendChild(div);

  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    cursorBlink: true,
    theme: { background: '#0d1117' },
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // NOTE: term.open() is deferred to termActivate — opening into a
  // hidden container makes xterm measure 0x0 and render at 80x24.

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${panelId}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'out') term.write(msg.data);
    else if (msg.type === 'state') termOnState(panelId, msg);
    else if (msg.type === 'login_url') termShowLogin(msg.url);
  };
  ws.onclose = () => termOnState(panelId, { state: 'disconnected' });
  term.onData(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'in', data: d })); });

  termState.panels[panelId] = { term, fit, ws, agent, label: label || agent, state: 'launching' };
  termRenderTabs();
  termActivate(panelId);
}

function termActivate(panelId) {
  termState.active = panelId;
  for (const [id, p] of Object.entries(termState.panels)) {
    const pane = document.getElementById(`pane-${id}`);
    if (pane) pane.style.display = id === panelId ? 'block' : 'none';
  }
  const p = termState.panels[panelId];
  if (p) requestAnimationFrame(() => {
    const pane = document.getElementById(`pane-${panelId}`);
    if (pane && !p.opened) { p.term.open(pane); p.opened = true; }
    termFit(p);
    p.term.focus();
  });
  termRenderTabs();
}

function termFit(p) {
  if (!p || !p.opened) return;
  try {
    p.fit.fit();
    if (p.ws.readyState === 1)
      p.ws.send(JSON.stringify({ type: 'resize', cols: p.term.cols, rows: p.term.rows }));
  } catch (e) { /* container not measurable yet */ }
}

if (!window.__termResizeBound) {
  window.__termResizeBound = true;
  window.addEventListener('resize', () => {
    const p = termState.panels[termState.active];
    if (p && document.getElementById(`pane-${termState.active}`)) termFit(p);
  });
}

function termRenderTabs() {
  const tabs = document.getElementById('termTabs');
  if (!tabs) return;
  tabs.innerHTML = Object.entries(termState.panels).map(([id, p]) => `
    <div class="terminal-tab ${id === termState.active ? 'active' : ''} state-${p.state}"
         onclick="termActivate('${id}')">
      <span class="term-dot"></span>${escapeHtml(p.label)}
      <span class="term-state">${p.state}</span>
    </div>`).join('');
}

function termOnState(panelId, msg) {
  const p = termState.panels[panelId];
  if (!p) return;
  p.state = msg.state;
  if (msg.state === 'exited' || msg.state === 'disconnected') {
    try { p.ws.close(); } catch (e) {}
  }
  if (msg.login_url) termShowLogin(msg.login_url);
  termRenderTabs();
}

function termShowLogin(url) {
  const banner = document.getElementById('termBanner');
  if (!banner) return;
  banner.style.display = 'block';
  banner.innerHTML = `🔑 Login required: <a href="${url}" target="_blank" rel="noopener">${url}</a>
    <span class="term-hint">(opens in browser — the terminal continues automatically)</span>`;
  showToast('Agent needs a one-time browser login — see the banner link', 'info');
}

function termSendTask() {
  const input = document.getElementById('termTaskInput');
  const p = termState.panels[termState.active];
  if (!p || !input.value.trim()) return;
  if (p.state !== 'ready') {
    showToast(`Agent is "${p.state}" — wait for the ready prompt`, 'warning');
    return;
  }
  p.ws.send(JSON.stringify({ type: 'task', text: input.value.trim() }));
  input.value = '';
}

function termInterrupt() {
  const p = termState.panels[termState.active];
  if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'interrupt' }));
}

function termKill() {
  const id = termState.active;
  const p = termState.panels[id];
  if (!p) return;
  if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'kill' }));
  try { p.term.dispose(); } catch (e) {}
  const pane = document.getElementById(`pane-${id}`);
  if (pane) pane.remove();
  delete termState.panels[id];
  termState.active = Object.keys(termState.panels)[0] || null;
  if (termState.active) termActivate(termState.active);
  termRenderTabs();
}

window.renderTerminal = renderTerminal;
