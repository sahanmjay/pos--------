const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

async function checkDetails() {
  const ids = [184, 185, 23449, 24372, 23451, 24373, 24374, 23461, 24375, 24364, 24380, 24365, 24384, 24389, 24390];
  const sRes = await fetch(SUPABASE_URL + '/rest/v1/sales?id=in.(' + ids.join(',') + ')&select=*', {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  const sales = await sRes.json();
  const iRes = await fetch(SUPABASE_URL + '/rest/v1/sale_items?sale_id=in.(' + ids.join(',') + ')&select=*', {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  const items = await iRes.json();
  
  sales.sort((a,b) => a.id - b.id);
  sales.forEach(s => {
    const sItems = items.filter(it => it.sale_id === s.id);
    console.log('--- SALE ID:', s.id, '(Bill #' + s.bill_no + ') ---');
    console.log('Date:', s.date, '| Total:', s.total_amount, '| Status:', s.status, '| Pay:', s.payment_type);
    console.log('Items (' + sItems.length + '):', sItems.map(i => i.product_name + ' (qty: ' + i.quantity + ', price: ' + i.unit_price + ', total: ' + i.line_total + ')'));
    console.log('');
  });
}
checkDetails().catch(console.error);
