'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  receipts: [],
  currentView: 'list',
  editingId: null,
  pendingOcrData: null,
};

// ── Currency helpers ──────────────────────────────────────────────────────────
const CURRENCY_SYMBOLS = {
  CAD: 'CA$', USD: '$', EUR: '€', GBP: '£', AUD: 'A$',
  JPY: '¥', MXN: 'MX$', CHF: 'Fr', CNY: '¥', HKD: 'HK$', SGD: 'S$',
};

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || (code ? `${code} ` : '$');
}

function formatMoney(amount, currency) {
  if (amount == null || amount === '') return '—';
  const sym = currencySymbol(currency);
  return `${sym}${parseFloat(amount).toFixed(2)}`;
}

// ── Category → badge colour ───────────────────────────────────────────────────
const CATEGORY_BADGE = {
  'Meals & Entertainment': 'badge-amber',
  'Accommodation':         'badge-blue',
  'Transportation':        'badge-green',
  'Office Supplies':       'badge-gray',
  'Software & Tools':      'badge-purple',
  'Conferences & Events':  'badge-red',
  'Other':                 'badge-gray',
};

function badgeClass(cat) { return CATEGORY_BADGE[cat] || 'badge-gray'; }

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const views = {
  list:    $('view-list'),
  capture: $('view-capture'),
  form:    $('view-form'),
  summary: $('view-summary'),
};

const el = {
  pageTitle:       $('page-title'),
  btnBack:         $('btn-back'),
  btnSummary:      $('btn-summary'),
  fab:             $('fab'),

  // list
  receiptList:     $('receipt-list'),
  listEmpty:       $('list-empty'),

  // capture
  fileCam:         $('file-camera'),
  fileUpload:      $('file-upload'),
  capturePreview:  $('capture-preview'),
  capturePH:       $('capture-placeholder'),
  ocrStatus:       $('ocr-status'),
  btnScan:         $('btn-scan'),

  // form
  receiptForm:     $('receipt-form'),
  formImageWrap:   $('form-image-wrap'),
  formImageThumb:  $('form-image-thumb'),
  fieldId:         $('field-id'),
  fieldImage:      $('field-image'),
  fieldVendor:     $('field-vendor'),
  fieldDate:       $('field-date'),
  fieldCategory:   $('field-category'),
  fieldCurrency:   $('field-currency'),
  fieldCurrencyCustom: $('field-currency-custom'),
  fieldSubtotal:   $('field-subtotal'),
  fieldGst:        $('field-gst'),
  fieldPst:        $('field-pst'),
  fieldGratuity:   $('field-gratuity'),
  fieldTotal:      $('field-total'),
  fieldNotes:      $('field-notes'),
  btnSave:         $('btn-save'),
  btnDelete:       $('btn-delete'),

  // currency prefix spans
  cpSubtotal:      $('currency-prefix'),
  cpGst:           $('currency-prefix-gst'),
  cpPst:           $('currency-prefix-pst'),
  cpTip:           $('currency-prefix-tip'),
  cpTotal:         $('currency-prefix-total'),

  // summary
  summaryCurrencyFilter: $('summary-currency-filter'),
  summaryCards:    $('summary-cards'),
  summaryBreakdown:$('summary-breakdown'),

  // toast / confirm
  toast:           $('toast'),
  confirmOverlay:  $('confirm-overlay'),
  confirmMessage:  $('confirm-message'),
  confirmOk:       $('confirm-ok'),
  confirmCancel:   $('confirm-cancel'),
};

// ── Navigation ────────────────────────────────────────────────────────────────
function showView(name, title, showBack = false, showFab = true) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
  state.currentView = name;
  el.pageTitle.textContent = title;
  el.btnBack.classList.toggle('hidden', !showBack);
  el.fab.classList.toggle('hidden', !showFab);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;

function showToast(msg, isError = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 3000);
}

// ── Confirm dialog ────────────────────────────────────────────────────────────
function confirmDialog(msg) {
  return new Promise((resolve) => {
    el.confirmMessage.textContent = msg;
    el.confirmOverlay.classList.remove('hidden');
    const cleanup = (result) => {
      el.confirmOverlay.classList.add('hidden');
      el.confirmOk.onclick = null;
      el.confirmCancel.onclick = null;
      resolve(result);
    };
    el.confirmOk.onclick = () => cleanup(true);
    el.confirmCancel.onclick = () => cleanup(false);
  });
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Load receipt list ─────────────────────────────────────────────────────────
async function loadReceipts() {
  try {
    state.receipts = await apiJson('/api/receipts');
    renderList();
  } catch (e) {
    showToast(`Could not load receipts: ${e.message}`, true);
  }
}

function renderList() {
  const { receipts } = state;
  el.listEmpty.classList.toggle('hidden', receipts.length > 0);
  el.receiptList.innerHTML = '';

  receipts.forEach((r) => {
    const card = document.createElement('div');
    card.className = 'receipt-card';
    card.dataset.id = r.id;

    const dateStr = r.date ? new Date(r.date + 'T00:00:00').toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    }) : '—';

    card.innerHTML = `
      <span class="card-vendor">${esc(r.vendor || 'Unknown Vendor')}</span>
      <span class="card-total">${formatMoney(r.total, r.currency)}</span>
      <span class="card-meta">${esc(dateStr)} · ${esc(r.currency || '')}</span>
      <span class="card-badge"><span class="badge ${badgeClass(r.category)}">${esc(r.category || 'Other')}</span></span>
    `;
    card.addEventListener('click', () => openEditForm(r.id));
    el.receiptList.appendChild(card);
  });
}

// ── Capture / OCR flow ────────────────────────────────────────────────────────
function goToCapture() {
  resetCaptureUI();
  showView('capture', 'Scan Receipt', true, false);
}

function resetCaptureUI() {
  el.capturePreview.classList.add('hidden');
  el.capturePH.classList.remove('hidden');
  el.btnScan.classList.add('hidden');
  el.ocrStatus.classList.add('hidden');
  el.fileCam.value = '';
  el.fileUpload.value = '';
  state.pendingOcrData = null;
}

function handleFileSelect(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    el.capturePreview.src = e.target.result;
    el.capturePreview.classList.remove('hidden');
    el.capturePH.classList.add('hidden');
    el.btnScan.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

el.fileCam.addEventListener('change', (e) => handleFileSelect(e.target.files[0]));
el.fileUpload.addEventListener('change', (e) => handleFileSelect(e.target.files[0]));

el.btnScan.addEventListener('click', async () => {
  const file = el.fileCam.files[0] || el.fileUpload.files[0];
  if (!file) return;

  el.btnScan.classList.add('hidden');
  el.ocrStatus.classList.remove('hidden');

  try {
    const formData = new FormData();
    formData.append('receipt', file);

    const res = await fetch('/api/ocr', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'OCR failed');

    state.pendingOcrData = data;
    openNewForm(data);
  } catch (e) {
    el.ocrStatus.classList.add('hidden');
    el.btnScan.classList.remove('hidden');
    showToast(`Scan failed: ${e.message}`, true);
  }
});

// ── Form helpers ──────────────────────────────────────────────────────────────
const KNOWN_CURRENCIES = ['CAD','USD','EUR','GBP','AUD','JPY','MXN','CHF','CNY','HKD','SGD'];

function populateForm(data = {}) {
  el.fieldId.value       = data.id         || '';
  el.fieldVendor.value   = data.vendor      || '';
  el.fieldDate.value     = data.date        || '';
  el.fieldNotes.value    = data.notes       || '';

  // Currency
  const cur = (data.currency || 'CAD').toUpperCase();
  if (KNOWN_CURRENCIES.includes(cur)) {
    el.fieldCurrency.value = cur;
    el.fieldCurrencyCustom.classList.add('hidden');
    el.fieldCurrencyCustom.value = '';
  } else {
    el.fieldCurrency.value = 'Other';
    el.fieldCurrencyCustom.classList.remove('hidden');
    el.fieldCurrencyCustom.value = cur;
  }
  updateCurrencyPrefixes();

  // Category
  const cat = data.suggested_category || data.category || 'Other';
  el.fieldCategory.value = cat;

  // Amounts
  el.fieldSubtotal.value = data.subtotal  != null ? data.subtotal  : '';
  el.fieldGst.value      = data.gst       != null ? data.gst       : '';
  el.fieldPst.value      = data.pst       != null ? data.pst       : '';
  el.fieldGratuity.value = data.gratuity  != null ? data.gratuity  : '';
  el.fieldTotal.value    = data.total     != null ? data.total     : '';

  // Image
  const imgData = data.image_data || '';
  el.fieldImage.value = imgData;
  if (imgData) {
    el.formImageThumb.src = imgData;
    el.formImageWrap.classList.remove('hidden');
  } else {
    el.formImageWrap.classList.add('hidden');
  }
}

function updateCurrencyPrefixes() {
  let cur = el.fieldCurrency.value;
  if (cur === 'Other') cur = el.fieldCurrencyCustom.value.toUpperCase() || '?';
  const sym = currencySymbol(cur);
  el.cpSubtotal.textContent = sym;
  el.cpGst.textContent      = sym;
  el.cpPst.textContent      = sym;
  el.cpTip.textContent      = sym;
  el.cpTotal.textContent    = sym;
}

el.fieldCurrency.addEventListener('change', () => {
  const isOther = el.fieldCurrency.value === 'Other';
  el.fieldCurrencyCustom.classList.toggle('hidden', !isOther);
  if (isOther) el.fieldCurrencyCustom.focus();
  updateCurrencyPrefixes();
});

el.fieldCurrencyCustom.addEventListener('input', updateCurrencyPrefixes);

function collectForm() {
  let currency = el.fieldCurrency.value;
  if (currency === 'Other') {
    currency = el.fieldCurrencyCustom.value.toUpperCase().trim() || 'Other';
  }
  return {
    vendor:     el.fieldVendor.value.trim()   || null,
    date:       el.fieldDate.value            || null,
    currency,
    category:   el.fieldCategory.value,
    subtotal:   el.fieldSubtotal.value  !== '' ? parseFloat(el.fieldSubtotal.value)  : null,
    gst:        el.fieldGst.value       !== '' ? parseFloat(el.fieldGst.value)       : null,
    pst:        el.fieldPst.value       !== '' ? parseFloat(el.fieldPst.value)       : null,
    gratuity:   el.fieldGratuity.value  !== '' ? parseFloat(el.fieldGratuity.value)  : null,
    total:      el.fieldTotal.value     !== '' ? parseFloat(el.fieldTotal.value)     : null,
    notes:      el.fieldNotes.value.trim()    || null,
    image_data: el.fieldImage.value           || null,
  };
}

// ── Open forms ────────────────────────────────────────────────────────────────
function openNewForm(ocrData = {}) {
  state.editingId = null;
  el.btnDelete.classList.add('hidden');
  el.btnSave.textContent = 'Save Receipt';
  populateForm(ocrData);
  showView('form', 'New Receipt', true, false);
}

function openEditForm(id) {
  const receipt = state.receipts.find(r => r.id === id);
  if (!receipt) return;
  state.editingId = id;
  el.btnDelete.classList.remove('hidden');
  el.btnSave.textContent = 'Update Receipt';
  populateForm(receipt);
  showView('form', 'Edit Receipt', true, false);
}

// ── Save / Delete ─────────────────────────────────────────────────────────────
el.receiptForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = collectForm();
  el.btnSave.disabled = true;
  el.btnSave.textContent = 'Saving…';

  try {
    if (state.editingId) {
      await apiJson(`/api/receipts/${state.editingId}`, {
        method: 'PUT', body: JSON.stringify(body),
      });
      showToast('Receipt updated');
    } else {
      await apiJson('/api/receipts', { method: 'POST', body: JSON.stringify(body) });
      showToast('Receipt saved');
    }
    await loadReceipts();
    goToList();
  } catch (err) {
    showToast(`Save failed: ${err.message}`, true);
  } finally {
    el.btnSave.disabled = false;
    el.btnSave.textContent = state.editingId ? 'Update Receipt' : 'Save Receipt';
  }
});

el.btnDelete.addEventListener('click', async () => {
  const ok = await confirmDialog('Delete this receipt? This cannot be undone.');
  if (!ok) return;
  try {
    await apiJson(`/api/receipts/${state.editingId}`, { method: 'DELETE' });
    showToast('Receipt deleted');
    await loadReceipts();
    goToList();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, true);
  }
});

// ── Summary view ──────────────────────────────────────────────────────────────
function openSummary() {
  buildSummary();
  showView('summary', 'Summary', true, true);
}

function buildSummary() {
  const all = state.receipts;

  // Populate currency filter
  const currencies = [...new Set(all.map(r => r.currency).filter(Boolean))].sort();
  const selected = el.summaryCurrencyFilter.value;
  el.summaryCurrencyFilter.innerHTML = '<option value="">All Currencies</option>';
  currencies.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    if (c === selected) opt.selected = true;
    el.summaryCurrencyFilter.appendChild(opt);
  });

  const filterCur = el.summaryCurrencyFilter.value;
  const receipts = filterCur ? all.filter(r => r.currency === filterCur) : all;

  const totalSpend = receipts.reduce((s, r) => s + (r.total || 0), 0);
  const totalGst   = receipts.reduce((s, r) => s + (r.gst   || 0), 0);
  const totalPst   = receipts.reduce((s, r) => s + (r.pst   || 0), 0);
  const totalTip   = receipts.reduce((s, r) => s + (r.gratuity || 0), 0);
  const curLabel   = filterCur || 'Mixed';

  el.summaryCards.innerHTML = `
    <div class="summary-stat">
      <div class="stat-value">${receipts.length}</div>
      <div class="stat-label">Receipts</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatMoney(totalSpend, filterCur || '')}</div>
      <div class="stat-label">Total (${curLabel})</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatMoney(totalGst, filterCur || '')}</div>
      <div class="stat-label">GST / HST</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatMoney(totalPst, filterCur || '')}</div>
      <div class="stat-label">PST / QST</div>
    </div>
  `;

  // By category
  const byCategory = {};
  receipts.forEach(r => {
    const cat = r.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, count: 0 };
    byCategory[cat].total += r.total || 0;
    byCategory[cat].count += 1;
  });

  const sorted = Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total);

  el.summaryBreakdown.innerHTML = sorted.length ? `
    <h3>By Category</h3>
    ${sorted.map(([cat, { total, count }]) => `
      <div class="summary-row">
        <div>
          <div class="cat-name"><span class="badge ${badgeClass(cat)}">${esc(cat)}</span></div>
          <div class="cat-count">${count} receipt${count !== 1 ? 's' : ''}</div>
        </div>
        <div class="cat-amount">${formatMoney(total, filterCur || '')}</div>
      </div>
    `).join('')}
  ` : '';
}

el.summaryCurrencyFilter.addEventListener('change', buildSummary);

// ── Back button ───────────────────────────────────────────────────────────────
function goToList() {
  showView('list', 'My Receipts', false, true);
}

el.btnBack.addEventListener('click', () => {
  if (state.currentView === 'form' || state.currentView === 'summary') {
    goToList();
  } else if (state.currentView === 'capture') {
    goToList();
  }
});

// ── FAB ───────────────────────────────────────────────────────────────────────
el.fab.addEventListener('click', () => {
  if (state.currentView === 'list') goToCapture();
  else if (state.currentView === 'summary') goToCapture();
});

// ── Summary button ────────────────────────────────────────────────────────────
el.btnSummary.addEventListener('click', () => {
  if (state.currentView === 'summary') {
    goToList();
  } else {
    openSummary();
  }
});

// ── Hardware back / browser back ──────────────────────────────────────────────
window.addEventListener('popstate', () => {
  if (state.currentView !== 'list') goToList();
});

// ── Escape html ───────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadReceipts();
