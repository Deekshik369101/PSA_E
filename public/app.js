/* ═══════════════════════════════════════════════════════════════════
   PSA Time Entry System — app.js
   Handles: Auth, Schedules, Time Entry, Notes Modal, Admin Panel
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── Config ────────────────────────────────────────────────────────
const API_BASE = '';   // same origin
let token = null;
let currentUser = null;
// Map: scheduleId → { entryId, notes, isSubmitted, status }
let entryMap = {};
// Track schedule IDs that have been submitted (for filtering the schedule list)
const submittedScheduleIds = new Set();

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

    // Set default week ending = this Saturday; restrict to Saturdays only
    const we = $('week-ending');
    we.value = getThisSaturday();
    we.addEventListener('change', () => {
        // Snap to nearest upcoming Saturday if a non-Saturday was picked
        const picked = new Date(we.value + 'T00:00:00');
        const dow = picked.getDay(); // 0=Sun, 6=Sat
        if (dow !== 6) {
            const diff = (6 - dow + 7) % 7 || 7;
            picked.setDate(picked.getDate() + diff);
            we.value = picked.toISOString().split('T')[0];
        }
        entryMap = {};
        submittedScheduleIds.clear();
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
        submittedScheduleIds.clear();
        $('submit-btn').disabled = true;
        stopCopyAllPolling();
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
        startCopyAllPolling();  // begin listening for external triggers
    }
}

// ── Schedules (User Panel) ────────────────────────────────────────
async function loadSchedules() {
    const tbody = $('schedules-tbody');
    tbody.innerHTML = `<tr><td colspan="4" class="table-empty">Loading...</td></tr>`;
    try {
        const schedules = await api('GET', '/api/schedules');
        // Filter out schedules that have a submitted entry for this week
        const visible = schedules.filter(s => !submittedScheduleIds.has(s.id));
        if (!visible.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="table-empty">No schedules assigned yet.</td></tr>`;
            return;
        }
        tbody.innerHTML = '';
        visible.forEach(s => {
            const tr = el('tr');
            tr.innerHTML = `
        <td class="col-check">
          <input type="checkbox" class="sched-check schedule-checkbox" data-id="${s.id}" data-title="${escHtml(s.projectTitle)}" />
        </td>
        <td>${escHtml(s.projectTitle)}</td>
        <td><span class="badge ${s.isAssigned ? 'badge-assigned' : 'badge-open'}">${s.isAssigned ? '\u2713 Assigned' : 'Unassigned'}</span></td>
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

// ── External Automation ──────────────────────────────────────────────────────

/** Small sleep helper for pacing async automation steps */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
//  window.externalTriggerSelectAndCopy
//  Simple: select all schedules and copy them to the Time Entry table.
// ─────────────────────────────────────────────────────────────────────────────
function externalTriggerSelectAndCopy() {
    console.log('[PSA Automation] Quick trigger: selecting all schedules and copying…');
    const allCheck = $('select-all-check');
    if (allCheck) allCheck.checked = true;
    document.querySelectorAll('.schedule-checkbox').forEach(cb => { cb.checked = true; });
    updateSelectedCount();
    copySelectedToEntry();
    console.log('[PSA Automation] Quick trigger complete.');
}
window.externalTriggerSelectAndCopy = externalTriggerSelectAndCopy;

// ─────────────────────────────────────────────────────────────────────────────
//  window.executeExternalWorkflow(workflowData)
//  Full 6-step automation:
//    1. Select all schedules
//    2. Copy to Time Entry table
//    3. Inject hours + notes into the new rows
//    4. Commit notes to local state (entryMap)
//    5. Save  →  status: Draft → Saved  (enables Submit button)
//    6. Submit →  status: Saved → Submitted
//
//  workflowData shape:
//    {
//      hours: { sun:8, mon:8, tue:8, wed:8, thu:8, fri:8, sat:0 }
//             OR { all: 8 }   (same value for every day)
//             OR a bare number (same value for every day)
//      notes: "Text applied to Mon-Fri"
//             OR { mon:"...", tue:"...", ... }   (per-day)
//    }
// ─────────────────────────────────────────────────────────────────────────────
async function executeExternalWorkflow(workflowData = {}) {
    const { hours = {}, notes = '' } = workflowData;
    const LOG = (msg) => console.log(`[PSA Workflow] ${msg}`);
    const WARN = (msg) => console.warn(`[PSA Workflow] ⚠ ${msg}`);

    LOG('═══ Starting 6-step automation ═══');
    LOG('Payload received: ' + JSON.stringify(workflowData));

    // ── Step 1: Select All Schedules ────────────────────────────────────────
    LOG('Step 1: Selecting all schedules…');
    const allCheck = $('select-all-check');
    if (allCheck) allCheck.checked = true;
    // Target ONLY the Schedules table (.schedule-checkbox), NOT the Time Entry table
    document.querySelectorAll('#schedules-tbody .schedule-checkbox, .schedule-checkbox')
        .forEach(cb => { cb.checked = true; });
    updateSelectedCount();
    LOG('Step 1 complete — all schedule checkboxes selected.');

    // ── Step 2: Trigger Copy ─────────────────────────────────────────────────
    LOG('Step 2: Copying selected schedules to the Time Entry table…');
    await copySelectedToEntry();
    await sleep(350); // allow DOM update
    LOG('Step 2 complete — rows added to Time Entry table.');

    // ── Step 3: Inject Hours & Notes ─────────────────────────────────────────
    LOG('Step 3: Injecting hours and notes into every new entry row…');
    const entryRows = document.querySelectorAll('#entry-tbody tr[id^="entry-row-"]');

    for (const tr of entryRows) {
        const schedId = parseInt(tr.dataset.schedId);
        if (entryMap[schedId]?.isSubmitted) continue; // skip already-submitted rows

        // — Inject hours —
        tr.querySelectorAll('.hour-input').forEach(inp => {
            const day = inp.dataset.day;
            let val;
            if (typeof hours === 'number') {
                val = hours;
            } else if (typeof hours.all === 'number') {
                val = hours.all;
            } else if (hours[day] !== undefined) {
                val = hours[day];
            }
            if (val !== undefined && val !== null) {
                inp.value = val;
                // Dispatch both 'input' and 'change' so internal state (recalcTotals,
                // the submit-btn disable logic) all fire correctly.
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        // — Inject notes into entryMap (used by saveEntries) —
        if (notes) {
            const notesObj = (typeof notes === 'string')
                ? { mon: notes, tue: notes, wed: notes, thu: notes, fri: notes }
                : notes;
            if (!entryMap[schedId]) entryMap[schedId] = {};
            entryMap[schedId].notes = notesObj;

            // Update the visual indicator on the notes button
            const hasAny = Object.values(notesObj).some(v => v && v.trim());
            const notesBtn = tr.querySelector('.notes-btn');
            if (notesBtn) notesBtn.classList.toggle('has-notes', hasAny);
        }
        LOG(`  → Row schedId=${schedId} — hours and notes injected.`);
    }
    LOG('Step 3 complete — all rows updated.');

    // ── Step 4: Notes committed ──────────────────────────────────────────────
    // Notes are already in entryMap (read by saveEntries). No modal interaction needed.
    LOG('Step 4: Notes committed to local state (entryMap). No modal save required.');

    // ── Step 5: Save ─────────────────────────────────────────────────────────
    LOG('Step 5: Saving entries (Draft → Saved)…');
    await saveEntries();
    await sleep(400); // let the UI settle

    if ($('submit-btn').disabled) {
        WARN('Step 5: Submit button is STILL disabled after save. A save error likely occurred.');
        WARN('Workflow aborted at Step 5. Check the console and network tab for details.');
        showToast('⚠ Automation: save failed — workflow aborted', 'error');
        return;
    }
    LOG('Step 5 complete — status is now "Saved". Submit button enabled.');

    // ── Step 6: Submit ───────────────────────────────────────────────────────
    LOG('Step 6: Validating notes and submitting entries (Saved → Submitted)…');

    // Mirror the notes-required guard from doSubmit() for a clean console warning
    const unsubmitted = [...document.querySelectorAll('#entry-tbody tr[id^="entry-row-"]')]
        .filter(tr => !entryMap[parseInt(tr.dataset.schedId)]?.isSubmitted);

    for (const tr of unsubmitted) {
        const sid = parseInt(tr.dataset.schedId);
        const rowNotes = entryMap[sid]?.notes || {};
        const hasNote = Object.values(rowNotes).some(v => v && v.trim());
        if (!hasNote) {
            const title = tr.querySelector('td')?.textContent?.trim() || `Row ${sid}`;
            WARN(`Step 6 aborted: Notes are empty for "${title}".`);
            alert(`Please fill the notes for: ${title}`);
            return;
        }
    }

    // Call doSubmit() directly — bypass the confirm modal for automation
    await doSubmit();
    LOG('Step 6 complete — entries submitted.');
    LOG('═══ Full workflow finished successfully! ═══');
    showToast('✅ Automation workflow complete', 'success');
}
window.executeExternalWorkflow = executeExternalWorkflow;

// ── Poll for backend-triggered automation ────────────────────────────────────
let _copyAllPollTimer = null;

function startCopyAllPolling(intervalMs = 3000) {
    stopCopyAllPolling();
    _copyAllPollTimer = setInterval(async () => {
        if (!token) { stopCopyAllPolling(); return; }
        try {
            const data = await api('GET', '/api/external/schedules/copy-all-pending');
            if (data.pending) {
                if (data.workflowData) {
                    // Full 6-step automation triggered via POST body hours/notes
                    showToast('⚡ Executing full automation workflow…', 'info');
                    console.log('[PSA Poll] workflowData received:', data.workflowData);
                    await executeExternalWorkflow(data.workflowData);
                } else {
                    // Simple select-all-and-copy trigger (no payload)
                    showToast('⚡ External trigger — selecting all and copying…', 'info');
                    externalTriggerSelectAndCopy();
                }
            }
        } catch (_) { /* silently ignore poll errors */ }
    }, intervalMs);
}

function stopCopyAllPolling() {
    if (_copyAllPollTimer) {
        clearInterval(_copyAllPollTimer);
        _copyAllPollTimer = null;
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
// Sunday-first column order
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function addEntryRow(schedId, title, entryId, data, isSubmitted) {
    const status = data.status || (isSubmitted ? 'Submitted' : 'Draft');
    entryMap[schedId] = { entryId: entryId || null, notes: data.notes || {}, isSubmitted: !!isSubmitted, status };

    if (isSubmitted) submittedScheduleIds.add(schedId);

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
    <td id="status-badge-${schedId}">${renderStatusBadge(status)}</td>`;

    $('entry-tbody').appendChild(tr);

    // Wire hour inputs: recalc totals AND disable submit-btn on change
    tr.querySelectorAll('.hour-input').forEach(inp => {
        inp.addEventListener('input', () => {
            recalcTotals();
            $('submit-btn').disabled = true;  // must re-save after changes
        });
    });

    // Notes button
    tr.querySelector('.notes-btn').addEventListener('click', () => {
        openModal(schedId, title);
    });

    recalcRowTotal(schedId);
}

function renderStatusBadge(status) {
    if (status === 'Submitted') return '<span class="badge badge-submitted"><i class="fa-solid fa-check"></i> Submitted</span>';
    if (status === 'Saved') return '<span class="badge badge-saved"><i class="fa-solid fa-floppy-disk"></i> Saved</span>';
    return '<span class="badge badge-draft"><i class="fa-solid fa-pen"></i> Draft</span>';
}

// ── Load existing entries for current week ────────────────────────
async function loadEntriesForWeek() {
    const weekEnding = $('week-ending').value;  // 'YYYY-MM-DD'
    if (!weekEnding) return;
    try {
        const entries = await api('GET', `/api/entries?weekEnding=${weekEnding}`);
        let schedulesRefreshNeeded = false;

        entries.forEach(e => {
            const serverDate = e.weekEnding ? e.weekEnding.substring(0, 10) : null;

            // Always track submitted entries (even if date differs slightly)
            if (e.isSubmitted) {
                submittedScheduleIds.add(e.scheduleId);
                schedulesRefreshNeeded = true;
            }

            // For non-submitted entries, enforce strict week match to avoid showing wrong week data
            if (!e.isSubmitted && serverDate !== weekEnding) return;

            const title = e.schedule?.projectTitle || `Schedule #${e.scheduleId}`;
            if (!$(`entry-row-${e.scheduleId}`)) {
                // Row doesn't exist yet — add it (handles externally-submitted entries)
                const emptyRow = $('entry-empty-row');
                if (emptyRow) emptyRow.remove();
                addEntryRow(e.scheduleId, title, e.id, e, e.isSubmitted);
            } else {
                // Row already in DOM — sync entryId and status in entryMap
                if (entryMap[e.scheduleId]) {
                    entryMap[e.scheduleId].entryId = e.id;
                    entryMap[e.scheduleId].status = e.status || entryMap[e.scheduleId].status;
                    entryMap[e.scheduleId].isSubmitted = !!e.isSubmitted;
                    const badgeCell = $(`status-badge-${e.scheduleId}`);
                    if (badgeCell) badgeCell.innerHTML = renderStatusBadge(entryMap[e.scheduleId].status);
                    // Disable inputs if now submitted
                    if (e.isSubmitted) {
                        const row = $(`entry-row-${e.scheduleId}`);
                        if (row) {
                            row.classList.add('submitted-row');
                            row.querySelectorAll('.hour-input').forEach(i => i.disabled = true);
                        }
                    }
                }
            }
        });

        updateEntryBadge();
        recalcTotals();

        // Refresh the schedule panel so submitted rows are filtered out of the checklist
        if (schedulesRefreshNeeded) loadSchedules();
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
    $('submit-btn').disabled = true;
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
            let updatedEntry;
            if (meta?.entryId) {
                // Update existing → server sets status: 'Saved'
                updatedEntry = await api('PATCH', `/api/entries/${meta.entryId}`, {
                    ...hoursData, notes: meta.notes
                });
                entryMap[schedId].entryId = updatedEntry.id;
            } else {
                // Create new → server sets status: 'Draft'
                updatedEntry = await api('POST', '/api/entries', {
                    scheduleId: schedId,
                    weekEnding,
                    ...hoursData,
                    notes: meta?.notes || {},
                });
                entryMap[schedId] = { ...entryMap[schedId], entryId: updatedEntry.id };
            }
            // Update local status and badge
            entryMap[schedId].status = updatedEntry.status || 'Saved';
            const badgeCell = $(`status-badge-${schedId}`);
            if (badgeCell) badgeCell.innerHTML = renderStatusBadge(entryMap[schedId].status);
            saved++;
        } catch (err) {
            console.error('Save error for sched', schedId, err);
            errors++;
        }
    }

    if (errors) {
        showToast(`Saved ${saved} rows. ${errors} error(s).`, 'warn');
    } else {
        showToast(`\u2705 ${saved} row(s) saved successfully`, 'success');
        if (saved > 0) $('submit-btn').disabled = false;
        // BUG FIX: reload entries so entryId + status badge sync from server
        await loadEntriesForWeek();
    }
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

    // ── #5 Notes required ────────────────────────────────────────
    for (const tr of unsubmitted) {
        const sid = parseInt(tr.dataset.schedId);
        const notes = entryMap[sid]?.notes || {};
        const hasNote = Object.values(notes).some(v => v && v.trim());
        if (!hasNote) {
            const title = tr.querySelector('td')?.textContent || `Row ${sid}`;
            alert(`Please fill the notes for: ${title}`);
            return;
        }
    }

    let submitted = 0;
    for (const tr of unsubmitted) {
        const sid = parseInt(tr.dataset.schedId);
        const meta = entryMap[sid];
        if (!meta?.entryId) continue;
        try {
            await api('POST', `/api/entries/${meta.entryId}/submit`);
            entryMap[sid].isSubmitted = true;
            entryMap[sid].status = 'Submitted';
            submittedScheduleIds.add(sid);
            // Update row UI
            tr.classList.add('submitted-row');
            tr.querySelectorAll('.hour-input').forEach(i => i.disabled = true);
            const badgeCell = $(`status-badge-${sid}`);
            if (badgeCell) badgeCell.innerHTML = renderStatusBadge('Submitted');
            submitted++;
        } catch (err) {
            console.error('Submit error', err);
        }
    }
    showToast(`✅ ${submitted} row(s) submitted`, 'success');
    setStatus(`Submitted at ${new Date().toLocaleTimeString()}`);
    $('submit-btn').disabled = true;
    // Refresh schedules table to filter now-submitted rows
    loadSchedules();
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
        <td>${s.user ? escHtml(s.user.username) : '\u2014'}</td>
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
    const userId = $('task-user').value;
    if (!title) return showToast('Enter a project title', 'warn');
    if (!userId) {
        alert('Please select a user before assigning the task.');
        return;
    }

    try {
        await api('POST', '/api/schedules', { projectTitle: title, userId: parseInt(userId) });
        showToast('\u2705 Task created successfully', 'success');
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
function getThisSaturday() {
    const d = new Date();
    const day = d.getDay();  // 0=Sun, 6=Sat
    const diff = (6 - day + 7) % 7;  // days until next Saturday (0 if today is Saturday)
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
