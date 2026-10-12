-- ═══════════════════════════════════════════════════════════
-- Crystal Restaurant & Cafe — remove test data
--   • kitchen ingredients "chicken" and "rice", with their stock batches
--     and stock history
--   • customer "Sahan MJ"
-- Nothing else is touched. Run once in Supabase → SQL Editor. It stops
-- without changing anything unless exactly one business is named
-- "Crystal Restaurant…".
-- ═══════════════════════════════════════════════════════════
DO $$
DECLARE
  org UUID;
  matches INT;
  test_items INT[];
BEGIN
  SELECT count(*) INTO matches FROM public.organizations WHERE name ILIKE 'Crystal Restaurant%';
  IF matches <> 1 THEN
    RAISE EXCEPTION 'Expected one business named "Crystal Restaurant…", found %. Nothing was changed.', matches;
  END IF;
  SELECT id INTO org FROM public.organizations WHERE name ILIKE 'Crystal Restaurant%';

  SELECT array_agg(id) INTO test_items FROM public.products
  WHERE organization_id = org AND item_type = 'ingredient' AND lower(name) IN ('chicken', 'rice');

  IF test_items IS NOT NULL THEN
    DELETE FROM public.stock_batches   WHERE organization_id = org AND product_id = ANY (test_items);
    DELETE FROM public.stock_movements WHERE organization_id = org AND product_id = ANY (test_items);
    DELETE FROM public.products        WHERE organization_id = org AND id = ANY (test_items);
  END IF;

  DELETE FROM public.customers WHERE organization_id = org AND name = 'Sahan MJ';
END $$;
