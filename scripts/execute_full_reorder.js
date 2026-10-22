const fs = require('fs');

const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

async function fetchAll(table, select = '*') {
  let all = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}&offset=${offset}&limit=${limit}`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    if (!res.ok) throw new Error(`Fetch ${table} failed: ${res.status}`);
    const rows = await res.json();
    if (!rows || rows.length === 0) break;
    all = all.concat(rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

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

async function deleteSale(saleId) {
  const url = `${SUPABASE_URL}/rest/v1/sales?id=eq.${saleId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to delete sale id ${saleId}: ${res.status} ${err}`);
  }
}

async function run() {
  console.log('=== STARTING COMPLETE PRODUCTION REORDERING & DEDUPLICATION ===');

  // 1. Fetch and create fresh complete backup
  console.log('1. Fetching all sales and items from Supabase...');
  const allSales = await fetchAll('sales');
  const allItems = await fetchAll('sale_items');
  console.log(`   Fetched ${allSales.length} sales and ${allItems.length} sale_items.`);

  if (!fs.existsSync('backups')) fs.mkdirSync('backups');
  const timestamp = Date.now();
  const salesBackupPath = `backups/sales_backup_full_${timestamp}.json`;
  const itemsBackupPath = `backups/items_backup_full_${timestamp}.json`;
  fs.writeFileSync(salesBackupPath, JSON.stringify(allSales, null, 2));
  fs.writeFileSync(itemsBackupPath, JSON.stringify(allItems, null, 2));
  console.log(`✅ 2. Complete backup saved:`);
  console.log(`   - ${salesBackupPath}`);
  console.log(`   - ${itemsBackupPath}`);

  // 2. Remove confirmed 3 empty ghost duplicates (IDs: 184, 24364, 24365)
  console.log('\n3. Cleaning up 3 confirmed empty ghost duplicate sales:');
  const ghostIds = [184, 24364, 24365];
  for (const id of ghostIds) {
    const s = allSales.find(x => x.id === id);
    const hasItems = allItems.some(it => it.sale_id === id);
    if (!hasItems) {
      console.log(`   Deleting empty duplicate ghost sale ID ${id} (Date: ${s ? s.date : 'unknown'}, Total: ${s ? s.total_amount : 'unknown'})...`);
      await deleteSale(id);
      console.log(`   ✅ Sale ID ${id} deleted successfully.`);
    } else {
      console.error(`   ⚠️ ABORTING delete for ID ${id}: Unexpectedly has items!`);
      process.exit(1);
    }
  }

  // 3. Filter active sales
  const activeSales = allSales.filter(s => !ghostIds.includes(s.id));
  console.log(`\n4. Active sales remaining: ${activeSales.length}`);

  // Sort strictly chronological: date ASC, then id ASC
  activeSales.sort((a, b) => {
    const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (diff !== 0) return diff;
    return a.id - b.id;
  });

  // Group by month
  const months = {};
  activeSales.forEach(s => {
    const d = new Date(s.date);
    const m = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (!months[m]) months[m] = [];
    months[m].push(s);
  });

  const targets = [];
  Object.entries(months).forEach(([month, rows]) => {
    console.log(`   Month ${month}: ${rows.length} sales -> Sequence #1 to #${rows.length}`);
    rows.forEach((s, idx) => {
      targets.push({
        id: s.id,
        date: s.date,
        oldBillNo: s.bill_no,
        newBillNo: idx + 1
      });
    });
  });

  // 4. Phase 1: Set temporary negative bill numbers
  console.log('\n5. --- PHASE 1: Setting temporary negative bill numbers ---');
  let p1 = 0;
  for (const t of targets) {
    await updateSaleBillNo(t.id, -t.newBillNo);
    p1++;
    if (p1 % 50 === 0 || p1 === targets.length) {
      console.log(`   Phase 1 progress: ${p1}/${targets.length} updated`);
    }
  }

  // 5. Phase 2: Set final positive sequential bill numbers
  console.log('\n6. --- PHASE 2: Setting final positive chronological bill numbers ---');
  let p2 = 0;
  for (const t of targets) {
    await updateSaleBillNo(t.id, t.newBillNo);
    p2++;
    if (p2 % 50 === 0 || p2 === targets.length) {
      console.log(`   Phase 2 progress: ${p2}/${targets.length} updated`);
    }
  }

  console.log('\n=== REORDERING COMPLETE. RUNNING POST-MIGRATION VERIFICATION ===');
}

run().catch(err => {
  console.error('\n❌ CRITICAL REORDER ERROR:', err);
  process.exit(1);
});
