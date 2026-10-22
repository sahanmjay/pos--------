
const fs = require('fs');

const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

async function fetchAllSales() {
  let allSales = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/sales?select=*&order=bill_no.asc&offset=${offset}&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to fetch sales: ${res.status} ${err}`);
    }

    const batch = await res.json();
    if (!batch || batch.length === 0) break;
    allSales = allSales.concat(batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return allSales;
}

async function verify() {
  console.log('=== RUNNING POST-REORDER VERIFICATION ===');
  const sales = await fetchAllSales();
  console.log(`1. Total sales records in Supabase: ${sales.length}`);

  // Load the newest full backup
  const backupFiles = fs.readdirSync('backups').filter(f => f.startsWith('sales_backup_full_'));
  backupFiles.sort().reverse();
  const latestBackupFile = 'backups/' + backupFiles[0];
  console.log(`2. Comparing with backup: ${latestBackupFile}`);
  const originalBackup = JSON.parse(fs.readFileSync(latestBackupFile, 'utf8'));

  const ghostIds = new Set([184, 24364, 24365]);
  const expectedCount = originalBackup.length - ghostIds.size;

  if (sales.length !== expectedCount) {
    console.error(`❌ COUNT MISMATCH: Expected ${expectedCount}, got ${sales.length}`);
    process.exit(1);
  }
  console.log(`✅ Count verified: Exactly ${sales.length} active sales (3 ghost duplicates removed).`);

  // Map by id to check field-level data integrity
  const backupMap = new Map(originalBackup.map(s => [s.id, s]));
  let integrityFailed = false;

  for (const s of sales) {
    const orig = backupMap.get(s.id);
    if (!orig) {
      console.error(`❌ UNEXPECTED RECORD: Sale ID ${s.id} not found in backup!`);
      integrityFailed = true;
      break;
    }
    // Verify untouched fields
    if (orig.date !== s.date ||
        Number(orig.total_amount) !== Number(s.total_amount) ||
        orig.payment_type !== s.payment_type ||
        orig.customer_id !== s.customer_id) {
      console.error(`❌ DATA MUTATION DETECTED on Sale ID ${s.id}!`);
      integrityFailed = true;
      break;
    }
  }

  if (integrityFailed) process.exit(1);
  console.log('✅ 3. Data Integrity: 100% of dates, amounts, customers, and payments match backup exactly.');

  // Check sequential bill numbers 1 to 516
  const billNos = sales.map(s => s.bill_no);
  const minBill = Math.min(...billNos);
  const maxBill = Math.max(...billNos);
  const uniqueBills = new Set(billNos);

  console.log(`4. Bill numbers range: min #${minBill} to max #${maxBill}`);
  console.log(`5. Unique bill numbers count: ${uniqueBills.size}/${sales.length}`);

  if (uniqueBills.size !== sales.length || minBill !== 1 || maxBill !== sales.length) {
    console.error(`❌ BILL NUMBER SEQUENCE ERROR: Expected 1..${sales.length}, got min ${minBill}, max ${maxBill}, unique ${uniqueBills.size}`);
    process.exit(1);
  }
  console.log(`✅ 6. Sequential Integrity: Bills strictly cover #1 to #${sales.length} without any gaps or duplicates.`);

  // Check chronological order (each bill_no must have timestamp >= previous bill_no)
  let chronoViolations = 0;
  for (let i = 0; i < sales.length - 1; i++) {
    const currTime = new Date(sales[i].date).getTime();
    const nextTime = new Date(sales[i + 1].date).getTime();
    if (currTime > nextTime) {
      console.error(`❌ CHRONOLOGICAL VIOLATION: Bill #${sales[i].bill_no} (${sales[i].date}) is AFTER Bill #${sales[i+1].bill_no} (${sales[i+1].date})`);
      chronoViolations++;
    }
  }

  if (chronoViolations === 0) {
    console.log(`✅ 7. Chronological Integrity: All ${sales.length} bills are strictly sorted from earliest to latest.`);
  } else {
    console.error(`❌ Found ${chronoViolations} chronological order violations!`);
    process.exit(1);
  }

  // Print day transitions
  console.log('\n--- Day-to-Day Continuity Check ---');
  const dayGroups = {};
  sales.forEach(s => {
    const day = s.date.split('T')[0];
    if (!dayGroups[day]) dayGroups[day] = [];
    dayGroups[day].push(s);
  });

  Object.entries(dayGroups).forEach(([day, rows]) => {
    console.log(`  ${day}: ${rows.length} bills | Starts: #${rows[0].bill_no} | Ends: #${rows[rows.length - 1].bill_no}`);
  });

  console.log('\n🎉 ALL SAFETY, CONTINUITY, AND INTEGRITY AUDITS PASSED WITH ZERO ERRORS!');
}

verify().catch(console.error);
