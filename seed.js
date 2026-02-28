require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {

    console.log('🔄 Seeding database...');

    // ─────────────────────────────────────────────
    // 1️⃣ FORCE CREATE USERS WITH FIXED IDS
    // ─────────────────────────────────────────────
    await prisma.user.createMany({
        data: [
            { id: 1, username: 'admin', role: 'ADMIN' },
            { id: 2, username: 'user1', role: 'USER' },
            { id: 3, username: 'user2', role: 'USER' }
        ],
        skipDuplicates: true
    });

    console.log('✅ Users seeded with fixed IDs');

    // ─────────────────────────────────────────────
    // 2️⃣ SEED SCHEDULES
    // ─────────────────────────────────────────────
    const sampleSchedules = [
        { projectTitle: 'ERP Upgrade Project', userId: 2, isAssigned: true, projectType: 'Customer Project' },
        { projectTitle: 'Data Migration Initiative', userId: 2, isAssigned: true, projectType: 'Customer Project' },
        { projectTitle: 'HR Portal Enhancement', userId: 2, isAssigned: true, projectType: 'Internal_Productive (EMS)' },
        { projectTitle: 'Task101', userId: 2, isAssigned: true, projectType: 'Internal_Productive (EMS)' },
        { projectTitle: 'PS Internship', userId: 2, isAssigned: true, projectType: 'Internal_Productive (EMS)' },
        { projectTitle: 'LCTCS - billable', userId: 2, isAssigned: true, projectType: 'Customer Project' },
        { projectTitle: 'LCTCS - non billable', userId: 2, isAssigned: true, projectType: 'Internal_Overhead (EMS)' },
        { projectTitle: 'Finance Module Support', userId: 3, isAssigned: true, projectType: 'Customer Project' },
        { projectTitle: 'IT Infrastructure Review', userId: 3, isAssigned: true, projectType: 'Internal_Overhead (EMS)' },
    ];

    for (const s of sampleSchedules) {
        await prisma.schedule.upsert({
            where: {
                projectTitle_userId: {
                    projectTitle: s.projectTitle,
                    userId: s.userId
                }
            },
            update: {
                projectType: s.projectType,
                isAssigned: s.isAssigned
            },
            create: s
        });
    }

    console.log('✅ Sample schedules seeded');

    console.log('\n📋 Login Credentials:');
    console.log('   Admin → username: admin  | password: admin123');
    console.log('   User1 → username: user1  | password: user123');
    console.log('   User2 → username: user2  | password: user123');
}

main()
    .catch(e => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());