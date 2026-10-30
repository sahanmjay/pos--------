-- ═══════════════════════════════════════════════════════════
-- PickMe / Uber Eats orders and service charge: four columns on each bill.
--   order_type      dine_in / takeaway / delivery / pickme / uber
--   ref_no          the platform's order number (PickMe / Uber Eats only)
--   commission      the platform's cut, worked out at checkout and kept, so
--                   changing the % later never rewrites past days
--   service_charge  the dine-in service charge on this bill (0 when none)
-- Only adds columns; no existing data changes. Safe to run more than once
-- (run it again if you ran an earlier copy without service_charge).
-- Run in Supabase → SQL Editor. Until it is run, bills still save, just
-- without these fields.
-- ═══════════════════════════════════════════════════════════
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS order_type TEXT,
  ADD COLUMN IF NOT EXISTS ref_no TEXT,
  ADD COLUMN IF NOT EXISTS commission NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_charge NUMERIC DEFAULT 0;
