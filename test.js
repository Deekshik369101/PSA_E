const http = require('http');

function post(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const options = {
            hostname: 'localhost', port: 3000,
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
        const options = { hostname: 'localhost', port: 3000, path, method: 'GET', headers };
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
            hostname: 'localhost', port: 3000,
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

    // 1. Login - admin
    console.log('1. Authentication');
    let adminToken, userToken;
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
        const r = await post('/api/auth/login', { username: 'admin', password: 'wrong' });
        check('Invalid login rejected (401)', r.status, 401);
    } catch (e) { fail++; }

    // 2. Admin: list users
    console.log('\n2. Admin Routes');
    try {
        const r = await get('/api/admin/users', { Authorization: `Bearer ${adminToken}` });
        check('GET /api/admin/users', r.status, 200);
        console.log(`     Users: ${r.body.map(u => u.username).join(', ')}`);
    } catch (e) { fail++; }

    // 3. Schedules
    console.log('\n3. Schedules');
    let createdSchedId;
    try {
        const r = await post('/api/schedules', { projectTitle: 'Test Automation Project', userId: 2 },
            { Authorization: `Bearer ${adminToken}` });
        check('POST /api/schedules (admin)', r.status, 201);
        createdSchedId = r.body.id;
        console.log(`     Created schedule ID: ${createdSchedId}`);
    } catch (e) { fail++; }

    try {
        const r = await get('/api/schedules', { Authorization: `Bearer ${userToken}` });
        check('GET /api/schedules (user1)', r.status, 200);
        console.log(`     Schedules for user1: ${r.body.length}`);
    } catch (e) { fail++; }

    // 4. Time Entries
    console.log('\n4. Time Entries');
    let entryId;
    const weekEnding = '2026-03-01';
    try {
        const r = await post('/api/entries', {
            scheduleId: createdSchedId, weekEnding,
            mon: 8, tue: 8, wed: 8, thu: 8, fri: 8,
            notes: { mon: 'Initial note', tue: '' }
        }, { Authorization: `Bearer ${userToken}` });
        check('POST /api/entries', r.status, 201);
        entryId = r.body.id;
        console.log(`     Entry ID: ${entryId}, Notes: ${JSON.stringify(r.body.notes)}`);
    } catch (e) { console.log('  ❌ POST entries:', e.message); fail++; }

    try {
        const r = await get(`/api/entries?weekEnding=${weekEnding}`, { Authorization: `Bearer ${userToken}` });
        check('GET /api/entries?weekEnding', r.status, 200);
        console.log(`     Entries found: ${r.body.length}`);
    } catch (e) { fail++; }

    try {
        const r = await patch(`/api/entries/${entryId}`, { mon: 7.5, notes: { mon: 'Updated note', tue: 'Task B' } },
            { Authorization: `Bearer ${userToken}` });
        check('PATCH /api/entries/:id', r.status, 200);
        console.log(`     Updated mon: ${r.body.mon}, notes: ${JSON.stringify(r.body.notes)}`);
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
            scheduleId: createdSchedId,
            weekEnding: '2026-03-08',
            hours: { mon: 6, tue: 7, wed: 8, thu: 7, fri: 6 },
            notes: { mon: 'External submission' }
        }, { 'x-api-key': apiKey });
        check('POST /api/external/submit-timesheet', r.status, 200);
        console.log(`     isSubmitted: ${r.body.entry?.isSubmitted}, Total days set`);
    } catch (e) { console.log('  ❌ external submit:', e.message); fail++; }

    try {
        const r = await patch('/api/external/update-note',
            { entryId, day: 'monday', text: 'Bad key' },
            { 'x-api-key': 'WRONG_KEY' });
        check('Invalid X-API-KEY rejected (401)', r.status, 401);
    } catch (e) { fail++; }

    // 6. Submit a time entry
    console.log('\n6. Submit Flow');
    try {
        const r = await post(`/api/entries/${entryId}/submit`, {},
            { Authorization: `Bearer ${userToken}` });
        check('POST /api/entries/:id/submit', r.status, 200);
        console.log(`     isSubmitted: ${r.body.isSubmitted}`);
    } catch (e) { fail++; }

    try {
        const r = await patch(`/api/entries/${entryId}`, { mon: 1 },
            { Authorization: `Bearer ${userToken}` });
        check('Edit after submit blocked (400)', r.status, 400);
    } catch (e) { fail++; }

    console.log(`\n${'='.repeat(38)}`);
    console.log(`  PASSED: ${ok}  |  FAILED: ${fail}`);
    console.log(`${'='.repeat(38)}\n`);
    process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
