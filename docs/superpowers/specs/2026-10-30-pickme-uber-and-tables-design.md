# PickMe / Uber Eats orders and table management upgrade

Date: 2026-10-30 · Status: approved in chat, awaiting spec review
Applies to: restaurant-mode businesses (Nai Kochchi Kegalle, Crystal Restaurant & Cafe).
Shops without tables see no change.

## Why

The Nai Kochchi client reported three problems: PickMe/Uber orders, table booking,
and UI errors. The UI errors are fixed separately. This spec covers PickMe/Uber
(part 1) and the table upgrade (part 2). Bookings (table reservations, venue and
event bookings with advances) follow in their own spec, because they build on
part 2's floor areas.

## Part 1: PickMe and Uber Eats orders

### What the client asked for (all four confirmed)
1. Platform orders cost more than dine-in (to cover commission).
2. Sales tracked per platform, separately from cash.
3. The platform's order number on the bill and KOT.
4. Commission subtracted so profit is real.

### Settings
- New section, Settings → **Delivery platforms**. It lists PickMe and Uber Eats,
  each with **Price markup %** and **Commission %**. Both default to 0.
- Stored as one settings row, key `delivery_platforms`, value JSON:
  `[{ "id": "pickme", "name": "PickMe", "markup": 25, "commission": 20 }, { "id": "uber", ... }]`.
- No adding or removing platforms (YAGNI). The two ids are fixed.

### POS
- The order-type selector gains **PickMe** and **Uber Eats** after Delivery.
- Choosing a platform:
  - reprices every cart line and every item added afterwards to
    `ceil(retail_price × (1 + markup/100) / 10) × 10`, so prices are rounded up to Rs. 10;
  - shows a required **Platform order no.** input under the selector;
  - hides the table picker (platform orders have no table).
- Switching back to Dine-in, Takeaway or Delivery reprices the lines to `retail_price`.
- Price shown on the menu cards also uses the platform price while a platform is selected.

### Checkout
- With a platform selected, the Cash, Card and Credit buttons and the fast-cash bar are
  replaced by one button: **Complete PickMe order** (or Uber Eats).
- It refuses to complete without a platform order no.
- The sale is saved with `payment_type` = `pickme` or `uber`, so:
  - the cash drawer's expected cash is unchanged, because it counts only `cash`;
  - the daily report's payment breakdown shows PickMe and Uber Eats lines with no code
    change, because it groups by `payment_type`;
  - the Reports screen payment summary, which only knows cash, card and credit today,
    gains `pickme` and `uber` keys.

### Stored on each sale (new columns, guarded)
| Column | Meaning |
|---|---|
| `order_type` | dine_in / takeaway / delivery / pickme / uber |
| `ref_no` | platform order number, NULL otherwise |
| `commission` | `total × commission% / 100` at checkout, 0 otherwise |

- Commission is stored, not recalculated, so a later % change never rewrites past days.
  This follows the same rule as `sale_items.cost_price`.
- Migration `migrations/2026-10-30-sales-order-type.sql` adds the three columns
  (`ADD COLUMN IF NOT EXISTS`). The user runs it once in Supabase.
- Until it is run, the app checks for the columns the way `salesSupportsBillNo()` does
  and leaves the fields out, so bills still save.

### Printing
- KOT: the order line reads `PICKME #<ref_no>` (or `UBER EATS #<ref_no>`).
- Receipt: a line `PickMe order #<ref_no>` under the bill number. Payment method prints
  as PICKME or UBER EATS.

### Profit
- Daily report: a new line **Platform commission** (the day's sum of `commission`),
  subtracted after gross profit and before expenses. It is hidden when 0.
- Reports screen: `netProfit` also subtracts the period's commission, with its own row
  in the profit table.

## Part 2: Table management upgrade

### Floor areas
- Table objects in `tables_config` gain `area` (string, default `''`).
- The Add Table and Edit Table forms get an **Area** input with a `<datalist>` of
  areas already in use.
- Floor screen:
  - filter chips **All · <each area>** (hidden when no table has an area);
  - tables grouped under area headings; tables with no area go under "Main floor".
- There is no separate area list to manage.

### Statuses
| Status | When | Colour |
|---|---|---|
| Occupied | the table's order has items (unchanged) | existing |
| Needs Cleaning | set when a dine-in bill for the table completes | amber |
| Vacant | otherwise | existing |
| Reserved | (bookings spec) | blue |

- Needs Cleaning is stored as `activeTableOrders[tableId] = { items: [], cleaning: true }`
  instead of deleting the entry at checkout.
- Every existing "is busy" check uses `items.length > 0`, so a cleaning table still
  counts as free for those checks.
- It syncs to other tills through the existing `TABLE_UPDATED` broadcast and
  `restaurant_tables_state`.
- Table card: a **Mark Clean** button clears it. Starting an order on a cleaning table
  also clears it.
- Summary cards: Total · Vacant · Occupied · Needs Cleaning · Running total.

### Move, merge and split
All three are one function: `moveTableItems(fromId, toId, picks)`.
- `picks` = null: the whole order.
  - Target empty → **move**. Order, customer and openedAt carry over.
  - Target occupied → **merge**. Lines with the same product, price and note have their
    quantities added; other lines are appended. The earlier openedAt wins.
- `picks` = `[{ index, qty }]` → **split**. Those quantities leave the source and go to
  the target. Source lines that reach 0 are removed.
- The source is deleted when it ends up empty.
- KOTs whose `table_id` is the source are re-pointed to the target, and `table_name` is
  updated, only when the whole order moved. For a split, KOTs stay with the source.
- Afterwards: `saveRestaurantState()`, a `TABLE_UPDATED` broadcast, and a re-render.
- UI:
  - an occupied card gets **Move / Merge**, which opens a table picker (vacant and
    occupied tables are labelled, and the source is excluded);
  - the Table Overview modal gets **Split bill**: each line with a qty stepper (0 to its
    qty), then pick a target table.

### Unchanged
POS checkout logic beyond the platform button, receipts for normal sales, reports for
normal sales.

## Testing
- `tests/table-move-check.js`: node assertions for `moveTableItems` covering move to
  empty, merge with matching lines, split partial qty, split the last qty (source
  removed), and that quantities and totals are conserved. `moveTableItems` is a
  top-level pure function over a plain orders object, so the test pulls it out of
  app.js by brace matching, the way `tests/fifo-check.js` does.
- `tests/platform-price-check.js`: assertions for the platform price rounding and
  the commission amount.
- Browser check on the local server at till size: switch to PickMe, see the repriced
  cart, the order no. required, the single complete button; move, merge and split on
  the floor screen.

## Order of work
Part 1, then part 2. Each part is committed on its own.
