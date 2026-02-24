/* ═══════════════════════════════════════════════════════════════════
   PSA Time Entry System — app.js
   Handles: Auth, Schedules, Time Entry, Notes Modal, Admin Panel
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── Config ────────────────────────────────────────────────────────
const API_BASE = '';   // same origin
let token = null;
let currentUser = null;
// Map: scheduleId → { entryId, notes, isSubmitted }
let entryMap = {};

// ── DOM Shortcuts ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Restore session
    const saved = localStorage.getItem('psa_token');
    const savedUser = localStorage.getItem('psa_user');
    if (saved && savedUser) {
        token = saved;
        currentUser = JSON.parse(savedUser);
        showApp();
    }

    // Set default week ending = this Sunday
    const we = $('week-ending');
    we.value = getThisSunday();
    we.addEventListener('change', () => {
        entryMap = {};
        renderEntryTable();
        loadEntriesForWeek();
    });

    // Login
    $('login-form').addEventListener('submit', handleLogin);

    // Logout
    $('logout-btn').addEventListener('click', () => {
        token = null; currentUser = null;
        localStorage.removeItem('psa_token');
        localStorage.removeItem('psa_user');
        $('app').classList.add('hidden');
        $('login-screen').classList.remove('hidden');
        $('entry-tbody').innerHTML = `<tr id="entry-empty-row"><td colspan="11" class="table-empty"><i class="fa-solid fa-arrow-down"></i> Select schedules below and click <strong>Copy Selected</strong></td></tr>`;
        entryMap = {};
    });

    // Copy Selected
    $('copy-selected-btn').addEventListener('click', copySelectedToEntry);

    // Select All checkbox
    $('select-all-check').addEventListener('change', function () {
        document.querySelectorAll('.sched-check').forEach(cb => cb.checked = this.checked);
        updateSelectedCount();
    });

    // Save / Submit
    $('save-btn').addEventListener('click', saveEntries);
    $('submit-btn').addEventListener('click', submitEntries);

    // Submit confirm modal
    $('confirm-modal-close').addEventListener('click', closeConfirmModal);
    $('confirm-cancel-btn').addEventListener('click', closeConfirmModal);
    $('confirm-submit-btn').addEventListener('click', () => { closeConfirmModal(); doSubmit(); });
    $('submit-confirm-modal').addEventListener('click', e => { if (e.target === $('submit-confirm-modal')) closeConfirmModal(); });

    // Notes modal
    $('modal-close-btn').addEventListener('click', closeModal);
    $('modal-cancel-btn').addEventListener('click', closeModal);
    $('modal-save-btn').addEventListener('click', saveNotes);
    $('notes-modal').addEventListener('click', e => { if (e.target === $('notes-modal')) closeModal(); });

    // Admin
    $('create-task-form').addEventListener('submit', handleCreateTask);
    $('refresh-admin-schedules').addEventListener('click', loadAdminSchedules);
    $('refresh-schedules-btn').addEventListener('click', loadSchedules);
});

// ── Auth ──────────────────────────────────────────────────────────
async function handleLogin(e) {
    e.preventDefault();
    const username = $('login-username').value.trim();
    const password = $('login-password').value.trim();
    const btn = $('login-btn');
    const errEl = $('login-error');

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';
    errEl.classList.add('hidden');

    try {
        const res = await api('POST', '/api/auth/login', { username, password }, false);
        token = res.token;
        currentUser = res.user;
        localStorage.setItem('psa_token', token);
        localStorage.setItem('psa_user', JSON.stringify(currentUser));
        $('login-screen').classList.add('hidden');
        showApp();
    } catch (err) {
        errEl.textContent = err.message || 'Login failed';
        errEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
    }
}

function showApp() {
    $('app').classList.remove('hidden');
    $('login-screen').classList.add('hidden');
    $('header-username').textContent = currentUser.username;
    $('header-role-badge').textContent = currentUser.role;

    if (currentUser.role === 'ADMIN') {
        $('admin-panel').classList.remove('hidden');
        $('user-panel').classList.add('hidden');
        loadAdminUsers();
        loadAdminSchedules();
    } else {
        $('admin-panel').classList.add('hidden');
        $('user-panel').classList.remove('hidden');
        loadSchedules();
        loadEntriesForWeek();
    }
}

// ── Schedules (User Panel) ────────────────────────────────────────
async function loadSchedules() {
    const tbody = $('schedules-tbody');
    tbody.innerHTML = `<tr><td colspan="4" class="table-empty">Loading...</td></tr>`;
    try {
        const schedules = await api('GET', '/api/schedules');
        if (!schedules.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="table-empty">No schedules assigned yet.</td></tr>`;
            return;
        }
        tbody.innerHTML = '';
        schedules.forEach(s => {
            const tr = el('tr');
            tr.innerHTML = `
        <td class="col-check">
          <input type="checkbox" class="sched-check" data-id="${s.id}" data-title="${escHtml(s.projectTitle)}" />
        </td>
        <td>${escHtml(s.projectTitle)}</td>
        <td><span class="badge ${s.isAssigned ? 'badge-assigned' : 'badge-open'}">${s.isAssigned ? '✓ Assigned' : 'Unassigned'}</span></td>
        <td class="text-muted">${fmtDate(s.createdAt)}</td>
      `;
            tbody.appendChild(tr);
        });
        // Re-attach change listeners for count
        document.querySelectorAll('.sched-check').forEach(cb =>
            cb.addEventListener('change', updateSelectedCount)
        );
        updateSelectedCount();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="table-empty" style="color:#c62828">${err.message}</td></tr>`;
    }
}

function updateSelectedCount() {
    const n = document.querySelectorAll('.sched-check:checked').length;
    $('selected-count-label').textContent = `${n} row${n !== 1 ? 's' : ''} selected`;
}

// ── Copy Selected → Time Entry Table ─────────────────────────────
async function copySelectedToEntry() {
    const checked = [...document.querySelectorAll('.sched-check:checked')];
    if (!checked.length) return showToast('Select at least one schedule row', 'warn');

    const weekEnding = $('week-ending').value;
    if (!weekEnding) return showToast('Please select a week ending date', 'warn');

    // Remove empty state row
    const emptyRow = $('entry-empty-row');
    if (emptyRow) emptyRow.remove();

    for (const cb of checked) {
        const schedId = parseInt(cb.dataset.id);
        const title = cb.dataset.title;
        // Skip if already in entry table
        if ($(`entry-row-${schedId}`)) continue;

        addEntryRow(schedId, title, null, {}, false);
    }

    updateEntryBadge();
    recalcTotals();
    showToast(`${checked.length} row(s) added to Time Entry`, 'success');
}

// ── Entry Row ─────────────────────────────────────────────────────
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function addEntryRow(schedId, title, entryId, data, isSubmitted) {
    entryMap[schedId] = { entryId: entryId || null, notes: data.notes || {}, isSubmitted: !!isSubmitted };

    const tr = el('tr');
    tr.id = `entry-row-${schedId}`;
    tr.dataset.schedId = schedId;
    if (isSubmitted) tr.classList.add('submitted-row');

    const hasNotes = data.notes && Object.values(data.notes).some(v => v && v.trim());

    let dayCells = '';
    DAYS.forEach(d => {
        const val = data[d] !== undefined && data[d] !== null ? data[d] : '';
        dayCells += `
      <td>
        <input type="number" class="hour-input" min="0" max="24" step="0.5"
          data-sched="${schedId}" data-day="${d}"
          value="${val}" placeholder="0"
          ${isSubmitted ? 'disabled' : ''}
          title="${d.toUpperCase()}" />
      </td>`;
    });

    tr.innerHTML = `
    <td style="text-align:left;font-weight:600">${escHtml(title)}</td>
    ${dayCells}
    <td class="row-total" id="rtot-${schedId}">0.0</td>
    <td>
      <button class="notes-btn ${hasNotes ? 'has-notes' : ''}" data-sched="${schedId}" data-title="${escHtml(title)}" title="View/Edit Notes">
        <i class="fa-solid fa-note-sticky"></i>
      </button>
    </td>
    <td>
      ${isSubmitted
            ? '<span class="badge badge-submitted"><i class="fa-solid fa-check"></i> Submitted</span>'
            : '<span class="badge badge-draft"><i class="fa-solid fa-pen"></i> Draft</span>'}
    </td>`;

    $('entry-tbody').appendChild(tr);

    // Wire hour input listeners
    tr.querySelectorAll('.hour-input').forEach(inp => {
        inp.addEventListener('input', () => recalcTotals());
    });

    // Notes button
    tr.querySelector('.notes-btn').addEventListener('click', () => {
        openModal(schedId, title);
    });

    recalcRowTotal(schedId);
}

// ── Load existing entries for current week ────────────────────────
async function loadEntriesForWeek() {
    const weekEnding = $('week-ending').value;
    if (!weekEnding) return;
    try {
        const entries = await api('GET', `/api/entries?weekEnding=${weekEnding}`);
        entries.forEach(e => {
            // Only show entries that belong to this user's schedules
            const title = e.schedule?.projectTitle || `Schedule #${e.scheduleId}`;
            if (!$(`entry-row-${e.scheduleId}`)) {
                const emptyRow = $('entry-empty-row');
                if (emptyRow) emptyRow.remove();
                addEntryRow(e.scheduleId, title, e.id, e, e.isSubmitted);
            }
        });
        updateEntryBadge();
        recalcTotals();
    } catch (_) { /* no entries for week yet */ }
}

// ── Totals ────────────────────────────────────────────────────────
function recalcRowTotal(schedId) {
    const row = $(`entry-row-${schedId}`);
    if (!row) return 0;
    let sum = 0;
    row.querySelectorAll('.hour-input').forEach(inp => { sum += parseFloat(inp.value) || 0; });
    const cell = $(`rtot-${schedId}`);
    if (cell) cell.textContent = sum.toFixed(1);
    return sum;
}

function recalcTotals() {
    const dayTotals = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
    document.querySelectorAll('.hour-input').forEach(inp => {
        dayTotals[inp.dataset.day] += parseFloat(inp.value) || 0;
    });
    DAYS.forEach(d => {
        const cell = $(`tot-${d}`);
        if (cell) cell.textContent = dayTotals[d].toFixed(1);
    });
    // Week total
    const weekTotal = Object.values(dayTotals).reduce((a, b) => a + b, 0);
    $('tot-week').textContent = weekTotal.toFixed(1);

    // Row totals
    document.querySelectorAll('#entry-tbody tr[data-sched-id], #entry-tbody tr[id^="entry-row-"]').forEach(tr => {
        const sid = tr.dataset.schedId;
        if (sid) recalcRowTotal(parseInt(sid));
    });
}

function renderEntryTable() {
    $('entry-tbody').innerHTML = `<tr id="entry-empty-row"><td colspan="11" class="table-empty"><i class="fa-solid fa-arrow-down"></i> Select schedules below and click <strong>Copy Selected</strong></td></tr>`;
    updateEntryBadge();
}

function updateEntryBadge() {
    const rows = document.querySelectorAll('#entry-tbody tr[id^="entry-row-"]').length;
    $('entry-count-badge').textContent = `${rows} row${rows !== 1 ? 's' : ''}`;
}

// ── Save ──────────────────────────────────────────────────────────
async function saveEntries() {
    const weekEnding = $('week-ending').value;
    if (!weekEnding) return showToast('Select a week ending date first', 'warn');

    const rows = document.querySelectorAll('#entry-tbody tr[id^="entry-row-"]');
    if (!rows.length) return showToast('No rows to save', 'warn');

    let saved = 0, errors = 0;
    for (const tr of rows) {
        const schedId = parseInt(tr.dataset.schedId);
        const meta = entryMap[schedId];
        if (meta?.isSubmitted) continue;

        const hoursData = {};
        tr.querySelectorAll('.hour-input').forEach(inp => {
            const v = parseFloat(inp.value);
            hoursData[inp.dataset.day] = isNaN(v) ? null : v;
        });

        try {
            if (meta?.entryId) {
                // Update existing
                const updated = await api('PATCH', `/api/entries/${meta.entryId}`, {
                    ...hoursData, notes: meta.notes
                });
                entryMap[schedId].entryId = updated.id;
            } else {
                // Create new
                const created = await api('POST', '/api/entries', {
                    scheduleId: schedId,
                    weekEnding,
                    ...hoursData,
                    notes: meta?.notes || {},
                });
                entryMap[schedId] = { ...entryMap[schedId], entryId: created.id };
            }
            saved++;
        } catch (err) {
            console.error('Save error for sched', schedId, err);
            errors++;
        }
    }

    if (errors) showToast(`Saved ${saved} rows. ${errors} error(s).`, 'warn');
    else showToast(`✅ ${saved} row(s) saved successfully`, 'success');
    setStatus(`Last saved: ${new Date().toLocaleTimeString()}`);
}

// ── Submit ────────────────────────────────────────────────────────
function submitEntries() {
    const rows = document.querySelectorAll('#entry-tbody tr[id^="entry-row-"]');
    const unsubmitted = [...rows].filter(tr => {
        const sid = parseInt(tr.dataset.schedId);
        return !entryMap[sid]?.isSubmitted;
    });
    if (!unsubmitted.length) return showToast('No rows to submit', 'warn');
    openConfirmModal(unsubmitted.length);
}

function openConfirmModal(count) {
    const meta = $('confirm-meta');
    meta.textContent = `${count} timesheet row${count !== 1 ? 's' : ''} will be submitted and locked.`;
    meta.classList.add('visible');
    $('submit-confirm-modal').classList.remove('hidden');
}

function closeConfirmModal() {
    $('submit-confirm-modal').classList.add('hidden');
}

async function doSubmit() {
    const rows = document.querySelectorAll('#entry-tbody tr[id^="entry-row-"]');
    const unsubmitted = [...rows].filter(tr => {
        const sid = parseInt(tr.dataset.schedId);
        return !entryMap[sid]?.isSubmitted;
    });
    if (!unsubmitted.length) return;

    // Save first
    await saveEntries();

    let submitted = 0;
    for (const tr of unsubmitted) {
        const sid = parseInt(tr.dataset.schedId);
        const meta = entryMap[sid];
        if (!meta?.entryId) continue;
        try {
            await api('POST', `/api/entries/${meta.entryId}/submit`);
            entryMap[sid].isSubmitted = true;
            // Update row UI
            tr.classList.add('submitted-row');
            tr.querySelectorAll('.hour-input').forEach(i => i.disabled = true);
            const badge = tr.querySelector('.badge');
            if (badge) badge.outerHTML = '<span class="badge badge-submitted"><i class="fa-solid fa-check"></i> Submitted</span>';
            submitted++;
        } catch (err) {
            console.error('Submit error', err);
        }
    }
    showToast(`✅ ${submitted} row(s) submitted`, 'success');
    setStatus(`Submitted at ${new Date().toLocaleTimeString()}`);
}

// ── Notes Modal ───────────────────────────────────────────────────
let activeModalSchedId = null;

function openModal(schedId, title) {
    activeModalSchedId = schedId;
    $('modal-project-label').textContent = `Project: ${title}`;
    const notes = entryMap[schedId]?.notes || {};
    ['mon', 'tue', 'wed', 'thu', 'fri'].forEach(d => {
        $(`note-${d}`).value = notes[d] || '';
        $(`note-${d}`).disabled = !!entryMap[schedId]?.isSubmitted;
    });
    $('modal-save-btn').disabled = !!entryMap[schedId]?.isSubmitted;
    $('notes-modal').classList.remove('hidden');
}

function closeModal() {
    $('notes-modal').classList.add('hidden');
    activeModalSchedId = null;
}

function saveNotes() {
    if (!activeModalSchedId) return;
    const sid = activeModalSchedId;
    const notes = {};
    ['mon', 'tue', 'wed', 'thu', 'fri'].forEach(d => {
        notes[d] = $(`note-${d}`).value.trim();
    });
    if (!entryMap[sid]) entryMap[sid] = {};
    entryMap[sid].notes = notes;

    // Update notes button indicator
    const hasAny = Object.values(notes).some(v => v);
    const btn = document.querySelector(`#entry-row-${sid} .notes-btn`);
    if (btn) btn.classList.toggle('has-notes', hasAny);

    closeModal();
    showToast('Notes saved locally — click Save to persist', 'success');
}

// ── Admin Panel ───────────────────────────────────────────────────
async function loadAdminUsers() {
    try {
        const users = await api('GET', '/api/admin/users');
        const sel = $('task-user');
        sel.innerHTML = '<option value="">— Select User —</option>';
        users.filter(u => u.role !== 'ADMIN').forEach(u => {
            const opt = el('option');
            opt.value = u.id;
            opt.textContent = u.username;
            sel.appendChild(opt);
        });
    } catch (err) { console.error('Load users failed', err); }
}

async function loadAdminSchedules() {
    const tbody = $('admin-schedules-body');
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">Loading...</td></tr>`;
    try {
        const schedules = await api('GET', '/api/schedules');
        if (!schedules.length) {
            tbody.innerHTML = `<tr><td colspan="5" class="table-empty">No schedules yet.</td></tr>`;
            return;
        }
        tbody.innerHTML = '';
        schedules.forEach(s => {
            const tr = el('tr');
            tr.innerHTML = `
        <td>${s.id}</td>
        <td style="font-weight:600">${escHtml(s.projectTitle)}</td>
        <td>${s.user ? escHtml(s.user.username) : '—'}</td>
        <td><span class="badge ${s.isAssigned ? 'badge-assigned' : 'badge-open'}">${s.isAssigned ? 'Assigned' : 'Unassigned'}</span></td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteSchedule(${s.id}, this)">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>`;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color:#c62828">${err.message}</td></tr>`;
    }
}

async function handleCreateTask(e) {
    e.preventDefault();
    const title = $('task-title').value.trim();
    const userId = parseInt($('task-user').value);
    if (!title) return showToast('Enter a project title', 'warn');

    try {
        await api('POST', '/api/schedules', { projectTitle: title, userId: userId || undefined });
        showToast('✅ Task created successfully', 'success');
        $('task-title').value = '';
        $('task-user').value = '';
        loadAdminSchedules();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteSchedule(id, btn) {
    if (!confirm('Delete this schedule and all its time entries?')) return;
    btn.disabled = true;
    try {
        await api('DELETE', `/api/schedules/${id}`);
        loadAdminSchedules();
        showToast('Schedule deleted', 'success');
    } catch (err) { showToast(err.message, 'error'); btn.disabled = false; }
}

// ── API Helper ────────────────────────────────────────────────────
async function api(method, url, body, useAuth = true) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (useAuth && token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(API_BASE + url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ── Helpers ───────────────────────────────────────────────────────
function getThisSunday() {
    const d = new Date();
    const day = d.getDay(); // 0=Sun
    const diff = day === 0 ? 0 : 7 - day;
    d.setDate(d.getDate() + diff);
    return d.toISOString().split('T')[0];
}

function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(msg) { $('status-msg').textContent = msg; }

let toastTimer = null;
function showToast(msg, type = 'info') {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast toast-${type}`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
