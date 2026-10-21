const fs = require('fs');

const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

async function updateSaleBillNo(saleId, billNo) {
  const url = `${SUPABASE_URL}/rest/v1/sales?id=eq.${saleId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({ bill_no: billNo })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update sale id ${saleId} with bill_no ${billNo}: ${res.status} ${err}`);
  }
  return await res.json();
}

async function run() {
  console.log('=== STARTING SAFE HISTORICAL BILL REORDERING ===');

  // Load verified backup
  const backupFiles = fs.readdirSync('backups').filter(f => f.startsWith('sales_backup_'));
  backupFiles.sort().reverse();
  const latestBackupFile = 'backups/' + backupFiles[0];
  console.log(`Using backup file: ${latestBackupFile}`);
  const sales = JSON.parse(fs.readFileSync(latestBackupFile, 'utf8'));

  console.log(`Total sales to reorder: ${sales.length}`);

  // Sort strictly by date ASC, then id ASC
  sales.sort((a, b) => {
    const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (diff !== 0) return diff;
    return a.id - b.id;
  });

  // Group by month YYYY-MM
  const months = {};
  sales.forEach(s => {
    const d = new Date(s.date);
    const m = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (!months[m]) months[m] = [];
    months[m].push(s);
  });

  // Build target assignment mapping
  const targets = [];
  Object.entries(months).forEach(([month, rows]) => {
    console.log(`Planning month ${month}: ${rows.length} sales -> sequence 1 to ${rows.length}`);
    rows.forEach((s, idx) => {
      const newBillNo = idx + 1;
      targets.push({
        id: s.id,
        date: s.date,
        oldBillNo: s.bill_no,
        newBillNo: newBillNo
      });
    });
  });

  // Phase 1: Set temporary negative numbers to guarantee NO unique constraint collisions
  console.log('\n--- PHASE 1: Setting temporary unique negative bill numbers ---');
  let p1Count = 0;
  for (const t of targets) {
    await updateSaleBillNo(t.id, -t.newBillNo);
    p1Count++;
    if (p1Count % 50 === 0 || p1Count === targets.length) {
      console.log(`Phase 1 progress: ${p1Count}/${targets.length} records updated`);
    }
  }

  // Phase 2: Set final positive bill numbers in chronological sequence
  console.log('\n--- PHASE 2: Setting final chronological positive bill numbers ---');
  let p2Count = 0;
  for (const t of targets) {
    await updateSaleBillNo(t.id, t.newBillNo);
    p2Count++;
    if (p2Count % 50 === 0 || p2Count === targets.length) {
      console.log(`Phase 2 progress: ${p2Count}/${targets.length} records updated`);
    }
  }

  console.log('\n=== REORDERING COMPLETED SUCCESSFULLY ===');
}

run().catch(err => {
  console.error('\n❌ CRITICAL ERROR DURING REORDERING:', err);
  process.exit(1);
});
