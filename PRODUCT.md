# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Cashiers** at the counter during busy hours: ringing up sales fast, taking cash and giving change, holding and resuming bills, scanning barcodes. Many are not tech-savvy.
- **Owners and managers**: checking sales, stock, staff, attendance, payroll, expenses and reports.
- Both groups spend real time in the app; neither is secondary.
- **Platform super admin**: manages all businesses on the platform.

## Product Purpose
NexPOS is a multi-business point-of-sale and back-office platform. One install serves restaurants and cafes (tables, kitchen tickets/KOT), retail and clothing (barcodes, stock), grocery and meat shops (weighted items, fast queues) and bookshops. Success means a cashier finishes a sale in seconds without mistakes, and an owner can see how the business is doing without help.

## Positioning
One POS that adapts to the shop type (restaurant mode, retail, grocery, bookshop) with sales, stock, HR, payroll and expenses in the same app, and keeps selling offline.

## Operating Context
- Used equally on desktop/laptop (mouse and keyboard at a counter) and touchscreens/tablets (finger taps). Phone widths are also supported.
- Runs in the browser (PWA) and as a Windows desktop app (Electron).
- Works offline: sales queue locally in IndexedDB and sync to Supabase when back online.
- Sri Lanka context: prices in LKR ("Rs."), LKR note and coin denominations at cash payment.
- Printed receipts and table bills.

## Capabilities and Constraints
- Screens: Point of Sale, Dashboard, Kitchen Display (KOT), Table Management, Products, Categories, Stock, Sales History, Customers, Staff Management, Attendance, Advances, Expenses, Payroll, Reports, Settings, plus the Super Admin console.
- Stack: vanilla HTML/CSS/JS (index.html, style.css, app.js, db.js), no framework or build step. Supabase backend, Node static server, Electron wrapper.
- Screen layout is fixed: sidebar navigation, products on the left, cart on the right, mobile bottom tab bar. Staff should not have to relearn where things are.
- All existing features must keep working.

## Brand Commitments
- Product name: **NexPOS**.
- The **"NP" logo mark** and existing favicon files stay.

## Evidence on Hand
- No testimonials, customer logos or usage numbers exist in the repo; do not invent any.

## Product Principles
1. Counter speed first: the most common checkout actions take the fewest taps and are the biggest targets.
2. Numbers must be unmistakable: totals, change due and stock levels read correctly at a glance.
3. Same place, every time: layout stays stable across shop types and devices.
4. Works for touch and mouse equally.
5. Calm under pressure: nothing distracts a cashier mid-sale.

## Accessibility & Inclusion
- Touch targets at least 44px on touch devices.
- Readable contrast in a bright shop environment; full keyboard use on desktop.
