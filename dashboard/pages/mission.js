// Mission Control — Julian's Agent OS layout: left rail of live agent
// status, center chat, right goals tracker, bottom daily journal.

const missionState = { agent: localStorage.getItem('missionAgent') || 'claude', timer: null, busy: false };

async function renderMission() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="mission-grid">
      <aside class="mission-rail" id="missionAgents"><div class="loading-spinner"></div></aside>
      <section class="mission-chat">
        <div class="mission-chat-log" id="missionChatLog"></div>
        <div class="mission-chat-bar">
          <select id="missionAgentSel" onchange="missionSetAgent(this.value)"></select>
          <input type="text" id="missionChatInput" placeholder="Brief your agent…"
                 onkeydown="if(event.key==='Enter')missionSend()">
          <button class="btn btn-primary" onclick="missionSend()" id="missionSendBtn">Send</button>
        </div>
      </section>
      <aside class="mission-goals">
        <div class="mission-panel-title">🎯 Goals</div>
        <div id="missionGoalList"></div>
        <div class="mission-goal-add">
          <input type="text" id="missionGoalInput" placeholder="Add a goal…"
                 onkeydown="if(event.key==='Enter')missionAddGoal()">
        </div>
      </aside>
      <section class="mission-journal">
        <div class="mission-panel-title">📓 Today — what got built, what got blocked
          <span class="mission-journal-actions">
            <button class="btn btn-sm" onclick="missionQuickLine('✅ Built: ')">+ Built</button>
            <button class="btn btn-sm" onclick="missionQuickLine('🚧 Blocked: ')">+ Blocked</button>
            <button class="btn btn-sm btn-primary" onclick="missionSaveJournal()">Save</button>
          </span>
        </div>
        <textarea id="missionJournalText" spellcheck="false"></textarea>
      </section>
    </div>`;
  await Promise.all([missionRefreshAgents(), missionLoadGoals(), missionLoadJournal(), missionLoadHistory()]);
  clearInterval(missionState.timer);
  missionState.timer = setInterval(() => {
    if (document.getElementById('missionAgents')) missionRefreshAgents();
    else clearInterval(missionState.timer);
  }, 5000);
}

// ── Agents rail ──────────────────────────────────────────────────

async function missionRefreshAgents() {
  try {
    const s = await api.getStatus();
    const box = document.getElementById('missionAgents');
    if (!box) return;
    box.innerHTML = `<div class="mission-panel-title">🛰 Agents</div>` + s.agents.map(a => `
      <div class="mission-agent-card ${a.status}">
        <span class="agent-dot ${a.status}"></span>
        <span class="mission-agent-name">${escapeHtml(a.name)}</span>
        <span class="mission-agent-status">${a.status}</span>
      </div>`).join('') +
      `<a class="btn btn-sm mission-terminal-link" href="#terminal">🖥 Open Terminal →</a>`;
    const sel = document.getElementById('missionAgentSel');
    if (sel && !sel.options.length) {
      const chatAgents = s.agents;   // freebuff included — it IS the command agent
      sel.innerHTML = chatAgents.map(a =>
        `<option value="${a.name}" ${a.name === missionState.agent ? 'selected' : ''}>${a.name}</option>`).join('');
    }
  } catch (e) { /* transient */ }
}

function missionSetAgent(name) {
  missionState.agent = name;
  localStorage.setItem('missionAgent', name);
}

// ── Chat ─────────────────────────────────────────────────────────

function missionBubble(role, text) {
  const log = document.getElementById('missionChatLog');
  if (!log) return;
  const div = document.createElement('div');
  div.className = `mission-msg ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function missionLoadHistory() {
  try {
    const h = await api.getChatHistory();
    (h.messages || []).slice(-20).forEach(m =>
      missionBubble(m.role === 'user' ? 'user' : 'agent', m.content || m.text || ''));
  } catch (e) { /* none */ }
}

async function missionSend() {
  const input = document.getElementById('missionChatInput');
  const text = input.value.trim();
  if (!text || missionState.busy) return;
  input.value = '';
  missionBubble('user', text);
  const pending = missionBubble('agent', '…');
  missionState.busy = true;
  document.getElementById('missionSendBtn').disabled = true;
  try {
    const r = await api.chat(missionState.agent, text);
    pending.textContent = (r.response && r.response.content) || r.reply ||
      JSON.stringify(r).slice(0, 400);
  } catch (e) {
    pending.textContent = `⚠ ${e.message}`;
  } finally {
    missionState.busy = false;
    const btn = document.getElementById('missionSendBtn');
    if (btn) btn.disabled = false;
  }
}

// ── Goals ────────────────────────────────────────────────────────

async function missionLoadGoals() {
  try {
    const data = await api.getGoals();
    const box = document.getElementById('missionGoalList');
    if (!box) return;
    const active = (data.goals || []).filter(g => g.status !== 'done' && g.status !== 'archived');
    box.innerHTML = active.length ? active.map(g => `
      <div class="mission-goal" title="${escapeHtml(g.description || '')}">
        <div class="mission-goal-row">
          <span class="mission-goal-title">${escapeHtml(g.title)}</span>
          <span class="mission-goal-pct">${g.progress || 0}%</span>
        </div>
        <div class="mission-goal-bar"><div style="width:${g.progress || 0}%"></div></div>
      </div>`).join('')
      : `<div class="mission-empty">No active goals</div>`;
  } catch (e) { /* none */ }
}

async function missionAddGoal() {
  const input = document.getElementById('missionGoalInput');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await api.createGoal({ title, description: '', category: 'general', target_date: null });
  missionLoadGoals();
}

// ── Journal ──────────────────────────────────────────────────────

function missionToday() { return new Date().toISOString().slice(0, 10); }

async function missionLoadJournal() {
  try {
    const e = await api.getJournalEntry(missionToday());
    const ta = document.getElementById('missionJournalText');
    if (ta) ta.value = e.content || '';
  } catch (err) { /* no entry yet */ }
}

function missionQuickLine(prefix) {
  const ta = document.getElementById('missionJournalText');
  if (!ta) return;
  ta.value = (ta.value ? ta.value.replace(/\n*$/, '\n') : '') + prefix;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}

async function missionSaveJournal() {
  const ta = document.getElementById('missionJournalText');
  if (!ta) return;
  await api.saveJournalEntry(missionToday(), ta.value);
  showToast('Journal saved', 'success');
}

window.renderMission = renderMission;
