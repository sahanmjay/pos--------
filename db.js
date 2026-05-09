const SUPABASE_URL = 'https://rakklmxpukcehbyjuxjy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc';

const { createClient } = supabase;
const supa = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentOrgId = null;

// ─── SUPABASE COMPATIBILITY LAYER (with multi-tenancy) ───

class SupaQuery {
  constructor(table, filters) {
    this._table = table;
    this._filters = filters;
  }
  equals(val) {
    this._filters.push({ field: this._field, val });
    return this;
  }
  async first() {
    let q = supa.from(this._table).select('*');
    if (currentOrgId && this._table !== 'organizations') {
      q = q.eq('organization_id', currentOrgId);
    }
    for (const f of this._filters) q = q.eq(f.field, f.val);
    const { data } = await q.limit(1).maybeSingle();
    return data || null;
  }
  async toArray() {
    let q = supa.from(this._table).select('*');
    if (currentOrgId && this._table !== 'organizations') {
      q = q.eq('organization_id', currentOrgId);
    }
    for (const f of this._filters) q = q.eq(f.field, f.val);
    const { data } = await q;
    return data || [];
  }
}

class SupaTable {
  constructor(name) { this._name = name; }

  async toArray() {
    let q = supa.from(this._name).select('*').order('id', { ascending: true });
    if (currentOrgId && this._name !== 'organizations') {
      q = q.eq('organization_id', currentOrgId);
    }
    const { data, error } = await q;
    if (error) { console.error('toArray', this._name, error); return []; }
    return data;
  }

  async get(id) {
    let q = supa.from(this._name).select('*').eq('id', id);
    if (currentOrgId && this._name !== 'organizations') {
      q = q.eq('organization_id', currentOrgId);
    }
    const { data } = await q.maybeSingle();
    return data || null;
  }

  async add(item) {
    if (currentOrgId && this._name !== 'organizations') {
      item.organization_id = currentOrgId;
    }
    const { data, error } = await supa.from(this._name).insert(item).select('id').single();
    if (error) { console.error('add', this._name, error); return null; }
    return data.id;
  }

  async bulkAdd(items) {
    if (currentOrgId && this._name !== 'organizations') {
      items = items.map(i => ({ ...i, organization_id: currentOrgId }));
    }
    const { error } = await supa.from(this._name).insert(items);
    if (error) console.error('bulkAdd', this._name, error);
  }

  async update(id, changes) {
    const { error } = await supa.from(this._name).update(changes).eq('id', id);
    if (error) console.error('update', this._name, error);
  }

  async delete(id) {
    const { error } = await supa.from(this._name).delete().eq('id', id);
    if (error) console.error('delete', this._name, error);
  }

  async clear() {
    let q = supa.from(this._name).delete();
    if (currentOrgId && this._name !== 'organizations') {
      q = q.eq('organization_id', currentOrgId);
    } else {
      q = q.neq('id', 0);
    }
    const { error } = await q;
    if (error) console.error('clear', this._name, error);
  }

  async count() {
    let q = supa.from(this._name).select('*', { count: 'exact', head: true });
    if (currentOrgId && this._name !== 'organizations') {
      q = q.eq('organization_id', currentOrgId);
    }
    const { count, error } = await q;
    if (error) return 0;
    return count;
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
};

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
    icon: '📚', categories: ['Fiction','Non-Fiction','Textbooks','Stationery','Art Supplies','Magazines'],
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
    icon: '🥩', categories: ['Chicken','Beef','Mutton','Fish & Seafood','Processed','Marinades'],
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
    icon: '🍞', categories: ['Bread','Cakes','Pastries','Cookies','Beverages'],
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

// ─── BUSINESS TYPE CONFIGS (extended per guide Fix 4) ───
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

  await db.categories.clear();
  await db.products.clear();

  for (const c of tmpl.categories) {
    await db.categories.add({ name: c });
  }

  for (const p of tmpl.products) {
    await db.products.add({
      ...p,
      barcode: '',
      wholesale_price: Math.round(p.retail_price * 0.8),
      low_stock_threshold: 5,
      is_active: true
    });
  }
}
