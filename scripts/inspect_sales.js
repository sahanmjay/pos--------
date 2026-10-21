const fs = require('fs');

const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

async function fetchAllSales() {
  let allSales = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/sales?select=*&order=date.asc,id.asc&offset=${offset}&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact'
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

async function run() {
  console.log('Fetching all sales from Supabase via REST API...');
  const sales = await fetchAllSales();
  console.log(`Total sales records fetched: ${sales.length}`);

  // Check organizations
  const orgs = {};
  for (const s of sales) {
    orgs[s.organization_id] = (orgs[s.organization_id] || 0) + 1;
  }
  console.log('Sales by organization:', orgs);

  // Group by month YYYY-MM
  const months = {};
  for (const s of sales) {
    const d = new Date(s.date);
    const mKey = isNaN(d.getTime()) ? 'INVALID_DATE' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months[mKey]) months[mKey] = [];
    months[mKey].push(s);
  }

  console.log('\nSales grouped by Month:');
  for (const [m, rows] of Object.entries(months)) {
    console.log(`  Month: ${m} -> ${rows.length} sales. Earliest: ${rows[0].date}, Latest: ${rows[rows.length - 1].date}`);
    // Check bill_no min and max in that month currently
    const billNos = rows.map(r => r.bill_no).filter(n => n !== null && n !== undefined);
    console.log(`    Current bill_no count: ${billNos.length}, null count: ${rows.length - billNos.length}`);
    if (billNos.length > 0) {
      console.log(`    Current bill_no range: min ${Math.min(...billNos)} to max ${Math.max(...billNos)}`);
    }
  }

  // Backup all sales to file
  if (!fs.existsSync('backups')) fs.mkdirSync('backups');
  const backupFile = `backups/sales_backup_${Date.now()}.json`;
  fs.writeFileSync(backupFile, JSON.stringify(sales, null, 2));
  console.log(`\n✅ Safe backup saved to ${backupFile}`);
}

run().catch(console.error);
