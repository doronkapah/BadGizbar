'use strict';

// ─── FIREBASE CONFIG ──────────────────────────────────────────────────────────
// Replace every "REPLACE_ME" with values from your Firebase project.
// console.firebase.google.com → Project settings → Your apps → SDK setup
const FIREBASE_CONFIG = {
  apiKey:            'REPLACE_ME',
  authDomain:        'REPLACE_ME',
  databaseURL:       'REPLACE_ME',   // https://your-project-default-rtdb.firebaseio.com
  projectId:         'REPLACE_ME',
  storageBucket:     'REPLACE_ME',
  messagingSenderId: 'REPLACE_ME',
  appId:             'REPLACE_ME'
};
// ─────────────────────────────────────────────────────────────────────────────

const CHIPS_PER_ILS = 10;   // 500 chips per ₪50
const FIRST_BUYIN   = 50;

let db;
let currentSessionId  = null;
let sessionUnsubscribe = null;
let liveData          = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────

function init() {
  if (FIREBASE_CONFIG.apiKey === 'REPLACE_ME') {
    document.getElementById('setup-overlay').classList.remove('hidden');
    return;
  }

  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.database();

  bindStaticEvents();
  showLanding();
}

// ─── VIEWS ────────────────────────────────────────────────────────────────────

function showLanding() {
  document.getElementById('view-landing').classList.remove('hidden');
  document.getElementById('view-session').classList.add('hidden');
  document.getElementById('join-code-input').value = '';
  clearError('join-error');
}

function showSessionView() {
  document.getElementById('view-landing').classList.add('hidden');
  document.getElementById('view-session').classList.remove('hidden');
}

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes 0/O/I/1
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function createSession() {
  const id = generateCode();
  await db.ref(`sessions/${id}/currentEvening`).set({
    date: formatDate(),
    players: null
  });
  attachListener(id);
}

async function joinSession(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (code.length !== 4) return 'Enter a 4-letter session code.';

  const snap = await db.ref(`sessions/${code}`).get();
  if (!snap.exists()) return `Session "${code}" not found.`;

  attachListener(code);
  return null;
}

function attachListener(id) {
  if (sessionUnsubscribe) sessionUnsubscribe();

  currentSessionId = id;
  document.getElementById('session-id-display').textContent = id;
  showSessionView();

  const ref     = db.ref(`sessions/${id}`);
  const handler = ref.on('value', snap => {
    liveData = snap.val();
    renderFromLiveData();
  });
  sessionUnsubscribe = () => ref.off('value', handler);
}

function leaveSession() {
  if (sessionUnsubscribe) sessionUnsubscribe();
  currentSessionId   = null;
  sessionUnsubscribe = null;
  liveData           = null;
  showLanding();
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

async function addPlayer(name) {
  const trimmed = name.trim();
  if (!trimmed) return 'Please enter a player name.';

  if (getPlayers().some(p => p.name.toLowerCase() === trimmed.toLowerCase()))
    return `"${trimmed}" is already in this session.`;

  const playerId = db.ref().push().key;
  const buyinId  = db.ref().push().key;
  await db.ref(`sessions/${currentSessionId}/currentEvening/players/${playerId}`).set({
    name:   trimmed,
    buyins: { [buyinId]: { amount: FIRST_BUYIN, chips: FIRST_BUYIN * CHIPS_PER_ILS } }
  });
  return null;
}

async function addBuyin(playerId, amountStr) {
  if (!playerId) return 'Please select a player.';
  const amount = Number(amountStr);
  if (!amount || amount <= 0 || amount % FIRST_BUYIN !== 0)
    return `Amount must be a positive multiple of ₪${FIRST_BUYIN}.`;

  await db.ref(`sessions/${currentSessionId}/currentEvening/players/${playerId}/buyins`).push({
    amount,
    chips: amount * CHIPS_PER_ILS
  });
  return null;
}

async function startNewEvening() {
  const current = liveData?.currentEvening;
  if (!current) return;

  const archiveKey = db.ref().push().key;
  await db.ref().update({
    [`sessions/${currentSessionId}/pastEvenings/${archiveKey}`]: current,
    [`sessions/${currentSessionId}/currentEvening`]: { date: formatDate(), players: null }
  });
}

// ─── COMPUTED ─────────────────────────────────────────────────────────────────

function getPlayers() {
  const raw = liveData?.currentEvening?.players;
  if (!raw) return [];
  return Object.entries(raw).map(([id, p]) => ({
    id,
    name:   p.name,
    buyins: p.buyins ? Object.values(p.buyins) : []
  }));
}

function computePot() {
  const ils = getPlayers().reduce(
    (sum, p) => sum + p.buyins.reduce((s, b) => s + b.amount, 0), 0
  );
  return { ils, chips: ils * CHIPS_PER_ILS };
}

function getPastEvenings() {
  const raw = liveData?.pastEvenings;
  if (!raw) return [];
  return Object.entries(raw)
    .map(([id, ev]) => ({
      id,
      date: ev.date,
      players: ev.players
        ? Object.entries(ev.players).map(([pid, p]) => ({
            id: pid, name: p.name,
            buyins: p.buyins ? Object.values(p.buyins) : []
          }))
        : []
    }))
    .reverse();
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function renderFromLiveData() {
  // Preserve typed chip counts so Firebase updates don't wipe them
  const saved = {};
  document.querySelectorAll('.calc-chip-input').forEach(inp => {
    if (inp.value) saved[inp.dataset.playerId] = inp.value;
  });

  renderHeader();
  renderPlayerSelect();
  renderPlayersList();
  renderCalculator(saved);
  renderHistory();
}

function renderHeader() {
  const { ils, chips } = computePot();
  document.getElementById('pot-ils').textContent   = `₪${ils}`;
  document.getElementById('pot-chips').textContent = chips.toLocaleString();
}

function renderPlayerSelect() {
  const sel  = document.getElementById('rebuy-player-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select player —</option>';
  getPlayers().forEach(p => {
    const opt = document.createElement('option');
    opt.value       = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function renderPlayersList() {
  const container = document.getElementById('players-list');
  const players   = getPlayers();

  if (!players.length) {
    container.innerHTML = '<p class="empty-state">No players yet. Add a player above to start the evening.</p>';
    return;
  }

  container.innerHTML = players.map(p => {
    const totalILS   = p.buyins.reduce((s, b) => s + b.amount, 0);
    const totalChips = totalILS * CHIPS_PER_ILS;
    const tags = p.buyins.map((b, i) =>
      `<span class="buyin-tag${i === 0 ? ' first' : ''}">
        ${i === 0 ? '&#9733; ' : ''}&#8362;${b.amount} / ${b.chips.toLocaleString()} chips
      </span>`
    ).join('');

    return `<div class="player-card">
      <div class="player-header">
        <span class="player-name">${esc(p.name)}</span>
        <span class="player-totals">
          <span>Total: <span class="amount">&#8362;${totalILS}</span></span>
          <span>Chips: <span class="amount">${totalChips.toLocaleString()}</span></span>
        </span>
      </div>
      <div class="buyin-history">${tags}</div>
    </div>`;
  }).join('');
}

function renderCalculator(saved = {}) {
  const players  = getPlayers();
  const expected = computePot().chips;
  const container    = document.getElementById('calculator-rows');
  const verifyResult = document.getElementById('verify-result');

  document.getElementById('calc-expected').textContent = expected.toLocaleString();

  if (!players.length) {
    container.innerHTML = '<p class="empty-state">Add players to use the calculator.</p>';
    document.getElementById('calc-total').textContent = '0';
    verifyResult.className = 'verify-result hidden';
    return;
  }

  container.innerHTML = players.map(p =>
    `<div class="calc-row">
      <label title="${esc(p.name)}">${esc(p.name)}</label>
      <input type="number" class="calc-chip-input" data-player-id="${p.id}"
             placeholder="chips" min="0" step="1"
             value="${esc(saved[p.id] || '')}" />
    </div>`
  ).join('');

  container.querySelectorAll('.calc-chip-input').forEach(inp => {
    inp.addEventListener('input', updateCalcTotal);
  });

  updateCalcTotal();

  // Clear verify result only if the player set changed
  const prevIds = new Set(Object.keys(saved));
  const currIds = new Set(players.map(p => p.id));
  const changed = [...prevIds].some(id => !currIds.has(id)) || [...currIds].some(id => !prevIds.has(id));
  if (changed && Object.keys(saved).length > 0) verifyResult.className = 'verify-result hidden';
}

function renderHistory() {
  const container = document.getElementById('history-list');
  const evenings  = getPastEvenings();

  if (!evenings.length) {
    container.innerHTML = '<p class="empty-state">No archived evenings yet.</p>';
    return;
  }

  container.innerHTML = evenings.map((ev, idx) => {
    const ils   = ev.players.reduce((s, p) => s + p.buyins.reduce((ss, b) => ss + b.amount, 0), 0);
    const chips = ils * CHIPS_PER_ILS;
    const rows  = ev.players.map(p => {
      const pILS = p.buyins.reduce((s, b) => s + b.amount, 0);
      return `<tr>
        <td>${esc(p.name)}</td>
        <td>&#8362;${pILS}</td>
        <td>${(pILS * CHIPS_PER_ILS).toLocaleString()}</td>
        <td>${p.buyins.length}</td>
      </tr>`;
    }).join('');

    return `<div class="history-item">
      <div class="history-summary" data-idx="${idx}">
        <span class="history-date">${esc(ev.date)}</span>
        <span class="history-meta">${ev.players.length} player(s)</span>
        <span class="history-pot">&#8362;${ils} / ${chips.toLocaleString()} chips</span>
        <span class="btn-ghost">&#9660;</span>
      </div>
      <div class="history-details" id="hist-detail-${idx}">
        <table>
          <thead><tr><th>Player</th><th>Paid</th><th>Chips</th><th>Buy-ins</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.history-summary').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById(`hist-detail-${el.dataset.idx}`).classList.toggle('open');
    });
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function updateCalcTotal() {
  const total = Array.from(document.querySelectorAll('.calc-chip-input'))
    .reduce((s, i) => s + (Number(i.value) || 0), 0);
  document.getElementById('calc-total').textContent = total.toLocaleString();
}

function verifyChips() {
  const total    = Array.from(document.querySelectorAll('.calc-chip-input'))
    .reduce((s, i) => s + (Number(i.value) || 0), 0);
  const expected = computePot().chips;
  const result   = document.getElementById('verify-result');
  const diff     = total - expected;

  if (diff === 0) {
    result.className  = 'verify-result balanced';
    result.textContent = '✓ Balanced — all chips accounted for!';
  } else {
    const sign = diff > 0 ? '+' : '';
    result.className  = 'verify-result unbalanced';
    result.textContent = `✗ Discrepancy: ${sign}${diff.toLocaleString()} chips (${sign}₪${diff / CHIPS_PER_ILS})`;
  }
}

function formatDate() {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError(id) {
  const el = document.getElementById(id);
  el.textContent = '';
  el.classList.add('hidden');
}

// ─── EVENT BINDING ────────────────────────────────────────────────────────────

function bindStaticEvents() {
  // Landing
  document.getElementById('btn-create-session').addEventListener('click', createSession);

  document.getElementById('btn-join-session').addEventListener('click', async () => {
    const err = await joinSession(document.getElementById('join-code-input').value);
    if (err) showError('join-error', err);
  });

  document.getElementById('join-code-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
    clearError('join-error');
  });

  document.getElementById('join-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join-session').click();
  });

  // Session header
  document.getElementById('btn-leave-session').addEventListener('click', leaveSession);

  document.getElementById('session-id-badge').addEventListener('click', () => {
    if (!currentSessionId) return;
    navigator.clipboard.writeText(currentSessionId).then(() => {
      const badge = document.getElementById('session-id-badge');
      badge.classList.add('copied');
      setTimeout(() => badge.classList.remove('copied'), 1500);
    });
  });

  // Add player
  document.getElementById('btn-add-player').addEventListener('click', async () => {
    const input = document.getElementById('player-name-input');
    const err   = await addPlayer(input.value);
    if (err) { showError('add-player-error', err); return; }
    clearError('add-player-error');
    input.value = '';
    input.focus();
  });

  document.getElementById('player-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-add-player').click();
  });

  // Re-buy
  document.getElementById('btn-rebuy').addEventListener('click', async () => {
    const playerId = document.getElementById('rebuy-player-select').value;
    const amount   = document.getElementById('rebuy-amount').value;
    const err      = await addBuyin(playerId, amount);
    if (err) { showError('rebuy-error', err); return; }
    clearError('rebuy-error');
    document.getElementById('rebuy-amount').value = '';
  });

  // Verify
  document.getElementById('btn-verify').addEventListener('click', verifyChips);

  // New evening
  document.getElementById('btn-new-session').addEventListener('click', async () => {
    const players = getPlayers();
    const msg = players.length
      ? `Archive tonight (${players.length} player(s)) and start a new evening?`
      : 'Start a new evening? (Current evening is empty.)';
    if (!confirm(msg)) return;
    await startNewEvening();
  });
}

document.addEventListener('DOMContentLoaded', init);
