const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

async function fetchAll(table, select = '*') {
  let all = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}&offset=${offset}&limit=${limit}`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
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

async function simulate() {
  console.log('Fetching all current sales from Supabase...');
  const sales = await fetchAll('sales');
  console.log(`Current total sales: ${sales.length}`);

  // Ghost empty duplicate IDs to prune: 184, 24364, 24365
  const ghostIds = new Set([184, 24364, 24365]);
  const activeSales = sales.filter(s => !ghostIds.has(s.id));
  console.log(`Active sales after removing 3 empty duplicates: ${activeSales.length}`);

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

  for (const [m, rows] of Object.entries(months)) {
    console.log(`\n=== Month ${m} (${rows.length} sales) ===`);
    console.log(`Sequential bill numbers: #1 to #${rows.length}`);

    // Group by day to show day-to-day continuity
    const days = {};
    rows.forEach((s, idx) => {
      const day = s.date.split('T')[0];
      if (!days[day]) days[day] = [];
      days[day].push({ ...s, newBillNo: idx + 1 });
    });

    for (const [day, dayRows] of Object.entries(days)) {
      const first = dayRows[0];
      const last = dayRows[dayRows.length - 1];
      console.log(`  ${day}: ${dayRows.length} bills | Starts: #${first.newBillNo} (${first.date.split('T')[1].substring(0,8)}) | Ends: #${last.newBillNo} (${last.date.split('T')[1].substring(0,8)})`);
    }
  }

  // Check the last 15 sales of Oct 21 in detail
  const oct21 = activeSales.filter(s => s.date.startsWith('2026-10-21'));
  console.log(`\n--- October 21 Sales Breakdown (${oct21.length} sales) ---`);
  oct21.forEach(s => {
    const idx = activeSales.indexOf(s);
    console.log(`ID: ${s.id} | New Bill: #${idx + 1} (was #${s.bill_no}) | Time: ${s.date} | Amount: Rs. ${s.total_amount}`);
  });
}

simulate().catch(console.error);
