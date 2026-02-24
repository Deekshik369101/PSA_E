require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    // Sync DB users (no passwords stored in DB)
    const users = [
        { id: 1, username: 'admin', role: 'ADMIN' },
        { id: 2, username: 'user1', role: 'USER' },
        { id: 3, username: 'user2', role: 'USER' },
    ];

    for (const u of users) {
        await prisma.user.upsert({
            where: { username: u.username },
            update: { role: u.role },
            create: { username: u.username, role: u.role },
        });
    }
    console.log('✅ Users seeded');

    // Sample schedules assigned to user1 (id=2)
    const sampleSchedules = [
        { projectTitle: 'ERP Upgrade Project', userId: 2, isAssigned: true },
        { projectTitle: 'Data Migration Initiative', userId: 2, isAssigned: true },
        { projectTitle: 'HR Portal Enhancement', userId: 2, isAssigned: true },
        { projectTitle: 'Finance Module Support', userId: 3, isAssigned: true },
        { projectTitle: 'IT Infrastructure Review', userId: 3, isAssigned: true },
    ];

    for (const s of sampleSchedules) {
        await prisma.schedule.create({ data: s });
    }
    console.log('✅ Sample schedules seeded');
    console.log('\n📋 Login Credentials:');
    console.log('   Admin → username: admin  | password: admin123');
    console.log('   User1 → username: user1  | password: user123');
    console.log('   User2 → username: user2  | password: user123');
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
