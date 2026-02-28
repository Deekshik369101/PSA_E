require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 9000;
const JWT_SECRET = process.env.JWT_SECRET || 'psa-secret';
const EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY || 'psa-external-api-key-uipath-2024';
const EXTERNAL_PROJECT_KEY = process.env.EXTERNAL_PROJECT_KEY || 'psa-external-copy-key-2024';

// ─── In-memory trigger (signals frontend to run automation workflow) ───────────
let pendingTrigger = { active: false, workflowData: null };

// ─── Hardcoded Credentials ───────────────────────────────────────────────────
const USERS = [
  { id: 1, username: 'admin', password: 'admin123', role: 'ADMIN' },
  { id: 2, username: 'user1', password: 'user123', role: 'USER' },
  { id: 3, username: 'user2', password: 'user123', role: 'USER' },
];

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── JWT Auth Middleware ──────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const token = authHeader.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden: Admin only' });
  }
  next();
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== EXTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

function requireProjectKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== EXTERNAL_PROJECT_KEY) {
    return res.status(401).json({ error: 'Invalid project API key' });
  }
  next();
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// ─── Admin: User List ─────────────────────────────────────────────────────────
app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
  res.json(USERS.map(u => ({ id: u.id, username: u.username, role: u.role })));
});

// ─── Schedule Routes ──────────────────────────────────────────────────────────
// GET /api/schedules - Admin gets all; User gets their own
app.get('/api/schedules', authenticate, async (req, res) => {
  try {
    const where = req.user.role === 'ADMIN' ? {} : { userId: req.user.id };
    const schedules = await prisma.schedule.findMany({
      where,
      include: { user: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules - Admin creates a task
app.post('/api/schedules', authenticate, requireAdmin, async (req, res) => {
  try {
    const { projectTitle, userId, projectType } = req.body;
    if (!projectTitle) return res.status(400).json({ error: 'projectTitle required' });
    if (!userId) return res.status(400).json({ error: 'userId required — please select a user' });

    const validTypes = ['Customer Project', 'Internal_Productive (EMS)', 'Internal_Overhead (EMS)'];
    const resolvedType = validTypes.includes(projectType) ? projectType : 'Customer Project';

    const schedule = await prisma.schedule.create({
      data: { projectTitle, userId: parseInt(userId), isAssigned: true, projectType: resolvedType },
    });
    res.status(201).json(schedule);
  } catch (err) {
    // Handle unique constraint violation
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A schedule with this title is already assigned to this user.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/schedules/:id/assign - Admin assigns schedule to a user
app.patch('/api/schedules/:id/assign', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId, projectType } = req.body;
    const data = { userId: parseInt(userId), isAssigned: true };
    if (projectType) data.projectType = projectType;
    const schedule = await prisma.schedule.update({
      where: { id: parseInt(req.params.id) },
      data,
    });
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/schedules/:id - Admin deletes a schedule
app.delete('/api/schedules/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await prisma.timeEntry.deleteMany({ where: { scheduleId: parseInt(req.params.id) } });
    await prisma.schedule.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Time Entry Routes ────────────────────────────────────────────────────────
// GET /api/entries?weekEnding=YYYY-MM-DD&scheduleId=X
// BUG FIX: Scoped to the calling user's schedules (not all entries)
app.get('/api/entries', authenticate, async (req, res) => {
  try {
    const { weekEnding, scheduleId } = req.query;

    // Scope to user's own schedules (admins see all)
    const scheduleFilter = req.user.role === 'ADMIN'
      ? {}
      : { userId: req.user.id };
    const userSchedules = await prisma.schedule.findMany({
      where: scheduleFilter,
      select: { id: true },
    });
    const userScheduleIds = userSchedules.map(s => s.id);

    const where = { scheduleId: { in: userScheduleIds } };
    if (weekEnding) {
      // Compare by date string to avoid UTC offset issues
      const d = new Date(weekEnding + 'T00:00:00.000Z');
      // Use a range: weekEnding day (UTC midnight) to next day
      const next = new Date(d);
      next.setUTCDate(next.getUTCDate() + 1);
      where.weekEnding = { gte: d, lt: next };
    }
    if (scheduleId) where.scheduleId = parseInt(scheduleId);

    const entries = await prisma.timeEntry.findMany({
      where,
      include: { schedule: true },
      orderBy: { createdAt: 'desc' },
    });
    const parsed = entries.map(e => ({ ...e, notes: safeParseJSON(e.notes) }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/entries - Create a new time entry
// BUG FIX: Prevent duplicate entries for same schedule+week (upsert logic)
app.post('/api/entries', authenticate, async (req, res) => {
  try {
    const { scheduleId, weekEnding, mon, tue, wed, thu, fri, sat, sun, notes } = req.body;
    if (!scheduleId || !weekEnding) {
      return res.status(400).json({ error: 'scheduleId and weekEnding required' });
    }

    const weekDate = new Date(weekEnding + 'T00:00:00.000Z');
    const nextDay = new Date(weekDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    // BUG FIX #1: Check existing entry for this schedule+week to avoid duplicates
    const existing = await prisma.timeEntry.findFirst({
      where: {
        scheduleId: parseInt(scheduleId),
        weekEnding: { gte: weekDate, lt: nextDay },
      },
    });

    if (existing) {
      // Update existing instead of creating duplicate
      const updated = await prisma.timeEntry.update({
        where: { id: existing.id },
        data: {
          mon: mon ?? existing.mon,
          tue: tue ?? existing.tue,
          wed: wed ?? existing.wed,
          thu: thu ?? existing.thu,
          fri: fri ?? existing.fri,
          sat: sat ?? existing.sat,
          sun: sun ?? existing.sun,
          notes: notes ? JSON.stringify(notes) : existing.notes,
          status: 'Saved',
        },
      });
      return res.status(200).json({ ...updated, notes: safeParseJSON(updated.notes) });
    }

    const entry = await prisma.timeEntry.create({
      data: {
        scheduleId: parseInt(scheduleId),
        weekEnding: weekDate,
        mon: mon ?? null, tue: tue ?? null, wed: wed ?? null,
        thu: thu ?? null, fri: fri ?? null, sat: sat ?? null, sun: sun ?? null,
        notes: notes ? JSON.stringify(notes) : '{}',
        status: 'Draft',
      },
    });
    res.status(201).json({ ...entry, notes: safeParseJSON(entry.notes) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/entries/:id - Update hours and/or notes (status → Saved)
app.patch('/api/entries/:id', authenticate, async (req, res) => {
  try {
    const entryId = parseInt(req.params.id);
    const existing = await prisma.timeEntry.findUnique({ where: { id: entryId } });
    if (!existing) return res.status(404).json({ error: 'Entry not found' });
    if (existing.isSubmitted) return res.status(400).json({ error: 'Entry already submitted' });

    const { mon, tue, wed, thu, fri, sat, sun, notes } = req.body;
    const updateData = { status: 'Saved' };
    if (mon !== undefined) updateData.mon = mon;
    if (tue !== undefined) updateData.tue = tue;
    if (wed !== undefined) updateData.wed = wed;
    if (thu !== undefined) updateData.thu = thu;
    if (fri !== undefined) updateData.fri = fri;
    if (sat !== undefined) updateData.sat = sat;
    if (sun !== undefined) updateData.sun = sun;
    if (notes !== undefined) updateData.notes = JSON.stringify(notes);

    const entry = await prisma.timeEntry.update({ where: { id: entryId }, data: updateData });
    res.json({ ...entry, notes: safeParseJSON(entry.notes) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/entries/:id/submit - Lock/submit a time entry (status → Submitted)
app.post('/api/entries/:id/submit', authenticate, async (req, res) => {
  try {
    const entryId = parseInt(req.params.id);
    const entry = await prisma.timeEntry.update({
      where: { id: entryId },
      data: { isSubmitted: true, status: 'Submitted' },
    });
    res.json({ ...entry, notes: safeParseJSON(entry.notes) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── External API Routes (X-API-KEY secured) ─────────────────────────────────

// POST /api/external/schedules/trigger-copy-all
app.post('/api/external/schedules/trigger-copy-all', requireProjectKey, (req, res) => {
  const { hours, notes } = req.body || {};
  const workflowData = (hours || notes) ? { hours: hours || {}, notes: notes || '' } : null;
  pendingTrigger = { active: true, workflowData };
  res.json({
    success: true,
    mode: workflowData ? 'full-workflow' : 'select-and-copy',
    message: workflowData
      ? 'Full 6-step workflow queued. Frontend will execute it on the next poll cycle (~3 s).'
      : 'Copy-all trigger queued. Frontend will pick it up on the next poll cycle (~3 s).',
    workflowData,
  });
});

// GET /api/external/schedules/copy-all-pending
app.get('/api/external/schedules/copy-all-pending', authenticate, (req, res) => {
  const { active, workflowData } = pendingTrigger;
  if (active) pendingTrigger = { active: false, workflowData: null };
  res.json({ pending: active, workflowData });
});

const DAY_MAP = {
  monday: 'mon', tuesday: 'tue', wednesday: 'wed',
  thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun',
  mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu',
  fri: 'fri', sat: 'sat', sun: 'sun',
};

// PATCH /api/external/update-note
app.patch('/api/external/update-note', requireApiKey, async (req, res) => {
  try {
    const { entryId, day, text, append } = req.body;
    if (!entryId || !day || text === undefined) {
      return res.status(400).json({ error: 'entryId, day, and text are required' });
    }
    const dayKey = DAY_MAP[day.toLowerCase()];
    if (!dayKey) return res.status(400).json({ error: `Invalid day: ${day}` });

    const existing = await prisma.timeEntry.findUnique({ where: { id: parseInt(entryId) } });
    if (!existing) return res.status(404).json({ error: 'Entry not found' });

    const notes = safeParseJSON(existing.notes);
    if (append && notes[dayKey]) {
      notes[dayKey] = notes[dayKey] + '\n' + text;
    } else {
      notes[dayKey] = text;
    }

    const updated = await prisma.timeEntry.update({
      where: { id: parseInt(entryId) },
      data: { notes: JSON.stringify(notes) },
    });
    res.json({ success: true, entry: { ...updated, notes: safeParseJSON(updated.notes) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/external/submit-timesheet  — Lock + submit (Friday only)
app.post('/api/external/submit-timesheet', requireApiKey, async (req, res) => {
  try {
    const { scheduleId, weekEnding, hours, notes, userId } = req.body;
    if (!scheduleId || !weekEnding) {
      return res.status(400).json({ error: 'scheduleId and weekEnding required' });
    }

    const weekDate = new Date(weekEnding + 'T00:00:00.000Z');
    const nextDay = new Date(weekDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    const existing = await prisma.timeEntry.findFirst({
      where: { scheduleId: parseInt(scheduleId), weekEnding: { gte: weekDate, lt: nextDay } },
    });

    const data = {
      scheduleId: parseInt(scheduleId),
      weekEnding: weekDate,
      mon: hours?.mon ?? hours?.monday ?? null,
      tue: hours?.tue ?? hours?.tuesday ?? null,
      wed: hours?.wed ?? hours?.wednesday ?? null,
      thu: hours?.thu ?? hours?.thursday ?? null,
      fri: hours?.fri ?? hours?.friday ?? null,
      sat: hours?.sat ?? hours?.saturday ?? null,
      sun: hours?.sun ?? hours?.sunday ?? null,
      notes: notes ? JSON.stringify(notes) : '{}',
      isSubmitted: true,
      status: 'Submitted',
    };

    let entry;
    if (existing) {
      entry = await prisma.timeEntry.update({ where: { id: existing.id }, data });
    } else {
      entry = await prisma.timeEntry.create({ data });
    }
    res.json({ success: true, entry: { ...entry, notes: safeParseJSON(entry.notes) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/external/save-timesheet  — Save draft (Mon–Thu, not locked)
app.post('/api/external/save-timesheet', requireApiKey, async (req, res) => {
  try {
    const { scheduleId, weekEnding, hours, notes, userId } = req.body;
    if (!scheduleId || !weekEnding) {
      return res.status(400).json({ error: 'scheduleId and weekEnding required' });
    }

    const weekDate = new Date(weekEnding + 'T00:00:00.000Z');
    const nextDay = new Date(weekDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    const existing = await prisma.timeEntry.findFirst({
      where: {
        scheduleId: parseInt(scheduleId),
        weekEnding: { gte: weekDate, lt: nextDay },
        isSubmitted: false   // never overwrite a locked/submitted entry
      },
    });

    const data = {
      scheduleId: parseInt(scheduleId),
      weekEnding: weekDate,
      mon: hours?.mon ?? hours?.monday ?? null,
      tue: hours?.tue ?? hours?.tuesday ?? null,
      wed: hours?.wed ?? hours?.wednesday ?? null,
      thu: hours?.thu ?? hours?.thursday ?? null,
      fri: hours?.fri ?? hours?.friday ?? null,
      sat: hours?.sat ?? hours?.saturday ?? null,
      sun: hours?.sun ?? hours?.sunday ?? null,
      notes: notes ? JSON.stringify(notes) : '{}',
      isSubmitted: false,
      status: 'Saved',
    };

    let entry;
    if (existing) {
      entry = await prisma.timeEntry.update({ where: { id: existing.id }, data });
    } else {
      entry = await prisma.timeEntry.create({ data });
    }
    res.json({ success: true, entry: { ...entry, notes: safeParseJSON(entry.notes) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/external/projects — list all schedules with projectType
app.get('/api/external/projects', requireApiKey, async (req, res) => {
  try {
    const schedules = await prisma.schedule.findMany({
      include: { user: { select: { id: true, username: true } } },
    });
    const projects = schedules.map(s => ({
      id: s.id.toString(),
      name: s.projectTitle,
      projectType: s.projectType,
      client: 'Internal',
      wbsCode: `WBS-${s.id}`,
      userId: s.userId?.toString(),
      assignedTo: s.user?.username || null,
    }));
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeParseJSON(str) {
  try { return JSON.parse(str || '{}'); } catch { return {}; }
}

// ─── Catch-all: serve SPA ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ PSA Time Entry Server running on http://localhost:${PORT}`);
  console.log(`   External API Key: ${EXTERNAL_API_KEY}`);
});
