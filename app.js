'use strict';

// ─── FIREBASE CONFIG ──────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBXhYcajLx6Hd_OWT3jiGrG2ICciDHlPlw',
  authDomain:        'poker-tracker-9927b.firebaseapp.com',
  databaseURL:       'https://poker-tracker-9927b-default-rtdb.firebaseio.com',
  projectId:         'poker-tracker-9927b',
  storageBucket:     'poker-tracker-9927b.firebasestorage.app',
  messagingSenderId: '464853595153',
  appId:             '1:464853595153:web:9fa412821c1d0a35aa2db0'
};
// ─────────────────────────────────────────────────────────────────────────────

const CHIPS_PER_ILS  = 10;
const FIRST_BUYIN    = 50;
const QUICK_AMOUNTS  = [50, 100, 150, 200, 300];

let db;
let currentSessionId   = null;
let sessionUnsubscribe = null;
let liveData           = null;
let isAdmin            = false;

// ─── PIN HASHING (Web Crypto — no external lib needed) ───────────────────────

async function hashPin(pin) {
  const data = new TextEncoder().encode(pin.trim());
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

function init() {
  if (FIREBASE_CONFIG.apiKey === 'REPLACE_ME') {
    document.getElementById('setup-overlay').classList.remove('hidden');
    return;
  }
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.database();
  bindStaticEvents();
  initRoulette();
  showLanding();
}

// ─── VIEWS ────────────────────────────────────────────────────────────────────

function showLanding() {
  document.getElementById('view-landing').classList.remove('hidden');
  document.getElementById('view-session').classList.add('hidden');
  document.getElementById('join-code-input').value  = '';
  document.getElementById('create-pin-input').value = '';
  document.getElementById('join-pin-input').value   = '';
  document.getElementById('admin-pin-section').classList.add('hidden');
  clearError('join-error');
  clearError('create-error');
}

function showSessionView() {
  document.getElementById('view-landing').classList.add('hidden');
  document.getElementById('view-session').classList.remove('hidden');
  document.body.classList.toggle('is-admin', isAdmin);
  document.getElementById('admin-badge').classList.toggle('hidden', !isAdmin);
}

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function createSession(pin) {
  const trimmed = pin.trim();
  if (trimmed.length < 4) return 'PIN must be at least 4 characters.';

  const id      = generateCode();
  const pinHash = await hashPin(trimmed);

  await db.ref(`sessions/${id}`).set({
    adminPinHash:   pinHash,
    currentEvening: { date: formatDate(), players: null }
  });

  isAdmin = true;
  sessionStorage.setItem(`bg_admin_${id}`, '1');
  attachListener(id);
  return null;
}

async function joinViewer(code) {
  const id = code.trim().toUpperCase();
  if (id.length !== 4) return 'Enter a 4-letter session code.';

  const snap = await db.ref(`sessions/${id}`).get();
  if (!snap.exists()) return `Session "${id}" not found.`;

  isAdmin = false;
  attachListener(id);
  return null;
}

async function joinAdmin(code, pin) {
  const id = code.trim().toUpperCase();
  if (id.length !== 4) return 'Enter a 4-letter session code.';
  if (!pin.trim())      return 'Enter the admin PIN.';

  const snap = await db.ref(`sessions/${id}`).get();
  if (!snap.exists()) return `Session "${id}" not found.`;

  const stored = snap.val().adminPinHash;
  const input  = await hashPin(pin);
  if (input !== stored) return 'Incorrect PIN.';

  isAdmin = true;
  sessionStorage.setItem(`bg_admin_${id}`, '1');
  attachListener(id);
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
  isAdmin            = false;
  document.body.classList.remove('is-admin');
  showLanding();
}

// ─── ACTIONS (admin-guarded) ──────────────────────────────────────────────────

async function addPlayer(name) {
  if (!isAdmin) return;
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

async function addBuyin(playerId, amount) {
  if (!isAdmin) return;
  if (!amount || amount <= 0 || amount % FIRST_BUYIN !== 0) return;
  await db.ref(`sessions/${currentSessionId}/currentEvening/players/${playerId}/buyins`).push({
    amount,
    chips: amount * CHIPS_PER_ILS
  });
}

async function deletePlayer(playerId) {
  if (!isAdmin) return;
  const player  = getPlayers().find(p => p.id === playerId);
  if (!player) return;
  const totalILS = player.buyins.reduce((s, b) => s + b.amount, 0);
  if (!confirm(`Remove "${player.name}"?\nThis will remove ₪${totalILS} from the pot.`)) return;
  await db.ref(`sessions/${currentSessionId}/currentEvening/players/${playerId}`).remove();
}

async function startNewEvening() {
  if (!isAdmin) return;
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
      date:    ev.date,
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
  const saved = {};
  document.querySelectorAll('.calc-chip-input').forEach(inp => {
    if (inp.value) saved[inp.dataset.playerId] = inp.value;
  });

  renderHeader();
  renderPlayersList();
  renderSummary();
  renderCalculator(saved);
  renderHistory();
}

function renderHeader() {
  const { ils, chips } = computePot();
  document.getElementById('pot-ils').textContent   = `₪${ils}`;
  document.getElementById('pot-chips').textContent = chips.toLocaleString();
}

function renderPlayersList() {
  const container = document.getElementById('players-list');
  const players   = getPlayers();

  if (!players.length) {
    container.innerHTML = isAdmin
      ? '<p class="empty-state">No players yet — add one above.</p>'
      : '<p class="empty-state">No players yet.</p>';
    return;
  }

  const quickBtns = QUICK_AMOUNTS.map(amt =>
    `<button class="btn-quick-rebuy" data-amount="${amt}">+&#8362;${amt}</button>`
  ).join('');

  container.innerHTML = players.map(p => {
    const totalILS   = p.buyins.reduce((s, b) => s + b.amount, 0);
    const totalChips = totalILS * CHIPS_PER_ILS;

    const tags = p.buyins.map((b, i) =>
      `<span class="buyin-tag${i === 0 ? ' first' : ''}">
        ${i === 0 ? '&#9733; ' : ''}&#8362;${b.amount}&hairsp;/&hairsp;${b.chips.toLocaleString()}&thinsp;chips
      </span>`
    ).join('');

    return `<div class="player-card" data-player-id="${p.id}">
      <div class="player-header">
        <span class="player-name">${esc(p.name)}</span>
        <span class="player-totals">
          <span>Total:&nbsp;<span class="amount">&#8362;${totalILS}</span></span>
          <span>Chips:&nbsp;<span class="amount">${totalChips.toLocaleString()}</span></span>
        </span>
        <button class="btn-delete-player admin-only" data-player-id="${p.id}" title="Remove player">&#215;</button>
      </div>
      <div class="buyin-history">${tags}</div>
      <div class="quick-rebuy-row admin-only">
        <span class="quick-rebuy-label">Re-buy:</span>
        ${quickBtns}
        <button class="btn-quick-rebuy-custom" title="Custom amount">&#8230;</button>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.btn-quick-rebuy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.player-card');
      const pid  = card.dataset.playerId;
      btn.disabled = true;
      await addBuyin(pid, Number(btn.dataset.amount));
      btn.disabled = false;
    });
  });

  container.querySelectorAll('.btn-quick-rebuy-custom').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card   = btn.closest('.player-card');
      const pid    = card.dataset.playerId;
      const name   = getPlayers().find(p => p.id === pid)?.name ?? '';
      const raw    = prompt(`Custom re-buy for ${name}\nEnter amount in ₪ (multiple of ${FIRST_BUYIN}):`);
      if (raw === null) return;
      const amount = Number(raw.trim());
      if (!amount || amount <= 0 || amount % FIRST_BUYIN !== 0) {
        alert(`Amount must be a positive multiple of ₪${FIRST_BUYIN}.`);
        return;
      }
      await addBuyin(pid, amount);
    });
  });

  container.querySelectorAll('.btn-delete-player').forEach(btn => {
    btn.addEventListener('click', () => deletePlayer(btn.dataset.playerId));
  });
}

function renderSummary() {
  const players                = getPlayers();
  const { ils: total, chips }  = computePot();
  const tbody                  = document.getElementById('summary-body');

  document.getElementById('summary-total-ils').textContent   = `₪${total}`;
  document.getElementById('summary-total-chips').textContent = chips.toLocaleString();

  if (!players.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="padding:.75rem">No players yet.</td></tr>';
    return;
  }

  tbody.innerHTML = players.map(p => {
    const pILS = p.buyins.reduce((s, b) => s + b.amount, 0);
    return `<tr>
      <td>${esc(p.name)}</td>
      <td class="td-num">${p.buyins.length}</td>
      <td class="td-num td-gold">&#8362;${pILS}</td>
      <td class="td-num">${(pILS * CHIPS_PER_ILS).toLocaleString()}</td>
    </tr>`;
  }).join('');
}

function renderCalculator(saved = {}) {
  const players      = getPlayers();
  const expected     = computePot().chips;
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

  const prevIds = new Set(Object.keys(saved));
  const currIds = new Set(players.map(p => p.id));
  const changed = [...prevIds].some(id => !currIds.has(id)) || [...currIds].some(id => !prevIds.has(id));
  if (changed && prevIds.size > 0) verifyResult.className = 'verify-result hidden';
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
        <span class="history-pot">&#8362;${ils}&thinsp;/&thinsp;${chips.toLocaleString()} chips</span>
        <span>&#9660;</span>
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
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  // Create session
  document.getElementById('btn-create-session').addEventListener('click', async () => {
    const btn = document.getElementById('btn-create-session');
    const pin = document.getElementById('create-pin-input').value;
    btn.disabled = true;
    const err = await createSession(pin);
    btn.disabled = false;
    if (err) showError('create-error', err);
  });

  document.getElementById('create-pin-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create-session').click();
  });

  // Toggle admin PIN section
  document.getElementById('btn-toggle-admin').addEventListener('click', () => {
    document.getElementById('admin-pin-section').classList.toggle('hidden');
    document.getElementById('join-pin-input').focus();
  });

  // Join as viewer
  document.getElementById('btn-join-viewer').addEventListener('click', async () => {
    const btn  = document.getElementById('btn-join-viewer');
    btn.disabled = true;
    const err  = await joinViewer(document.getElementById('join-code-input').value);
    btn.disabled = false;
    if (err) showError('join-error', err);
  });

  // Join as admin
  document.getElementById('btn-join-admin').addEventListener('click', async () => {
    const btn  = document.getElementById('btn-join-admin');
    btn.disabled = true;
    const code = document.getElementById('join-code-input').value;
    const pin  = document.getElementById('join-pin-input').value;
    const err  = await joinAdmin(code, pin);
    btn.disabled = false;
    if (err) showError('join-error', err);
  });

  document.getElementById('join-code-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    clearError('join-error');
  });

  document.getElementById('join-pin-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join-admin').click();
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

// ─── ROULETTE ─────────────────────────────────────────────────────────────────

const R_GAMES = [
  { lines: ["Texas", "Hold'em"],  full: "Texas Hold'em",            fill: '#f59e0b', text: '#1a0800' },
  { lines: ['Omaha', '4 Cards'],  full: 'Omaha 4 Cards',            fill: '#3b82f6', text: '#ffffff' },
  { lines: ['Omaha 5', 'Single'], full: 'Omaha 5 Cards Single-Run', fill: '#a855f7', text: '#ffffff' },
  { lines: ['Omaha 5', 'Double'], full: 'Omaha 5 Cards Double-Run', fill: '#10b981', text: '#ffffff' },
  { lines: ['Crazyyy!'],          full: 'Crazyyy!',                  fill: '#ef4444', text: '#ffffff' },
];

const R_N       = R_GAMES.length;
const R_SLICE_R = (2 * Math.PI) / R_N;
const R_SLICE_D = 360 / R_N;

let rAngle    = 0;
let rSpinning = false;

function initRoulette() {
  drawRoulette(rAngle);
  document.getElementById('btn-spin').addEventListener('click', () => {
    if (!rSpinning) doSpin();
  });
}

function drawRoulette(angleDeg) {
  const canvas = document.getElementById('roulette-canvas');
  const ctx    = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R  = Math.min(W, H) / 2 - 6;

  ctx.clearRect(0, 0, W, H);

  // Wheel glow
  ctx.save();
  ctx.shadowColor = 'rgba(245,158,11,0.25)';
  ctx.shadowBlur  = 24;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  ctx.restore();

  const rot = (angleDeg - 90) * (Math.PI / 180);

  for (let i = 0; i < R_N; i++) {
    const a0 = rot + i * R_SLICE_R;
    const a1 = a0 + R_SLICE_R;
    const am = a0 + R_SLICE_R / 2;

    // Slice
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = R_GAMES[i].fill;
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Labels (radial, tip pointing outward from centre)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(am);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = R_GAMES[i].text;
    ctx.font         = "bold 11px 'Segoe UI', system-ui, sans-serif";

    const lines = R_GAMES[i].lines;
    const lH    = 15;
    const tR    = R * 0.63;
    lines.forEach((line, j) => {
      ctx.fillText(line, tR, (j - (lines.length - 1) / 2) * lH);
    });
    ctx.restore();
  }

  // Gold outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth   = 4;
  ctx.stroke();

  // Centre cap
  ctx.beginPath();
  ctx.arc(cx, cy, 19, 0, 2 * Math.PI);
  ctx.fillStyle = '#0f172a';
  ctx.fill();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth   = 3;
  ctx.stroke();

  // Centre dot
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
  ctx.fillStyle = '#f59e0b';
  ctx.fill();
}

function doSpin() {
  rSpinning = true;
  document.getElementById('btn-spin').disabled = true;
  document.getElementById('roulette-result').className = 'roulette-result hidden';

  const target     = Math.floor(Math.random() * R_N);
  const targetMod  = ((-(target + 0.5) * R_SLICE_D) % 360 + 360) % 360;
  const currentMod = ((rAngle % 360) + 360) % 360;
  let   delta      = targetMod - currentMod;
  if (delta <= 0) delta += 360;

  // Slight random wobble within the slice (±20%)
  const wobble = R_SLICE_D * (Math.random() * 0.4 - 0.2);
  const from   = rAngle;
  const to     = rAngle + (6 + Math.floor(Math.random() * 5)) * 360 + delta + wobble;
  const dur    = 3800;
  const t0     = performance.now();

  function frame(now) {
    const p = Math.min((now - t0) / dur, 1);
    const e = 1 - Math.pow(1 - p, 4); // ease-out quart
    rAngle  = from + (to - from) * e;
    drawRoulette(rAngle);

    if (p < 1) {
      requestAnimationFrame(frame);
    } else {
      rAngle    = to;
      rSpinning = false;
      document.getElementById('btn-spin').disabled = false;
      drawRoulette(rAngle);
      // Winner based on final angle (accounts for wobble)
      const finalMod = (((-rAngle) % 360) + 360) % 360;
      showRouletteResult(Math.floor(finalMod / R_SLICE_D) % R_N);
    }
  }

  requestAnimationFrame(frame);
}

function showRouletteResult(idx) {
  const g  = R_GAMES[idx];
  const el = document.getElementById('roulette-result');
  el.textContent       = g.full;
  el.style.background  = g.fill + '22';
  el.style.borderColor = g.fill;
  el.style.color       = g.fill;
  el.className         = 'roulette-result';
}

// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
