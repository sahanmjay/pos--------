-- ═══════════════════════════════════════════════════════════
-- NexPOS — high-demand items
-- Safe on a live database: adds one column, changes no data.
-- Run once in Supabase → SQL Editor, then refresh the app.
-- ═══════════════════════════════════════════════════════════

-- Items marked ★ in Products get their own "High demand" tab on the till
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_popular BOOLEAN DEFAULT false;
