'use strict';

const CHIPS_PER_ILS = 10;       // 500 chips / 50 ILS
const FIRST_BUYIN_ILS = 50;
const STORAGE_KEY = 'badgizbar_v1';

// ─── STATE ────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return { currentSession: newSession(), pastSessions: [] };
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function newSession() {
  return {
    id: crypto.randomUUID(),
    date: new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    players: []
  };
}

let state = loadState();

// ─── COMPUTED ─────────────────────────────────────────────────────────────────

function computePot(session) {
  const ils = session.players.reduce((sum, p) =>
    sum + p.buyins.reduce((s, b) => s + b.amount, 0), 0);
  return { ils, chips: ils * CHIPS_PER_ILS };
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

function addPlayer(name) {
  const trimmed = name.trim();
  if (!trimmed) return 'Please enter a player name.';
  const duplicate = state.currentSession.players.some(
    p => p.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (duplicate) return `"${trimmed}" is already in this session.`;

  state.currentSession.players.push({
    id: crypto.randomUUID(),
    name: trimmed,
    buyins: [{ amount: FIRST_BUYIN_ILS, chips: FIRST_BUYIN_ILS * CHIPS_PER_ILS }]
  });
  saveState(state);
  return null;
}

function addBuyin(playerId, amountILS) {
  if (!playerId) return 'Please select a player.';
  const amount = Number(amountILS);
  if (!amount || amount <= 0 || amount % FIRST_BUYIN_ILS !== 0)
    return `Amount must be a positive multiple of ₪${FIRST_BUYIN_ILS}.`;

  const player = state.currentSession.players.find(p => p.id === playerId);
  if (!player) return 'Player not found.';

  player.buyins.push({ amount, chips: amount * CHIPS_PER_ILS });
  saveState(state);
  return null;
}

function startNewSession() {
  state.pastSessions.unshift(state.currentSession);
  state.currentSession = newSession();
  saveState(state);
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function renderAll() {
  renderHeader();
  renderPlayerSelect();
  renderPlayersList();
  renderCalculator();
  renderHistory();
}

function renderHeader() {
  const { ils, chips } = computePot(state.currentSession);
  document.getElementById('pot-ils').textContent = `₪${ils}`;
  document.getElementById('pot-chips').textContent = chips.toLocaleString();
  document.getElementById('session-date').textContent = state.currentSession.date;
}

function renderPlayerSelect() {
  const sel = document.getElementById('rebuy-player-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select player —</option>';
  state.currentSession.players.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

function renderPlayersList() {
  const container = document.getElementById('players-list');
  const players = state.currentSession.players;

  if (!players.length) {
    container.innerHTML = '<p class="empty-state">No players yet. Add a player above to start the evening.</p>';
    return;
  }

  container.innerHTML = players.map(p => {
    const totalILS = p.buyins.reduce((s, b) => s + b.amount, 0);
    const totalChips = totalILS * CHIPS_PER_ILS;
    const tags = p.buyins.map((b, i) =>
      `<span class="buyin-tag${i === 0 ? ' first' : ''}">
        ${i === 0 ? '&#x2605; ' : ''}₪${b.amount} / ${b.chips.toLocaleString()} chips
      </span>`
    ).join('');

    return `
      <div class="player-card">
        <div class="player-header">
          <span class="player-name">${escHtml(p.name)}</span>
          <span class="player-totals">
            <span>Total: <span class="amount">₪${totalILS}</span></span>
            <span>Chips: <span class="amount">${totalChips.toLocaleString()}</span></span>
          </span>
        </div>
        <div class="buyin-history">${tags}</div>
      </div>`;
  }).join('');
}

function renderCalculator() {
  const players = state.currentSession.players;
  const { chips: expected } = computePot(state.currentSession);
  const container = document.getElementById('calculator-rows');
  const calcExpected = document.getElementById('calc-expected');
  const verifyResult = document.getElementById('verify-result');

  calcExpected.textContent = expected.toLocaleString();

  if (!players.length) {
    container.innerHTML = '<p class="empty-state">Add players to use the calculator.</p>';
    document.getElementById('calc-total').textContent = '0';
    verifyResult.className = 'verify-result hidden';
    return;
  }

  container.innerHTML = players.map(p =>
    `<div class="calc-row">
      <label title="${escHtml(p.name)}">${escHtml(p.name)}</label>
      <input type="number" class="calc-chip-input" data-player-id="${p.id}"
             placeholder="chips" min="0" step="1" />
    </div>`
  ).join('');

  container.querySelectorAll('.calc-chip-input').forEach(inp => {
    inp.addEventListener('input', updateCalcTotal);
  });

  updateCalcTotal();
  verifyResult.className = 'verify-result hidden';
}

function updateCalcTotal() {
  const inputs = document.querySelectorAll('.calc-chip-input');
  const total = Array.from(inputs).reduce((s, i) => s + (Number(i.value) || 0), 0);
  document.getElementById('calc-total').textContent = total.toLocaleString();
}

function verifyChips() {
  const inputs = document.querySelectorAll('.calc-chip-input');
  const total = Array.from(inputs).reduce((s, i) => s + (Number(i.value) || 0), 0);
  const { chips: expected } = computePot(state.currentSession);
  const result = document.getElementById('verify-result');
  const diff = total - expected;

  if (diff === 0) {
    result.className = 'verify-result balanced';
    result.textContent = '✓ Balanced — all chips accounted for!';
  } else {
    const sign = diff > 0 ? '+' : '';
    const ilsDiff = diff / CHIPS_PER_ILS;
    result.className = 'verify-result unbalanced';
    result.textContent =
      `✗ Discrepancy: ${sign}${diff.toLocaleString()} chips (${sign}₪${ilsDiff})`;
  }
}

function renderHistory() {
  const container = document.getElementById('history-list');
  const sessions = state.pastSessions;

  if (!sessions.length) {
    container.innerHTML = '<p class="empty-state">No past sessions yet.</p>';
    return;
  }

  container.innerHTML = sessions.map((s, idx) => {
    const { ils, chips } = computePot(s);
    const rows = s.players.map(p => {
      const pILS = p.buyins.reduce((sum, b) => sum + b.amount, 0);
      return `<tr>
        <td>${escHtml(p.name)}</td>
        <td>₪${pILS}</td>
        <td>${(pILS * CHIPS_PER_ILS).toLocaleString()}</td>
        <td>${p.buyins.length}</td>
      </tr>`;
    }).join('');

    return `
      <div class="history-item">
        <div class="history-summary" data-idx="${idx}">
          <span class="history-date">${escHtml(s.date)}</span>
          <span class="history-meta">${s.players.length} players</span>
          <span class="history-pot">₪${ils} / ${chips.toLocaleString()} chips</span>
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
      const detail = document.getElementById(`hist-detail-${el.dataset.idx}`);
      detail.classList.toggle('open');
    });
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

// ─── INIT ─────────────────────────────────────────────────────────────────────

function init() {
  renderAll();

  // Add player
  document.getElementById('btn-add-player').addEventListener('click', () => {
    const input = document.getElementById('player-name-input');
    const err = addPlayer(input.value);
    if (err) { showError('add-player-error', err); return; }
    clearError('add-player-error');
    input.value = '';
    renderAll();
  });

  document.getElementById('player-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-add-player').click();
  });

  // Re-buy
  document.getElementById('btn-rebuy').addEventListener('click', () => {
    const playerId = document.getElementById('rebuy-player-select').value;
    const amount   = document.getElementById('rebuy-amount').value;
    const err = addBuyin(playerId, amount);
    if (err) { showError('rebuy-error', err); return; }
    clearError('rebuy-error');
    document.getElementById('rebuy-amount').value = '';
    renderAll();
  });

  // Verify
  document.getElementById('btn-verify').addEventListener('click', verifyChips);

  // New session
  document.getElementById('btn-new-session').addEventListener('click', () => {
    const players = state.currentSession.players;
    const msg = players.length
      ? `End evening for ${players.length} player(s) and start a new session?`
      : 'Start a new session? (Current session is empty.)';
    if (!confirm(msg)) return;
    startNewSession();
    renderAll();
  });
}

document.addEventListener('DOMContentLoaded', init);
