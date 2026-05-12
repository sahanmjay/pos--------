-- ═══════════════════════════════════════════════════════════
-- NexPOS Commercial Migration — Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. CLEAN SLATE — Drop all existing tables
DROP TABLE IF EXISTS public.attendance CASCADE;
DROP TABLE IF EXISTS public.sale_items CASCADE;
DROP TABLE IF EXISTS public.sales CASCADE;
DROP TABLE IF EXISTS public.held_carts CASCADE;
DROP TABLE IF EXISTS public.products CASCADE;
DROP TABLE IF EXISTS public.categories CASCADE;
DROP TABLE IF EXISTS public.customers CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.settings CASCADE;
DROP TABLE IF EXISTS public.organizations CASCADE;

-- 2. CREATE ORGANIZATIONS TABLE (Multi-Tenancy Core)
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  business_type TEXT NOT NULL DEFAULT 'Retail Shop',
  currency TEXT NOT NULL DEFAULT 'Rs.',
  tax_rate NUMERIC(5,2) DEFAULT 0,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  subscription TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. CREATE ALL TABLES WITH organization_id
CREATE TABLE public.users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.products (
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
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  outstanding_balance NUMERIC DEFAULT 0,
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.sales (
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
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL,
  line_total NUMERIC NOT NULL,
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.settings (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  display_name TEXT NOT NULL,
  date DATE NOT NULL,
  clock_in TIMESTAMP WITH TIME ZONE,
  clock_out TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL,
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.shift_closures (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  closed_by TEXT,
  close_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expected_cash DECIMAL(12,2),
  counted_cash DECIMAL(12,2),
  variance DECIMAL(12,2),
  denominations TEXT,
  notes TEXT,
  organization_id UUID REFERENCES public.organizations(id)
);

CREATE TABLE public.held_carts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  items JSONB,
  customer_id INTEGER,
  date TEXT,
  organization_id UUID REFERENCES public.organizations(id)
);

-- 4. DISABLE RLS FOR NOW (Will enable after Supabase Auth setup)
ALTER TABLE public.organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.products DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.held_carts DISABLE ROW LEVEL SECURITY;

-- 5. SEED DEFAULT ORGANIZATION
INSERT INTO public.organizations (id, name, slug, business_type, currency)
VALUES ('00000000-0000-0000-0000-000000000001', 'My Shop', 'my-shop', 'Retail Shop', 'Rs.');

-- 6. SEED DEFAULT USERS (linked to the default org)
INSERT INTO public.users (username, password, display_name, role, organization_id)
VALUES ('admin', '123', 'Administrator', 'Admin', '00000000-0000-0000-0000-000000000001');

INSERT INTO public.users (username, password, display_name, role, organization_id)
VALUES ('counter', '123', 'Counter Staff', 'Counter', '00000000-0000-0000-0000-000000000001');

INSERT INTO public.users (username, password, display_name, role, organization_id)
VALUES ('hr', '123', 'HR Manager', 'HR', '00000000-0000-0000-0000-000000000001');

INSERT INTO public.users (username, password, display_name, role, organization_id)
VALUES ('inv', '123', 'Inventory Manager', 'Inventory', '00000000-0000-0000-0000-000000000001');

-- 7. SEED DEFAULT CUSTOMER
INSERT INTO public.customers (name, phone, email, outstanding_balance, organization_id)
VALUES ('Walk-in Customer', '', '', 0, '00000000-0000-0000-0000-000000000001');

-- 8. SEED DEFAULT SETTINGS
INSERT INTO public.settings (key, value, organization_id) VALUES ('biz_name', 'My Shop', '00000000-0000-0000-0000-000000000001');
INSERT INTO public.settings (key, value, organization_id) VALUES ('biz_type', 'Retail Shop', '00000000-0000-0000-0000-000000000001');
INSERT INTO public.settings (key, value, organization_id) VALUES ('currency', 'Rs.', '00000000-0000-0000-0000-000000000001');
INSERT INTO public.settings (key, value, organization_id) VALUES ('tax_rate', '0', '00000000-0000-0000-0000-000000000001');
INSERT INTO public.settings (key, value, organization_id) VALUES ('phone', '', '00000000-0000-0000-0000-000000000001');
INSERT INTO public.settings (key, value, organization_id) VALUES ('address', '', '00000000-0000-0000-0000-000000000001');
