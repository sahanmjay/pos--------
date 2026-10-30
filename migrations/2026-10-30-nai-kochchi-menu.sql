-- ═══════════════════════════════════════════════════════════
-- Nai Kochchi Kegalle — load the full food menu (from "Updated Menu",
-- the latest spreadsheet version).
--
-- What it does, for this one business only:
--   • adds the categories and menu items below
--   • items with a Regular and a Large price become two items,
--     "… (R)" and "… (L)"
-- Fixed while copying: spelling (Prowns → Prawns, Omlet → Omelette …),
-- the repeated "Chicken & Egg Soup" is added once, and Sausage Cheese
-- Lasagna (R) is Rs. 1,650 (the sheet says 16,500).
-- Not added: the "One Kilo gram Bite Prices" section (it has no prices yet).
-- The menu's 10% service charge is not added to prices.
--
-- Run once in Supabase → SQL Editor. It stops without changing anything
-- unless exactly one business is named "Nai Kochchi…" and it has no menu yet.
-- ═══════════════════════════════════════════════════════════
DO $$
DECLARE
  org UUID;
  matches INT;
BEGIN
  SELECT count(*) INTO matches FROM public.organizations WHERE name ILIKE 'Nai Kochchi%';
  IF matches <> 1 THEN
    RAISE EXCEPTION 'Expected one business named "Nai Kochchi…", found %. Nothing was changed.', matches;
  END IF;
  SELECT id INTO org FROM public.organizations WHERE name ILIKE 'Nai Kochchi%';

  IF EXISTS (SELECT 1 FROM public.products WHERE organization_id = org AND COALESCE(item_type, 'menu') <> 'ingredient') THEN
    RAISE EXCEPTION 'Nai Kochchi already has menu items, so this was already run. Nothing was changed.';
  END IF;

  INSERT INTO public.categories (name, organization_id)
  SELECT c.name, org
  FROM unnest(ARRAY[
    'Starters', 'Soups', 'Fresh Corner', 'Fried Rice (Kiri Samba)', 'Fried Rice (Basmati)',
    'Nasi Goreng', 'Thai Rice & Noodles', 'Mongolian Rice', 'Pot Biryani', 'Chopsuey Rice',
    'Noodles', 'Pasta', 'Lasagna', 'Kottu', 'Shavol', 'Sandwiches', 'Burgers', 'Submarines',
    'Loaded Fries', 'Chicken Bites', 'Beef', 'BBQ', 'Seafood Sides', 'Sausage', 'Egg',
    'Vegetable Sides', 'Family Combos', 'Pizza', 'Desserts', 'Waffles', 'Milkshakes', 'Mojito',
    'Ice Tea', 'Cheesy Girl Tea', 'Boba', 'Hot Tea', 'Coffee', 'Fresh Juice', 'Lassi', 'Soft Drinks'
  ]) WITH ORDINALITY AS c(name, ord)
  ORDER BY c.ord;

  -- One row per menu line: Regular price, Large price (NULL when one size).
  -- Inserted last-first because the till shows the newest item first, so on
  -- the till they read in menu order.
  INSERT INTO public.products
    (name, sku, barcode, category, retail_price, wholesale_price, cost_price,
     stock_qty, low_stock_threshold, unit, is_active, item_type, recipe, organization_id)
  SELECT x.name, x.sku, '', x.category, x.price, x.price, 0,
         0, 0, x.unit, true, 'menu', '[]'::jsonb, org
  FROM (
    SELECT m.name || v.sfx AS name, m.category, v.price, m.unit, m.ord, v.k,
           m.code || '-' || lpad(row_number() OVER (PARTITION BY m.code ORDER BY m.ord, v.k)::text, 2, '0') AS sku
    FROM (VALUES
      -- Starters
      (  1, 'ST', 'Starters', 'Chicken Mini Kievs',      750, NULL, 'plate'),
      (  2, 'ST', 'Starters', 'French Fries',           1000, NULL, 'plate'),
      (  3, 'ST', 'Starters', 'Pakora',                  750, NULL, 'plate'),
      (  4, 'ST', 'Starters', 'Vegetable Spring Rolls',  750, NULL, 'plate'),
      (  5, 'ST', 'Starters', 'Seafood Cocktail',       1499, NULL, 'plate'),
      -- Soup with bread
      ( 10, 'SP', 'Soups', 'Vegetable Clear Soup',           500, NULL, 'bowl'),
      ( 11, 'SP', 'Soups', 'Cream of Vegetable Soup',        600, NULL, 'bowl'),
      ( 12, 'SP', 'Soups', 'Chicken & Egg Soup',             850, NULL, 'bowl'),
      ( 13, 'SP', 'Soups', 'Cream of Chicken Soup',          900, NULL, 'bowl'),
      ( 14, 'SP', 'Soups', 'Chicken with Sweet Corn Soup',   950, NULL, 'bowl'),
      ( 15, 'SP', 'Soups', 'Mushroom Soup',                 1150, NULL, 'bowl'),
      ( 16, 'SP', 'Soups', 'Seafood Chowder Soup',          1250, NULL, 'bowl'),
      -- Fresh corner
      ( 20, 'FC', 'Fresh Corner', 'Mix Vegetable Salad',          850, NULL, 'plate'),
      ( 21, 'FC', 'Fresh Corner', 'Coleslaw',                     950, NULL, 'plate'),
      ( 22, 'FC', 'Fresh Corner', 'Chicken Hawaii Salad',        1250, NULL, 'plate'),
      ( 23, 'FC', 'Fresh Corner', 'Russian Egg Salad',           1550, NULL, 'plate'),
      ( 24, 'FC', 'Fresh Corner', 'Caesar Chicken and Prawns',   2500, NULL, 'plate'),
      -- Fried rice, Kiri Samba
      ( 30, 'FK', 'Fried Rice (Kiri Samba)', 'Vegetable Fried Rice',         850,  950, 'plate'),
      ( 31, 'FK', 'Fried Rice (Kiri Samba)', 'Egg & Vegetable Fried Rice',   950, 1150, 'plate'),
      ( 32, 'FK', 'Fried Rice (Kiri Samba)', 'Chicken Fried Rice',          1050, 1300, 'plate'),
      ( 33, 'FK', 'Fried Rice (Kiri Samba)', 'Prawns Fried Rice',           1350, 1650, 'plate'),
      ( 34, 'FK', 'Fried Rice (Kiri Samba)', 'Fish Fried Rice',             1450, 1750, 'plate'),
      ( 35, 'FK', 'Fried Rice (Kiri Samba)', 'Seafood Fried Rice',          1550, 2000, 'plate'),
      ( 36, 'FK', 'Fried Rice (Kiri Samba)', 'Mixed Fried Rice',            1750, 2100, 'plate'),
      -- Fried rice, Basmati
      ( 40, 'FB', 'Fried Rice (Basmati)', 'Basmati Vegetable Fried Rice',  900, 1100, 'plate'),
      ( 41, 'FB', 'Fried Rice (Basmati)', 'Basmati Egg Fried Rice',        950, 1250, 'plate'),
      ( 42, 'FB', 'Fried Rice (Basmati)', 'Basmati Chicken Fried Rice',   1200, 1600, 'plate'),
      ( 43, 'FB', 'Fried Rice (Basmati)', 'Basmati Prawns Fried Rice',    1500, 2000, 'plate'),
      ( 44, 'FB', 'Fried Rice (Basmati)', 'Basmati Fish Fried Rice',      1650, 2100, 'plate'),
      ( 45, 'FB', 'Fried Rice (Basmati)', 'Basmati Seafood Fried Rice',   1900, 2300, 'plate'),
      ( 46, 'FB', 'Fried Rice (Basmati)', 'Basmati Mixed Fried Rice',     2000, 2500, 'plate'),
      -- Nasi goreng, for two
      ( 50, 'NG', 'Nasi Goreng', 'Nasi Goreng Chicken (2 Person)', 2300, NULL, 'plate'),
      ( 51, 'NG', 'Nasi Goreng', 'Nasi Goreng Seafood (2 Person)', 2550, NULL, 'plate'),
      ( 52, 'NG', 'Nasi Goreng', 'Nasi Goreng Mixed (2 Person)',   2650, NULL, 'plate'),
      -- Thai rice & noodles
      ( 55, 'TH', 'Thai Rice & Noodles', 'Thai Seafood Rice',                    1950, 2400, 'plate'),
      ( 56, 'TH', 'Thai Rice & Noodles', 'Nai Kochchi Special Thai Mixed Rice',  2300, 2800, 'plate'),
      ( 57, 'TH', 'Thai Rice & Noodles', 'Pad Thai Noodles Chicken',             1850, 2300, 'plate'),
      ( 58, 'TH', 'Thai Rice & Noodles', 'Pad Thai Noodles Beef',                2000, 2400, 'plate'),
      -- Mongolian rice
      ( 60, 'MG', 'Mongolian Rice', 'Mongolian Chicken Rice',        1700, 2150, 'plate'),
      ( 61, 'MG', 'Mongolian Rice', 'Mongolian Seafood Fried Rice',  1900, 2500, 'plate'),
      ( 62, 'MG', 'Mongolian Rice', 'Mongolian Mixed Fried Rice',    2200, 2750, 'plate'),
      -- Pot biryani
      ( 65, 'BR', 'Pot Biryani', 'Chicken Biryani 1 Person (Kiri Samba)', 1400, NULL, 'pot'),
      ( 66, 'BR', 'Pot Biryani', 'Chicken Biryani 1 Person (Basmati)',    1700, NULL, 'pot'),
      ( 67, 'BR', 'Pot Biryani', 'Chicken Biryani 2 Person (Kiri Samba)', 1899, NULL, 'pot'),
      ( 68, 'BR', 'Pot Biryani', 'Chicken Biryani 2 Person (Basmati)',    2100, NULL, 'pot'),
      ( 69, 'BR', 'Pot Biryani', 'Chicken Biryani 3 Person (Kiri Samba)', 3100, NULL, 'pot'),
      ( 70, 'BR', 'Pot Biryani', 'Chicken Biryani 3 Person (Basmati)',    3500, NULL, 'pot'),
      ( 71, 'BR', 'Pot Biryani', 'Chicken Biryani 4 Person (Kiri Samba)', 3800, NULL, 'pot'),
      ( 72, 'BR', 'Pot Biryani', 'Chicken Biryani 4 Person (Basmati)',    4500, NULL, 'pot'),
      ( 73, 'BR', 'Pot Biryani', 'Chicken Biryani 5 Person (Kiri Samba)', 4500, NULL, 'pot'),
      ( 74, 'BR', 'Pot Biryani', 'Chicken Biryani 5 Person (Basmati)',    5500, NULL, 'pot'),
      -- Chopsuey with rice
      ( 80, 'CR', 'Chopsuey Rice', 'Vegetable Chopsuey Rice',                 1450, 1850, 'plate'),
      ( 81, 'CR', 'Chopsuey Rice', 'Chicken Chopsuey with Rice',              1650, 2350, 'plate'),
      ( 82, 'CR', 'Chopsuey Rice', 'Fish Chopsuey with Rice',                 1850, 2500, 'plate'),
      ( 83, 'CR', 'Chopsuey Rice', 'Prawns Chopsuey with Rice',               1900, 2600, 'plate'),
      ( 84, 'CR', 'Chopsuey Rice', 'Seafood Chopsuey with Rice',              2400, 2900, 'plate'),
      ( 85, 'CR', 'Chopsuey Rice', 'Mixed Chopsuey with Rice',                2500, 3200, 'plate'),
      ( 86, 'CR', 'Chopsuey Rice', 'Nai Kochchi Special Chopsuey with Rice',  3000, 3800, 'plate'),
      -- Noodles
      ( 90, 'ND', 'Noodles', 'Vegetable Fried Noodles',      1000, 1250, 'plate'),
      ( 91, 'ND', 'Noodles', 'Egg Fried Noodles',            1100, 1350, 'plate'),
      ( 92, 'ND', 'Noodles', 'Chicken Fried Noodles',        1250, 1450, 'plate'),
      ( 93, 'ND', 'Noodles', 'Fish Fried Noodles',           1450, 1850, 'plate'),
      ( 94, 'ND', 'Noodles', 'Prawns Fried Noodles',         1500, 1850, 'plate'),
      ( 95, 'ND', 'Noodles', 'Seafood Fried Noodles',        1650, 1950, 'plate'),
      ( 96, 'ND', 'Noodles', 'Mixed Fried Noodles',          1750, 2250, 'plate'),
      ( 97, 'ND', 'Noodles', 'Nai Kochchi Special Noodles',  1900, 2500, 'plate'),
      -- Penne or spaghetti
      (100, 'PA', 'Pasta', 'Pasta with Mushroom Sauce',     1850, 2400, 'plate'),
      (101, 'PA', 'Pasta', 'Spaghetti Napolitana',          1750, 2200, 'plate'),
      (102, 'PA', 'Pasta', 'Pasta Milano',                  1900, 2300, 'plate'),
      (103, 'PA', 'Pasta', 'Carbonara Penne or Spaghetti',  2200, 2600, 'plate'),
      (104, 'PA', 'Pasta', 'Chicken Alfredo Pasta',         1500, 2400, 'plate'),
      (105, 'PA', 'Pasta', 'Spaghetti Marinara Seafood',    2300, 2850, 'plate'),
      (106, 'PA', 'Pasta', 'Spaghetti Bolognese',           2300, 2950, 'plate'),
      -- Lasagna
      (110, 'LS', 'Lasagna', 'Veggie Lasagna',           1500, 2000, 'plate'),
      (111, 'LS', 'Lasagna', 'Sausage Cheese Lasagna',   1650, 2200, 'plate'),
      (112, 'LS', 'Lasagna', 'Chicken Lasagna',          1750, 2350, 'plate'),
      (113, 'LS', 'Lasagna', 'Beef Lasagna',             2200, 2800, 'plate'),
      -- Kottu
      (120, 'KT', 'Kottu', 'Vegetable Kottu',                     850, 1000, 'plate'),
      (121, 'KT', 'Kottu', 'Egg Kottu',                          1100, 1100, 'plate'),
      (122, 'KT', 'Kottu', 'Chicken Kottu',                       900, 1500, 'plate'),
      (123, 'KT', 'Kottu', 'Fish Kottu',                         1450, 1850, 'plate'),
      (124, 'KT', 'Kottu', 'Seafood Kottu',                      1950, 2300, 'plate'),
      (125, 'KT', 'Kottu', 'Mixed Kottu',                        2050, 2400, 'plate'),
      (126, 'KT', 'Kottu', 'Dolphin Chicken Kottu',              1850, 2250, 'plate'),
      (127, 'KT', 'Kottu', 'Vegetable Cheese Kottu',             1350, 1750, 'plate'),
      (128, 'KT', 'Kottu', 'Chicken Cheese Kottu',               2000, 2500, 'plate'),
      (129, 'KT', 'Kottu', 'Chicken Cheese Kottu (One Person)',  1600, NULL, 'plate'),
      (130, 'KT', 'Kottu', 'Seafood Cheese Kottu',               2000, 2750, 'plate'),
      (131, 'KT', 'Kottu', 'Mixed Cheese Kottu',                 2300, 2850, 'plate'),
      -- Shavol (sharing platters)
      (140, 'SH', 'Shavol', 'Chicken Shavol Kottu (5 Person)',                 3950, NULL, 'platter'),
      (141, 'SH', 'Shavol', 'Chicken Shavol Rice (5 Person)',                  3950, NULL, 'platter'),
      (142, 'SH', 'Shavol', 'Shavol Chicken Rice & Kottu (5 Person)',          4000, NULL, 'platter'),
      (143, 'SH', 'Shavol', 'Shavol Rice, Kottu with Devilled & Salad (5 Person)', 4900, NULL, 'platter'),
      (144, 'SH', 'Shavol', 'Mixed Shavol Rice (3 Person)',                    4900, NULL, 'platter'),
      (145, 'SH', 'Shavol', 'Mixed Shavol Rice (5 Person)',                    7850, NULL, 'platter'),
      (146, 'SH', 'Shavol', 'Shavol Nasi Goreng (5 Person)',                   6350, NULL, 'platter'),
      (147, 'SH', 'Shavol', 'Shavol Cheese Chicken Kottu (5 Person)',          6500, NULL, 'platter'),
      (148, 'SH', 'Shavol', 'Shavol Cheese Chicken Pasta (5 Person)',          6800, NULL, 'platter'),
      (149, 'SH', 'Shavol', 'Nai Kochchi Chef Special Shavol (5 Person)',      7900, NULL, 'platter'),
      -- Sandwiches
      (150, 'SW', 'Sandwiches', 'Vegetable Sandwich',  950, NULL, 'pcs'),
      (151, 'SW', 'Sandwiches', 'Cheese Sandwich',    1200, NULL, 'pcs'),
      (152, 'SW', 'Sandwiches', 'Egg Sandwich',       1100, NULL, 'pcs'),
      (153, 'SW', 'Sandwiches', 'Chicken Sandwich',   1400, NULL, 'pcs'),
      (154, 'SW', 'Sandwiches', 'Fish Sandwich',      1500, NULL, 'pcs'),
      (155, 'SW', 'Sandwiches', 'Club Sandwich',      1500, NULL, 'pcs'),
      (156, 'SW', 'Sandwiches', 'Ros Pan Sandwich',   1200, NULL, 'pcs'),
      -- Burgers
      (160, 'BG', 'Burgers', 'Chicken Burger',                     850, NULL, 'pcs'),
      (161, 'BG', 'Burgers', 'Crispy Chicken Burger',             1999, NULL, 'pcs'),
      (162, 'BG', 'Burgers', 'Devilled Chicken Burger',           1500, NULL, 'pcs'),
      (163, 'BG', 'Burgers', 'Nai Kochchi Special Burger Tower',  4200, NULL, 'pcs'),
      (164, 'BG', 'Burgers', 'Good Night Good Cause Burger',      2850, NULL, 'pcs'),
      -- Submarines
      (170, 'SB', 'Submarines', 'Crispy Chicken Submarine',         1500, NULL, 'pcs'),
      (171, 'SB', 'Submarines', 'Crispy Chicken Cheese Submarine',  1999, NULL, 'pcs'),
      (172, 'SB', 'Submarines', 'Chilli Chicken Submarine',         1750, NULL, 'pcs'),
      (173, 'SB', 'Submarines', 'Devilled Chicken Submarine',       1750, NULL, 'pcs'),
      (174, 'SB', 'Submarines', 'Devilled Prawns Submarine',        1999, NULL, 'pcs'),
      (175, 'SB', 'Submarines', 'Kegalle Longest Submarine',        4500, NULL, 'pcs'),
      -- Loaded fries
      (180, 'LF', 'Loaded Fries', 'Cheese Loaded Fries',                       1800, NULL, 'plate'),
      (181, 'LF', 'Loaded Fries', 'Chicken & Cheese Loaded Fries',             2500, NULL, 'plate'),
      (182, 'LF', 'Loaded Fries', 'Crispy Chicken Cheese Loaded Fries',        2800, NULL, 'plate'),
      (183, 'LF', 'Loaded Fries', 'Sausages & Cheese Loaded Fries',            2800, NULL, 'plate'),
      (184, 'LF', 'Loaded Fries', 'Nai Kochchi & Chicken Cheese Loaded Fries', 2500, NULL, 'plate'),
      (185, 'LF', 'Loaded Fries', 'Nai Kochchi Special Loaded Fries',          3500, NULL, 'plate'),
      -- Bites: chicken
      (190, 'CB', 'Chicken Bites', 'Chicken Wings',                 1600, NULL, 'plate'),
      (191, 'CB', 'Chicken Bites', 'Devilled Chicken',              2500, NULL, 'plate'),
      (192, 'CB', 'Chicken Bites', 'Fried Chicken',                 2000, NULL, 'plate'),
      (193, 'CB', 'Chicken Bites', 'Hot Butter Chicken',            2500, NULL, 'plate'),
      (194, 'CB', 'Chicken Bites', 'Chilli Chicken',                2800, NULL, 'plate'),
      (195, 'CB', 'Chicken Bites', 'Sweet & Sour Chicken',          2500, NULL, 'plate'),
      (196, 'CB', 'Chicken Bites', 'Tandoori Style Grilled Chicken',2500, NULL, 'plate'),
      (197, 'CB', 'Chicken Bites', 'Chicken Black Pepper Curry',    2800, NULL, 'plate'),
      (198, 'CB', 'Chicken Bites', 'Chicken Stew',                  2500, NULL, 'plate'),
      (199, 'CB', 'Chicken Bites', 'Hot Garlic Chicken',            2500, NULL, 'plate'),
      (200, 'CB', 'Chicken Bites', 'Stir Fry Chicken',              2000, NULL, 'plate'),
      -- Bites: beef
      (205, 'BF', 'Beef', 'Saute Beef',          2900, NULL, 'plate'),
      (206, 'BF', 'Beef', 'Beef Stew',           3000, NULL, 'plate'),
      (207, 'BF', 'Beef', 'Black Pepper Beef',   3200, NULL, 'plate'),
      (208, 'BF', 'Beef', 'Devilled Beef',       2900, NULL, 'plate'),
      (209, 'BF', 'Beef', 'Kan Kan Beef',        3000, NULL, 'plate'),
      -- BBQ (served with salad & french fries or white rice)
      (215, 'BQ', 'BBQ', 'BBQ Chicken',   2500, NULL, 'plate'),
      (216, 'BQ', 'BBQ', 'BBQ Fish',      3000, NULL, 'plate'),
      (217, 'BQ', 'BBQ', 'BBQ Prawns',    2800, NULL, 'plate'),
      (218, 'BQ', 'BBQ', 'BBQ Sausages',  2000, NULL, 'plate'),
      -- Seafood side dishes
      (220, 'SF', 'Seafood Sides', 'Hot Butter Cuttlefish',  2000, NULL, 'plate'),
      (221, 'SF', 'Seafood Sides', 'Hot Butter Prawns',      2500, NULL, 'plate'),
      (222, 'SF', 'Seafood Sides', 'Pepper Fish',            2800, NULL, 'plate'),
      (223, 'SF', 'Seafood Sides', 'Fried Fish',             2200, NULL, 'plate'),
      (224, 'SF', 'Seafood Sides', 'Devilled Fish',          2500, NULL, 'plate'),
      (225, 'SF', 'Seafood Sides', 'Devilled Prawns',        2500, NULL, 'plate'),
      (226, 'SF', 'Seafood Sides', 'Thai Chilli Prawns',     2800, NULL, 'plate'),
      (227, 'SF', 'Seafood Sides', 'Fish Stew',              2800, NULL, 'plate'),
      -- Sausage
      (230, 'SS', 'Sausage', 'Jumbo Fried Sausage',     1500, NULL, 'plate'),
      (231, 'SS', 'Sausage', 'Jumbo Devilled Sausage',  1750, NULL, 'plate'),
      -- Egg
      (235, 'EG', 'Egg', 'Plain Omelette',                     550, NULL, 'plate'),
      (236, 'EG', 'Egg', 'Bullseye',                           300, NULL, 'plate'),
      (237, 'EG', 'Egg', 'Boiled Egg',                         200, NULL, 'pcs'),
      (238, 'EG', 'Egg', 'Sri Lankan Omelette',                600, NULL, 'plate'),
      (239, 'EG', 'Egg', 'Cheese Omelette',                    950, NULL, 'plate'),
      (240, 'EG', 'Egg', 'Cheese Chicken Omelette',           1250, NULL, 'plate'),
      (241, 'EG', 'Egg', 'Chicken & Sausage Omelette',        1100, NULL, 'plate'),
      (242, 'EG', 'Egg', 'Nai Kochchi Chef Special Omelette', 1350, NULL, 'plate'),
      (243, 'EG', 'Egg', 'Chicken Omelette',                  1000, NULL, 'plate'),
      -- Vegetable
      (250, 'VG', 'Vegetable Sides', 'Boiled Vegetable',        1350, NULL, 'plate'),
      (251, 'VG', 'Vegetable Sides', 'Vegetable Chopsuey',      1450, NULL, 'plate'),
      (252, 'VG', 'Vegetable Sides', 'Batter Fried Vegetable',  1200, NULL, 'plate'),
      (253, 'VG', 'Vegetable Sides', 'Hot Butter Mushroom',     1300, NULL, 'plate'),
      (254, 'VG', 'Vegetable Sides', 'Kankun with Garlic',       850, NULL, 'plate'),
      (255, 'VG', 'Vegetable Sides', 'Kankun with Onion',        850, NULL, 'plate'),
      (256, 'VG', 'Vegetable Sides', 'Fried Garlic',             650, NULL, 'plate'),
      (257, 'VG', 'Vegetable Sides', 'Potato Wedges',           1500, NULL, 'plate'),
      -- Family combo packs
      (260, 'FM', 'Family Combos', 'Egg Fried Rice Combo (4 Person)',      4999, NULL, 'pack'),
      (261, 'FM', 'Family Combos', 'Egg Kottu Combo (4 Person)',           4999, NULL, 'pack'),
      (262, 'FM', 'Family Combos', 'Egg Fried Noodles Combo (4 Person)',   5999, NULL, 'pack'),
      (263, 'FM', 'Family Combos', 'Family Combo (6 Person)',              8250, NULL, 'pack'),
      (264, 'FM', 'Family Combos', 'Biryani Combo (10 Person)',           11000, NULL, 'pack'),
      -- Pizza
      (270, 'PZ', 'Pizza', 'Pizza Adults Only',             3300, NULL, 'pcs'),
      (271, 'PZ', 'Pizza', 'Pizza Sausage Delight',         3100, NULL, 'pcs'),
      (272, 'PZ', 'Pizza', 'Pizza Margherita',              3200, NULL, 'pcs'),
      (273, 'PZ', 'Pizza', 'BBQ Chicken & Cheese Pizza',    3400, NULL, 'pcs'),
      (274, 'PZ', 'Pizza', 'Pizza Tandoori',                3400, NULL, 'pcs'),
      (275, 'PZ', 'Pizza', 'Pizza Seafood Delight',         3800, NULL, 'pcs'),
      (276, 'PZ', 'Pizza', 'Pizza Milano',                  3800, NULL, 'pcs'),
      -- Desserts
      (280, 'DS', 'Desserts', 'Watalappam',                              300, NULL, 'cup'),
      (281, 'DS', 'Desserts', 'Cream Caramel Pudding',                  2100, NULL, 'plate'),
      (282, 'DS', 'Desserts', 'Brownie with Ice Cream Sizzling',        2100, NULL, 'plate'),
      (283, 'DS', 'Desserts', 'Lava Cake',                               950, NULL, 'pcs'),
      (284, 'DS', 'Desserts', 'Cheese Cream (Chocolate)',               1200, NULL, 'cup'),
      (285, 'DS', 'Desserts', 'Cheese Cream (Vanilla)',                  400, NULL, 'cup'),
      (286, 'DS', 'Desserts', 'Kegalle Clock Tower Ice Cream Sizzling', 2800, NULL, 'plate'),
      -- Waffles
      (290, 'WF', 'Waffles', 'Milky Waffle',                     850, NULL, 'pcs'),
      (291, 'WF', 'Waffles', 'Honey Waffle',                     900, NULL, 'pcs'),
      (292, 'WF', 'Waffles', 'Strawberry Waffle',               1200, NULL, 'pcs'),
      (293, 'WF', 'Waffles', 'Chocolate Waffle',                1150, NULL, 'pcs'),
      (294, 'WF', 'Waffles', 'Strawberry & Chocolate Waffle',   1500, NULL, 'pcs'),
      -- Milkshakes
      (300, 'MS', 'Milkshakes', 'Vanilla Milkshake',     850, NULL, 'glass'),
      (301, 'MS', 'Milkshakes', 'Chocolate Milkshake',   900, NULL, 'glass'),
      (302, 'MS', 'Milkshakes', 'Banana Milkshake',      950, NULL, 'glass'),
      (303, 'MS', 'Milkshakes', 'Strawberry Milkshake',  950, NULL, 'glass'),
      (304, 'MS', 'Milkshakes', 'Mango Milkshake',      1100, NULL, 'glass'),
      (305, 'MS', 'Milkshakes', 'Coffee Milkshake',      950, NULL, 'glass'),
      (306, 'MS', 'Milkshakes', 'Faluda Milkshake',      650, NULL, 'glass'),
      (307, 'MS', 'Milkshakes', 'Milo Milkshake',        850, NULL, 'glass'),
      (308, 'MS', 'Milkshakes', 'Oreo Milkshake',       1300, NULL, 'glass'),
      (309, 'MS', 'Milkshakes', 'Kit Kat Milkshake',    1300, NULL, 'glass'),
      -- Mojito
      (310, 'MJ', 'Mojito', 'Mint Mojito',              750, NULL, 'glass'),
      (311, 'MJ', 'Mojito', 'Passion Fruit Mojito',     850, NULL, 'glass'),
      (312, 'MJ', 'Mojito', 'Spicy Mojito',             850, NULL, 'glass'),
      (313, 'MJ', 'Mojito', 'Sky Blue Mojito',          900, NULL, 'glass'),
      (314, 'MJ', 'Mojito', 'Blackcurrant Mojito',      850, NULL, 'glass'),
      (315, 'MJ', 'Mojito', 'Apple Mojito',            1050, NULL, 'glass'),
      (316, 'MJ', 'Mojito', 'Pineapple Mojito',        1100, NULL, 'glass'),
      (317, 'MJ', 'Mojito', 'Strawberry Mojito',        950, NULL, 'glass'),
      (318, 'MJ', 'Mojito', 'Rainbow Mojito',           950, NULL, 'glass'),
      (319, 'MJ', 'Mojito', 'King Coconut Mojito',     1050, NULL, 'glass'),
      -- Ice tea
      (320, 'IT', 'Ice Tea', 'Lime Ice Tea',          650, NULL, 'glass'),
      (321, 'IT', 'Ice Tea', 'Apple Ice Tea',         700, NULL, 'glass'),
      (322, 'IT', 'Ice Tea', 'Blackcurrant Ice Tea',  700, NULL, 'glass'),
      (323, 'IT', 'Ice Tea', 'Strawberry Ice Tea',    750, NULL, 'glass'),
      -- Cheesy girl tea
      (325, 'CG', 'Cheesy Girl Tea', 'Classic Cheesy Girl',     1250, NULL, 'glass'),
      (326, 'CG', 'Cheesy Girl Tea', 'Mango Cheesy Girl',       1350, NULL, 'glass'),
      (327, 'CG', 'Cheesy Girl Tea', 'Strawberry Cheesy Girl',  1250, NULL, 'glass'),
      (328, 'CG', 'Cheesy Girl Tea', 'Choco Cheesy Girl',       1200, NULL, 'glass'),
      -- Boba shakes and popping boba
      (330, 'BB', 'Boba', 'Choco Boba Milkshake',      1100, NULL, 'glass'),
      (331, 'BB', 'Boba', 'Vanilla Boba Milkshake',    1000, NULL, 'glass'),
      (332, 'BB', 'Boba', 'Faluda Boba Milkshake',      950, NULL, 'glass'),
      (333, 'BB', 'Boba', 'Milo Boba Milkshake',       1050, NULL, 'glass'),
      (334, 'BB', 'Boba', 'Milk Coffee Boba Shake',    1100, NULL, 'glass'),
      (335, 'BB', 'Boba', 'Passion Boba Tea',           950, NULL, 'glass'),
      (336, 'BB', 'Boba', 'Blackcurrant Boba Tea',      950, NULL, 'glass'),
      (337, 'BB', 'Boba', 'Strawberry Boba Tea',        950, NULL, 'glass'),
      -- Hot tea pot
      (340, 'TE', 'Hot Tea', 'Plain Tea',           350, NULL, 'pot'),
      (341, 'TE', 'Hot Tea', 'Green Tea',           450, NULL, 'pot'),
      (342, 'TE', 'Hot Tea', 'Black Tea',           350, NULL, 'pot'),
      (343, 'TE', 'Hot Tea', 'Ceylon Ginger Tea',   350, NULL, 'pot'),
      (344, 'TE', 'Hot Tea', 'Milk Tea',            450, NULL, 'pot'),
      (345, 'TE', 'Hot Tea', 'Milk Coffee',         550, NULL, 'pot'),
      -- Coffee, hot and iced
      (350, 'CF', 'Coffee', 'Black Coffee',          400, NULL, 'cup'),
      (351, 'CF', 'Coffee', 'Cappuccino',            950, NULL, 'cup'),
      (352, 'CF', 'Coffee', 'Americano',             450, NULL, 'cup'),
      (353, 'CF', 'Coffee', 'Latte Macchiato',      1200, NULL, 'cup'),
      (354, 'CF', 'Coffee', 'Mocha Latte',          1100, NULL, 'cup'),
      (355, 'CF', 'Coffee', 'Espresso Single',       450, NULL, 'cup'),
      (356, 'CF', 'Coffee', 'Espresso Double',       550, NULL, 'cup'),
      (357, 'CF', 'Coffee', 'Hot Chocolate',         850, NULL, 'cup'),
      (358, 'CF', 'Coffee', 'Flat White Coffee',    1100, NULL, 'cup'),
      (359, 'CF', 'Coffee', 'Iced Latte',            950, NULL, 'glass'),
      (360, 'CF', 'Coffee', 'Iced Americano',        750, NULL, 'glass'),
      (361, 'CF', 'Coffee', 'Iced Mocha Latte',      950, NULL, 'glass'),
      (362, 'CF', 'Coffee', 'Iced Chocolate',       1200, NULL, 'glass'),
      (363, 'CF', 'Coffee', 'Iced Hazelnut Latte',  1200, NULL, 'glass'),
      -- Fresh juice
      (370, 'JU', 'Fresh Juice', 'Mango Juice',         750, NULL, 'glass'),
      (371, 'JU', 'Fresh Juice', 'Watermelon Juice',    650, NULL, 'glass'),
      (372, 'JU', 'Fresh Juice', 'Orange Juice',       1450, NULL, 'glass'),
      (373, 'JU', 'Fresh Juice', 'Pineapple Juice',     750, NULL, 'glass'),
      (374, 'JU', 'Fresh Juice', 'Banana Juice',        650, NULL, 'glass'),
      (375, 'JU', 'Fresh Juice', 'Papaya Juice',        650, NULL, 'glass'),
      (376, 'JU', 'Fresh Juice', 'Lime Juice',          550, NULL, 'glass'),
      (377, 'JU', 'Fresh Juice', 'Mixed Fruit Juice',   850, NULL, 'glass'),
      -- Lassi
      (380, 'LA', 'Lassi', 'Mango Lassi',          950, NULL, 'glass'),
      (381, 'LA', 'Lassi', 'Banana Lassi',         950, NULL, 'glass'),
      (382, 'LA', 'Lassi', 'Papaya Lassi',         950, NULL, 'glass'),
      (383, 'LA', 'Lassi', 'Pineapple Lassi',      950, NULL, 'glass'),
      (384, 'LA', 'Lassi', 'Mint Lassi',           750, NULL, 'glass'),
      (385, 'LA', 'Lassi', 'Mint & Mango Lassi',   950, NULL, 'glass'),
      -- Soft drinks
      (390, 'SD', 'Soft Drinks', 'Water Bottle 500ml',    100, NULL, 'bottle'),
      (391, 'SD', 'Soft Drinks', 'Water Bottle 1000ml',   130, NULL, 'bottle'),
      (392, 'SD', 'Soft Drinks', 'Water Bottle 1500ml',   150, NULL, 'bottle'),
      (393, 'SD', 'Soft Drinks', 'Coca Cola Glass',       350, NULL, 'glass'),
      (394, 'SD', 'Soft Drinks', 'Sprite Glass',          350, NULL, 'glass')
    ) AS m(ord, code, category, name, r, l, unit)
    CROSS JOIN LATERAL (
      SELECT ' (R)' AS sfx, m.r AS price, 1 AS k WHERE m.l IS NOT NULL
      UNION ALL SELECT ' (L)', m.l, 2 WHERE m.l IS NOT NULL
      UNION ALL SELECT '', m.r, 1 WHERE m.l IS NULL
    ) v
  ) x
  ORDER BY x.ord DESC, x.k DESC;
END $$;
