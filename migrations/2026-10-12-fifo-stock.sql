-- ═══════════════════════════════════════════════════════════
-- NexPOS — FIFO stock batches and recipe snapshots
-- Safe on a live database: it only adds a table, columns and indexes and
-- changes no data. Run once in Supabase → SQL Editor. Running it again does
-- no harm.
--
-- Do NOT run saas-migration.sql on a live database: it starts by wiping
-- every table.
-- ═══════════════════════════════════════════════════════════

-- Each delivery is its own batch with its own price. Stock leaves oldest
-- batch first, so a new price never re-values what is already on the shelf.
-- Stock from before this table existed becomes each item's first batch the
-- first time the app touches it, at the item's cost price.
CREATE TABLE IF NOT EXISTS public.stock_batches (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL,
  product_name TEXT DEFAULT '',
  qty_received NUMERIC NOT NULL,
  qty_remaining NUMERIC NOT NULL,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reference TEXT DEFAULT '',
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS stock_batches_org_product_idx
  ON public.stock_batches (organization_id, product_id);

-- The recipe a dish was made with when it was sold. Returns and reports use
-- it, so editing a recipe only changes future sales.
ALTER TABLE public.sale_items ADD COLUMN IF NOT EXISTS recipe JSONB;

-- Columns earlier releases rely on, in case they were never added
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS item_type TEXT DEFAULT 'menu';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS recipe JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.sale_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC DEFAULT 0;

-- Lookups the daily report and the stock screen make
CREATE INDEX IF NOT EXISTS stock_movements_org_product_idx
  ON public.stock_movements (organization_id, product_id);
CREATE INDEX IF NOT EXISTS sales_org_date_idx ON public.sales (organization_id, date);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON public.sale_items (sale_id);
