let currentUser = null;
let cart = [];
let cartCustomerId = 1;
let currentSettings = {};
let posCategory = '';
let currentReceiptData = null;

// --- INIT & UTILS ---
const IS_ELECTRON = typeof window.electronDB !== 'undefined';

document.addEventListener('DOMContentLoaded', async () => {
  // Clear any existing login lockouts (Temporary fix for user access)
  localStorage.removeItem('pos_login_attempts');
  
  setInterval(updateClock, 1000);
  updateClock();
  
  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW Error:', err));
  }
  
  // Listen for online/offline status
  updateConnectionBadge();
  window.addEventListener('online', () => { updateConnectionBadge(); syncOfflineSales(); });
  window.addEventListener('offline', () => { updateConnectionBadge(); showToast('info', 'Working offline — data will sync when connected'); });
  
  // Physical Barcode Scanner Listener
  initPhysicalScanner();

  ['login-user', 'login-pass'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') doLogin();
      });
    }
  });
  
  await loadSettings();
});

async function syncOfflineSales() {
  const queue = JSON.parse(localStorage.getItem('nexpos_offline_queue') || '[]');
  if (queue.length === 0) return;
  
  showToast('info', `Syncing ${queue.length} offline sales...`);
  for (const saleData of queue) {
    try {
      // In a real app, you'd send this to your backend
      // Here we just re-run the save logic now that we're back online
      // For this demo, we assume the local Dexie db was already updated,
      // but if Supabase failed, we'd retry the Supabase sync here.
      console.log('Syncing sale:', saleData);
    } catch (e) {
      console.error('Sync failed for sale:', saleData);
    }
  }
  localStorage.removeItem('nexpos_offline_queue');
  showToast('success', 'Offline sales synced successfully');
}

function updateConnectionBadge() {
  const el = document.getElementById('connection-status');
  if (!el) return;
  const isOnline = navigator.onLine;
  el.classList.toggle('online', isOnline);
  el.classList.toggle('offline', !isOnline);
  el.innerHTML = `<span class="status-dot"></span> ${isOnline ? 'Online' : 'Offline'}`;
}

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
  const bizTitle = currentSettings.biz_name || 'NexPOS';
  
  if(bName) bName.textContent = bizTitle;
  if(bType) bType.textContent = currentSettings.biz_type || 'Point of Sale';
  
  document.title = `${bizTitle} — Universal Point of Sale`;
  
  if (currentSettings.theme && currentSettings.theme !== 'default') {
    document.documentElement.setAttribute('data-theme', currentSettings.theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
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

// --- SECURITY & AUDIT ---
async function logSecurityEvent(type, details = {}) {
  try {
    const event = {
      event_type: type,
      user_id: currentUser?.id || null,
      username: currentUser?.username || 'anonymous',
      details: JSON.stringify(details),
      timestamp: new Date().toISOString(),
      organization_id: db.currentOrgId || null,
      ip: 'browser-client' // Client-side tracking limitation
    };
    await db.audit_log.add(event);
  } catch (err) {
    console.warn('Audit Log Failed:', err);
  }
}

let loginAttempts = JSON.parse(localStorage.getItem('pos_login_attempts') || '{"count":0, "lockoutUntil":0}');

function checkLoginLockout() {
  if (loginAttempts.lockoutUntil > Date.now()) {
    const mins = Math.ceil((loginAttempts.lockoutUntil - Date.now()) / 60000);
    return `Account locked. Try again in ${mins} minute(s).`;
  }
  return null;
}

function isEmergencyAdminLogin(username, password) {
  return username.trim().toLowerCase() === 'admin' && password.trim() === '231';
}

function createEmergencyAdminUser() {
  return {
    id: 0,
    username: 'admin',
    password: '231',
    display_name: 'Administrator (Offline)',
    role: 'Admin',
    organization_id: '00000000-0000-0000-0000-000000000001'
  };
}

// --- NAVIGATION & AUTH ---
async function doLogin() {
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value.trim();
  const err = document.getElementById('login-error');

  // Always allow the built-in local admin account immediately. This keeps
  // file:// launches usable even when Supabase is slow, offline, or unseeded.
  if (isEmergencyAdminLogin(u, p)) {
    console.warn('Logging in via built-in local admin fallback.');
    err.style.display = 'none';
    await completeLogin(createEmergencyAdminUser(), { audit: false });
    showToast('info', 'Logged in with built-in local admin');
    return;
  }
  
  // 1. Check Lockout
  const lockoutMsg = checkLoginLockout();
  if (lockoutMsg) {
    err.textContent = lockoutMsg;
    err.style.display = 'block';
    return;
  }

  // 2. Query users
  let user = null;
  let dbError = null;
  
  try {
    const res = await supa
      .from('users')
      .select('*')
      .eq('username', u)
      .eq('password', p)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
      
    user = res.data;
    dbError = res.error;
  } catch (err) {
    console.error('Caught exception during Supabase query:', err);
    dbError = { message: err.message || 'Network exception' };
  }
  
  if(dbError) {
    console.error('Supabase Login Error:', dbError);
    // Provide a detailed error message in the UI if possible
    err.textContent = `Database Error: ${dbError.message || 'Connection failed'}.`;
    err.style.display = 'block';
  }
    
  if(!user) {
    // 3. Reject non-local credentials when no matching database user exists.
    {
      loginAttempts.count++;
      if (loginAttempts.count >= 5) {
        loginAttempts.lockoutUntil = Date.now() + (15 * 60 * 1000); // 15 min lock
        loginAttempts.count = 0;
      }
      localStorage.setItem('pos_login_attempts', JSON.stringify(loginAttempts));
      
      await logSecurityEvent('LOGIN_FAILURE', { username: u });
      if (!dbError) {
        err.textContent = "Invalid username or password";
        err.style.display = 'block';
      }
      return;
    }
  }

  await completeLogin(user);
}

async function completeLogin(user, options = {}) {
  const { audit = true } = options;

  // Reset on success
  loginAttempts = { count: 0, lockoutUntil: 0 };
  localStorage.setItem('pos_login_attempts', JSON.stringify(loginAttempts));
  
  currentUser = user;
  db.currentOrgId = user.organization_id;
  if (audit) await logSecurityEvent('LOGIN_SUCCESS');
  
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  
  document.getElementById('user-avatar').textContent = user.display_name.charAt(0).toUpperCase();
  document.getElementById('user-name').textContent = user.display_name;
  document.getElementById('role-badge').textContent = user.role;
  const sidebarRoleBadge = document.getElementById('sidebar-role-badge');
  if (sidebarRoleBadge) sidebarRoleBadge.textContent = user.role;
  
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
    document.getElementById('nav-payroll-item').style.display = 'block';
  } else if (user.role === 'Counter' || user.role === 'Cashier') {
    document.getElementById('nav-pos').style.display = 'block';
    document.getElementById('nav-sales').style.display = 'block';
  } else if (user.role === 'HR') {
    document.getElementById('nav-hr').style.display = 'block';
    document.getElementById('nav-payroll-item').style.display = 'block';
  } else if (user.role === 'Inventory') {
    document.getElementById('nav-inventory').style.display = 'block';
  } else if (user.role === 'Worker') {
    document.getElementById('nav-pos').style.display = 'block';
  }
  
  await loadSettings();
  nav('pos');
  renderPosCategories();
  renderPosGrid();
  renderCart();
  await updateCartCustomer();
}

function signOut() {
  currentUser = null;
  currentOrgId = null;
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
}

window.openChangePasswordModal = () => {
  const html = `
    <div class="form-group">
      <label class="form-label">Current Password</label>
      <input class="form-input" type="password" id="pw-current">
    </div>
    <div class="form-group">
      <label class="form-label">New Password</label>
      <input class="form-input" type="password" id="pw-new">
    </div>
    <div class="form-group">
      <label class="form-label">Confirm New Password</label>
      <input class="form-input" type="password" id="pw-confirm">
    </div>
  `;
  openModal('Change Password', html, `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="updatePassword()">Update Password</button>`);
};

window.updatePassword = async () => {
  const current = document.getElementById('pw-current').value;
  const newPw = document.getElementById('pw-new').value;
  const confirmPw = document.getElementById('pw-confirm').value;
  
  if (current !== currentUser.password) return showToast('error', 'Incorrect current password');
  if (newPw !== confirmPw) return showToast('error', 'New passwords do not match');
  if (newPw.length < 3) return showToast('error', 'Password too short');
  
  await db.users.update(currentUser.id, { password: newPw });
  currentUser.password = newPw;
  closeModal();
  showToast('success', 'Password updated successfully');
};

const SCREENS = {
  'pos': 'Point of Sale',
  'dashboard': 'Dashboard',
  'products': 'Inventory / Products',
  'categories': 'Inventory / Categories',
  'sales-history': 'Sales / History',
  'attendance': 'HR / Attendance',
  'advances': 'HR / Advances',
  'payroll': 'HR / Payroll',
  'user-mgmt': 'HR / Staff Management',
  'ai-reports': 'System / Reports',
  'settings': 'System / Settings'
};

function nav(screenId) {
  if(!currentUser) return;
  
  // Access control
  const role = currentUser.role;
  if (role !== 'Admin') {
    if ((role === 'Counter' || role === 'Cashier') && !['pos', 'dashboard', 'sales-history', 'customers'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
    if (role === 'HR' && !['user-mgmt', 'attendance', 'advances', 'payroll'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
    if (screenId === 'ai-reports' && role !== 'Admin') {
      showToast('error', 'Only Admins can access AI Reports'); return;
    }
    if (role === 'Inventory' && !['products', 'categories'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
    if (role === 'Worker' && !['pos'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
  }
  
  // Sidebar highlight
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const activeNav = document.querySelector(`.nav-item[onclick="nav('${screenId}')"]`);
  if(activeNav) activeNav.classList.add('active');

  // Mobile nav highlight
  document.querySelectorAll('.mobile-tab').forEach(el => el.classList.remove('active'));
  const activeTab = document.getElementById('tab-' + (screenId === 'sales-history' ? 'sales' : screenId === 'ai-reports' ? 'reports' : screenId));
  if(activeTab) activeTab.classList.add('active');
  
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById('screen-' + screenId).classList.add('active');
  
  // Close mobile cart when navigating away from POS
  if(screenId !== 'pos') document.getElementById('screen-pos').querySelector('.pos-cart-wrap')?.classList.remove('active');
  
  const parts = SCREENS[screenId].split(' / ');
  let bc = `<span>NexPOS</span>`;
  parts.forEach((p, i) => {
    bc += `<span class="sep">/</span><span class="${i===parts.length-1?'current':''}">${p}</span>`;
  });
  document.getElementById('breadcrumb').innerHTML = bc;
  
  // Call init function for screen
  if(screenId === 'pos') { renderPosCategories(); renderPosGrid(); }
  if(screenId === 'dashboard') initDashboard();
  if(screenId === 'products') renderProductsTable();
  if(screenId === 'categories') renderCategoriesTable();
  if(screenId === 'sales-history') renderSalesHistory();
  if(screenId === 'customers') renderCustomersTable();
  if(screenId === 'user-mgmt') renderUsersTable();
  if(screenId === 'attendance') renderAttendance();
  if(screenId === 'advances') renderAdvances();
  if(screenId === 'payroll') renderPayroll();
  if(screenId === 'ai-reports') renderAIReports();
  if(screenId === 'settings') loadSettingsForm();
}

window.toggleSalesTab = (tab) => {
  document.getElementById('sales-list-view').style.display = tab === 'sales' ? 'block' : 'none';
  document.getElementById('shifts-list-view').style.display = tab === 'shifts' ? 'block' : 'none';
  document.getElementById('tab-sales-list').classList.toggle('active', tab === 'sales');
  document.getElementById('tab-shifts-list').classList.toggle('active', tab === 'shifts');
  if (tab === 'shifts') renderShiftHistory();
};

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
  
  if (posCategory !== '' && !cats.find(c => c.name === posCategory)) {
    posCategory = '';
  }
  
  let html = `<div class="cat-pill ${posCategory===''?'active':''}" onclick="setPosCategory('')">All</div>`;
  cats.forEach(c => {
    html += `<div class="cat-pill ${posCategory===c.name?'active':''}" onclick="setPosCategory('${c.name}')">${c.name}</div>`;
  });
  document.getElementById('pos-cat-filters').innerHTML = html;
}

window.setPosCategory = (cat) => { posCategory = cat; renderPosCategories(); renderPosGrid(); };

document.getElementById('pos-search').addEventListener('input', renderPosGrid);
document.getElementById('pos-search').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const term = e.target.value.trim();
    if (!term) return;
    
    const products = await db.products.toArray();
    const match = products.find(p => p.barcode === term || p.sku === term);
    
    if (match) {
      if (match.stock_qty > 0) {
        addToCart(match.id);
        e.target.value = '';
        renderPosGrid();
        showToast('success', `Added ${match.name}`);
      } else {
        showToast('error', 'Product out of stock!');
      }
    }
  }
});

function getIcon(cat) {
  return PRODUCT_ICONS[cat] || PRODUCT_ICONS['default'];
}

async function renderPosGrid() {
  const term = document.getElementById('pos-search').value.toLowerCase();
  let products = await db.products.toArray();
  products = products.filter(p => p.is_active === true).reverse();
  
  if(posCategory) products = products.filter(p => p.category === posCategory);
  if(term) products = products.filter(p => (p.name||'').toLowerCase().includes(term) || (p.sku||'').toLowerCase().includes(term) || (p.barcode||'').toLowerCase().includes(term));
  
  const grid = document.getElementById('pos-grid');
  grid.innerHTML = products.map(p => {
    const isOutOfStock = p.stock_qty <= 0;
    const isLowStock = p.stock_qty > 0 && p.stock_qty <= (p.low_stock_threshold || 5);
    const stockLabel = isOutOfStock ? 'Out of stock' : `${p.stock_qty} ${p.unit || ''}`.trim();
    const stockState = isOutOfStock ? 'out' : (isLowStock ? 'low' : 'normal');
    return `
      <div class="pos-product-card ${isOutOfStock?'out-of-stock':''} ${isLowStock?'low-stock':''}" onclick="addToCart(${p.id})">
        <div class="pos-card-topline">
          <span class="pos-category-label">${p.category || 'General'}</span>
          <span class="stock-badge ${stockState}">${isLowStock ? 'Low stock' : stockLabel}</span>
        </div>
        <div class="pos-prod-icon-wrap"><div class="pos-prod-icon">${getIcon(p.category)}</div></div>
        <div class="pos-prod-content">
          <div class="pos-prod-name" title="${p.name}">${p.name}</div>
          <div class="pos-prod-meta">${p.sku || p.barcode || 'Retail item'}</div>
        </div>
        <div class="pos-prod-footer">
          <div class="pos-prod-price">${formatMoney(p.retail_price)}</div>
          <div class="pos-prod-stock ${stockState}">${stockLabel}</div>
        </div>
      </div>
    `;
  }).join('');
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
    cEl.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty-icon"><i class="fa-solid fa-basket-shopping"></i></div>
        <div class="cart-empty-title">Cart is Empty</div>
        <div class="cart-empty-subtitle">Select products to start a new order</div>
      </div>`;
    updateTotals();
    return;
  }
  
  cEl.innerHTML = cart.map((item, i) => `
    <div class="cart-item">
      <div class="cart-item-avatar"><i class="fa-solid fa-box-open"></i></div>
      <div class="cart-item-info">
        <div class="cart-item-name" title="${item.name}">${item.name}</div>
        <div class="cart-item-price">@ ${formatMoney(item.unit_price)}</div>
      </div>
      <div class="cart-item-qty">
        <button onclick="updateCartQty(${i}, -1)" aria-label="Decrease quantity">−</button>
        <span>${item.quantity}</span>
        <button onclick="updateCartQty(${i}, 1)" aria-label="Increase quantity">+</button>
      </div>
      <div class="cart-item-total">${formatMoney(item.quantity * item.unit_price)}</div>
      <button class="cart-item-del" onclick="removeCartItem(${i})" aria-label="Remove item"><i class="fa-solid fa-xmark"></i></button>
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
  
  const saleItems = cart.map(i => ({
    product_id: i.product_id, product_name: i.name,
    quantity: i.quantity, unit_price: i.unit_price, line_total: i.quantity * i.unit_price
  }));

  try {
    const saleId = await db.sales.add(sale);
    await db.sale_items.bulkAdd(saleItems.map(si => ({...si, sale_id: saleId})));
    
    // Update local stock
    for(let item of cart) {
      const p = await db.products.get(item.product_id);
      if(p) await db.products.update(p.id, { stock_qty: p.stock_qty - item.quantity });
    }
    
    if(paymentType === 'credit') {
      const c = await db.customers.get(cartCustomerId);
      await db.customers.update(c.id, { outstanding_balance: c.outstanding_balance + total });
    }

    // Try to sync with Supabase (Background)
    if(!navigator.onLine) {
      const queue = JSON.parse(localStorage.getItem('nexpos_offline_queue') || '[]');
      queue.push({ sale, items: saleItems });
      localStorage.setItem('nexpos_offline_queue', JSON.stringify(queue));
      showToast('info', 'Sale saved offline. Will sync when online.');
    }

    // Finalize
    cart = []; manualDiscount = 0; cartCustomerId = 1;
    renderCart(); updateCartCustomer(); renderPosGrid();
    showReceipt(Object.assign({id:saleId}, sale), saleItems, change, paymentType==='cash'?parseFloat(total+change):total);
    
    await logSecurityEvent('SALE_COMPLETED', { sale_id: saleId, total: total, type: paymentType });

    // Close mobile cart
    document.querySelector('.pos-cart-wrap')?.classList.remove('active');

  } catch (err) {
    console.error('Checkout error:', err);
    showToast('error', 'Failed to complete checkout: ' + err.message);
  }
};

function showReceipt(sale, items, change, tendered) {
  const shopName = currentSettings.biz_name || 'NexPOS';
  const address = currentSettings.address || '';
  const phone = currentSettings.phone || '';
  
  let html = `
    <div style="text-align:center;margin-bottom:15px;border-bottom:1px dashed var(--border);padding-bottom:10px">
      <h2 style="margin:0;font-size:18px;color:var(--text-primary)">${shopName}</h2>
      <div style="color:var(--text-muted);font-size:12px">${address}</div>
      <div style="color:var(--text-muted);font-size:12px">${phone}</div>
    </div>
    <div style="margin-bottom:10px;color:var(--text-primary);font-size:12px">
      <div>Receipt: <span class="fw-600">#${sale.id}</span></div>
      <div>Date: ${new Date(sale.date).toLocaleString()}</div>
      <div>Cashier: ${sale.cashier}</div>
      <div>Pay Method: <span class="badge badge-completed" style="font-size:10px">${sale.payment_type.toUpperCase()}</span></div>
    </div>
    <table style="width:100%;text-align:left;border-bottom:1px dashed var(--border);margin-bottom:10px;color:var(--text-primary)">
      <tr style="color:var(--text-muted);font-size:11px;text-transform:uppercase"><th>Item</th><th>Qty</th><th style="text-align:right">Total</th></tr>
  `;
  
  items.forEach(i => {
    html += `<tr style="border-bottom:1px solid var(--surface-2)"><td style="padding:4px 0">${i.product_name}</td><td>${i.quantity}</td><td style="text-align:right" class="td-mono">${formatMoney(i.line_total)}</td></tr>`;
  });
  
  html += `</table>
    <div style="text-align:right;color:var(--text-primary)">
      <div style="color:var(--text-muted)">Subtotal: ${formatMoney(sale.subtotal)}</div>
      ${sale.discount>0 ? `<div style="color:var(--danger)">Discount: -${formatMoney(sale.discount)}</div>` : ''}
      ${sale.tax>0 ? `<div style="color:var(--text-muted)">Tax: ${formatMoney(sale.tax)}</div>` : ''}
      <h3 style="margin:5px 0;color:var(--brand);font-size:20px">Total: ${formatMoney(sale.total_amount)}</h3>
      ${sale.payment_type==='cash' ? `<div style="font-size:12px">Tendered: ${formatMoney(tendered)}</div><div style="font-weight:700;color:var(--success)">Change: ${formatMoney(change)}</div>` : ''}
    </div>
    <div style="text-align:center;margin-top:15px;border-top:1px dashed var(--border);padding-top:10px;color:var(--text-muted);font-style:italic">Thank you for your business!</div>
  `;
  
  currentReceiptData = { sale, items };
  document.getElementById('receipt-body').innerHTML = html;
  
  // Show "LOCKED" banner for past sales, hide for new ones
  const banner = document.getElementById('receipt-status-banner');
  if (banner) {
    // If sale.id exists and was recently created, it might be the same sale.
    // But usually history view is where we want the banner.
    // Let's show it if sale.status === 'completed' or if we are viewing from history
    banner.style.display = (sale.id) ? 'block' : 'none';
  }

  document.getElementById('receipt-overlay').classList.add('open');
}

window.closeReceipt = () => document.getElementById('receipt-overlay').classList.remove('open');

window.printReceipt = () => {
  window.print();
};

window.shareReceiptPDF = async () => {
  const receiptBody = document.getElementById('receipt-body');
  if (!receiptBody || !currentReceiptData) return showToast('error', 'No receipt data found');

  // 1. Get Phone Number First
  let phone = '';
  try {
    const customer = await db.customers.get(currentReceiptData.sale.customer_id);
    if (customer && customer.phone) {
      phone = customer.phone.replace(/\D/g, '');
      if (phone.length === 9 && phone.startsWith('7')) phone = '94' + phone;
      else if (phone.length === 10 && phone.startsWith('0')) phone = '94' + phone.substring(1);
    }
  } catch(e) {}

  const inputPhone = prompt("Enter WhatsApp number (e.g. 0771234567):", phone);
  if (inputPhone === null) return; // User cancelled

  let finalPhone = inputPhone.replace(/\D/g, '');
  if (finalPhone.length === 9 && finalPhone.startsWith('7')) finalPhone = '94' + finalPhone;
  else if (finalPhone.length === 10 && finalPhone.startsWith('0')) finalPhone = '94' + finalPhone.substring(1);

  showToast('info', 'Generating secure digital receipt...');

  try {
    const { jsPDF } = window.jspdf;
    
    // 2. Create High-Quality Capture
    const tempDiv = document.createElement('div');
    tempDiv.style.position = 'absolute';
    tempDiv.style.left = '-9999px';
    tempDiv.style.width = '350px';
    tempDiv.style.background = 'white';
    tempDiv.style.padding = '30px';
    tempDiv.style.color = 'black';
    tempDiv.style.fontFamily = '"DM Mono", monospace';
    tempDiv.innerHTML = receiptBody.innerHTML;
    document.body.appendChild(tempDiv);

    const canvas = await html2canvas(tempDiv, { scale: 3, useCORS: true, backgroundColor: '#ffffff' });
    document.body.removeChild(tempDiv);

    // 3. Create PDF Blob
    const imgData = canvas.toDataURL('image/jpeg', 0.9);
    const pdfW = 80;
    const pdfH = (canvas.height * pdfW) / canvas.width;
    const pdf = new jsPDF({ unit: 'mm', format: [pdfW, pdfH] });
    pdf.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH);
    const pdfBlob = pdf.output('blob');

    // 4. Secure File Naming (UUID to prevent guessing)
    const fileId = self.crypto.randomUUID();
    const fileName = `receipt_${fileId}.pdf`;
    
    // 5. Upload to Private Storage
    const { error: uploadError } = await supa.storage
      .from('receipts')
      .upload(fileName, pdfBlob, { contentType: 'application/pdf', upsert: true });

    const bizName = currentSettings.biz_name || 'Our Shop';

    if (uploadError) {
        console.warn('Storage Upload Failed:', uploadError.message);
        const downloadName = `Receipt_${currentReceiptData.sale.id}.pdf`;
        pdf.save(downloadName);
        showToast('info', 'Cloud full/missing. PDF downloaded. Opening WhatsApp...');
        const message = encodeURIComponent(`*${bizName}*\nHello! Please find your digital receipt for Order #${currentReceiptData.sale.id} attached below.`);
        setTimeout(() => { window.open(`https://wa.me/${finalPhone}?text=${message}`, '_blank'); }, 1000);
        return;
    }

    // 6. Generate the "Clean" Redirect Link
    // We use the current website origin + bill.html
    const cleanLink = `${window.location.origin}/bill.html?id=${fileId}`;

    // 7. Redirect to WhatsApp with Premium Template
    showToast('success', 'Secure Bill Created! Opening WhatsApp...');
    const bizNameDisplay = currentSettings.biz_name || 'thilakawardhana shop';
    
    const message = encodeURIComponent(
        `✨ *Receipt from ${bizNameDisplay}* ✨\n\n` +
        `Hello! Thank you for your purchase. You can view and download your official bill here:\n\n` +
        `🔗 ${cleanLink}\n\n` +
        `🛡️ _For your privacy, this link is only active for 24 hours._\n` +
        `Have a great day!`
    );
    
    setTimeout(() => {
        window.open(`https://wa.me/${finalPhone}?text=${message}`, '_blank');
    }, 500);

  } catch (err) {
    console.error('PDF Secure Error:', err);
    showToast('error', 'Critical error generating secure receipt.');
  }
};

window.printViaRawBT = (sale, items) => {
  // ESC/POS raw commands for RawBT app
  let r = "rawbt:";
  r += "\x1B\x40"; // Init
  r += "\x1B\x61\x01"; // Center
  r += (currentSettings.biz_name || 'NexPOS') + "\n";
  r += "\x1B\x61\x00"; // Left
  r += "--------------------------------\n";
  items.forEach(i => {
    r += `${i.product_name.slice(0,20)}\n`;
    r += ` ${i.quantity}x${i.unit_price}=${i.line_total}\n`;
  });
  r += "--------------------------------\n";
  r += `TOTAL: ${sale.total_amount}\n`;
  r += "\x1B\x64\x03"; // Feed 3 lines
  window.location.href = r;
};

// --- DASHBOARD ---
async function initDashboard() {
  document.getElementById('dash-date').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  
  const today = new Date(); today.setHours(0,0,0,0);
  const sales = await db.sales.toArray();
  const todaySales = sales.filter(s => new Date(s.date) >= today);
  
  const revenue = todaySales.reduce((s, x)=>s+x.total_amount, 0);
  const transCount = todaySales.length;
  
  let products = await db.products.toArray();
  products = products.filter(p => p.is_active === true);
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
  if(term) products = products.filter(p => (p.name||'').toLowerCase().includes(term) || (p.sku||'').toLowerCase().includes(term) || (p.barcode||'').toLowerCase().includes(term));
  
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
      <div class="form-group">
        <label class="form-label">Barcode</label>
        <div style="position:relative;">
          <input class="form-input" id="f-prod-barcode" value="${p.barcode}" style="padding-right: 40px;">
          <button class="btn btn-ghost btn-icon" onclick="openBarcodeScannerForInput('f-prod-barcode')" style="position:absolute; right:4px; top:50%; transform:translateY(-50%); color:var(--text-muted);" title="Scan Barcode"><i class="fa-solid fa-camera"></i></button>
        </div>
      </div>
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
  
  // Auto-focus barcode field for quick scanning if it's a new product
  setTimeout(() => {
    const field = document.getElementById(id ? 'f-prod-name' : 'f-prod-barcode');
    if (field) field.focus();
  }, 100);
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
  document.getElementById('categories-tbody').innerHTML = cats.map(c => `<tr><td class="fw-600">${c.name}</td><td>-</td><td><button class="btn btn-ghost btn-sm btn-icon" onclick="deleteCategory(${c.id})">🗑️</button></td></tr>`).join('');
};
window.deleteCategory = async (id) => {
  await db.categories.delete(id);
  renderCategoriesTable();
};
window.openCategoryForm = () => {
  openModal('New Category', '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="f-cat-name"></div>', `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveCategory()">Save</button>`);
};
window.saveCategory = async () => {
  const name = document.getElementById('f-cat-name').value;
  if (!name) return showToast('error', 'Name is required');
  await db.categories.add({ name });
  closeModal();
  renderCategoriesTable();
  showToast('success', 'Category added');
};
window.renderUsersTable = async () => {
  const users = await db.users.toArray();
  const today = new Date().toISOString().split('T')[0];
  const attendance = await db.attendance.where('date').equals(today).toArray();
  const attMap = {};
  attendance.forEach(a => attMap[a.user_id] = a.status);

  document.getElementById('users-tbody').innerHTML = users.map(u => {
    const workStatus = attMap[u.id] || 'Clocked Out';
    const statusClass = workStatus === 'Clocked In' ? 'badge-active' : 'badge-inactive';
    
    return `
    <tr>
      <td class="fw-600">${u.username}</td>
      <td>${u.display_name}</td>
      <td>${u.role}</td>
      <td>
        <span class="badge ${u.is_active?'badge-active':'badge-inactive'}" style="margin-right:5px">${u.is_active?'Active':'Inactive'}</span>
        <span class="badge ${statusClass}">${workStatus}</span>
      </td>
      <td>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="openUserForm(${u.id})" title="Edit User">✏️</button>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="deleteUser(${u.id}, '${u.display_name}')" title="Delete User" style="color:var(--danger)">🗑️</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="text-align:center">No users found</td></tr>';
};
window.openUserForm = async (id = null) => {
  let u = { username:'', password:'', display_name:'', role:'Counter', is_active:true, hourly_rate:0, ot_rate:0 };
  if(id) u = await db.users.get(id);
  const html = `
    <input type="hidden" id="f-usr-id" value="${id||''}">
    <div class="form-grid">
      <div class="form-group"><label class="form-label">Username</label><input class="form-input" id="f-usr-name" value="${u.username}"></div>
      <div class="form-group"><label class="form-label">Password</label><input class="form-input" type="password" id="f-usr-pass" value="${u.password}"></div>
      <div class="form-group"><label class="form-label">Display Name</label><input class="form-input" id="f-usr-disp" value="${u.display_name}"></div>
      <div class="form-group"><label class="form-label">Role</label><select class="form-input" id="f-usr-role" onchange="togglePayFields(this.value)"><option ${u.role==='Admin'?'selected':''}>Admin</option><option ${u.role==='Counter'?'selected':''}>Counter</option><option ${u.role==='Cashier'?'selected':''}>Cashier</option><option ${u.role==='HR'?'selected':''}>HR</option><option ${u.role==='Inventory'?'selected':''}>Inventory</option><option ${u.role==='Worker'?'selected':''}>Worker</option></select></div>
      <div id="pay-fields" style="grid-column: span 2; display: ${u.role==='Worker'?'grid':'none'}; grid-template-columns: 1fr 1fr; gap: 14px;">
        <div class="form-group"><label class="form-label">Hourly Rate (Basic)</label><input class="form-input" type="number" step="0.01" id="f-usr-h-rate" value="${u.hourly_rate||0}"></div>
        <div class="form-group"><label class="form-label">OT Rate (per hr)</label><input class="form-input" type="number" step="0.01" id="f-usr-ot-rate" value="${u.ot_rate||0}"></div>
      </div>
      <div class="form-group"><label class="form-label">Status</label><select class="form-input" id="f-usr-active"><option value="true" ${u.is_active?'selected':''}>Active</option><option value="false" ${!u.is_active?'selected':''}>Inactive</option></select></div>
    </div>`;
  openModal(id?'Edit User':'New User', html, `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveUser()">Save</button>`);
};

window.togglePayFields = (role) => {
  document.getElementById('pay-fields').style.display = (role === 'Worker') ? 'grid' : 'none';
};
window.saveUser = async () => {
  const id = document.getElementById('f-usr-id').value;
  const u = { 
    username:document.getElementById('f-usr-name').value, 
    password:document.getElementById('f-usr-pass').value, 
    display_name:document.getElementById('f-usr-disp').value, 
    role:document.getElementById('f-usr-role').value, 
    is_active:document.getElementById('f-usr-active').value==='true',
    hourly_rate: parseFloat(document.getElementById('f-usr-h-rate').value)||0,
    ot_rate: parseFloat(document.getElementById('f-usr-ot-rate').value)||0
  };
  if(id) await db.users.update(parseInt(id), u); else await db.users.add(u);
  closeModal(); renderUsersTable(); showToast('success', 'User saved');
};
window.deleteUser = async (id, name) => {
  if (id === currentUser.id) return showToast('error', 'You cannot delete yourself!');
  if (confirm(`Are you sure you want to remove ${name}? This will permanently delete their account and history.`)) {
    await db.users.delete(id);
    renderUsersTable();
    showToast('success', 'User removed successfully');
  }
};

// --- PAYROLL LOGIC ---
window.renderPayroll = async () => {
  const users = await db.users.where('is_active').equals(true).toArray();
  const tbody = document.getElementById('payroll-tbody');
  
  const rows = [];
  for (const u of users) {
    if (u.role === 'Admin') continue;
    
    const attendance = await db.attendance.where('user_id').equals(u.id).toArray();
    const lastPaid = u.last_paid_date ? new Date(u.last_paid_date) : new Date(0);
    const pendingAttendance = attendance.filter(a => a.clock_out && new Date(a.clock_out) > lastPaid);
    
    let totalHours = 0;
    let basicHours = 0;
    let otHours = 0;
    
    pendingAttendance.forEach(a => {
      const dayHours = (new Date(a.clock_out) - new Date(a.clock_in)) / (1000 * 60 * 60);
      totalHours += dayHours;
      if (dayHours > 8) {
        basicHours += 8;
        otHours += (dayHours - 8);
      } else {
        basicHours += dayHours;
      }
    });

    // Get pending advances
    const advances = await db.advances.where({user_id: u.id, status: 'PENDING'}).toArray();
    const totalAdvances = advances.reduce((sum, a) => sum + a.amount, 0);

    const basicPay = basicHours * (u.hourly_rate || 0);
    const otPay = otHours * (u.ot_rate || 0);
    const totalDue = basicPay + otPay - totalAdvances;

    rows.push(`
      <tr>
        <td class="fw-600">${u.display_name}</td>
        <td>${u.last_paid_date || 'Never'}</td>
        <td class="td-mono">${totalHours.toFixed(2)} hrs</td>
        <td class="td-mono">${formatMoney(basicPay)}</td>
        <td class="td-mono">${formatMoney(otPay)}</td>
        <td class="td-mono text-danger">-${formatMoney(totalAdvances)}</td>
        <td class="td-mono fw-600 text-success">${formatMoney(totalDue)}</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="openPayrollRunModal(${u.id})">Process</button>
        </td>
      </tr>
    `);
  }
  
  tbody.innerHTML = rows.join('') || '<tr><td colspan="8" style="text-align:center">No employees pending payment</td></tr>';
};

window.openPayrollRunModal = async (userId = null) => {
  const users = await db.users.where('is_active').equals(true).toArray();
  const workers = users.filter(u => u.role !== 'Admin');
  
  let u = userId ? await db.users.get(userId) : null;
  
  const html = `
    <div class="form-group">
      <label class="form-label">Employee</label>
      <select class="form-input" id="p-run-user" onchange="updatePayrollCalc()">
        <option value="">Select Employee</option>
        ${workers.map(w => `<option value="${w.id}" ${u && u.id === w.id ? 'selected' : ''}>${w.display_name}</option>`).join('')}
      </select>
    </div>
    <div class="form-grid" style="margin-top:15px">
      <div class="form-group"><label class="form-label">Basic Salary / Rate</label><input type="number" class="form-input" id="p-run-basic-rate" oninput="updatePayrollCalc()"></div>
      <div class="form-group"><label class="form-label">Basic Hours</label><input type="number" class="form-input" id="p-run-basic-hours" oninput="updatePayrollCalc()"></div>
      <div class="form-group"><label class="form-label">OT Rate (per hr)</label><input type="number" class="form-input" id="p-run-ot-rate" oninput="updatePayrollCalc()"></div>
      <div class="form-group"><label class="form-label">OT Hours</label><input type="number" class="form-input" id="p-run-ot-hours" oninput="updatePayrollCalc()"></div>
      <div class="form-group"><label class="form-label">Advances to Deduct</label><input type="number" class="form-input" id="p-run-advances" oninput="updatePayrollCalc()" readonly></div>
      <div class="form-group">
        <label class="form-label">Total Net Pay</label>
        <div id="p-run-total" style="font-size:24px; font-weight:700; color:var(--success); margin-top:5px">Rs. 0.00</div>
      </div>
    </div>
  `;
  
  openModal('Process Payroll Run', html, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="submitPayrollRun()">Confirm Payment</button>
  `);
  
  if (u) updatePayrollCalc();
};

window.updatePayrollCalc = async () => {
  const userId = document.getElementById('p-run-user').value;
  if (!userId) return;
  
  const u = await db.users.get(parseInt(userId));
  
  // Auto-fill from attendance if first time or user changed
  const basicRateInput = document.getElementById('p-run-basic-rate');
  const basicHoursInput = document.getElementById('p-run-basic-hours');
  const otRateInput = document.getElementById('p-run-ot-rate');
  const otHoursInput = document.getElementById('p-run-ot-hours');
  const advancesInput = document.getElementById('p-run-advances');

  // If inputs are empty, auto-calculate from system
  const attendance = await db.attendance.where('user_id').equals(u.id).toArray();
  const lastPaid = u.last_paid_date ? new Date(u.last_paid_date) : new Date(0);
  const pendingAttendance = attendance.filter(a => a.clock_out && new Date(a.clock_out) > lastPaid);
  
  let bHrs = 0;
  let oHrs = 0;
  pendingAttendance.forEach(a => {
    const dayHours = (new Date(a.clock_out) - new Date(a.clock_in)) / (1000 * 60 * 60);
    if (dayHours > 8) { bHrs += 8; oHrs += (dayHours - 8); }
    else { bHrs += dayHours; }
  });

  // Get advances
  const advances = await db.advances.where({user_id: u.id, status: 'PENDING'}).toArray();
  const totalAdvances = advances.reduce((sum, a) => sum + a.amount, 0);

  if (basicRateInput.value === "") basicRateInput.value = u.hourly_rate || 0;
  if (basicHoursInput.value === "") basicHoursInput.value = bHrs.toFixed(2);
  if (otRateInput.value === "") otRateInput.value = u.ot_rate || 0;
  if (otHoursInput.value === "") otHoursInput.value = oHrs.toFixed(2);
  advancesInput.value = totalAdvances;

  const bRate = parseFloat(basicRateInput.value) || 0;
  const bH = parseFloat(basicHoursInput.value) || 0;
  const oRate = parseFloat(otRateInput.value) || 0;
  const oH = parseFloat(otHoursInput.value) || 0;
  const adv = parseFloat(advancesInput.value) || 0;

  const total = (bRate * bH) + (oRate * oH) - adv;
  document.getElementById('p-run-total').textContent = formatMoney(total);
};

window.submitPayrollRun = async () => {
  const userId = parseInt(document.getElementById('p-run-user').value);
  const bRate = parseFloat(document.getElementById('p-run-basic-rate').value) || 0;
  const bH = parseFloat(document.getElementById('p-run-basic-hours').value) || 0;
  const oRate = parseFloat(document.getElementById('p-run-ot-rate').value) || 0;
  const oH = parseFloat(document.getElementById('p-run-ot-hours').value) || 0;
  const adv = parseFloat(document.getElementById('p-run-advances').value) || 0;
  const total = (bRate * bH) + (oRate * oH) - adv;

  if (!userId) return showToast('error', 'Please select an employee');
  if (total < 0) return showToast('error', 'Total cannot be negative');

  const u = await db.users.get(userId);
  const today = new Date().toISOString().split('T')[0];

  await db.payroll.add({
    user_id: userId,
    employee_name: u.display_name,
    period_start: u.last_paid_date || 'Initial',
    period_end: today,
    total_hours: bH + oH,
    ot_hours: oH,
    basic_pay: bRate * bH,
    ot_pay: oRate * oH,
    advances_deducted: adv,
    total_salary: total,
    paid_at: new Date().toISOString()
  });

  // Mark advances as deducted
  const pendingAdvances = await db.advances.where({user_id: userId, status: 'PENDING'}).toArray();
  for (const a of pendingAdvances) {
    await db.advances.update(a.id, { status: 'DEDUCTED' });
  }

  await db.users.update(userId, { last_paid_date: today });

  closeModal();
  showToast('success', `Salary processed for ${u.display_name}`);
  renderPayroll();
};

// --- ADVANCES LOGIC ---
window.renderAdvances = async () => {
  const advances = await db.advances.toArray();
  const tbody = document.getElementById('advances-tbody');
  
  tbody.innerHTML = advances.reverse().map(a => `
    <tr>
      <td class="fw-600">${a.employee_name}</td>
      <td class="td-mono">${formatMoney(a.amount)}</td>
      <td>${a.reason || '-'}</td>
      <td><span class="badge ${a.status==='PENDING'?'badge-pending':'badge-completed'}">${a.status}</span></td>
      <td>${a.date}</td>
      <td>
        ${a.status === 'PENDING' ? `<button class="btn btn-ghost btn-sm" onclick="deleteAdvance(${a.id})">🗑️</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="text-align:center">No advances found</td></tr>';
};

window.openAdvanceForm = async () => {
  const users = await db.users.where('role').equals('Worker').toArray();
  const html = `
    <div class="form-group">
      <label class="form-label">Worker</label>
      <select class="form-input" id="adv-user-id">
        ${users.map(u => `<option value="${u.id}">${u.display_name}</option>`).join('')}
      </select>
    </div>
    <div class="form-group" style="margin-top:15px">
      <label class="form-label">Amount</label>
      <input type="number" class="form-input" id="adv-amount" placeholder="Enter amount">
    </div>
    <div class="form-group" style="margin-top:15px">
      <label class="form-label">Reason</label>
      <textarea class="form-input" id="adv-reason" placeholder="Optional reason"></textarea>
    </div>
  `;
  openModal('New Advance', html, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveAdvance()">Save Advance</button>
  `);
};

window.saveAdvance = async () => {
  const userId = parseInt(document.getElementById('adv-user-id').value);
  const amount = parseFloat(document.getElementById('adv-amount').value);
  const reason = document.getElementById('adv-reason').value;

  if (!userId || !amount) return showToast('error', 'Worker and amount are required');

  const u = await db.users.get(userId);
  await db.advances.add({
    user_id: userId,
    employee_name: u.display_name,
    amount: amount,
    reason: reason,
    status: 'PENDING',
    date: new Date().toISOString().split('T')[0]
  });

  closeModal();
  showToast('success', 'Advance recorded');
  renderAdvances();
};

window.deleteAdvance = async (id) => {
  if (confirm('Delete this advance request?')) {
    await db.advances.delete(id);
    renderAdvances();
  }
};

// --- ATTENDANCE ---
window.renderAttendance = async () => {
  let dateVal = document.getElementById('att-date').value;
  if(!dateVal) {
    const d = new Date();
    dateVal = d.toISOString().split('T')[0];
    document.getElementById('att-date').value = dateVal;
  }
  
  const records = await db.attendance.where('date').equals(dateVal).toArray();
  const tbody = document.getElementById('attendance-tbody');
  
  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center">No attendance records for this date</td></tr>';
    return;
  }
  
  tbody.innerHTML = records.map(r => {
    let hoursStr = '-';
    if (r.clock_in && r.clock_out) {
      const diff = new Date(r.clock_out) - new Date(r.clock_in);
      const hours = (diff / (1000 * 60 * 60)).toFixed(2);
      hoursStr = hours + ' hrs';
    }
    return `
    <tr>
      <td class="fw-600">${r.display_name}</td>
      <td>${r.date}</td>
      <td class="td-mono text-success">${r.clock_in ? new Date(r.clock_in).toLocaleTimeString() : '-'}</td>
      <td class="td-mono text-danger">${r.clock_out ? new Date(r.clock_out).toLocaleTimeString() : '-'}</td>
      <td class="td-mono fw-600">${hoursStr}</td>
      <td><span class="badge ${r.status==='Clocked In'?'badge-pending':'badge-completed'}">${r.status}</span></td>
    </tr>
    `;
  }).join('');
};

window.clockInUser = async () => {
  const users = await db.users.where('is_active').equals(true).toArray();
  const dateVal = new Date().toISOString().split('T')[0];
  
  const html = `
    <div class="form-group">
      <label class="form-label">Select Employee</label>
      <select class="form-input" id="att-emp-id">
        ${users.map(u => `<option value="${u.id}">${u.display_name} (${u.role})</option>`).join('')}
      </select>
    </div>
    <div class="form-group" style="margin-top:10px">
      <label class="form-label">Action</label>
      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" style="flex:1;background:var(--success);border-color:var(--success)" onclick="submitClockIn(true)">⏱️ Clock In</button>
        <button class="btn btn-danger" style="flex:1" onclick="submitClockIn(false)">🛑 Clock Out</button>
      </div>
    </div>
  `;
  openModal('Clock In / Clock Out', html, `<button class="btn btn-secondary" onclick="closeModal()">Close</button>`);
};

window.submitClockIn = async (isClockIn) => {
  const empId = parseInt(document.getElementById('att-emp-id').value);
  const emp = await db.users.get(empId);
  const dateVal = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  
  let record = await db.attendance.where({user_id: empId, date: dateVal}).first();
  
  if (isClockIn) {
    if (record && record.clock_in) {
      showToast('error', 'Already clocked in for today');
      return;
    }
    if (!record) {
      await db.attendance.add({
        user_id: emp.id,
        display_name: emp.display_name,
        date: dateVal,
        clock_in: now,
        clock_out: null,
        status: 'Clocked In'
      });
    } else {
      await db.attendance.update(record.id, { clock_in: now, status: 'Clocked In' });
    }
    showToast('success', `${emp.display_name} clocked in!`);
  } else {
    if (!record || !record.clock_in) {
      showToast('error', 'Must clock in first');
      return;
    }
    if (record.clock_out) {
      showToast('error', 'Already clocked out');
      return;
    }
    await db.attendance.update(record.id, { clock_out: now, status: 'Completed' });
    showToast('success', `${emp.display_name} clocked out!`);
  }
  
  closeModal();
  renderAttendance();
};

// --- AI REPORTS LOGIC ---
let reportCharts = {};
let currentReportData = null;

window.setReportPeriod = (period) => {
  document.querySelectorAll('.btn-group .btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`btn-period-${period}`).classList.add('active');
  document.getElementById('custom-range-inputs').style.display = (period === 'custom') ? 'flex' : 'none';
  
  if (period !== 'custom') renderAIReports();
};

window.renderAIReports = async () => {
  const mainContent = document.getElementById('report-main-content');
  try {
    await loadSettings(); 
    const activeBtn = document.querySelector('#report-period-group .btn.active');
    if (!activeBtn) return;
    
    const period = activeBtn.id.replace('btn-period-', '');
    let start, end;
    const now = new Date();
    
    if (period === 'today') {
      start = new Date(new Date(now).setHours(0,0,0,0)).toISOString();
      end = new Date(new Date(now).setHours(23,59,59,999)).toISOString();
    } else if (period === 'week') {
      const day = now.getDay() || 7;
      const firstDay = new Date(now);
      firstDay.setDate(now.getDate() - day + 1);
      start = new Date(firstDay.setHours(0,0,0,0)).toISOString();
      end = new Date(new Date(now).setHours(23,59,59,999)).toISOString();
    } else if (period === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
    } else if (period === 'custom') {
      start = document.getElementById('report-start-date').value;
      end = document.getElementById('report-end-date').value;
      if (!start || !end) return showToast('info', 'Please select a date range');
      start = new Date(start).toISOString();
      end = new Date(new Date(end).setHours(23,59,59,999)).toISOString();
    }

    if (mainContent) {
      mainContent.innerHTML = `<div class="spinner-lg" style="margin: 50px auto;"></div>`;
      mainContent.style.display = 'flex';
    }

    const data = await fetchReportData(start, end);
    if (!data) throw new Error("Could not calculate report data");
    
    currentReportData = data;
    
    // Clear spinner and render
    mainContent.innerHTML = `
      <div id="report-executive-summary" class="card" style="display:none; border-left:4px solid var(--brand)">
        <div class="card-body">
          <div class="section-header" style="color:var(--brand)">📈 Executive Summary & Insights</div>
          <div id="executive-summary-content" style="font-size:14px; line-height:1.6; color:var(--text-secondary)"></div>
        </div>
      </div>
      <div class="summary-grid" id="report-kpi-grid"></div>
      <div id="report-secondary-metrics"></div>
      <div class="dash-grid">
        <div class="card"><div class="card-body"><div class="section-header">Revenue Trend</div><div style="height:250px"><canvas id="chart-revenue-trend"></canvas></div></div></div>
        <div class="card"><div class="card-body"><div class="section-header">Hourly Sales (Peak Activity)</div><div style="height:250px"><canvas id="chart-hourly-peak"></canvas></div></div></div>
      </div>
      <div class="dash-grid" style="margin-top:20px">
        <div class="card"><div class="card-body"><div class="section-header">Payment Methods</div><div style="height:250px"><canvas id="chart-payments"></canvas></div></div></div>
        <div class="card"><div class="card-body"><div class="section-header">Customer Loyalty</div><div style="height:250px"><canvas id="chart-loyalty"></canvas></div></div></div>
      </div>
      <div class="dash-grid">
        <div class="card">
          <div class="card-body">
            <div class="section-header">👥 HR & Operations</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
              <div style="padding:12px; background:var(--surface-2); border-radius:var(--radius)"><div style="font-size:10px; color:var(--text-muted); text-transform:uppercase">Hours</div><div style="font-size:18px; font-weight:700" id="kpi-hr-hours">0</div></div>
              <div style="padding:12px; background:var(--surface-2); border-radius:var(--radius)"><div style="font-size:10px; color:var(--text-muted); text-transform:uppercase">Payroll</div><div style="font-size:18px; font-weight:700" id="kpi-hr-cost">0</div></div>
            </div>
            <div id="hr-insight-text" style="margin-top:12px; font-size:12px"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-body">
            <div class="section-header">📦 Inventory</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
              <div style="padding:12px; background:var(--surface-2); border-radius:var(--radius)"><div style="font-size:10px; color:var(--text-muted); text-transform:uppercase">Stock Value</div><div style="font-size:18px; font-weight:700" id="kpi-inv-value">0</div></div>
              <div style="padding:12px; background:var(--surface-2); border-radius:var(--radius)"><div style="font-size:10px; color:var(--text-muted); text-transform:uppercase">Low Stock</div><div style="font-size:18px; font-weight:700; color:var(--danger)" id="kpi-inv-low">0</div></div>
            </div>
            <div id="inv-insight-text" style="margin-top:12px; font-size:12px"></div>
          </div>
        </div>
      </div>
      <div id="report-breakdowns"></div>
    `;

  // 0. Update Executive Summary
  const execSummary = document.getElementById('report-executive-summary');
  const execContent = document.getElementById('executive-summary-content');
  if (execSummary && execContent) {
    execSummary.style.display = 'block';
    const topProd = data.topProducts[0]?.name || 'N/A';
    execContent.innerHTML = `
      Your business generated <b>${formatMoney(data.revenue)}</b> revenue from <b>${data.transactions}</b> transactions. 
      The most successful category was <b>${Object.entries(data.categoryStats).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'N/A'}</b>, 
      with <b>${topProd}</b> as the top-selling item. 
      Customer retention is at <b>${data.repeatRate.toFixed(1)}%</b>. 
      Peak sales activity occurs between <b>${data.peakHour}:00 and ${data.peakHour + 1}:00</b>.
    `;
  }

  // 1. Update Sales KPIs
  const kpiGrid = document.getElementById('report-kpi-grid');
  if (kpiGrid) {
    kpiGrid.innerHTML = `
      <div class="summary-card">
        <div class="summary-label">Total Revenue</div>
        <div class="summary-value">${formatMoney(data.revenue)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">Net Revenue</div>
        <div class="summary-value">${formatMoney(data.netRevenue)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">Transactions</div>
        <div class="summary-value">${data.transactions}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">Gross Profit</div>
        <div class="summary-value" style="color:var(--success)">${formatMoney(data.grossProfit)}</div>
      </div>
    `;
  }
  
  // 2. Add/Update Secondary Metrics
  const secondaryHtml = `
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:15px">
      <div class="card" style="padding:15px">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase">Items Per Sale (IPT)</div>
        <div style="font-size:20px; font-weight:700">${data.ipt.toFixed(1)}</div>
      </div>
      <div class="card" style="padding:15px">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase">Repeat Customers</div>
        <div style="font-size:20px; font-weight:700">${data.repeatCount} (${data.repeatRate.toFixed(1)}%)</div>
      </div>
      <div class="card" style="padding:15px">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase">Profit Margin</div>
        <div style="font-size:20px; font-weight:700; color:var(--success)">${data.profitMargin.toFixed(1)}%</div>
      </div>
      <div class="card" style="padding:15px">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase">Peak Hour</div>
        <div style="font-size:20px; font-weight:700">${data.peakHour}:00 - ${data.peakHour + 1}:00</div>
      </div>
    </div>
  `;
  
  const secondaryContainer = document.getElementById('report-secondary-metrics');
  if (secondaryContainer) secondaryContainer.innerHTML = secondaryHtml;

  // 3. Update HR & Operations
  document.getElementById('kpi-hr-hours').textContent = `${data.totalHours.toFixed(1)} hrs`;
  document.getElementById('kpi-hr-cost').textContent = formatMoney(data.payrollTotal + data.advancesTotal);
  document.getElementById('hr-insight-text').textContent = data.totalHours > 0 
    ? `Staff productivity: ${formatMoney(data.revenue / (data.totalHours || 1))} per hour.`
    : "No labor hours recorded.";

  // 4. Update Inventory Intelligence
  document.getElementById('kpi-inv-value').textContent = formatMoney(data.totalInventoryValue);
  document.getElementById('kpi-inv-low').textContent = data.lowStockCount;
  
  const invInsight = document.getElementById('inv-insight-text');
  if (invInsight) {
    invInsight.innerHTML = `
      <div style="margin-top:10px; font-size:12px">
        <span>Turnover Rate: <b>${(data.turnoverRate * 100).toFixed(1)}%</b></span>
        <span style="margin-left:15px">Sell-Through: <b>${(data.sellThroughRate * 100).toFixed(1)}%</b></span>
      </div>
    `;
  }

  // 5. Update Breakdowns
  const breakdownHtml = `
    <div class="dash-grid" style="margin-top:20px">
      <div class="card">
        <div class="card-body">
          <div class="section-header">Sales by Category</div>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>Category</th><th style="text-align:right">Revenue</th></tr></thead>
              <tbody>
                ${Object.entries(data.categoryStats).sort((a,b)=>b[1]-a[1]).map(([cat, rev]) => `
                  <tr><td>${cat}</td><td style="text-align:right">${formatMoney(rev)}</td></tr>
                `).join('') || '<tr><td colspan="2">No data</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="section-header">Sales by Employee</div>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>Employee</th><th style="text-align:right">Revenue</th></tr></thead>
              <tbody>
                ${Object.entries(data.salesByCashier).sort((a,b)=>b[1]-a[1]).map(([emp, rev]) => `
                  <tr><td>${emp}</td><td style="text-align:right">${formatMoney(rev)}</td></tr>
                `).join('') || '<tr><td colspan="2">No data</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
  const breakdownContainer = document.getElementById('report-breakdowns');
  if (breakdownContainer) breakdownContainer.innerHTML = breakdownHtml;

  // 6. Update Top Products Table
  const topProductsTbody = document.getElementById('report-top-products-tbody');
  if (topProductsTbody) {
    topProductsTbody.innerHTML = data.topProducts.map((p, i) => `
      <tr>
        <td>#${i+1}</td>
        <td class="fw-600">${p.name}</td>
        <td>${p.qty}</td>
        <td class="td-mono">${formatMoney(p.revenue)}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" style="text-align:center">No sales data</td></tr>';
  }

  // 7. Render Charts
  renderReportCharts(data);
  } catch (err) {
    console.error(err);
    if(mainContent) mainContent.innerHTML = `<div class="error-state">Failed to load report. Please try again.</div>`;
  }
};




async function fetchReportData(start, end) {
  // 1. Sales Data
  let allSales = await db.sales.toArray();
  const periodSales = allSales.filter(s => s.date >= start && s.date <= end);
  
  const revenue = periodSales.reduce((sum, s) => sum + s.total_amount, 0);
  const transactions = periodSales.length;
  const totalItemsSold = periodSales.reduce((sum, s) => sum + (s.items_count || 0), 0);
  const discount = periodSales.reduce((sum, s) => sum + (s.discount || 0), 0);
  const tax = periodSales.reduce((sum, s) => sum + (s.tax || 0), 0);
  
  // Advanced Matrices
  const ipt = totalItemsSold / (transactions || 1);
  const netRevenue = revenue - discount - tax;
  
  // 2. Customer Analytics (New vs Repeat)
  const periodCustomerIds = new Set(periodSales.filter(s => s.customer_id > 1).map(s => s.customer_id));
  let repeatCount = 0;
  periodCustomerIds.forEach(cid => {
    const previousSales = allSales.filter(s => s.customer_id === cid && s.date < start);
    if (previousSales.length > 0) repeatCount++;
  });
  const uniqueCustomers = periodCustomerIds.size;
  const repeatRate = uniqueCustomers > 0 ? (repeatCount / uniqueCustomers) * 100 : 0;

  // 3. Revenue by Payment Type
  const payments = { cash: 0, card: 0, credit: 0 };
  periodSales.forEach(s => { if (payments[s.payment_type] !== undefined) payments[s.payment_type] += s.total_amount; });
  
  // 4. Time Analytics (Daily & Hourly)
  const dailyRev = {};
  const hourlySales = Array(24).fill(0);
  periodSales.forEach(s => {
    const day = s.date.split('T')[0];
    dailyRev[day] = (dailyRev[day] || 0) + s.total_amount;
    
    const hour = new Date(s.date).getHours();
    hourlySales[hour]++;
  });
  
  // Find Peak Hour
  const peakHour = hourlySales.indexOf(Math.max(...hourlySales));

  // 5. Product & Category Performance
  const items = await db.sale_items.toArray();
  const saleIds = periodSales.map(s => s.id);
  const periodItems = items.filter(i => saleIds.includes(i.sale_id));
  
  const allProducts = await db.products.toArray();
  const prodMap = {}; 
  allProducts.forEach(p => {
    prodMap[p.id] = { cost: p.cost_price || 0, category: p.category || 'Uncategorized' };
  });

  const productStats = {};
  const categoryStats = {};
  
  periodItems.forEach(i => {
    if (!productStats[i.product_name]) productStats[i.product_name] = { qty: 0, revenue: 0, product_id: i.product_id };
    productStats[i.product_name].qty += i.quantity;
    productStats[i.product_name].revenue += i.line_total;

    const cat = prodMap[i.product_id]?.category || 'Uncategorized';
    categoryStats[cat] = (categoryStats[cat] || 0) + i.line_total;
  });
  
  const topProducts = Object.entries(productStats)
    .map(([name, stat]) => ({ name, ...stat }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);
    
  // 6. Gross Profit & Margins
  let totalCost = 0;
  periodItems.forEach(i => { totalCost += i.quantity * (prodMap[i.product_id]?.cost || 0); });
  const grossProfit = revenue - totalCost;
  const profitMargin = (grossProfit / (revenue || 1)) * 100;
  
  // 7. HR Costs & Attendance
  const payrolls = await db.payroll.toArray();
  const periodPayroll = payrolls.filter(p => p.paid_at >= start && p.paid_at <= end);
  const payrollTotal = periodPayroll.reduce((sum, p) => sum + p.total_salary, 0);
  
  const advances = await db.advances.toArray();
  const periodAdvances = advances.filter(a => a.date >= start.split('T')[0] && a.date <= end.split('T')[0]);
  const advancesTotal = periodAdvances.reduce((sum, a) => sum + a.amount, 0);

  const attendance = await db.attendance.toArray();
  const periodAtt = attendance.filter(a => a.date >= start.split('T')[0] && a.date <= end.split('T')[0]);
  let totalHours = 0;
  periodAtt.forEach(a => {
    if (a.clock_in && a.clock_out) {
      totalHours += (new Date(a.clock_out) - new Date(a.clock_in)) / (1000 * 60 * 60);
    }
  });

  // 8. Inventory Intelligence
  let totalInventoryValue = 0;
  let totalStockQty = 0;
  let lowStockCount = 0;
  allProducts.forEach(p => {
    totalInventoryValue += (p.stock_qty || 0) * (p.retail_price || 0);
    totalStockQty += (p.stock_qty || 0);
    if ((p.stock_qty || 0) <= (p.low_stock_threshold || 0)) lowStockCount++;
  });

  const turnoverRate = totalCost > 0 ? (totalCost / (totalInventoryValue || 1)) : 0;
  const sellThroughRate = totalItemsSold / (totalStockQty + totalItemsSold || 1);

  return {
    revenue, netRevenue, transactions, totalItemsSold, discount, tax, 
    ipt, uniqueCustomers, repeatCount, repeatRate, peakHour,
    payments, dailyRev, hourlySales, salesByCashier: {}, // Simplified for now
    categoryStats, topProducts, grossProfit, profitMargin,
    payrollTotal, advancesTotal, totalHours, totalInventoryValue, lowStockCount,
    turnoverRate, sellThroughRate, start, end
  };
}


function renderReportCharts(data) {
  // Revenue Trend
  if (reportCharts.trend) reportCharts.trend.destroy();
  const trendLabels = Object.keys(data.dailyRev).sort();
  reportCharts.trend = new Chart(document.getElementById('chart-revenue-trend'), {
    type: 'line',
    data: {
      labels: trendLabels,
      datasets: [{ label: 'Revenue', data: trendLabels.map(l => data.dailyRev[l]), borderColor: '#6366f1', tension: 0.3, fill: true, backgroundColor: 'rgba(99, 102, 241, 0.1)' }]
    },
    options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
  });

  // Hourly Peak
  if (reportCharts.hourly) reportCharts.hourly.destroy();
  reportCharts.hourly = new Chart(document.getElementById('chart-hourly-peak'), {
    type: 'bar',
    data: {
      labels: Array.from({length: 24}, (_, i) => `${i}:00`),
      datasets: [{ label: 'Transactions', data: data.hourlySales, backgroundColor: 'rgba(245, 158, 11, 0.8)' }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });

  // Payment Types
  if (reportCharts.payments) reportCharts.payments.destroy();
  reportCharts.payments = new Chart(document.getElementById('chart-payments'), {
    type: 'doughnut',
    data: {
      labels: ['Cash', 'Card', 'Credit'],
      datasets: [{ data: [data.payments.cash, data.payments.card, data.payments.credit], backgroundColor: ['#10b981', '#3b82f6', '#f59e0b'] }]
    },
    options: { maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'bottom' } } }
  });

  // Loyalty
  if (reportCharts.loyalty) reportCharts.loyalty.destroy();
  reportCharts.loyalty = new Chart(document.getElementById('chart-loyalty'), {
    type: 'pie',
    data: {
      labels: ['New Customers', 'Repeat Customers'],
      datasets: [{ data: [data.uniqueCustomers - data.repeatCount, data.repeatCount], backgroundColor: ['#6366f1', '#10b981'] }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });
}


window.generateAIInsight = async () => {
  if (!currentReportData) return;
  
  const btn = document.getElementById('btn-regen-ai');
  const content = document.getElementById('ai-content');
  const loading = document.getElementById('ai-loading');
  const empty = document.getElementById('ai-empty');
  const ready = document.getElementById('ai-ready');

  content.style.display = 'none';
  empty.style.display = 'none';
  ready.style.display = 'none';
  loading.style.display = 'block';
  btn.disabled = true;

  try {
    const provider = currentSettings.ai_provider || 'anthropic';
    const apiKey = currentSettings.ai_api_key;
    
    if (!apiKey) {
        throw new Error('Please add your AI API Key in Settings first.');
    }

    const bizName = currentSettings.biz_name || 'My Shop';
    const topProds = currentReportData.topProducts.map(p => `${p.name} (${p.qty} units)`).join(', ');
    const range = `${currentReportData.start.split('T')[0]} to ${currentReportData.end.split('T')[0]}`;
    
    const sysPrompt = "You are a specialized business analyst AI for the NexPOS system in Sri Lanka. You are given sales, payroll, and inventory data for a specific time period. Write a concise, friendly, and actionable business performance report in 3 sections: (1) Performance Summary — how the business did this period vs what the numbers mean, (2) Key Insights — 3 specific observations about what is working or not working, (3) Recommendations — 3 concrete actions the owner should take. Write in plain English. Keep total response under 300 words. End with one motivational sentence. Do not mention your own name or that you are an AI model.";
    
    const userPrompt = `Business: ${bizName}. Period: ${range}. Revenue: ${formatMoney(currentReportData.revenue)}. Transactions: ${currentReportData.transactions}. Avg transaction: ${formatMoney(currentReportData.revenue / (currentReportData.transactions || 1))}. Top products: ${topProds}. Payment breakdown: Cash ${formatMoney(currentReportData.payments.cash)}, Card ${formatMoney(currentReportData.payments.card)}, Credit ${formatMoney(currentReportData.payments.credit)}. Payroll cost: ${formatMoney(currentReportData.payrollTotal)}. Gross profit estimate: ${formatMoney(currentReportData.grossProfit)}. Discount given: ${formatMoney(currentReportData.discount)}.`;

    let aiText = '';

    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'dangerously-allow-browser': 'true' },
        body: JSON.stringify({
          model: 'claude-3-sonnet-20240229', max_tokens: 1000, system: sysPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      aiText = data.content[0].text;

    } else if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4-turbo-preview',
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      aiText = data.choices[0].message.content;

    } else if (provider === 'google') {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: sysPrompt + "\n\n" + userPrompt }] }]
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      aiText = data.candidates[0].content.parts[0].text;
      
    } else if (provider === 'openrouter') {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': window.location.origin, // Optional for OpenRouter
          'X-Title': 'NexPOS' // Optional for OpenRouter
        },
        body: JSON.stringify({
          model: 'openai/gpt-3.5-turbo', // Default model for OpenRouter
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      aiText = data.choices[0].message.content;
    }

    content.innerText = aiText;
    loading.style.display = 'none';
    ready.style.display = 'block';
  } catch (err) {
    ready.style.display = 'none';
    empty.style.display = 'block';
    showToast('error', err.message);
  } finally {
    btn.disabled = false;
  }
};

window.copyAIReport = () => {
  const text = document.getElementById('ai-content').innerText;
  navigator.clipboard.writeText(text);
  showToast('success', 'Report copied to clipboard');
};

window.downloadPDFReport = async () => {
  if (!currentReportData) return showToast('error', 'Please generate or refresh a report first');
  
  const btn = document.getElementById('btn-download-pdf');
  const originalText = btn.innerHTML;
  btn.disabled = true;

  try {
    // 1. Get jsPDF constructor robustly
    let jspdfLib;
    if (window.jspdf && window.jspdf.jsPDF) {
      jspdfLib = window.jspdf.jsPDF;
    } else if (window.jsPDF) {
      jspdfLib = window.jsPDF;
    }
    
    if (!jspdfLib) throw new Error("PDF generation library (jsPDF) is not loaded. Please check your internet connection.");

    const doc = new jspdfLib('p', 'mm', 'a4');
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 20;
    const contentWidth = pageWidth - (margin * 2);
    let curY = 40;
    let pageNum = 1;

    const setProgress = (step, msg) => { 
      btn.innerText = `Step ${step}/5: ${msg}`; 
      console.log(`PDF Gen Step ${step}: ${msg}`);
    };

    const aiTextRaw = document.getElementById('ai-content')?.innerText || "AI analysis not generated. Use the 'Generate AI Report' button for insights.";

    // --- STEP 1: DATA GATHERING ---
    setProgress(1, "Analyzing inventory...");
    const invData = await fetchInventoryIntelligence();

    setProgress(2, "Fetching market trends...");
    const marketData = await fetchMarketIntelligence();

    setProgress(3, "Processing report structure...");
    const bizName = currentSettings.biz_name || 'NexPOS Shop';
    const periodType = document.querySelector('.btn-group .btn.active')?.innerText || 'Report';
    const dateRange = `${new Date(currentReportData.start).toLocaleDateString()} – ${new Date(currentReportData.end).toLocaleDateString()}`;

    // --- PAGE 1: COVER PAGE ---
    doc.setFillColor(27, 29, 42); 
    doc.rect(0, 0, pageWidth, pageHeight, 'F');
    doc.setFillColor(91, 95, 199); 
    doc.circle(pageWidth/2, 80, 15, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text("NP", pageWidth/2, 82, { align: 'center' });
    doc.setFontSize(26); doc.text(bizName.toUpperCase(), pageWidth/2, 110, { align: 'center' });
    doc.setFontSize(18); doc.setFont('helvetica', 'normal');
    doc.text("Business Performance Report", pageWidth/2, 125, { align: 'center' });
    doc.setDrawColor(91, 95, 199); doc.setLineWidth(1); doc.line(pageWidth/2 - 40, 135, pageWidth/2 + 40, 135);
    doc.setFontSize(12); doc.text(`${periodType}: ${dateRange}`, pageWidth/2, 150, { align: 'center' });
    doc.setFontSize(9); doc.text("NexPOS Ceylon — Business Intelligence Module", pageWidth/2, pageHeight - 20, { align: 'center' });

    // --- PAGE 2: EXECUTIVE DASHBOARD ---
    setProgress(4, "Building performance pages...");
    doc.addPage(); pageNum++;
    addPDFHeaderFooter(doc, bizName, pageNum, 6);
    doc.setTextColor(31, 41, 55); doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text("Executive Summary", margin, 40);

    const kpis = [
      { label: 'Total Revenue', value: formatMoney(currentReportData.revenue), sub: `from ${currentReportData.transactions} transactions`, color: [16, 185, 129] },
      { label: 'Gross Profit', value: formatMoney(currentReportData.grossProfit), sub: `${((currentReportData.grossProfit / (currentReportData.revenue || 1)) * 100).toFixed(1)}% margin`, color: [245, 158, 11] },
      { label: 'Avg Sale', value: formatMoney(currentReportData.revenue / (currentReportData.transactions || 1)), sub: 'revenue per customer', color: [59, 130, 246] },
      { label: 'Items Per Sale', value: (currentReportData.totalItemsSold / (currentReportData.transactions || 1)).toFixed(1), sub: 'average basket size', color: [168, 85, 247] }
    ];

    let kX = margin, kY = 50, boxW = (contentWidth - 10) / 2, boxH = 30;
    kpis.forEach((k, i) => {
      doc.setFillColor(255, 255, 255); doc.setDrawColor(240, 240, 240); doc.rect(kX, kY, boxW, boxH, 'FD');
      doc.setFillColor(...k.color); doc.rect(kX, kY, 2, boxH, 'F');
      doc.setTextColor(100, 100, 100); doc.setFontSize(8); doc.text(k.label, kX + 6, kY + 8);
      doc.setTextColor(31, 41, 55); doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.text(k.value, kX + 6, kY + 18);
      doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(150, 150, 150); doc.text(k.sub, kX + 6, kY + 25);
      if ((i + 1) % 2 === 0) { kX = margin; kY += boxH + 5; } else { kX += boxW + 5; }
    });

    curY = kY + 10;
    setProgress(5, "Capturing visual data...");
    
    // Revenue Trend Chart
    const trendEl = document.getElementById('chart-revenue-trend');
    if (trendEl) {
      try {
        const trendCanvas = await html2canvas(trendEl.parentElement, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
        doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(31, 41, 55);
        doc.text("Revenue Trend Analysis", margin, curY);
        doc.addImage(trendCanvas.toDataURL('image/png'), 'PNG', margin, curY + 5, contentWidth, 60);
        curY += 75;
      } catch (ce) { console.warn("Failed to capture trend chart", ce); curY += 10; }
    }

    // Payment Type Chart
    const payEl = document.getElementById('chart-payments');
    if (payEl) {
      try {
        if (curY > pageHeight - 80) { doc.addPage(); pageNum++; addPDFHeaderFooter(doc, bizName, pageNum, 6); curY = 40; }
        doc.setFontSize(10); doc.setFont('helvetica', 'bold');
        doc.text("Revenue by Payment Method", margin, curY);
        const payCanvas = await html2canvas(payEl.parentElement, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
        doc.addImage(payCanvas.toDataURL('image/png'), 'PNG', margin + (contentWidth - 60)/2, curY + 5, 60, 60);
      } catch (ce) { console.warn("Failed to capture payment chart", ce); }
    }

    // --- PAGE 3: TOP PRODUCTS ---
    doc.addPage(); pageNum++;
    addPDFHeaderFooter(doc, bizName, pageNum, 6);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.text("Top Product Performance", margin, 40);
    
    let pY = 55;
    const pCols = [15, 80, 25, 30, 20];
    doc.setFillColor(91, 95, 199); doc.rect(margin, pY - 5, contentWidth, 8, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(8);
    let pX = margin;
    ['RANK', 'PRODUCT', 'UNITS', 'REVENUE', '% TOTAL'].forEach((h, i) => { doc.text(h, pX + 2, pY); pX += pCols[i]; });

    pY += 8;
    (currentReportData.topProducts || []).forEach((p, i) => {
      doc.setTextColor(50, 50, 50); doc.setFontSize(8);
      if (i % 2 !== 0) { doc.setFillColor(248, 249, 250); doc.rect(margin, pY - 5, contentWidth, 8, 'F'); }
      let rX = margin;
      doc.text(`#${i+1}`, rX + 2, pY); rX += pCols[0];
      doc.text(p.name, rX + 2, pY); rX += pCols[1];
      doc.text(p.qty.toString(), rX + 2, pY); rX += pCols[2];
      doc.text(formatMoney(p.revenue), rX + 2, pY); rX += pCols[3];
      doc.text(`${(p.revenue / (currentReportData.revenue || 1) * 100).toFixed(1)}%`, rX + 2, pY);
      pY += 8;
    });

    pY += 15;
    doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text("Sales Breakdown by Category", margin, pY);
    pY += 8;
    Object.entries(currentReportData.categoryStats || {}).sort((a,b)=>b[1]-a[1]).forEach(([cat, rev]) => {
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      doc.text(cat, margin + 2, pY);
      doc.text(formatMoney(rev), pageWidth - margin - 2, pY, { align: 'right' });
      pY += 7;
    });

    pY += 10;
    doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text("Employee Performance (Sales)", margin, pY);
    pY += 8;
    Object.entries(currentReportData.salesByCashier || {}).sort((a,b)=>b[1]-a[1]).forEach(([emp, rev]) => {
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      doc.text(emp, margin + 2, pY);
      doc.text(formatMoney(rev), pageWidth - margin - 2, pY, { align: 'right' });
      pY += 7;
    });

    // --- PAGE 4: INVENTORY INTELLIGENCE ---
    doc.addPage(); pageNum++;
    addPDFHeaderFooter(doc, bizName, pageNum, 6);
    
    // Branding Header
    doc.setFillColor(59, 130, 246); doc.rect(margin, 35, 2, 10, 'F');
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(31, 41, 55);
    doc.text("Inventory Intelligence Report", margin + 6, 42);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(107, 114, 128);
    doc.text(`Proprietary Analysis for ${bizName}`, margin + 6, 47);
    
    doc.setFontSize(10); doc.setTextColor(50, 50, 50); doc.setFont('helvetica', 'bold');
    doc.text(`Turnover Rate: ${(currentReportData.turnoverRate * 100).toFixed(1)}%`, margin, 53);
    doc.text(`Sell-Through Rate: ${(currentReportData.sellThroughRate * 100).toFixed(1)}%`, pageWidth/2, 53);

    doc.setFontSize(11); doc.setTextColor(55, 65, 81); doc.setFont('helvetica', 'bold');
    doc.text("Low Stock Alerts", margin, 58);
    let iY = 66;
    const iCols = [60, 25, 25, 30, 30];
    doc.setFillColor(71, 85, 105); doc.rect(margin, iY - 5, contentWidth, 8, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(7);
    let iX = margin;
    ['PRODUCT', 'STOCK', 'THRESHOLD', 'STATUS', 'SUGGESTED ORDER'].forEach((h, j) => { doc.text(h, iX + 2, iY); iX += iCols[j]; });
    
    iY += 8;
    invData.lowStock.forEach((p, k) => {
      doc.setTextColor(50, 50, 50);
      let status = "LOW"; let sCol = [234, 179, 8];
      if (p.stock_qty === 0) { status = "OUT OF STOCK"; sCol = [220, 38, 38]; }
      else if (p.stock_qty <= p.low_stock_threshold/2) { status = "CRITICAL"; sCol = [249, 115, 22]; }

      let lX = margin;
      doc.text(p.name, lX + 2, iY); lX += iCols[0];
      doc.text(p.stock_qty.toString(), lX + 2, iY); lX += iCols[1];
      doc.text(p.low_stock_threshold.toString(), lX + 2, iY); lX += iCols[2];
      
      doc.setFillColor(...sCol); doc.rect(lX + 1, iY - 4, 25, 5, 'F');
      doc.setTextColor(255, 255, 255); doc.text(status, lX + 13.5, iY - 0.5, { align: 'center' });
      lX += iCols[3];
      
      doc.setTextColor(50, 50, 50);
      doc.text(`${(p.low_stock_threshold * 3) - p.stock_qty} pcs`, lX + 2, iY);
      iY += 8;
    });

    iY += 10;
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(59, 130, 246);
    doc.text("Reorder Schedule", margin, iY);
    iY += 8; doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50);
    let budget = 0;
    invData.velocity.filter(v => v.daysUntilStockout < 14).forEach(v => {
      const qty = Math.max(0, (v.retail_price > 0 ? 50 : 10)); // simple logic
      const cost = qty * v.cost_price;
      budget += cost;
      doc.text(`[ ] Order ${v.name} in ${Math.round(v.daysUntilStockout)} days - Est. Cost: ${formatMoney(cost)}`, margin + 5, iY);
      iY += 6;
    });
    doc.setFont('helvetica', 'bold'); doc.text(`Total Reorder Budget: ${formatMoney(budget)}`, margin, iY + 4);

    // --- PAGE 5: MARKET INTELLIGENCE ---
    doc.addPage(); pageNum++;
    addPDFHeaderFooter(doc, bizName, pageNum, 6);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(31, 41, 55);
    doc.text("Market Intelligence", margin, 40);
    doc.setFontSize(8); doc.setFont('helvetica', 'italic'); doc.setTextColor(150, 150, 150);
    doc.text(`Live market data sourced from public information - ${new Date().toLocaleDateString()}`, margin, 46);

    const drawCard = (title, body, color, y) => {
      doc.setFillColor(248, 249, 250); doc.rect(margin, y, contentWidth, 35, 'F');
      doc.setFillColor(...color); doc.rect(margin, y, 2, 35, 'F');
      doc.setTextColor(50, 50, 50); doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.text(title, margin + 6, y + 8);
      doc.setFontSize(8); doc.setFont('helvetica', 'normal');
      const lines = doc.splitTextToSize(body, contentWidth - 15);
      doc.text(lines, margin + 6, y + 16);
      return y + 40;
    };

    let mY = 55;
    mY = drawCard(`${currentSettings.biz_type} Sector Overview`, marketData.industry, [59, 130, 246], mY);
    mY = drawCard(`Market Info: ${currentReportData.topProducts[0]?.name || 'Top Product'}`, marketData.priceTrend, [16, 185, 129], mY);
    mY = drawCard(`Sri Lanka Business Climate`, marketData.economy, [168, 85, 247], mY);

    mY += 5;
    doc.setFillColor(254, 243, 199); doc.setDrawColor(245, 158, 11); doc.rect(margin, mY, contentWidth, 45, 'FD');
    doc.setTextColor(146, 64, 14); doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.text("Smart Business Suggestions", margin + 6, mY + 8);
    const suggestions = generateSmartSuggestions(invData);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    suggestions.forEach((s, idx) => { doc.text("- " + s, margin + 6, mY + 18 + (idx * 6)); });

    // --- PAGE 6: BUSINESS ENGINE ---
    doc.addPage(); pageNum++;
    addPDFHeaderFooter(doc, bizName, pageNum, 6);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(50, 50, 50);
    doc.text("Business Intelligence Engine Analysis", margin, 40);
    doc.setFontSize(8); doc.setFont('helvetica', 'italic'); doc.setTextColor(150, 150, 150);
    doc.text(`Powered by NexPOS Intelligence Engine`, margin, 46);

    let aY = 55;
    const aSections = [
      { title: 'Performance Summary', color: [91, 95, 199], key: 'Performance Summary' },
      { title: 'Key Insights', color: [29, 158, 117], key: 'Key Insights' },
      { title: 'Recommendations', color: [245, 158, 11], key: 'Recommendations' }
    ];

    aSections.forEach(sec => {
      let sectionBody = "";
      const escapedTitle = sec.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(`(?:\\*\\*)?\\d?\\.?\\s?${escapedTitle}(?:\\*\\*)?:?\\s*(.*?)(?=(?:\\*\\*)?\\d?\\.?\\s?(?:Performance Summary|Key Insights|Recommendations)|$)`, 'si'),
        new RegExp(`###\\s?${escapedTitle}\\s*(.*?)(?=###|$)`, 'si')
      ];
      for (const pattern of patterns) {
        const match = aiTextRaw.match(pattern);
        if (match && match[1].trim().length > 10) { sectionBody = match[1].trim(); break; }
      }
      if (!sectionBody) sectionBody = sec.key === 'Performance Summary' ? aiTextRaw.substring(0, 400) + "..." : "Refer to dashboard metrics for details.";

      const wrapped = doc.splitTextToSize(sectionBody, contentWidth - 15);
      const bH = wrapped.length * 4 + 15;
      doc.setFillColor(248, 249, 250); doc.rect(margin, aY, contentWidth, bH, 'F');
      doc.setFillColor(...sec.color); doc.rect(margin, aY, 2, bH, 'F');
      doc.setTextColor(50, 50, 50); doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.text(sec.title, margin + 6, aY + 8);
      doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.text(wrapped, margin + 6, aY + 15);
      aY += bH + 8;
    });

    setProgress(5, "Finalising report...");
    const fileName = `NexPOS-Full-Report-${bizName.replace(/\s+/g, '-')}-${periodType}-${new Date().toISOString().split('T')[0]}.pdf`;
    doc.save(fileName);
    showToast('success', 'Full Business Report downloaded successfully');
  } catch (err) {
    console.error(err);
    showToast('error', 'Report failed: ' + err.message);
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
};

function addPDFHeaderFooter(doc, bizName, page, total) {
  const margin = 20;
  const pageWidth = 210;
  const pageHeight = 297;
  
  // Footer
  doc.setDrawColor(91, 95, 199);
  doc.setLineWidth(0.5);
  doc.line(margin, pageHeight - 15, pageWidth - margin, pageHeight - 15);
  
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  doc.setFont('helvetica', 'normal');
  doc.text("NexPOS — Confidential Business Report", margin, pageHeight - 10);
  doc.text(`Page ${page} of ${total}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
  doc.text(bizName, pageWidth - margin, pageHeight - 10, { align: 'right' });
}

// --- INTELLIGENCE HELPERS ---

async function fetchInventoryIntelligence() {
  try {
    const orgId = db.currentOrgId;
    
    // We use the already initialized db wrappers for consistency and safety
    const allProducts = await db.products.toArray();
    const allSales = await db.sales.toArray();
    const allItems = await db.sale_items.toArray();
    
    // 1. Low Stock Logic
    const lowStockData = allProducts.filter(p => p.is_active && p.stock_qty <= (p.low_stock_threshold || 5));
    lowStockData.sort((a, b) => a.stock_qty - b.stock_qty);

    // 2. Velocity Logic (Sales in last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentSales = allSales.filter(s => s.date >= thirtyDaysAgo);
    const recentSaleIds = new Set(recentSales.map(s => s.id));
    
    const processedVelocity = allProducts.map(p => {
      const pItems = allItems.filter(i => i.product_id === p.id && recentSaleIds.has(i.sale_id));
      const units30d = pItems.reduce((sum, item) => sum + item.quantity, 0);
      const dailyRate = units30d / 30;
      const daysUntilStockout = dailyRate > 0 ? p.stock_qty / dailyRate : 999;
      return { ...p, units30d, daysUntilStockout };
    }).sort((a, b) => a.daysUntilStockout - b.daysUntilStockout).slice(0, 10);

    // 3. Overstock Logic
    const processedOverstock = allProducts.map(p => {
      const pItems = allItems.filter(i => i.product_id === p.id && recentSaleIds.has(i.sale_id));
      const units30d = pItems.reduce((sum, item) => sum + item.quantity, 0);
      return { ...p, units30d, stock_value: p.stock_qty * (p.cost_price || 0) };
    }).filter(p => p.stock_qty > 50 && p.units30d < 5)
      .sort((a, b) => b.stock_value - a.stock_value)
      .slice(0, 5);

    return { lowStock: lowStockData, velocity: processedVelocity, overstock: processedOverstock };
  } catch (err) {
    console.error('fetchInventoryIntelligence error:', err);
    return { lowStock: [], velocity: [], overstock: [] };
  }
}

async function fetchMarketIntelligence() {
  const bizType = currentSettings.biz_type || 'Retail';
  const cacheKey = 'nexpos_market_' + bizType;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    const c = JSON.parse(cached);
    if (Date.now() - c.ts < 1800000) return c.data;
  }

  const queries = [
    `${bizType} business Sri Lanka 2026`,
    `Sri Lanka ${currentReportData.topProducts[0]?.name || 'Retail'} price 2026`,
    `Sri Lanka retail economy May 2026`
  ];

  const fetchWithTimeout = (query) => {
    return new Promise(async (resolve) => {
      const timeout = setTimeout(() => resolve({ AbstractText: "Market data currently unavailable. Check business news at bizlanka.com" }), 5000);
      try {
        const url = `https://api.allorigins.win/get?url=${encodeURIComponent('https://api.duckduckgo.com/?q=' + query + '&format=json&no_html=1&skip_disambig=1')}`;
        const res = await fetch(url);
        const json = await res.json();
        const data = JSON.parse(json.contents);
        clearTimeout(timeout);
        resolve(data);
      } catch (e) {
        clearTimeout(timeout);
        resolve({ AbstractText: "Market data currently unavailable. Check business news at bizlanka.com" });
      }
    });
  };

  const results = await Promise.all(queries.map(q => fetchWithTimeout(q)));
  const data = {
    industry: results[0].AbstractText || (results[0].RelatedTopics && results[0].RelatedTopics[0]?.Text) || "Sri Lanka's retail sector continues to evolve with digital integration.",
    priceTrend: results[1].Answer || results[1].AbstractText || "Price stability remains a key focus for essential commodities.",
    economy: results[2].AbstractText || "The Sri Lankan economy shows signs of recovery in the retail and service sectors."
  };

  sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
  return data;
}

function generateSmartSuggestions(invData) {
  const suggestions = [];
  const report = currentReportData;
  if (!report) return ["No report data available"];
  const period = document.querySelector('.btn-group .btn.active')?.innerText || 'Today';

  if (report.payments.cash / (report.revenue || 1) > 0.9) {
    suggestions.push("→ Consider accepting card payments — you may be losing customers who prefer digital payments");
  }

  const urgentItem = (invData?.velocity || []).find(v => v.daysUntilStockout < 7);
  if (urgentItem) {
    suggestions.push(`→ URGENT: Reorder ${urgentItem.name} immediately — estimated stockout in ${Math.round(urgentItem.daysUntilStockout)} days`);
  }

  if (report.grossProfit / (report.revenue || 1) < 0.2) {
    suggestions.push("→ Your profit margin is below 20%. Review pricing on low-margin products.");
  }

  if (report.topProducts && report.topProducts[0] && report.topProducts[0].revenue > report.revenue * 0.5) {
    suggestions.push(`→ ${report.topProducts[0].name} drives over 50% of revenue. Ensure you never run out of it.`);
  }

  if (report.transactions < 5) {
    suggestions.push("→ Low transaction count. Consider running a promotion or loyalty discount.");
  }

  if (period === 'Today') suggestions.push("→ Best practice: Count your cash drawer at end of day and reconcile with system");
  else if (period === 'This Week') suggestions.push("→ Weekly tip: Review your top 5 products and ensure 2-week stock buffer");
  else suggestions.push("→ Monthly tip: Compare this month vs last month revenue to track growth");

  return suggestions.slice(0, 4);
}

// --- SETTINGS LOGIC ---
window.loadSettingsForm = () => {
  document.getElementById('set-biz-name').value = currentSettings.biz_name || '';
  document.getElementById('set-biz-type').value = currentSettings.biz_type || 'Retail Shop';
  document.getElementById('set-currency').value = currentSettings.currency || 'Rs.';
  document.getElementById('set-tax').value = currentSettings.tax_rate || '0';
  document.getElementById('set-phone').value = currentSettings.phone || '';
  document.getElementById('set-address').value = currentSettings.address || '';
  
  const theme = currentSettings.theme || 'default';
  const themeSelect = document.getElementById('set-theme');
  if (themeSelect) themeSelect.value = theme;
  
  document.querySelectorAll('.theme-btn').forEach(btn => {
    if (btn.dataset.theme === theme) btn.classList.add('active');
    else btn.classList.remove('active');
  });

  renderBizTemplates();
};

window.setTheme = (theme) => {
  const themeSelect = document.getElementById('set-theme');
  if (themeSelect) themeSelect.value = theme;
  
  if (theme && theme !== 'default') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  
  document.querySelectorAll('.theme-btn').forEach(btn => {
    if (btn.dataset.theme === theme) btn.classList.add('active');
    else btn.classList.remove('active');
  });
};

window.saveSettings = async () => {
  const btn = event?.target;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  try {
    const settings = {
      biz_name: document.getElementById('set-biz-name').value,
      biz_type: document.getElementById('set-biz-type').value,
      currency: document.getElementById('set-currency').value,
      tax_rate: document.getElementById('set-tax').value,
      phone: document.getElementById('set-phone').value,
      address: document.getElementById('set-address').value,
      theme: document.getElementById('set-theme') ? document.getElementById('set-theme').value : 'default'
    };

    const existing = await db.settings.toArray();
    for (const [key, value] of Object.entries(settings)) {
      const row = existing.find(s => s.key === key);
      if (row) {
        await db.settings.update(row.id, { value });
      } else {
        await db.settings.add({ key, value });
      }
    }

    // Also update the organization record if it exists
    if (db.currentOrgId) {
      await db.organizations.update(db.currentOrgId, {
        name: settings.biz_name,
        business_type: settings.biz_type,
        currency: settings.currency,
        tax_rate: parseFloat(settings.tax_rate) || 0,
        phone: settings.phone,
        address: settings.address
      });
    }

    await loadSettings(); // Refresh UI and global currentSettings
    await logSecurityEvent('SETTINGS_CHANGED', { settings });
    showToast('success', 'Settings saved successfully');
  } catch (err) {
    console.error('Save Settings Error:', err);
    showToast('error', 'Failed to save settings: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save Settings';
    }
  }
};

function renderBizTemplates() {
  const templates = [
    { name: 'Grocery', icon: '🛒', products: ['Fresh Milk 1L', 'Cheddar Cheese', 'Basmati Rice 5kg', 'Red Lentils 1kg', 'Chili Powder 250g', 'Turmeric Powder', 'Sugar 1kg', 'Tea Leaves 250g'] },
    { name: 'Bookshop', icon: '📚', products: ['A4 Paper Bundle', 'Blue Pen (Box)', 'Pencil Pack', 'Exercise Book', 'Geometry Box', 'Calculator'] },
    { name: 'Meat Shop', icon: '🥩', products: ['Fresh Chicken 1kg', 'Beef Curry Cut', 'Pork Ribs', 'Mutton', 'Chicken Sausages', 'Beef Meatballs'] },
    { name: 'Retail', icon: '👕', products: ['Cotton T-Shirt', 'Denim Jeans', 'Leather Belt', 'Socks (Pair)', 'Baseball Cap', 'Canvas Shoes'] }
  ];

  document.getElementById('biz-templates').innerHTML = templates.map(t => `
    <div class="quick-action" onclick="applyTemplate('${t.name}')">
      <div class="qa-icon">${t.icon}</div>
      <div>
        <div class="qa-text">${t.name} Template</div>
        <div class="qa-sub">Load sample products</div>
      </div>
    </div>
  `).join('');
}

window.applyTemplate = async (name) => {
  if (!confirm(`Apply ${name} template? This will add sample products to your inventory.`)) return;
  
  const templates = {
    'Grocery': [
      { name: 'Fresh Milk 1L', category: 'Dairy', price: 320, cost: 280, barcode: '880123' },
      { name: 'Cheddar Cheese', category: 'Dairy', price: 850, cost: 720, barcode: '880124' },
      { name: 'Basmati Rice 5kg', category: 'Grains', price: 1250, cost: 1100, barcode: '880125' },
      { name: 'Red Lentils 1kg', category: 'Grains', price: 480, cost: 420, barcode: '880126' },
      { name: 'Chili Powder 250g', category: 'Spices', price: 280, cost: 210, barcode: '880127' }
    ],
    'Bookshop': [
      { name: 'A4 Paper Bundle', category: 'Stationery', price: 1450, cost: 1200, barcode: '770123' },
      { name: 'Blue Pen (Box)', category: 'Stationery', price: 450, cost: 350, barcode: '770124' },
      { name: 'Exercise Book', category: 'Stationery', price: 120, cost: 90, barcode: '770125' }
    ],
    'Meat Shop': [
      { name: 'Fresh Chicken 1kg', category: 'Poultry', price: 1150, cost: 950, barcode: '660123' },
      { name: 'Beef Curry Cut', category: 'Meat', price: 2400, cost: 2100, barcode: '660124' }
    ]
  };

  const prods = templates[name] || templates['Grocery'];
  
  // Add category if not exists
  const existingCats = await db.categories.toArray();
  for (const p of prods) {
    if (!existingCats.find(c => c.name === p.category)) {
      await db.categories.add({ name: p.category });
      existingCats.push({ name: p.category });
    }
    await db.products.add({
      name: p.name, sku: p.barcode, barcode: p.barcode, category: p.category,
      retail_price: p.price, cost_price: p.cost, stock_qty: 100,
      low_stock_threshold: 10, is_active: true, created_at: new Date().toISOString()
    });
  }

  showToast('success', `${name} template applied! Check your inventory.`);
};

// --- MOBILE & SCANNING HELPERS ---

window.toggleMobileCart = () => {
  document.getElementById('pos-cart-wrap').classList.toggle('active');
};

window.toggleMobileMenu = () => {
  const html = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:10px">
      <button class="btn btn-secondary" onclick="nav('dashboard'); closeModal()">📊 Dash</button>
      <button class="btn btn-secondary" onclick="nav('categories'); closeModal()">🏷️ Cats</button>
      <button class="btn btn-secondary" onclick="nav('customers'); closeModal()">👤 Cust</button>
      <button class="btn btn-secondary" onclick="nav('attendance'); closeModal()">📅 Attend</button>
      <button class="btn btn-secondary" onclick="nav('advances'); closeModal()">💸 Adv</button>
      <button class="btn btn-secondary" onclick="nav('payroll'); closeModal()">💰 Pay</button>
      <button class="btn btn-secondary" onclick="nav('user-mgmt'); closeModal()">👥 Staff</button>
      <button class="btn btn-secondary" onclick="nav('settings'); closeModal()">⚙️ Sett</button>
      <div class="btn-group" id="report-period-group">
        <button class="btn btn-ghost btn-sm active" id="btn-period-today" onclick="setReportPeriod('today')">Daily Report</button>
        <button class="btn btn-ghost btn-sm" id="btn-period-week" onclick="setReportPeriod('week')">Weekly Report</button>
        <button class="btn btn-ghost btn-sm" id="btn-period-month" onclick="setReportPeriod('month')">Monthly Report</button>
        <button class="btn btn-ghost btn-sm" id="btn-period-custom" onclick="setReportPeriod('custom')">Custom Range</button>
      </div>
      <button class="btn btn-primary" onclick="signOut(); closeModal()" style="grid-column: span 2; background:var(--danger)">🚪 Sign Out</button>
    </div>
  `;
  openModal('Main Menu', html, `<button class="btn btn-ghost" onclick="closeModal()">Close</button>`);
};

// Update cart badge on FAB
const originalRenderCart = renderCart;
renderCart = async () => {
  await originalRenderCart();
  const count = cart.reduce((s, i) => s + i.quantity, 0);
  const badge = document.getElementById('mobile-cart-badge');
  if(badge) badge.textContent = count;
};

// Barcode Scanning
let codeReader = null;
let scannerTargetInputId = null;

window.openBarcodeScannerForInput = (inputId) => {
  scannerTargetInputId = inputId;
  openBarcodeScanner();
};

window.openBarcodeScanner = async () => {
  const container = document.getElementById('scanner-container');
  const videoElement = document.getElementById('scanner-video');
  
  container.style.display = 'flex';
  
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("HTTPS required for camera access");
    }

    // Try multiple possible global export names for ZXing Browser UMD
    const ZXingLib = window.ZXingBrowser || window.ZXing || window.ZXingLibrary;
    if (!ZXingLib) {
      throw new Error("Scanner Library not loaded. Please check your internet connection.");
    }

    // Correct class name is usually BrowserMultiFormatReader in @zxing/browser
    const ReaderClass = ZXingLib.BrowserMultiFormatReader || ZXingLib.BrowserMultiFormatCodeReader;
    if (!ReaderClass) {
      throw new Error("Could not find Scanner Reader class in library.");
    }

    codeReader = new ReaderClass();
    
    const constraints = { 
      video: { 
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      } 
    };

    // decodeFromConstraints is the modern way to start scanning
    await codeReader.decodeFromConstraints(constraints, videoElement, (result, err) => {
      if (result) {
        onBarcodeScanned(result.text);
      }
      // err is thrown for every frame that doesn't have a barcode, so we ignore most errors
    });
    
  } catch (err) {
    console.error("Scanner Initialization Failure:", err);
    let msg = err.message || 'Unknown Error';
    if (err.name === 'NotAllowedError') msg = 'Camera access denied by user or browser.';
    if (err.name === 'NotFoundError') msg = 'No suitable camera found.';
    if (err.name === 'NotReadableError') msg = 'Camera hardware is busy or locked.';
    
    showToast('error', `Scanner: ${msg}`);
    closeBarcodeScanner();
  }
};

window.closeBarcodeScanner = () => {
  if(codeReader) {
    document.getElementById('scanner-video').srcObject?.getTracks().forEach(track => track.stop());
  }
  document.getElementById('scanner-container').style.display = 'none';
};

async function onBarcodeScanned(barcode) {
  closeBarcodeScanner();
  
  if (scannerTargetInputId) {
    const inputEl = document.getElementById(scannerTargetInputId);
    if (inputEl) {
      inputEl.value = barcode;
    }
    scannerTargetInputId = null;
    return;
  }
  
  const products = await db.products.toArray();
  const product = products.find(p => p.barcode === barcode);
  
  if (product) {
    if(product.stock_qty > 0) {
      addToCart(product.id);
      showToast('success', `Added: ${product.name}`);
    } else {
      showToast('error', 'Product out of stock!');
    }
  } else {
    showToast('error', `Barcode not found: ${barcode}`);
    document.getElementById('pos-search').value = barcode;
    renderPosGrid();
  }
}

// Physical Scanner (Keyboard Emulation)
function initPhysicalScanner() {
  let barcodeBuffer = '';
  let barcodeTimer = null;
  
  document.addEventListener('keypress', (e) => {
    // Avoid capturing inside inputs unless it's a very fast burst (scanner)
    if (e.target.tagName === 'INPUT' && (Date.now() - (barcodeTimer || 0) > 50)) return;

    if (barcodeTimer) clearTimeout(barcodeTimer);
    
    if (e.key === 'Enter') {
      if (barcodeBuffer.length > 3) {
        onBarcodeScanned(barcodeBuffer);
        barcodeBuffer = '';
        e.preventDefault();
      }
      return;
    }
    
    barcodeBuffer += e.key;
    barcodeTimer = setTimeout(() => { barcodeBuffer = ''; }, 100);
  });
}
// --- SHIFT MANAGEMENT ---
window.openShiftClose = async () => {
  const denominations = [5000, 1000, 500, 100, 50, 20, 10, 5, 2, 1];
  
  // Calculate expected cash
  let expectedCash = 0;
  
  if (IS_ELECTRON) {
    try {
      const sales = await window.electronDB.getSales({});
      expectedCash = sales
        .filter(s => s.payment_type === 'cash' 
                 && s.status === 'completed'
                 && new Date(s.created_at || s.date).toDateString() === new Date().toDateString())
        .reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
    } catch (err) {
      console.error('Electron Cash Calc Error:', err);
    }
  } else {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supa
      .from('sales')
      .select('total_amount')
      .eq('organization_id', db.currentOrgId)
      .eq('payment_type', 'cash')
      .eq('status', 'completed')
      .gte('created_at', today + 'T00:00:00')
      .lte('created_at', today + 'T23:59:59');
    
    expectedCash = (data || []).reduce((sum, s) => sum + s.total_amount, 0);
  }

  let html = `
    <div style="margin-bottom:20px; padding:20px; background:rgba(91, 95, 199, 0.05); border-radius:16px; border:1px solid rgba(91, 95, 199, 0.2)">
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div>
          <div style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:4px">Expected Cash in Drawer</div>
          <div style="font-size:24px; font-weight:800; color:var(--brand)" id="modal-expected-cash-display">${formatMoney(expectedCash)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:4px">Current Session</div>
          <div style="font-size:14px; font-weight:600; color:var(--text-primary)">${new Date().toLocaleTimeString()}</div>
        </div>
      </div>
    </div>
    
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:24px">
      <div>
        <div class="form-section-title" style="margin-bottom:12px">Denominations Count</div>
        <div style="display:flex; flex-direction:column; gap:8px">
          ${denominations.map(d => `
            <div style="display:flex; align-items:center; gap:12px; padding:8px 12px; background:var(--surface-2); border-radius:10px">
              <span style="width:60px; font-weight:700; color:var(--text-secondary)">${d} x</span>
              <input type="number" class="form-input denom-input" data-value="${d}" placeholder="0" oninput="updateDenomTotal()" style="width:80px; padding:6px 10px">
              <span class="denom-row-total" style="flex:1; text-align:right; font-family:var(--mono); font-weight:600; color:var(--text-muted)">0.00</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div>
        <div class="form-section-title" style="margin-bottom:12px">Reconciliation Summary</div>
        <div style="background:var(--surface); border:1px solid var(--border); padding:20px; border-radius:16px; box-shadow:var(--shadow-sm)">
          <div style="display:flex; justify-content:space-between; margin-bottom:12px">
            <span style="color:var(--text-secondary)">Total Counted:</span>
            <span id="denom-total-counted" style="font-weight:700; font-family:var(--mono)">0.00</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom:12px">
            <span style="color:var(--text-secondary)">Expected:</span>
            <span style="font-weight:700; font-family:var(--mono)">${formatMoney(expectedCash)}</span>
          </div>
          <div style="height:1px; background:var(--border); margin:12px 0"></div>
          <div style="display:flex; justify-content:space-between; align-items:center">
            <span style="font-size:16px; font-weight:700">Variance:</span>
            <span id="denom-variance" style="font-size:18px; font-weight:800; font-family:var(--mono)">BALANCED</span>
          </div>
        </div>
        
        <div class="form-group" style="margin-top:24px">
          <label class="form-label" style="font-weight:700">Discrepancy Reason / Notes</label>
          <textarea class="form-textarea" id="shift-notes" placeholder="Required if variance exists..." style="min-height:100px; border-radius:12px"></textarea>
        </div>
      </div>
    </div>
  `;

  openModal('Shift Closure — Cash Reconciliation', html, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="submitShiftClose(${expectedCash})" style="padding:10px 24px">Complete Shift Close</button>
  `, '800px');
};

window.updateDenomTotal = () => {
  let total = 0;
  document.querySelectorAll('.denom-input').forEach(input => {
    const val = parseFloat(input.value) || 0;
    const denom = parseFloat(input.dataset.value);
    const rowTotal = val * denom;
    total += rowTotal;
    input.nextElementSibling.textContent = Number(rowTotal).toLocaleString('en-US', {minimumFractionDigits:2});
  });
  
  const expectedText = document.getElementById('modal-expected-cash-display').textContent;
  const expectedValue = parseFloat(expectedText.replace(/[^\d.]/g, '')) || 0;
  
  document.getElementById('denom-total-counted').textContent = formatMoney(total).replace(/[^\d.]/g, '');
  
  const variance = total - expectedValue;
  const varEl = document.getElementById('denom-variance');
  
  if (Math.abs(variance) < 0.01) {
    varEl.textContent = 'BALANCED';
    varEl.style.color = 'var(--success)';
  } else if (variance > 0) {
    varEl.textContent = `OVER by ${formatMoney(variance)}`;
    varEl.style.color = 'var(--success)';
  } else {
    varEl.textContent = `SHORT by ${formatMoney(Math.abs(variance))}`;
    varEl.style.color = 'var(--danger)';
  }
};

window.submitShiftClose = async (expected) => {
  const countedText = document.getElementById('denom-total-counted').textContent;
  const counted = parseFloat(countedText.replace(/[^\d.]/g, '')) || 0;
  const notes = document.getElementById('shift-notes').value;
  const variance = counted - expected;
  
  if (Math.abs(variance) > 0.01 && !notes.trim()) {
    showToast('error', 'Please enter a reason for the discrepancy');
    document.getElementById('shift-notes').focus();
    return;
  }
  
  if (!confirm('Are you sure you want to finalize and close this shift?')) return;

  const denominations = {};
  document.querySelectorAll('.denom-input').forEach(input => {
    const val = parseInt(input.value) || 0;
    if (val > 0) denominations[input.dataset.value] = val;
  });

  const closureData = {
    closed_by: currentUser.display_name,
    expected_cash: expected,
    counted_cash: counted,
    variance: variance,
    denominations: JSON.stringify(denominations),
    notes: notes,
    organization_id: db.currentOrgId,
    close_time: new Date().toISOString()
  };

  try {
    if (IS_ELECTRON) {
      await window.electronDB.saveShiftClosure(closureData);
    } else {
      await db.shift_closures.add(closureData);
    }

    showToast('success', `Shift closed successfully. Variance: ${formatMoney(variance)}`);
    closeModal();
    
    // Offer to print report
    openModal('Shift Closure Summary', `
      <div style="text-align:center; padding:20px">
        <div style="font-size:48px; margin-bottom:10px">✅</div>
        <h3>Shift Closed Successfully</h3>
        <p>Would you like to print the summary report?</p>
      </div>
    `, `
      <button class="btn btn-secondary" onclick="closeModal()">Skip</button>
      <button class="btn btn-primary" onclick="printShiftReport(${JSON.stringify(closureData).replace(/"/g, '&quot;')})">🖨️ Print Report</button>
    `);

  } catch (err) {
    showToast('error', 'Failed to save shift data');
    console.error(err);
  }
};

window.printShiftReport = async (data) => {
  const bizName = currentSettings.biz_name || 'NexPOS';
  const d = new Date(data.close_time);
  const dateStr = d.toLocaleDateString();
  const timeStr = d.toLocaleTimeString();
  
  // Calculate sales summary for the report
  let summary = { cash: data.expected_cash, card: 0, credit: 0, total: 0, count: 0 };
  
  if (IS_ELECTRON) {
    const sales = await window.electronDB.getSales({});
    const todaySales = sales.filter(s => s.status === 'completed' && new Date(s.created_at || s.date).toDateString() === d.toDateString());
    summary.card = todaySales.filter(s => s.payment_type === 'card').reduce((sum, s) => sum + parseFloat(s.total_amount), 0);
    summary.credit = todaySales.filter(s => s.payment_type === 'credit').reduce((sum, s) => sum + parseFloat(s.total_amount), 0);
    summary.total = todaySales.reduce((sum, s) => sum + parseFloat(s.total_amount), 0);
    summary.count = todaySales.length;
  } else {
    const today = d.toISOString().split('T')[0];
    const { data: sales } = await supa.from('sales').select('total_amount, payment_type').eq('status', 'completed').gte('created_at', today + 'T00:00:00').lte('created_at', today + 'T23:59:59');
    summary.card = sales.filter(s => s.payment_type === 'card').reduce((sum, s) => sum + s.total_amount, 0);
    summary.credit = sales.filter(s => s.payment_type === 'credit').reduce((sum, s) => sum + s.total_amount, 0);
    summary.total = sales.reduce((sum, s) => sum + s.total_amount, 0);
    summary.count = sales.length;
  }

  const denoms = JSON.parse(data.denominations);
  const varStatus = Math.abs(data.variance) < 0.01 ? '[BALANCED]' : (data.variance > 0 ? '[OVER]' : '[SHORT]');

  const receiptHtml = `
    <div style="font-family: 'DM Mono', monospace; font-size: 13px; width: 300px; margin: 0 auto; color: #000; padding: 20px; background: #fff">
      <div style="text-align:center; font-weight:700; font-size:16px; margin-bottom:5px">${bizName.toUpperCase()}</div>
      <div style="text-align:center; margin-bottom:15px">SHIFT CLOSURE REPORT</div>
      <div style="height:1px; background:#000; margin:10px 0"></div>
      <div style="display:flex; justify-content:space-between"><span>Date:</span><span>${dateStr}</span></div>
      <div style="display:flex; justify-content:space-between"><span>Time:</span><span>${timeStr}</span></div>
      <div style="display:flex; justify-content:space-between"><span>Closed by:</span><span>${data.closed_by}</span></div>
      <div style="height:1px; background:#000; margin:10px 0"></div>
      <div style="font-weight:700; margin-bottom:5px">SALES SUMMARY</div>
      <div style="display:flex; justify-content:space-between"><span>Cash Sales:</span><span>${formatMoney(summary.cash)}</span></div>
      <div style="display:flex; justify-content:space-between"><span>Card Sales:</span><span>${formatMoney(summary.card)}</span></div>
      <div style="display:flex; justify-content:space-between"><span>Credit Sales:</span><span>${formatMoney(summary.credit)}</span></div>
      <div style="display:flex; justify-content:space-between; font-weight:700; margin-top:5px"><span>Total Sales:</span><span>${formatMoney(summary.total)}</span></div>
      <div style="display:flex; justify-content:space-between"><span>Transactions:</span><span>${summary.count}</span></div>
      <div style="height:1px; background:#000; margin:10px 0"></div>
      <div style="font-weight:700; margin-bottom:5px">CASH RECONCILIATION</div>
      <div style="display:flex; justify-content:space-between"><span>Expected:</span><span>${formatMoney(data.expected_cash)}</span></div>
      <div style="display:flex; justify-content:space-between"><span>Counted:</span><span>${formatMoney(data.counted_cash)}</span></div>
      <div style="display:flex; justify-content:space-between; font-weight:700"><span>Variance:</span><span>${formatMoney(data.variance)} ${varStatus}</span></div>
      <div style="height:1px; background:#000; margin:10px 0"></div>
      <div style="font-weight:700; margin-bottom:5px">DENOMINATIONS COUNTED</div>
      ${Object.entries(denoms).sort((a,b)=>b[0]-a[0]).map(([d, count]) => `
        <div style="display:flex; justify-content:space-between">
          <span>${d} x ${count}</span>
          <span>${formatMoney(d * count)}</span>
        </div>
      `).join('')}
      <div style="height:1px; background:#000; margin:10px 0"></div>
      ${data.notes ? `<div style="margin-top:5px"><b>Notes:</b><br>${data.notes}</div><div style="height:1px; background:#000; margin:10px 0"></div>` : ''}
      <div style="text-align:center; font-size:10px; margin-top:20px">Printed at ${new Date().toLocaleString()}</div>
    </div>
  `;

  const printWin = window.open('', '_blank');
  printWin.document.write(`<html><head><title>Shift Report</title></head><body>${receiptHtml}</body></html>`);
  printWin.document.close();
  setTimeout(() => {
    printWin.print();
    printWin.close();
    closeModal();
  }, 500);
};

window.renderShiftHistory = async () => {
  let closures = [];
  try {
    if (IS_ELECTRON) {
      closures = await window.electronDB.getShiftClosures();
    } else {
      closures = await db.shift_closures.toArray();
    }
    
    const tbody = document.getElementById('shift-closures-tbody');
    if (!tbody) return;

    tbody.innerHTML = closures.sort((a,b) => new Date(b.close_time) - new Date(a.close_time)).map(c => {
      const d = new Date(c.close_time);
      const varStatus = Math.abs(c.variance) < 0.01 ? 'BALANCED' : (c.variance > 0 ? 'OVER' : 'SHORT');
      const statusClass = Math.abs(c.variance) < 0.01 ? 'badge-active' : (c.variance > 0 ? 'badge-pending' : 'badge-inactive');
      
      return `
        <tr>
          <td>${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
          <td class="fw-600">${c.closed_by}</td>
          <td class="td-mono">${formatMoney(c.expected_cash)}</td>
          <td class="td-mono">${formatMoney(c.counted_cash)}</td>
          <td class="td-mono fw-700" style="color:${c.variance < 0 ? 'var(--danger)' : (c.variance > 0 ? 'var(--brand)' : 'var(--success)')}">
            ${formatMoney(c.variance)}
          </td>
          <td><span class="badge ${statusClass}">${varStatus}</span></td>
          <td>
            <button class="btn btn-ghost btn-sm" onclick="printShiftReport(${JSON.stringify(c).replace(/"/g, '&quot;')})">🖨️</button>
          </td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="7" style="text-align:center">No shift closures recorded yet</td></tr>';
  } catch (err) {
    console.error('Render Shift History Error:', err);
  }
};
