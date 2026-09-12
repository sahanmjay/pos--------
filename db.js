const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

let supa;
if (typeof supabase !== 'undefined') {
  const { createClient } = supabase;
  try {
    // Clear any stale Supabase auth tokens that cause HTTP 401s on anon calls
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
        localStorage.removeItem(k);
      }
    }
  } catch(e) {}

  supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
} else {
  console.warn("Supabase script not loaded. Running in local offline mode.");
  supa = null;
}

let currentOrgId = null;
let isSuperAdmin = false;

const GLOBAL_SAAS_TABLES = ['organizations','super_admins','subscription_plans','platform_log','platform_settings'];

// ─── OFFLINE MODE STATE ───
window._forceOfflineMode = localStorage.getItem('nexpos_force_offline') === 'true';

function isOffline() {
  return window._forceOfflineMode === true || !navigator.onLine || !supa;
}

function toggleForceOffline() {
  window._forceOfflineMode = !window._forceOfflineMode;
  localStorage.setItem('nexpos_force_offline', window._forceOfflineMode ? 'true' : 'false');
  if (typeof updateOfflineStatusUI === 'function') updateOfflineStatusUI();
  if (!window._forceOfflineMode && navigator.onLine) {
    syncOfflineQueue();
  }
  return window._forceOfflineMode;
}

// ─── INDEXEDDB LOCAL STORAGE & STORE-AND-FORWARD ENGINE ───
const IDB_NAME = 'nexpos_local_offline_db';
const IDB_VERSION = 1;
const ALL_IDB_STORES = [
  'organizations','products','categories','customers','sales','sale_items',
  'users','settings','attendance','held_carts','payroll','advances',
  'pos_shifts','shift_closures','audit_log','offline_sales_queue'
];

let _idbPromise = null;
function getLocalDB() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve) => {
    try {
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported on this browser, using memory fallback');
        return resolve(null);
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        ALL_IDB_STORES.forEach(s => {
          if (!d.objectStoreNames.contains(s)) {
            d.createObjectStore(s, { keyPath: 'id' });
          }
        });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => {
        console.warn('Failed to open local IndexedDB:', e);
        resolve(null);
      };
    } catch (err) {
      console.warn('LocalDB init error:', err);
      resolve(null);
    }
  });
  return _idbPromise;
}

async function idbGet(storeName, id) {
  const db = await getLocalDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function idbGetAll(storeName) {
  const db = await getLocalDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}

async function idbPut(storeName, item) {
  const db = await getLocalDB();
  if (!db || !item) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(item);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

async function idbPutMany(storeName, items) {
  const db = await getLocalDB();
  if (!db || !Array.isArray(items) || items.length === 0) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const item of items) {
        if (item && item.id !== undefined) store.put(item);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

async function idbDelete(storeName, id) {
  const db = await getLocalDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

async function idbClear(storeName) {
  const db = await getLocalDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

// ─── SUPABASE COMPATIBILITY LAYER WITH OFFLINE STORE-AND-FORWARD ───

class SupaQuery {
  constructor(table, filters) {
    this._table = table;
    this._filters = filters || [];
  }
  equals(val) {
    this._filters.push({ field: this._field, val });
    return this;
  }
  async first() {
    if (isOffline()) {
      let all = await idbGetAll(this._table);
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._table)) {
        all = all.filter(x => x.organization_id == currentOrgId);
      }
      for (const f of this._filters) {
        all = all.filter(x => x[f.field] == f.val);
      }
      return all[0] || null;
    }
    try {
      let q = supa.from(this._table).select('*');
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._table)) {
        q = q.eq('organization_id', currentOrgId);
      }
      for (const f of this._filters) q = q.eq(f.field, f.val);
      const { data, error } = await q.limit(1).maybeSingle();
      if (!error && data) {
        idbPut(this._table, data).catch(() => {});
        return data;
      }
    } catch (e) {
      console.warn(`[Offline fallback] Query.first failed on ${this._table}:`, e);
    }
    // Fallback to local
    let all = await idbGetAll(this._table);
    if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._table)) {
      all = all.filter(x => x.organization_id == currentOrgId);
    }
    for (const f of this._filters) {
      all = all.filter(x => x[f.field] == f.val);
    }
    return all[0] || null;
  }
  async toArray() {
    if (isOffline()) {
      let all = await idbGetAll(this._table);
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._table)) {
        all = all.filter(x => x.organization_id == currentOrgId);
      }
      for (const f of this._filters) {
        all = all.filter(x => x[f.field] == f.val);
      }
      return all;
    }
    try {
      let q = supa.from(this._table).select('*');
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._table)) {
        q = q.eq('organization_id', currentOrgId);
      }
      for (const f of this._filters) q = q.eq(f.field, f.val);
      const { data, error } = await q;
      if (!error && data) {
        idbPutMany(this._table, data).catch(() => {});
        return data;
      }
    } catch (e) {
      console.warn(`[Offline fallback] Query.toArray failed on ${this._table}:`, e);
    }
    // Fallback to local
    let all = await idbGetAll(this._table);
    if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._table)) {
      all = all.filter(x => x.organization_id == currentOrgId);
    }
    for (const f of this._filters) {
      all = all.filter(x => x[f.field] == f.val);
    }
    return all;
  }
}

class SupaTable {
  constructor(name) { this._name = name; }

  async toArray() {
    if (isOffline()) {
      let local = await idbGetAll(this._name);
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
        local = local.filter(x => x.organization_id == currentOrgId);
      }
      return local;
    }
    try {
      let q = supa.from(this._name).select('*').order('id', { ascending: true });
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
        q = q.eq('organization_id', currentOrgId);
      }
      const { data, error } = await q;
      if (!error && Array.isArray(data)) {
        let local = await idbGetAll(this._name);
        if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
          local = local.filter(x => x.organization_id == currentOrgId);
        }
        // If cloud returns 0 rows but local cache has items, don't wipe out the user's data!
        if (data.length === 0 && local.length > 0) {
          console.warn(`[db.toArray] Cloud '${this._name}' has 0 items, preserving ${local.length} local items.`);
          return local;
        }

        // Merge any locally-created offline items
        const cloudIds = new Set(data.map(d => d.id));
        const pendingLocal = local.filter(l => !cloudIds.has(l.id) && l._is_offline);

        idbPutMany(this._name, data).catch(() => {});
        return [...data, ...pendingLocal];
      }
    } catch (e) {
      console.warn(`[Offline fallback] toArray on ${this._name}:`, e);
    }
    let local = await idbGetAll(this._name);
    if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
      local = local.filter(x => x.organization_id == currentOrgId);
    }
    return local;
  }

  async get(id) {
    if (isOffline()) {
      return await idbGet(this._name, id);
    }
    try {
      let q = supa.from(this._name).select('*').eq('id', id);
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
        q = q.eq('organization_id', currentOrgId);
      }
      const { data, error } = await q.maybeSingle();
      if (!error && data) {
        idbPut(this._name, data).catch(() => {});
        return data;
      }
    } catch (e) {
      console.warn(`[Offline fallback] get on ${this._name}:`, e);
    }
    return await idbGet(this._name, id);
  }

  async add(item) {
    if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
      item.organization_id = currentOrgId;
    }
    
    // Always assign local ID if absent
    if (item.id === undefined) {
      item.id = Date.now() + Math.floor(Math.random() * 10000);
    }

    if (isOffline()) {
      item._is_offline = true;
      item._offline_created_at = new Date().toISOString();
      await idbPut(this._name, item);
      
      // If a sale is created offline, queue it for cloud sync
      if (this._name === 'sales') {
        await idbPut('offline_sales_queue', item);
        updateOfflineStatusUI();
      }
      return item.id;
    }

    try {
      // Online flow
      const insertPayload = { ...item };
      // Omit temporary client id so database can generate auto-increment primary key
      delete insertPayload.id;
      delete insertPayload._is_offline;

      const { data, error } = await supa.from(this._name).insert(insertPayload).select('id').single();
      if (!error && data) {
        item.id = data.id;
        await idbPut(this._name, item);
        return data.id;
      }
      throw error || new Error('Insert returned no data');
    } catch (err) {
      console.warn(`[Offline Fallback] Insertion failed for ${this._name}, saving locally:`, err);
      item._is_offline = true;
      item._offline_created_at = new Date().toISOString();
      await idbPut(this._name, item);
      if (this._name === 'sales') {
        await idbPut('offline_sales_queue', item);
        updateOfflineStatusUI();
      }
      return item.id;
    }
  }

  async bulkAdd(items) {
    if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
      items = items.map(i => ({ ...i, organization_id: currentOrgId }));
    }
    items = items.map(i => {
      if (i.id === undefined) i.id = Date.now() + Math.floor(Math.random() * 10000);
      return i;
    });

    // Save locally first
    await idbPutMany(this._name, items);

    if (!isOffline()) {
      try {
        const payloads = items.map(i => {
          const c = { ...i };
          delete c.id;
          delete c._is_offline;
          return c;
        });
        const { error } = await supa.from(this._name).insert(payloads);
        if (error) console.warn('bulkAdd remote error:', error);
      } catch (e) {
        console.warn('bulkAdd online error, kept local:', e);
      }
    }
  }

  async update(id, changes) {
    // Update local cache
    const existing = await idbGet(this._name, id);
    if (existing) {
      const merged = { ...existing, ...changes };
      await idbPut(this._name, merged);
    }
    if (!isOffline()) {
      try {
        const { error } = await supa.from(this._name).update(changes).eq('id', id);
        if (error) console.warn('update remote error:', error);
      } catch (e) {
        console.warn('update online error:', e);
      }
    }
  }

  async delete(id) {
    await idbDelete(this._name, id);
    if (!isOffline()) {
      try {
        const { error } = await supa.from(this._name).delete().eq('id', id);
        if (error) console.warn('delete remote error:', error);
      } catch (e) {
        console.warn('delete online error:', e);
      }
    }
  }

  async clear() {
    if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
      const all = await idbGetAll(this._name);
      for (const item of all) {
        if (item.organization_id == currentOrgId) {
          await idbDelete(this._name, item.id);
        }
      }
    } else {
      await idbClear(this._name);
    }
    if (!isOffline() && supa) {
      try {
        let q = supa.from(this._name).delete();
        if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
          q = q.eq('organization_id', currentOrgId);
        } else {
          q = q.neq('id', 0);
        }
        await q;
      } catch (e) {
        console.warn('clear online error:', e);
      }
    }
  }

  async count() {
    if (isOffline()) {
      let local = await idbGetAll(this._name);
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
        local = local.filter(x => x.organization_id == currentOrgId);
      }
      return local.length;
    }
    try {
      let q = supa.from(this._name).select('*', { count: 'exact', head: true });
      if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
        q = q.eq('organization_id', currentOrgId);
      }
      const { count, error } = await q;
      if (!error && typeof count === 'number') return count;
    } catch (e) {}
    let local = await idbGetAll(this._name);
    if (currentOrgId && !isSuperAdmin && !GLOBAL_SAAS_TABLES.includes(this._name)) {
      local = local.filter(x => x.organization_id == currentOrgId);
    }
    return local.length;
  }

  where(fieldOrObj) {
    const filters = [];
    if (typeof fieldOrObj === 'object') {
      for (const [k, v] of Object.entries(fieldOrObj)) filters.push({ field: k, val: v });
      return new SupaQuery(this._name, filters);
    }
    const q = new SupaQuery(this._name, filters);
    q._field = fieldOrObj;
    return q;
  }
}

const db = {
  get currentOrgId() { return currentOrgId; },
  set currentOrgId(val) { currentOrgId = val; },
  get isSuperAdmin() { return isSuperAdmin; },
  set isSuperAdmin(val) { isSuperAdmin = val; },
  // Whether public.sales carries the per-business bill_no column
  salesSupportsBillNo,
  // Whether public.sale_items can store the cost at the moment of sale
  saleItemsSupportCost,
  organizations: new SupaTable('organizations'),
  products:      new SupaTable('products'),
  categories:    new SupaTable('categories'),
  customers:     new SupaTable('customers'),
  sales:         new SupaTable('sales'),
  sale_items:    new SupaTable('sale_items'),
  users:         new SupaTable('users'),
  settings:      new SupaTable('settings'),
  attendance:    new SupaTable('attendance'),
  held_carts:    new SupaTable('held_carts'),
  payroll:       new SupaTable('payroll'),
  advances:      new SupaTable('advances'),
  pos_shifts:    new SupaTable('pos_shifts'),
  shift_closures: new SupaTable('shift_closures'),
  audit_log:     new SupaTable('audit_log'),
  // SaaS tables
  super_admins:       new SupaTable('super_admins'),
  subscription_plans: new SupaTable('subscription_plans'),
  platform_log:       new SupaTable('platform_log'),
  platform_settings:  new SupaTable('platform_settings'),
};

// ─── STORE-AND-FORWARD CLOUD SYNCHRONIZATION ───
let _isSyncing = false;
async function syncOfflineQueue() {
  if (isOffline() || _isSyncing) return 0;
  _isSyncing = true;
  let syncedCount = 0;
  try {
    const queue = await idbGetAll('offline_sales_queue');
    if (!queue || queue.length === 0) {
      _isSyncing = false;
      updateOfflineStatusUI();
      return 0;
    }

    console.log(`[Store-and-Forward] Synchronizing ${queue.length} offline transaction(s)...`);
    for (const sale of queue) {
      try {
        const localSaleId = sale.id;
        const uploadSale = { ...sale };
        delete uploadSale.id;
        delete uploadSale._is_offline;
        delete uploadSale._offline_created_at;

        // Insert sale into Supabase
        const { data: newSale, error: saleErr } = await supa.from('sales').insert(uploadSale).select('id').single();
        if (!saleErr && newSale) {
          // Sync associated sale items
          const allItems = await idbGetAll('sale_items');
          const relatedItems = allItems.filter(it => it.sale_id == localSaleId);
          for (const it of relatedItems) {
            const uploadItem = { ...it, sale_id: newSale.id };
            delete uploadItem.id;
            delete uploadItem._is_offline;
            await supa.from('sale_items').insert(uploadItem);
          }
          // Remove from sync queue
          await idbDelete('offline_sales_queue', localSaleId);
          syncedCount++;
        }
      } catch (itemErr) {
        console.warn('[Store-and-Forward] Error syncing record:', itemErr);
      }
    }

    if (syncedCount > 0 && typeof showToast === 'function') {
      showToast('success', `⚡ Synced ${syncedCount} offline transaction(s) to cloud!`);
      // Trigger data refresh on active screen
      if (typeof renderPosGrid === 'function') renderPosGrid();
      if (typeof loadSalesHistory === 'function') loadSalesHistory();
    }
  } catch (err) {
    console.warn('[Store-and-Forward] Global sync error:', err);
  } finally {
    _isSyncing = false;
    updateOfflineStatusUI();
  }
  return syncedCount;
}

// ─── OFFLINE STATUS UI CONTROLLER ───
async function updateOfflineStatusUI() {
  const statusPill = document.getElementById('connection-status');
  const queueCount = (await idbGetAll('offline_sales_queue')).length;
  
  if (statusPill) {
    if (isOffline()) {
      statusPill.className = 'status-pill offline';
      statusPill.innerHTML = `<span class="status-dot"></span> Offline Mode`;
      statusPill.title = 'Offline mode active. Transactions save locally and sync when reconnected.';
    } else {
      statusPill.className = 'status-pill online';
      statusPill.innerHTML = `<span class="status-dot"></span> Online`;
      statusPill.title = 'Connected to cloud. Realtime sync active.';
    }
  }

  // Queue pill in topbar
  let queuePill = document.getElementById('offline-queue-pill');
  if (!queuePill && document.querySelector('.topbar-actions')) {
    queuePill = document.createElement('span');
    queuePill.id = 'offline-queue-pill';
    queuePill.className = 'status-pill warning';
    queuePill.style.cursor = 'pointer';
    queuePill.onclick = () => syncOfflineSalesNow();
    const conn = document.getElementById('connection-status');
    if (conn && conn.parentNode) conn.parentNode.insertBefore(queuePill, conn.nextSibling);
  }

  if (queuePill) {
    if (queueCount > 0) {
      queuePill.style.display = 'inline-flex';
      queuePill.innerHTML = `<i class="fa-solid fa-cloud-arrow-up" style="margin-right:4px"></i> <span id="queue-count">${queueCount}</span> Queued (Sync)`;
      queuePill.title = `${queueCount} sales made offline. Click to upload now.`;
    } else {
      queuePill.style.display = 'none';
    }
  }
}

window.syncOfflineSalesNow = async () => {
  if (isOffline()) {
    if (typeof showToast === 'function') showToast('warning', 'Currently in offline mode or disconnected. Reconnect to sync.');
    return;
  }
  if (typeof showToast === 'function') showToast('info', 'Synchronizing offline transactions with cloud...');
  const count = await syncOfflineQueue();
  if (count === 0 && typeof showToast === 'function') {
    showToast('info', 'All transactions are already synchronized.');
  }
};

window.warmOfflineCache = async (orgId) => {
  if (isOffline() || !supa) return;
  try {
    console.log('[NexPOS Cache] Pre-warming offline cache for organization:', orgId);
    
    // 1. Products
    let prodQuery = supa.from('products').select('*');
    if (orgId && !isSuperAdmin) prodQuery = prodQuery.eq('organization_id', orgId);
    const { data: prods } = await prodQuery;
    if (prods && prods.length) await idbPutMany('products', prods);

    // 2. Categories
    let catQuery = supa.from('categories').select('*');
    if (orgId && !isSuperAdmin) catQuery = catQuery.eq('organization_id', orgId);
    const { data: cats } = await catQuery;
    if (cats && cats.length) await idbPutMany('categories', cats);

    // 3. Settings
    let setQuery = supa.from('settings').select('*');
    if (orgId && !isSuperAdmin) setQuery = setQuery.eq('organization_id', orgId);
    const { data: sets } = await setQuery;
    if (sets && sets.length) await idbPutMany('settings', sets);

    // 4. Customers
    let custQuery = supa.from('customers').select('*');
    if (orgId && !isSuperAdmin) custQuery = custQuery.eq('organization_id', orgId);
    const { data: custs } = await custQuery;
    if (custs && custs.length) await idbPutMany('customers', custs);

    // 5. Organization
    if (orgId) {
      const { data: org } = await supa.from('organizations').select('*').eq('id', orgId).maybeSingle();
      if (org) await idbPut('organizations', org);
    }

    // 6. Users for this org (for offline login!)
    let userQuery = supa.from('users').select('*');
    if (orgId && !isSuperAdmin) userQuery = userQuery.eq('organization_id', orgId);
    const { data: usrs } = await userQuery;
    if (usrs && usrs.length) await idbPutMany('users', usrs);

    console.log('[NexPOS Cache] Offline cache primed with products, categories, settings & users.');
  } catch (err) {
    console.warn('[NexPOS Cache] Pre-warming notice:', err);
  }
};

window.addEventListener('online', () => {
  console.log('[NexPOS] Online connection restored');
  updateOfflineStatusUI();
  syncOfflineQueue();
});

window.addEventListener('offline', () => {
  console.log('[NexPOS] Offline mode activated');
  updateOfflineStatusUI();
});

// Auto-check sync periodically every 20 seconds if online
setInterval(() => {
  if (!isOffline()) syncOfflineQueue();
}, 20000);

// ─── SUPER ADMIN HELPERS ───

async function saGetPlatformSetting(key, defaultVal = '') {
  try {
    const { data, error } = await supa.from('platform_settings').select('value').eq('key', key).maybeSingle();
    if (error || !data) return localStorage.getItem('nexpos_platform_' + key) || defaultVal;
    return data.value;
  } catch (e) {
    return localStorage.getItem('nexpos_platform_' + key) || defaultVal;
  }
}

async function saSetPlatformSetting(key, value) {
  try {
    localStorage.setItem('nexpos_platform_' + key, value);
    const { error } = await supa.from('platform_settings').upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) console.warn('saSetPlatformSetting db fallback:', error);
    return true;
  } catch (e) {
    console.warn('saSetPlatformSetting error:', e);
    return false;
  }
}

async function saGetAllPlatformSettings() {
  const result = {
    ai_provider: 'google',
    ai_model: 'gemini-1.5-flash',
    ai_enabled: 'true',
    ai_plan_requirement: 'pro',
    ai_api_key: ''
  };
  try {
    const { data } = await supa.from('platform_settings').select('*');
    if (data && data.length) {
      data.forEach(r => { result[r.key] = r.value; });
    }
  } catch (e) {
    console.warn('saGetAllPlatformSettings error:', e);
  }
  for (const k of Object.keys(result)) {
    const local = localStorage.getItem('nexpos_platform_' + k);
    if (local !== null && !result[k]) result[k] = local;
  }
  return result;
}

async function saLoginSuperAdmin(username, password) {
  if (isOffline()) {
    console.warn('Super admin login requires online connection');
    return null;
  }
  const { data, error } = await supa
    .from('super_admins')
    .select('*')
    .eq('username', username)
    .eq('password', password)
    .limit(1)
    .maybeSingle();
  if (error) { console.error('SA Login Error:', error); return null; }
  if (data) {
    await supa.from('super_admins').update({ last_login: new Date().toISOString() }).eq('id', data.id);
  }
  return data;
}

async function saGetAllOrganizations() {
  if (isOffline() || !supa) {
    return await idbGetAll('organizations');
  }
  try {
    const { data, error } = await supa
      .from('organizations')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('[saGetAllOrganizations] Supabase error:', error);
      return await idbGetAll('organizations');
    }
    if (data && data.length) {
      idbPutMany('organizations', data).catch(() => {});
      return data;
    }
    return await idbGetAll('organizations');
  } catch (e) {
    console.warn('[saGetAllOrganizations] Cloud fetch notice:', e);
    return await idbGetAll('organizations');
  }
}

// public.sales.bill_no is added by saas-migration.sql. Writing a column the
// schema does not have would be swallowed by add() and the sale would only
// exist locally, so establish support once and cache the answer.
// public.sale_items.cost_price is added by saas-migration.sql. Writing it to a
// schema that lacks it would be swallowed by add() and the sale line would only
// exist locally, so support is established once and cached.
let _costSnapSupported = null;
async function saleItemsSupportCost() {
  if (_costSnapSupported !== null) return _costSnapSupported;
  if (isOffline()) return false;
  try {
    const { error } = await supa.from('sale_items').select('cost_price').limit(1);
    _costSnapSupported = !error;
    if (error) console.warn('[cost_price] Column not present on sale_items — profit falls back to the current product cost. Run saas-migration.sql.');
  } catch (e) {
    _costSnapSupported = false;
  }
  return _costSnapSupported;
}

let _billNoSupported = null;
async function salesSupportsBillNo() {
  if (_billNoSupported !== null) return _billNoSupported;
  if (isOffline()) return false;
  try {
    const { error } = await supa.from('sales').select('bill_no').limit(1);
    _billNoSupported = !error;
    if (error) console.warn('[bill_no] Column not present — bill numbers fall back to record id. Run saas-migration.sql.');
  } catch (e) {
    _billNoSupported = false;
  }
  return _billNoSupported;
}

async function saCreateOrganization(orgData, adminData) {
  if (isOffline()) throw new Error('Creating a new business organization requires internet connection.');
  
  // Construct payload matching public.organizations schema in Supabase
  let candidatePayload = {
    name: orgData.name,
    slug: orgData.slug,
    business_type: orgData.business_type || 'Retail Shop',
    plan_id: orgData.plan_id || 'free',
    subscription: orgData.plan_id || 'free',
    currency: orgData.currency || 'Rs.',
    tax_rate: orgData.tax_rate || 0,
    phone: orgData.phone || '',
    address: orgData.address || '',
    max_users: orgData.max_users || 3,
    max_products: orgData.max_products || 100,
    is_active: true
  };

  let org = null;
  let orgErr = null;
  let attempts = 0;

  // Schema-resilient insert: automatically prunes any column that the Supabase schema cache does not recognize
  while (attempts < 5) {
    attempts++;
    const res = await supa
      .from('organizations')
      .insert(candidatePayload)
      .select('*')
      .single();
    
    org = res.data;
    orgErr = res.error;

    if (!orgErr && org) break;

    if (orgErr && orgErr.message) {
      const match = orgErr.message.match(/Could not find the '([^']+)' column of 'organizations' in the schema cache/i);
      if (match && match[1]) {
        const badCol = match[1];
        console.warn(`[saCreateOrganization] Column '${badCol}' not in Supabase schema cache. Removing and retrying...`);
        delete candidatePayload[badCol];
        continue;
      }
    }
    break;
  }

  if (orgErr) { console.error('Create Org Error:', orgErr); return { error: orgErr.message }; }
  if (!org) return { error: 'Failed to create organization record.' };

  // Save new organization to local IndexedDB
  await idbPut('organizations', org);

  // Create admin user for the business
  const { data: newUser, error: userErr } = await supa
    .from('users')
    .insert({
      username: adminData.username,
      password: adminData.password,
      display_name: adminData.display_name || 'Administrator',
      role: 'Admin',
      is_active: true,
      organization_id: org.id
    })
    .select('*')
    .maybeSingle();

  if (userErr) { console.error('Create Admin Error:', userErr); return { error: userErr.message }; }
  if (newUser) await idbPut('users', newUser);

  // Seed default walk-in customer
  const { data: defaultCust } = await supa.from('customers').insert({
    name: 'Walk-in Customer', phone: '', email: '', outstanding_balance: 0,
    organization_id: org.id
  }).select('*').maybeSingle();
  if (defaultCust) await idbPut('customers', defaultCust);

  // Seed default settings
  const defaultSettings = [
    { key: 'biz_name', value: orgData.name },
    { key: 'biz_type', value: orgData.business_type || 'Retail Shop' },
    { key: 'currency', value: orgData.currency || 'Rs.' },
    { key: 'tax_rate', value: String(orgData.tax_rate || 0) },
    { key: 'phone', value: orgData.phone || '' },
    { key: 'address', value: orgData.address || '' },
  ];

  if (orgData.business_type === 'Restaurant') {
    defaultSettings.push(
      { key: 'restaurant_mode', value: 'true' },
      { key: 'kot_autoprint', value: 'true' },
      { key: 'kot_sound', value: 'true' },
      { key: 'kot_next_num', value: '101' },
      { key: 'tables_config', value: JSON.stringify([
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
      ])}
    );
  }

  for (const s of defaultSettings) {
    await supa.from('settings').insert({ ...s, organization_id: org.id });
  }

  return { org };
}

async function saToggleOrgStatus(orgId, isActive) {
  const { error } = await supa.from('organizations').update({ is_active: isActive }).eq('id', orgId);
  if (error) console.error('Toggle Org Error:', error);
  return !error;
}

async function saDeleteOrganization(orgId) {
  const tables = ['sale_items','sales','held_carts','attendance','payroll','advances','shift_closures','audit_log','products','categories','customers','settings','users'];
  for (const t of tables) {
    await supa.from(t).delete().eq('organization_id', orgId);
  }
  await supa.from('organizations').delete().eq('id', orgId);
}

async function saUpdateOrganization(orgId, changes) {
  let payload = { ...changes };
  delete payload.email;
  delete payload.plan;
  if (payload.plan_id && !payload.subscription) payload.subscription = payload.plan_id;

  let attempts = 0;
  let updateErr = null;
  while (attempts < 5) {
    attempts++;
    const { error } = await supa.from('organizations').update(payload).eq('id', orgId);
    updateErr = error;
    if (!updateErr) break;

    if (updateErr && updateErr.message) {
      const match = updateErr.message.match(/Could not find the '([^']+)' column of 'organizations' in the schema cache/i);
      if (match && match[1]) {
        const badCol = match[1];
        console.warn(`[saUpdateOrganization] Column '${badCol}' not in Supabase schema cache. Removing and retrying...`);
        delete payload[badCol];
        continue;
      }
    }
    break;
  }

  if (updateErr) console.error('Update Org Error:', updateErr);
  return !updateErr;
}

async function saLogPlatformEvent(actorType, actorId, actorName, action, targetOrg, targetName, details = {}) {
  if (isOffline()) return;
  try {
    await supa.from('platform_log').insert({
      actor_type: actorType,
      actor_id: actorId,
      actor_name: actorName,
      action,
      target_org: targetOrg || null,
      target_name: targetName || '',
      details
    });
  } catch (e) {}
}

async function saGetPlatformLogs(limit = 100) {
  if (isOffline()) return [];
  const { data, error } = await supa
    .from('platform_log')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(limit);
  if (error) { console.error('Get Logs Error:', error); return []; }
  return data || [];
}

async function saGetPlatformStats() {
  const orgs = await saGetAllOrganizations();
  const activeOrgs = orgs.filter(o => o.is_active);
  
  let totalUsers = 0, totalProducts = 0, totalSales = 0, totalRevenue = 0;
  
  if (!isOffline()) {
    const { count: uCount } = await supa.from('users').select('*', { count: 'exact', head: true });
    const { count: pCount } = await supa.from('products').select('*', { count: 'exact', head: true });
    const { data: allSales } = await supa.from('sales').select('total_amount');
    
    totalUsers = uCount || 0;
    totalProducts = pCount || 0;
    totalSales = (allSales || []).length;
    totalRevenue = (allSales || []).reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
  } else {
    totalUsers = (await idbGetAll('users')).length;
    totalProducts = (await idbGetAll('products')).length;
    const localSales = await idbGetAll('sales');
    totalSales = localSales.length;
    totalRevenue = localSales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
  }

  return {
    totalOrgs: orgs.length,
    activeOrgs: activeOrgs.length,
    inactiveOrgs: orgs.length - activeOrgs.length,
    totalUsers,
    totalProducts,
    totalSales,
    totalRevenue
  };
}

async function saGetOrgUsers(orgId) {
  if (isOffline() || !supa) {
    const all = await idbGetAll('users');
    return all.filter(u => u.organization_id == orgId);
  }
  const { data, error } = await supa.from('users').select('*').eq('organization_id', orgId);
  if (error) return [];
  return data || [];
}

async function saGetOrgStats(orgId) {
  let users = 0;
  let products = 0;
  let sales = 0;
  let revenue = 0;

  if (isOffline() || !supa) {
    const allUsers = await idbGetAll('users');
    users = allUsers.filter(u => u.organization_id == orgId).length;
    const allProds = await idbGetAll('products');
    products = allProds.filter(p => p.organization_id == orgId).length;
    const allSales = await idbGetAll('sales');
    const orgSales = allSales.filter(s => s.organization_id == orgId);
    sales = orgSales.length;
    revenue = orgSales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
  } else {
    try {
      const [uRes, pRes, sRes] = await Promise.all([
        supa.from('users').select('*', { count: 'exact', head: true }).eq('organization_id', orgId),
        supa.from('products').select('*', { count: 'exact', head: true }).eq('organization_id', orgId),
        supa.from('sales').select('total_amount').eq('organization_id', orgId)
      ]);
      users = uRes?.count || 0;
      products = pRes?.count || 0;
      if (sRes?.data) {
        sales = sRes.data.length;
        revenue = sRes.data.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
      }
    } catch (e) {
      console.warn('saGetOrgStats notice:', e);
      const allUsers = await idbGetAll('users');
      users = allUsers.filter(u => u.organization_id == orgId).length;
    }
  }

  return { users, products, sales, revenue };
}

// ─── BUSINESS TEMPLATES ───
const BUSINESS_TEMPLATES = {
  'Retail Shop': {
    icon: '🏪', categories: ['Clothing','Footwear','Accessories','Bags','Jewelry'],
    products: [
      { name:'Classic T-Shirt', sku:'TS-001', category:'Clothing', retail_price:2500, cost_price:1500, stock_qty:50, unit:'pcs' },
      { name:'Denim Jeans', sku:'JN-001', category:'Clothing', retail_price:5500, cost_price:3200, stock_qty:30, unit:'pcs' },
      { name:'Sport Sneakers', sku:'SN-001', category:'Footwear', retail_price:12000, cost_price:7500, stock_qty:15, unit:'pcs' },
      { name:'Leather Belt', sku:'BT-001', category:'Accessories', retail_price:1800, cost_price:900, stock_qty:40, unit:'pcs' },
      { name:'Sunglasses', sku:'SG-001', category:'Accessories', retail_price:3500, cost_price:1800, stock_qty:25, unit:'pcs' },
      { name:'Backpack', sku:'BP-001', category:'Bags', retail_price:6500, cost_price:3800, stock_qty:20, unit:'pcs' },
    ]
  },
  'Grocery Store': {
    icon: '🛒', categories: ['Rice & Grains','Spices','Beverages','Dairy','Snacks','Household'],
    products: [
      { name:'Basmati Rice 5kg', sku:'GR-001', category:'Rice & Grains', retail_price:1250, cost_price:950, stock_qty:100, unit:'packs' },
      { name:'Red Lentils 1kg', sku:'GR-002', category:'Rice & Grains', retail_price:480, cost_price:350, stock_qty:80, unit:'packs' },
      { name:'Turmeric Powder', sku:'SP-001', category:'Spices', retail_price:120, cost_price:75, stock_qty:200, unit:'packs' },
      { name:'Chili Powder 250g', sku:'SP-002', category:'Spices', retail_price:280, cost_price:180, stock_qty:150, unit:'packs' },
      { name:'Fresh Milk 1L', sku:'DA-001', category:'Dairy', retail_price:320, cost_price:260, stock_qty:50, unit:'bottles' },
      { name:'Cheddar Cheese', sku:'DA-002', category:'Dairy', retail_price:850, cost_price:620, stock_qty:30, unit:'packs' },
      { name:'Cola 1.5L', sku:'BV-001', category:'Beverages', retail_price:350, cost_price:280, stock_qty:60, unit:'bottles' },
      { name:'Biscuit Pack', sku:'SN-001', category:'Snacks', retail_price:180, cost_price:120, stock_qty:100, unit:'packs' },
    ]
  },
  'Bookshop': {
    icon: '📚', categories: ['Fiction','Non-Fiction','Textbooks','Stationery','Art Supplies'],
    products: [
      { name:'Novel - Bestseller', sku:'BK-001', category:'Fiction', retail_price:1200, cost_price:750, stock_qty:30, unit:'pcs' },
      { name:'Science Textbook', sku:'BK-002', category:'Textbooks', retail_price:2500, cost_price:1600, stock_qty:25, unit:'pcs' },
      { name:'Notebook A4 (5-pack)', sku:'ST-001', category:'Stationery', retail_price:450, cost_price:280, stock_qty:100, unit:'packs' },
      { name:'Ballpoint Pens (12)', sku:'ST-002', category:'Stationery', retail_price:360, cost_price:200, stock_qty:80, unit:'packs' },
      { name:'Watercolor Set', sku:'AR-001', category:'Art Supplies', retail_price:1800, cost_price:1100, stock_qty:20, unit:'sets' },
      { name:'Sketch Pad A3', sku:'AR-002', category:'Art Supplies', retail_price:650, cost_price:380, stock_qty:35, unit:'pcs' },
      { name:'Self-Help Book', sku:'BK-003', category:'Non-Fiction', retail_price:1500, cost_price:900, stock_qty:20, unit:'pcs' },
    ]
  },
  'Meat Shop': {
    icon: '🥩', categories: ['Chicken','Beef','Mutton','Fish & Seafood','Processed'],
    products: [
      { name:'Chicken Breast 1kg', sku:'MT-001', category:'Chicken', retail_price:1200, cost_price:850, stock_qty:40, unit:'kg' },
      { name:'Chicken Drumsticks 1kg', sku:'MT-002', category:'Chicken', retail_price:980, cost_price:700, stock_qty:35, unit:'kg' },
      { name:'Beef Steak 1kg', sku:'MT-003', category:'Beef', retail_price:2800, cost_price:2100, stock_qty:20, unit:'kg' },
      { name:'Minced Beef 500g', sku:'MT-004', category:'Beef', retail_price:1400, cost_price:1000, stock_qty:25, unit:'packs' },
      { name:'Mutton Leg 1kg', sku:'MT-005', category:'Mutton', retail_price:3500, cost_price:2600, stock_qty:15, unit:'kg' },
      { name:'Fresh Prawns 500g', sku:'SF-001', category:'Fish & Seafood', retail_price:2200, cost_price:1600, stock_qty:20, unit:'packs' },
      { name:'Beef Sausages (6pc)', sku:'PR-001', category:'Processed', retail_price:850, cost_price:550, stock_qty:30, unit:'packs' },
    ]
  },
  'Bakery': {
    icon: '🥐', categories: ['Bread','Cakes','Pastries','Cookies'],
    products: [
      { name:'White Bread Loaf', sku:'BK-001', category:'Bread', retail_price:180, cost_price:100, stock_qty:50, unit:'pcs' },
      { name:'Chocolate Cake', sku:'CK-001', category:'Cakes', retail_price:2500, cost_price:1400, stock_qty:10, unit:'pcs' },
      { name:'Croissant', sku:'PS-001', category:'Pastries', retail_price:250, cost_price:120, stock_qty:40, unit:'pcs' },
      { name:'Cookie Box (12pc)', sku:'CO-001', category:'Cookies', retail_price:600, cost_price:320, stock_qty:30, unit:'boxes' },
      { name:'Fish Bun', sku:'PS-002', category:'Pastries', retail_price:120, cost_price:60, stock_qty:60, unit:'pcs' },
      { name:'Hot Coffee', sku:'BV-001', category:'Beverages', retail_price:250, cost_price:80, stock_qty:999, unit:'cups' },
    ]
  },
  'Pharmacy': {
    icon: '💊', categories: ['OTC Medicine','Vitamins','Personal Care','Medical Devices','Baby Care'],
    products: [
      { name:'Paracetamol 500mg (10)', sku:'MD-001', category:'OTC Medicine', retail_price:120, cost_price:65, stock_qty:200, unit:'strips' },
      { name:'Vitamin C 1000mg (30)', sku:'VT-001', category:'Vitamins', retail_price:850, cost_price:520, stock_qty:50, unit:'bottles' },
      { name:'Hand Sanitizer 250ml', sku:'PC-001', category:'Personal Care', retail_price:450, cost_price:280, stock_qty:60, unit:'bottles' },
      { name:'Face Masks (50pc)', sku:'MD-002', category:'Medical Devices', retail_price:600, cost_price:350, stock_qty:40, unit:'boxes' },
      { name:'Digital Thermometer', sku:'MD-003', category:'Medical Devices', retail_price:1500, cost_price:800, stock_qty:20, unit:'pcs' },
      { name:'Baby Diapers (24pc)', sku:'BC-001', category:'Baby Care', retail_price:1800, cost_price:1200, stock_qty:30, unit:'packs' },
    ]
  },
  'Hardware Store': {
    icon: '🔧', categories: ['Tools','Fasteners','Paint','Electrical','Plumbing','Safety'],
    products: [
      { name:'Hammer 500g', sku:'TL-001', category:'Tools', retail_price:1200, cost_price:750, stock_qty:25, unit:'pcs' },
      { name:'Screwdriver Set (8pc)', sku:'TL-002', category:'Tools', retail_price:2500, cost_price:1500, stock_qty:15, unit:'sets' },
      { name:'Nails 2" (1kg)', sku:'FT-001', category:'Fasteners', retail_price:350, cost_price:200, stock_qty:100, unit:'packs' },
      { name:'Wall Paint 4L', sku:'PT-001', category:'Paint', retail_price:3200, cost_price:2200, stock_qty:20, unit:'cans' },
      { name:'Electrical Wire 10m', sku:'EL-001', category:'Electrical', retail_price:650, cost_price:400, stock_qty:40, unit:'rolls' },
      { name:'PVC Pipe 1m', sku:'PL-001', category:'Plumbing', retail_price:280, cost_price:160, stock_qty:50, unit:'pcs' },
    ]
  },
  'Restaurant': {
    icon: '🍽️', categories: ['Rice & Curry','Noodles','Snacks','Beverages','Desserts','Specials'],
    products: [
      { name:'Rice & Curry Plate', sku:'RC-001', category:'Rice & Curry', retail_price:450, cost_price:200, stock_qty:999, unit:'plates' },
      { name:'Chicken Fried Rice', sku:'FR-001', category:'Rice & Curry', retail_price:650, cost_price:280, stock_qty:999, unit:'plates' },
      { name:'Egg Noodles', sku:'ND-001', category:'Noodles', retail_price:550, cost_price:230, stock_qty:999, unit:'plates' },
      { name:'Spring Rolls (4pc)', sku:'SN-001', category:'Snacks', retail_price:380, cost_price:150, stock_qty:999, unit:'portions' },
      { name:'Fresh Juice', sku:'BV-001', category:'Beverages', retail_price:350, cost_price:100, stock_qty:999, unit:'glasses' },
      { name:'Ice Cream Sundae', sku:'DS-001', category:'Desserts', retail_price:480, cost_price:180, stock_qty:999, unit:'portions' },
    ]
  }
};

const PRODUCT_ICONS = {
  'Clothing':'👕','Footwear':'👟','Accessories':'💍','Bags':'🎒','Jewelry':'💎',
  'Rice & Grains':'🍚','Spices':'🌶️','Beverages':'🥤','Dairy':'🥛','Snacks':'🍪','Household':'🏠',
  'Fiction':'📖','Non-Fiction':'📘','Textbooks':'📕','Stationery':'✏️','Art Supplies':'🎨','Magazines':'📰',
  'Chicken':'🍗','Beef':'🥩','Mutton':'🐑','Fish & Seafood':'🐟','Processed':'🌭','Marinades':'🫙',
  'Bread':'🍞','Cakes':'🎂','Pastries':'🥐','Cookies':'🍪',
  'OTC Medicine':'💊','Vitamins':'💉','Personal Care':'🧴','Medical Devices':'🩺','Baby Care':'👶',
  'Tools':'🔨','Fasteners':'🔩','Paint':'🎨','Electrical':'⚡','Plumbing':'🔧','Safety':'🦺',
  'Rice & Curry':'🍛','Noodles':'🍜','Desserts':'🍨','Specials':'⭐',
  'default':'📦'
};

const BUSINESS_CONFIGS = {
  'Retail Shop':    { units: ['pcs'], extraFields: ['size','color','brand'], receiptFooter: 'Thank you for shopping with us!' },
  'Grocery Store':  { units: ['kg','packs','pcs','litre','g'], extraFields: ['expiry_date','supplier_name'], receiptFooter: 'Fresh goods, every day!' },
  'Bookshop':       { units: ['pcs'], extraFields: ['author','isbn','publisher'], receiptFooter: 'Keep reading, keep growing.' },
  'Meat Shop':      { units: ['kg','g','pcs','pack'], extraFields: ['cut_type','origin'], receiptFooter: 'Fresh cuts, every day.' },
  'Bakery':         { units: ['pcs','kg','slice','box','dozen'], extraFields: ['made_date','allergens'], receiptFooter: 'Baked fresh daily!' },
  'Pharmacy':       { units: ['pcs','strips','bottles','ml','mg'], extraFields: ['batch_number','expiry_date','manufacturer'], receiptFooter: 'Your health is our priority.' },
  'Hardware Store':  { units: ['pcs','meters','kg','box','roll','litre'], extraFields: ['brand','warranty_months'], receiptFooter: 'Quality tools for quality work.' },
  'Restaurant':     { units: ['portion','plate','cup','glass','pcs'], extraFields: ['table_number','waiter_name'], receiptFooter: 'Thank you! Come again.' },
};

async function loadBusinessTemplate(type) {
  const tmpl = BUSINESS_TEMPLATES[type];
  if (!tmpl) return;

  const targetOrgId = currentOrgId || '00000000-0000-0000-0000-000000000001';

  // Ensure organization exists in Supabase before inserting to prevent foreign key violations
  if (!isOffline() && supa && targetOrgId) {
    try {
      const { data: orgExists } = await supa.from('organizations').select('id').eq('id', targetOrgId).maybeSingle();
      if (!orgExists) {
        console.log(`[loadBusinessTemplate] Ensuring organization ${targetOrgId} exists in Supabase...`);
        const orgName = (typeof currentSettings !== 'undefined' && currentSettings.biz_name) || (type + ' Store');
        await supa.from('organizations').upsert({
          id: targetOrgId,
          name: orgName,
          slug: orgName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Math.floor(Math.random() * 1000),
          business_type: type,
          currency: (typeof currentSettings !== 'undefined' && currentSettings.currency) || 'Rs.',
          tax_rate: (typeof currentSettings !== 'undefined' && parseFloat(currentSettings.tax_rate)) || 0,
          is_active: true
        });
      }
    } catch (e) {
      console.warn('[loadBusinessTemplate] Organization check notice:', e);
    }
  }

  await db.categories.clear();
  await db.products.clear();

  for (const c of tmpl.categories) {
    await db.categories.add({ name: c, organization_id: targetOrgId });
  }

  for (const p of tmpl.products) {
    await db.products.add({
      ...p,
      barcode: '',
      wholesale_price: Math.round(p.retail_price * 0.8),
      low_stock_threshold: 5,
      is_active: true,
      organization_id: targetOrgId
    });
  }
}
