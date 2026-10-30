// Runs moveTableItems from app.js: moving, merging and splitting table orders.
// node tests/table-move-check.js   (reads ../app.js; no database, no network)
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

const moveTableItems = new Function(extract(/^function moveTableItems\(/m) + '\nreturn moveTableItems;')();

const line = (product_id, quantity, unit_price = 100, notes = '') => ({ product_id, name: 'P' + product_id, quantity, unit_price, notes });
const value = o => (o ? o.items.reduce((a, i) => a + i.quantity * i.unit_price, 0) : 0);
const order = (items, openedAt = '2026-10-30T10:00:00Z') => ({ items, customerId: 7, openedAt, kots: [] });

// Move: whole order to an empty table
let orders = { A: order([line(1, 2), line(2, 1)]) };
moveTableItems(orders, 'A', 'B', null);
assert.ok(!orders.A, 'source is freed');
assert.strictEqual(orders.B.items.length, 2);
assert.strictEqual(orders.B.customerId, 7, 'customer carries over');

// Move onto a table that is only waiting to be cleaned counts as empty
orders = { A: order([line(1, 1)]), B: { items: [], cleaning: true } };
moveTableItems(orders, 'A', 'B', null);
assert.strictEqual(orders.B.items.length, 1);
assert.ok(!orders.B.cleaning, 'a table with guests is no longer waiting to be cleaned');

// Merge: matching lines add up, others are appended, earliest openedAt wins
orders = {
  A: order([line(1, 2), line(3, 1, 250)], '2026-10-30T09:00:00Z'),
  B: order([line(1, 1), line(1, 1, 100, 'no chilli')], '2026-10-30T10:00:00Z'),
};
let before = value(orders.A) + value(orders.B);
moveTableItems(orders, 'A', 'B', null);
assert.ok(!orders.A);
assert.strictEqual(orders.B.items.find(i => i.product_id === 1 && !i.notes).quantity, 3, 'same product, price and note merge');
assert.strictEqual(orders.B.items.find(i => i.notes === 'no chilli').quantity, 1, 'a different note stays its own line');
assert.strictEqual(orders.B.items.length, 3);
assert.strictEqual(orders.B.openedAt, '2026-10-30T09:00:00Z');
assert.strictEqual(value(orders.B), before, 'nothing lost or doubled');

// Split part of a line
orders = { A: order([line(1, 3), line(2, 2)]) };
before = value(orders.A);
moveTableItems(orders, 'A', 'B', [{ index: 0, qty: 1 }]);
assert.strictEqual(orders.A.items[0].quantity, 2);
assert.strictEqual(orders.B.items[0].quantity, 1);
assert.strictEqual(value(orders.A) + value(orders.B), before);

// Split the last units: the line goes, and the source goes when empty
orders = { A: order([line(1, 1), line(2, 2)]) };
moveTableItems(orders, 'A', 'B', [{ index: 1, qty: 2 }]);
assert.strictEqual(orders.A.items.length, 1, 'emptied line removed');
moveTableItems(orders, 'A', 'B', [{ index: 0, qty: 1 }]);
assert.ok(!orders.A, 'source freed when nothing is left');
assert.strictEqual(value(orders.B), 300);

// Asking for more than the line has moves only what is there
orders = { A: order([line(1, 2)]) };
moveTableItems(orders, 'A', 'B', [{ index: 0, qty: 5 }]);
assert.ok(!orders.A);
assert.strictEqual(orders.B.items[0].quantity, 2);

// The table copy is independent: changing it never changes the source line
orders = { A: order([line(1, 2)]) };
moveTableItems(orders, 'A', 'B', [{ index: 0, qty: 1 }]);
orders.B.items[0].quantity = 9;
assert.strictEqual(orders.A.items[0].quantity, 1);

console.log('table-move-check: all passed');
