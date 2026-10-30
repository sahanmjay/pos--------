// Runs billTotals from app.js: service charge, then tax on top.
// node tests/bill-totals-check.js   (reads ../app.js; no database, no network)
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'app.js'), 'utf8');

function extract(startPattern) {
  const start = src.search(startPattern);
  if (start < 0) throw new Error('Not found: ' + startPattern);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

const billTotals = new Function(extract(/^function billTotals\(/m) + '\nreturn billTotals;')();

// 10% service charge, no tax: the bill from the till photo
assert.deepStrictEqual(billTotals(17700, 0, 0.10, 0), { serviceCharge: 1770, tax: 0, total: 19470 });
// Service charge is on the amount after discount
assert.deepStrictEqual(billTotals(1000, 200, 0.10, 0), { serviceCharge: 80, tax: 0, total: 880 });
// Tax is charged on the service charge too
assert.deepStrictEqual(billTotals(1000, 0, 0.10, 0.18), { serviceCharge: 100, tax: 198, total: 1298 });
// No service charge (takeaway, or removed for this bill)
assert.deepStrictEqual(billTotals(1000, 0, 0, 0.18), { serviceCharge: 0, tax: 180, total: 1180 });
// Cents round once each, so the printed lines add up to the total
const t = billTotals(333.33, 0, 0.10, 0.08);
assert.strictEqual(t.total, Math.round((333.33 + t.serviceCharge + t.tax) * 100) / 100);
// A discount larger than the bill never makes it negative
assert.deepStrictEqual(billTotals(500, 900, 0.10, 0.18), { serviceCharge: 0, tax: 0, total: 0 });

console.log('bill-totals-check: all passed');
