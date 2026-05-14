-- ═══════════════════════════════════════════════════════════
-- NexPOS Performance Indexes — Run once in Supabase SQL Editor
-- Speeds up receipts, customer totals/outstanding, sales history, and POS search
-- ═══════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_customers_org_id
  ON public.customers (organization_id, id);

CREATE INDEX IF NOT EXISTS idx_sales_org_customer
  ON public.sales (organization_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_sales_org_date
  ON public.sales (organization_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_sale_items_org_sale
  ON public.sale_items (organization_id, sale_id);

CREATE INDEX IF NOT EXISTS idx_products_org_active
  ON public.products (organization_id, is_active, id DESC);

CREATE INDEX IF NOT EXISTS idx_products_org_barcode
  ON public.products (organization_id, barcode)
  WHERE barcode IS NOT NULL AND barcode <> '';

CREATE INDEX IF NOT EXISTS idx_products_org_sku
  ON public.products (organization_id, sku)
  WHERE sku IS NOT NULL AND sku <> '';
