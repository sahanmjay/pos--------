-- ═══════════════════════════════════════════════════════════
-- NexPOS — RLS Fix Script
-- Run this in Supabase SQL Editor to allow the anon key
-- to read/write all tables
-- ═══════════════════════════════════════════════════════════

-- Step 1: Drop any existing policies that might be blocking
DO $$ 
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT policyname, tablename 
    FROM pg_policies 
    WHERE schemaname = 'public'
  ) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- Step 2: Enable RLS (required before creating policies)
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.held_carts ENABLE ROW LEVEL SECURITY;

-- Step 3: Create permissive "allow all" policies for development
CREATE POLICY "allow_all" ON public.organizations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.categories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.customers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.sales FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.sale_items FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.attendance FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON public.held_carts FOR ALL USING (true) WITH CHECK (true);
