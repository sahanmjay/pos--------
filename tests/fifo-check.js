// Runs the real FIFO stock functions from app.js against an in-memory db.
// node tests/fifo-check.js   (reads ../app.js; no database, no network)
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'app.js'), 'utf8');

// Pull one top-level declaration out of app.js by brace matching
function extract(startPattern) {
  const start = src.search(startPattern);
  if (start < 0) throw new Error('Not found: ' + startPattern);
  const line = src.slice(start, src.indexOf('\n', start));
  if (!line.trimEnd().endsWith('{')) return line; // one-liner
  let i = start + line.lastIndexOf('{'), depth = 0; // the body, not a { … } = {} parameter
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  const semi = src.slice(i + 1).match(/^[^\n]*/)[0]; // e.g. ", new Map());"
  return src.slice(start, i + 1) + semi;
}

const code = [
  /^const round3 = /m, /^async function moveStock\(/m, /^const byOldest = /m, /^async function shelfBatches\(/m,
  /^async function addBatch\(/m, /^async function takeFromBatches\(/m, /^function fifoValue\(/m,
  /^async function returnStock\(/m, /^function productRecipe\(/m, /^async function withRecipeIngredients\(/m,
  /^async function recordLineCosts\(/m, /^const groupBy = /m, /^async function dailyStock\(/m,
].map(extract).join('\n\n');

// ── In-memory db with the same calls app.js makes ──
let clock = Date.parse('2026-10-10T08:00:00Z');
const tick = () => new Date(clock += 60000).toISOString();
function table() {
  const rows = new Map(); let next = 1;
  const t = {
    rows,
    async toArray() { return [...rows.values()].map(r => ({ ...r })); },
    async get(id) { const r = rows.get(Number(id)); return r ? { ...r } : null; },
    async add(item) { item.id = next++; rows.set(item.id, { ...item }); return item.id; },
    async update(id, ch) { const r = rows.get(Number(id)); if (r) Object.assign(r, ch); },
    where(field) { return { equals: v => ({ toArray: async () => (await t.toArray()).filter(r => r[field] == v) }) }; },
    async between(field, from, to) { return (await t.toArray()).filter(r => Date.parse(r[field]) >= Date.parse(from) && Date.parse(r[field]) < Date.parse(to)); },
  };
  return t;
}
const db = {
  products: table(), stock_batches: table(), stock_movements: table(), sale_items: table(),
  supportsBatches: async () => true, saleItemsSupportCost: async () => true,
};
// movements get the fake clock, so the daily sheet can be tested
const addMove = db.stock_movements.add;
db.stock_movements.add = async m => addMove({ ...m, date: tick() });
const currentUser = { display_name: 'Tester' };
const tracksStock = p => p.item_type === 'ingredient';
const billNumber = s => s.bill_no;

eval(code + `
(async () => {
  const rice = await db.products.add({ name: 'Rice', item_type: 'ingredient', stock_qty: 0, cost_price: 0, unit: 'kg' });
  const chicken = await db.products.add({ name: 'Chicken', item_type: 'ingredient', stock_qty: 10, cost_price: 90, unit: 'kg' }); // old stock, no batches
  const dish = await db.products.add({ name: 'Chicken Rice', item_type: 'menu', recipe: [{ product_id: rice, qty: 0.5 }, { product_id: chicken, qty: 0.2 }] });

  // 1. Two deliveries at different prices stay separate; old stock keeps its price
  await moveStock(rice, 20, { type: 'receive', unitCost: 100 });
  await moveStock(rice, 50, { type: 'receive', unitCost: 120 });
  let b = (await db.stock_batches.toArray()).filter(x => x.product_id === rice);
  assert.deepStrictEqual(b.map(x => [x.qty_remaining, x.unit_cost]), [[20, 100], [50, 120]]);
  assert.strictEqual((await db.products.get(rice)).cost_price, 120, 'last price paid');

  // 2. One deduction spanning two batches splits, each slice at its own price
  let out = await moveStock(rice, -30, { type: 'sale', reference: 'Bill #1' });
  assert.deepStrictEqual(out, { qty: 30, cost: 20 * 100 + 10 * 120 });
  b = (await db.stock_batches.toArray()).filter(x => x.product_id === rice);
  assert.deepStrictEqual(b.map(x => x.qty_remaining), [0, 40], 'oldest emptied first');
  const slices = (await db.stock_movements.toArray()).filter(m => m.reference === 'Bill #1');
  assert.deepStrictEqual(slices.map(m => [m.qty_change, m.unit_cost, m.balance_after]), [[-20, 100, 50], [-10, 120, 40]]);

  // 3. Stock from before batches is the first (oldest) batch, at its cost price
  out = await moveStock(chicken, -4, { type: 'sale' });
  assert.deepStrictEqual(out, { qty: 4, cost: 360 });
  b = (await db.stock_batches.toArray()).filter(x => x.product_id === chicken);
  assert.deepStrictEqual(b.map(x => [x.reference, x.qty_remaining, x.unit_cost]), [['Opening stock', 6, 90]]);

  // 4. A dish moves its recipe; the line's FIFO cost is written to the bill line
  await db.sale_items.add({ sale_id: 7, product_id: dish, quantity: 2, cost_price: 0 });
  const lines = [{ product_id: dish, qty: -2, recipe: [{ product_id: rice, qty: 0.5 }, { product_id: chicken, qty: 0.2 }] }];
  const used = await returnStock(lines, 'Bill #7');
  assert.deepStrictEqual(used.get(rice), { qty: 1, cost: 120 });
  assert.deepStrictEqual(used.get(chicken), { qty: 0.4, cost: 36 });
  await recordLineCosts(7, lines, used);
  assert.strictEqual((await db.sale_items.toArray())[0].cost_price, 0.5 * 120 + 0.2 * 90, 'unit cost per plate');

  // 5. The recipe saved on the line wins over today's recipe
  await db.products.update(dish, { recipe: [{ product_id: rice, qty: 5 }] });
  const back = await returnStock([{ product_id: dish, qty: 2, recipe: lines[0].recipe }], 'Bill #7 deleted', { unitCosts: new Map([[rice, 120]]) });
  assert.strictEqual((await db.products.get(rice)).stock_qty, 40, 'returned 1 kg, not 10 kg');
  assert.strictEqual(back.size, 0, 'nothing went out on a return');

  // 6. Selling below zero: the shortfall is costed at the last price, and the next delivery covers it
  const oil = await db.products.add({ name: 'Oil', item_type: 'ingredient', stock_qty: 0, cost_price: 0 });
  await moveStock(oil, 2, { type: 'receive', unitCost: 500 });
  out = await moveStock(oil, -5, { type: 'sale' });
  assert.deepStrictEqual(out, { qty: 5, cost: 2 * 500 + 3 * 500 });
  await moveStock(oil, 10, { type: 'receive', unitCost: 600 });
  b = (await db.stock_batches.toArray()).filter(x => x.product_id === oil);
  assert.deepStrictEqual(b.map(x => x.qty_remaining), [0, 7], '3 of the 10 were already sold');
  assert.strictEqual((await db.products.get(oil)).stock_qty, 7);

  // 7. Value at FIFO = the newest batches; daily sheet works back from today
  const riceP = await db.products.get(rice);
  const riceBatches = (await db.stock_batches.toArray()).filter(x => x.product_id === rice);
  assert.strictEqual(fifoValue(riceP, 41, riceBatches), 41 * 120 + 0, 'newest batch first');
  // newest: the 1 kg returned @120, then 50 @120, then 9 of the 20 @100
  assert.strictEqual(fifoValue(riceP, 60, riceBatches), 1 * 120 + 50 * 120 + 9 * 100);
  const [row] = await dailyStock(new Date('2026-10-10T00:00:00Z'), new Date('2026-10-11T00:00:00Z'), [riceP]);
  assert.deepStrictEqual([row.opening, row.received, row.used, row.closing], [0, 70, 30, 40],
    'opening + received − used = closing');
  console.log('FIFO checks passed');
})().catch(e => { console.error(e); process.exit(1); });
`);
