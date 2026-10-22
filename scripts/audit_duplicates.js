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

async function run() {
  console.log('Fetching sales and items...');
  const sales = await fetchAll('sales', 'id,bill_no,date,total_amount,payment_type,status,organization_id,customer_id');
  const items = await fetchAll('sale_items', 'id,sale_id,product_name,quantity,line_total');

  console.log(`Fetched ${sales.length} sales and ${items.length} sale_items.`);

  const itemsBySale = new Map();
  items.forEach(it => {
    if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, []);
    itemsBySale.get(it.sale_id).push(it);
  });

  // Group by (date + total_amount)
  const exactDupes = [];
  const map = new Map();
  sales.forEach(s => {
    const key = `${s.date}_${Number(s.total_amount)}`;
    if (map.has(key)) {
      exactDupes.push({ original: map.get(key), dupe: s });
    } else {
      map.set(key, s);
    }
  });

  console.log(`\nExact (date + amount) duplicates: ${exactDupes.length}`);
  exactDupes.forEach(d => {
    const oItems = itemsBySale.get(d.original.id) || [];
    const dItems = itemsBySale.get(d.dupe.id) || [];
    console.log(`  Orig ID: ${d.original.id} (Bill: ${d.original.bill_no}, Items: ${oItems.length}) <---> Dupe ID: ${d.dupe.id} (Bill: ${d.dupe.bill_no}, Items: ${dItems.length}) Date: ${d.original.date} Total: ${d.original.total_amount}`);
  });

  // Check sales with 0 items
  const emptySales = sales.filter(s => (itemsBySale.get(s.id) || []).length === 0);
  console.log(`\nSales with 0 items: ${emptySales.length}`);
  emptySales.forEach(s => {
    console.log(`  ID: ${s.id}, Bill: ${s.bill_no}, Date: ${s.date}, Total: ${s.total_amount}`);
  });

  // Close-in-time duplicates (e.g. repeated checkout within 60s with identical items or total)
  console.log('\nChecking Oct 20 & 21 sales:');
  const recentSales = sales.filter(s => s.date >= '2026-10-20T00:00:00.000Z');
  recentSales.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  recentSales.forEach(s => {
    const its = itemsBySale.get(s.id) || [];
    const itStr = its.map(i => `${i.product_name}x${i.quantity}`).join(', ');
    console.log(`ID: ${s.id} | Bill: #${s.bill_no} | Date: ${s.date} | Total: ${s.total_amount} | Items (${its.length}): ${itStr}`);
  });
}

run().catch(console.error);
