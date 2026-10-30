# PickMe / Uber Eats and Table Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PickMe and Uber Eats order types with marked-up prices, platform order no., per-platform payment, and commission in profit; then floor areas, Needs Cleaning status, and move/merge/split for tables.

**Architecture:** Everything lives in the existing app.js, index.html and style.css, following current patterns. Platform settings are one `settings` row (`delivery_platforms`). Platform bills use `payment_type` = `pickme`/`uber`, so the cash drawer and the daily report's payment breakdown work unchanged. Three guarded `sales` columns (order_type, ref_no, commission) come from a migration the user runs. Table changes extend `tables_config` and `activeTableOrders`. Pure logic (`platformPrice`, `platformCommission`, `moveTableItems`) is top-level and tested by node scripts that extract it from app.js, the way `tests/fifo-check.js` does.

**Tech Stack:** Vanilla JS, Supabase (PostgREST), IndexedDB cache, node assert scripts.

**Spec:** docs/superpowers/specs/2026-10-30-pickme-uber-and-tables-design.md

## Global Constraints
- Restaurant mode only. Shops without tables see no change.
- Platform price = `ceil(retail × (1 + markup/100) / 10) × 10`. Markup and commission default to 0.
- A platform bill cannot complete without a platform order no.
- Commission is stored per bill at checkout, never recalculated.
- Never write to the live DB from the session. The migration is handed to the user.

## Review Focus
- Switching order type with items already in the cart: lines are repriced both ways. Covered in the Task 3 browser check.
- Migration not run yet: bills still save, minus the new fields. Covered in Task 3 by `salesSupportsOrderType()` dropping the keys.
- Resuming a held PickMe bill: the dining type is restored, so prices are re-applied. Covered because `setDiningType` reprices.
- Merging a table whose lines match the target: quantities are added, not duplicated. Covered in Task 6 test.
- Splitting the last unit of a line: the line is removed, and the source is deleted when empty. Covered in Task 6 test.

---

### Task 1: Migration and column guard
**Files:** Create `migrations/2026-10-30-sales-order-type.sql`. Modify `db.js` (guard and export).
- [ ] SQL: `ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS order_type TEXT, ADD COLUMN IF NOT EXISTS ref_no TEXT, ADD COLUMN IF NOT EXISTS commission NUMERIC DEFAULT 0;`
- [ ] `salesSupportsOrderType()`, cached the same way as `salesSupportsBillNo()`, selecting `order_type`. Exported on `db`.
- [ ] Commit.

### Task 2: Platform pricing helpers, tested
**Files:** Modify `app.js` (near `DINING_LABELS`). Create `tests/platform-price-check.js`.
**Produces:** `PLATFORM_IDS = ['pickme','uber']`, `platformPrice(price, markup) → number`, `platformCommission(total, pct) → number`, `deliveryPlatforms() → [{id,name,markup,commission}]`, `currentPlatform() → platform | null`, `posPrice(p) → number`.
- [ ] Test: `platformPrice(1250, 25) === 1570`, `platformPrice(1000, 0) === 1000`, `platformPrice(999, 0) === 999` (no markup means no rounding), `platformCommission(1570, 20) === 314`, `platformCommission(1000, 0) === 0`.
- [ ] Implement, run `node tests/platform-price-check.js`, and commit.

### Task 3: POS order types, pricing, checkout, settings
**Files:** `index.html` (dining buttons, order-no row, platform pay button, settings inputs), `app.js` (`setDiningType`, `addToCart`, grid price, `payNow`, `executeCheckout`, `saveSettings`, `renderRestaurantSettingsUI`), `style.css` (order-no row).
- [ ] PickMe and Uber Eats buttons. `DINING_LABELS` gains them.
- [ ] `setDiningType` shows or hides the order-no row, table row, fast-cash bar, payment buttons and platform button, then calls `repriceCart()`.
- [ ] `addToCart` and the grid use `posPrice(p)`.
- [ ] `payNow('platform')` requires the order no, then calls `executeCheckout(currentPlatform().id, total, total, 0, …)`.
- [ ] `executeCheckout` sets `order_type`, `ref_no` and `commission`, and drops them when `salesSupportsOrderType()` is false. It clears the order-no box after a sale.
- [ ] Settings: four inputs, saved as `delivery_platforms` by `saveSettings`.
- [ ] Browser check at till size, then commit.

### Task 4: Printing
- [ ] KOT `table_name` for a platform = `PICKME #<ref>` / `UBER EATS #<ref>`.
- [ ] Receipt: the pay method uses the platform name, plus a `<Platform> order: #<ref>` line. Commit.

### Task 5: Reports
- [ ] Daily report: `takings.commission`, and `profit = net − cogs − commission`. A "Platform commission" row (screen and print) when > 0.
- [ ] Reports screen: `payments` gains pickme and uber, the chart shows them, and `commissionTotal` is subtracted in `netProfit` with a P&L row. Commit.

### Task 6: moveTableItems, tested
**Produces:** `moveTableItems(orders, fromId, toId, picks) → orders` (mutates and returns). `picks` null means the whole order; otherwise `[{index, qty}]`.
- [ ] Test: move to empty; merge with a matching line (qty adds); split part of a qty; split the last qty (line and source removed); the total value is conserved.
- [ ] Implement, run `node tests/table-move-check.js`, and commit.

### Task 7: Table UI: areas, cleaning, move/merge/split
- [ ] Area field in the add and edit modals (with a datalist), chips, and grouped floor.
- [ ] Checkout marks a dine-in table `{items:[], cleaning:true}`. Mark Clean button. Summary count.
- [ ] Move / Merge picker. Split modal with qty steppers. KOTs re-pointed on a whole-order move.
- [ ] Browser check, then commit.
