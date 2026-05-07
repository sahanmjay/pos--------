let currentUser = null;
let cart = [];
let cartCustomerId = 1;
let currentSettings = {};
let posCategory = '';

// --- INIT & UTILS ---
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setInterval(updateClock, 1000);
  updateClock();
});

function updateClock() {
  const d = new Date();
  const el = document.getElementById('topbar-clock');
  if(el) el.textContent = d.toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

async function loadSettings() {
  const sets = await db.settings.toArray();
  sets.forEach(s => { currentSettings[s.key] = s.value; });
  
  const bName = document.getElementById('topbar-biz-name');
  const bType = document.getElementById('topbar-biz-type');
  if(bName) bName.textContent = currentSettings.biz_name || 'NexPOS';
  if(bType) bType.textContent = currentSettings.biz_type || 'Point of Sale';
}

function formatMoney(num) {
  return (currentSettings.currency || 'Rs.') + ' ' + Number(num).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function showToast(type, msg) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  const icons = {success:'✓', error:'✕', info:'ℹ'};
  t.className = 'toast toast-'+type;
  t.innerHTML = `<span style="font-size:16px">${icons[type]}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transform='translateX(20px)'; t.style.transition='all 300ms'; setTimeout(()=>t.remove(),300); }, 3000);
}

// --- NAVIGATION & AUTH ---
async function doLogin() {
  const u = document.getElementById('login-user').value;
  const p = document.getElementById('login-pass').value;
  const err = document.getElementById('login-error');
  
  const user = await db.users.where('username').equals(u).first();
  if(!user || user.password !== p || !user.is_active) {
    err.textContent = "Invalid username or password";
    err.style.display = 'block';
    return;
  }
  
  currentUser = user;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  
  document.getElementById('user-avatar').textContent = user.display_name.charAt(0).toUpperCase();
  document.getElementById('user-name').textContent = user.display_name;
  document.getElementById('role-badge').textContent = user.role;
  
  // Apply role restrictions
  document.getElementById('nav-pos').style.display = 'none';
  document.getElementById('nav-inventory').style.display = 'none';
  document.getElementById('nav-sales').style.display = 'none';
  document.getElementById('nav-hr').style.display = 'none';
  document.getElementById('nav-system').style.display = 'none';

  if(user.role === 'Admin') {
    document.getElementById('nav-pos').style.display = 'block';
    document.getElementById('nav-inventory').style.display = 'block';
    document.getElementById('nav-sales').style.display = 'block';
    document.getElementById('nav-hr').style.display = 'block';
    document.getElementById('nav-system').style.display = 'block';
  } else if (user.role === 'Counter') {
    document.getElementById('nav-pos').style.display = 'block';
    document.getElementById('nav-sales').style.display = 'block';
  } else if (user.role === 'HR') {
    document.getElementById('nav-hr').style.display = 'block';
  } else if (user.role === 'Inventory') {
    document.getElementById('nav-inventory').style.display = 'block';
  }
  
  nav('pos');
  renderPosCategories();
  renderPosGrid();
  renderCart();
  await updateCartCustomer();
}

function signOut() {
  currentUser = null;
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
}

const SCREENS = {
  'pos': 'Point of Sale',
  'dashboard': 'Dashboard',
  'products': 'Inventory / Products',
  'categories': 'Inventory / Categories',
  'sales-history': 'Sales / History',
  'customers': 'Sales / Customers',
  'user-mgmt': 'System / Users',
  'settings': 'System / Settings'
};

function nav(screenId) {
  if(!currentUser) return;
  
  // Access control
  const role = currentUser.role;
  if (role !== 'Admin') {
    if (role === 'Counter' && !['pos', 'dashboard', 'sales-history', 'customers'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
    if (role === 'HR' && !['user-mgmt'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
    if (role === 'Inventory' && !['products', 'categories'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
  }
  
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const activeNav = document.querySelector(`.nav-item[onclick="nav('${screenId}')"]`);
  if(activeNav) activeNav.classList.add('active');
  
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById('screen-' + screenId).classList.add('active');
  
  const parts = SCREENS[screenId].split(' / ');
  let bc = `<span>NexPOS</span>`;
  parts.forEach((p, i) => {
    bc += `<span class="sep">/</span><span class="${i===parts.length-1?'current':''}">${p}</span>`;
  });
  document.getElementById('breadcrumb').innerHTML = bc;
  
  // Call init function for screen
  if(screenId === 'dashboard') initDashboard();
  if(screenId === 'products') renderProductsTable();
  if(screenId === 'categories') renderCategoriesTable();
  if(screenId === 'sales-history') renderSalesHistory();
  if(screenId === 'customers') renderCustomersTable();
  if(screenId === 'user-mgmt') renderUsersTable();
  if(screenId === 'settings') loadSettingsForm();
}

// --- MODALS ---
function openModal(title, bodyHtml, footerHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-footer').innerHTML = footerHtml;
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// --- POS SYSTEM ---
async function renderPosCategories() {
  const cats = await db.categories.toArray();
  let html = `<div class="cat-pill ${posCategory===''?'active':''}" onclick="setPosCategory('')">All</div>`;
  cats.forEach(c => {
    html += `<div class="cat-pill ${posCategory===c.name?'active':''}" onclick="setPosCategory('${c.name}')">${c.name}</div>`;
  });
  document.getElementById('pos-cat-filters').innerHTML = html;
}

window.setPosCategory = (cat) => { posCategory = cat; renderPosCategories(); renderPosGrid(); };

document.getElementById('pos-search').addEventListener('input', renderPosGrid);

function getIcon(cat) {
  return PRODUCT_ICONS[cat] || PRODUCT_ICONS['default'];
}

async function renderPosGrid() {
  const term = document.getElementById('pos-search').value.toLowerCase();
  let products = await db.products.where('is_active').equals(true).toArray();
  
  if(posCategory) products = products.filter(p => p.category === posCategory);
  if(term) products = products.filter(p => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term) || p.barcode.toLowerCase().includes(term));
  
  const grid = document.getElementById('pos-grid');
  grid.innerHTML = products.map(p => `
    <div class="pos-product-card ${p.stock_qty<=0?'out-of-stock':''}" onclick="addToCart(${p.id})">
      <div class="pos-prod-icon">${getIcon(p.category)}</div>
      <div class="pos-prod-name" title="${p.name}">${p.name}</div>
      <div class="pos-prod-price">${formatMoney(p.retail_price)}</div>
      <div class="pos-prod-stock">${p.stock_qty>0 ? p.stock_qty+' '+p.unit : 'Out of stock'}</div>
    </div>
  `).join('');
}

async function addToCart(id) {
  const p = await db.products.get(id);
  if(!p || p.stock_qty <= 0) return;
  
  const existing = cart.find(i => i.product_id === id);
  if(existing) {
    if(existing.quantity < p.stock_qty) existing.quantity++;
    else showToast('error', 'Not enough stock!');
  } else {
    cart.push({
      product_id: p.id,
      name: p.name,
      unit_price: p.retail_price,
      quantity: 1,
      stock: p.stock_qty
    });
  }
  renderCart();
}

window.updateCartQty = (idx, delta) => {
  const item = cart[idx];
  item.quantity += delta;
  if(item.quantity <= 0) cart.splice(idx, 1);
  else if(item.quantity > item.stock) {
    item.quantity = item.stock;
    showToast('error', 'Max stock reached');
  }
  renderCart();
};

window.removeCartItem = (idx) => { cart.splice(idx, 1); renderCart(); };

let manualDiscount = 0;

function renderCart() {
  const cEl = document.getElementById('cart-items');
  if(cart.length === 0) {
    cEl.innerHTML = `<div class="cart-empty"><div class="cart-empty-icon">🛒</div><div>Cart is empty</div></div>`;
    updateTotals();
    return;
  }
  
  cEl.innerHTML = cart.map((item, i) => `
    <div class="cart-item">
      <div class="cart-item-info">
        <div class="cart-item-name" title="${item.name}">${item.name}</div>
        <div class="cart-item-price">@ ${formatMoney(item.unit_price)}</div>
      </div>
      <div class="cart-item-qty">
        <button onclick="updateCartQty(${i}, -1)">-</button>
        <span>${item.quantity}</span>
        <button onclick="updateCartQty(${i}, 1)">+</button>
      </div>
      <div class="cart-item-total">${formatMoney(item.quantity * item.unit_price)}</div>
      <button class="cart-item-del" onclick="removeCartItem(${i})">✕</button>
    </div>
  `).join('');
  updateTotals();
}

function updateTotals() {
  const subtotal = cart.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
  const taxRate = parseFloat(currentSettings.tax_rate || 0) / 100;
  
  let discount = manualDiscount;
  if(discount > subtotal) discount = subtotal; // cap discount
  
  const taxable = Math.max(0, subtotal - discount);
  const tax = taxable * taxRate;
  const total = taxable + tax;
  
  document.getElementById('cart-subtotal').textContent = formatMoney(subtotal);
  document.getElementById('cart-discount').textContent = '- ' + formatMoney(discount);
  document.getElementById('tax-rate-display').textContent = currentSettings.tax_rate || '0';
  document.getElementById('cart-tax').textContent = formatMoney(tax);
  document.getElementById('cart-total').textContent = formatMoney(total);
  
  return { subtotal, discount, tax, total };
}

window.clearCart = () => { if(confirm('Clear current cart?')) { cart=[]; manualDiscount=0; renderCart(); } };

async function updateCartCustomer() {
  const cust = await db.customers.get(cartCustomerId);
  document.getElementById('cart-customer-name').textContent = cust ? cust.name : 'Walk-in Customer';
}

window.openCustomerSelect = async () => {
  const customers = await db.customers.toArray();
  const html = `
    <div class="form-group">
      <input class="form-input" id="cust-search-modal" placeholder="Search customer..." oninput="filterModalCustomers()">
    </div>
    <div style="max-height:300px;overflow-y:auto;margin-top:10px" id="cust-list-modal">
      ${customers.map(c => `
        <div style="padding:10px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;justify-content:space-between" onclick="selectCartCustomer(${c.id})">
          <div class="fw-600">${c.name}</div><div class="text-muted">${c.phone}</div>
        </div>
      `).join('')}
    </div>
  `;
  openModal('Select Customer', html, `<button class="btn btn-secondary" onclick="closeModal()">Close</button>`);
};

window.filterModalCustomers = () => {
  const term = document.getElementById('cust-search-modal').value.toLowerCase();
  const list = document.getElementById('cust-list-modal');
  Array.from(list.children).forEach(row => {
    if(row.textContent.toLowerCase().includes(term)) row.style.display='';
    else row.style.display='none';
  });
};

window.selectCartCustomer = (id) => { cartCustomerId = id; updateCartCustomer(); closeModal(); };

window.applyDiscount = () => {
  const d = prompt("Enter discount amount:", manualDiscount);
  if(d !== null && !isNaN(d)) { manualDiscount = parseFloat(d); renderCart(); }
};

window.holdCart = async () => {
  if(cart.length === 0) return showToast('error', 'Cart is empty');
  const name = prompt("Enter a name for this held cart:", "Cart " + new Date().toLocaleTimeString());
  if(!name) return;
  await db.held_carts.add({ name, items: cart, customer_id: cartCustomerId, date: new Date().toISOString() });
  cart = []; manualDiscount = 0; cartCustomerId = 1;
  renderCart(); updateCartCustomer(); showToast('success', 'Cart held');
};

window.payNow = async (paymentType) => {
  if(cart.length === 0) return showToast('error', 'Cart is empty');
  
  const { subtotal, discount, tax, total } = updateTotals();
  
  if(paymentType === 'credit') {
    if(cartCustomerId === 1) return showToast('error', 'Please select a specific customer for credit sales.');
    const c = await db.customers.get(cartCustomerId);
    if(!confirm(`Add ${formatMoney(total)} to ${c.name}'s credit balance?`)) return;
  }
  
  let change = 0;
  if(paymentType === 'cash') {
    const tendered = prompt(`Total: ${formatMoney(total)}\nEnter amount given by customer:`, total);
    if(tendered === null) return;
    const given = parseFloat(tendered);
    if(isNaN(given) || given < total) return showToast('error', 'Invalid amount tendered.');
    change = given - total;
  }
  
  const sale = {
    date: new Date().toISOString(),
    subtotal, discount, tax, total_amount: total,
    payment_type: paymentType, status: 'completed',
    customer_id: cartCustomerId,
    cashier: currentUser.display_name,
    items_count: cart.reduce((sum, item)=>sum+item.quantity, 0)
  };
  
  const saleId = await db.sales.add(sale);
  
  const saleItems = cart.map(i => ({
    sale_id: saleId, product_id: i.product_id, product_name: i.name,
    quantity: i.quantity, unit_price: i.unit_price, line_total: i.quantity * i.unit_price
  }));
  await db.sale_items.bulkAdd(saleItems);
  
  // Update stock
  for(let item of cart) {
    const p = await db.products.get(item.product_id);
    if(p) await db.products.update(p.id, { stock_qty: p.stock_qty - item.quantity });
  }
  
  // Update credit
  if(paymentType === 'credit') {
    const c = await db.customers.get(cartCustomerId);
    await db.customers.update(c.id, { outstanding_balance: c.outstanding_balance + total });
  }
  
  // Finalize
  cart = []; manualDiscount = 0; cartCustomerId = 1;
  renderCart(); updateCartCustomer(); renderPosGrid();
  
  showReceipt(Object.assign({id:saleId}, sale), saleItems, change, paymentType==='cash'?parseFloat(total+change):total);
};

function showReceipt(sale, items, change, tendered) {
  const shopName = currentSettings.biz_name || 'NexPOS';
  const address = currentSettings.address || '';
  const phone = currentSettings.phone || '';
  
  let html = `
    <div style="text-align:center;margin-bottom:15px;border-bottom:1px dashed #ccc;padding-bottom:10px">
      <h2 style="margin:0;font-size:18px">${shopName}</h2>
      <div>${address}</div>
      <div>${phone}</div>
    </div>
    <div style="margin-bottom:10px">
      <div>Receipt: #${sale.id}</div>
      <div>Date: ${new Date(sale.date).toLocaleString()}</div>
      <div>Cashier: ${sale.cashier}</div>
      <div>Pay Method: ${sale.payment_type.toUpperCase()}</div>
    </div>
    <table style="width:100%;text-align:left;border-bottom:1px dashed #ccc;margin-bottom:10px">
      <tr><th>Item</th><th>Qty</th><th style="text-align:right">Total</th></tr>
  `;
  
  items.forEach(i => {
    html += `<tr><td>${i.product_name}</td><td>${i.quantity}</td><td style="text-align:right">${formatMoney(i.line_total)}</td></tr>`;
  });
  
  html += `</table>
    <div style="text-align:right">
      <div>Subtotal: ${formatMoney(sale.subtotal)}</div>
      ${sale.discount>0 ? `<div>Discount: -${formatMoney(sale.discount)}</div>` : ''}
      ${sale.tax>0 ? `<div>Tax: ${formatMoney(sale.tax)}</div>` : ''}
      <h3 style="margin:5px 0">Total: ${formatMoney(sale.total_amount)}</h3>
      ${sale.payment_type==='cash' ? `<div>Tendered: ${formatMoney(tendered)}</div><div>Change: ${formatMoney(change)}</div>` : ''}
    </div>
    <div style="text-align:center;margin-top:15px;border-top:1px dashed #ccc;padding-top:10px">Thank you for your business!</div>
  `;
  
  document.getElementById('receipt-body').innerHTML = html;
  document.getElementById('receipt-overlay').classList.add('open');
}

window.closeReceipt = () => document.getElementById('receipt-overlay').classList.remove('open');

window.printReceipt = () => {
  const content = document.getElementById('receipt-body').innerHTML;
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Receipt</title><style>body{font-family:monospace;font-size:12px;width:300px;margin:0 auto;}</style></head><body>${content}</body></html>`);
  w.document.close();
  w.print();
  setTimeout(()=>w.close(), 500);
};

// --- DASHBOARD ---
async function initDashboard() {
  document.getElementById('dash-date').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  
  const today = new Date(); today.setHours(0,0,0,0);
  const sales = await db.sales.toArray();
  const todaySales = sales.filter(s => new Date(s.date) >= today);
  
  const revenue = todaySales.reduce((s, x)=>s+x.total_amount, 0);
  const transCount = todaySales.length;
  
  const products = await db.products.where('is_active').equals(true).toArray();
  const lowStock = products.filter(p => p.stock_qty <= p.low_stock_threshold);
  
  const customers = await db.customers.toArray();
  const outCredit = customers.reduce((s, c)=>s+(c.outstanding_balance||0), 0);
  
  document.getElementById('dash-summary').innerHTML = `
    <div class="summary-card"><div class="summary-card-top"><div class="summary-icon green">💰</div></div><div class="summary-value">${formatMoney(revenue)}</div><div class="summary-label">Today's Revenue</div></div>
    <div class="summary-card"><div class="summary-card-top"><div class="summary-icon blue">🛒</div></div><div class="summary-value">${transCount}</div><div class="summary-label">Today's Transactions</div></div>
    <div class="summary-card" onclick="nav('products')"><div class="summary-card-top"><div class="summary-icon amber">⚠️</div></div><div class="summary-value">${lowStock.length}</div><div class="summary-label">Low Stock Items</div></div>
    <div class="summary-card" onclick="nav('customers')"><div class="summary-card-top"><div class="summary-icon purple">📝</div></div><div class="summary-value">${formatMoney(outCredit)}</div><div class="summary-label">Outstanding Credit</div></div>
  `;
  
  document.getElementById('dash-recent-sales').innerHTML = sales.sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5).map(s => `
    <div class="activity-item"><div class="activity-dot"></div><div style="flex:1"><div class="activity-text fw-600">Sale #${s.id} — ${formatMoney(s.total_amount)}</div><div class="activity-time">${new Date(s.date).toLocaleString()} · ${s.payment_type.toUpperCase()}</div></div></div>
  `).join('') || '<div class="text-muted">No sales yet</div>';
  
  document.getElementById('dash-low-stock').innerHTML = lowStock.slice(0,5).map(p => `
    <div class="activity-item"><div class="activity-dot" style="background:var(--danger)"></div><div style="flex:1"><div class="activity-text fw-600">${p.name}</div><div class="activity-time" style="color:var(--danger)">Stock: ${p.stock_qty} ${p.unit} (Alert: ${p.low_stock_threshold})</div></div></div>
  `).join('') || '<div class="text-muted">No low stock alerts</div>';
}

// --- PRODUCTS ---
window.renderProductsTable = async () => {
  const cats = await db.categories.toArray();
  const catSel = document.getElementById('product-cat-filter');
  const currVal = catSel.value;
  catSel.innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  catSel.value = currVal;
  
  let products = await db.products.toArray();
  const term = document.getElementById('product-search').value.toLowerCase();
  
  if(currVal) products = products.filter(p => p.category === currVal);
  if(term) products = products.filter(p => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term));
  
  document.getElementById('products-tbody').innerHTML = products.map(p => `
    <tr>
      <td class="fw-600">${p.name}</td>
      <td class="td-mono">${p.sku}</td>
      <td>${p.category}</td>
      <td class="td-mono">${formatMoney(p.retail_price)}</td>
      <td class="td-mono" style="${p.stock_qty<=p.low_stock_threshold?'color:var(--danger);font-weight:bold':''}">${p.stock_qty} ${p.unit}</td>
      <td><span class="badge ${p.is_active?'badge-active':'badge-inactive'}">${p.is_active?'Active':'Inactive'}</span></td>
      <td><button class="btn btn-ghost btn-sm btn-icon" onclick="openProductForm(${p.id})">✏️</button></td>
    </tr>
  `).join('') || '<tr><td colspan="7" style="text-align:center">No products found</td></tr>';
};

window.openProductForm = async (id = null) => {
  let p = { name:'', sku:'', barcode:'', category:'', retail_price:0, wholesale_price:0, cost_price:0, stock_qty:0, low_stock_threshold:5, unit:'pcs', is_active:true };
  if(id) { p = await db.products.get(id); }
  
  const cats = await db.categories.toArray();
  
  const html = `
    <input type="hidden" id="f-prod-id" value="${id||''}">
    <div class="form-grid">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="f-prod-name" value="${p.name}"></div>
      <div class="form-group"><label class="form-label">Category</label>
        <select class="form-input" id="f-prod-cat">${cats.map(c=>`<option value="${c.name}" ${p.category===c.name?'selected':''}>${c.name}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label class="form-label">SKU</label><input class="form-input" id="f-prod-sku" value="${p.sku}"></div>
      <div class="form-group"><label class="form-label">Barcode</label><input class="form-input" id="f-prod-barcode" value="${p.barcode}"></div>
      <div class="form-group"><label class="form-label">Retail Price</label><input class="form-input" type="number" step="0.01" id="f-prod-retail" value="${p.retail_price}"></div>
      <div class="form-group"><label class="form-label">Cost Price</label><input class="form-input" type="number" step="0.01" id="f-prod-cost" value="${p.cost_price}"></div>
      <div class="form-group"><label class="form-label">Stock Qty</label><input class="form-input" type="number" step="0.01" id="f-prod-stock" value="${p.stock_qty}"></div>
      <div class="form-group"><label class="form-label">Unit</label><input class="form-input" id="f-prod-unit" value="${p.unit}"></div>
      <div class="form-group"><label class="form-label">Low Stock Alert</label><input class="form-input" type="number" id="f-prod-low" value="${p.low_stock_threshold}"></div>
      <div class="form-group"><label class="form-label">Status</label>
        <select class="form-input" id="f-prod-active"><option value="true" ${p.is_active?'selected':''}>Active</option><option value="false" ${!p.is_active?'selected':''}>Inactive</option></select>
      </div>
    </div>
  `;
  openModal(id?'Edit Product':'New Product', html, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveProduct()">Save</button>
  `);
};

window.saveProduct = async () => {
  const id = document.getElementById('f-prod-id').value;
  const p = {
    name: document.getElementById('f-prod-name').value,
    category: document.getElementById('f-prod-cat').value,
    sku: document.getElementById('f-prod-sku').value,
    barcode: document.getElementById('f-prod-barcode').value,
    retail_price: parseFloat(document.getElementById('f-prod-retail').value)||0,
    cost_price: parseFloat(document.getElementById('f-prod-cost').value)||0,
    wholesale_price: parseFloat(document.getElementById('f-prod-retail').value)||0, // auto fallback
    stock_qty: parseFloat(document.getElementById('f-prod-stock').value)||0,
    unit: document.getElementById('f-prod-unit').value || 'pcs',
    low_stock_threshold: parseFloat(document.getElementById('f-prod-low').value)||5,
    is_active: document.getElementById('f-prod-active').value === 'true'
  };
  
  if(!p.name) return showToast('error', 'Name is required');
  
  if(id) await db.products.update(parseInt(id), p);
  else await db.products.add(p);
  
  closeModal(); showToast('success', 'Product saved'); renderProductsTable();
};

// --- SETTINGS ---
window.loadSettingsForm = async () => {
  const s = currentSettings;
  document.getElementById('set-biz-name').value = s.biz_name || '';
  document.getElementById('set-biz-type').value = s.biz_type || 'Retail Shop';
  document.getElementById('set-currency').value = s.currency || 'Rs.';
  document.getElementById('set-tax').value = s.tax_rate || '0';
  document.getElementById('set-phone').value = s.phone || '';
  document.getElementById('set-address').value = s.address || '';
  
  document.getElementById('biz-templates').innerHTML = Object.keys(BUSINESS_TEMPLATES).map(k => `
    <div class="quick-action" onclick="applyTemplate('${k}')"><div class="qa-icon">${BUSINESS_TEMPLATES[k].icon}</div><div><div class="qa-text">${k}</div><div class="qa-sub">${BUSINESS_TEMPLATES[k].products.length} items</div></div></div>
  `).join('');
};

window.saveSettings = async () => {
  const keys = ['biz_name','biz_type','currency','tax_rate','phone','address'];
  for(let k of keys) {
    const val = document.getElementById('set-'+k).value;
    const existing = await db.settings.where('key').equals(k).first();
    if(existing) await db.settings.update(existing.id, {value: val});
    else await db.settings.add({key: k, value: val});
  }
  await loadSettings();
  showToast('success', 'Settings saved');
};

window.applyTemplate = async (type) => {
  if(!confirm(`Warning: This will DELETE all existing products and categories, and load the ${type} template. Continue?`)) return;
  await loadBusinessTemplate(type);
  showToast('success', `${type} template applied`);
  nav('products');
};

// --- SALES HISTORY ---
window.renderSalesHistory = async () => {
  let sales = await db.sales.toArray();
  sales.sort((a,b)=>new Date(b.date)-new Date(a.date));
  
  const from = document.getElementById('sale-date-from').value;
  const to = document.getElementById('sale-date-to').value;
  
  if(from) { const fd = new Date(from); fd.setHours(0,0,0,0); sales = sales.filter(s => new Date(s.date) >= fd); }
  if(to) { const td = new Date(to); td.setHours(23,59,59,999); sales = sales.filter(s => new Date(s.date) <= td); }
  
  const custs = await db.customers.toArray();
  const cMap = {}; custs.forEach(c => cMap[c.id]=c.name);
  
  document.getElementById('sales-tbody').innerHTML = sales.map(s => `
    <tr>
      <td class="td-mono fw-600">#${s.id}</td>
      <td class="text-muted">${new Date(s.date).toLocaleString()}</td>
      <td>${cMap[s.customer_id]||'Walk-in'}</td>
      <td>${s.items_count}</td>
      <td class="td-mono fw-600">${formatMoney(s.total_amount)}</td>
      <td>${s.payment_type.toUpperCase()}</td>
      <td><span class="badge ${s.status==='completed'?'badge-completed':'badge-voided'}">${s.status}</span></td>
      <td><button class="btn btn-ghost btn-sm btn-icon" onclick="viewSaleDetails(${s.id})">👁️</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8" style="text-align:center">No sales found</td></tr>';
};

window.viewSaleDetails = async (id) => {
  const sale = await db.sales.get(id);
  const items = await db.sale_items.where('sale_id').equals(id).toArray();
  showReceipt(sale, items, 0, sale.total_amount);
};

// --- CUSTOMERS ---
window.renderCustomersTable = async () => {
  let custs = await db.customers.toArray();
  const term = document.getElementById('customer-search').value.toLowerCase();
  if(term) custs = custs.filter(c => c.name.toLowerCase().includes(term) || c.phone.includes(term));
  
  // Calculate total purchases per customer (lazy load for MVP)
  for(let c of custs) {
    const s = await db.sales.where('customer_id').equals(c.id).toArray();
    c.total_purchases = s.reduce((sum, x)=>sum+x.total_amount, 0);
  }
  
  document.getElementById('customers-tbody').innerHTML = custs.map(c => `
    <tr>
      <td class="fw-600">${c.name}</td>
      <td>${c.phone||'-'}</td>
      <td>${c.email||'-'}</td>
      <td class="td-mono">${formatMoney(c.total_purchases)}</td>
      <td class="td-mono" style="${c.outstanding_balance>0?'color:var(--danger);font-weight:bold':''}">${formatMoney(c.outstanding_balance)}</td>
      <td><button class="btn btn-ghost btn-sm btn-icon" onclick="openCustomerForm(${c.id})">✏️</button></td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="text-align:center">No customers found</td></tr>';
};

window.openCustomerForm = async (id = null) => {
  let c = { name:'', phone:'', email:'', outstanding_balance:0 };
  if(id) c = await db.customers.get(id);
  
  const html = `
    <input type="hidden" id="f-cust-id" value="${id||''}">
    <div class="form-grid">
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="f-cust-name" value="${c.name}"></div>
      <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="f-cust-phone" value="${c.phone}"></div>
      <div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="f-cust-email" value="${c.email}"></div>
      <div class="form-group"><label class="form-label">Outstanding Balance</label><input class="form-input" type="number" step="0.01" id="f-cust-bal" value="${c.outstanding_balance}" ${id===1?'disabled':''}></div>
    </div>
  `;
  openModal(id?'Edit Customer':'New Customer', html, `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveCustomer()">Save</button>`);
};

window.saveCustomer = async () => {
  const id = document.getElementById('f-cust-id').value;
  const c = {
    name: document.getElementById('f-cust-name').value,
    phone: document.getElementById('f-cust-phone').value,
    email: document.getElementById('f-cust-email').value,
    outstanding_balance: parseFloat(document.getElementById('f-cust-bal').value)||0
  };
  if(!c.name) return showToast('error', 'Name is required');
  if(id) await db.customers.update(parseInt(id), c); else await db.customers.add(c);
  closeModal(); showToast('success', 'Customer saved'); renderCustomersTable();
};

// --- EXPORT ---
window.exportSalesCSV = async () => {
  const sales = await db.sales.toArray();
  const csv = "Sale ID,Date,Amount,Payment Type,Status\n" + sales.map(s => `${s.id},${s.date},${s.total_amount},${s.payment_type},${s.status}`).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `sales_export_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); window.URL.revokeObjectURL(url);
};

// Categories & Users management (simplified for completion)
window.renderCategoriesTable = async () => {
  const cats = await db.categories.toArray();
  document.getElementById('categories-tbody').innerHTML = cats.map(c => `<tr><td class="fw-600">${c.name}</td><td>-</td><td><button class="btn btn-ghost btn-sm btn-icon" onclick="db.categories.delete(${c.id});renderCategoriesTable()">🗑️</button></td></tr>`).join('');
};
window.openCategoryForm = () => {
  openModal('New Category', '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="f-cat-name"></div>', `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="db.categories.add({name:document.getElementById('f-cat-name').value});closeModal();renderCategoriesTable()">Save</button>`);
};
window.renderUsersTable = async () => {
  const users = await db.users.toArray();
  document.getElementById('users-tbody').innerHTML = users.map(u => `<tr><td class="fw-600">${u.username}</td><td>${u.display_name}</td><td>${u.role}</td><td><span class="badge ${u.is_active?'badge-active':'badge-inactive'}">${u.is_active?'Active':'Inactive'}</span></td><td><button class="btn btn-ghost btn-sm btn-icon" onclick="openUserForm(${u.id})">✏️</button></td></tr>`).join('');
};
window.openUserForm = async (id = null) => {
  let u = { username:'', password:'', display_name:'', role:'Counter', is_active:true };
  if(id) u = await db.users.get(id);
  const html = `<input type="hidden" id="f-usr-id" value="${id||''}"><div class="form-grid"><div class="form-group"><label class="form-label">Username</label><input class="form-input" id="f-usr-name" value="${u.username}"></div><div class="form-group"><label class="form-label">Password</label><input class="form-input" type="password" id="f-usr-pass" value="${u.password}"></div><div class="form-group"><label class="form-label">Display Name</label><input class="form-input" id="f-usr-disp" value="${u.display_name}"></div><div class="form-group"><label class="form-label">Role</label><select class="form-input" id="f-usr-role"><option ${u.role==='Admin'?'selected':''}>Admin</option><option ${u.role==='Counter'?'selected':''}>Counter</option><option ${u.role==='HR'?'selected':''}>HR</option><option ${u.role==='Inventory'?'selected':''}>Inventory</option></select></div><div class="form-group"><label class="form-label">Status</label><select class="form-input" id="f-usr-active"><option value="true" ${u.is_active?'selected':''}>Active</option><option value="false" ${!u.is_active?'selected':''}>Inactive</option></select></div></div>`;
  openModal(id?'Edit User':'New User', html, `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveUser()">Save</button>`);
};
window.saveUser = async () => {
  const id = document.getElementById('f-usr-id').value;
  const u = { username:document.getElementById('f-usr-name').value, password:document.getElementById('f-usr-pass').value, display_name:document.getElementById('f-usr-disp').value, role:document.getElementById('f-usr-role').value, is_active:document.getElementById('f-usr-active').value==='true' };
  if(id) await db.users.update(parseInt(id), u); else await db.users.add(u);
  closeModal(); renderUsersTable(); showToast('success', 'User saved');
};
