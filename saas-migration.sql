-- ═══════════════════════════════════════════════════════════
-- NexPOS SaaS Complete Migration & Clean Slate Reset
-- Safe, Idempotent, and Error-Free
-- Run this script in the Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- ─── 1. PURGE ALL PAST DATA SAFELY (Clean Slate Reset) ───
-- Only truncates tables that actually exist in the database, preventing "relation does not exist" errors
DO $$ 
DECLARE 
  tbl TEXT;
  tbls TEXT[] := ARRAY[
    'sale_items', 'sales', 'held_carts', 'shift_closures', 'attendance',
    'products', 'categories', 'customers', 'settings', 'payroll',
    'advances', 'pos_shifts', 'audit_log', 'platform_log', 'users', 'organizations'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE 'TRUNCATE TABLE public.' || quote_ident(tbl) || ' CASCADE';
    END IF;
  END LOOP;
END $$;


-- ─── 2. ENSURE ALL APPLICATION TABLES EXIST ───

CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  business_type TEXT NOT NULL DEFAULT 'Retail Shop',
  currency TEXT NOT NULL DEFAULT 'Rs.',
  tax_rate NUMERIC(5,2) DEFAULT 0,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  subscription TEXT NOT NULL DEFAULT 'free',
  plan_id TEXT DEFAULT 'free',
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID,
  logo_url TEXT DEFAULT '',
  last_activity TIMESTAMPTZ DEFAULT now(),
  max_users INTEGER DEFAULT 3,
  max_products INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure all multi-tenant columns exist on organizations
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT '';
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS plan_id TEXT DEFAULT 'free';
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS max_users INTEGER DEFAULT 3;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS max_products INTEGER DEFAULT 100;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS public.users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  hourly_rate NUMERIC DEFAULT 0,
  ot_rate NUMERIC DEFAULT 0,
  last_paid_date TEXT,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  barcode TEXT,
  category TEXT,
  retail_price NUMERIC NOT NULL,
  wholesale_price NUMERIC,
  cost_price NUMERIC,
  stock_qty NUMERIC DEFAULT 0,
  low_stock_threshold NUMERIC DEFAULT 5,
  unit TEXT DEFAULT 'pcs',
  is_active BOOLEAN DEFAULT TRUE,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  outstanding_balance NUMERIC DEFAULT 0,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.sales (
  id SERIAL PRIMARY KEY,
  date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  subtotal NUMERIC NOT NULL,
  discount NUMERIC DEFAULT 0,
  tax NUMERIC DEFAULT 0,
  total_amount NUMERIC NOT NULL,
  payment_type TEXT NOT NULL,
  status TEXT DEFAULT 'completed',
  customer_id INTEGER,
  cashier TEXT NOT NULL,
  items_count INTEGER NOT NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

-- The cost of a line at the moment it was sold. Without it, repricing a
-- product rewrites the profit on every sale that ever included it.
ALTER TABLE public.sale_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC DEFAULT 0;

-- Each business numbers its own bills 1, 2, 3. sales.id is a SERIAL shared by
-- every tenant, so it is unusable as a customer-facing receipt number.
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS bill_no INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS sales_org_bill_no_idx
  ON public.sales (organization_id, bill_no) WHERE bill_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL,
  line_total NUMERIC NOT NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.settings (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  display_name TEXT NOT NULL,
  date DATE NOT NULL,
  clock_in TIMESTAMP WITH TIME ZONE,
  clock_out TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.shift_closures (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  closed_by TEXT,
  close_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expected_cash DECIMAL(12,2),
  counted_cash DECIMAL(12,2),
  variance DECIMAL(12,2),
  denominations TEXT,
  notes TEXT,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.held_carts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  items JSONB,
  customer_id INTEGER,
  date TEXT,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);


-- ─── 3. SUPER ADMINS TABLE (Platform owners only) ───
CREATE TABLE IF NOT EXISTS public.super_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login TIMESTAMPTZ
);


-- ─── 4. SUBSCRIPTION PLANS TABLE ───
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_users INTEGER DEFAULT 3,
  max_products INTEGER DEFAULT 100,
  max_monthly_sales INTEGER DEFAULT 500,
  features JSONB DEFAULT '{}',
  price_monthly NUMERIC DEFAULT 0
);


-- ─── 5. PLATFORM ACTIVITY LOG TABLE ───
CREATE TABLE IF NOT EXISTS public.platform_log (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT DEFAULT '',
  action TEXT NOT NULL,
  target_org UUID,
  target_name TEXT DEFAULT '',
  details JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT now()
);


-- ─── 6. PLATFORM SETTINGS TABLE (AI engines, API keys, global toggles) ───
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);


-- ─── 7. ROW LEVEL SECURITY (Safe & Idempotent) ───
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_super_admins" ON public.super_admins;
CREATE POLICY "allow_all_super_admins" ON public.super_admins FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_subscription_plans" ON public.subscription_plans;
CREATE POLICY "allow_all_subscription_plans" ON public.subscription_plans FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.platform_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_platform_log" ON public.platform_log;
CREATE POLICY "allow_all_platform_log" ON public.platform_log FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_platform_settings" ON public.platform_settings;
CREATE POLICY "allow_all_platform_settings" ON public.platform_settings FOR ALL USING (true) WITH CHECK (true);

-- Ensure all application tables allow API access safely
DO $$ 
DECLARE 
  tbl TEXT;
  tbls TEXT[] := ARRAY[
    'organizations', 'users', 'categories', 'products', 'customers',
    'sales', 'sale_items', 'settings', 'attendance', 'held_carts', 
    'shift_closures', 'payroll', 'advances', 'pos_shifts', 'audit_log'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE 'ALTER TABLE public.' || quote_ident(tbl) || ' DISABLE ROW LEVEL SECURITY';
    END IF;
  END LOOP;
END $$;


-- ─── 8. SEED SUPER ADMIN (Platform Owner) ───
INSERT INTO public.super_admins (username, password, display_name, email)
VALUES ('superadmin', 'super@123', 'Platform Owner', 'admin@nexpos.cloud')
ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password;


-- ─── 9. SEED SUBSCRIPTION PLANS ───
INSERT INTO public.subscription_plans (id, name, max_users, max_products, max_monthly_sales, features, price_monthly) VALUES
  ('free', 'Free', 3, 100, 500, '{"reports":false,"ai":false}', 0),
  ('starter', 'Starter', 10, 500, 2000, '{"reports":true,"ai":false}', 2500),
  ('pro', 'Professional', 25, 2000, 10000, '{"reports":true,"ai":true}', 7500),
  ('enterprise', 'Enterprise', 999, 99999, 999999, '{"reports":true,"ai":true,"priority_support":true}', 15000)
ON CONFLICT (id) DO NOTHING;


-- ─── 10. SEED PLATFORM SETTINGS (AI & SaaS Defaults) ───
INSERT INTO public.platform_settings (key, value) VALUES
  ('ai_provider', 'google'),
  ('ai_model', 'gemini-1.5-flash'),
  ('ai_enabled', 'true'),
  ('ai_plan_requirement', 'pro'),
  ('ai_api_key', '')
ON CONFLICT (key) DO NOTHING;


-- ─── 11. SEED DEFAULT BUSINESSES & STARTER INVENTORY ───
-- Default Main Business
INSERT INTO public.organizations (id, name, slug, business_type, currency, tax_rate, subscription, plan_id, max_users, max_products, is_active)
VALUES ('00000000-0000-0000-0000-000000000001', 'NexPOS Main Store', 'main-store', 'Restaurant', 'Rs.', 0, 'enterprise', 'enterprise', 999, 99999, true)
ON CONFLICT (id) DO UPDATE SET is_active = true;

-- Default Business Admin
INSERT INTO public.users (username, password, display_name, role, is_active, organization_id)
SELECT 'admin', '231', 'Administrator', 'Admin', true, '00000000-0000-0000-0000-000000000001'
WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE username = 'admin' AND organization_id = '00000000-0000-0000-0000-000000000001');

-- Business "testingone"
INSERT INTO public.organizations (id, name, slug, business_type, currency, tax_rate, subscription, plan_id, max_users, max_products, is_active)
VALUES ('cc5471c9-578e-428c-a85e-ad06f09094bd', 'testingone', 'testingone', 'Restaurant', 'Rs.', 0, 'free', 'free', 10, 500, true)
ON CONFLICT (slug) DO UPDATE SET is_active = true;

-- Admin for "testingone"
INSERT INTO public.users (username, password, display_name, role, is_active, organization_id)
SELECT 'namal', 'admin', 'namal', 'Admin', true, 'cc5471c9-578e-428c-a85e-ad06f09094bd'
WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE username = 'namal');

-- Starter Categories & Products for both stores
DO $$
DECLARE
  org_rec RECORD;
BEGIN
  FOR org_rec IN SELECT id FROM public.organizations WHERE slug IN ('main-store', 'testingone') LOOP
    -- Customer
    IF NOT EXISTS (SELECT 1 FROM public.customers WHERE organization_id = org_rec.id) THEN
      INSERT INTO public.customers (name, phone, email, outstanding_balance, organization_id)
      VALUES ('Walk-in Customer', '', '', 0, org_rec.id);
    END IF;

    -- Categories
    INSERT INTO public.categories (name, organization_id)
    SELECT c, org_rec.id FROM unnest(ARRAY['Rice & Curry', 'Noodles', 'Snacks', 'Beverages', 'Desserts', 'Specials']) AS c
    WHERE NOT EXISTS (SELECT 1 FROM public.categories WHERE name = c AND organization_id = org_rec.id);

    -- Products
    INSERT INTO public.products (name, sku, category, retail_price, wholesale_price, cost_price, stock_qty, unit, is_active, organization_id)
    SELECT p.name, p.sku, p.cat, p.price, p.wprice, p.cprice, 999, p.unit, true, org_rec.id
    FROM (VALUES
      ('Rice & Curry Plate', 'RC-001', 'Rice & Curry', 450, 360, 200, 'plates'),
      ('Chicken Fried Rice', 'FR-001', 'Rice & Curry', 650, 520, 280, 'plates'),
      ('Egg Noodles', 'ND-001', 'Noodles', 550, 440, 230, 'plates'),
      ('Spring Rolls (4pc)', 'SN-001', 'Snacks', 380, 300, 150, 'portions'),
      ('Fresh Juice', 'BV-001', 'Beverages', 350, 280, 100, 'glasses'),
      ('Ice Cream Sundae', 'DS-001', 'Desserts', 480, 380, 180, 'portions')
    ) AS p(name, sku, cat, price, wprice, cprice, unit)
    WHERE NOT EXISTS (SELECT 1 FROM public.products WHERE sku = p.sku AND organization_id = org_rec.id);
  END LOOP;
END $$;

