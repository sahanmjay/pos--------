const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

async function checkConstraint() {
  // Let's test what happens if we attempt to set a bill_no that already exists on a single record
  // Sale id 24366 currently has bill_no 505.
  // Sale id 24365 currently has bill_no 504.
  // Let's try to temporarily PATCH id 24366 with bill_no: 504 (which 24365 has)
  console.log('Testing whether duplicate bill_no triggers a constraint...');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?id=eq.24366`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({ bill_no: 504 })
  });

  const status = res.status;
  const body = await res.text();
  console.log('Status:', status);
  console.log('Response:', body);
}

checkConstraint();
