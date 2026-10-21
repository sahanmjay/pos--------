-- ═══════════════════════════════════════════════════════════
-- Monthly Bill Number Unique Index Migration
-- Enables bill numbers to reset to 1 at the beginning of each calendar month.
-- ═══════════════════════════════════════════════════════════

-- 1. Drop old all-time unique index (which blocked monthly resets to 1)
DROP INDEX IF EXISTS public.sales_org_bill_no_idx;

-- 2. Create normal high-performance index for filtering and sorting by organization and date
CREATE INDEX IF NOT EXISTS sales_org_date_bill_no_idx
  ON public.sales (organization_id, date, bill_no);
