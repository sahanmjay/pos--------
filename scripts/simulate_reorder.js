const fs = require('fs');

const backup = JSON.parse(fs.readFileSync('backups/sales_backup_1792568712267.json', 'utf8'));

// Sort strictly by date ASC, then id ASC
backup.sort((a, b) => {
  const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
  if (diff !== 0) return diff;
  return a.id - b.id;
});

// Group by month
const months = {};
backup.forEach(s => {
  const d = new Date(s.date);
  const m = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  if (!months[m]) months[m] = [];
  months[m].push(s);
});

let totalChanged = 0;
const totalSales = backup.length;

Object.entries(months).forEach(([m, rows]) => {
  console.log('Month ' + m + ': ' + rows.length + ' records. Sequence will be 1 to ' + rows.length);
  rows.forEach((s, idx) => {
    const newBillNo = idx + 1;
    if (s.bill_no !== newBillNo) {
      totalChanged++;
    }
  });
});

console.log('Total sales: ' + totalSales);
console.log('Total needing update: ' + totalChanged);

console.log('\n--- Day Breakdown in October ---');
const dayGroups = {};
months['2026-10'].forEach((s, idx) => {
  const day = s.date.split('T')[0];
  if (!dayGroups[day]) dayGroups[day] = [];
  dayGroups[day].push({ id: s.id, time: s.date.split('T')[1], oldBill: s.bill_no, newBill: idx + 1 });
});

Object.entries(dayGroups).forEach(([day, items]) => {
  const first = items[0];
  const last = items[items.length - 1];
  console.log(day + ': ' + items.length + ' bills. Starts at #' + first.newBill + ' (was #' + first.oldBill + '), Ends at #' + last.newBill + ' (was #' + last.oldBill + ')');
});
