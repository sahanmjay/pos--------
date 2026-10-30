// Runs the PickMe / Uber Eats price and commission maths from app.js.
// node tests/platform-price-check.js   (reads ../app.js; no database, no network)
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

const { platformPrice, platformCommission } = new Function(
  [extract(/^function platformPrice\(/m), extract(/^function platformCommission\(/m)].join('\n') +
  '\nreturn { platformPrice, platformCommission };'
)();

assert.strictEqual(platformPrice(1250, 25), 1570, '1250 + 25% = 1562.5, rounded up to the next Rs. 10');
assert.strictEqual(platformPrice(1000, 20), 1200, 'already on Rs. 10 stays put');
assert.strictEqual(platformPrice(999, 0), 999, 'no markup means the menu price, unrounded');
assert.strictEqual(platformPrice(850, '15'), 980, 'markup typed in settings arrives as text');
assert.strictEqual(platformCommission(1570, 20), 314);
assert.strictEqual(platformCommission(1000, 0), 0);
assert.strictEqual(platformCommission(333, 10), 33.3, 'kept to the cent');

console.log('platform-price-check: all passed');
