const http = require('http');

function post(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const options = {
            hostname: 'localhost', port: 9000,
            path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
        };
        const req = http.request(options, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = { hostname: 'localhost', port: 9000, path, method: 'GET', headers };
        const req = http.request(options, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.end();
    });
}

function patch(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const options = {
            hostname: 'localhost', port: 9000,
            path, method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
        };
        const req = http.request(options, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function run() {
    let ok = 0, fail = 0;

    function check(name, status, expected) {
        const pass = status === expected;
        console.log(`  ${pass ? '✅' : '❌'} [${status}] ${name}`);
        pass ? ok++ : fail++;
        return pass;
    }

    console.log('\n=== PSA Time Entry API Tests ===\n');

    // 1. Authentication
    console.log('1. Authentication');
    let adminToken, userToken, user2Token;
    try {
        const r = await post('/api/auth/login', { username: 'admin', password: 'admin123' });
        check('Admin login', r.status, 200);
        adminToken = r.body.token;
        console.log(`     Role: ${r.body.user?.role}, Username: ${r.body.user?.username}`);
    } catch (e) { console.log('  ❌ Admin login threw:', e.message); fail++; }

    try {
        const r = await post('/api/auth/login', { username: 'user1', password: 'user123' });
        check('User1 login', r.status, 200);
        userToken = r.body.token;
    } catch (e) { console.log('  ❌ User1 login threw:', e.message); fail++; }

    try {
        const r = await post('/api/auth/login', { username: 'user2', password: 'user123' });
        check('User2 login', r.status, 200);
        user2Token = r.body.token;
    } catch (e) { console.log('  ❌ User2 login threw:', e.message); fail++; }

    try {
        const r = await post('/api/auth/login', { username: 'admin', password: 'wrong' });
        check('Invalid login rejected (401)', r.status, 401);
    } catch (e) { fail++; }

    // 2. Admin Routes
    console.log('\n2. Admin Routes');
    try {
        const r = await get('/api/admin/users', { Authorization: `Bearer ${adminToken}` });
        check('GET /api/admin/users', r.status, 200);
        console.log(`     Users: ${r.body.map(u => u.username).join(', ')}`);
    } catch (e) { fail++; }

    // 3. Schedules + Project Types
    console.log('\n3. Schedules & Project Types');
    let createdSchedId, internalSchedId, overheadSchedId;
    const projectTypes = [
        { projectTitle: 'Test Customer Project', userId: 2, projectType: 'Customer Project' },
        { projectTitle: 'Test Internal Productive', userId: 2, projectType: 'Internal_Productive (EMS)' },
        { projectTitle: 'Test Internal Overhead', userId: 2, projectType: 'Internal_Overhead (EMS)' },
    ];
    // Helper: get existing scheduleId by title from admin's list
    const getSchedId = async (title) => {
        const r = await get('/api/schedules', { Authorization: `Bearer ${adminToken}` });
        const s = r.body.find(x => x.projectTitle === title);
        return s ? s.id : null;
    };
    for (const [i, sched] of projectTypes.entries()) {
        try {
            const r = await post('/api/schedules', sched, { Authorization: `Bearer ${adminToken}` });
            let id = r.body.id;
            if (r.status === 201) {
                check(`POST /api/schedules - ${sched.projectType}`, r.status, 201);
                console.log(`     Created: "${r.body.projectTitle}" (type: ${r.body.projectType})`);
            } else if (r.status === 409) {
                // Already exists — idempotent test: look it up and continue
                id = await getSchedId(sched.projectTitle);
                check(`POST /api/schedules - ${sched.projectType} (already exists → 409, using existing ID ${id})`, 409, 409);
            } else {
                check(`POST /api/schedules - ${sched.projectType}`, r.status, 201);
            }
            if (i === 0) createdSchedId = id;
            if (i === 1) internalSchedId = id;
            if (i === 2) overheadSchedId = id;
        } catch (e) { console.log(`  ❌ POST /api/schedules threw:`, e.message); fail++; }
    }

    // Test duplicate prevention (409)
    try {
        const r = await post('/api/schedules',
            { projectTitle: 'Test Customer Project', userId: 2, projectType: 'Customer Project' },
            { Authorization: `Bearer ${adminToken}` });
        check('Duplicate schedule rejected (409)', r.status, 409);
    } catch (e) { fail++; }

    try {
        const r = await get('/api/schedules', { Authorization: `Bearer ${userToken}` });
        check('GET /api/schedules (user1)', r.status, 200);
        const types = r.body.map(s => s.projectType).filter(Boolean);
        console.log(`     Schedules: ${r.body.length}, Types: ${[...new Set(types)].join(', ')}`);
    } catch (e) { fail++; }

    // 4. Time Entries (Bug 1+3+4 checks)
    console.log('\n4. Time Entries');
    let entryId;
    const weekEnding = '2026-03-01';
    try {
        const r = await post('/api/entries', {
            scheduleId: createdSchedId, weekEnding,
            mon: 8, tue: 8, wed: 8, thu: 8, fri: 8,
            notes: { mon: 'Initial note', tue: '' }
        }, { Authorization: `Bearer ${userToken}` });
        // 200 = existing updated (dedup), 201 = new entry created — both are correct
        const pass = r.status === 200 || r.status === 201;
        check('POST /api/entries (201 new or 200 dedup)', pass ? r.status : 999, r.status);
        entryId = r.body.id;
        console.log(`     Entry ID: ${entryId}, Status: ${r.body.status}`);
    } catch (e) { console.log('  ❌ POST entries:', e.message); fail++; }

    // BUG 1 FIX CHECK: posting again for same schedule+week should NOT create duplicate
    try {
        const r = await post('/api/entries', {
            scheduleId: createdSchedId, weekEnding,
            mon: 7, notes: { mon: 'Updated via POST dedup' }
        }, { Authorization: `Bearer ${userToken}` });
        check('Duplicate entry POST updates existing (200 or 201)', r.status >= 200 && r.status <= 201 ? r.status : 999, r.status);
        // Verify only 1 entry exists
        const list = await get(`/api/entries?weekEnding=${weekEnding}`, { Authorization: `Bearer ${userToken}` });
        const forSched = list.body.filter(e => e.scheduleId === createdSchedId);
        const noDup = forSched.length <= 1;
        console.log(`  ${noDup ? '✅' : '❌'} No duplicate entries (count=${forSched.length})`);
        noDup ? ok++ : fail++;
    } catch (e) { console.log('  ❌ Dedup check threw:', e.message); fail++; }

    // BUG 3+4 FIX CHECK: user-scoped GET /api/entries
    try {
        const r = await get(`/api/entries?weekEnding=${weekEnding}`, { Authorization: `Bearer ${userToken}` });
        check('GET /api/entries scoped to user1', r.status, 200);
        const schedIds = r.body.map(e => e.scheduleId);
        console.log(`     Entries for user1: ${r.body.length}, Schedule IDs: ${schedIds.join(', ')}`);
    } catch (e) { fail++; }

    // BUG 3+4: user2 should NOT see user1's entries
    try {
        const r = await get(`/api/entries?weekEnding=${weekEnding}`, { Authorization: `Bearer ${user2Token}` });
        check('GET /api/entries user2 gets own entries only', r.status, 200);
        const crossUser = r.body.filter(e => e.scheduleId === createdSchedId);
        const isolated = crossUser.length === 0;
        console.log(`  ${isolated ? '✅' : '❌'} User isolation OK (user2 cannot see user1 entry=${!isolated})`);
        isolated ? ok++ : fail++;
    } catch (e) { fail++; }

    try {
        const r = await patch(`/api/entries/${entryId}`, { mon: 7.5, notes: { mon: 'Updated note', tue: 'Task B' } },
            { Authorization: `Bearer ${userToken}` });
        check('PATCH /api/entries/:id → Saved', r.status, 200);
        console.log(`     Updated mon: ${r.body.mon}, status: ${r.body.status}, notes: ${JSON.stringify(r.body.notes)}`);
    } catch (e) { fail++; }

    // 5. External API
    console.log('\n5. External API (X-API-KEY)');
    const apiKey = 'psa-external-api-key-uipath-2024';
    try {
        const r = await patch('/api/external/update-note',
            { entryId, day: 'wednesday', text: 'Note from UiPath bot' },
            { 'x-api-key': apiKey });
        check('PATCH /api/external/update-note', r.status, 200);
        console.log(`     Notes after update: ${JSON.stringify(r.body.entry?.notes)}`);
    } catch (e) { console.log('  ❌ external update-note:', e.message); fail++; }

    try {
        const r = await patch('/api/external/update-note',
            { entryId, day: 'wednesday', text: ' - appended', append: true },
            { 'x-api-key': apiKey });
        check('PATCH /api/external/update-note (append)', r.status, 200);
        console.log(`     Wed note (appended): ${r.body.entry?.notes?.wed}`);
    } catch (e) { fail++; }

    try {
        const r = await post('/api/external/submit-timesheet', {
            scheduleId: internalSchedId,
            weekEnding: '2026-03-08',
            hours: { mon: 6, tue: 7, wed: 8, thu: 7, fri: 6 },
            notes: { mon: 'External submission' }
        }, { 'x-api-key': apiKey });
        check('POST /api/external/submit-timesheet', r.status, 200);
        console.log(`     isSubmitted: ${r.body.entry?.isSubmitted}, status: ${r.body.entry?.status}`);
    } catch (e) { console.log('  ❌ external submit:', e.message); fail++; }

    try {
        const r = await patch('/api/external/update-note',
            { entryId, day: 'monday', text: 'Bad key' },
            { 'x-api-key': 'WRONG_KEY' });
        check('Invalid X-API-KEY rejected (401)', r.status, 401);
    } catch (e) { fail++; }

    // GET /api/external/projects - returns all with projectType
    try {
        const r = await get('/api/external/projects', { 'x-api-key': apiKey });
        check('GET /api/external/projects', r.status, 200);
        const types = [...new Set(r.body.map(p => p.projectType))];
        console.log(`     Projects: ${r.body.length}, Types: ${types.join(', ')}`);
    } catch (e) { console.log('  ❌ external projects:', e.message); fail++; }

    // 6. Submit Flow
    console.log('\n6. Submit Flow');
    try {
        const r = await post(`/api/entries/${entryId}/submit`, {},
            { Authorization: `Bearer ${userToken}` });
        check('POST /api/entries/:id/submit', r.status, 200);
        console.log(`     isSubmitted: ${r.body.isSubmitted}, status: ${r.body.status}`);
    } catch (e) { fail++; }

    try {
        const r = await patch(`/api/entries/${entryId}`, { mon: 1 },
            { Authorization: `Bearer ${userToken}` });
        check('Edit after submit blocked (400)', r.status, 400);
    } catch (e) { fail++; }

    // 7. Cleanup - delete test schedules
    console.log('\n7. Cleanup');
    for (const schedId of [createdSchedId, internalSchedId, overheadSchedId]) {
        if (!schedId) continue;
        try {
            const r = await new Promise((resolve, reject) => {
                const options = { hostname: 'localhost', port: 9000, path: `/api/schedules/${schedId}`, method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } };
                const req = http.request(options, res => {
                    let raw = ''; res.on('data', c => raw += c);
                    res.on('end', () => resolve({ status: res.statusCode }));
                });
                req.on('error', reject); req.end();
            });
            check(`DELETE /api/schedules/${schedId}`, r.status, 200);
        } catch (e) { fail++; }
    }

    console.log(`\n${'='.repeat(42)}`);
    console.log(`  PASSED: ${ok}  |  FAILED: ${fail}`);
    console.log(`${'='.repeat(42)}\n`);
    process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
