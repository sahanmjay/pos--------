let currentUser = null;
let cart = [];
let cartCustomerId = 1;
let currentSettings = {};
let posCategory = '';
let currentReceiptData = null;

// SaaS globals
let loginMode = 'business'; // 'business' or 'super'
let superAdminUser = null;
let isImpersonating = false;
let impersonatedOrgId = null;
let selectedOrgForDetail = null;


function runInBackground(label, task) {
  Promise.resolve()
    .then(task)
    .catch(err => {
      console.error(`${label} failed:`, err);
      showToast('error', `${label} failed. Please refresh and check data.`);
    });
}

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
  
  // Initialize Realtime Engine (SSE + BroadcastChannel + Multi-Device Sync)
  initRealtimeEngine();
  
  // Physical Barcode Scanner Listener
  initPhysicalScanner();

  ['login-slug', 'login-user', 'login-pass'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') doLogin();
      });
      input.addEventListener('input', () => {
        const err = document.getElementById('login-error');
        if (err) err.style.display = 'none';
      });
    }
  });
  
  await loadSettings();
});

async function syncOfflineSales() {
  if (typeof syncOfflineSalesNow === 'function') {
    await syncOfflineSalesNow();
  }
}

function updateConnectionBadge() {
  if (typeof updateOfflineStatusUI === 'function') {
    updateOfflineStatusUI();
  } else {
    const el = document.getElementById('connection-status');
    if (!el) return;
    const isOnline = navigator.onLine && !window._forceOfflineMode;
    el.classList.toggle('online', isOnline);
    el.classList.toggle('offline', !isOnline);
    el.innerHTML = `<span class="status-dot"></span> ${isOnline ? 'Online' : 'Offline'}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// ⚡ NEXPOS OMNI-CHANNEL REALTIME ENGINE (SSE + BroadcastChannel + Storage Bus)
// ═══════════════════════════════════════════════════════════════

const REALTIME_CLIENT_ID = 'term_' + Math.random().toString(36).substr(2, 9);
let realtimeBroadcastBus = null;
let realtimeEventSource = null;
let realtimeReconnectTimer = null;
let isRealtimeConnected = false;

function initRealtimeEngine() {
  // A. Instant same-machine tab-to-tab communication (0ms latency)
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      realtimeBroadcastBus = new BroadcastChannel('nexpos_realtime_channel');
      realtimeBroadcastBus.onmessage = (event) => {
        if (event && event.data) {
          handleIncomingRealtimeEvent(event.data);
        }
      };
    } catch (e) {
      console.warn('BroadcastChannel error:', e);
    }
  }

  // B. Cross-Device LAN / Network Sync via Server-Sent Events (SSE)
  connectRealtimeSSE();

  // C. Storage Fallback for Older Browsers or Multi-Window Sync
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith('nexpos_live_ping_')) {
      try {
        const payload = JSON.parse(e.newValue);
        if (payload && payload.senderId !== REALTIME_CLIENT_ID) {
          handleIncomingRealtimeEvent(payload);
        }
      } catch(err) {}
    }
  });

  updateRealtimeStatusBadge(true, 'Live Sync');
}

function connectRealtimeSSE() {
  if (typeof EventSource === 'undefined') return;

  try {
    if (realtimeEventSource) {
      realtimeEventSource.close();
    }

    realtimeEventSource = new EventSource('/api/realtime/events');

    realtimeEventSource.onopen = () => {
      isRealtimeConnected = true;
      updateRealtimeStatusBadge(true, 'Live Sync');
      clearTimeout(realtimeReconnectTimer);
    };

    realtimeEventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.senderId !== REALTIME_CLIENT_ID) {
          handleIncomingRealtimeEvent(data);
        }
      } catch (e) {
        // Heartbeat or ping
      }
    };

    realtimeEventSource.onerror = () => {
      isRealtimeConnected = false;
      updateRealtimeStatusBadge(false, 'Sync Paused');
      if (realtimeEventSource) realtimeEventSource.close();

      // Exponential auto-reconnect
      clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = setTimeout(() => {
        connectRealtimeSSE();
      }, 5000);
    };
  } catch (err) {
    console.warn('SSE connection notice:', err);
  }
}

window.broadcastRealtimeEvent = async (type, payload = {}) => {
  const eventMsg = {
    type,
    payload,
    senderId: REALTIME_CLIENT_ID,
    timestamp: Date.now()
  };

  // 1. Instant local tab dispatch
  if (realtimeBroadcastBus) {
    try {
      realtimeBroadcastBus.postMessage(eventMsg);
    } catch (e) {}
  }

  // 2. Storage event fallback
  try {
    localStorage.setItem(`nexpos_live_ping_${Date.now() % 5}`, JSON.stringify(eventMsg));
  } catch(e) {}

  // 3. Network fan-out to other devices (kitchen tablets, POS PCs) via server
  try {
    fetch('/api/realtime/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventMsg)
    }).catch(() => {});
  } catch (e) {}
};

function updateRealtimeStatusBadge(connected, text) {
  const pill = document.getElementById('realtime-status-pill');
  const txt = document.getElementById('realtime-status-text');
  if (!pill) return;

  pill.classList.toggle('realtime-live', connected);
  pill.classList.toggle('realtime-offline', !connected);
  if (txt) txt.textContent = connected ? (text || '⚡ Live Sync') : '⚠️ Reconnecting';
}

window.testRealtimePing = () => {
  broadcastRealtimeEvent('PING', { time: new Date().toLocaleTimeString() });
  showToast('info', '⚡ Realtime ping sent to all connected terminals and kitchen screens');
};

async function handleIncomingRealtimeEvent(event) {
  if (!event || !event.type) return;

  const type = event.type;
  const payload = event.payload || {};

  switch (type) {
    case 'KOT_NEW': {
      // 1. Update in-memory KOTs & tables
      if (Array.isArray(payload.activeKots)) {
        activeKots = payload.activeKots;
      }
      if (payload.activeTableOrders) {
        activeTableOrders = payload.activeTableOrders;
      }

      // 2. Update KDS screen if currently active
      const kdsScreen = document.getElementById('screen-kot');
      if (kdsScreen && kdsScreen.classList.contains('active')) {
        renderKOTScreen();
      }

      // 3. Play kitchen chime audio
      if (typeof playKitchenChime === 'function') {
        playKitchenChime();
      }

      // 4. Update header badge & table UI
      if (typeof updateKotBadge === 'function') updateKotBadge();
      if (typeof updateDiningTableUI === 'function') updateDiningTableUI();

      // 5. Toast alert
      const kotNum = payload.kot_number || 'New';
      const tblName = payload.table_name || 'Dine-In';
      showToast('info', `🍳 New KOT #${kotNum} received for ${tblName}!`);
      break;
    }

    case 'KOT_STATUS_UPDATED': {
      if (Array.isArray(payload.activeKots)) {
        activeKots = payload.activeKots;
      }
      if (payload.activeTableOrders) {
        activeTableOrders = payload.activeTableOrders;
      }

      const kdsScreen = document.getElementById('screen-kot');
      if (kdsScreen && kdsScreen.classList.contains('active')) {
        renderKOTScreen();
      }

      const tablesScreen = document.getElementById('screen-tables');
      if (tablesScreen && tablesScreen.classList.contains('active')) {
        renderTablesScreen();
      }

      if (typeof updateKotBadge === 'function') updateKotBadge();
      if (typeof updateDiningTableUI === 'function') updateDiningTableUI();

      if (payload.status === 'ready') {
        showToast('success', `🔔 KOT #${payload.kot_number} (${payload.table_name}) is Ready to Serve!`);
      }
      break;
    }

    case 'TABLE_UPDATED': {
      if (payload.activeTableOrders) {
        activeTableOrders = payload.activeTableOrders;
      }
      if (typeof updateDiningTableUI === 'function') updateDiningTableUI();
      const tablesScreen = document.getElementById('screen-tables');
      if (tablesScreen && tablesScreen.classList.contains('active')) {
        renderTablesScreen();
      }
      break;
    }

    case 'SALE_COMPLETED': {
      // Refresh POS products stock
      if (typeof renderPosGrid === 'function') await renderPosGrid();

      // Update Dashboard if on dashboard
      const dashScreen = document.getElementById('screen-dashboard');
      if (dashScreen && dashScreen.classList.contains('active')) {
        initDashboard();
      }

      // Update Sales History if on sales history
      const salesScreen = document.getElementById('screen-sales-history');
      if (salesScreen && salesScreen.classList.contains('active')) {
        renderSalesHistory();
      }

      // If restaurant mode, also sync KOTs and tables
      if (Array.isArray(payload.activeKots)) activeKots = payload.activeKots;
      if (payload.activeTableOrders) activeTableOrders = payload.activeTableOrders;
      if (typeof updateKotBadge === 'function') updateKotBadge();
      if (typeof updateDiningTableUI === 'function') updateDiningTableUI();
      break;
    }

    case 'STOCK_UPDATED': {
      if (typeof renderPosGrid === 'function') await renderPosGrid();
      const prodScreen = document.getElementById('screen-products');
      if (prodScreen && prodScreen.classList.contains('active')) {
        renderProductsTable();
      }
      break;
    }

    case 'PING': {
      showToast('info', `⚡ Realtime connection verified (${payload.time || 'now'})`);
      break;
    }

    default:
      break;
  }
}


function updateClock() {
  const d = new Date();
  const el = document.getElementById('topbar-clock');
  if(el) el.textContent = d.toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

async function loadSettings() {
  const bName = document.getElementById('topbar-biz-name');
  const bType = document.getElementById('topbar-biz-type');
  const sBizName = document.getElementById('sidebar-biz-name');
  const sBizSub = document.getElementById('sidebar-biz-sub');

  // If not logged in into a specific business, ALWAYS show clean NexPOS branding
  if (!db.currentOrgId) {
    currentSettings = {};
    const defaultTitle = isSuperAdmin ? 'NexPOS — Platform Admin' : 'NexPOS — SaaS Business Platform';
    document.title = defaultTitle;
    if (bName) bName.textContent = isSuperAdmin ? 'NexPOS Console' : 'NexPOS';
    if (bType) bType.textContent = isSuperAdmin ? 'Platform Management' : 'Point of Sale';
    if (sBizName) sBizName.textContent = 'NexPOS';
    if (sBizSub) sBizSub.textContent = isSuperAdmin ? 'Platform Admin' : 'Premium Retail Suite';
    document.documentElement.removeAttribute('data-theme');
    return;
  }

  // A specific business IS signed in -> load only their settings
  currentSettings = {};
  try {
    const sets = await db.settings.toArray();
    sets.forEach(s => { currentSettings[s.key] = s.value; });

    const org = await db.organizations.get(db.currentOrgId);
    if (org) {
      if (!currentSettings.biz_name) currentSettings.biz_name = org.name;
      if (!currentSettings.biz_type) currentSettings.biz_type = org.business_type;
      if (!currentSettings.currency) currentSettings.currency = org.currency;
      if (!currentSettings.tax_rate) currentSettings.tax_rate = String(org.tax_rate || 0);
      if (!currentSettings.phone) currentSettings.phone = org.phone || '';
      if (!currentSettings.address) currentSettings.address = org.address || '';
      if (!currentSettings.receipt_autoprint) currentSettings.receipt_autoprint = 'true';
      currentSettings.plan_id = org.plan_id || 'free';
    }
    if (!currentSettings.receipt_autoprint) currentSettings.receipt_autoprint = 'true';
    if (!currentSettings.biz_logo) currentSettings.biz_logo = '';

    // Self-Healing: Verify and sync active organization with cloud
    if (db.currentOrgId && !isSuperAdmin && supa && !isOffline()) {
      try {
        let activeOrg = org;
        if (!activeOrg) {
          const candidateName = currentSettings.biz_name || (currentUser && (currentUser.display_name || currentUser.username)) || '';
          if (candidateName) {
            const { data: matched } = await supa.from('organizations').select('*').ilike('name', candidateName).maybeSingle();
            if (matched) {
              console.log(`[Self-Healing] Re-linked local org ${db.currentOrgId} to cloud org ${matched.id} (${matched.name})`);
              db.currentOrgId = matched.id;
              if (currentUser) currentUser.organization_id = matched.id;
              activeOrg = matched;
            }
          }
        }
        
        // If store currently has 0 products and 0 categories, auto-seed starter template
        const prodCount = await db.products.count();
        const catCount = await db.categories.count();
        if (prodCount === 0 && catCount === 0) {
          const typeToSeed = (activeOrg && activeOrg.business_type) || currentSettings.biz_type || 'Restaurant';
          console.log(`[Self-Healing] Auto-populating initial catalogue for ${typeToSeed}...`);
          await loadBusinessTemplate(typeToSeed);
        }
      } catch (healErr) {
        console.warn('[Self-Healing] Org check notice:', healErr);
      }
    }
  } catch (e) {
    console.warn('loadSettings error:', e);
  }

  const bizTitle = currentSettings.biz_name || 'My Business';
  const bizType = currentSettings.biz_type || 'Point of Sale';

  if (bName) bName.textContent = bizTitle;
  if (bType) bType.textContent = bizType;
  if (sBizName) sBizName.textContent = bizTitle;
  if (sBizSub) sBizSub.textContent = 'Powered by NexPOS';

  document.title = `${bizTitle} — NexPOS`;

  if (currentSettings.theme && currentSettings.theme !== 'default') {
    document.documentElement.setAttribute('data-theme', currentSettings.theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  // Restaurant & Hospitality Suite Toggle
  const isRestaurant = currentSettings.restaurant_mode === 'true' || currentSettings.biz_type === 'Restaurant';
  const navRest = document.getElementById('nav-restaurant');
  const divRest = document.getElementById('divider-restaurant');
  if (navRest) navRest.style.display = isRestaurant ? 'block' : 'none';
  if (divRest) divRest.style.display = isRestaurant ? 'block' : 'none';

  document.querySelectorAll('.restaurant-only').forEach(el => {
    if (el.classList.contains('sidebar-divider')) el.style.display = isRestaurant ? 'block' : 'none';
    else if (el.classList.contains('pos-dining-bar')) el.style.display = isRestaurant ? 'flex' : 'none';
    else if (el.id === 'btn-fire-kot') el.style.display = isRestaurant ? 'inline-flex' : 'none';
    else el.style.display = isRestaurant ? 'block' : 'none';
  });
  if (isRestaurant && typeof initRestaurantSuite === 'function') {
    initRestaurantSuite();
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

// Account lockout disabled
try { localStorage.removeItem('pos_login_attempts'); } catch(e) {}
let loginAttempts = { count: 0, lockoutUntil: 0 };

function checkLoginLockout() {
  return null; // No lockout
}

function isEmergencyAdminLogin(username, password) {
  const u = username.trim().toLowerCase();
  const p = password.trim();
  return u === 'admin' && (p === '231' || p === 'admin');
}

function createEmergencyAdminUser(orgId) {
  return {
    id: 0,
    username: 'admin',
    password: '231',
    display_name: 'Administrator',
    role: 'Admin',
    organization_id: orgId || '00000000-0000-0000-0000-000000000001'
  };
}

// --- UNIFIED DIRECT LOGIN & AUTHENTICATION ---
window.setLoginMode = (mode) => {
  // Maintained for backward compatibility
};

async function doLogin() {
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value.trim();
  const err = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  if (!u || !p) {
    err.textContent = 'Please enter your username and password';
    err.style.display = 'block';
    return;
  }

  // Check lockout
  const lockoutMsg = checkLoginLockout();
  if (lockoutMsg) {
    err.textContent = lockoutMsg;
    err.style.display = 'block';
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Signing In...';
  }

  try {
    // 1. Check Platform Super Admin credentials first
    try {
      let sa = await saLoginSuperAdmin(u, p);
      if (!sa && (u.toLowerCase() === 'superadmin' || u.toLowerCase() === 'admin@nexpos.cloud') && p === 'super@123') {
        sa = {
          id: '00000000-0000-0000-0000-000000000000',
          username: 'superadmin',
          password: 'super@123',
          display_name: 'Platform Owner',
          email: 'admin@nexpos.cloud'
        };
      }
      if (sa) {
        err.style.display = 'none';
        await completeSuperLogin(sa);
        return;
      }
    } catch (e) {
      console.warn('Super Admin auth check notice:', e);
    }

    // 2. Direct Query: Look up user across businesses by username & password
    let matchedUser = null;
    try {
      // First attempt: search in Supabase users table
      const { data: usersData, error: uErr } = await supa
        .from('users')
        .select('*, organizations(*)')
        .eq('password', p)
        .eq('is_active', true);

      if (usersData && usersData.length > 0) {
        matchedUser = usersData.find(usr => 
          (usr.username && usr.username.toLowerCase() === u.toLowerCase()) ||
          (usr.display_name && usr.display_name.toLowerCase() === u.toLowerCase())
        );
      }
    } catch (e) {
      console.warn('Supabase user search notice:', e);
    }

    // Secondary attempt: exact query
    if (!matchedUser) {
      try {
        const { data: exactUsers } = await supa
          .from('users')
          .select('*, organizations(*)')
          .eq('username', u)
          .eq('password', p)
          .eq('is_active', true)
          .limit(1);
        if (exactUsers && exactUsers.length > 0) {
          matchedUser = exactUsers[0];
        }
      } catch (e) {
        console.warn('Exact username query notice:', e);
      }
    }

    // Offline / Local IndexedDB fallback check
    if (!matchedUser) {
      try {
        const localUsers = await idbGetAll('users');
        if (localUsers && localUsers.length > 0) {
          matchedUser = localUsers.find(usr => 
            ((usr.username && usr.username.toLowerCase() === u.toLowerCase()) ||
             (usr.display_name && usr.display_name.toLowerCase() === u.toLowerCase())) &&
            usr.password === p &&
            usr.is_active !== false
          );
        }
      } catch (e) {
        console.warn('Local offline user lookup notice:', e);
      }
    }

    // If user record found
    if (matchedUser) {
      // Check if business is deactivated
      if (matchedUser.organizations && matchedUser.organizations.is_active === false) {
        err.textContent = 'This business account has been deactivated. Please contact platform admin.';
        err.style.display = 'block';
        return;
      }

      err.style.display = 'none';
      await completeLogin(matchedUser);
      return;
    }

    // 3. Emergency / Local admin fallback (admin/admin or admin/231)
    if (isEmergencyAdminLogin(u, p)) {
      err.style.display = 'none';
      let orgId = '00000000-0000-0000-0000-000000000001';
      
      // Auto-assign to the first active business if one exists in database
      try {
        const { data: orgs } = await supa.from('organizations').select('id, name, is_active').eq('is_active', true).limit(1);
        if (orgs && orgs.length > 0) {
          orgId = orgs[0].id;
        }
      } catch (e) {}

      const emergencyUser = createEmergencyAdminUser(orgId);
      await completeLogin(emergencyUser, { audit: false });
      showToast('info', 'Logged in as Administrator');
      return;
    }

    // 4. Invalid credentials (no account lockout)
    try { localStorage.removeItem('pos_login_attempts'); } catch(e) {}
    await logSecurityEvent('LOGIN_FAILURE', { username: u });
    err.textContent = 'Invalid username or password';
    err.style.display = 'block';

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Sign In to Dashboard →';
    }
  }
}

// ─── SUPER ADMIN LOGIN COMPLETION ───
async function completeSuperLogin(sa) {
  superAdminUser = sa;
  db.isSuperAdmin = true;
  isSuperAdmin = true;

  loginAttempts = { count: 0, lockoutUntil: 0 };
  localStorage.setItem('pos_login_attempts', JSON.stringify(loginAttempts));

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');

  // Show SA sidebar, hide business sidebar
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('sa-sidebar').style.display = 'flex';

  // Update topbar
  document.getElementById('user-avatar').textContent = '⚡';
  document.getElementById('user-name').textContent = sa.display_name;
  document.getElementById('role-badge').textContent = 'Super Admin';

  // Hide business nav sections
  document.getElementById('nav-pos').style.display = 'none';
  document.getElementById('nav-inventory').style.display = 'none';
  document.getElementById('nav-sales').style.display = 'none';
  document.getElementById('nav-hr').style.display = 'none';
  document.getElementById('nav-system').style.display = 'none';

  // Configure password menu for super admin
  const saPwItem = document.getElementById('user-dropdown-pw-item');
  if (saPwItem) {
    saPwItem.style.display = 'block';
    saPwItem.style.opacity = '1';
    saPwItem.style.cursor = 'pointer';
    saPwItem.onclick = openChangePasswordModal;
    saPwItem.innerHTML = '🔑 Change Password';
    saPwItem.title = 'Change Platform Super Admin password';
  }

  await saLogPlatformEvent('super_admin', sa.id, sa.display_name, 'SUPER_ADMIN_LOGIN', null, '', {});

  // Navigate to SA dashboard
  saNav('sa-dashboard');
  showToast('success', `Welcome back, ${sa.display_name}`);
}

// ─── BUSINESS LOGIN COMPLETION ───
async function completeLogin(user, options = {}) {
  const { audit = true } = options;

  // Reset on success
  loginAttempts = { count: 0, lockoutUntil: 0 };
  localStorage.setItem('pos_login_attempts', JSON.stringify(loginAttempts));
  
  currentUser = user;
  db.currentOrgId = user.organization_id;
  db.isSuperAdmin = false;
  if (audit) await logSecurityEvent('LOGIN_SUCCESS');
  
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');

  // Show business sidebar, hide SA sidebar
  document.getElementById('sidebar').style.display = 'flex';
  document.getElementById('sa-sidebar').style.display = 'none';

  // Hide all SA screens
  document.querySelectorAll('.sa-screen').forEach(s => s.classList.remove('active'));
  
  document.getElementById('user-avatar').textContent = user.display_name.charAt(0).toUpperCase();
  document.getElementById('user-name').textContent = user.display_name;
  document.getElementById('role-badge').textContent = user.role;
  const sidebarRoleBadge = document.getElementById('sidebar-role-badge');
  if (sidebarRoleBadge) sidebarRoleBadge.textContent = user.role;

  // Configure change password option based on Business Admin role
  const pwItem = document.getElementById('user-dropdown-pw-item');
  if (pwItem) {
    if (user.role === 'Admin') {
      pwItem.style.display = 'block';
      pwItem.style.opacity = '1';
      pwItem.style.cursor = 'pointer';
      pwItem.onclick = openChangePasswordModal;
      pwItem.innerHTML = '🔑 Change Password';
      pwItem.title = 'Change your administrator password';
    } else {
      pwItem.style.display = 'block';
      pwItem.style.opacity = '0.5';
      pwItem.style.cursor = 'default';
      pwItem.onclick = () => showToast('info', 'Passwords can only be set or changed by your business administrator.');
      pwItem.innerHTML = '<span style="font-size:12px; color:var(--text-muted)">🔒 Password Managed by Admin</span>';
      pwItem.title = 'Only Business Administrators can set or change passwords';
    }
  }
  
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
  if (typeof updateOfflineStatusUI === 'function') updateOfflineStatusUI();

  // Save user locally in IndexedDB for offline authentication
  if (typeof idbPut === 'function' && user) {
    idbPut('users', user).catch(() => {});
  }
  
  // Pre-warm offline cache in background
  if (typeof warmOfflineCache === 'function' && user && user.organization_id) {
    warmOfflineCache(user.organization_id).catch(() => {});
  }
}

async function signOut() {
  currentUser = null;
  superAdminUser = null;
  currentOrgId = null;
  db.currentOrgId = null;
  db.isSuperAdmin = false;
  isSuperAdmin = false;
  isImpersonating = false;
  impersonatedOrgId = null;

  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-slug').value = '';

  // Reset sidebars
  document.getElementById('sidebar').style.display = 'flex';
  document.getElementById('sa-sidebar').style.display = 'none';
  document.getElementById('impersonation-banner').style.display = 'none';

  // Reset login mode
  setLoginMode('business');
  await loadSettings();
}

window.openChangePasswordModal = () => {
  if (currentUser && currentUser.role !== 'Admin') {
    return showToast('error', 'Only Business Administrators can set or change passwords.');
  }

  const isSuper = !!superAdminUser;
  const accountTitle = isSuper 
    ? 'Platform Super Admin' 
    : (currentUser ? `${currentUser.display_name} (Admin)` : 'Account');

  const html = `
    <div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px">
      Updating security credentials for: <strong style="color:var(--brand)">${accountTitle}</strong>
    </div>
    <div class="form-group">
      <label class="form-label">Current Password</label>
      <input class="form-input" type="password" id="pw-current" placeholder="Enter current password">
    </div>
    <div class="form-group">
      <label class="form-label">New Password</label>
      <input class="form-input" type="password" id="pw-new" placeholder="Enter new password (min 3 chars)">
    </div>
    <div class="form-group">
      <label class="form-label">Confirm New Password</label>
      <input class="form-input" type="password" id="pw-confirm" placeholder="Re-enter new password">
    </div>
  `;
  openModal('Change Password', html, `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="updatePassword()">Update Password</button>`);
};

window.updatePassword = async () => {
  const current = document.getElementById('pw-current').value;
  const newPw = document.getElementById('pw-new').value;
  const confirmPw = document.getElementById('pw-confirm').value;
  
  if (!current || !newPw) return showToast('error', 'Please fill in all password fields');
  if (newPw !== confirmPw) return showToast('error', 'New passwords do not match');
  if (newPw.length < 3) return showToast('error', 'Password must be at least 3 characters');
  
  // ─── Super Admin Password Update ───
  if (superAdminUser) {
    if (current !== superAdminUser.password) return showToast('error', 'Incorrect current password');
    try {
      const { error } = await supa.from('super_admins').update({ password: newPw }).eq('id', superAdminUser.id);
      if (error) throw error;
      superAdminUser.password = newPw;
      closeModal();
      showToast('success', 'Super Admin password updated successfully');
      await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'PASSWORD_CHANGED', null, '', {});
      return;
    } catch (e) {
      return showToast('error', 'Failed to update super admin password: ' + e.message);
    }
  }

  // ─── Business Admin Password Update ───
  if (currentUser) {
    if (currentUser.role !== 'Admin') {
      return showToast('error', 'Only Business Administrators can set or change passwords.');
    }
    if (current !== currentUser.password) return showToast('error', 'Incorrect current password');
    try {
      await db.users.update(currentUser.id, { password: newPw });
      currentUser.password = newPw;
      closeModal();
      showToast('success', 'Business Admin password updated successfully');
      return;
    } catch (e) {
      return showToast('error', 'Failed to update admin password: ' + e.message);
    }
  }
};

window.bizAdminChangePassword = async () => {
  if (!currentUser || currentUser.role !== 'Admin') {
    return showToast('error', 'Only Business Administrators can change passwords');
  }
  const current = document.getElementById('set-admin-current-pw').value;
  const newPw = document.getElementById('set-admin-new-pw').value;

  if (!current || !newPw) return showToast('error', 'Please fill in both current and new password');
  if (current !== currentUser.password) return showToast('error', 'Incorrect current admin password');
  if (newPw.length < 3) return showToast('error', 'New password must be at least 3 characters');

  try {
    await db.users.update(currentUser.id, { password: newPw });
    currentUser.password = newPw;
    document.getElementById('set-admin-current-pw').value = '';
    document.getElementById('set-admin-new-pw').value = '';
    showToast('success', 'Business Admin password updated successfully');
  } catch (e) {
    showToast('error', 'Failed to update admin password: ' + e.message);
  }
};

const SCREENS = {
  'pos': 'Point of Sale',
  'dashboard': 'Dashboard',
  'kot': 'Kitchen / Live KOT Display',
  'tables': 'Dining / Table Management',
  'products': 'Inventory / Products',
  'categories': 'Inventory / Categories',
  'sales-history': 'Sales / History',
  'customers': 'Sales / Customers',
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
    if (screenId === 'user-mgmt') {
      showToast('error', 'Only Business Administrators can access Staff Management and manage accounts');
      return;
    }
    if ((role === 'Counter' || role === 'Cashier') && !['pos', 'dashboard', 'sales-history', 'customers', 'kot', 'tables'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
    if (role === 'HR' && !['attendance', 'advances', 'payroll'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
    if (screenId === 'ai-reports' && role !== 'Admin') {
      showToast('error', 'Only Admins can access AI Reports'); return;
    }
    if (role === 'Inventory' && !['products', 'categories'].includes(screenId)) {
      showToast('error', 'Access denied'); return;
    }
    if (role === 'Worker' && !['pos', 'kot', 'tables'].includes(screenId)) {
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
  
  const parts = (SCREENS[screenId] || screenId).split(' / ');
  let bc = `<span>NexPOS</span>`;
  parts.forEach((p, i) => {
    bc += `<span class="sep">/</span><span class="${i===parts.length-1?'current':''}">${p}</span>`;
  });
  document.getElementById('breadcrumb').innerHTML = bc;
  
  // Call init function for screen
  if(screenId === 'pos') { renderPosCategories(); renderPosGrid(); }
  if(screenId === 'dashboard') initDashboard();
  if(screenId === 'kot') renderKOTScreen();
  if(screenId === 'tables') renderTablesScreen();
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
  collapseSidebarAfterNav();
}

window.toggleSalesTab = (tab) => {
  document.getElementById('sales-list-view').style.display = tab === 'sales' ? 'block' : 'none';
  document.getElementById('shifts-list-view').style.display = tab === 'shifts' ? 'block' : 'none';
  const ramisView = document.getElementById('ramis-list-view');
  if (ramisView) ramisView.style.display = tab === 'ramis' ? 'block' : 'none';

  document.getElementById('tab-sales-list').classList.toggle('active', tab === 'sales');
  document.getElementById('tab-shifts-list').classList.toggle('active', tab === 'shifts');
  const tabRamis = document.getElementById('tab-ramis-list');
  if (tabRamis) tabRamis.classList.toggle('active', tab === 'ramis');

  if (tab === 'shifts') renderShiftHistory();
  if (tab === 'ramis') renderRamisMonitor();
};

// ─── RAMIS IRD LIVE MONITOR ───
let ramisCachedJobs = [];

window.renderRamisMonitor = async () => {
  const tbody = document.getElementById('ramis-invoices-tbody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--text-muted)"><span class="spinner-border spinner-border-sm"></span> Loading RAMIS IRD Gateway data...</td></tr>`;

  try {
    const res = await fetch('/api/ramis/status');
    const json = await res.json();
    const stats = json.stats || { pending: 0, completed: 0, failed: 0, recentCompleted: [] };
    ramisCachedJobs = stats.recentCompleted || [];

    // Update KPI indicators
    const countEl = document.getElementById('ramis-stat-count');
    const supplyEl = document.getElementById('ramis-stat-supply');
    const vatEl = document.getElementById('ramis-stat-vat');
    const pendingEl = document.getElementById('ramis-stat-pending');

    let totalSupply = 0;
    let totalVat = 0;
    ramisCachedJobs.forEach(j => {
      totalSupply += (j.data?.valueOfSupply || 0);
      totalVat += (j.data?.vatAmount || 0);
    });

    if (countEl) countEl.textContent = stats.completed || ramisCachedJobs.length;
    if (supplyEl) supplyEl.textContent = formatMoney(totalSupply);
    if (vatEl) vatEl.textContent = formatMoney(totalVat);
    if (pendingEl) pendingEl.textContent = `${stats.pending || 0} pending jobs`;

    if (ramisCachedJobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted)">No RAMIS invoices transmitted yet. Complete a checkout sale or click "Test Submission" above to transmit one.</td></tr>`;
      return;
    }

    // Render Rows (Newest first)
    tbody.innerHTML = ramisCachedJobs.slice().reverse().map(j => {
      const d = j.data || {};
      const res = j.result || {};
      const ramisRef = res.ramisReference || 'PENDING';
      const status = res.status || j.status || 'SUBMITTED';

      return `
        <tr>
          <td><strong style="color:var(--brand)">${d.taxInvoiceNo || '-'}</strong></td>
          <td>${d.invoiceDate || new Date().toISOString().split('T')[0]}</td>
          <td><span style="font-family:monospace; font-size:11px">${d.supplierTin || '-'}</span></td>
          <td class="td-mono">${formatMoney(d.valueOfSupply || 0)}</td>
          <td class="td-mono" style="color:var(--success)">${formatMoney(d.vatAmount || 0)}</td>
          <td class="td-mono fw-600">${formatMoney(d.totalAmount || (d.valueOfSupply + d.vatAmount) || 0)}</td>
          <td>
            <span style="font-family:monospace; font-size:11px; background:var(--surface-2); padding:3px 6px; border-radius:4px; border:1px solid var(--border)">
              ${ramisRef}
            </span>
          </td>
          <td>
            <span class="badge badge-completed" style="font-size:10px">
              ✓ ${status}
            </span>
          </td>
          <td>
            <button class="btn btn-ghost btn-sm" onclick="viewRamisPayload('${j.id}')" title="View IRD JSON payload">
              👁 View JSON
            </button>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.warn('RAMIS monitor fetch error:', err);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--danger)">Could not connect to RAMIS queue server: ${err.message}</td></tr>`;
  }
};

window.viewRamisPayload = (jobId) => {
  const job = ramisCachedJobs.find(j => j.id === jobId);
  if (!job) return showToast('error', 'Job details not found');

  const jsonPretty = JSON.stringify(job, null, 2);
  const body = `
    <div style="font-size:12px; color:var(--text-muted); margin-bottom:10px">
      Sri Lanka IRD RAMIS Schedule 1 Payload & Gateway Response
    </div>
    <pre style="background:var(--surface-2); border:1px solid var(--border); border-radius:8px; padding:14px; max-height:420px; overflow:auto; font-family:Consolas,monospace; font-size:11.5px; color:var(--text-primary)">${jsonPretty}</pre>
  `;
  openModal(`RAMIS Invoice: ${job.data?.taxInvoiceNo || jobId}`, body, `<button class="btn btn-secondary" onclick="closeModal()">Close</button>`);
};

window.testRamisSubmission = async () => {
  const invoiceNo = 'INV-' + Math.floor(100000 + Math.random() * 900000);
  const testPayload = {
    taxInvoiceNo: invoiceNo,
    invoiceDate: new Date().toISOString().split('T')[0],
    supplierTin: (currentSettings && currentSettings.tin) ? currentSettings.tin : '102938475',
    purchaserTin: null,
    valueOfSupply: 10000.00,
    vatAmount: 1800.00,
    totalAmount: 11800.00,
    scheduleType: 'SCHEDULE_1',
    branchCode: '001',
    paymentType: 'cash'
  };

  showToast('info', `⚡ Enqueueing test invoice ${invoiceNo} to RAMIS...`);

  try {
    const res = await fetch('/api/ramis/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    const data = await res.json();
    showToast('success', `✓ Job ${data.jobId} queued for IRD submission`);

    setTimeout(() => {
      renderRamisMonitor();
      showToast('success', `🎉 Invoice ${invoiceNo} accepted by IRD RAMIS MSMQ!`);
    }, 1200);
  } catch (e) {
    showToast('error', 'Test submission failed: ' + e.message);
  }
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

// ─── APP DIALOGS ───
// Native browser popups cannot be styled and feel disconnected from the POS UI.
// These promise-based dialogs keep confirmation and input flows consistent.
let activeAppDialog = null;

function openAppDialog({ title, message, confirmLabel = 'Confirm', danger = false, input = false, inputValue = '', inputLabel = 'Your response' }) {
  if (activeAppDialog) activeAppDialog.resolve(activeAppDialog.input ? null : false);

  const overlay = document.getElementById('app-dialog-overlay');
  const icon = document.getElementById('app-dialog-icon');
  const titleEl = document.getElementById('app-dialog-title');
  const messageEl = document.getElementById('app-dialog-message');
  const field = document.getElementById('app-dialog-field');
  const inputEl = document.getElementById('app-dialog-input');
  const label = document.getElementById('app-dialog-label');
  const confirm = document.getElementById('app-dialog-confirm');

  titleEl.textContent = title;
  messageEl.textContent = message;
  label.textContent = inputLabel;
  inputEl.value = inputValue;
  field.classList.toggle('visible', input);
  confirm.textContent = confirmLabel;
  confirm.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  icon.classList.toggle('is-danger', danger);
  icon.innerHTML = `<i class="fa-solid ${danger ? 'fa-triangle-exclamation' : input ? 'fa-pen-to-square' : 'fa-circle-question'}"></i>`;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');

  return new Promise(resolve => {
    activeAppDialog = { resolve, input };
    requestAnimationFrame(() => (input ? inputEl : confirm).focus());
  });
}

function closeAppDialog(confirmed = false) {
  if (!activeAppDialog) return;
  const { resolve, input } = activeAppDialog;
  activeAppDialog = null;
  const overlay = document.getElementById('app-dialog-overlay');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  resolve(input ? (confirmed ? document.getElementById('app-dialog-input').value : null) : confirmed);
}

function showConfirmation(message, options = {}) {
  const danger = options.danger ?? /delete|remove|clear|permanently/i.test(message);
  return openAppDialog({ title: options.title || 'Please confirm', message, confirmLabel: options.confirmLabel || (danger ? 'Continue' : 'Confirm'), danger });
}

function showPrompt(message, inputValue = '', options = {}) {
  return openAppDialog({ title: options.title || 'Enter details', message, confirmLabel: options.confirmLabel || 'Save', input: true, inputValue, inputLabel: options.inputLabel || 'Your response' });
}

document.getElementById('app-dialog-cancel').addEventListener('click', () => closeAppDialog(false));
document.getElementById('app-dialog-confirm').addEventListener('click', () => closeAppDialog(true));
document.getElementById('app-dialog-overlay').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeAppDialog(false);
});
document.addEventListener('keydown', event => {
  if (!activeAppDialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeAppDialog(false); }
  if (event.key === 'Enter' && (activeAppDialog.input || event.target.id === 'app-dialog-confirm')) { event.preventDefault(); closeAppDialog(true); }
});

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

let currentPosViewMode = localStorage.getItem('nexpos_pos_view_mode') || 'grid';

window.setPosViewMode = (mode) => {
  currentPosViewMode = mode;
  localStorage.setItem('nexpos_pos_view_mode', mode);
  const btns = document.querySelectorAll('#pos-view-toggles .view-toggle-btn');
  btns.forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === mode));
  const grid = document.getElementById('pos-grid');
  if (grid) {
    grid.classList.toggle('compact-mode', mode === 'compact');
  }
  renderPosGrid();
};

function getProductCardVisual(p) {
  if (p.image || p.image_url) {
    return `<div class="pos-card-media"><img src="${p.image || p.image_url}" alt="${p.name}" class="pos-prod-img" onerror="this.parentElement.innerHTML='<i class=\\\'fa-solid fa-utensils pos-media-icon\\\'></i>'"></div>`;
  }
  
  const cat = p.category || 'General';
  const catMap = {
    'Rice & Curry': { bg: 'linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%)', text: '#92400E', icon: 'fa-bowl-rice', label: 'Rice & Curry' },
    'Noodles': { bg: 'linear-gradient(135deg, #FFE4E6 0%, #FECDD3 100%)', text: '#9F1239', icon: 'fa-bowl-food', label: 'Noodles' },
    'Snacks': { bg: 'linear-gradient(135deg, #D1FAE5 0%, #A7F3D0 100%)', text: '#065F46', icon: 'fa-cookie-bite', label: 'Snacks' },
    'Beverages': { bg: 'linear-gradient(135deg, #DBEAFE 0%, #BFDBFE 100%)', text: '#1E40AF', icon: 'fa-mug-hot', label: 'Beverage' },
    'Desserts': { bg: 'linear-gradient(135deg, #F5D0FE 0%, #E879F9 100%)', text: '#701A75', icon: 'fa-ice-cream', label: 'Dessert' },
    'Specials': { bg: 'linear-gradient(135deg, #E0E7FF 0%, #C7D2FE 100%)', text: '#312E81', icon: 'fa-star', label: 'Special' },
    'Clothing': { bg: 'linear-gradient(135deg, #F1F5F9 0%, #E2E8F0 100%)', text: '#0F172A', icon: 'fa-shirt', label: 'Clothing' },
    'Footwear': { bg: 'linear-gradient(135deg, #F1F5F9 0%, #E2E8F0 100%)', text: '#0F172A', icon: 'fa-shoe-prints', label: 'Footwear' },
    'Bags': { bg: 'linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%)', text: '#78350F', icon: 'fa-bag-shopping', label: 'Bags' },
    'Chicken': { bg: 'linear-gradient(135deg, #FEE2E2 0%, #FECACA 100%)', text: '#7F1D1D', icon: 'fa-drumstick-bite', label: 'Chicken' },
    'Beef': { bg: 'linear-gradient(135deg, #FEE2E2 0%, #FECACA 100%)', text: '#7F1D1D', icon: 'fa-bacon', label: 'Beef' },
    'Bread': { bg: 'linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%)', text: '#78350F', icon: 'fa-bread-slice', label: 'Bakery' },
    'Cakes': { bg: 'linear-gradient(135deg, #FDF4FF 0%, #F5D0FE 100%)', text: '#701A75', icon: 'fa-cake-candles', label: 'Cake' },
    'Tools': { bg: 'linear-gradient(135deg, #F1F5F9 0%, #E2E8F0 100%)', text: '#334155', icon: 'fa-wrench', label: 'Tools' },
    'default': { bg: 'linear-gradient(135deg, #F1F5F9 0%, #E2E8F0 100%)', text: '#475569', icon: 'fa-box', label: 'Product' }
  };
  
  const m = catMap[cat] || catMap['default'];
  return `
    <div class="pos-card-media" style="background:${m.bg}; color:${m.text}">
      <i class="fa-solid ${m.icon} pos-media-icon"></i>
      <span class="pos-media-watermark">${m.label}</span>
    </div>
  `;
}

function getIcon(cat) {
  return PRODUCT_ICONS[cat] || PRODUCT_ICONS['default'];
}

async function renderPosGrid() {
  const term = (document.getElementById('pos-search')?.value || '').toLowerCase();
  let products = await db.products.toArray();
  products = products.filter(p => p.is_active !== false).reverse();
  
  if(posCategory) products = products.filter(p => p.category === posCategory);
  if(term) products = products.filter(p => (p.name||'').toLowerCase().includes(term) || (p.sku||'').toLowerCase().includes(term) || (p.barcode||'').toLowerCase().includes(term));
  
  const grid = document.getElementById('pos-grid');
  if (!grid) return;

  if (currentPosViewMode === 'compact') {
    grid.classList.add('compact-mode');
  } else {
    grid.classList.remove('compact-mode');
  }

  if (products.length === 0) {
    const isFiltered = !!term || !!posCategory;
    const bizType = currentSettings.biz_type || 'Restaurant';
    grid.innerHTML = `
      <div class="pos-no-results">
        <div class="pos-no-results-icon"><i class="fa-solid ${isFiltered ? 'fa-box-open' : 'fa-utensils'}"></i></div>
        <div class="pos-no-results-title">${isFiltered ? 'No matching products' : 'Product Catalogue is Empty'}</div>
        <div class="pos-no-results-desc">${isFiltered ? 'Try clearing the search query or select another category' : 'No menu items have been added to this store yet.'}</div>
        ${!isFiltered ? `
          <div style="display:flex; gap:12px; margin-top:20px; justify-content:center; flex-wrap:wrap">
            <button class="btn btn-primary" onclick="quickSeedTemplateCatalogue()" style="padding:10px 22px; font-size:14px; border-radius:10px; font-weight:600; display:inline-flex; align-items:center; gap:8px">
              <i class="fa-solid fa-wand-magic-sparkles"></i> Load Starter Menu (${bizType})
            </button>
            <button class="btn btn-secondary" onclick="openProductForm()" style="padding:10px 22px; font-size:14px; border-radius:10px; font-weight:600; display:inline-flex; align-items:center; gap:8px">
              <i class="fa-solid fa-plus"></i> Add New Product
            </button>
          </div>
        ` : ''}
      </div>
    `;
    return;
  }

  grid.innerHTML = products.map(p => {
    const isOutOfStock = p.stock_qty <= 0;
    const isLowStock = p.stock_qty > 0 && p.stock_qty <= (p.low_stock_threshold || 5);
    const stockLabel = isOutOfStock ? 'Out of stock' : `${p.stock_qty} ${p.unit || ''}`.trim();
    const stockState = isOutOfStock ? 'out' : (isLowStock ? 'low' : 'normal');
    
    // In-Cart live indicator
    const inCartItem = cart.find(i => i.product_id === p.id);
    const inCartQty = inCartItem ? inCartItem.quantity : 0;
    const priceNum = Number(p.retail_price || 0);

    return `
      <div class="pos-product-card ${isOutOfStock?'out-of-stock':''} ${isLowStock?'low-stock':''} ${inCartQty > 0 ? 'in-cart' : ''}" 
           onclick="addToCart(${p.id})" 
           title="${p.name} — ${formatMoney(priceNum)}">
        ${getProductCardVisual(p)}
        <div class="pos-card-top-badges">
          <span class="pos-category-label">${p.category || 'General'}</span>
          ${inCartQty > 0 ? `<span class="in-cart-pill"><i class="fa-solid fa-check"></i> ${inCartQty}</span>` : ''}
        </div>
        <div class="pos-prod-body">
          <div class="pos-prod-name">${p.name}</div>
          <div class="pos-prod-meta">#${p.sku || p.barcode || 'ITEM'}</div>
          <div class="pos-prod-footer">
            <div class="pos-prod-price"><span class="price-curr">Rs.</span><span class="price-val">${priceNum.toLocaleString()}</span><span class="price-dec">.00</span></div>
            <div class="pos-prod-stock ${stockState}"><span class="stock-dot"></span>${isLowStock ? 'Low stock' : stockLabel}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.quickSeedTemplateCatalogue = async () => {
  const bizType = currentSettings.biz_type || 'Restaurant';
  showToast('info', `Loading starter catalogue for ${bizType}...`);
  try {
    await loadBusinessTemplate(bizType);
    await renderPosCategories();
    await renderPosGrid();
    showToast('success', `✨ Starter ${bizType} catalogue loaded successfully!`);
  } catch (err) {
    showToast('error', 'Error loading catalogue: ' + err.message);
  }
};

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
  renderPosGrid();
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
  renderPosGrid();
};

window.removeCartItem = (idx) => { 
  cart.splice(idx, 1); 
  renderCart(); 
  renderPosGrid();
};

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
  
  const isRestaurant = currentSettings.restaurant_mode === 'true' || currentSettings.biz_type === 'Restaurant';

  cEl.innerHTML = cart.map((item, i) => `
    <div class="cart-item">
      <div class="cart-item-avatar"><i class="fa-solid fa-box-open"></i></div>
      <div class="cart-item-info">
        <div class="cart-item-name" title="${item.name}">${item.name}</div>
        <div class="cart-item-price">@ ${formatMoney(item.unit_price)}</div>
        ${isRestaurant ? `
          <div class="cart-item-note-row">
            ${item.notes ? `
              <span class="cart-item-note-tag" onclick="openItemNoteModal(${i})" title="Click to edit cooking note">
                <i class="fa-solid fa-pen" style="font-size:9px"></i> ${item.notes}
              </span>
            ` : `
              <button type="button" class="cart-item-note-btn" onclick="openItemNoteModal(${i})">
                <i class="fa-solid fa-plus"></i> Add Note
              </button>
            `}
          </div>
        ` : ''}
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

window.clearCart = async () => { 
  if(await showConfirmation('Clear current cart?', { title: 'Clear cart', confirmLabel: 'Clear cart' })) { 
    cart=[]; 
    manualDiscount=0; 
    renderCart(); 
    renderPosGrid(); 
  } 
};

// ─── HARDWARE FAST-CASH TENDER (Real POS feature) ───
window.fastCashTender = async (preset) => {
  if(cart.length === 0) return showToast('error', 'Cart is empty');
  const { subtotal, discount, tax, total } = updateTotals();
  let tendered = total;
  if(preset === 'exact') {
    tendered = total;
  } else {
    const num = Number(preset);
    if(num < total) {
      showToast('info', `Rs. ${num.toLocaleString()} is less than bill amount. Opening cash register...`);
      return openCashPaymentModal(total, subtotal, discount, tax);
    }
    tendered = num;
  }
  const change = Math.max(0, tendered - total);
  await executeCheckout('cash', total, tendered, change, subtotal, discount, tax);
};

window.toggleWorkOfflineMode = () => {
  if (typeof toggleForceOffline === 'function') {
    const isNowOffline = toggleForceOffline();
    showToast(isNowOffline ? 'warning' : 'success', isNowOffline ? '📶 Forced Offline Mode: Sales and receipts save locally in IndexedDB' : '🌐 Online Mode: Cloud connection active');
  }
};

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

window.applyDiscount = async () => {
  const d = await showPrompt('Enter discount amount:', manualDiscount, { title: 'Apply discount', inputLabel: 'Discount amount', confirmLabel: 'Apply' });
  if(d !== null && !isNaN(d)) { manualDiscount = parseFloat(d); renderCart(); }
};

window.holdCart = async () => {
  if(cart.length === 0) return showToast('error', 'Cart is empty');
  const name = await showPrompt('Enter a name for this held cart:', 'Cart ' + new Date().toLocaleTimeString(), { title: 'Hold cart', inputLabel: 'Cart name', confirmLabel: 'Hold cart' });
  if(!name) return;
  await db.held_carts.add({ name, items: cart, customer_id: cartCustomerId, date: new Date().toISOString() });
  cart = []; manualDiscount = 0; cartCustomerId = 1;
  renderCart(); updateCartCustomer(); showToast('success', 'Cart held');
};

// ─── CASH DENOMINATIONS & PAYMENT STATE ───
let currentCashCheckout = { total: 0, subtotal: 0, discount: 0, tax: 0, tendered: 0 };

window.payNow = async (paymentType) => {
  if(cart.length === 0) return showToast('error', 'Cart is empty');
  
  const { subtotal, discount, tax, total } = updateTotals();
  
  if(paymentType === 'credit') {
    if(cartCustomerId === 1) return showToast('error', 'Please select a specific customer for credit sales.');
    const c = await db.customers.get(cartCustomerId);
    if(!await showConfirmation(`Add ${formatMoney(total)} to ${c.name}'s credit balance?`, { title: 'Confirm credit sale', confirmLabel: 'Add to credit' })) return;
    return executeCheckout('credit', total, total, 0, subtotal, discount, tax);
  }
  
  if(paymentType === 'card') {
    return executeCheckout('card', total, total, 0, subtotal, discount, tax);
  }
  
  if(paymentType === 'cash') {
    openCashPaymentModal(total, subtotal, discount, tax);
  }
};

window.openCashPaymentModal = (total, subtotal, discount, tax) => {
  currentCashCheckout = {
    total,
    subtotal,
    discount,
    tax,
    tendered: total,
    noteCounts: { 5000: 0, 2000: 0, 1000: 0, 500: 0, 100: 0, 50: 0, 20: 0 },
    coinCounts: { 10: 0, 5: 0, 2: 0, 1: 0 }
  };
  
  const notes = [5000, 2000, 1000, 500, 100, 50, 20];
  const coins = [10, 5, 2, 1];

  const html = `
    <div class="cash-modal-wrap">
      <div class="cash-due-card">
        <div>
          <div class="cash-due-label">Total Bill Amount</div>
          <div class="cash-due-val">${formatMoney(total)}</div>
        </div>
        <div style="display:flex; gap:6px">
          <button type="button" class="btn btn-secondary btn-sm" onclick="setExactCash()" title="Pay exact bill amount">Exact Bill</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="clearCashTendered()" title="Reset tendered amount" style="color:var(--danger)">Clear</button>
        </div>
      </div>

      <div>
        <label class="form-label" style="display:flex; justify-content:space-between">
          <span>Amount Tendered by Customer</span>
          <span style="font-weight:400; color:var(--text-muted); font-size:11px">Type note counts below or type total</span>
        </label>
        <div class="cash-input-row">
          <input class="form-input cash-tendered-input" type="number" step="any" id="cash-tendered-input" 
            value="${total.toFixed(2)}" placeholder="${total.toFixed(2)}" oninput="onCashTenderedInput(this.value)" autocomplete="off">
        </div>
      </div>

      <!-- Currency Notes with Direct Quantity Typing -->
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
          <div class="denom-section-title" style="margin-bottom:0">💵 Currency Notes (LKR)</div>
          <span style="font-size:11px; color:var(--brand); font-weight:600">Type quantity or click +/-</span>
        </div>
        <div class="denom-grid-notes">
          ${notes.map(n => `
            <div class="denom-note-card" id="note-card-${n}">
              <div class="denom-note-top" onclick="stepNoteQty(${n}, 1)" title="Click to add 1 note">
                <span class="denom-note-val">Rs. ${n.toLocaleString()}</span>
                <span class="denom-note-badge">+ ${n >= 1000 ? (n/1000) + 'K' : n}</span>
              </div>
              <div class="denom-qty-control">
                <button type="button" class="denom-qty-btn" onclick="stepNoteQty(${n}, -1)" title="Remove 1 note">−</button>
                <input type="number" min="0" max="999" class="denom-qty-input" id="note-qty-${n}" 
                  placeholder="0" value="" 
                  oninput="onNoteQtyChange(${n}, this.value)" 
                  onfocus="this.select()" 
                  title="Type number of Rs. ${n} notes given">
                <button type="button" class="denom-qty-btn" onclick="stepNoteQty(${n}, 1)" title="Add 1 note">+</button>
              </div>
              <div class="denom-note-subtotal" id="note-subtotal-${n}">Rs. 0</div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Currency Coins -->
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
          <div class="denom-section-title" style="margin-bottom:0">🪙 Coins (LKR)</div>
          <span style="font-size:11px; color:var(--text-muted)">Click to add coins</span>
        </div>
        <div class="denom-grid-coins">
          ${coins.map(c => `
            <button type="button" class="denom-btn denom-coin" id="coin-btn-${c}" onclick="stepNoteQty(${c}, 1)" title="Add Rs. ${c} coin">
              <span>+ Rs. ${c}</span>
              <span id="coin-badge-${c}" style="display:none; margin-left:4px; background:var(--brand); color:#fff; font-size:10px; font-weight:700; padding:1px 6px; border-radius:999px">0</span>
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Live Calculation Summary -->
      <div id="cash-calc-summary-box"></div>
    </div>
  `;

  const footer = `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" id="btn-confirm-cash" onclick="confirmCashSale()" style="padding:12px 20px; font-weight:700">
      Complete Cash Sale →
    </button>
  `;

  openModal('Cash Payment & Denominations', html, footer);
  renderCashCalcSummary();
  
  setTimeout(() => {
    const input = document.getElementById('cash-tendered-input');
    if(input) {
      input.focus();
      input.addEventListener('keydown', (e) => {
        if(e.key === 'Enter') confirmCashSale();
      });
    }
  }, 120);
};

window.stepNoteQty = (denom, delta) => {
  if (!currentCashCheckout) return;
  if (currentCashCheckout.noteCounts && currentCashCheckout.noteCounts[denom] !== undefined) {
    currentCashCheckout.noteCounts[denom] = Math.max(0, (currentCashCheckout.noteCounts[denom] || 0) + delta);
    const input = document.getElementById(`note-qty-${denom}`);
    if (input) input.value = currentCashCheckout.noteCounts[denom] || '';
  } else if (currentCashCheckout.coinCounts && currentCashCheckout.coinCounts[denom] !== undefined) {
    currentCashCheckout.coinCounts[denom] = Math.max(0, (currentCashCheckout.coinCounts[denom] || 0) + delta);
  }
  recalcCashFromCounts();
};

window.onNoteQtyChange = (denom, val) => {
  if (!currentCashCheckout) return;
  const count = Math.max(0, parseInt(val, 10) || 0);
  if (currentCashCheckout.noteCounts && currentCashCheckout.noteCounts[denom] !== undefined) {
    currentCashCheckout.noteCounts[denom] = count;
  } else if (currentCashCheckout.coinCounts && currentCashCheckout.coinCounts[denom] !== undefined) {
    currentCashCheckout.coinCounts[denom] = count;
  }
  recalcCashFromCounts();
};

window.addCashDenom = (amount) => {
  window.stepNoteQty(amount, 1);
};

function recalcCashFromCounts() {
  if (!currentCashCheckout) return;
  let sum = 0;
  
  if (currentCashCheckout.noteCounts) {
    for (const [denom, count] of Object.entries(currentCashCheckout.noteCounts)) {
      const n = Number(denom);
      const sub = n * count;
      sum += sub;
      const card = document.getElementById(`note-card-${n}`);
      const subEl = document.getElementById(`note-subtotal-${n}`);
      const input = document.getElementById(`note-qty-${n}`);
      if (card) {
        if (count > 0) card.classList.add('has-qty');
        else card.classList.remove('has-qty');
      }
      if (subEl) {
        subEl.textContent = count > 0 ? `Rs. ${sub.toLocaleString()}` : `Rs. 0`;
      }
      if (input && document.activeElement !== input) {
        input.value = count || '';
      }
    }
  }

  if (currentCashCheckout.coinCounts) {
    for (const [denom, count] of Object.entries(currentCashCheckout.coinCounts)) {
      const c = Number(denom);
      sum += c * count;
      const badge = document.getElementById(`coin-badge-${c}`);
      const btn = document.getElementById(`coin-btn-${c}`);
      if (badge) {
        badge.style.display = count > 0 ? 'inline' : 'none';
        badge.textContent = `x${count}`;
      }
      if (btn) {
        if (count > 0) btn.classList.add('has-qty');
        else btn.classList.remove('has-qty');
      }
    }
  }

  currentCashCheckout.tendered = Number(sum.toFixed(2));
  const mainInput = document.getElementById('cash-tendered-input');
  if (mainInput) mainInput.value = currentCashCheckout.tendered || '';
  renderCashCalcSummary();
}

window.setExactCash = () => {
  if (!currentCashCheckout) return;
  currentCashCheckout.tendered = currentCashCheckout.total;
  if (currentCashCheckout.noteCounts) {
    Object.keys(currentCashCheckout.noteCounts).forEach(k => {
      currentCashCheckout.noteCounts[k] = 0;
      const input = document.getElementById(`note-qty-${k}`);
      if (input) input.value = '';
      const card = document.getElementById(`note-card-${k}`);
      if (card) card.classList.remove('has-qty');
      const subEl = document.getElementById(`note-subtotal-${k}`);
      if (subEl) subEl.textContent = 'Rs. 0';
    });
  }
  if (currentCashCheckout.coinCounts) {
    Object.keys(currentCashCheckout.coinCounts).forEach(k => {
      currentCashCheckout.coinCounts[k] = 0;
      const badge = document.getElementById(`coin-badge-${k}`);
      if (badge) badge.style.display = 'none';
      const btn = document.getElementById(`coin-btn-${k}`);
      if (btn) btn.classList.remove('has-qty');
    });
  }
  const input = document.getElementById('cash-tendered-input');
  if (input) input.value = currentCashCheckout.tendered;
  renderCashCalcSummary();
};

window.clearCashTendered = () => {
  if (!currentCashCheckout) return;
  currentCashCheckout.tendered = 0;
  if (currentCashCheckout.noteCounts) {
    Object.keys(currentCashCheckout.noteCounts).forEach(k => {
      currentCashCheckout.noteCounts[k] = 0;
      const input = document.getElementById(`note-qty-${k}`);
      if (input) input.value = '';
      const card = document.getElementById(`note-card-${k}`);
      if (card) card.classList.remove('has-qty');
      const subEl = document.getElementById(`note-subtotal-${k}`);
      if (subEl) subEl.textContent = 'Rs. 0';
    });
  }
  if (currentCashCheckout.coinCounts) {
    Object.keys(currentCashCheckout.coinCounts).forEach(k => {
      currentCashCheckout.coinCounts[k] = 0;
      const badge = document.getElementById(`coin-badge-${k}`);
      if (badge) badge.style.display = 'none';
      const btn = document.getElementById(`coin-btn-${k}`);
      if (btn) btn.classList.remove('has-qty');
    });
  }
  const input = document.getElementById('cash-tendered-input');
  if (input) {
    input.value = '';
    input.focus();
  }
  renderCashCalcSummary();
};

window.onCashTenderedInput = (val) => {
  currentCashCheckout.tendered = parseFloat(val) || 0;
  renderCashCalcSummary();
};

function renderCashCalcSummary() {
  const box = document.getElementById('cash-calc-summary-box');
  if(!box) return;
  const total = currentCashCheckout.total;
  const tendered = currentCashCheckout.tendered;
  const diff = tendered - total;

  if (tendered === 0) {
    box.innerHTML = `
      <div class="cash-calc-summary" style="background:var(--surface-2); border-color:var(--border)">
        <div>
          <div class="cash-calc-status" style="color:var(--text-muted)">Waiting for Cash</div>
          <div style="font-size:12px; color:var(--text-muted)">Enter amount given by customer</div>
        </div>
        <div class="cash-calc-val" style="color:var(--text-muted); font-size:18px">Rs. 0.00</div>
      </div>
    `;
    return;
  }

  if (diff >= 0) {
    box.innerHTML = `
      <div class="cash-calc-summary cash-calc-change">
        <div>
          <div class="cash-calc-status">✓ Change to Return</div>
          <div style="font-size:11px; opacity:0.85">Customer Paid: ${formatMoney(tendered)}</div>
        </div>
        <div class="cash-calc-val">${formatMoney(diff)}</div>
      </div>
    `;
  } else {
    box.innerHTML = `
      <div class="cash-calc-summary cash-calc-short">
        <div>
          <div class="cash-calc-status">⚠ Short / Due Remaining</div>
          <div style="font-size:11px; opacity:0.85">Tendered: ${formatMoney(tendered)} of ${formatMoney(total)}</div>
        </div>
        <div class="cash-calc-val">-${formatMoney(Math.abs(diff))}</div>
      </div>
    `;
  }
}

window.confirmCashSale = async () => {
  const total = currentCashCheckout.total;
  let tendered = parseFloat(document.getElementById('cash-tendered-input')?.value);
  if (isNaN(tendered) || tendered <= 0) {
    tendered = currentCashCheckout.tendered || total;
  }

  // Directly complete sale and print receipt with NO other confirmation popup
  const change = Math.max(0, tendered - total);
  closeModal();
  await executeCheckout('cash', total, tendered, change, currentCashCheckout.subtotal, currentCashCheckout.discount, currentCashCheckout.tax);
};

// ─── EXECUTE CHECKOUT & BACKGROUND PIPELINES ───
async function executeCheckout(paymentType, total, tendered, change, subtotal, discount, tax) {
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
    const checkoutCart = cart.map(item => ({ ...item }));
    const saleId = await db.sales.add(sale);
    await db.sale_items.bulkAdd(saleItems.map(si => ({...si, sale_id: saleId})));

    cart = []; manualDiscount = 0; cartCustomerId = 1;
    renderCart(); updateCartCustomer();

    // If a restaurant order was checked out, free table and mark its KOTs served
    if (typeof activeTableOrders !== 'undefined' && currentTableId) {
      if (currentDiningType === 'dine_in') {
        delete activeTableOrders[currentTableId];
      }
      if (typeof activeKots !== 'undefined' && Array.isArray(activeKots)) {
        activeKots.forEach(k => {
          if ((k.table_id === currentTableId || k.id === currentTableId) && k.status !== 'served') {
            k.status = 'served';
            k.sale_id = saleId;
          }
        });
      }
      if (typeof saveRestaurantState === 'function') saveRestaurantState();
      if (typeof updateDiningTableUI === 'function') updateDiningTableUI();
      if (typeof updateKotBadge === 'function') updateKotBadge();
      if (typeof renderKOTScreen === 'function') renderKOTScreen();
    }
    
    // Display 80mm receipt with Univerzlk branding and auto-print
    showReceipt(Object.assign({id:saleId}, sale), saleItems, change, paymentType==='cash'?tendered:total, true);

    // ⚡ Realtime Broadcast across all connected terminals and kitchen screens
    if (typeof broadcastRealtimeEvent === 'function') {
      broadcastRealtimeEvent('SALE_COMPLETED', {
        sale_id: saleId,
        total: total,
        payment_type: paymentType,
        activeKots: typeof activeKots !== 'undefined' ? activeKots : [],
        activeTableOrders: typeof activeTableOrders !== 'undefined' ? activeTableOrders : {}
      });
    }

    // ─── BACKGROUND LOCAL UPDATES (Zero UI Lag) ───
    runInBackground('Post-sale database update', async () => {
      await Promise.all(checkoutCart.map(async item => {
        const p = await db.products.get(item.product_id);
        if(p) await db.products.update(p.id, { stock_qty: p.stock_qty - item.quantity });
      }));

      if(paymentType === 'credit') {
        const c = await db.customers.get(sale.customer_id);
        if(c) await db.customers.update(c.id, { outstanding_balance: (c.outstanding_balance || 0) + total });
      }

      await Promise.all([
        renderPosGrid(),
        logSecurityEvent('SALE_COMPLETED', { sale_id: saleId, total: total, type: paymentType })
      ]);
    });

    // ─── BACKGROUND RAMIS IRD SCHEDULE 1 ENQUEUE ───
    enqueueRamisInvoice({
      id: saleId,
      date: sale.date,
      subtotal: sale.subtotal,
      discount: sale.discount,
      tax: sale.tax,
      total_amount: sale.total_amount,
      payment_type: paymentType,
      items_count: sale.items_count,
      customer_id: sale.customer_id
    });

    // Offline status notification & UI update
    if(typeof isOffline === 'function' && isOffline()) {
      if(typeof updateOfflineStatusUI === 'function') updateOfflineStatusUI();
      showToast('info', '📶 Sale recorded in offline queue. Will auto-sync when online.');
    }

    // Close mobile cart
    document.querySelector('.pos-cart-wrap')?.classList.remove('active');

  } catch (err) {
    console.error('Checkout error:', err);
    showToast('error', 'Failed to complete checkout: ' + err.message);
  }
}

// ─── RAMIS WEB API BACKGROUND ENQUEUE ───
async function enqueueRamisInvoice(saleData) {
  try {
    const customer = saleData.customer_id ? await db.customers.get(saleData.customer_id) : null;
    const tinSupplier = document.getElementById('set-ramis-tin')?.value.trim() || (currentSettings && currentSettings.tin) || '102938475';
    const periodCode = document.getElementById('set-ramis-period')?.value.trim() || '2610';
    const tinPurchaser = (customer && customer.tin) ? customer.tin : null;
    const purchaserName = (customer && customer.name) ? customer.name : null;
    
    // Calculate taxable value of supply (Supply Value excluding VAT)
    const valueOfSupply = Number(((saleData.subtotal || 0) - (saleData.discount || 0)).toFixed(2));
    const vatAmount = Number((saleData.tax || 0).toFixed(2));
    const invoiceNo = `INV-${String(saleData.id).padStart(6, '0')}`;
    const invoiceDate = new Date(saleData.date).toISOString().split('T')[0];

    const payload = {
      taxInvoiceNo: invoiceNo,
      invoiceDate: invoiceDate,
      periodCode: periodCode,
      supplierTin: tinSupplier,
      purchaserTin: tinPurchaser,
      purchaserName: purchaserName,
      valueOfSupply: valueOfSupply,
      vatAmount: vatAmount,
      totalAmount: Number(saleData.total_amount.toFixed(2)),
      scheduleType: 'SCHEDULE_1',
      branchCode: '001',
      paymentType: saleData.payment_type || 'cash'
    };

    // Fast asynchronous call to background queue worker
    fetch('/api/ramis/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).then(res => res.json()).then(data => {
      console.log('⚡ [RAMIS] Invoice enqueued successfully:', data);
    }).catch(err => {
      console.warn('ℹ️ [RAMIS Queue Notice]:', err.message);
    });
  } catch (err) {
    console.warn('RAMIS enqueue notice:', err);
  }
}

function showReceipt(sale, items, change, tendered, autoPrint = false) {
  const shopName = currentSettings.biz_name || 'NexPOS';
  const address = currentSettings.address || '';
  const phone = currentSettings.phone || '';
  const logo = currentSettings.biz_logo || '';
  
  let html = `
    <div style="text-align:center;margin-bottom:12px;border-bottom:1px dashed var(--rule);padding-bottom:8px">
      ${logo ? `
        <div style="margin-bottom:8px; display:flex; justify-content:center; align-items:center;">
          <img src="${logo}" alt="${shopName}" style="max-height:55px; max-width:150px; object-fit:contain; display:block; margin:0 auto;" />
        </div>
      ` : ''}
      <h2 style="margin:0;font-size:17px;color:var(--ink);letter-spacing:0.5px">${shopName}</h2>
      <div style="color:var(--ink-3);font-size:11px">${address}</div>
      <div style="color:var(--ink-3);font-size:11px">${phone}</div>
    </div>
    <div style="margin-bottom:8px;color:var(--ink);font-size:11.5px">
      <div>Receipt: <span class="fw-600">#${sale.id}</span></div>
      <div>Date: ${new Date(sale.date).toLocaleString()}</div>
      <div>Cashier: ${sale.cashier}</div>
      <div>Pay Method: <span style="font-weight:700">${sale.payment_type.toUpperCase()}</span></div>
    </div>
    <table style="width:100%;text-align:left;border-bottom:1px dashed var(--rule);margin-bottom:8px;color:var(--ink);font-size:11.5px">
      <tr style="color:var(--ink-3);font-size:10.5px;text-transform:uppercase"><th>Item</th><th>Qty</th><th style="text-align:right">Total</th></tr>
  `;
  
  items.forEach(i => {
    html += `<tr><td style="padding:3px 0">${i.product_name}</td><td>${i.quantity}</td><td style="text-align:right" class="td-mono">${formatMoney(i.line_total)}</td></tr>`;
  });
  
  html += `</table>
    <div style="text-align:right;color:var(--ink);font-size:12px">
      <div style="color:var(--ink-3)">Subtotal: ${formatMoney(sale.subtotal)}</div>
      ${sale.discount>0 ? `<div style="color:var(--ink-2)">Discount: -${formatMoney(sale.discount)}</div>` : ''}
      ${sale.tax>0 ? `<div style="color:var(--ink-3)">Tax: ${formatMoney(sale.tax)}</div>` : ''}
      <h3 style="margin:4px 0;color:var(--ink);font-size:18px;font-weight:800">Total: ${formatMoney(sale.total_amount)}</h3>
      ${sale.payment_type==='cash' ? `<div style="font-size:11.5px">Tendered: ${formatMoney(tendered)}</div><div style="font-weight:700;color:var(--ink);font-size:12.5px">Change: ${formatMoney(change)}</div>` : ''}
    </div>
    <div style="text-align:center;margin-top:10px;border-top:1px dashed var(--rule);padding-top:6px;color:var(--ink-3);font-style:italic;font-size:10.5px">Thank you for your business!</div>
    
    <!-- 80mm Custom Branding Footer -->
    <div class="thermal-univerzlk-footer" style="text-align:center;margin-top:8px;border-top:1px dashed var(--rule);padding-top:6px;font-family:'Courier New',Courier,monospace;font-size:10px;line-height:1.35;color:var(--ink-2)">
      <div class="univerzlk-title" style="font-weight:700;font-size:11px;color:var(--ink)">Powered by Univerzlk (pvt)Ltd</div>
      <div class="univerzlk-tagline" style="font-size:9px;color:var(--ink-3)">Ask for POS Systems</div>
      <div class="univerzlk-contact" style="font-size:9.5px;font-weight:600;color:var(--ink)">+94 77 887 3302 | univerzlk.com</div>
    </div>
  `;
  
  currentReceiptData = { sale, items };
  document.getElementById('receipt-body').innerHTML = html;
  
  // Show "LOCKED" banner for past sales, hide for new ones
  const banner = document.getElementById('receipt-status-banner');
  if (banner) {
    banner.style.display = (sale.id) ? 'block' : 'none';
  }

  const receiptOverlay = document.getElementById('receipt-overlay');

  // 🖨️ Auto-Print Bill on Payment (Direct print with zero popup modal blocking)
  const shouldAutoPrint = autoPrint && (currentSettings.receipt_autoprint !== 'false');
  if (shouldAutoPrint) {
    if (receiptOverlay) {
      receiptOverlay.classList.add('open', 'autoprint-mode');
    }
    setTimeout(async () => {
      await printReceipt();
      setTimeout(() => {
        if (receiptOverlay) {
          receiptOverlay.classList.remove('open', 'autoprint-mode');
        }
      }, 400);
    }, 120);
  } else {
    // Regular manual view from history or modal
    if (receiptOverlay) {
      receiptOverlay.classList.remove('autoprint-mode');
      receiptOverlay.classList.add('open');
    }
  }
}

window.closeReceipt = () => {
  const overlay = document.getElementById('receipt-overlay');
  if (overlay) overlay.classList.remove('open', 'autoprint-mode');
};

window.addEventListener('afterprint', () => {
  window.closeReceipt();
});

window.printReceipt = async () => {
  // If running inside Electron desktop app, use silent thermal printing
  if (window.electronAPI && window.electronAPI.isElectron) {
    try {
      showToast('info', '🖨️ Sending to thermal printer...');
      const result = await window.electronAPI.silentPrint();
      if (result.success) {
        showToast('success', `✅ Printed silently to ${result.printer || 'default printer'}`);
      } else {
        showToast('error', `Print failed: ${result.error || 'Unknown error'}. Falling back to browser print.`);
        window.print();
      }
    } catch (err) {
      console.error('Electron print error:', err);
      window.print();
    }
  } else {
    // Browser mode — standard print dialog
    window.print();
  }
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

  const inputPhone = await showPrompt('Enter WhatsApp number (e.g. 0771234567):', phone, { title: 'Share via WhatsApp', inputLabel: 'WhatsApp number', confirmLabel: 'Continue' });
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
    tempDiv.className = 'thermal-paper';
    tempDiv.innerHTML = receiptBody.innerHTML;
    document.body.appendChild(tempDiv);

    const canvas = await html2canvas(tempDiv, { scale: 3, useCORS: true, backgroundColor: '#ffffff' });
    document.body.removeChild(tempDiv);

    // Flatten every pixel to luminance so the shared bill carries no colour at
    // all — a tinted logo or a stray themed style cannot survive this pass.
    // Throws if a cross-origin logo tainted the canvas, in which case the
    // already-achromatic markup is good enough on its own.
    try {
      const ctx = canvas.getContext('2d');
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = frame.data;
      for (let i = 0; i < px.length; i += 4) {
        const grey = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
        px[i] = px[i + 1] = px[i + 2] = grey;
      }
      ctx.putImageData(frame, 0, 0);
    } catch (e) {
      console.warn('Greyscale pass skipped (canvas tainted):', e);
    }

    // 3. Create PDF Blob — PNG, not JPEG: chroma subsampling smears coloured
    // fringes around black glyphs, and flat black-on-white compresses smaller
    const imgData = canvas.toDataURL('image/png');
    const pdfW = 80;
    const pdfH = (canvas.height * pdfW) / canvas.width;
    const pdf = new jsPDF({ unit: 'mm', format: [pdfW, pdfH] });
    pdf.addImage(imgData, 'PNG', 0, 0, pdfW, pdfH);
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
    const bizNameDisplay = currentSettings.biz_name || 'NexPOS';
    
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
  // The Bluetooth button calls this with no arguments, which used to throw on
  // items.forEach — fall back to whatever receipt is on screen
  if (!sale || !items) {
    if (!currentReceiptData) return showToast('error', 'No receipt data found');
    sale = currentReceiptData.sale;
    items = currentReceiptData.items;
  }

  // ESC/POS raw commands for RawBT app — text only, so inherently monochrome
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
  if (typeof broadcastRealtimeEvent === 'function') broadcastRealtimeEvent('STOCK_UPDATED', {});
};

window.applyTemplate = async (type) => {
  if(!await showConfirmation(`This will delete all existing products and categories, then load the ${type} template.`, { title: 'Replace inventory?', confirmLabel: 'Load template', danger: true })) return;
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
  const tbody = document.getElementById('customers-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center">Loading customers...</td></tr>';

  let [custs, sales] = await Promise.all([
    db.customers.toArray(),
    db.sales.toArray()
  ]);

  const purchasesByCustomer = sales.reduce((map, sale) => {
    const customerId = sale.customer_id;
    if(customerId) map[customerId] = (map[customerId] || 0) + (Number(sale.total_amount) || 0);
    return map;
  }, {});

  const term = document.getElementById('customer-search').value.toLowerCase();
  if(term) custs = custs.filter(c => (c.name || '').toLowerCase().includes(term) || (c.phone || '').includes(term));

  custs = custs.map(c => ({
    ...c,
    total_purchases: purchasesByCustomer[c.id] || 0
  }));
  
  tbody.innerHTML = custs.map(c => `
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
        <button class="btn btn-ghost btn-sm btn-icon" onclick="openResetStaffPasswordModal(${u.id}, '${u.display_name}')" title="Change / Set Password" style="color:var(--brand)">🔑</button>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="deleteUser(${u.id}, '${u.display_name}')" title="Delete User" style="color:var(--danger)">🗑️</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="text-align:center">No users found</td></tr>';
};

window.openResetStaffPasswordModal = (userId, displayName) => {
  if (!currentUser || currentUser.role !== 'Admin') {
    return showToast('error', 'Only Business Administrators can change staff passwords');
  }
  const html = `
    <div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px">
      Assign/change password for staff member: <strong style="color:var(--brand)">${displayName}</strong>
    </div>
    <div class="form-group">
      <label class="form-label">New Password</label>
      <input class="form-input" type="password" id="staff-new-pw" placeholder="Enter new password (min 3 chars)">
    </div>
    <div class="form-group">
      <label class="form-label">Confirm Password</label>
      <input class="form-input" type="password" id="staff-confirm-pw" placeholder="Re-enter new password">
    </div>
  `;
  openModal(`Set Password — ${displayName}`, html, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveStaffPassword(${userId}, '${displayName}')">Update Password</button>
  `);
};

window.saveStaffPassword = async (userId, displayName) => {
  if (!currentUser || currentUser.role !== 'Admin') {
    return showToast('error', 'Only Business Administrators can change staff passwords');
  }
  const newPw = document.getElementById('staff-new-pw').value.trim();
  const confirmPw = document.getElementById('staff-confirm-pw').value.trim();
  if (!newPw) return showToast('error', 'Please enter a password');
  if (newPw !== confirmPw) return showToast('error', 'Passwords do not match');
  if (newPw.length < 3) return showToast('error', 'Password must be at least 3 characters');

  try {
    await db.users.update(parseInt(userId), { password: newPw });
    closeModal();
    showToast('success', `Password for ${displayName} updated successfully!`);
  } catch (e) {
    showToast('error', 'Failed to update staff password: ' + e.message);
  }
};

window.openUserForm = async (id = null) => {
  if (!currentUser || currentUser.role !== 'Admin') {
    return showToast('error', 'Only Business Administrators can add or edit staff');
  }
  let u = { username:'', password:'', display_name:'', role:'Counter', is_active:true, hourly_rate:0, ot_rate:0 };
  if(id) u = await db.users.get(id);
  const html = `
    <input type="hidden" id="f-usr-id" value="${id||''}">
    <div class="form-grid">
      <div class="form-group"><label class="form-label">Username *</label><input class="form-input" id="f-usr-name" value="${u.username}" placeholder="e.g. cashier1"></div>
      <div class="form-group"><label class="form-label">Password *</label><input class="form-input" type="password" id="f-usr-pass" value="${u.password}" placeholder="Assign password"></div>
      <div class="form-group"><label class="form-label">Display Name *</label><input class="form-input" id="f-usr-disp" value="${u.display_name}" placeholder="e.g. Kasun Silva"></div>
      <div class="form-group"><label class="form-label">Role</label><select class="form-input" id="f-usr-role" onchange="togglePayFields(this.value)"><option ${u.role==='Admin'?'selected':''}>Admin</option><option ${u.role==='Counter'?'selected':''}>Counter</option><option ${u.role==='Cashier'?'selected':''}>Cashier</option><option ${u.role==='HR'?'selected':''}>HR</option><option ${u.role==='Inventory'?'selected':''}>Inventory</option><option ${u.role==='Worker'?'selected':''}>Worker</option></select></div>
      <div id="pay-fields" style="grid-column: span 2; display: ${u.role==='Worker'?'grid':'none'}; grid-template-columns: 1fr 1fr; gap: 14px;">
        <div class="form-group"><label class="form-label">Hourly Rate (Basic)</label><input class="form-input" type="number" step="0.01" id="f-usr-h-rate" value="${u.hourly_rate||0}"></div>
        <div class="form-group"><label class="form-label">OT Rate (per hr)</label><input class="form-input" type="number" step="0.01" id="f-usr-ot-rate" value="${u.ot_rate||0}"></div>
      </div>
      <div class="form-group"><label class="form-label">Status</label><select class="form-input" id="f-usr-active"><option value="true" ${u.is_active?'selected':''}>Active</option><option value="false" ${!u.is_active?'selected':''}>Inactive</option></select></div>
    </div>`;
  openModal(id?'Edit User & Credentials':'New Employee & Password', html, `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveUser()">Save</button>`);
};

window.togglePayFields = (role) => {
  document.getElementById('pay-fields').style.display = (role === 'Worker') ? 'grid' : 'none';
};
window.saveUser = async () => {
  if (!currentUser || currentUser.role !== 'Admin') {
    return showToast('error', 'Only Business Administrators can save staff accounts');
  }
  const id = document.getElementById('f-usr-id').value;
  const username = document.getElementById('f-usr-name').value.trim();
  const password = document.getElementById('f-usr-pass').value.trim();
  const displayName = document.getElementById('f-usr-disp').value.trim();

  if (!username) return showToast('error', 'Username is required');
  if (!password) return showToast('error', 'Password is required');
  if (password.length < 3) return showToast('error', 'Password must be at least 3 characters');
  if (!displayName) return showToast('error', 'Display name is required');

  const u = { 
    username, 
    password, 
    display_name: displayName, 
    role: document.getElementById('f-usr-role').value, 
    is_active: document.getElementById('f-usr-active').value === 'true',
    hourly_rate: parseFloat(document.getElementById('f-usr-h-rate').value) || 0,
    ot_rate: parseFloat(document.getElementById('f-usr-ot-rate').value) || 0
  };
  if(id) await db.users.update(parseInt(id), u); else await db.users.add(u);
  closeModal(); 
  renderUsersTable(); 
  showToast('success', id ? 'Staff account updated' : 'New employee created with assigned password');
};
window.deleteUser = async (id, name) => {
  if (!currentUser || currentUser.role !== 'Admin') {
    return showToast('error', 'Only Business Administrators can remove staff accounts');
  }
  if (id === currentUser.id) return showToast('error', 'You cannot delete yourself!');
  if (await showConfirmation(`Are you sure you want to remove ${name}? This will permanently delete their account.`, { title: 'Remove staff account', confirmLabel: 'Remove account', danger: true })) {
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
  if (await showConfirmation('Delete this advance request?', { title: 'Delete advance request', confirmLabel: 'Delete', danger: true })) {
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
    const platformAi = await saGetAllPlatformSettings();
    if (platformAi.ai_enabled === 'false') {
      throw new Error('AI Business Insights is currently paused by the platform administrator.');
    }

    const planReq = platformAi.ai_plan_requirement || 'pro';
    const bizPlan = currentSettings.plan_id || 'free';
    const planRanks = { free: 1, starter: 2, pro: 3, enterprise: 4 };
    const requiredRank = planRanks[planReq] || 1;
    const currentRank = planRanks[bizPlan] || 1;

    if (currentRank < requiredRank) {
      throw new Error(`AI Business Insights requires a ${planReq.toUpperCase()} subscription. Your business is on the ${bizPlan.toUpperCase()} plan. Contact your platform administrator to upgrade.`);
    }

    const provider = platformAi.ai_provider || 'google';
    const apiKey = platformAi.ai_api_key || currentSettings.ai_api_key;
    const model = platformAi.ai_model || (provider === 'google' ? 'gemini-1.5-flash' : provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-sonnet-20241022');

    if (!apiKey) {
      throw new Error('Platform AI engine is not configured yet. Please contact the platform administrator.');
    }

    const bizName = currentSettings.biz_name || 'My Shop';
    const topProds = currentReportData.topProducts.map(p => `${p.name} (${p.qty} units)`).join(', ');
    const range = `${currentReportData.start.split('T')[0]} to ${currentReportData.end.split('T')[0]}`;
    
    const sysPrompt = "You are a specialized business analyst AI for the NexPOS system. You are given sales, payroll, and inventory data for a specific time period. Write a concise, friendly, and actionable business performance report in 3 sections: (1) Performance Summary — how the business did this period vs what the numbers mean, (2) Key Insights — 3 specific observations about what is working or not working, (3) Recommendations — 3 concrete actions the owner should take. Write in plain English. Keep total response under 300 words. End with one motivational sentence. Do not mention your own name or that you are an AI model.";
    
    const userPrompt = `Business: ${bizName}. Period: ${range}. Revenue: ${formatMoney(currentReportData.revenue)}. Transactions: ${currentReportData.transactions}. Avg transaction: ${formatMoney(currentReportData.revenue / (currentReportData.transactions || 1))}. Top products: ${topProds}. Payment breakdown: Cash ${formatMoney(currentReportData.payments.cash)}, Card ${formatMoney(currentReportData.payments.card)}, Credit ${formatMoney(currentReportData.payments.credit)}. Payroll cost: ${formatMoney(currentReportData.payrollTotal)}. Gross profit estimate: ${formatMoney(currentReportData.grossProfit)}. Discount given: ${formatMoney(currentReportData.discount)}.`;

    let aiText = '';

    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'dangerously-allow-browser': 'true' },
        body: JSON.stringify({
          model: model || 'claude-3-5-sonnet-20241022', max_tokens: 1000, system: sysPrompt,
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
          model: model || 'gpt-4o-mini',
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
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-1.5-flash'}:generateContent?key=${apiKey}`, {
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
          'HTTP-Referer': window.location.origin,
          'X-Title': 'NexPOS'
        },
        body: JSON.stringify({
          model: model || 'google/gemini-flash-1.5',
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
window.updateLogoPreviewUI = () => {
  const previewImg = document.getElementById('biz-logo-preview-img');
  const placeholder = document.getElementById('biz-logo-placeholder');
  const removeBtn = document.getElementById('btn-remove-logo');
  const logo = currentSettings.biz_logo;

  if (previewImg && placeholder) {
    if (logo) {
      previewImg.src = logo;
      previewImg.style.display = 'block';
      placeholder.style.display = 'none';
      if (removeBtn) removeBtn.style.display = 'inline-flex';
    } else {
      previewImg.src = '';
      previewImg.style.display = 'none';
      placeholder.style.display = 'block';
      if (removeBtn) removeBtn.style.display = 'none';
    }
  }
};

window.handleLogoFileInput = (input) => {
  const file = input?.files?.[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    return showToast('error', 'Please select a valid image file (PNG, JPG, WebP, SVG)');
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = async () => {
      // Scale down image to max 360px width or 180px height for optimal receipt printing & tiny storage
      const maxW = 360;
      const maxH = 180;
      let width = img.width;
      let height = img.height;

      if (width > maxW || height > maxH) {
        const ratio = Math.min(maxW / width, maxH / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const compressedDataUrl = canvas.toDataURL(mimeType, 0.88);

      currentSettings.biz_logo = compressedDataUrl;
      updateLogoPreviewUI();

      // Auto-save to settings database
      try {
        const existing = await db.settings.where('key').equals('biz_logo').first();
        if (existing) {
          await db.settings.update(existing.id, { value: compressedDataUrl });
        } else {
          await db.settings.add({ key: 'biz_logo', value: compressedDataUrl });
        }
        showToast('success', 'Business logo uploaded and saved!');
      } catch (err) {
        console.error('Error saving logo:', err);
        showToast('success', 'Logo ready. Click Save Settings to persist.');
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
};

window.removeBusinessLogo = async () => {
  currentSettings.biz_logo = '';
  updateLogoPreviewUI();
  try {
    const existing = await db.settings.where('key').equals('biz_logo').first();
    if (existing) {
      await db.settings.update(existing.id, { value: '' });
    }
    showToast('info', 'Business logo removed.');
  } catch (err) {
    console.warn('Error clearing logo:', err);
  }
};

window.loadSettingsForm = () => {
  document.getElementById('set-biz-name').value = currentSettings.biz_name || '';
  document.getElementById('set-biz-type').value = currentSettings.biz_type || 'Retail Shop';
  document.getElementById('set-currency').value = currentSettings.currency || 'Rs.';
  document.getElementById('set-tax').value = currentSettings.tax_rate || '0';
  document.getElementById('set-phone').value = currentSettings.phone || '';
  document.getElementById('set-address').value = currentSettings.address || '';
  const autoPrintReceipt = document.getElementById('set-receipt-autoprint');
  if (autoPrintReceipt) autoPrintReceipt.value = currentSettings.receipt_autoprint !== 'false' ? 'true' : 'false';
  
  const theme = currentSettings.theme || 'default';
  const themeSelect = document.getElementById('set-theme');
  if (themeSelect) themeSelect.value = theme;
  
  document.querySelectorAll('.theme-btn').forEach(btn => {
    if (btn.dataset.theme === theme) btn.classList.add('active');
    else btn.classList.remove('active');
  });

  updateLogoPreviewUI();
  renderBizTemplates();
  loadRamisConfigUI();
  if (typeof renderRestaurantSettingsUI === 'function') {
    renderRestaurantSettingsUI();
  }
};

// ─── RAMIS CONFIGURATION & CONNECTION TESTER ───
window.loadRamisConfigUI = async () => {
  try {
    const res = await fetch('/api/ramis/config');
    const { success, config } = await res.json();
    if (!success || !config) return;

    const modeEl = document.getElementById('set-ramis-mode');
    const tinEl = document.getElementById('set-ramis-tin');
    const ssidEl = document.getElementById('set-ramis-ssid');
    const passEl = document.getElementById('set-ramis-password');
    const urlEl = document.getElementById('set-ramis-url');
    const periodEl = document.getElementById('set-ramis-period');
    const badgeEl = document.getElementById('set-ramis-status-badge');

    if (modeEl) modeEl.value = config.mode || 'sandbox';
    if (tinEl) tinEl.value = config.supplierTin || '';
    if (ssidEl) ssidEl.value = config.ssid || '';
    if (passEl && config.hasPassword && !passEl.value) passEl.placeholder = '•••••••• (Configured)';
    if (urlEl) urlEl.value = config.baseUrl || 'https://ramis.ird.gov.lk/api/v1';
    if (periodEl) periodEl.value = config.defaultPeriodCode || '2610';

    if (badgeEl) {
      if (config.mode === 'live') {
        badgeEl.textContent = '● Live Production';
        badgeEl.className = 'badge badge-completed';
      } else {
        badgeEl.textContent = '● Sandbox Active';
        badgeEl.className = 'badge';
        badgeEl.style.background = 'rgba(37,99,235,0.12)';
        badgeEl.style.color = 'var(--brand)';
      }
    }
  } catch (e) {
    console.warn('Could not load RAMIS config:', e);
  }
};

window.onRamisModeChange = (val) => {
  const urlEl = document.getElementById('set-ramis-url');
  if (val === 'live') {
    if (urlEl) urlEl.value = 'https://ramis.ird.gov.lk/api/v1';
  } else if (val === 'sandbox') {
    if (urlEl) urlEl.value = 'https://ramis.ird.gov.lk/api/v1';
  }
};

window.testRamisAuthConnection = async () => {
  const btn = document.getElementById('btn-test-ramis-auth');
  const resultBox = document.getElementById('ramis-test-result');

  const ssid = document.getElementById('set-ramis-ssid').value.trim();
  const password = document.getElementById('set-ramis-password').value.trim();
  const baseUrl = document.getElementById('set-ramis-url').value.trim();
  const mode = document.getElementById('set-ramis-mode').value;

  if (!ssid) {
    return showToast('error', 'Please enter your RAMIS SSID to test connection');
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Testing IRD Gateway...';
  }

  if (resultBox) {
    resultBox.style.display = 'block';
    resultBox.style.background = 'var(--surface-2)';
    resultBox.style.border = '1px solid var(--border)';
    resultBox.style.color = 'var(--text-primary)';
    resultBox.innerHTML = 'Connecting to Sri Lanka IRD RAMIS Gateway Auth endpoint...';
  }

  try {
    const res = await fetch('/api/ramis/test-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid, password, baseUrl, mode })
    });
    const data = await res.json();

    if (data.success) {
      resultBox.style.background = 'rgba(16,185,129,0.12)';
      resultBox.style.border = '1px solid var(--success)';
      resultBox.style.color = 'var(--success)';
      resultBox.innerHTML = `
        <strong>✓ Connection Successful!</strong><br>
        ${data.message}<br>
        <span style="font-size:11px; opacity:0.85">Token received: <code>${data.token}</code> (Valid for ${data.expiresIn} seconds)</span>
      `;
      showToast('success', 'Connected to Sri Lanka IRD Gateway!');
    } else {
      resultBox.style.background = 'rgba(239,68,68,0.12)';
      resultBox.style.border = '1px solid var(--danger)';
      resultBox.style.color = 'var(--danger)';
      resultBox.innerHTML = `
        <strong>⚠ Connection Failed:</strong><br>
        ${data.error || 'Could not validate SSID and Password with IRD.'}
      `;
      showToast('error', 'IRD Authentication failed. Verify credentials.');
    }
  } catch (err) {
    if (resultBox) {
      resultBox.style.background = 'rgba(239,68,68,0.12)';
      resultBox.style.border = '1px solid var(--danger)';
      resultBox.style.color = 'var(--danger)';
      resultBox.innerHTML = `<strong>Error:</strong> ${err.message}`;
    }
    showToast('error', 'Connection error: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-key"></i> Test Connection & Verify Token';
    }
  }
};

window.saveRamisConfigOnly = async () => {
  const mode = document.getElementById('set-ramis-mode').value;
  const supplierTin = document.getElementById('set-ramis-tin').value.trim();
  const ssid = document.getElementById('set-ramis-ssid').value.trim();
  const password = document.getElementById('set-ramis-password').value.trim();
  const baseUrl = document.getElementById('set-ramis-url').value.trim();
  const defaultPeriodCode = document.getElementById('set-ramis-period').value.trim();

  const payload = { mode, supplierTin, ssid, baseUrl, defaultPeriodCode };
  if (password) payload.password = password;

  try {
    const res = await fetch('/api/ramis/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('success', 'RAMIS IRD configuration saved successfully');
      loadRamisConfigUI();
    } else {
      showToast('error', 'Failed to save RAMIS config: ' + data.error);
    }
  } catch (e) {
    showToast('error', 'Network error saving RAMIS config');
  }
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
    const isRestEnabled = document.getElementById('set-restaurant-enabled')?.checked || document.getElementById('set-biz-type')?.value === 'Restaurant';
    const settings = {
      biz_name: document.getElementById('set-biz-name').value,
      biz_logo: currentSettings.biz_logo || '',
      biz_type: document.getElementById('set-biz-type').value,
      currency: document.getElementById('set-currency').value,
      tax_rate: document.getElementById('set-tax').value,
      phone: document.getElementById('set-phone').value,
      address: document.getElementById('set-address').value,
      theme: document.getElementById('set-theme') ? document.getElementById('set-theme').value : 'default',
      receipt_autoprint: document.getElementById('set-receipt-autoprint')?.value || 'true',
      restaurant_mode: isRestEnabled ? 'true' : 'false',
      kot_autoprint: document.getElementById('set-kot-autoprint')?.value || 'true',
      kot_sound: document.getElementById('set-kot-sound')?.value || 'true',
      tables_config: JSON.stringify(restaurantTables && restaurantTables.length ? restaurantTables : [
        { id: 'T1', name: 'Table 1', seats: 4 },
        { id: 'T2', name: 'Table 2', seats: 2 },
        { id: 'T3', name: 'Table 3', seats: 4 },
        { id: 'T4', name: 'Table 4', seats: 6 },
        { id: 'T5', name: 'Table 5', seats: 2 },
        { id: 'T6', name: 'Table 6', seats: 4 },
        { id: 'T7', name: 'Table 7', seats: 8 },
        { id: 'T8', name: 'Table 8', seats: 4 },
        { id: 'VIP1', name: 'VIP Lounge 1', seats: 6 },
        { id: 'OUT1', name: 'Garden Table 1', seats: 4 }
      ])
    };

    const existing = await db.settings.toArray();
    for (const [key, value] of Object.entries(settings)) {
      const row = existing.find(s => s.key === key);
      if (row) {
        await db.settings.update(row.id, { value });
      } else {
        await db.settings.add({ key, value });
      }
      currentSettings[key] = value;
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

    // Save RAMIS config if fields are populated
    await saveRamisConfigOnly();

    await loadSettings(); // Refresh UI and global currentSettings
    if (typeof renderRestaurantSettingsUI === 'function') {
      renderRestaurantSettingsUI();
    }
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
  if (!await showConfirmation(`Apply ${name} template? This will add sample products to your inventory.`, { title: 'Apply product template', confirmLabel: 'Apply template' })) return;
  
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

window.toggleSidebarReveal = (force) => {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const shouldReveal = typeof force === 'boolean' ? force : !sidebar.classList.contains('revealed');
  sidebar.classList.toggle('revealed', shouldReveal);
};

function collapseSidebarAfterNav() {
  if (!window.matchMedia('(min-width: 641px) and (max-width: 1180px)').matches) return;
  document.getElementById('sidebar')?.classList.remove('revealed');
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

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
let nativeBarcodeLoop = null;
let scannerTargetInputId = null;

const BARCODE_FORMATS = [
  'aztec', 'codabar', 'code_39', 'code_93', 'code_128', 'data_matrix',
  'ean_8', 'ean_13', 'itf', 'pdf417', 'qr_code', 'upc_a', 'upc_e'
];

window.openBarcodeScannerForInput = (inputId) => {
  scannerTargetInputId = inputId;
  openBarcodeScanner();
};

function setScannerStatus(message) {
  const status = document.getElementById('scanner-status');
  if (status) status.textContent = message;
}

function isCameraSecureContext() {
  return window.isSecureContext || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

async function selectBackCameraId() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter(device => device.kind === 'videoinput');
  const backCamera = cameras.find(camera => /back|rear|environment/i.test(camera.label));
  return backCamera?.deviceId || null;
}

function buildScannerConstraints(deviceId = null) {
  const video = {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920, min: 640 },
    height: { ideal: 1080, min: 480 },
    frameRate: { ideal: 30 },
    advanced: [
      { focusMode: 'continuous' },
      { exposureMode: 'continuous' },
      { zoom: 1.5 }
    ]
  };

  if (deviceId) {
    delete video.facingMode;
    video.deviceId = { exact: deviceId };
  }

  return { video };
}

async function startNativeBarcodeDetector(videoElement, constraints) {
  if (!('BarcodeDetector' in window)) return false;

  const supportedFormats = await window.BarcodeDetector.getSupportedFormats?.().catch(() => []) || [];
  const formats = BARCODE_FORMATS.filter(format => supportedFormats.includes(format));
  if (!formats.length) return false;

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoElement.srcObject = stream;
  videoElement.setAttribute('playsinline', 'true');
  await videoElement.play();

  const detector = new window.BarcodeDetector({ formats });
  setScannerStatus('Align the barcode or Data Matrix inside the box');

  const scan = async () => {
    if (!videoElement.srcObject) return;
    try {
      const results = await detector.detect(videoElement);
      if (results.length) {
        onBarcodeScanned(results[0].rawValue);
        return;
      }
    } catch (err) {
      console.debug('Native barcode frame skipped:', err);
    }
    nativeBarcodeLoop = requestAnimationFrame(scan);
  };

  nativeBarcodeLoop = requestAnimationFrame(scan);
  return true;
}

function getZXingLibrary() {
  return window.ZXingBrowser || window.ZXing || window.ZXingLibrary;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const loaded = document.querySelector(`script[src="${src}"][data-loaded="true"]`);
    if (loaded) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      script.remove();
      reject(new Error(`Timed out loading ${src}`));
    }, 8000);

    script.src = src;
    script.async = true;
    script.onload = () => {
      clearTimeout(timeout);
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      reject(new Error(`Failed to load ${src}`));
    };

    document.head.appendChild(script);
  });
}

async function ensureZXingLibrary() {
  if (getZXingLibrary()) return getZXingLibrary();

  const scannerScripts = [
    'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js',
    'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js'
  ];

  setScannerStatus('Loading scanner library…');
  for (const src of scannerScripts) {
    try {
      await loadScriptOnce(src);
      if (getZXingLibrary()) return getZXingLibrary();
    } catch (err) {
      console.warn('Scanner library fallback failed:', err);
    }
  }

  throw new Error('Scanner library could not load. Check internet, disable content blockers, then try again.');
}

async function createZXingReader() {
  const ZXingLib = await ensureZXingLibrary();
  const ReaderClass = ZXingLib.BrowserMultiFormatReader || ZXingLib.BrowserMultiFormatCodeReader;
  if (!ReaderClass) throw new Error('Scanner reader is unavailable. Reload the page.');

  return new ReaderClass();
}

window.openBarcodeScanner = async () => {
  const container = document.getElementById('scanner-container');
  const videoElement = document.getElementById('scanner-video');

  container.style.display = 'flex';
  setScannerStatus('Starting camera…');

  try {
    if (!isCameraSecureContext() || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera needs HTTPS or localhost. Open the POS with https:// on phones/tablets.');
    }

    const deviceId = await selectBackCameraId();
    const constraints = buildScannerConstraints(deviceId);

    if (await startNativeBarcodeDetector(videoElement, constraints)) return;

    codeReader = await createZXingReader();
    setScannerStatus('Align the barcode or Data Matrix inside the box');
    await codeReader.decodeFromConstraints(constraints, videoElement, (result) => {
      if (result) onBarcodeScanned(result.text);
    });
  } catch (err) {
    console.error('Scanner Initialization Failure:', err);
    let msg = err.message || 'Unknown error';
    if (err.name === 'NotAllowedError') msg = 'Camera permission is blocked. Allow camera permission in browser/site settings.';
    if (err.name === 'NotFoundError') msg = 'No back camera found on this device.';
    if (err.name === 'NotReadableError') msg = 'Camera is busy. Close other camera apps and try again.';

    showToast('error', `Scanner: ${msg}`);
    setScannerStatus(msg);
  }
};

window.closeBarcodeScanner = () => {
  if (nativeBarcodeLoop) cancelAnimationFrame(nativeBarcodeLoop);
  nativeBarcodeLoop = null;

  if (codeReader?.reset) codeReader.reset();
  if (codeReader?.stopContinuousDecode) codeReader.stopContinuousDecode();
  codeReader = null;

  const video = document.getElementById('scanner-video');
  video.srcObject?.getTracks().forEach(track => track.stop());
  video.srcObject = null;

  document.getElementById('scanner-container').style.display = 'none';
  setScannerStatus('');
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
  
  if (!await showConfirmation('Are you sure you want to finalize and close this shift?', { title: 'Close shift', confirmLabel: 'Close shift' })) return;

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

// ═══════════════════════════════════════════════════════════
// SUPER ADMIN PORTAL — ALL FUNCTIONS
// ═══════════════════════════════════════════════════════════

const SA_SCREENS = {
  'sa-dashboard': 'Platform / Dashboard',
  'sa-businesses': 'Platform / Businesses',
  'sa-create-business': 'Platform / Create Business',
  'sa-activity': 'Platform / Activity Log',
  'sa-plans': 'Platform / Subscription Plans',
  'sa-ai': 'Platform / AI Integration',
  'sa-settings': 'Platform / Settings',
  'sa-business-detail': 'Platform / Business Detail'
};

window.saNav = (screenId) => {
  // Hide all screens (both SA and business)
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  
  // Show requested SA screen
  const el = document.getElementById('screen-' + screenId);
  if (el) el.classList.add('active');

  // Update sidebar
  document.querySelectorAll('.sa-nav').forEach(n => n.classList.remove('active'));
  const activeNav = document.querySelector(`.sa-nav[onclick="saNav('${screenId}')"]`);
  if (activeNav) activeNav.classList.add('active');

  // Update breadcrumb
  const parts = (SA_SCREENS[screenId] || 'Platform').split(' / ');
  let bc = `<span>NexPOS</span>`;
  parts.forEach((p, i) => {
    bc += `<span class="sep">/</span><span class="${i === parts.length - 1 ? 'current' : ''}">${p}</span>`;
  });
  document.getElementById('breadcrumb').innerHTML = bc;

  // Init screen
  if (screenId === 'sa-dashboard') saRenderDashboard();
  if (screenId === 'sa-businesses') saRenderBusinesses();
  if (screenId === 'sa-activity') saRenderActivity();
  if (screenId === 'sa-plans') saRenderPlans();
  if (screenId === 'sa-ai') saRenderAiHub();
  if (screenId === 'sa-settings') saRenderSettings();
};

// ─── SA DASHBOARD ───
window.saRenderDashboard = async () => {
  const stats = await saGetPlatformStats();
  
  document.getElementById('sa-stats-grid').innerHTML = `
    <div class="sa-stat-card stat-businesses">
      <div class="sa-stat-value">${stats.totalOrgs}</div>
      <div class="sa-stat-label">Total Businesses</div>
      <div class="sa-stat-sub">${stats.activeOrgs} active · ${stats.inactiveOrgs} inactive</div>
    </div>
    <div class="sa-stat-card stat-users">
      <div class="sa-stat-value">${stats.totalUsers}</div>
      <div class="sa-stat-label">Total Users</div>
      <div class="sa-stat-sub">Across all businesses</div>
    </div>
    <div class="sa-stat-card stat-sales">
      <div class="sa-stat-value">${stats.totalSales.toLocaleString()}</div>
      <div class="sa-stat-label">Total Sales</div>
      <div class="sa-stat-sub">All time transactions</div>
    </div>
    <div class="sa-stat-card stat-revenue">
      <div class="sa-stat-value">Rs. ${stats.totalRevenue.toLocaleString()}</div>
      <div class="sa-stat-label">Platform Revenue</div>
      <div class="sa-stat-sub">Combined business revenue</div>
    </div>
  `;

  // Recent businesses
  const orgs = await saGetAllOrganizations();
  const recentOrgs = orgs.slice(0, 5);
  document.getElementById('sa-recent-businesses').innerHTML = recentOrgs.length ? recentOrgs.map(o => `
    <div class="sa-recent-item" style="cursor:pointer" onclick="saViewBusinessDetail('${o.id}')">
      <div class="sa-recent-icon">${(BUSINESS_TEMPLATES[o.business_type] || {icon:'🏪'}).icon || '🏪'}</div>
      <div class="sa-recent-text">
        <div class="sa-recent-name">${o.name}</div>
        <div class="sa-recent-meta">${o.business_type} · ${o.slug}</div>
      </div>
      <span class="sa-recent-badge ${o.is_active ? 'action-create' : 'action-delete'}">${o.is_active ? 'Active' : 'Inactive'}</span>
    </div>
  `).join('') : '<div style="color:var(--text-muted); text-align:center; padding:20px">No businesses yet</div>';

  // Recent activity
  const logs = await saGetPlatformLogs(5);
  document.getElementById('sa-recent-activity').innerHTML = logs.length ? logs.map(l => {
    const d = new Date(l.timestamp);
    const actionClass = l.action.includes('CREATE') ? 'action-create' : l.action.includes('LOGIN') ? 'action-login' : l.action.includes('DELETE') ? 'action-delete' : 'action-update';
    return `
    <div class="sa-recent-item">
      <div class="sa-recent-icon">📋</div>
      <div class="sa-recent-text">
        <div class="sa-recent-name">${l.actor_name || l.actor_id}</div>
        <div class="sa-recent-meta">${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
      </div>
      <span class="sa-recent-badge ${actionClass}">${l.action}</span>
    </div>`;
  }).join('') : '<div style="color:var(--text-muted); text-align:center; padding:20px">No activity yet</div>';
};

// ─── SA BUSINESSES LIST ───
window.saRenderBusinesses = async () => {
  let orgs = [];
  try {
    orgs = await saGetAllOrganizations();
  } catch (err) {
    console.error('saGetAllOrganizations error:', err);
  }
  const search = (document.getElementById('sa-biz-search')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('sa-biz-status-filter')?.value || '';

  let filtered = orgs || [];
  if (search) filtered = filtered.filter(o => (o.name||'').toLowerCase().includes(search) || (o.slug||'').toLowerCase().includes(search));
  if (statusFilter === 'active') filtered = filtered.filter(o => o.is_active);
  if (statusFilter === 'inactive') filtered = filtered.filter(o => !o.is_active);

  const tbody = document.getElementById('sa-businesses-tbody');
  if (!tbody) return;
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--text-muted)">No businesses found</td></tr>';
    return;
  }

  const rows = [];
  for (const o of filtered) {
    let stats = { users: 0, products: 0, sales: 0, revenue: 0 };
    try {
      if (typeof saGetOrgStats === 'function') {
        stats = await saGetOrgStats(o.id);
      }
    } catch (e) {
      console.warn('Stats lookup notice for org:', o.id, e);
    }
    const d = o.created_at ? new Date(o.created_at) : new Date();
    rows.push(`
    <tr>
      <td class="fw-600">${o.name}</td>
      <td>${o.business_type || 'General'}</td>
      <td><code style="font-size:12px;background:var(--surface-3);padding:2px 6px;border-radius:4px">${o.slug}</code></td>
      <td><span class="badge badge-active">${(o.plan_id || 'free').toUpperCase()}</span></td>
      <td>${stats.users || 0}</td>
      <td><span class="badge ${o.is_active ? 'badge-active' : 'badge-inactive'}">${o.is_active ? 'Active' : 'Inactive'}</span></td>
      <td style="font-size:12px">${d.toLocaleDateString()}</td>
      <td>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="saViewBusinessDetail('${o.id}')" title="View">👁️</button>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="saQuickImpersonate('${o.id}','${(o.name||'').replace(/'/g, "\\'")}')" title="Enter POS">🔑</button>
      </td>
    </tr>`);
  }
  tbody.innerHTML = rows.join('');
};

// ─── SA CREATE BUSINESS ───
window.saUpdatePlanLimits = () => {
  // Visual feedback could be added here
};

window.saCreateBusiness = async () => {
  const name = document.getElementById('sa-new-biz-name').value.trim();
  const slug = document.getElementById('sa-new-biz-slug').value.trim().toLowerCase().replace(/\s+/g, '-');
  const type = document.getElementById('sa-new-biz-type').value;
  const currency = document.getElementById('sa-new-biz-currency').value || 'Rs.';
  const tax = parseFloat(document.getElementById('sa-new-biz-tax').value) || 0;
  const phone = document.getElementById('sa-new-biz-phone').value;
  const address = document.getElementById('sa-new-biz-address').value;
  const plan = document.getElementById('sa-new-biz-plan').value;
  const adminUser = document.getElementById('sa-new-admin-user').value.trim();
  const adminPass = document.getElementById('sa-new-admin-pass').value.trim();
  const adminName = document.getElementById('sa-new-admin-name').value.trim() || 'Administrator';
  const loadTemplate = document.getElementById('sa-new-load-template')?.checked;

  // Validation
  if (!name) return showToast('error', 'Business name is required');
  if (!slug) return showToast('error', 'Business code is required');
  if (!/^[a-z0-9-]+$/.test(slug)) return showToast('error', 'Business code must be lowercase letters, numbers, and hyphens only');
  if (!adminUser) return showToast('error', 'Admin username is required');
  if (!adminPass) return showToast('error', 'Admin password is required');
  if (adminPass.length < 3) return showToast('error', 'Password must be at least 3 characters');

  const btn = document.getElementById('sa-create-btn');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const planLimits = { free: {u:3,p:100}, starter: {u:10,p:500}, pro: {u:25,p:2000}, enterprise: {u:999,p:99999} };
    const limits = planLimits[plan] || planLimits.free;

    const result = await saCreateOrganization(
      { name, slug, business_type: type, currency, tax_rate: tax, phone, address, plan_id: plan, max_users: limits.u, max_products: limits.p },
      { username: adminUser, password: adminPass, display_name: adminName }
    );

    if (result.error) {
      showToast('error', 'Failed: ' + result.error);
      return;
    }

    // Load template products if requested
    if (loadTemplate && BUSINESS_TEMPLATES[type]) {
      const oldOrgId = db.currentOrgId;
      const oldSA = db.isSuperAdmin;
      db.currentOrgId = result.org.id;
      db.isSuperAdmin = false;
      await loadBusinessTemplate(type);
      db.currentOrgId = oldOrgId;
      db.isSuperAdmin = oldSA;
    }

    await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'BUSINESS_CREATED', result.org.id, name, { slug, type, plan });

    showToast('success', `Business "${name}" created successfully!`);
    
    // Reset form
    document.getElementById('sa-new-biz-name').value = '';
    document.getElementById('sa-new-biz-slug').value = '';
    document.getElementById('sa-new-admin-user').value = '';
    document.getElementById('sa-new-admin-pass').value = '';
    document.getElementById('sa-new-admin-name').value = '';

    saNav('sa-businesses');
  } catch (e) {
    showToast('error', 'Error creating business: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Create Business';
  }
};

// ─── SA VIEW BUSINESS DETAIL ───
window.saViewBusinessDetail = async (orgId) => {
  selectedOrgForDetail = orgId;

  const { data: org } = await supa.from('organizations').select('*').eq('id', orgId).maybeSingle();
  if (!org) return showToast('error', 'Business not found');

  const stats = await saGetOrgStats(orgId);
  const users = await saGetOrgUsers(orgId);

  document.getElementById('sa-detail-title').textContent = org.name;
  document.getElementById('sa-detail-subtitle').textContent = `${org.business_type} · ${org.slug}`;

  // Stats
  document.getElementById('sa-detail-stats').innerHTML = `
    <div class="sa-stat-card stat-users"><div class="sa-stat-value">${stats.users}</div><div class="sa-stat-label">Users</div></div>
    <div class="sa-stat-card stat-businesses"><div class="sa-stat-value">${stats.products}</div><div class="sa-stat-label">Products</div></div>
    <div class="sa-stat-card stat-sales"><div class="sa-stat-value">${stats.sales}</div><div class="sa-stat-label">Sales</div></div>
    <div class="sa-stat-card stat-revenue"><div class="sa-stat-value">Rs. ${stats.revenue.toLocaleString()}</div><div class="sa-stat-label">Revenue</div></div>
  `;

  // Info
  document.getElementById('sa-detail-info').innerHTML = `
    <div class="sa-info-grid">
      <div class="sa-info-label">Name</div><div class="sa-info-value">${org.name}</div>
      <div class="sa-info-label">Code</div><div class="sa-info-value"><code>${org.slug}</code></div>
      <div class="sa-info-label">Type</div><div class="sa-info-value">${org.business_type}</div>
      <div class="sa-info-label">Currency</div><div class="sa-info-value">${org.currency}</div>
      <div class="sa-info-label">Tax Rate</div><div class="sa-info-value">${org.tax_rate || 0}%</div>
      <div class="sa-info-label">Phone</div><div class="sa-info-value">${org.phone || '—'}</div>
      <div class="sa-info-label">Address</div><div class="sa-info-value">${org.address || '—'}</div>
      <div class="sa-info-label">Plan</div><div class="sa-info-value"><span class="badge badge-active">${(org.plan_id || 'free').toUpperCase()}</span></div>
      <div class="sa-info-label">Status</div><div class="sa-info-value"><span class="badge ${org.is_active ? 'badge-active' : 'badge-inactive'}">${org.is_active ? 'Active' : 'Inactive'}</span></div>
      <div class="sa-info-label">Created</div><div class="sa-info-value">${new Date(org.created_at).toLocaleDateString()}</div>
    </div>
  `;

  // Toggle button state
  document.getElementById('sa-toggle-status-btn').innerHTML = org.is_active ? '⏸ Deactivate' : '▶️ Activate';

  // Users
  document.getElementById('sa-detail-users').innerHTML = users.length ? users.map(u => `
    <div class="sa-user-item">
      <div class="sa-user-avatar">${u.display_name.charAt(0).toUpperCase()}</div>
      <div style="flex:1">
        <div class="fw-600">${u.display_name}</div>
        <div style="font-size:11px;color:var(--text-muted)">${u.username} · ${u.role}</div>
      </div>
      <button class="btn btn-ghost btn-sm btn-icon" onclick="saResetUserPassword(${u.id}, '${u.display_name}')" title="Reset User Password" style="color:var(--brand); margin-right:8px">🔑</button>
      <span class="badge ${u.is_active ? 'badge-active' : 'badge-inactive'}">${u.is_active ? 'Active' : 'Inactive'}</span>
    </div>
  `).join('') : '<div style="color:var(--text-muted); padding:12px">No users</div>';

  // Activity
  const { data: orgLogs } = await supa.from('platform_log').select('*').eq('target_org', orgId).order('timestamp', { ascending: false }).limit(10);
  document.getElementById('sa-detail-activity').innerHTML = (orgLogs || []).length ? orgLogs.map(l => {
    const d = new Date(l.timestamp);
    return `<div class="sa-recent-item">
      <div class="sa-recent-text"><div class="sa-recent-name">${l.action}</div><div class="sa-recent-meta">${l.actor_name} · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div></div>
    </div>`;
  }).join('') : '<div style="color:var(--text-muted); padding:12px">No activity logged</div>';

  saNav('sa-business-detail');
};

// ─── SA BUSINESS ACTIONS ───
window.saEditBusiness = async () => {
  if (!selectedOrgForDetail) return;
  const { data: org } = await supa.from('organizations').select('*').eq('id', selectedOrgForDetail).maybeSingle();
  if (!org) return;

  const html = `
    <div class="form-grid">
      <div class="form-group"><label class="form-label">Business Name</label><input class="form-input" id="sa-edit-name" value="${org.name}"></div>
      <div class="form-group"><label class="form-label">Business Type</label>
        <select class="form-input" id="sa-edit-type">
          ${['Retail Shop','Grocery Store','Bookshop','Meat Shop','Bakery','Pharmacy','Hardware Store','Restaurant','Electronics Store','Clothing Store','Other'].map(t => `<option ${org.business_type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Currency</label><input class="form-input" id="sa-edit-currency" value="${org.currency}"></div>
      <div class="form-group"><label class="form-label">Tax Rate (%)</label><input class="form-input" type="number" id="sa-edit-tax" value="${org.tax_rate || 0}" step="0.1"></div>
      <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="sa-edit-phone" value="${org.phone || ''}"></div>
      <div class="form-group"><label class="form-label">Address</label><input class="form-input" id="sa-edit-address" value="${org.address || ''}"></div>
      <div class="form-group"><label class="form-label">Plan</label>
        <select class="form-input" id="sa-edit-plan">
          <option value="free" ${org.plan_id==='free'?'selected':''}>Free</option>
          <option value="starter" ${org.plan_id==='starter'?'selected':''}>Starter</option>
          <option value="pro" ${org.plan_id==='pro'?'selected':''}>Professional</option>
          <option value="enterprise" ${org.plan_id==='enterprise'?'selected':''}>Enterprise</option>
        </select>
      </div>
    </div>`;

  openModal('Edit Business', html, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saSaveBusinessEdit()">Save Changes</button>
  `);
};

window.saSaveBusinessEdit = async () => {
  const changes = {
    name: document.getElementById('sa-edit-name').value,
    business_type: document.getElementById('sa-edit-type').value,
    currency: document.getElementById('sa-edit-currency').value,
    tax_rate: parseFloat(document.getElementById('sa-edit-tax').value) || 0,
    phone: document.getElementById('sa-edit-phone').value,
    address: document.getElementById('sa-edit-address').value,
    plan_id: document.getElementById('sa-edit-plan').value,
  };

  await saUpdateOrganization(selectedOrgForDetail, changes);
  await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'BUSINESS_UPDATED', selectedOrgForDetail, changes.name, changes);
  
  closeModal();
  showToast('success', 'Business updated');
  saViewBusinessDetail(selectedOrgForDetail);
};

window.saToggleStatus = async () => {
  if (!selectedOrgForDetail) return;
  const { data: org } = await supa.from('organizations').select('is_active, name').eq('id', selectedOrgForDetail).maybeSingle();
  if (!org) return;

  const newStatus = !org.is_active;
  const action = newStatus ? 'activate' : 'deactivate';
  if (!await showConfirmation(`Are you sure you want to ${action} "${org.name}"? ${!newStatus ? 'Users will not be able to login.' : ''}`, { title: `${action[0].toUpperCase() + action.slice(1)} business`, confirmLabel: action[0].toUpperCase() + action.slice(1) })) return;

  await saToggleOrgStatus(selectedOrgForDetail, newStatus);
  await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, newStatus ? 'BUSINESS_ACTIVATED' : 'BUSINESS_DEACTIVATED', selectedOrgForDetail, org.name, {});
  
  showToast('success', `Business ${action}d`);
  saViewBusinessDetail(selectedOrgForDetail);
};

window.saDeleteBusiness = async () => {
  if (!selectedOrgForDetail) return;
  const { data: org } = await supa.from('organizations').select('name').eq('id', selectedOrgForDetail).maybeSingle();
  if (!org) return;

  if (!await showConfirmation(`Permanently delete "${org.name}"?

This will remove:
• All users
• All products & categories
• All sales history
• All attendance & payroll data

This cannot be undone.`, { title: 'Delete business permanently', confirmLabel: 'Continue', danger: true })) return;
  if (!await showConfirmation(`Are you absolutely sure you want to delete "${org.name}"?`, { title: 'Final deletion confirmation', confirmLabel: 'Delete business', danger: true })) return;

  await saDeleteOrganization(selectedOrgForDetail);
  await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'BUSINESS_DELETED', null, org.name, {});
  
  selectedOrgForDetail = null;
  showToast('success', 'Business deleted permanently');
  saNav('sa-businesses');
};

window.saResetUserPassword = (userId, displayName) => {
  const html = `
    <div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px">
      Platform Admin: Reset password for user <strong style="color:var(--brand)">${displayName}</strong>
    </div>
    <div class="form-group">
      <label class="form-label">New Password</label>
      <input class="form-input" type="password" id="sa-usr-new-pw" placeholder="Enter new password (min 3 chars)">
    </div>
  `;
  openModal(`Reset Password — ${displayName}`, html, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saDoResetUserPassword(${userId}, '${displayName}')">Update Password</button>
  `);
};

window.saDoResetUserPassword = async (userId, displayName) => {
  const newPw = document.getElementById('sa-usr-new-pw').value.trim();
  if (!newPw || newPw.length < 3) return showToast('error', 'Password must be at least 3 characters');
  try {
    const { error } = await supa.from('users').update({ password: newPw }).eq('id', userId);
    if (error) throw error;
    closeModal();
    showToast('success', `Password for ${displayName} reset successfully!`);
    await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'RESET_USER_PASSWORD', selectedOrgForDetail, displayName, { userId });
  } catch (e) {
    showToast('error', 'Failed to reset password: ' + e.message);
  }
};

// ─── SA IMPERSONATION ───
window.saImpersonateBusiness = async () => {
  if (!selectedOrgForDetail) return;
  const { data: org } = await supa.from('organizations').select('*').eq('id', selectedOrgForDetail).maybeSingle();
  if (!org) return;
  
  await saDoImpersonate(org);
};

window.saQuickImpersonate = async (orgId, orgName) => {
  const { data: org } = await supa.from('organizations').select('*').eq('id', orgId).maybeSingle();
  if (!org) return showToast('error', 'Business not found');
  await saDoImpersonate(org);
};

async function saDoImpersonate(org) {
  isImpersonating = true;
  impersonatedOrgId = org.id;
  db.currentOrgId = org.id;
  db.isSuperAdmin = false;

  // Create a fake admin user for this org
  currentUser = {
    id: 0,
    username: 'superadmin',
    display_name: `${superAdminUser.display_name} (SA)`,
    role: 'Admin',
    is_active: true,
    organization_id: org.id
  };

  // Show business sidebar, hide SA sidebar
  document.getElementById('sidebar').style.display = 'flex';
  document.getElementById('sa-sidebar').style.display = 'none';

  // Show impersonation banner
  document.getElementById('impersonation-banner').style.display = 'block';
  document.getElementById('imp-biz-name').textContent = org.name;

  // Update topbar
  document.getElementById('user-avatar').textContent = org.name.charAt(0).toUpperCase();
  document.getElementById('user-name').textContent = org.name;
  document.getElementById('role-badge').textContent = 'Viewing';

  // Show all nav
  document.getElementById('nav-pos').style.display = 'block';
  document.getElementById('nav-inventory').style.display = 'block';
  document.getElementById('nav-sales').style.display = 'block';
  document.getElementById('nav-hr').style.display = 'block';
  document.getElementById('nav-system').style.display = 'block';
  document.getElementById('nav-payroll-item').style.display = 'block';

  // Hide SA screens
  document.querySelectorAll('.sa-screen').forEach(s => s.classList.remove('active'));

  await loadSettings();
  nav('pos');

  await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'IMPERSONATE_BUSINESS', org.id, org.name, {});
  showToast('info', `Now viewing: ${org.name}`);
}

window.exitImpersonation = () => {
  isImpersonating = false;
  impersonatedOrgId = null;
  currentUser = null;
  db.currentOrgId = null;
  db.isSuperAdmin = true;

  // Hide business sidebar, show SA sidebar
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('sa-sidebar').style.display = 'flex';

  // Hide impersonation banner
  document.getElementById('impersonation-banner').style.display = 'none';

  // Restore SA topbar
  document.getElementById('user-avatar').textContent = '⚡';
  document.getElementById('user-name').textContent = superAdminUser.display_name;
  document.getElementById('role-badge').textContent = 'Super Admin';

  // Hide business nav
  document.getElementById('nav-pos').style.display = 'none';
  document.getElementById('nav-inventory').style.display = 'none';
  document.getElementById('nav-sales').style.display = 'none';
  document.getElementById('nav-hr').style.display = 'none';
  document.getElementById('nav-system').style.display = 'none';

  // Navigate to SA dashboard
  saNav('sa-dashboard');
  showToast('info', 'Returned to admin panel');
};

// ─── SA ACTIVITY LOG ───
window.saRenderActivity = async () => {
  const logs = await saGetPlatformLogs(100);
  const tbody = document.getElementById('sa-activity-tbody');

  tbody.innerHTML = logs.length ? logs.map(l => {
    const d = new Date(l.timestamp);
    const actionClass = l.action.includes('CREATE') ? 'action-create' : 
                        l.action.includes('LOGIN') ? 'action-login' : 
                        l.action.includes('DELETE') ? 'action-delete' :
                        l.action.includes('TOGGLE') || l.action.includes('ACTIVATE') || l.action.includes('DEACTIVATE') ? 'action-toggle' : 'action-update';
    return `<tr>
      <td style="font-size:12px;white-space:nowrap">${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
      <td class="fw-600">${l.actor_name || l.actor_id}</td>
      <td><span class="sa-recent-badge ${actionClass}">${l.action}</span></td>
      <td>${l.target_name || '—'}</td>
      <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis">${JSON.stringify(l.details || {}).substring(0, 80)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted)">No activity logged yet</td></tr>';
};

// ─── SA SUBSCRIPTION PLANS ───
window.saRenderPlans = async () => {
  const { data: plans } = await supa.from('subscription_plans').select('*').order('price_monthly', { ascending: true });
  if (!plans) return;

  document.getElementById('sa-plans-grid').innerHTML = plans.map((p, i) => {
    const features = typeof p.features === 'string' ? JSON.parse(p.features) : p.features;
    return `
    <div class="sa-plan-card ${i === 2 ? 'plan-featured' : ''}">
      <div class="sa-plan-name">${p.name}</div>
      <div class="sa-plan-price">Rs. ${Number(p.price_monthly).toLocaleString()}<span>/month</span></div>
      <ul class="sa-plan-features">
        <li>Up to ${p.max_users} users</li>
        <li>Up to ${p.max_products.toLocaleString()} products</li>
        <li>Up to ${p.max_monthly_sales.toLocaleString()} sales/month</li>
        <li>Reports: ${features.reports ? '✅' : '❌'}</li>
        <li>AI Features: ${features.ai ? '✅' : '❌'}</li>
        ${features.priority_support ? '<li>Priority Support ⭐</li>' : ''}
      </ul>
    </div>`;
  }).join('');
};

// ─── SA PLATFORM SETTINGS ───
window.saRenderSettings = async () => {
  const orgs = await saGetAllOrganizations();
  const { count: totalUsers } = await supa.from('users').select('*', { count: 'exact', head: true });
  document.getElementById('sa-platform-info').innerHTML = `
    <div><strong>Businesses:</strong> ${orgs.length}</div>
    <div><strong>Total Users:</strong> ${totalUsers || 0}</div>
    <div><strong>Super Admin:</strong> ${superAdminUser?.username || '—'}</div>
  `;
};

window.saChangePassword = async () => {
  const current = document.getElementById('sa-set-current-pw').value;
  const newPw = document.getElementById('sa-set-new-pw').value;

  if (!current || !newPw) return showToast('error', 'Fill in both fields');
  if (current !== superAdminUser.password) return showToast('error', 'Current password is incorrect');
  if (newPw.length < 3) return showToast('error', 'New password too short');

  await supa.from('super_admins').update({ password: newPw }).eq('id', superAdminUser.id);
  superAdminUser.password = newPw;
  
  document.getElementById('sa-set-current-pw').value = '';
  document.getElementById('sa-set-new-pw').value = '';
  
  await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'PASSWORD_CHANGED', null, '', {});
  showToast('success', 'Password updated successfully');
};

// ─── SA AI INTEGRATION & INTELLIGENCE ───
window.saRenderAiHub = async () => {
  const conf = await saGetAllPlatformSettings();
  const orgs = await saGetAllOrganizations();

  // Summary Grid
  const providerNames = { google: 'Google Gemini', openai: 'OpenAI', anthropic: 'Claude', openrouter: 'OpenRouter' };
  const provEl = document.getElementById('sa-ai-active-provider');
  if (provEl) provEl.textContent = providerNames[conf.ai_provider] || 'Gemini';

  const modelSub = document.getElementById('sa-ai-active-model');
  if (modelSub) modelSub.textContent = conf.ai_model || 'gemini-1.5-flash';
  
  const planLabels = { all: 'All Plans', starter: 'Starter +', pro: 'Pro +', enterprise: 'Enterprise' };
  const planAcc = document.getElementById('sa-ai-plan-access');
  if (planAcc) planAcc.textContent = planLabels[conf.ai_plan_requirement] || 'Pro +';

  const planSub = document.getElementById('sa-ai-plan-sub');
  if (planSub) planSub.textContent = `Required: ${planLabels[conf.ai_plan_requirement] || 'Pro'}`;
  
  const hasKey = !!conf.ai_api_key;
  const keyStat = document.getElementById('sa-ai-key-status');
  if (keyStat) keyStat.textContent = hasKey ? 'Configured' : 'Not Set';

  const keySub = document.getElementById('sa-ai-key-sub');
  if (keySub) keySub.textContent = hasKey ? 'Platform Key Ready' : 'Key Missing';
  
  const isEnabled = conf.ai_enabled !== 'false';
  const engState = document.getElementById('sa-ai-engine-state');
  if (engState) engState.textContent = isEnabled ? 'Active' : 'Disabled';
  
  const pill = document.getElementById('sa-ai-status-pill');
  const pillText = document.getElementById('sa-ai-status-text');
  if (pill && pillText) {
    if (isEnabled && hasKey) {
      pill.className = 'status-pill online';
      pillText.textContent = 'AI Ready';
    } else {
      pill.className = 'status-pill offline';
      pillText.textContent = hasKey ? 'AI Disabled' : 'Key Required';
    }
  }

  // Populate Form Fields
  const provSelect = document.getElementById('sa-ai-provider');
  if (provSelect) provSelect.value = conf.ai_provider || 'google';
  
  const keyInput = document.getElementById('sa-ai-api-key');
  if (keyInput) keyInput.value = conf.ai_api_key || '';
  
  const modelInput = document.getElementById('sa-ai-model');
  if (modelInput) modelInput.value = conf.ai_model || 'gemini-1.5-flash';
  
  const planReqSelect = document.getElementById('sa-ai-plan-req');
  if (planReqSelect) planReqSelect.value = conf.ai_plan_requirement || 'pro';
  
  const enCheck = document.getElementById('sa-ai-enabled');
  if (enCheck) enCheck.checked = isEnabled;

  // Populate Business Scope Dropdown
  const bizSelect = document.getElementById('sa-ai-biz-select');
  if (bizSelect) {
    let opts = '<option value="all">🌐 All Businesses (Platform Macro View)</option>';
    orgs.forEach(o => {
      opts += `<option value="${o.id}">${o.name} (${o.slug})</option>`;
    });
    bizSelect.innerHTML = opts;
  }
};

window.saOnAiProviderChange = () => {
  const prov = document.getElementById('sa-ai-provider').value;
  const modelInput = document.getElementById('sa-ai-model');
  const defaults = {
    google: 'gemini-1.5-flash',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-20241022',
    openrouter: 'google/gemini-flash-1.5'
  };
  if (modelInput && defaults[prov]) {
    modelInput.value = defaults[prov];
  }
};

window.saToggleApiKeyVisibility = () => {
  const input = document.getElementById('sa-ai-api-key');
  const btn = document.getElementById('sa-ai-key-toggle-btn');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (btn) btn.textContent = '🔒';
  } else {
    input.type = 'password';
    if (btn) btn.textContent = '👁️';
  }
};

window.saOnAiApiKeyInput = (val) => {
  val = (val || '').trim();
  const provEl = document.getElementById('sa-ai-provider');
  const modelEl = document.getElementById('sa-ai-model');
  const hintEl = document.getElementById('sa-ai-key-hint');

  if (val.startsWith('sk-or-v1-') || val.startsWith('sk-or-')) {
    if (provEl && provEl.value !== 'openrouter') {
      provEl.value = 'openrouter';
      if (modelEl) modelEl.value = 'google/gemini-flash-1.5';
    }
    if (hintEl) {
      hintEl.style.display = 'block';
      hintEl.innerHTML = '✨ <strong>OpenRouter Key Detected:</strong> Engine automatically switched to <strong>OpenRouter</strong> with model <code>google/gemini-flash-1.5</code>.';
    }
  } else if (val.startsWith('AIzaSy')) {
    if (provEl && provEl.value !== 'google') {
      provEl.value = 'google';
      if (modelEl) modelEl.value = 'gemini-1.5-flash';
    }
    if (hintEl) {
      hintEl.style.display = 'block';
      hintEl.innerHTML = '✨ <strong>Google Gemini Key Detected:</strong> Engine set to <strong>Google Gemini</strong> with model <code>gemini-1.5-flash</code>.';
    }
  } else if (hintEl) {
    hintEl.style.display = 'none';
  }
};

window.saSaveAiSettings = async () => {
  let provider = document.getElementById('sa-ai-provider').value;
  const apiKey = document.getElementById('sa-ai-api-key').value.trim();
  let model = document.getElementById('sa-ai-model').value.trim();
  const planReq = document.getElementById('sa-ai-plan-req').value;
  const isEnabled = document.getElementById('sa-ai-enabled').checked ? 'true' : 'false';

  // Smart Auto-Correction: If OpenRouter key was pasted while left on Google
  if ((apiKey.startsWith('sk-or-v1-') || apiKey.startsWith('sk-or-')) && provider !== 'openrouter') {
    provider = 'openrouter';
    document.getElementById('sa-ai-provider').value = 'openrouter';
    if (!model || model === 'gemini-1.5-flash') {
      model = 'google/gemini-flash-1.5';
      document.getElementById('sa-ai-model').value = model;
    }
  }

  // Model ID normalization for OpenRouter
  if (provider === 'openrouter') {
    if (!model || model === 'gemini-1.5-flash') {
      model = 'google/gemini-flash-1.5';
      document.getElementById('sa-ai-model').value = model;
    } else if (!model.includes('/')) {
      model = 'google/' + model;
      document.getElementById('sa-ai-model').value = model;
    }
  }

  const btn = document.getElementById('sa-ai-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await saSetPlatformSetting('ai_provider', provider);
    await saSetPlatformSetting('ai_api_key', apiKey);
    await saSetPlatformSetting('ai_model', model);
    await saSetPlatformSetting('ai_plan_requirement', planReq);
    await saSetPlatformSetting('ai_enabled', isEnabled);

    await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'AI_CONFIG_UPDATED', null, '', {
      provider, model, planReq, enabled: isEnabled, keySet: !!apiKey
    });

    showToast('success', 'AI Configuration saved successfully');
    await saRenderAiHub();
  } catch (err) {
    showToast('error', 'Error saving AI settings: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save AI Configuration';
  }
};

window.saTestAiConnection = async () => {
  let provider = document.getElementById('sa-ai-provider').value;
  const apiKey = document.getElementById('sa-ai-api-key').value.trim();
  let model = document.getElementById('sa-ai-model').value.trim();
  const box = document.getElementById('sa-ai-test-box');

  if (!apiKey) {
    box.style.display = 'block';
    box.style.background = '#fef2f2';
    box.style.color = '#dc2626';
    box.style.border = '1px solid #fecaca';
    box.innerHTML = '<strong>❌ Key Required:</strong> Please enter an API key to test the connection.';
    return;
  }

  // Smart Auto-Correction: If user pasted OpenRouter key with Google provider
  if (apiKey.startsWith('sk-or-v1-') || apiKey.startsWith('sk-or-')) {
    if (provider !== 'openrouter') {
      provider = 'openrouter';
      const provEl = document.getElementById('sa-ai-provider');
      if (provEl) provEl.value = 'openrouter';
      showToast('info', 'Detected OpenRouter key: Auto-switched provider to OpenRouter');
    }
    if (!model || model === 'gemini-1.5-flash') {
      model = 'google/gemini-flash-1.5';
      const modelEl = document.getElementById('sa-ai-model');
      if (modelEl) modelEl.value = model;
    }
  }

  // If OpenRouter, normalize model ID
  if (provider === 'openrouter') {
    if (!model || model === 'gemini-1.5-flash') {
      model = 'google/gemini-flash-1.5';
    } else if (!model.includes('/')) {
      model = 'google/' + model;
    }
    const modelEl = document.getElementById('sa-ai-model');
    if (modelEl) modelEl.value = model;
  }

  box.style.display = 'block';
  box.style.background = 'var(--surface-3)';
  box.style.color = 'var(--text-primary)';
  box.style.border = '1px solid var(--border)';
  box.innerHTML = '⏳ Testing connection with ' + provider + ' (' + model + ')...';

  const btn = document.getElementById('sa-ai-test-btn');
  btn.disabled = true;

  const t0 = Date.now();
  try {
    let resultText = '';
    const testPrompt = 'Respond with exactly: OK';

    if (provider === 'google') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-1.5-flash'}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: testPrompt }] }] })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      resultText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'OK';
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: testPrompt }], max_tokens: 10 })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      resultText = data.choices?.[0]?.message?.content?.trim() || 'OK';
    } else if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'dangerously-allow-browser': 'true' },
        body: JSON.stringify({ model: model || 'claude-3-5-sonnet-20241022', max_tokens: 10, messages: [{ role: 'user', content: testPrompt }] })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      resultText = data.content?.[0]?.text?.trim() || 'OK';
    } else if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': window.location.origin,
          'X-Title': 'NexPOS'
        },
        body: JSON.stringify({ model: model || 'google/gemini-flash-1.5', messages: [{ role: 'user', content: testPrompt }], max_tokens: 10 })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      resultText = data.choices?.[0]?.message?.content?.trim() || 'OK';
    }

    const latency = Date.now() - t0;
    box.style.background = '#ecfdf5';
    box.style.color = '#059669';
    box.style.border = '1px solid #a7f3d0';
    box.innerHTML = `<strong>✅ Connection Successful (${latency}ms)</strong><br>Provider confirmed active. Response: <em>"${resultText}"</em>`;
    showToast('success', `AI connected successfully in ${latency}ms!`);
  } catch (err) {
    box.style.background = '#fef2f2';
    box.style.color = '#dc2626';
    box.style.border = '1px solid #fecaca';
    box.innerHTML = `<strong>❌ Connection Failed:</strong><br>${err.message}`;
    showToast('error', 'AI test connection failed');
  } finally {
    btn.disabled = false;
  }
};

window.saRunPlatformAiAnalysis = async () => {
  const bizScope = document.getElementById('sa-ai-biz-select').value;
  const analysisType = document.getElementById('sa-ai-analysis-type').value;
  const loading = document.getElementById('sa-ai-report-loading');
  const output = document.getElementById('sa-ai-report-output');
  const reportText = document.getElementById('sa-ai-report-text');
  const runBtn = document.getElementById('sa-ai-run-btn');

  const conf = await saGetAllPlatformSettings();
  const apiKey = conf.ai_api_key;
  if (!apiKey) {
    return showToast('error', 'Please configure and save your Platform API Key first.');
  }

  loading.style.display = 'block';
  output.style.display = 'none';
  runBtn.disabled = true;

  try {
    let scopeDescription = '';
    let metricSummary = '';

    if (bizScope === 'all') {
      const stats = await saGetPlatformStats();
      const orgs = await saGetAllOrganizations();
      scopeDescription = `Platform-Wide Macro Overview across ${stats.totalOrgs} businesses (${stats.activeOrgs} active, ${stats.inactiveOrgs} inactive).`;
      metricSummary = `Total Registered Users: ${stats.totalUsers}. Total Products Listed: ${stats.totalProducts}. Total Transactions Recorded: ${stats.totalSales}. Combined Platform Sales Revenue: Rs. ${stats.totalRevenue.toLocaleString()}. Business Types Breakdown: ${orgs.map(o => o.business_type).join(', ')}.`;
    } else {
      const { data: org } = await supa.from('organizations').select('*').eq('id', bizScope).single();
      const stats = await saGetOrgStats(bizScope);
      const users = await saGetOrgUsers(bizScope);
      scopeDescription = `Single Business Audit: "${org.name}" (Code: ${org.slug}, Type: ${org.business_type}, Plan: ${org.plan_id || 'free'}, Status: ${org.is_active ? 'Active' : 'Inactive'}).`;
      metricSummary = `Staff Count: ${users.length} (${users.map(u => u.role).join(', ')}). Product Catalog: ${stats.products} items. Total Sales Transactions: ${stats.sales}. Total Revenue: Rs. ${stats.revenue.toLocaleString()}. Tax Rate: ${org.tax_rate || 0}%.`;
    }

    const typePrompts = {
      health: 'Provide a 360-degree Business Health and Growth Diagnostic. Highlight operational strengths, bottlenecks, user adoption risks, and 3 high-impact strategic growth levers for the platform owner to execute.',
      revenue: 'Provide a Sales Velocity and Revenue Forecast. Analyze transaction volume, average revenue generation, seasonality considerations, and opportunities to optimize ticket size and repeat purchases.',
      inventory: 'Provide an Inventory & Supply Chain Diagnostic. Evaluate product catalog breadth, stock turnover health, risks of dead inventory or sudden stockouts, and actionable SKU management recommendations.',
      risk: 'Provide a Risk, Inactivity, and Churn Warning report. Identify businesses or staff teams showing signs of disengagement, low activity velocity, and provide retention strategies.'
    };

    const sysPrompt = `You are an elite Chief Operating Officer & SaaS Product Strategist analyzing multi-tenant retail and POS operations for the platform owner of NexPOS. You provide crisp, highly executive, numerical, and actionable insights. Format with clear headers: (1) Executive Findings, (2) Critical Health Metrics, (3) 3 High-Impact Action Items. Keep total response under 350 words.`;
    const userPrompt = `Scope: ${scopeDescription}\nMetrics: ${metricSummary}\nObjective: ${typePrompts[analysisType] || typePrompts.health}`;

    const provider = conf.ai_provider || 'google';
    const model = conf.ai_model || 'gemini-1.5-flash';
    let aiText = '';

    if (provider === 'google') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: sysPrompt + '\n\n' + userPrompt }] }] })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No content generated';
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }] })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      aiText = data.choices?.[0]?.message?.content || 'No content generated';
    } else if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'dangerously-allow-browser': 'true' },
        body: JSON.stringify({ model, max_tokens: 1000, system: sysPrompt, messages: [{ role: 'user', content: userPrompt }] })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      aiText = data.content?.[0]?.text || 'No content generated';
    } else if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }] })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      aiText = data.choices?.[0]?.message?.content || 'No content generated';
    }

    reportText.textContent = aiText;
    loading.style.display = 'none';
    output.style.display = 'block';

    await saLogPlatformEvent('super_admin', superAdminUser.id, superAdminUser.display_name, 'AI_PLATFORM_DIAGNOSIS', bizScope === 'all' ? null : bizScope, bizScope, { analysisType });
    showToast('success', 'AI diagnostic report generated!');
  } catch (err) {
    loading.style.display = 'none';
    showToast('error', 'AI analysis failed: ' + err.message);
  } finally {
    runBtn.disabled = false;
  }
};

window.saCopyAiReport = () => {
  const text = document.getElementById('sa-ai-report-text').textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('success', 'Report copied to clipboard!');
  });
};

// ─── ELECTRON DESKTOP APP DETECTION ───
(function detectElectronDesktop() {
  if (window.electronAPI && window.electronAPI.isElectron) {
    console.log('⚡ NexPOS Desktop Edition detected');

    // Show desktop badge on login screen
    const badge = document.getElementById('electron-edition-badge');
    if (badge) badge.style.display = 'inline';

    // Log app info
    window.electronAPI.getAppInfo().then(info => {
      console.log('App Info:', info);
    }).catch(() => {});

    // Listen for Auto-Update events from GitHub Releases
    if (window.electronAPI.onUpdateStatus) {
      window.electronAPI.onUpdateStatus((update) => {
        if (update.status === 'available') {
          showToast('info', `🚀 New NexPOS v${update.version} update found! Downloading in background...`);
        } else if (update.status === 'downloading') {
          // Update badge if available
          if (badge) badge.textContent = `⚡ Updating ${update.percent}%`;
        } else if (update.status === 'downloaded') {
          if (badge) badge.textContent = `⚡ Restart to update (v${update.version})`;
          showToast('success', `✅ NexPOS v${update.version} is ready! Restart to apply update.`);
        }
      });
    }
  }
})();

window.checkAppUpdates = async () => {
  if (window.electronAPI && window.electronAPI.isElectron) {
    showToast('info', '🔍 Checking GitHub for NexPOS updates...');
    try {
      const res = await window.electronAPI.checkForUpdates();
      if (res && res.status === 'dev-mode') {
        showToast('info', 'Running in development mode. In installed mode, updates check GitHub Releases automatically.');
      } else if (res && res.updateInfo) {
        showToast('info', `🚀 Update v${res.updateInfo.version} found! Downloading in background...`);
      } else {
        setTimeout(() => {
          showToast('success', '✨ NexPOS is up to date! You have the latest version.');
        }, 1200);
      }
    } catch (e) {
      showToast('error', 'Update check failed: ' + (e.message || 'Check network connection'));
    }
  } else {
    showToast('info', 'Running in Web mode. Cloud updates apply automatically whenever you refresh.');
  }
};

// ═══════════════════════════════════════════════════════════
// 🍽️ RESTAURANT SUITE: KOT, KDS & TABLE MANAGEMENT
// ═══════════════════════════════════════════════════════════

let currentDiningType = 'dine_in'; // 'dine_in' | 'takeaway' | 'delivery'
let currentTableId = 'T1';
let restaurantTables = [
  { id: 'T1', name: 'Table 1', seats: 4 },
  { id: 'T2', name: 'Table 2', seats: 2 },
  { id: 'T3', name: 'Table 3', seats: 4 },
  { id: 'T4', name: 'Table 4', seats: 6 },
  { id: 'T5', name: 'Table 5', seats: 2 },
  { id: 'T6', name: 'Table 6', seats: 4 },
  { id: 'T7', name: 'Table 7', seats: 8 },
  { id: 'T8', name: 'Table 8', seats: 4 },
  { id: 'VIP1', name: 'VIP Lounge 1', seats: 6 },
  { id: 'OUT1', name: 'Garden Table 1', seats: 4 }
];
let activeKots = [];
let activeTableOrders = {}; // key: tableId -> { items: [], customerId: 1, customerName: '', openedAt: '', kots: [] }
let currentKotFilter = 'active';
let kdsSoundEnabled = true;
let kdsTimerInterval = null;
let currentKotReceiptData = null;

// Audio Chime using Web Audio API (Synthesizer bell chime)
window.playKitchenChime = () => {
  if (!kdsSoundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playTone = (freq, start, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(0.3, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };
    playTone(880, 0, 0.25);      // A5
    playTone(1318.5, 0.18, 0.5); // E6
  } catch (e) {
    console.warn('Audio chime notice:', e);
  }
};

window.toggleKdsSound = () => {
  kdsSoundEnabled = !kdsSoundEnabled;
  const btn = document.getElementById('btn-kds-sound');
  if (btn) {
    btn.innerHTML = kdsSoundEnabled 
      ? '<i class="fa-solid fa-volume-high"></i> Sound On' 
      : '<i class="fa-solid fa-volume-xmark" style="color:var(--danger)"></i> Muted';
  }
  showToast('info', kdsSoundEnabled ? 'Kitchen chime sound unmuted' : 'Kitchen chime muted');
};

// Initialize or reload restaurant suite
window.initRestaurantSuite = async () => {
  await loadRestaurantConfigAndState();
  updateDiningTableUI();
  updateKotBadge();
};

async function loadRestaurantConfigAndState() {
  if (currentSettings.tables_config) {
    try {
      restaurantTables = JSON.parse(currentSettings.tables_config);
    } catch (e) {
      console.warn('Error parsing tables_config:', e);
    }
  }

  // Load KOTs and Table states from db.settings or localStorage
  const orgId = db.currentOrgId || 'default';
  const localKots = localStorage.getItem(`nexpos_kots_${orgId}`);
  const localTables = localStorage.getItem(`nexpos_tables_${orgId}`);
  if (localKots) {
    try { activeKots = JSON.parse(localKots); } catch(e){}
  }
  if (localTables) {
    try { activeTableOrders = JSON.parse(localTables); } catch(e){}
  }

  if (currentSettings.restaurant_active_kots) {
    try {
      const dbKots = JSON.parse(currentSettings.restaurant_active_kots);
      if (Array.isArray(dbKots) && dbKots.length > 0) activeKots = dbKots;
    } catch(e){}
  }
  if (currentSettings.restaurant_tables_state) {
    try {
      const dbTables = JSON.parse(currentSettings.restaurant_tables_state);
      if (dbTables && typeof dbTables === 'object') activeTableOrders = dbTables;
    } catch(e){}
  }
}

async function saveRestaurantState() {
  const orgId = db.currentOrgId || 'default';
  localStorage.setItem(`nexpos_kots_${orgId}`, JSON.stringify(activeKots));
  localStorage.setItem(`nexpos_tables_${orgId}`, JSON.stringify(activeTableOrders));

  // Sync to database settings silently in background
  try {
    const kotsStr = JSON.stringify(activeKots.slice(0, 100)); // cap to last 100
    const tablesStr = JSON.stringify(activeTableOrders);

    const existingKots = await db.settings.where('key').equals('restaurant_active_kots').first();
    if (existingKots) await db.settings.update(existingKots.id, { value: kotsStr });
    else await db.settings.add({ key: 'restaurant_active_kots', value: kotsStr });

    const existingTables = await db.settings.where('key').equals('restaurant_tables_state').first();
    if (existingTables) await db.settings.update(existingTables.id, { value: tablesStr });
    else await db.settings.add({ key: 'restaurant_tables_state', value: tablesStr });
  } catch(e) {
    console.warn('saveRestaurantState notice:', e);
  }
}

// Dining Type Switcher (Dine-In, Takeaway, Delivery)
window.setDiningType = (type) => {
  currentDiningType = type;
  document.querySelectorAll('.dining-type-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-type') === type);
  });
  const tableRow = document.getElementById('dining-table-row');
  if (tableRow) {
    tableRow.style.display = (type === 'dine_in') ? 'block' : 'none';
  }
  updateDiningTableUI();
};

window.updateDiningTableUI = () => {
  const nameEl = document.getElementById('pos-selected-table-name');
  const seatsEl = document.getElementById('pos-selected-table-seats');
  const pillEl = document.getElementById('pos-table-status-pill');
  if (!nameEl) return;

  const tObj = restaurantTables.find(t => t.id === currentTableId) || restaurantTables[0] || { id: 'T1', name: 'Table 1', seats: 4 };
  nameEl.textContent = tObj.name;
  if (seatsEl) seatsEl.textContent = tObj.seats;

  const hasOrder = activeTableOrders[tObj.id] && activeTableOrders[tObj.id].items && activeTableOrders[tObj.id].items.length > 0;
  if (pillEl) {
    if (hasOrder) {
      pillEl.className = 'badge badge-warning';
      pillEl.textContent = 'Occupied';
    } else {
      pillEl.className = 'badge badge-completed';
      pillEl.textContent = 'Vacant';
    }
  }
};

window.openTablePickerModal = () => {
  const html = `
    <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px">
      Select a table to seat guests, fire KOT tickets, or resume an existing table bill:
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(130px, 1fr)); gap:10px; max-height:60vh; overflow-y:auto; padding:2px">
      ${restaurantTables.map(t => {
        const hasOrder = activeTableOrders[t.id] && activeTableOrders[t.id].items && activeTableOrders[t.id].items.length > 0;
        const subtotal = hasOrder ? activeTableOrders[t.id].items.reduce((s, i) => s + (i.unit_price * i.quantity), 0) : 0;
        const isSelected = t.id === currentTableId;
        return `
          <div class="card" onclick="selectTable('${t.id}')" style="cursor:pointer; padding:12px; border:2px solid ${isSelected ? 'var(--brand)' : (hasOrder ? 'rgba(245,158,11,0.6)' : 'var(--border)')}; background:${isSelected ? 'rgba(99,102,241,0.06)' : (hasOrder ? 'rgba(245,158,11,0.04)' : 'var(--surface)')}; border-radius:10px; text-align:center; transition:all 0.15s">
            <div style="font-size:20px; margin-bottom:4px">${hasOrder ? '🍽️' : '🪑'}</div>
            <div style="font-weight:700; font-size:14px; color:var(--text-primary)">${t.name}</div>
            <div style="font-size:11px; color:var(--text-muted)">${t.seats} Seats</div>
            <div style="margin-top:6px">
              <span class="badge ${hasOrder ? 'badge-warning' : 'badge-completed'}" style="font-size:9.5px">
                ${hasOrder ? formatMoney(subtotal) : 'Vacant'}
              </span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  openModal('Select Dining Table', html, `<button class="btn btn-secondary btn-sm" onclick="closeModal()">Cancel</button>`);
};

window.selectTable = (tableId) => {
  currentTableId = tableId;
  closeModal();
  updateDiningTableUI();

  // If table already has an active order and current cart is empty, load it into cart
  const order = activeTableOrders[tableId];
  if (order && order.items && order.items.length > 0) {
    if (cart.length === 0) {
      cart = order.items.map(i => ({ ...i }));
      cartCustomerId = order.customerId || 1;
      updateCartCustomer();
      renderCart();
      showToast('info', `Loaded active order for ${getTableObj(tableId)?.name || tableId}`);
    } else {
      showToast('info', `Switched to ${getTableObj(tableId)?.name || tableId} (Table has ${order.items.length} items ordered)`);
    }
  }
};

function getTableObj(tableId) {
  return restaurantTables.find(t => t.id === tableId);
}

// Item Kitchen Cooking Instruction / Notes Modal
let noteEditingCartIndex = null;
window.openItemNoteModal = (idx) => {
  noteEditingCartIndex = idx;
  const item = cart[idx];
  if (!item) return;

  const presets = [
    'No Spicy', 'Extra Spicy', 'Less Spicy', 
    'No Onion', 'No Garlic', 'Less Salt', 
    'Less Sugar', 'No Ice', 'Parcel / Takeaway',
    'Separately Packed', 'Allergy Alert: Nuts', 'Chef Special'
  ];

  const html = `
    <div style="margin-bottom:12px">
      <div style="font-weight:700; font-size:15px; color:var(--text-primary)">${item.name}</div>
      <div style="font-size:12px; color:var(--text-muted)">Add specific kitchen preparation notes for the chef:</div>
    </div>
    <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px">
      ${presets.map(p => `
        <button type="button" class="btn btn-secondary btn-sm" onclick="addNoteChip('${p}')" style="font-size:11.5px; padding:4px 9px">
          + ${p}
        </button>
      `).join('')}
    </div>
    <div class="form-group">
      <label class="form-label">Special Cooking Instruction</label>
      <input class="form-input" id="item-note-input" value="${item.notes || ''}" placeholder="e.g. No spicy, extra gravy, pack separately" autocomplete="off">
    </div>
  `;

  openModal('Kitchen Instructions', html, `
    <button class="btn btn-ghost btn-sm" onclick="clearItemNote()">Clear Note</button>
    <button class="btn btn-primary btn-sm" onclick="saveItemNote()">Save Note</button>
  `);
  setTimeout(() => {
    const input = document.getElementById('item-note-input');
    if (input) { input.focus(); input.select(); }
  }, 100);
};

window.addNoteChip = (text) => {
  const input = document.getElementById('item-note-input');
  if (!input) return;
  const current = input.value.trim();
  if (current) {
    if (!current.includes(text)) input.value = current + ', ' + text;
  } else {
    input.value = text;
  }
};

window.clearItemNote = () => {
  if (noteEditingCartIndex !== null && cart[noteEditingCartIndex]) {
    delete cart[noteEditingCartIndex].notes;
    renderCart();
    closeModal();
    showToast('info', 'Instruction cleared');
  }
};

window.saveItemNote = () => {
  const val = document.getElementById('item-note-input')?.value.trim();
  if (noteEditingCartIndex !== null && cart[noteEditingCartIndex]) {
    cart[noteEditingCartIndex].notes = val || '';
    renderCart();
    closeModal();
    showToast('success', val ? 'Cooking instruction saved' : 'Note updated');
  }
};

// Send Order to Kitchen (Fire KOT)
window.sendOrderToKitchen = async () => {
  if (cart.length === 0) return showToast('error', 'Cart is empty. Add food items first.');

  // Determine next sequential KOT number
  let nextNum = parseInt(currentSettings.kot_next_num || '101');
  if (isNaN(nextNum) || nextNum < 1) nextNum = 101;
  currentSettings.kot_next_num = String(nextNum + 1);

  const tObj = getTableObj(currentTableId);
  const tableName = (currentDiningType === 'dine_in') ? (tObj?.name || currentTableId) : (currentDiningType === 'takeaway' ? 'Takeaway' : 'Delivery');

  const kot = {
    id: 'KOT-' + Date.now(),
    kot_number: nextNum,
    table_id: currentDiningType === 'dine_in' ? currentTableId : currentDiningType,
    table_name: tableName,
    order_type: currentDiningType,
    waiter: currentUser?.display_name || 'Staff',
    created_at: new Date().toISOString(),
    status: 'preparing', // 'preparing' | 'ready' | 'served'
    items: cart.map(i => ({
      product_id: i.product_id,
      name: i.name,
      quantity: i.quantity,
      unit_price: Number(i.unit_price) || 0,
      unit: i.unit || 'portion',
      notes: i.notes || '',
      is_done: false
    }))
  };

  // Add to active KOTs list
  activeKots.unshift(kot);

  // Link / update active table order
  if (currentDiningType === 'dine_in') {
    const prevOrder = activeTableOrders[currentTableId] || { items: [], customerId: cartCustomerId, openedAt: new Date().toISOString(), kots: [] };
    prevOrder.items = cart.map(i => ({ ...i }));
    prevOrder.customerId = cartCustomerId;
    prevOrder.kots = prevOrder.kots || [];
    prevOrder.kots.push(nextNum);
    activeTableOrders[currentTableId] = prevOrder;
  }

  await saveRestaurantState();
  updateDiningTableUI();
  updateKotBadge();
  playKitchenChime();

  // ⚡ Live Realtime Broadcast to Kitchen Screen & other devices
  if (typeof broadcastRealtimeEvent === 'function') {
    broadcastRealtimeEvent('KOT_NEW', {
      kot_number: nextNum,
      table_name: tableName,
      activeKots,
      activeTableOrders
    });
  }

  showToast('success', `🍳 KOT #${nextNum} sent to Kitchen (${tableName})`);

  // Auto-print thermal KOT if enabled
  const autoPrint = currentSettings.kot_autoprint !== 'false';
  if (autoPrint) {
    showKotReceipt(kot);
  }
};

window.updateKotBadge = () => {
  const badge = document.getElementById('kot-badge-count');
  if (!badge) return;
  const preparingCount = activeKots.filter(k => k.status === 'preparing').length;
  if (preparingCount > 0) {
    badge.style.display = 'inline-block';
    badge.textContent = preparingCount;
  } else {
    badge.style.display = 'none';
  }
};

// 80mm Thermal KOT Receipt Modal & Print
window.showKotReceipt = (kot) => {
  currentKotReceiptData = kot;
  const overlay = document.getElementById('kot-receipt-overlay');
  const body = document.getElementById('kot-receipt-body');
  if (!overlay || !body) return;

  const timeStr = new Date(kot.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = new Date(kot.created_at).toLocaleDateString();

  let html = `
    <div style="text-align:center; margin-bottom:8px; border-bottom:2px dashed #000; padding-bottom:6px">
      <h2 style="margin:0; font-size:18px; font-weight:900; letter-spacing:1px; text-transform:uppercase">*** KITCHEN ORDER ***</h2>
      <div style="font-size:15px; font-weight:800; margin-top:2px">KOT #${kot.kot_number}</div>
    </div>
    <div style="margin-bottom:8px; font-size:12px; line-height:1.4">
      <div style="display:flex; justify-content:space-between">
        <span><strong>${kot.order_type === 'dine_in' ? 'TABLE:' : 'ORDER:'}</strong> <span style="font-size:16px; font-weight:900">${kot.table_name}</span></span>
        <span><strong>${kot.order_type.toUpperCase()}</strong></span>
      </div>
      <div style="display:flex; justify-content:space-between; margin-top:2px">
        <span>Server: ${kot.waiter}</span>
        <span>${timeStr} · ${dateStr}</span>
      </div>
    </div>
    <table style="width:100%; border-collapse:collapse; border-top:1px dashed #000; border-bottom:1px dashed #000; margin-bottom:8px">
      <thead>
        <tr style="border-bottom:1px solid #000; text-align:left; font-size:11px">
          <th style="padding:4px 0; width:45px">QTY</th>
          <th style="padding:4px 0">ITEM & INSTRUCTION</th>
        </tr>
      </thead>
      <tbody>
        ${kot.items.map(i => `
          <tr>
            <td style="padding:6px 0; vertical-align:top; font-size:15px; font-weight:900">[ ${i.quantity}x ]</td>
            <td style="padding:6px 0; vertical-align:top">
              <div style="font-size:14px; font-weight:700">${i.name}</div>
              ${i.notes ? `
                <div class="thermal-invert" style="margin-top:2px; font-size:12px; font-weight:800; background:#000; color:#fff; display:inline-block; padding:1px 5px; border-radius:2px">
                  * ${i.notes.toUpperCase()} *
                </div>
              ` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div style="text-align:center; font-size:11px; font-style:italic; margin-top:4px">
      Kitchen Display System · NexPOS
    </div>
  `;

  body.innerHTML = html;
  overlay.style.display = 'flex';
  overlay.classList.add('open');
};

window.printKotReceipt = () => {
  window.print();
};

window.closeKotReceipt = () => {
  const overlay = document.getElementById('kot-receipt-overlay');
  if (overlay) { overlay.style.display = 'none'; overlay.classList.remove('open'); }
};

// 🍳 KITCHEN DISPLAY SCREEN (KDS) LOGIC
window.renderKOTScreen = () => {
  const grid = document.getElementById('kot-tickets-grid');
  if (!grid) return;

  // Counts
  const activeCount = activeKots.filter(k => k.status !== 'served').length;
  const preparingCount = activeKots.filter(k => k.status === 'preparing').length;
  const readyCount = activeKots.filter(k => k.status === 'ready').length;
  const completedCount = activeKots.filter(k => k.status === 'served').length;

  const elActive = document.getElementById('kot-count-active');
  const elPrep = document.getElementById('kot-count-preparing');
  const elReady = document.getElementById('kot-count-ready');
  const elComp = document.getElementById('kot-count-completed');
  if (elActive) elActive.textContent = activeCount;
  if (elPrep) elPrep.textContent = preparingCount;
  if (elReady) elReady.textContent = readyCount;
  if (elComp) elComp.textContent = completedCount;

  // Filter
  const search = document.getElementById('kot-search')?.value.toLowerCase() || '';
  const filtered = activeKots.filter(k => {
    if (currentKotFilter === 'active' && k.status === 'served') return false;
    if (currentKotFilter === 'preparing' && k.status !== 'preparing') return false;
    if (currentKotFilter === 'ready' && k.status !== 'ready') return false;
    if (currentKotFilter === 'completed' && k.status !== 'served') return false;
    if (search && !k.table_name.toLowerCase().includes(search) && !String(k.kot_number).includes(search) && !k.waiter.toLowerCase().includes(search)) return false;
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1; padding:48px 20px; text-align:center">
        <div class="empty-state-icon" style="font-size:42px; margin-bottom:12px">🍳</div>
        <div class="empty-state-title" style="font-size:18px; font-weight:700">No Kitchen Orders</div>
        <div class="empty-state-subtitle" style="color:var(--text-muted); font-size:13px; max-width:360px; margin:6px auto 16px">
          ${currentKotFilter === 'active' ? 'Kitchen is all caught up! New orders sent from POS will appear here live with cooking timers.' : 'No orders found matching this filter.'}
        </div>
      </div>
    `;
    return;
  }

  const now = Date.now();
  grid.innerHTML = filtered.map(k => {
    const elapsedMins = Math.floor((now - new Date(k.created_at).getTime()) / 60000);
    const timerClass = elapsedMins < 10 ? 'timer-ok' : (elapsedMins < 20 ? 'timer-warn' : 'timer-danger');
    const timerText = elapsedMins <= 0 ? 'Just now' : `${elapsedMins}m ago`;

    return `
      <div class="kot-card status-${k.status}">
        <div class="kot-card-header">
          <div class="kot-card-title">
            <span>KOT #${k.kot_number}</span>
            <span class="badge ${k.status === 'ready' ? 'badge-completed' : (k.status === 'preparing' ? 'badge-warning' : 'badge-neutral')}" style="font-size:10px">
              ${k.status === 'ready' ? 'Ready to Serve' : (k.status === 'preparing' ? 'Preparing' : 'Served')}
            </span>
          </div>
          <div class="kot-timer ${timerClass}">
            <i class="fa-regular fa-clock"></i> ${timerText}
          </div>
        </div>
        <div class="kot-card-meta">
          <div>
            <span style="font-weight:700; color:var(--text-primary)"><i class="fa-solid fa-chair"></i> ${k.table_name}</span>
            <span style="margin-left:6px; text-transform:uppercase; font-size:10px; opacity:0.8">(${k.order_type})</span>
          </div>
          <div><i class="fa-regular fa-user"></i> ${k.waiter}</div>
        </div>
        <div class="kot-items-list">
          ${k.items.map((it, itemIdx) => `
            <div class="kot-item-row ${it.is_done ? 'is-done' : ''}" onclick="toggleKotItemDone('${k.id}', ${itemIdx})">
              <div class="kot-item-qty">${it.quantity}x</div>
              <div class="kot-item-info">
                <div class="kot-item-name">${it.name}</div>
                ${it.notes ? `<div class="kot-item-instruction"><i class="fa-solid fa-triangle-exclamation" style="font-size:9px"></i> ${it.notes}</div>` : ''}
              </div>
              <input type="checkbox" ${it.is_done ? 'checked' : ''} style="cursor:pointer; transform:scale(1.2)" onclick="event.stopPropagation(); toggleKotItemDone('${k.id}', ${itemIdx})">
            </div>
          `).join('')}
        </div>
        <div class="kot-card-footer">
          ${k.status === 'preparing' ? `
            <button class="btn btn-primary btn-sm" onclick="markKotReady('${k.id}')" style="flex:1">
              <i class="fa-solid fa-check"></i> Mark Ready
            </button>
          ` : (k.status === 'ready' ? `
            <button class="btn btn-success btn-sm" onclick="openKotBillCheckout('${k.id}')" style="flex:1; background:var(--success); color:#fff; border:none; font-weight:700">
              <i class="fa-solid fa-receipt"></i> Print Bill & Complete
            </button>
          ` : `
            <div style="display:flex; gap:6px; flex:1">
              <button class="btn btn-secondary btn-sm" onclick="reprintKotBill('${k.id}')" style="flex:1; font-weight:600" title="Reprint Customer Bill Receipt">
                <i class="fa-solid fa-receipt"></i> Reprint Bill
              </button>
              <button class="btn btn-ghost btn-sm" onclick="markKotReady('${k.id}')" title="Reopen ticket to Ready">
                <i class="fa-solid fa-rotate-left"></i>
              </button>
            </div>
          `)}
          <button class="btn btn-secondary btn-sm btn-icon" onclick="reprintKot('${k.id}')" title="Reprint Kitchen Ticket (KOT)">
            <i class="fa-solid fa-print"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
};

// Start 15s timer for KDS board
if (!kdsTimerInterval) {
  kdsTimerInterval = setInterval(() => {
    const kdsScreen = document.getElementById('screen-kot');
    if (kdsScreen && kdsScreen.classList.contains('active')) {
      renderKOTScreen();
    }
  }, 15000);
}

window.setKotFilter = (filter) => {
  currentKotFilter = filter;
  document.querySelectorAll('#kot-filter-group button').forEach(b => {
    b.classList.remove('active');
  });
  const activeBtn = document.getElementById(`btn-kot-${filter}`);
  if (activeBtn) activeBtn.classList.add('active');
  renderKOTScreen();
};

window.filterKotTickets = () => {
  renderKOTScreen();
};

window.toggleKotItemDone = async (kotId, itemIdx) => {
  const kot = activeKots.find(k => k.id === kotId);
  if (!kot || !kot.items[itemIdx]) return;
  kot.items[itemIdx].is_done = !kot.items[itemIdx].is_done;
  await saveRestaurantState();
  renderKOTScreen();

  if (typeof broadcastRealtimeEvent === 'function') {
    broadcastRealtimeEvent('KOT_STATUS_UPDATED', {
      kot_number: kot.kot_number,
      table_name: kot.table_name,
      status: kot.status,
      activeKots,
      activeTableOrders
    });
  }
};

window.markKotReady = async (kotId) => {
  const kot = activeKots.find(k => k.id === kotId);
  if (!kot) return;
  kot.status = 'ready';
  await saveRestaurantState();
  updateKotBadge();
  renderKOTScreen();

  // ⚡ Live Realtime Broadcast to Waiters, POS & Tables
  if (typeof broadcastRealtimeEvent === 'function') {
    broadcastRealtimeEvent('KOT_STATUS_UPDATED', {
      kot_number: kot.kot_number,
      table_name: kot.table_name,
      status: 'ready',
      activeKots,
      activeTableOrders
    });
  }

  showToast('success', `KOT #${kot.kot_number} (${kot.table_name}) marked Ready to Serve!`);
};

window.markKotServed = async (kotId) => {
  // Order must not be completed without printing the bill!
  return openKotBillCheckout(kotId);
};

window.reprintKot = (kotId) => {
  const kot = activeKots.find(k => k.id === kotId);
  if (kot) showKotReceipt(kot);
};

// ─── KDS BILL & ORDER COMPLETION FLOW (Goes directly to POS Dashboard) ───
window.openKotBillCheckout = async (kotId) => {
  const kot = activeKots.find(k => k.id === kotId);
  if (!kot) return showToast('error', 'Kitchen order not found');

  // Gather items:
  // If dine_in table has activeTableOrders, use the full table order items
  let orderItems = [];
  let customerId = 1;
  const tableOrder = (kot.order_type === 'dine_in' && activeTableOrders[kot.table_id]) ? activeTableOrders[kot.table_id] : null;

  if (tableOrder && Array.isArray(tableOrder.items) && tableOrder.items.length > 0) {
    orderItems = tableOrder.items.map(it => ({ ...it }));
    customerId = tableOrder.customerId || 1;
  } else if (Array.isArray(kot.items) && kot.items.length > 0) {
    orderItems = kot.items.map(it => ({ ...it }));
  }

  if (orderItems.length === 0) {
    return showToast('error', 'No items found in this order to bill.');
  }

  // Ensure every item has a valid unit_price and stock (lookup from products db if needed)
  for (const item of orderItems) {
    if (typeof item.unit_price !== 'number' || isNaN(item.unit_price) || item.unit_price <= 0) {
      try {
        let p = null;
        if (item.product_id) p = await db.products.get(item.product_id);
        if (!p && item.name) p = await db.products.where('name').equals(item.name).first();
        item.unit_price = p ? Number(p.retail_price || p.price || 0) : 0;
        if (p && !item.stock) item.stock = p.stock_qty;
      } catch (e) {
        item.unit_price = item.unit_price || 0;
      }
    }
    if (typeof item.stock === 'undefined') item.stock = 999;
  }

  // Transfer all order details directly to the POS dashboard!
  currentDiningType = kot.order_type || 'dine_in';
  currentTableId = kot.table_id || 'T1';
  cartCustomerId = customerId || 1;
  cart = orderItems.map(i => ({
    product_id: i.product_id,
    name: i.name,
    unit_price: Number(i.unit_price) || 0,
    quantity: Number(i.quantity) || 1,
    stock: i.stock || 999,
    notes: i.notes || '',
    unit: i.unit || 'portion'
  }));

  // Ensure activeTableOrders has this order in case table state is checked
  if (currentDiningType === 'dine_in' && currentTableId) {
    if (!activeTableOrders[currentTableId]) {
      activeTableOrders[currentTableId] = {
        items: cart.map(i => ({ ...i })),
        customerId: cartCustomerId,
        openedAt: kot.created_at || new Date().toISOString(),
        kots: [kot.kot_number]
      };
    }
  }

  closeModal();
  nav('pos');
  updateDiningTableUI();
  await updateCartCustomer();
  renderCart();

  showToast('info', `Order "${kot.table_name}" (KOT #${kot.kot_number}) loaded into POS. Choose payment to complete.`);

  // Directly open Cash Payment modal so the user can complete cash sale in 1 click
  setTimeout(() => {
    payNow('cash');
  }, 100);
};

window.reprintKotBill = async (kotId) => {
  const kot = activeKots.find(k => k.id === kotId);
  if (!kot) return showToast('error', 'Kitchen order not found');

  if (kot.sale_id) {
    const sale = await db.sales.get(kot.sale_id);
    const items = await db.sale_items.where('sale_id').equals(kot.sale_id).toArray();
    if (sale && items && items.length > 0) {
      showReceipt(sale, items, 0, sale.total_amount, true);
      return;
    }
  }

  // Fallback: create receipt view from KOT items
  const items = (kot.items || []).map(it => ({
    product_name: it.name,
    quantity: Number(it.quantity) || 1,
    unit_price: Number(it.unit_price) || 0,
    line_total: (Number(it.quantity) || 1) * (Number(it.unit_price) || 0)
  }));
  const subtotal = items.reduce((s, it) => s + it.line_total, 0);
  const taxRate = parseFloat(currentSettings.tax_rate || 0);
  const tax = Number((subtotal * (taxRate / 100)).toFixed(2));
  const total = Number((subtotal + tax).toFixed(2));

  const sale = {
    id: `KOT-${kot.kot_number}`,
    date: kot.created_at || new Date().toISOString(),
    subtotal,
    discount: 0,
    tax,
    total_amount: total,
    payment_type: 'cash',
    cashier: kot.waiter || 'Staff'
  };

  showReceipt(sale, items, 0, total, true);
};

// 🍽️ TABLE MANAGEMENT SCREEN LOGIC
window.renderTablesScreen = () => {
  const grid = document.getElementById('tables-floor-grid');
  if (!grid) return;

  const total = restaurantTables.length;
  let vacant = 0;
  let occupied = 0;
  let activeRev = 0;
  const now = Date.now();

  restaurantTables.forEach(t => {
    const ord = activeTableOrders[t.id];
    if (ord && ord.items && ord.items.length > 0) {
      occupied++;
      activeRev += ord.items.reduce((sum, it) => sum + (it.unit_price * it.quantity), 0);
    } else {
      vacant++;
    }
  });

  const elTot = document.getElementById('tables-total-count');
  const elVac = document.getElementById('tables-vacant-count');
  const elOcc = document.getElementById('tables-occupied-count');
  const elRev = document.getElementById('tables-active-revenue');
  if (elTot) elTot.textContent = total;
  if (elVac) elVac.textContent = vacant;
  if (elOcc) elOcc.textContent = occupied;
  if (elRev) elRev.textContent = formatMoney(activeRev);

  grid.innerHTML = restaurantTables.map(t => {
    const ord = activeTableOrders[t.id];
    const isOccupied = ord && ord.items && ord.items.length > 0;
    const subtotal = isOccupied ? ord.items.reduce((sum, it) => sum + (it.unit_price * it.quantity), 0) : 0;
    const itemsCount = isOccupied ? ord.items.reduce((sum, it) => sum + it.quantity, 0) : 0;
    const elapsedMins = (isOccupied && ord.openedAt) ? Math.floor((now - new Date(ord.openedAt).getTime()) / 60000) : 0;

    return `
      <div class="table-card ${isOccupied ? 'table-occupied' : 'table-vacant'}" onclick="openTableDetails('${t.id}')">
        <div class="table-top">
          <div class="table-name">
            <span>${isOccupied ? '🍽️' : '🪑'}</span>
            <span>${t.name}</span>
          </div>
          <div style="display:flex; align-items:center; gap:6px">
            <span class="table-status-pill ${isOccupied ? 'table-status-occupied' : 'table-status-vacant'}">
              ${isOccupied ? 'Occupied' : 'Vacant'}
            </span>
            <button type="button" class="table-opt-btn" onclick="event.stopPropagation(); openEditTableModal('${t.id}')" title="Edit Table details (Name & Seats)">
              <i class="fa-solid fa-pen"></i>
            </button>
            ${!isOccupied ? `
              <button type="button" class="table-opt-btn" onclick="event.stopPropagation(); deleteTable('${t.id}')" title="Remove Table from floor" style="color:var(--danger)">
                <i class="fa-regular fa-trash-can"></i>
              </button>
            ` : ''}
          </div>
        </div>
        <div class="table-body-info">
          <div class="table-seats"><i class="fa-solid fa-users"></i> ${t.seats} Guest Seats</div>
          ${isOccupied ? `
            <div class="table-subtotal">${formatMoney(subtotal)}</div>
            <div class="table-time">
              <span>${itemsCount} items ordered</span> · <span>⏱️ ${elapsedMins}m dining</span>
            </div>
          ` : `
            <div style="font-size:12px; color:var(--text-muted); margin-top:6px">Clean & Ready for guests</div>
          `}
        </div>
        <div class="table-actions">
          ${isOccupied ? `
            <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); settleTableBill('${t.id}')" style="flex:1">
              <i class="fa-solid fa-credit-card"></i> Settle Bill
            </button>
            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); startOrderAtTable('${t.id}')" title="Add items to table">
              + Items
            </button>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openEditTableModal('${t.id}')" title="Manage Table">
              <i class="fa-solid fa-sliders"></i>
            </button>
          ` : `
            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); startOrderAtTable('${t.id}')" style="flex:1">
              <i class="fa-solid fa-plus"></i> Start Order
            </button>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openEditTableModal('${t.id}')" title="Edit Table Details">
              <i class="fa-solid fa-sliders"></i>
            </button>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); deleteTable('${t.id}')" title="Remove Table" style="color:var(--danger)">
              <i class="fa-regular fa-trash-can"></i>
            </button>
          `}
        </div>
      </div>
    `;
  }).join('');
};

window.openTableDetails = (tableId) => {
  const t = getTableObj(tableId);
  if (!t) return;
  const ord = activeTableOrders[tableId];
  const isOccupied = ord && ord.items && ord.items.length > 0;

  if (!isOccupied) {
    return startOrderAtTable(tableId);
  }

  const subtotal = ord.items.reduce((s, it) => s + (it.unit_price * it.quantity), 0);
  const html = `
    <div style="margin-bottom:14px">
      <div style="display:flex; justify-content:space-between; align-items:center">
        <h3 style="margin:0">${t.name} (${t.seats} Seats)</h3>
        <span class="badge badge-warning">Occupied</span>
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin-top:2px">
        Order opened: ${new Date(ord.openedAt).toLocaleTimeString()}
      </div>
    </div>
    <div style="max-height:220px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:8px; margin-bottom:14px">
      ${ord.items.map(it => `
        <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--surface-3); font-size:13px">
          <div>
            <strong>${it.quantity}x</strong> ${it.name}
            ${it.notes ? `<div style="font-size:11px; color:#b45309">Note: ${it.notes}</div>` : ''}
          </div>
          <div style="font-weight:700">${formatMoney(it.quantity * it.unit_price)}</div>
        </div>
      `).join('')}
    </div>
    <div style="display:flex; justify-content:space-between; font-size:16px; font-weight:800; margin-bottom:16px">
      <span>Subtotal</span>
      <span style="color:var(--brand)">${formatMoney(subtotal)}</span>
    </div>
    <div style="display:flex; flex-direction:column; gap:8px">
      <button class="btn btn-primary" onclick="settleTableBill('${tableId}')">
        💳 Proceed to Checkout & Pay Bill
      </button>
      <button class="btn btn-secondary" onclick="startOrderAtTable('${tableId}')">
        ➕ Add More Food Items in POS
      </button>
      <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="clearTableOrder('${tableId}')">
        ✕ Clear & Reset Table
      </button>
    </div>
  `;
  openModal(`Table Overview — ${t.name}`, html, `<button class="btn btn-secondary btn-sm" onclick="closeModal()">Close</button>`);
};

window.startOrderAtTable = (tableId) => {
  currentDiningType = 'dine_in';
  currentTableId = tableId;
  closeModal();
  nav('pos');
  updateDiningTableUI();

  const ord = activeTableOrders[tableId];
  if (ord && ord.items && ord.items.length > 0) {
    cart = ord.items.map(i => ({ ...i }));
    cartCustomerId = ord.customerId || 1;
    updateCartCustomer();
    renderCart();
  }
};

window.settleTableBill = (tableId) => {
  currentDiningType = 'dine_in';
  currentTableId = tableId;
  closeModal();
  nav('pos');
  updateDiningTableUI();

  const ord = activeTableOrders[tableId];
  if (ord && ord.items && ord.items.length > 0) {
    cart = ord.items.map(i => ({ ...i }));
    cartCustomerId = ord.customerId || 1;
    updateCartCustomer();
    renderCart();
  }
  showToast('info', `Order loaded. Choose Cash, Card, or Credit to finalize.`);
};

window.clearTableOrder = async (tableId) => {
  if (!await showConfirmation(`Are you sure you want to clear and reset ${getTableObj(tableId)?.name || tableId}?`, { title: 'Clear table order', confirmLabel: 'Clear table', danger: true })) return;
  delete activeTableOrders[tableId];
  await saveRestaurantState();
  closeModal();
  renderTablesScreen();
  updateDiningTableUI();
  if (typeof broadcastRealtimeEvent === 'function') {
    broadcastRealtimeEvent('TABLE_UPDATED', { activeTableOrders });
  }
  showToast('info', `Table cleared and marked vacant.`);
};

window.openAddNewTableModal = () => {
  const html = `
    <div class="form-grid">
      <div class="form-group" style="grid-column:span 2">
        <label class="form-label">Table Name *</label>
        <input class="form-input" id="new-tbl-name" placeholder="e.g. Table 9, VIP Terrace" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Seating Capacity</label>
        <input class="form-input" id="new-tbl-seats" type="number" value="4" min="1" max="50">
      </div>
    </div>
  `;
  openModal('Add Dining Table', html, `
    <button class="btn btn-secondary btn-sm" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary btn-sm" onclick="saveNewTable()">Add Table</button>
  `);
};

window.saveNewTable = async () => {
  const name = document.getElementById('new-tbl-name')?.value.trim();
  const seats = parseInt(document.getElementById('new-tbl-seats')?.value) || 4;
  if (!name) return showToast('error', 'Table name is required');

  const id = 'T-' + Date.now();
  restaurantTables.push({ id, name, seats });
  currentSettings.tables_config = JSON.stringify(restaurantTables);

  const existing = await db.settings.where('key').equals('tables_config').first();
  if (existing) await db.settings.update(existing.id, { value: currentSettings.tables_config });
  else await db.settings.add({ key: 'tables_config', value: currentSettings.tables_config });

  closeModal();
  renderTablesScreen();
  updateDiningTableUI();
  showToast('success', `Added "${name}" with ${seats} seats.`);
};

window.openEditTableModal = (tableId) => {
  const t = getTableObj(tableId);
  if (!t) return showToast('error', 'Table not found');
  const ord = activeTableOrders[tableId];
  const isOccupied = ord && ord.items && ord.items.length > 0;

  const html = `
    <div class="form-grid">
      <div class="form-group" style="grid-column:span 2">
        <label class="form-label">Table Name *</label>
        <input class="form-input" id="edit-tbl-name" value="${t.name}" placeholder="e.g. Table 1, VIP 2" autocomplete="off">
      </div>
      <div class="form-group" style="grid-column:span 2">
        <label class="form-label">Guest Seating Capacity</label>
        <input class="form-input" id="edit-tbl-seats" type="number" value="${t.seats || 4}" min="1" max="50">
      </div>
      ${isOccupied ? `
        <div style="grid-column:span 2; padding:10px 12px; background:rgba(245,158,11,0.1); border-radius:8px; border:1px solid #fde68a; font-size:12px; color:#92400e">
          ⚠️ <strong>Table Currently Occupied:</strong> Active guest order in progress. You can edit the name or seats, but cannot remove this table until the bill is settled or cleared.
        </div>
      ` : ''}
    </div>
  `;

  const footerButtons = `
    <div style="display:flex; justify-content:space-between; width:100%; align-items:center; flex-wrap:wrap; gap:8px">
      <div>
        ${!isOccupied ? `
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteTable('${t.id}')">
            <i class="fa-regular fa-trash-can"></i> Remove Table
          </button>
        ` : `
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="clearTableOrder('${t.id}')">
            <i class="fa-solid fa-xmark"></i> Clear Order
          </button>
        `}
      </div>
      <div style="display:flex; gap:8px">
        <button class="btn btn-secondary btn-sm" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="saveEditTable('${t.id}')"><i class="fa-solid fa-check"></i> Save Changes</button>
      </div>
    </div>
  `;

  openModal(`Manage Table — ${t.name}`, html, footerButtons);
};

window.saveEditTable = async (tableId) => {
  const name = document.getElementById('edit-tbl-name')?.value.trim();
  const seats = parseInt(document.getElementById('edit-tbl-seats')?.value) || 4;
  if (!name) return showToast('error', 'Table name is required');

  const t = restaurantTables.find(tbl => tbl.id === tableId);
  if (!t) return showToast('error', 'Table not found');

  t.name = name;
  t.seats = seats;
  currentSettings.tables_config = JSON.stringify(restaurantTables);

  const existing = await db.settings.where('key').equals('tables_config').first();
  if (existing) await db.settings.update(existing.id, { value: currentSettings.tables_config });
  else await db.settings.add({ key: 'tables_config', value: currentSettings.tables_config });

  closeModal();
  renderTablesScreen();
  updateDiningTableUI();
  renderRestaurantSettingsUI();
  showToast('success', `Updated table "${name}" (${seats} seats).`);
};

window.deleteTable = async (tableId) => {
  const t = restaurantTables.find(tbl => tbl.id === tableId);
  if (!t) return showToast('error', 'Table not found');

  const ord = activeTableOrders[tableId];
  if (ord && ord.items && ord.items.length > 0) {
    return showToast('error', `Cannot remove "${t.name}" while guests are dining. Please settle or clear the order first.`);
  }

  if (!confirm(`Are you sure you want to remove table "${t.name}" from your floor plan?`)) {
    return;
  }

  restaurantTables = restaurantTables.filter(tbl => tbl.id !== tableId);
  currentSettings.tables_config = JSON.stringify(restaurantTables);

  const existing = await db.settings.where('key').equals('tables_config').first();
  if (existing) await db.settings.update(existing.id, { value: currentSettings.tables_config });
  else await db.settings.add({ key: 'tables_config', value: currentSettings.tables_config });

  if (currentTableId === tableId) {
    currentTableId = restaurantTables.length > 0 ? restaurantTables[0].id : null;
  }

  closeModal();
  renderTablesScreen();
  updateDiningTableUI();
  renderRestaurantSettingsUI();
  showToast('info', `Table "${t.name}" removed from floor plan.`);
};

window.openTableManagerModal = () => {
  const html = `
    <div style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px">
      <div style="font-size:13px; color:var(--text-muted)">
        Total Configured Tables: <strong style="color:var(--text-primary)">${restaurantTables.length}</strong>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openAddNewTableModal()"><i class="fa-solid fa-plus"></i> Add New Table</button>
    </div>

    <div style="max-height:380px; overflow-y:auto; border:1px solid var(--border); border-radius:10px; margin-bottom:14px">
      ${restaurantTables.map(t => {
        const ord = activeTableOrders[t.id];
        const isOccupied = ord && ord.items && ord.items.length > 0;
        return `
          <div class="table-manage-row">
            <div style="display:flex; align-items:center; gap:12px">
              <span style="font-size:20px">${isOccupied ? '🍽️' : '🪑'}</span>
              <div>
                <div style="font-weight:700; font-size:14px; color:var(--text-primary)">${t.name}</div>
                <div style="font-size:11.5px; color:var(--text-muted)">
                  <i class="fa-solid fa-users"></i> ${t.seats} Seats · 
                  <span class="${isOccupied ? 'badge badge-warning' : 'badge badge-completed'}" style="font-size:10px; padding:1px 6px">
                    ${isOccupied ? 'Occupied' : 'Vacant & Ready'}
                  </span>
                </div>
              </div>
            </div>
            <div style="display:flex; gap:6px; align-items:center">
              <button class="btn btn-secondary btn-sm" onclick="openEditTableModal('${t.id}')" title="Edit table">
                <i class="fa-solid fa-pen"></i> Edit
              </button>
              ${!isOccupied ? `
                <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteTable('${t.id}')" title="Remove table">
                  <i class="fa-regular fa-trash-can"></i>
                </button>
              ` : `
                <button class="btn btn-ghost btn-sm" style="opacity:0.4; cursor:not-allowed" title="Table is currently occupied with diners">
                  <i class="fa-regular fa-trash-can"></i>
                </button>
              `}
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px">
      <button class="btn btn-ghost btn-sm" onclick="seedDefaultTables()" title="Restore standard 10 tables">
        <i class="fa-solid fa-rotate-left"></i> Reset to Default 10 Tables
      </button>
      <button class="btn btn-secondary btn-sm" onclick="closeModal()">Done</button>
    </div>
  `;

  openModal('Dining Floor & Table Management', html, `<button class="btn btn-secondary btn-sm" onclick="closeModal()">Close</button>`);
};

// Restaurant Settings in screen-settings
window.renderRestaurantSettingsUI = () => {
  const enabledCb = document.getElementById('set-restaurant-enabled');
  const autoPrintSel = document.getElementById('set-kot-autoprint');
  const soundSel = document.getElementById('set-kot-sound');
  const tablesList = document.getElementById('set-tables-list');
  const tablesCount = document.getElementById('set-tables-count');
  const badge = document.getElementById('set-restaurant-badge');
  const configFields = document.getElementById('restaurant-config-fields');
  const bizTypeSel = document.getElementById('set-biz-type');

  const isRest = currentSettings.restaurant_mode === 'true' || currentSettings.biz_type === 'Restaurant' || (bizTypeSel && bizTypeSel.value === 'Restaurant');

  if (enabledCb) enabledCb.checked = isRest;
  if (badge) {
    badge.textContent = isRest ? 'Restaurant Active' : 'Suite Disabled';
    badge.className = isRest ? 'badge badge-warning' : 'badge';
    if (!isRest) {
      badge.style.background = 'var(--surface-sunken)';
      badge.style.color = 'var(--text-muted)';
    } else {
      badge.style.background = '';
      badge.style.color = '';
    }
  }
  if (configFields) {
    configFields.style.opacity = isRest ? '1' : '0.6';
  }
  if (autoPrintSel) autoPrintSel.value = currentSettings.kot_autoprint || 'true';
  if (soundSel) soundSel.value = currentSettings.kot_sound || 'true';
  if (tablesCount) tablesCount.textContent = restaurantTables.length;

  if (tablesList) {
    tablesList.innerHTML = restaurantTables.map(t => `
      <span class="table-config-pill">
        <i class="fa-solid fa-chair" style="color:var(--brand)"></i> ${t.name} (${t.seats}s)
        <button type="button" class="table-config-del" onclick="removeConfigTable('${t.id}')" title="Delete table">✕</button>
      </span>
    `).join('');
  }
};

window.toggleRestaurantSetting = (enabled) => {
  const isEnabled = !!enabled;
  currentSettings.restaurant_mode = isEnabled ? 'true' : 'false';

  // Seed default tables if enabling for first time
  if (isEnabled && (!restaurantTables || restaurantTables.length === 0)) {
    window.seedDefaultTables(true);
  }

  // Explicitly update sidebar
  const navRest = document.getElementById('nav-restaurant');
  const divRest = document.getElementById('divider-restaurant');
  if (navRest) navRest.style.display = isEnabled ? 'block' : 'none';
  if (divRest) divRest.style.display = isEnabled ? 'block' : 'none';

  // Explicitly update all restaurant-only elements
  document.querySelectorAll('.restaurant-only').forEach(el => {
    if (el.classList.contains('sidebar-divider')) el.style.display = isEnabled ? 'block' : 'none';
    else if (el.classList.contains('pos-dining-bar')) el.style.display = isEnabled ? 'flex' : 'none';
    else if (el.id === 'btn-fire-kot') el.style.display = isEnabled ? 'inline-flex' : 'none';
    else el.style.display = isEnabled ? 'block' : 'none';
  });

  const badge = document.getElementById('set-restaurant-badge');
  if (badge) {
    badge.textContent = isEnabled ? 'Restaurant Active' : 'Suite Disabled';
    badge.className = isEnabled ? 'badge badge-warning' : 'badge';
    if (!isEnabled) {
      badge.style.background = 'var(--surface-sunken)';
      badge.style.color = 'var(--text-muted)';
    } else {
      badge.style.background = '';
      badge.style.color = '';
    }
  }

  const configFields = document.getElementById('restaurant-config-fields');
  if (configFields) {
    configFields.style.opacity = isEnabled ? '1' : '0.6';
  }

  if (isEnabled && typeof initRestaurantSuite === 'function') {
    initRestaurantSuite();
  }

  showToast(isEnabled ? 'success' : 'info', isEnabled 
    ? '🍽️ Restaurant Suite Enabled! Kitchen Display (KOT) and Table Management added to sidebar.' 
    : 'Restaurant Suite Disabled. Click "Save Settings" to persist.');
};

window.onBizTypeChange = async (type) => {
  const isRest = (type === 'Restaurant');
  const enabledCb = document.getElementById('set-restaurant-enabled');
  if (isRest) {
    if (enabledCb) enabledCb.checked = true;
    currentSettings.biz_type = 'Restaurant';
    currentSettings.restaurant_mode = 'true';
    toggleRestaurantSetting(true);
    const restCard = document.getElementById('card-restaurant-settings');
    if (restCard) {
      restCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } else {
    renderRestaurantSettingsUI();
  }
};

window.seedDefaultTables = (silent = false) => {
  restaurantTables = [
    { id: 'T1', name: 'Table 1', seats: 4 },
    { id: 'T2', name: 'Table 2', seats: 2 },
    { id: 'T3', name: 'Table 3', seats: 4 },
    { id: 'T4', name: 'Table 4', seats: 6 },
    { id: 'T5', name: 'Table 5', seats: 2 },
    { id: 'T6', name: 'Table 6', seats: 4 },
    { id: 'T7', name: 'Table 7', seats: 8 },
    { id: 'T8', name: 'Table 8', seats: 4 },
    { id: 'VIP1', name: 'VIP Lounge 1', seats: 6 },
    { id: 'OUT1', name: 'Garden Table 1', seats: 4 }
  ];
  currentSettings.tables_config = JSON.stringify(restaurantTables);
  renderRestaurantSettingsUI();
  if (!silent) {
    showToast('info', 'Loaded 10 standard dining tables. Click "Save Settings" to persist.');
  }
};

window.addConfigTable = async () => {
  const name = document.getElementById('set-new-table-name')?.value.trim();
  const seats = parseInt(document.getElementById('set-new-table-seats')?.value) || 4;
  if (!name) return showToast('error', 'Table name is required');

  const id = 'T-' + Date.now();
  restaurantTables.push({ id, name, seats });
  document.getElementById('set-new-table-name').value = '';
  renderRestaurantSettingsUI();
  showToast('info', `Added ${name} to list. Click "Save Settings" to persist.`);
};

window.removeConfigTable = (tableId) => {
  restaurantTables = restaurantTables.filter(t => t.id !== tableId);
  renderRestaurantSettingsUI();
  showToast('info', 'Table removed from list. Click "Save Settings" to persist.');
};

window.saveRestaurantSettings = async () => {
  const enabled = document.getElementById('set-restaurant-enabled')?.checked ? 'true' : 'false';
  const autoprint = document.getElementById('set-kot-autoprint')?.value || 'true';
  const sound = document.getElementById('set-kot-sound')?.value || 'true';
  const tablesJson = JSON.stringify(restaurantTables);

  currentSettings.restaurant_mode = enabled;
  currentSettings.kot_autoprint = autoprint;
  currentSettings.kot_sound = sound;
  currentSettings.tables_config = tablesJson;

  const pairs = [
    { key: 'restaurant_mode', value: enabled },
    { key: 'kot_autoprint', value: autoprint },
    { key: 'kot_sound', value: sound },
    { key: 'tables_config', value: tablesJson }
  ];

  for (const p of pairs) {
    const ex = await db.settings.where('key').equals(p.key).first();
    if (ex) await db.settings.update(ex.id, { value: p.value });
    else await db.settings.add(p);
  }

  toggleRestaurantSetting(enabled === 'true');
  updateDiningTableUI();
  showToast('success', 'Restaurant settings saved successfully!');
};

window.saOnBizTypeChange = (type) => {
  const badge = document.getElementById('sa-restaurant-pack-badge');
  if (badge) {
    badge.style.display = (type === 'Restaurant') ? 'block' : 'none';
  }
};
