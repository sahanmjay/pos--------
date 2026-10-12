-- ═══════════════════════════════════════════════════════════
-- Crystal Restaurant & Cafe — replace the sample menu with the real one
-- (taken from the price boards in the shop).
--
-- What it does, for this one business only:
--   • deletes its menu items and categories (the old sample menu)
--   • keeps its kitchen ingredients (chicken, rice …) and all past bills —
--     old bills keep the item names they were sold under
--   • adds the categories and items below
-- Items the board shows with no price are added switched off at Rs. 0:
-- set a price in Products and switch them on when they are sold.
-- Recipes are not copied: add them again on each item in Products.
--
-- Run once in Supabase → SQL Editor. It stops without changing anything
-- unless exactly one business is named "Crystal Restaurant…".
-- ═══════════════════════════════════════════════════════════
DO $$
DECLARE
  org UUID;
  matches INT;
BEGIN
  SELECT count(*) INTO matches FROM public.organizations WHERE name ILIKE 'Crystal Restaurant%';
  IF matches <> 1 THEN
    RAISE EXCEPTION 'Expected one business named "Crystal Restaurant…", found %. Nothing was changed.', matches;
  END IF;
  SELECT id INTO org FROM public.organizations WHERE name ILIKE 'Crystal Restaurant%';

  DELETE FROM public.products WHERE organization_id = org AND COALESCE(item_type, 'menu') <> 'ingredient';
  DELETE FROM public.categories WHERE organization_id = org;

  INSERT INTO public.categories (name, organization_id)
  SELECT c.name, org
  FROM unnest(ARRAY[
    'Breakfast', 'Rice & Curry (Lunch)', 'Fried Rice', 'Kottu', 'Short Eats', 'Bites',
    'Korean & Salads', 'Fresh Juice', 'Milkshakes', 'Ice Cream', 'Drinks & Snacks'
  ]) WITH ORDINALITY AS c(name, ord)
  ORDER BY c.ord;

  -- Listed in board order. Inserted last-first because the till shows the
  -- newest item first, so on the till they read in this order.
  INSERT INTO public.products
    (name, sku, barcode, category, retail_price, wholesale_price, cost_price,
     stock_qty, low_stock_threshold, unit, is_active, item_type, recipe, organization_id)
  SELECT m.name, m.sku, '', m.category, m.price, m.price, 0,
         0, 0, m.unit, m.price > 0, 'menu', '[]'::jsonb, org
  FROM (VALUES
    -- උදේ කෑම — Breakfast
    (  1, 'Breakfast', 'Rice & Curry (Breakfast)', 'BF-01', 400, 'plate'),
    (  2, 'Breakfast', 'Plain Roti',               'BF-02', 200, 'pcs'),
    (  3, 'Breakfast', 'Thosai',                   'BF-03',  80, 'pcs'),
    (  4, 'Breakfast', 'Egg Roti',                 'BF-04', 100, 'pcs'),
    (  5, 'Breakfast', 'Parata',                   'BF-05',  40, 'pcs'),
    (  6, 'Breakfast', 'String Hoppers',           'BF-06',  10, 'pcs'),
    (  7, 'Breakfast', 'Noodles',                  'BF-07', 700, 'plate'),
    (  8, 'Breakfast', 'Lavariya',                 'BF-08',  70, 'pcs'),
    -- දවල් කෑම රයිස් ඇන්ඩ් කරි — Lunch rice & curry
    ( 10, 'Rice & Curry (Lunch)', 'Vegetable Rice & Curry', 'RC-01', 350, 'plate'),
    ( 11, 'Rice & Curry (Lunch)', 'Egg Rice & Curry',       'RC-02', 380, 'plate'),
    ( 12, 'Rice & Curry (Lunch)', 'Chicken Rice & Curry',   'RC-03', 400, 'plate'),
    ( 13, 'Rice & Curry (Lunch)', 'Fish Rice & Curry',      'RC-04', 400, 'plate'),
    ( 14, 'Rice & Curry (Lunch)', 'Sausage Rice & Curry',   'RC-05',   0, 'plate'),
    -- රයිස් / කොත්තු — one board, Normal and Full, same price for rice or kottu
    ( 20, 'Fried Rice', 'Egg Fried Rice (Normal)',      'FR-01', 500, 'plate'),
    ( 21, 'Fried Rice', 'Egg Fried Rice (Full)',        'FR-02', 700, 'plate'),
    ( 22, 'Fried Rice', 'Chicken Fried Rice (Normal)',  'FR-03', 700, 'plate'),
    ( 23, 'Fried Rice', 'Chicken Fried Rice (Full)',    'FR-04', 850, 'plate'),
    ( 24, 'Fried Rice', 'Beef Fried Rice (Normal)',     'FR-05',   0, 'plate'),
    ( 25, 'Fried Rice', 'Beef Fried Rice (Full)',       'FR-06',   0, 'plate'),
    ( 26, 'Fried Rice', 'Mixed Fried Rice (Normal)',    'FR-07', 1000, 'plate'),
    ( 27, 'Fried Rice', 'Mixed Fried Rice (Full)',      'FR-08', 1300, 'plate'),
    ( 28, 'Fried Rice', 'Seafood Fried Rice (Normal)',  'FR-09', 1000, 'plate'),
    ( 29, 'Fried Rice', 'Seafood Fried Rice (Full)',    'FR-10', 1300, 'plate'),
    ( 30, 'Kottu', 'Egg Kottu (Normal)',      'KT-01', 500, 'plate'),
    ( 31, 'Kottu', 'Egg Kottu (Full)',        'KT-02', 700, 'plate'),
    ( 32, 'Kottu', 'Chicken Kottu (Normal)',  'KT-03', 700, 'plate'),
    ( 33, 'Kottu', 'Chicken Kottu (Full)',    'KT-04', 850, 'plate'),
    ( 34, 'Kottu', 'Beef Kottu (Normal)',     'KT-05',   0, 'plate'),
    ( 35, 'Kottu', 'Beef Kottu (Full)',       'KT-06',   0, 'plate'),
    ( 36, 'Kottu', 'Mixed Kottu (Normal)',    'KT-07', 1000, 'plate'),
    ( 37, 'Kottu', 'Mixed Kottu (Full)',      'KT-08', 1300, 'plate'),
    ( 38, 'Kottu', 'Cheese Kottu (Normal)',   'KT-09',   0, 'plate'),
    ( 39, 'Kottu', 'Cheese Kottu (Full)',     'KT-10',   0, 'plate'),
    ( 40, 'Kottu', 'Seafood Kottu (Normal)',  'KT-11', 1000, 'plate'),
    ( 41, 'Kottu', 'Seafood Kottu (Full)',    'KT-12', 1300, 'plate'),
    -- ෂෝට් ඊට්ස් — Short eats
    ( 50, 'Short Eats', 'Parippu Vadai',     'SE-01',  20, 'pcs'),
    ( 51, 'Short Eats', 'Vegetable Roti',    'SE-02',  70, 'pcs'),
    ( 52, 'Short Eats', 'Egg Samosa',        'SE-03',  80, 'pcs'),
    ( 53, 'Short Eats', 'Vegetable Samosa',  'SE-04',  70, 'pcs'),
    ( 54, 'Short Eats', 'Ulundu Vadai',      'SE-05',  60, 'pcs'),
    ( 55, 'Short Eats', 'Egg Pattie',        'SE-06',   0, 'pcs'),
    ( 56, 'Short Eats', 'Sausage Bun',       'SE-07', 120, 'pcs'),
    ( 57, 'Short Eats', 'Egg Roll',          'SE-08',   0, 'pcs'),
    ( 58, 'Short Eats', 'Egg Bun',           'SE-09', 120, 'pcs'),
    ( 59, 'Short Eats', 'Chicken Pattie',    'SE-10',   0, 'pcs'),
    ( 60, 'Short Eats', 'Chicken Roll',      'SE-11', 100, 'pcs'),
    ( 61, 'Short Eats', 'Cutlet',            'SE-12',   0, 'pcs'),
    -- බයිට් වර්ග — Bites
    ( 70, 'Bites', 'Omelette',          'BT-01',  70, 'portion'),
    ( 71, 'Bites', 'Chicken Devilled',  'BT-02', 350, 'portion'),
    ( 72, 'Bites', 'Pork Devilled',     'BT-03',   0, 'portion'),
    ( 73, 'Bites', 'Fried Fish',        'BT-04', 350, 'portion'),
    ( 74, 'Bites', 'Fried Sausages',    'BT-05', 350, 'portion'),
    ( 75, 'Bites', 'Fish Devilled',     'BT-06', 400, 'portion'),
    ( 76, 'Bites', 'Sausages',          'BT-07',   0, 'portion'),
    -- සැලඩ් / කොරියන්
    ( 80, 'Korean & Salads', 'Salad',            'KS-01', 300, 'portion'),
    ( 81, 'Korean & Salads', 'Korean Noodles',   'KS-02', 350, 'plate'),
    ( 82, 'Korean & Salads', 'Korean Toffee',    'KS-03', 120, 'pcs'),
    -- ජූස් — Fresh juice
    ( 90, 'Fresh Juice', 'Papaya Juice',        'JU-01', 300, 'glass'),
    ( 91, 'Fresh Juice', 'Watermelon Juice',    'JU-02', 250, 'glass'),
    ( 92, 'Fresh Juice', 'Mango Juice',         'JU-03', 350, 'glass'),
    ( 93, 'Fresh Juice', 'Passion Fruit Juice', 'JU-04', 300, 'glass'),
    ( 94, 'Fresh Juice', 'Mixed Fruit Juice',   'JU-05', 350, 'glass'),
    ( 95, 'Fresh Juice', 'Avocado Juice',       'JU-06', 350, 'glass'),
    ( 96, 'Fresh Juice', 'Lime Juice',          'JU-07', 200, 'glass'),
    -- Milkshakes
    (100, 'Milkshakes', 'Strawberry Milkshake', 'MS-01', 400, 'glass'),
    (101, 'Milkshakes', 'Chocolate Milkshake',  'MS-02', 450, 'glass'),
    (102, 'Milkshakes', 'Vanilla Milkshake',    'MS-03', 350, 'glass'),
    (103, 'Milkshakes', 'Banana Milkshake',     'MS-04', 375, 'glass'),
    (104, 'Milkshakes', 'Mango Milkshake',      'MS-05', 400, 'glass'),
    -- Ice cream
    (110, 'Ice Cream', 'Strawberry Ice Cream', 'IC-01', 120, 'cup'),
    (111, 'Ice Cream', 'Chocolate Ice Cream',  'IC-02', 120, 'cup'),
    (112, 'Ice Cream', 'Vanilla Ice Cream',    'IC-03', 120, 'cup'),
    (113, 'Ice Cream', 'Banana Ice Cream',     'IC-04', 120, 'cup'),
    (114, 'Ice Cream', 'Mango Ice Cream',      'IC-05', 120, 'cup'),
    -- Ice coffee, faluda, popcorn
    (120, 'Drinks & Snacks', 'Ice Coffee', 'DS-01', 400, 'glass'),
    (121, 'Drinks & Snacks', 'Faluda',     'DS-02', 350, 'glass'),
    (122, 'Drinks & Snacks', 'Popcorn',    'DS-03', 100, 'pack')
  ) AS m(ord, category, name, sku, price, unit)
  ORDER BY m.ord DESC;
END $$;
