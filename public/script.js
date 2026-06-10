/* ═══════════════════════════════════════════
   OilyDex v4 — Frontend Logic
═══════════════════════════════════════════ */
'use strict';

const STORAGE_KEY = 'oilydex_data_v3';

let DATA = null;
const state = {
  category: 'all',
  q:        '',
  sort:     'countDesc',   // default: most owned
  demand:   'all',
  view:     'all',
  page:     'collection'
};

// ── Utils ──────────────────────────────────
const $ = id => document.getElementById(id);
const fmt    = n => Number(n || 0).toLocaleString('en-IN');
const fmtVal = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 4 });
const esc    = s => String(s ?? '').replace(/[&<>\"']/g, m =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'": '&#039;' }[m])
);

// ── Persistence ─────────────────────────────
function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}


let VALUES_DATA = null;
const textDecoder = new TextDecoder('utf-8');

async function loadValuesData() {
  if (VALUES_DATA) return VALUES_DATA;

  if (window.OILYDEX_VALUES_DATA && Array.isArray(window.OILYDEX_VALUES_DATA)) {
    VALUES_DATA = window.OILYDEX_VALUES_DATA;
    return VALUES_DATA;
  }

  throw new Error('Missing values data. Make sure data/values.js is included in the deployed site.');
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return ['nan', 'none'].includes(text.toLowerCase()) ? '' : text;
}

function cleanNumber(value) {
  const text = cleanText(value).replace(',', '.');
  if (!text || text === '-') return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function cleanNormalValue(value) {
  const text = cleanText(value).replace(',', '.');
  if (!text || text === '-') return null;
  const parts = text.split('/');
  const target = parts.length > 1 ? parts[parts.length - 1] : text;
  return cleanNumber(target);
}

function displayNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const num = Number(value);
  return Number.isInteger(num) ? String(num) : String(Number(num.toPrecision(12)));
}

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch !== '\r') {
        field += ch;
      }
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(h => cleanText(h));
  return rows.slice(1)
    .filter(r => r.some(cell => cleanText(cell) !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function parseCommonCategory(normalRaw) {
  const text = cleanText(normalRaw).replace(',', '.');
  if (!text) return { label: 'Common', sortValue: 0 };

  const beforeSlash = text.split('/')[0].trim();
  const match = beforeSlash.match(/-?\d+(?:\.\d+)?/);
  if (!match) return { label: beforeSlash || 'Common', sortValue: 0 };

  const value = Number(match[0]);
  const display = displayNumber(value);
  return { label: `${display} Common`, sortValue: value };
}

function parseCategory(row) {
  const rarity = cleanNumber(row.Rarity);
  const normalRaw = cleanText(row.Normal);
  const normalLower = normalRaw.replace(',', '.').toLowerCase();
  if (rarity !== null && rarity <= 30) return { category: 'T1-T30', sort: 1, type: 'tier' };

  const normalNum = cleanNormalValue(normalRaw);
  if (normalLower.includes('common')) {
    const common = parseCommonCategory(normalRaw);
    return { category: common.label, sort: 3000 + common.sortValue, type: 'common' };
  }
  if (normalNum !== null && normalNum < 1) {
    return { category: displayNumber(normalNum), sort: 1000 + normalNum, type: 'fraction' };
  }
  if (normalNum !== null) {
    return { category: displayNumber(normalNum), sort: 2000 + normalNum, type: 'value' };
  }
  return { category: 'Other', sort: 999999, type: 'other' };
}

function requireColumns(rows, required, label) {
  const cols = new Set(Object.keys(rows[0] || {}));
  for (const col of required) {
    if (!cols.has(col)) throw new Error(`${label} is missing required column: ${col}`);
  }
}

function findZipHeader(bytes, start) {
  for (let i = start; i <= bytes.length - 4; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      return i;
    }
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Your browser does not support ZIP extraction.');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function extractCsvFromZipFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const files = [];

  let offset = 0;
  while (offset < bytes.length - 4) {
    const idx = findZipHeader(bytes, offset);
    if (idx === -1) break;

    const compression = view.getUint16(idx + 8, true);
    const compressedSz = view.getUint32(idx + 18, true);
    const fileNameLen = view.getUint16(idx + 26, true);
    const extraLen = view.getUint16(idx + 28, true);
    const fileName = textDecoder.decode(bytes.slice(idx + 30, idx + 30 + fileNameLen));
    const dataStart = idx + 30 + fileNameLen + extraLen;
    const dataEnd = dataStart + compressedSz;

    if (dataEnd > bytes.length) break;

    if (fileName.toLowerCase().endsWith('.csv')) {
      const compressed = bytes.slice(dataStart, dataEnd);
      if (compression === 0) {
        files.push({ name: fileName, content: textDecoder.decode(compressed) });
      } else if (compression === 8) {
        try {
          const decompressed = await inflateRaw(compressed);
          files.push({ name: fileName, content: textDecoder.decode(decompressed) });
        } catch {}
      }
    }

    offset = dataEnd;
    if (offset <= idx) break;
  }

  return files;
}

async function analyzeInventoryFile(file) {
  const name = file.name.toLowerCase();
  let csvText = '';
  let csvName = file.name;

  if (name.endsWith('.zip')) {
    const csvFiles = await extractCsvFromZipFile(file);
    if (!csvFiles.length) throw new Error('No CSV file found inside the ZIP.');
    csvText = csvFiles[0].content;
    csvName = csvFiles[0].name;
  } else {
    csvText = await file.text();
  }

  const inventory = parseCSV(csvText);
  const valuesRaw = await loadValuesData();
  if (!inventory.length) throw new Error('The CSV file has no rows.');
  if (!valuesRaw.length) throw new Error('The values data has no rows.');

  requireColumns(inventory, ['countryball', 'special_card'], 'Inventory CSV');
  requireColumns(valuesRaw, ['Rarity', 'Balls', 'Dem', 'Normal'], 'Values data');

  const normalCounts = new Map();
  const specialMap = new Map();

  for (const row of inventory) {
    const ball = cleanText(row.countryball);
    const special = cleanText(row.special_card);
    if (!ball) continue;

    if (special) {
      const key = `${ball}|||${special}`;
      specialMap.set(key, (specialMap.get(key) || 0) + 1);
    } else {
      normalCounts.set(ball, (normalCounts.get(ball) || 0) + 1);
    }
  }

  const merged = valuesRaw
    .map(row => ({ ...row, Balls: cleanText(row.Balls) }))
    .filter(row => row.Balls && row.Balls.toLowerCase() !== 'common value')
    .map(row => {
      const parsed = parseCategory(row);
      const count = normalCounts.get(row.Balls) || 0;
      const rarityNum = cleanNumber(row.Rarity);
      const normalNum = cleanNormalValue(row.Normal);
      const duplicate = Math.max(0, count - 1);
      return {
        ball: row.Balls,
        category: parsed.category,
        categorySort: parsed.sort,
        categoryType: parsed.type,
        rarity: rarityNum === null ? null : Math.trunc(rarityNum),
        demand: cleanText(row.Dem) || '-',
        normal: cleanText(row.Normal) || '-',
        normalNum,
        count,
        duplicate,
        missing: count === 0,
        score: Number((count * (normalNum ?? 1)).toFixed(3))
      };
    })
    .sort((a, b) =>
      a.categorySort - b.categorySort ||
      (a.rarity ?? 9999) - (b.rarity ?? 9999) ||
      a.ball.localeCompare(b.ball)
    );

  const categoryMap = new Map();
  for (const row of merged) {
    if (!categoryMap.has(row.category)) {
      categoryMap.set(row.category, {
        name: row.category,
        sort: row.categorySort,
        type: row.categoryType,
        total: 0,
        unique: 0,
        available: 0,
        missing: 0
      });
    }
    const cat = categoryMap.get(row.category);
    cat.total += row.count;
    cat.available += 1;
    if (row.count > 0) cat.unique += 1;
    if (row.count === 0) cat.missing += 1;
  }

  const categories = [...categoryMap.values()]
    .map(c => ({ ...c, completion: c.available ? Number(((c.unique / c.available) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => a.sort - b.sort);

  const specials = [...specialMap.entries()]
    .map(([key, count]) => {
      const [ball, special] = key.split('|||');
      return { ball, special, count };
    })
    .sort((a, b) => a.special.localeCompare(b.special) || b.count - a.count || a.ball.localeCompare(b.ball));

  const typeMap = new Map();
  for (const s of specials) typeMap.set(s.special, (typeMap.get(s.special) || 0) + s.count);
  const specialTypes = [...typeMap.entries()]
    .map(([special, count]) => ({ special, count }))
    .sort((a, b) => b.count - a.count);

  const ownedNormal = merged.reduce((sum, r) => sum + r.count, 0);
  const ownedSpecials = specials.reduce((sum, r) => sum + r.count, 0);
  const uniqueOwned = merged.filter(r => r.count > 0).length;
  const totalInDb = merged.length;
  const missingCount = merged.filter(r => r.count === 0).length;
  const duplicates = merged.reduce((sum, r) => sum + r.duplicate, 0);

  return {
    generatedAt: new Date().toLocaleString('en-IN'),
    sourceFiles: { inventory: csvName, values: 'Balldex trading values.xlsx' },
    balls: merged,
    categories,
    specials,
    specialTypes,
    stats: {
      ownedNormal,
      ownedSpecials,
      totalOwned: ownedNormal + ownedSpecials,
      uniqueOwned,
      totalInDb,
      missing: missingCount,
      duplicates,
      completion: totalInDb ? Number(((uniqueOwned / totalInDb) * 100).toFixed(1)) : 0
    }
  };
}


// ── Screens ────────────────────────────────
function showScreen(id) {
  closeSidebar();
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.setAttribute('aria-hidden', 'true');
  });
  const target = $(id);
  target.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => target.classList.add('active'));
  const isDash = id === 'dashboardScreen';
  updateSidebarToggleVisibility(isDash && state.page === 'collection');
}

function updateSidebarToggleVisibility(show) {
  const toggle = $('sidebarToggle');
  if (!toggle) return;
  // Only show on mobile breakpoint AND collection page
  const isMobile = window.innerWidth <= 860;
  toggle.classList.toggle('hidden', !(show && isMobile));
}

function goUpload() {
  $('csvInput').value = '';
  $('uploadStatus').textContent = '';
  $('uploadStatus').className = 'upload-status';
  $('backToDashboardBtn').classList.toggle('hidden', !DATA);
  showScreen('uploadScreen');
}

function goDashboard() {
  showScreen('dashboardScreen');
}

// ── Page navigation ────────────────────────
function switchPage(page) {
  state.page = page;
  document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.page-nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
  });
  updateSidebarToggleVisibility(page === 'collection');

  if (page === 'collection') {
    $('pageCollection').classList.add('active');
    render();
  } else if (page === 'raws') {
    $('pageRaws').classList.add('active');
    renderRaws();
  } else if (page === 'bulk') {
    $('pageBulk').classList.add('active');
    renderHalsTable();
  }
}

document.querySelectorAll('.page-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!DATA) { setStatus('Please upload a collection first.', 'error'); goUpload(); return; }
    switchPage(btn.dataset.page);
  });
});

// ── File drop/upload ────────────────────────
const dropZone = $('dropZone');

$('csvInput').addEventListener('change', () => {
  if ($('csvInput').files[0]) uploadFile($('csvInput').files[0]);
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

$('newUploadBtn').addEventListener('click', goUpload);
$('newUploadBtnAlt').addEventListener('click', goUpload);
$('backToDashboardBtn').addEventListener('click', () => { if (DATA) goDashboard(); });

async function uploadFile(file) {
  const name = file.name.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.zip')) {
    setStatus('Please upload a CSV or ZIP file.', 'error');
    return;
  }

  setStatus(`Reading ${file.name}…`, 'loading');

  try {
    const payload = await analyzeInventoryFile(file);
    DATA = payload;
    saveData(DATA);
    resetFilters(false);
    setupDemandOptions();
    goDashboard();
    switchPage('collection');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function setStatus(msg, type) {
  const el = $('uploadStatus');
  el.textContent = msg;
  el.className   = 'upload-status' + (type ? ' ' + type : '');
}

// ── Controls ───────────────────────────────
$('searchInput').addEventListener('input', e => { state.q = e.target.value; render(); });
$('sortSelect').addEventListener('change',   e => { state.sort   = e.target.value; render(); });
$('demandSelect').addEventListener('change', e => { state.demand = e.target.value; render(); });
$('viewSelect').addEventListener('change',   e => { state.view   = e.target.value; render(); });
$('resetBtn').addEventListener('click', () => resetFilters(true));

function resetFilters(shouldRender) {
  state.category = 'all';
  state.q        = '';
  state.sort     = 'countDesc';   // reset to default: most owned
  state.demand   = 'all';
  state.view     = 'all';
  if ($('searchInput'))  $('searchInput').value  = '';
  if ($('sortSelect'))   $('sortSelect').value   = 'countDesc';
  if ($('demandSelect')) $('demandSelect').value = 'all';
  if ($('viewSelect'))   $('viewSelect').value   = 'all';
  if (shouldRender) render();
}

function setupDemandOptions() {
  const demands = [...new Set(DATA.balls.map(b => b.demand).filter(d => d && d !== '-'))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  $('demandSelect').innerHTML = '<option value="all">All demand</option>' +
    demands.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
}

// ── Scroll to top ──────────────────────────
$('scrollTopBtn').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
window.addEventListener('scroll', () => {
  $('scrollTopBtn').classList.toggle('hidden', window.scrollY < 300);
});

// ── Mobile sidebar ─────────────────────────
const sidebarToggle = $('sidebarToggle');
const sidebar       = $('sidebar');
let overlay;

function createOverlay() {
  overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', closeSidebar);
}

function openSidebar() {
  if (!sidebar || !overlay) return;
  sidebar.classList.add('open');
  overlay.classList.add('open');
  document.body.classList.add('sidebar-locked');
  sidebarToggle.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  if (!sidebar || !overlay) return;
  sidebar.classList.remove('open');
  overlay.classList.remove('open');
  document.body.classList.remove('sidebar-locked');
  if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', 'false');
}

sidebarToggle.setAttribute('aria-controls', 'sidebar');
sidebarToggle.setAttribute('aria-expanded', 'false');
sidebarToggle.addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
window.addEventListener('resize', () => {
  if (window.innerWidth > 860) closeSidebar();
  // Re-evaluate toggle visibility on resize
  updateSidebarToggleVisibility(state.page === 'collection');
});

createOverlay();

// ── Category helpers ───────────────────────
function cleanCategoryLabel(label) {
  return String(label ?? '').replace(/^(\d+(?:\.\d+)?)\s+Commons$/i, '$1 Common');
}

// ── Category nav ───────────────────────────
function renderNav() {
  const nav = $('categoryNav');

  const items = [
    { name: 'all', label: 'All', count: DATA.stats.ownedNormal },
    ...DATA.categories.map(c => ({ name: c.name, label: cleanCategoryLabel(c.name), count: c.total }))
  ];

  nav.innerHTML = items.map(item => `
    <button class="cat-btn${state.category === item.name ? ' active' : ''}" data-cat="${esc(item.name)}">
      <span class="cat-btn-name">${esc(item.label)}</span>
      <span class="cat-btn-count">${fmt(item.count)}</span>
    </button>`
  ).join('');

  nav.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.category = btn.dataset.cat;
      render();
      closeSidebar();
    });
  });
}

// ── Filtering ──────────────────────────────
function filteredBalls() {
  let items = DATA.balls.slice();

  if (state.category !== 'all')
    items = items.filter(b => b.category === state.category);

  if (state.demand !== 'all') items = items.filter(b => b.demand === state.demand);
  if (state.view === 'owned')   items = items.filter(b => b.count > 0);
  if (state.view === 'missing') items = items.filter(b => b.count === 0);

  const q = state.q.trim().toLowerCase();
  if (q) items = items.filter(b =>
    [b.ball, b.normal, b.demand, b.category].join(' ').toLowerCase().includes(q)
  );

  items.sort((a, b) => {
    if (state.sort === 'name')      return a.ball.localeCompare(b.ball);
    if (state.sort === 'countDesc') return b.count - a.count || a.ball.localeCompare(b.ball);
    if (state.sort === 'countAsc')  return a.count - b.count || a.ball.localeCompare(b.ball);
    return a.categorySort - b.categorySort ||
           (a.rarity ?? 9999) - (b.rarity ?? 9999) ||
           a.ball.localeCompare(b.ball);
  });
  return items;
}

function filteredSpecials() {
  if (state.category !== 'all' || state.demand !== 'all' || state.view === 'missing') return [];
  let items = DATA.specials.slice();
  const q = state.q.trim().toLowerCase();
  if (q) items = items.filter(s =>
    [s.ball, s.special].join(' ').toLowerCase().includes(q)
  );
  items.sort((a, b) => a.special.localeCompare(b.special) || b.count - a.count || a.ball.localeCompare(b.ball));
  return items;
}

// ── Value helpers ──────────────────────────
function cleanCommonValueText(value) {
  const text     = String(value ?? '').trim();
  const tierPart = text.includes('/') ? text.split('/').pop() : text;
  const match    = tierPart.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return text || '-';
  const num = Number(match[0]);
  return Number.isInteger(num) ? String(num) : String(Number(num.toPrecision(12)));
}

function parseTierValue(b) {
  const cleaned = cleanCommonValueText(b.normal);
  const match   = cleaned.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (match) return Number(match[0]);
  return Number.isFinite(Number(b.normalNum)) ? Number(b.normalNum) : 999999;
}

function tierValueLabel(value) {
  if (!Number.isFinite(value) || value === 999999) return 'Other';
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}

function rawUnitValue(value) {
  if (Math.abs(value - 0.1)   < 0.000001) return 1 / 8;
  if (Math.abs(value - 0.05)  < 0.000001) return 1 / 16;
  if (Math.abs(value - 0.025) < 0.000001) return 1 / 26;
  return value;
}

// ── Row builders ───────────────────────────
function tableHead(col2, col3) {
  return `<div class="table-head">
    <span>Ball</span>
    <span>${col2}</span>
    <span>${col3}</span>
    <span>Count</span>
  </div>`;
}

function ballRow(b) {
  const zeroClass    = b.count === 0 ? ' count-zero' : '';
  const missingClass = b.count === 0 ? ' missing-row' : '';
  return `<div class="ball-row${missingClass}">
    <span class="name">${esc(b.ball)}</span>
    <span class="cell">${esc(cleanCommonValueText(b.normal))}</span>
    <span class="cell">${esc(b.demand)}</span>
    <span class="cell count-cell${zeroClass}">${fmt(b.count)}</span>
  </div>`;
}

function specialRow(s) {
  return `<div class="ball-row">
    <span class="name">${esc(s.ball)}</span>
    <span class="cell">${esc(s.special)}</span>
    <span class="cell">—</span>
    <span class="cell count-cell">${fmt(s.count)}</span>
  </div>`;
}

// ── T1-T30 tables ──────────────────────────
function sortForState(items) {
  return items.slice().sort((a, b) => {
    if (state.sort === 'name')      return a.ball.localeCompare(b.ball);
    if (state.sort === 'countDesc') return b.count - a.count || (a.rarity ?? 9999) - (b.rarity ?? 9999) || a.ball.localeCompare(b.ball);
    if (state.sort === 'countAsc')  return a.count - b.count || (a.rarity ?? 9999) - (b.rarity ?? 9999) || a.ball.localeCompare(b.ball);
    return (a.rarity ?? 9999) - (b.rarity ?? 9999) || a.ball.localeCompare(b.ball);
  });
}

function renderT130Tables(balls) {
  const groups = new Map();
  for (const ball of balls) {
    const value = parseTierValue(ball);
    const key   = tierValueLabel(value);
    if (!groups.has(key)) groups.set(key, { value, label: key, rows: [] });
    groups.get(key).rows.push(ball);
  }
  return [...groups.values()]
    .sort((a, b) => b.value - a.value)
    .map(group => {
      const sorted = sortForState(group.rows);
      const owned  = sorted.filter(r => r.count > 0).length;
      return `<div class="tier-head">
          <h3>Tier ${esc(group.label)}</h3>
          <span>${owned} / ${sorted.length} owned</span>
        </div>
        ${sorted.map(ballRow).join('')}`;
    })
    .join('');
}

// ── Raws Page ──────────────────────────────
function renderRaws() {
  if (!DATA) { $('rawsView').innerHTML = '<div class="empty-state">No data loaded</div>'; return; }
  const t130Balls = DATA.balls.filter(b => b.category === 'T1-T30');
  if (!t130Balls.length) { $('rawsView').innerHTML = '<div class="empty-state">No T1-T30 balls in your collection</div>'; return; }

  const totals = new Map();
  for (const ball of t130Balls) {
    const value = parseTierValue(ball);
    if (!Number.isFinite(value) || value === 999999) continue;
    const cur  = totals.get(value) || { value, count: 0, raw: 0 };
    cur.count += Number(ball.count || 0);
    cur.raw   += Number(ball.count || 0) * rawUnitValue(value);
    totals.set(value, cur);
  }
  const rows  = [...totals.values()].filter(r => r.count > 0).sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, r) => sum + r.raw, 0);

  const lines = rows.map(row => {
    const label = tierValueLabel(row.value);
    let note    = '';
    if (Math.abs(row.value - 0.1)   < 0.000001) note = '<span class="note">8 × 0.1 = 1 T1</span>';
    if (Math.abs(row.value - 0.05)  < 0.000001) note = '<span class="note">16 × 0.05 = 1 T1</span>';
    if (Math.abs(row.value - 0.025) < 0.000001) note = '<span class="note">26 × 0.025 = 1 T1</span>';
    return `<div class="raw-total-row">
      <strong>${esc(label)} × ${fmt(row.count)}</strong>
      <b>${fmtVal(row.raw)}</b>
      ${note}
    </div>`;
  }).join('');

  // Also render T1-T30 ball table sorted by tier
  const groups = new Map();
  for (const ball of t130Balls) {
    const value = parseTierValue(ball);
    const key   = tierValueLabel(value);
    if (!groups.has(key)) groups.set(key, { value, label: key, rows: [] });
    groups.get(key).rows.push(ball);
  }
  const tierTableHtml = [...groups.values()]
    .sort((a, b) => b.value - a.value)
    .map(group => {
      const sorted = group.rows.slice().sort((a, b) => (a.rarity ?? 9999) - (b.rarity ?? 9999) || a.ball.localeCompare(b.ball));
      const owned  = sorted.filter(r => r.count > 0).length;
      return `<div class="tier-head">
          <h3>Tier ${esc(group.label)}</h3>
          <span>${owned} / ${sorted.length} owned</span>
        </div>
        ${sorted.map(ballRow).join('')}`;
    })
    .join('');

  $('rawsView').innerHTML = `
    <div class="raw-total-box">
      <div class="raw-total-header">
        <p>Total raw value</p>
        <strong>${fmtVal(total)}</strong>
      </div>
      ${lines || '<div class="raw-total-row"><strong>No owned T1-T30 balls</strong><b>0</b></div>'}
    </div>
    <div class="section-head" style="margin-top:24px;">
      <h2>T1–T30 Breakdown</h2>
      <span class="count-badge">${t130Balls.length} balls</span>
    </div>
    <div class="ball-table">
      ${tableHead('Value', 'Demand')}
      ${tierTableHtml}
    </div>
  `;
}

// ── Bulk Values Page ───────────────────────

// Hal's rate table data
const HALS_RATES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.05, 0.025];

const HALS_TABLE_DATA = {
  cols: [
    { label: '20 Commons\n30',       vals: { 1:26,  0.9:23, 0.8:21, 0.7:19, 0.6:17, 0.5:15, 0.4:13, 0.3:10, 0.2:8,  0.15:5,  0.1:3,  0.05:2,  0.025:1   } },
    { label: '15 Commons\n35–36',    vals: { 1:30,  0.9:28, 0.8:25, 0.7:23, 0.6:20, 0.5:18, 0.4:15, 0.3:13, 0.2:10, 0.15:8,  0.1:5,  0.05:3,  0.025:1.5 } },
    { label: '12 Commons\n39',       vals: { 1:35,  0.9:30, 0.8:28, 0.7:25, 0.6:23, 0.5:20, 0.4:18, 0.3:15, 0.2:13, 0.15:10, 0.1:6,  0.05:4,  0.025:2   } },
    { label: '10 Commons\n42–48',    vals: { 1:40,  0.9:35, 0.8:30, 0.7:28, 0.6:25, 0.5:23, 0.4:20, 0.3:18, 0.2:15, 0.15:13, 0.1:9,  0.05:6,  0.025:3   } },
    { label: '8 Commons\n49',        vals: { 1:45,  0.9:40, 0.8:35, 0.7:30, 0.6:28, 0.5:25, 0.4:23, 0.3:20, 0.2:18, 0.15:15, 0.1:12, 0.05:8,  0.025:4   } },
    { label: '7 Commons\n55–64',     vals: { 1:50,  0.9:45, 0.8:40, 0.7:35, 0.6:30, 0.5:28, 0.4:25, 0.3:23, 0.2:20, 0.15:17, 0.1:13, 0.05:9,  0.025:5   } },
    { label: '6 Commons\n68',        vals: { 1:55,  0.9:50, 0.8:45, 0.7:40, 0.6:35, 0.5:30, 0.4:28, 0.3:25, 0.2:23, 0.15:20, 0.1:14, 0.05:10, 0.025:6   } },
    { label: '5 Commons\n77–85',     vals: { 1:60,  0.9:55, 0.8:50, 0.7:45, 0.6:40, 0.5:35, 0.4:30, 0.3:28, 0.2:25, 0.15:23, 0.1:15, 0.05:12, 0.025:8   } },
    { label: '4 Commons\n88–101',    vals: { 1:65,  0.9:60, 0.8:55, 0.7:50, 0.6:45, 0.5:40, 0.4:35, 0.3:30, 0.2:28, 0.15:25, 0.1:18, 0.05:13, 0.025:10  } },
    { label: '3 Commons\n104–111',   vals: { 1:70,  0.9:65, 0.8:60, 0.7:55, 0.6:50, 0.5:45, 0.4:40, 0.3:35, 0.2:30, 0.15:28, 0.1:20, 0.05:15, 0.025:13  } },
    { label: '2 Commons\n122–131',   vals: { 1:75,  0.9:70, 0.8:65, 0.7:60, 0.6:55, 0.5:50, 0.4:45, 0.3:40, 0.2:35, 0.15:30, 0.1:23, 0.05:18, 0.025:15  } },
    { label: '1.5 Commons\n154–160', vals: { 1:100, 0.9:90, 0.8:80, 0.7:70, 0.6:60, 0.5:55, 0.4:50, 0.3:45, 0.2:40, 0.15:35, 0.1:25, 0.05:20, 0.025:18  } },
    { label: '1 Common\n174–358',    vals: { 1:150, 0.9:135,0.8:120,0.7:105,0.6:90, 0.5:80, 0.4:70, 0.3:60, 0.2:50, 0.15:45, 0.1:35, 0.05:25, 0.025:20  } },
  ]
};

const TIER_MARKERS = {
  1: 'T1', 0.9: '', 0.8: 'T4', 0.7: '', 0.6: '', 0.5: 'T5', 0.4: 'T7', 0.3: 'T9',
  0.2: 'T10–11', 0.15: 'T12–13', 0.1: 'T14', 0.05: 'T21–29', 0.025: 'T30'
};

function renderHalsTable() {
  const cols = HALS_TABLE_DATA.cols;
  const firstCols  = cols.slice(0, 5);
  const secondCols = cols.slice(5);

  function buildTable(displayCols) {
    const headerCells = displayCols.map(c => {
      const parts = c.label.split('\n');
      return `<th class="hals-th"><span class="hals-col-top">${parts[0]}</span><span class="hals-col-sub">${parts[1] || ''}</span></th>`;
    }).join('');

    const bodyRows = HALS_RATES.map(rate => {
      const tier  = TIER_MARKERS[rate];
      const cells = displayCols.map(c => {
        const val = c.vals[rate];
        return `<td class="hals-td">${val !== undefined ? val : '–'}</td>`;
      }).join('');
      return `<tr>
        <td class="hals-rate">${rate}</td>
        ${cells}
        <td class="hals-tier">${tier || ''}</td>
      </tr>`;
    }).join('');

    return `<table class="hals-table">
      <thead><tr>
        <th class="hals-th hals-rate-head">Hal's<br>Rates</th>
        ${headerCells}
        <th class="hals-th hals-tier-head"></th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
  }

  $('halsTable').innerHTML = `
    <div class="hals-table-scroll">${buildTable(firstCols)}</div>
    <div class="hals-table-scroll" style="margin-top:14px;">${buildTable(secondCols)}</div>
  `;
}

// ── Bulk Calculator ────────────────────────
function setupBulkCalc() {
  const ballInput   = $('bulkBallInput');
  const amountInput = $('bulkAmountInput');
  const targetSel   = $('bulkTargetSelect');
  const calcBtn     = $('bulkCalcBtn');
  const suggestBox  = $('bulkBallSuggest');
  const resultBox   = $('bulkResult');

  function getBallData(name) {
    if (!DATA) return null;
    return DATA.balls.find(b => b.ball.toLowerCase() === name.toLowerCase()) || null;
  }

  function showSuggestions(q) {
    if (!DATA || q.length < 1) { suggestBox.innerHTML = ''; suggestBox.classList.remove('open'); return; }
    const lower   = q.toLowerCase();
    const matches = DATA.balls.filter(b => b.ball.toLowerCase().includes(lower)).slice(0, 8);
    if (!matches.length) { suggestBox.innerHTML = ''; suggestBox.classList.remove('open'); return; }
    suggestBox.innerHTML = matches.map(b =>
      `<div class="suggest-item" data-name="${esc(b.ball)}">${esc(b.ball)} <span class="suggest-val">${esc(cleanCommonValueText(b.normal))}</span></div>`
    ).join('');
    suggestBox.classList.add('open');
    suggestBox.querySelectorAll('.suggest-item').forEach(item => {
      item.addEventListener('click', () => {
        ballInput.value = item.dataset.name;
        suggestBox.innerHTML = '';
        suggestBox.classList.remove('open');
      });
    });
  }

  ballInput.addEventListener('input', () => showSuggestions(ballInput.value));
  ballInput.addEventListener('blur', () => setTimeout(() => { suggestBox.classList.remove('open'); }, 150));

  const TARGET_VALUES = { raws: 1, t4: 4, t5: 5, t7: 7, t9: 9, t10: 10 };
  const TARGET_LABELS = { raws: 'T1 Raws', t4: 'T4 balls (value 4)', t5: 'T5 balls (value 5)', t7: 'T7 balls (value 7)', t9: 'T9 balls (value 9)', t10: 'T10 balls (value 10)' };

  calcBtn.addEventListener('click', () => {
    const ballName = ballInput.value.trim();
    const amount   = parseInt(amountInput.value);
    const target   = targetSel.value;

    if (!ballName) { showResult('error', 'Please enter a ball name.'); return; }
    if (!DATA)     { showResult('error', 'No collection loaded.'); return; }
    if (!amount || amount < 1) { showResult('error', 'Please enter a valid amount (≥1).'); return; }

    const ball = getBallData(ballName);
    if (!ball) { showResult('error', `Ball "${ballName}" not found in database.`); return; }

    const ballValue = parseTierValue(ball);
    if (!Number.isFinite(ballValue) || ballValue === 999999) {
      showResult('error', `Could not parse value for "${ballName}".`); return;
    }

    const rawValue    = rawUnitValue(ballValue);
    const totalRaws   = amount * rawValue;
    const targetVal   = TARGET_VALUES[target];
    const targetLabel = TARGET_LABELS[target];
    const converted   = totalRaws / targetVal;

    showResult('ok', `
      <div class="bulk-result-row">
        <span class="bulk-result-label">Ball</span>
        <span class="bulk-result-val">${esc(ball.ball)}</span>
      </div>
      <div class="bulk-result-row">
        <span class="bulk-result-label">Value per ball</span>
        <span class="bulk-result-val">${esc(cleanCommonValueText(ball.normal))}</span>
      </div>
      <div class="bulk-result-row">
        <span class="bulk-result-label">Amount</span>
        <span class="bulk-result-val">${fmt(amount)}</span>
      </div>
      <div class="bulk-result-row">
        <span class="bulk-result-label">Total raw value</span>
        <span class="bulk-result-val lime">${fmtVal(totalRaws)} T1 raws</span>
      </div>
      <div class="bulk-result-divider"></div>
      <div class="bulk-result-row bulk-result-main">
        <span class="bulk-result-label">≈ ${targetLabel}</span>
        <span class="bulk-result-val lime">${fmtVal(converted)}</span>
      </div>
    `);
  });

  function showResult(type, html) {
    resultBox.innerHTML = html;
    resultBox.className = 'bulk-result ' + type;
    resultBox.classList.remove('hidden');
  }
}

// ── Main render ────────────────────────────
function render() {
  if (!DATA) return;
  renderNav();

  const balls    = filteredBalls();
  const specials = filteredSpecials();

  let html = '';

  html += `<div class="section-head">
    <h2>Collection</h2>
    <span class="count-badge">${fmt(balls.length)} ball${balls.length !== 1 ? 's' : ''}</span>
  </div>`;

  if (balls.length === 0) {
    html += `<div class="empty-state">No balls match these filters</div>`;
  } else if (state.category === 'T1-T30') {
    html += `<div class="ball-table">
      ${tableHead('Value', 'Demand')}
      ${renderT130Tables(balls)}
    </div>`;
  } else {
    html += `<div class="ball-table">
      ${tableHead('Value', 'Demand')}
      ${balls.map(ballRow).join('')}
    </div>`;
  }

  if (specials.length) {
    html += `<div class="special-section">
      <div class="section-head">
        <h2>Specials</h2>
        <span class="count-badge">${fmt(specials.length)} entr${specials.length !== 1 ? 'ies' : 'y'}</span>
      </div>
      <div class="ball-table">
        ${tableHead('Type', '—')}
        ${specials.map(specialRow).join('')}
      </div>
    </div>`;
  }

  $('view').innerHTML = html;
  $('footer').textContent = `${DATA.sourceFiles.inventory} · Generated ${DATA.generatedAt}`;
}

// ── Init ────────────────────────────────────
(function init() {
  setupBulkCalc();
  loadValuesData().catch(() => {});
  const saved = loadData();
  if (saved) {
    DATA = saved;
    resetFilters(false);
    setupDemandOptions();
    goDashboard();
    switchPage('collection');
  } else {
    showScreen('uploadScreen');
  }
})();
