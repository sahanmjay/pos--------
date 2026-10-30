-- ═══════════════════════════════════════════════════════════
-- PickMe / Uber Eats orders: three columns on each bill.
--   order_type  dine_in / takeaway / delivery / pickme / uber
--   ref_no      the platform's order number (PickMe / Uber Eats only)
--   commission  the platform's cut, worked out at checkout and kept, so
--               changing the % later never rewrites past days
-- Only adds columns; no existing data changes. Safe to run more than once.
-- Run in Supabase → SQL Editor. Until it is run, bills still save, just
-- without these three fields.
-- ═══════════════════════════════════════════════════════════
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS order_type TEXT,
  ADD COLUMN IF NOT EXISTS ref_no TEXT,
  ADD COLUMN IF NOT EXISTS commission NUMERIC DEFAULT 0;
