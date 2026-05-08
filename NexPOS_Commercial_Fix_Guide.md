# NexPOS — Commercial Fix Guide & Prompt Playbook
### Everything you need to fix the 4 critical blockers, serve multiple businesses, and run separate databases

---

## Table of Contents

1. [How to Use This Guide](#1-how-to-use-this-guide)
2. [Fix 1 — Passwords (Plain Text → Secure)](#2-fix-1--passwords)
3. [Fix 2 — RLS (Database Security)](#3-fix-2--rls-database-security)
4. [Fix 3 — Multi-Tenancy (organization_id)](#4-fix-3--multi-tenancy)
5. [Fix 4 — Separate Databases Per Business Type](#5-fix-4--separate-databases-per-business-type)
6. [Master Prompt Guide — Copy & Paste These](#6-master-prompt-guide)
7. [Business-Specific Database Templates](#7-business-specific-database-templates)
8. [The "Antigravity" Upgrade — Full SaaS Prompts](#8-the-antigravity-upgrade)

---

## 1. How to Use This Guide

This guide does two things:

**A) Gives you the exact SQL + JavaScript fixes** for each critical blocker shown in the assessment.

**B) Gives you copy-paste prompts** to give to Claude (or any AI) to generate the code automatically for each business type with its own separate database schema.

The sections marked `PROMPT:` are templates you copy, fill in the `[BRACKETS]`, and paste into a new Claude chat to get working code instantly.

---

## 2. Fix 1 — Passwords

### The Problem
Your `users` table stores passwords like this:
```
username: "admin"   password: "123"
```
Anyone who can read the table can see all passwords. This is illegal under GDPR and Sri Lanka's data protection guidelines.

### The Solution — Migrate to Supabase Auth

Supabase Auth handles all password hashing automatically. You stop managing passwords entirely.

**Step 1: In your Supabase Dashboard**
Go to Authentication → Settings → Enable email provider

**Step 2: Run this SQL to create the new users link table**
```sql
-- Keep your existing users table but remove the password column
-- Add a link to Supabase's built-in auth.users table

ALTER TABLE public.users
  ADD COLUMN auth_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- You no longer need the password column
ALTER TABLE public.users
  DROP COLUMN IF EXISTS password;
```

**Step 3: Replace your doLogin() function in app.js**
```javascript
// OLD (insecure - plain text password check)
async function doLogin() {
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const user = await db.users.where('username').equals(username).first();
  if (user && user.password === password) { ... }
}

// NEW (secure - Supabase Auth)
async function doLogin() {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  const { data, error } = await supa.auth.signInWithPassword({
    email: email,
    password: password
  });

  if (error) {
    showToast('Login failed: ' + error.message, 'error');
    return;
  }

  // Get the user's role from your users table
  const { data: userProfile } = await supa
    .from('users')
    .select('*')
    .eq('auth_id', data.user.id)
    .single();

  currentUser = userProfile;
  applyRoleNav(userProfile.role);
  nav('dashboard');
}

// Sign out function
async function doLogout() {
  await supa.auth.signOut();
  currentUser = null;
  nav('login');
}
```

### PROMPT to generate the full auth migration:

```
I have a NexPOS system built with vanilla JavaScript and Supabase.
Currently login uses plain-text passwords stored in a 'users' table.

My current users table:
  id, username, password (plain text), display_name, role, is_active

I want to migrate to Supabase Auth (email/password).

Please give me:
1. The SQL migration script to alter my users table (add auth_id column, drop password column)
2. The updated doLogin() function using supa.auth.signInWithPassword()
3. The doLogout() function
4. The doSignUp() function for when an Admin creates a new staff member
5. How to create the first Admin account in Supabase Dashboard

Keep the code as vanilla JavaScript (no frameworks). Use the existing global variable 'supa' as the Supabase client.
```

---

## 3. Fix 2 — RLS Database Security

### The Problem
Row Level Security is disabled. Your Supabase anon key is in your JavaScript file (visible in browser DevTools). This means anyone can call:
```javascript
// Any person on the internet can do this to your database right now
const supa = createClient('your-url', 'your-anon-key'); // key is in your JS file
const { data } = await supa.from('products').select('*'); // gets ALL shops' products
```

### The Solution — Enable RLS + Write Policies

**Step 1: Re-enable RLS on all tables**
```sql
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.held_carts ENABLE ROW LEVEL SECURITY;
```

**Step 2: Write policies (after organization_id is added — see Fix 3)**
```sql
-- Example policy: users can only see their own organization's products
CREATE POLICY "Users see own org products"
  ON public.products
  FOR ALL
  USING (
    organization_id = (
      SELECT organization_id FROM public.users
      WHERE auth_id = auth.uid()
    )
  );

-- Apply same pattern to ALL tables
-- (Repeat for customers, sales, sale_items, categories, settings, attendance, held_carts)
```

### PROMPT to generate all RLS policies:

```
I have a Supabase PostgreSQL database for a multi-tenant POS system called NexPOS.

Tables: users, products, categories, customers, sales, sale_items,
        settings, attendance, held_carts, organizations

Every table has an organization_id column (UUID).
The users table has an auth_id column that references auth.users(id).

Please write complete RLS (Row Level Security) policies for ALL tables so that:
1. A logged-in user can only SELECT, INSERT, UPDATE, DELETE rows where organization_id matches their own organization
2. The organization_id for the current user is looked up from the users table using auth.uid()
3. Unauthenticated users (anon) can access nothing

Format as runnable SQL. Include the ENABLE ROW LEVEL SECURITY statements first, then all CREATE POLICY statements.
```

---

## 4. Fix 3 — Multi-Tenancy

### The Problem
There is no `organization_id` column in any table. All shops share one database pool. Two customers = data crossover.

### The Solution — Add organization_id to every table

**Step 1: Create the organizations table**
```sql
CREATE TABLE public.organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  business_type TEXT NOT NULL DEFAULT 'retail',
  currency      TEXT NOT NULL DEFAULT 'Rs.',
  tax_rate      NUMERIC(5,2) DEFAULT 0,
  phone         TEXT DEFAULT '',
  address       TEXT DEFAULT '',
  subscription  TEXT NOT NULL DEFAULT 'free',  -- free | pro | enterprise
  owner_auth_id UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

**Step 2: Add organization_id to all tables**
```sql
ALTER TABLE public.users       ADD COLUMN organization_id UUID REFERENCES organizations(id);
ALTER TABLE public.products    ADD COLUMN organization_id UUID REFERENCES organizations(id);
ALTER TABLE public.categories  ADD COLUMN organization_id UUID REFERENCES organizations(id);
ALTER TABLE public.customers   ADD COLUMN organization_id UUID REFERENCES organizations(id);
ALTER TABLE public.sales       ADD COLUMN organization_id UUID REFERENCES organizations(id);
ALTER TABLE public.sale_items  ADD COLUMN organization_id UUID REFERENCES organizations(id);
ALTER TABLE public.settings    ADD COLUMN organization_id UUID REFERENCES organizations(id);
ALTER TABLE public.attendance  ADD COLUMN organization_id UUID REFERENCES organizations(id);
ALTER TABLE public.held_carts  ADD COLUMN organization_id UUID REFERENCES organizations(id);
```

**Step 3: Store organization_id in app.js after login**
```javascript
// In your login success handler, store org_id globally
let currentOrgId = null;

async function afterLogin(authUserId) {
  const { data: profile } = await supa
    .from('users')
    .select('*, organizations(*)')
    .eq('auth_id', authUserId)
    .single();

  currentUser = profile;
  currentOrgId = profile.organization_id;

  // Now every query you make should include organization_id filter
  // Example:
  // const products = await supa.from('products').select('*').eq('organization_id', currentOrgId);
}
```

**Step 4: Update db.js compatibility layer to always inject organization_id**
```javascript
// In your SupaTable class, update toArray() to always filter by org
async toArray() {
  let query = supa.from(this.name).select('*');
  if (currentOrgId && this.name !== 'organizations') {
    query = query.eq('organization_id', currentOrgId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// And update add() to always inject organization_id
async add(item) {
  if (currentOrgId && this.name !== 'organizations') {
    item.organization_id = currentOrgId;
  }
  const { data, error } = await supa.from(this.name).insert([item]).select().single();
  if (error) throw error;
  return data.id;
}
```

### PROMPT to generate the full multi-tenancy migration:

```
I have a NexPOS system (vanilla JS + Supabase). I need to add multi-tenancy so multiple shops can use the same database safely.

Current tables (none have organization_id yet):
users, products, categories, customers, sales, sale_items,
settings, attendance, held_carts

Please give me:
1. SQL to create an 'organizations' table with: id (UUID), name, slug, business_type, currency, tax_rate, phone, address, subscription (free/pro/enterprise), owner_auth_id, created_at
2. SQL ALTER statements to add organization_id (UUID) to all existing tables
3. Updated JavaScript for the SupaTable class in db.js — specifically toArray(), add(), update(), delete() methods — so they automatically filter by a global 'currentOrgId' variable
4. A JavaScript function called 'createOrganization(name, businessType)' that creates a new org and sets currentOrgId
5. An onboarding flow: after first signup, show a form to enter shop name and pick business type, then call createOrganization()

Keep everything in vanilla JavaScript. No frameworks.
```

---

## 5. Fix 4 — Separate Databases Per Business Type

### Understanding Your Two Options

**Option A — One Supabase project, multiple tenants (RECOMMENDED)**
All shops live in one database, separated by `organization_id`. This is what multi-tenancy means. Cheapest, easiest to manage. One Supabase free tier handles hundreds of shops.

**Option B — One Supabase project per shop (NOT recommended)**
Each customer gets their own Supabase project. Very expensive at scale. Only makes sense for Enterprise customers who pay for data isolation (HIPAA, etc.).

### How to Give Each Business a Different Schema Template

The best approach is NOT different databases — it's different **seed data and field configurations** loaded when a shop first signs up. Your existing Business Template system (in db.js) already does this! You just need to extend it.

**Current template system (already in your code):**
```javascript
// This already exists in db.js — you just need to tie it to the onboarding flow
await loadBusinessTemplate('grocery');   // loads grocery categories + sample products
await loadBusinessTemplate('pharmacy');  // loads pharmacy categories + sample products
```

**Extended template with org-specific settings:**
```javascript
const BUSINESS_CONFIGS = {
  grocery: {
    name: 'Grocery Store',
    currency: 'Rs.',
    units: ['kg', 'packs', 'pcs', 'litre', 'g'],
    defaultTax: 0,
    extraFields: ['expiry_date', 'supplier_name'],
    receiptFooter: 'Thank you for shopping with us!'
  },
  pharmacy: {
    name: 'Pharmacy',
    currency: 'Rs.',
    units: ['pcs', 'strips', 'bottles', 'ml', 'mg'],
    defaultTax: 0,
    extraFields: ['batch_number', 'expiry_date', 'manufacturer'],
    receiptFooter: 'Your health is our priority.'
  },
  restaurant: {
    name: 'Restaurant / Cafe',
    currency: 'Rs.',
    units: ['portion', 'plate', 'cup', 'glass', 'pcs'],
    defaultTax: 10,
    extraFields: ['table_number', 'waiter_name'],
    receiptFooter: 'Thank you! Come again.'
  },
  hardware: {
    name: 'Hardware Store',
    currency: 'Rs.',
    units: ['pcs', 'meters', 'kg', 'box', 'roll', 'litre'],
    defaultTax: 0,
    extraFields: ['brand', 'warranty_months'],
    receiptFooter: 'Quality tools for quality work.'
  },
  clothing: {
    name: 'Clothing / Boutique',
    currency: 'Rs.',
    units: ['pcs'],
    defaultTax: 0,
    extraFields: ['size', 'color', 'brand'],
    receiptFooter: 'Style is a way to say who you are.'
  },
  bookshop: {
    name: 'Bookshop',
    currency: 'Rs.',
    units: ['pcs'],
    defaultTax: 0,
    extraFields: ['author', 'isbn', 'publisher'],
    receiptFooter: 'Keep reading, keep growing.'
  },
  bakery: {
    name: 'Bakery',
    currency: 'Rs.',
    units: ['pcs', 'kg', 'slice', 'box', 'dozen'],
    defaultTax: 0,
    extraFields: ['made_date', 'allergens'],
    receiptFooter: 'Baked fresh daily!'
  },
  meatshop: {
    name: 'Meat Shop / Butcher',
    currency: 'Rs.',
    units: ['kg', 'g', 'pcs', 'pack'],
    defaultTax: 0,
    extraFields: ['cut_type', 'origin'],
    receiptFooter: 'Fresh cuts, every day.'
  }
};
```

---

## 6. Master Prompt Guide

### HOW TO USE THESE PROMPTS

1. Open a new Claude conversation
2. Copy the prompt exactly
3. Replace everything in `[SQUARE BRACKETS]` with your actual values
4. Paste and send
5. Copy the generated code into your project files

---

### PROMPT 1 — Generate a complete separate Supabase schema for a specific business

```
I am building a NexPOS POS system for a [BUSINESS TYPE — e.g. "pharmacy" or "restaurant"].

My base schema already has these tables:
organizations, users, products, categories, customers, sales, sale_items, settings, attendance, held_carts

Every table has organization_id UUID for multi-tenancy.

For a [BUSINESS TYPE], please give me:

1. Any ADDITIONAL columns I should add to the products table that are specific to this business type
   (e.g. pharmacy needs: batch_number, expiry_date, manufacturer, prescription_required)

2. Any ADDITIONAL tables specific to this business
   (e.g. restaurant needs: tables, table_orders, menu_categories)

3. The complete INSERT SQL to seed 20 realistic sample products with correct categories, SKUs, prices in Sri Lankan Rupees (Rs.), and stock quantities

4. A JavaScript function called 'loadTemplate_[businesstype]()' that:
   - Calls db.categories.clear() and db.products.clear()
   - Inserts the categories using await db.categories.add(...)
   - Inserts the products using await db.categories.bulkAdd(...)
   - Sets organization settings for this business type

Keep the code in vanilla JavaScript compatible with the existing db.js compatibility layer (SupaTable class).
```

---

### PROMPT 2 — Generate the full Supabase Auth + RLS setup for a new business

```
I need complete Supabase setup code for a new NexPOS tenant (a [BUSINESS TYPE] shop called "[SHOP NAME]").

Please generate:

1. The SQL to create the organization record:
   INSERT INTO organizations (name, slug, business_type, currency, tax_rate)
   VALUES ('[SHOP NAME]', '[shop-slug]', '[business_type]', 'Rs.', [TAX RATE]);

2. Instructions to create the owner's Supabase Auth account via the Dashboard

3. SQL to create the owner's profile in the users table:
   INSERT INTO users (auth_id, display_name, role, organization_id)
   VALUES (auth.uid(), '[OWNER NAME]', 'Admin', '[ORG ID]');

4. The 4 default staff accounts (Admin, Counter, HR, Inventory) with Supabase Auth signup code

5. RLS policy verification — a SELECT query I can run to confirm RLS is working:
   The query should try to read products WITHOUT organization_id filter and confirm it returns 0 rows
```

---

### PROMPT 3 — Generate a custom receipt template for a business type

```
I have a NexPOS POS system. I need a custom HTML receipt template for a [BUSINESS TYPE].

The receipt should print on an 80mm thermal printer.

Current receipt data available:
- orgSettings: { biz_name, phone, address, currency, tax_rate }
- sale: { id, date, cashier, total_amount, subtotal, discount, tax, payment_type }
- items: array of { product_name, quantity, unit_price, line_total }
- customer: { name, phone }

For a [BUSINESS TYPE], please:
1. Add any business-specific fields to the receipt
   (e.g. pharmacy: batch numbers, expiry warning, pharmacist name)
   (e.g. restaurant: table number, cover count, order time)
   (e.g. bookshop: ISBN numbers if available)

2. Write the complete HTML/CSS for the receipt as a JavaScript template literal string
   that returns a full HTML document suitable for window.print()

3. Include a professional header, itemized table, totals section, and footer
   All styles must be inline (no external CSS) for thermal printer compatibility
   Max width: 72mm content area
```

---

### PROMPT 4 — Generate the SaaS onboarding flow

```
I have a NexPOS app (vanilla JavaScript + Supabase). I need a complete onboarding flow for new business signups.

The flow should be:
Step 1: Sign up (email + password) → creates Supabase Auth account
Step 2: Create shop (business name, business type dropdown, phone, address, currency)
Step 3: Choose template (loads sample products for their business type)
Step 4: Create first staff accounts (optional, can skip)
Step 5: Go to dashboard

Please write:
1. The HTML for a 5-step onboarding wizard (screens inside a modal overlay)
   - Progress bar showing Step 1 of 5
   - Business type options: Grocery, Pharmacy, Restaurant, Hardware, Clothing, Bookshop, Bakery, Meat Shop
   - Show a description and emoji icon for each business type option

2. The JavaScript functions:
   - nextStep(stepNumber) — advances the wizard
   - createAccount(email, password) — calls supa.auth.signUp()
   - createShop(name, type, phone, address) — inserts into organizations table
   - applyBusinessTemplate(type) — calls the template loader
   - completeOnboarding() — redirects to dashboard

3. The CSS for the wizard (dark theme matching the existing NexPOS dark sidebar design: background #1B1D2A, primary color #5B5FC7)

Keep everything in vanilla JavaScript. No frameworks.
```

---

### PROMPT 5 — Add Stripe billing and subscription enforcement

```
I have a NexPOS SaaS app. I need to add subscription billing with Stripe.

My subscription tiers are:
- Free: max 50 products, 1 staff account, basic POS only
- Pro (Rs. 2,500/month): max 500 products, 5 staff, all modules, CSV export
- Enterprise (Rs. 6,500/month): unlimited everything, priority support, custom branding

My organizations table has: id, name, subscription (text: free/pro/enterprise), subscription_expires_at

Please give me:
1. How to create 3 Stripe products and prices in the Stripe Dashboard (step by step)
2. A Supabase Edge Function (TypeScript) that acts as the Stripe webhook:
   - Listens for 'checkout.session.completed' and 'customer.subscription.deleted'
   - Updates the organizations table subscription status accordingly
3. The JavaScript function 'openBillingPortal(plan)' that:
   - Creates a Stripe Checkout session by calling a Supabase Edge Function
   - Redirects to the Stripe hosted checkout page
4. A JavaScript function 'checkSubscriptionLimit(limitType)' that:
   - Accepts: 'products', 'staff', 'modules'
   - Reads currentOrgId's subscription from the organizations table
   - Returns true if allowed, false if limit exceeded
   - Shows a "Upgrade to Pro" toast/modal if false
5. Where to call checkSubscriptionLimit() in the existing app.js code

Keep JavaScript in vanilla JS. Edge functions in TypeScript.
```

---

## 7. Business-Specific Database Templates

### Quick reference — what each business type needs differently

| Business | Extra Product Fields | Extra Tables | Key Settings |
|----------|---------------------|--------------|--------------|
| **Grocery** | expiry_date, supplier_name | — | Weight units (kg/g), low stock alerts |
| **Pharmacy** | batch_number, expiry_date, manufacturer, prescription_required | prescriptions | Strict expiry tracking, dispensing log |
| **Restaurant** | — | tables, table_orders, kot (kitchen orders) | Table management, split bills, modifiers |
| **Hardware** | brand, warranty_months, specifications | purchase_orders | Large product catalog, bulk pricing |
| **Clothing** | size, color, brand, gender | — | Variant management (S/M/L × Red/Blue) |
| **Bookshop** | author, isbn, publisher, genre | — | ISBN barcode scanning, author search |
| **Bakery** | made_date, ingredients, allergens, shelf_life | production_log | Daily production tracking, waste logging |
| **Meat Shop** | cut_type, origin, grade | — | Weight-based pricing (per kg), live pricing |

### How to create a Separate Supabase Project for One Customer (Option B — Premium Only)

If an Enterprise customer wants full data isolation (their own database), do this:

1. Go to app.supabase.com → New Project
2. Name it: `nexpos-[shopname]`
3. Save the Project URL and Anon Key
4. Run the full SQL schema (Section 4 of your original PRD)
5. In your app, store each org's Supabase connection details in a master database:

```sql
-- In your MASTER Supabase project (for billing/routing only)
CREATE TABLE tenant_databases (
  organization_id  UUID PRIMARY KEY,
  supabase_url     TEXT NOT NULL,
  supabase_anon    TEXT NOT NULL,  -- NOTE: encrypt this in production
  plan             TEXT DEFAULT 'enterprise'
);
```

```javascript
// On login, fetch the correct Supabase connection for this org
async function getClientForOrg(orgSlug) {
  const { data } = await masterSupa.from('tenant_databases')
    .select('*').eq('slug', orgSlug).single();

  return createClient(data.supabase_url, data.supabase_anon);
}
```

**Warning:** This approach costs approximately $25/month per Enterprise customer (Supabase Pro per project). Only do this for customers paying Rs. 15,000+/month or more.

---

## 8. The "Antigravity" Upgrade

These are the prompts that take NexPOS from a local POS app to a serious commercial SaaS product. Use them in order.

---

### ANTIGRAVITY PROMPT A — The Complete Rewrite Prompt
*Use this if you want Claude to rebuild the entire security layer in one go*

```
I have a web POS app called NexPOS built with vanilla JavaScript and Supabase.

Here is my current file structure:
- index.html — UI with all screens and modals
- style.css — dark theme CSS
- db.js — Supabase client + SupaTable compatibility layer (mimics Dexie API)
- app.js — all business logic

CURRENT CRITICAL PROBLEMS TO FIX:
1. Passwords stored as plain text in a 'users' table — need to migrate to Supabase Auth
2. RLS is DISABLED — the anon key is exposed and the database is publicly writable
3. No organization_id — all customers share one database pool
4. Single-tenant architecture — not suitable for SaaS resale

TARGET ARCHITECTURE:
- Supabase Auth for login (email + password)
- organization_id on every table
- RLS policies that auto-filter by organization_id using auth.uid()
- Onboarding flow: signup → create shop → choose business type → load template
- 8 business type templates: grocery, pharmacy, restaurant, hardware, clothing, bookshop, bakery, meatshop

MY EXISTING DB.JS COMPATIBILITY LAYER:
[PASTE YOUR ENTIRE db.js FILE CONTENT HERE]

Please deliver in order:
1. Updated db.js with organization_id injection and Supabase Auth support
2. All SQL migrations (ALTER TABLE statements + new organizations table + RLS policies)
3. Updated doLogin(), doLogout(), doSignUp() functions
4. A createOrganization() onboarding function
5. Summary of every place in app.js I need to update (by function name)

Do NOT rewrite all of app.js — only give me the specific functions that need updating.
```

---

### ANTIGRAVITY PROMPT B — Add a Public Marketing/Signup Page

```
I have a SaaS POS app called NexPOS. I need a public landing page that exists before the app login.

The page should be a single HTML file: landing.html

Design requirements:
- Dark theme matching the app: sidebar #1B1D2A, primary #5B5FC7, background #F3F4F8 for content
- Fonts: DM Sans from Google Fonts
- Fully responsive (mobile + desktop)
- Professional and modern

Sections needed:
1. Hero: "NexPOS — The Smart POS for Sri Lankan Businesses" with a CTA button "Start Free — No Credit Card"
2. Feature cards: POS, Inventory, HR, Analytics (4 cards with icons)
3. Business types: show the 8 supported business types with emoji icons
4. Pricing: Free / Pro (Rs. 2,500) / Enterprise (Rs. 6,500) — 3 column cards
5. Footer: links, contact, copyright

The "Start Free" button should redirect to index.html#signup (the app's onboarding modal).

Write the complete landing.html file with all CSS inline or in a style block.
No JavaScript frameworks. Use vanilla JS only for any interactions.
```

---

### ANTIGRAVITY PROMPT C — Add AI-Powered Smart Inventory Suggestions

```
I have a NexPOS POS system. I want to add a smart "Reorder Suggestion" feature
that uses AI to suggest when to reorder products.

I want this as a new screen in the app called "Smart Reorder" accessible from the Inventory menu.

Data available:
- products table: id, name, stock_qty, low_stock_threshold, cost_price
- sales and sale_items tables: last 90 days of sales data

Please write:
1. A SQL query that calculates average daily sales velocity for each product over the last 30 days
2. A JavaScript function 'calculateReorderSuggestions()' that:
   - Runs the velocity query
   - For each product, calculates: days_until_stockout = stock_qty / avg_daily_sales
   - Returns a sorted list of products where days_until_stockout < 14 (critical) or < 30 (warning)
3. The HTML screen for "Smart Reorder" with a table showing:
   - Product name | Current stock | Daily sales rate | Days until stockout | Reorder status badge
   - Status badges: CRITICAL (red, < 7 days), WARNING (orange, < 30 days), OK (green)
   - A "Generate Purchase Order" button that creates a pre-filled purchase order
4. The CSS for the new screen matching the existing NexPOS dark theme

Vanilla JavaScript only. Use existing db.js compatibility layer.
```

---

### ANTIGRAVITY PROMPT D — Multi-Branch Support

```
I have NexPOS running for one organization. I want to add multi-branch support
so one business (e.g. a grocery chain) can have 3 branches sharing one account.

Changes needed:
1. Add a 'branches' table: id, organization_id, name, address, phone
2. Add branch_id to: products (shared catalog vs branch-specific stock), sales, attendance
3. A branch selector in the app topbar (dropdown to switch between branches)
4. Branch-level stock: each branch has its own stock_qty for shared products
5. Head office reports: consolidated sales across all branches

Please give me:
- The SQL schema changes
- Updated RLS policies that allow branch managers to see only their branch's sales but organization admins to see all branches
- The JavaScript for the branch selector dropdown
- A 'switchBranch(branchId)' function that updates the global currentBranchId and refreshes the current screen

Vanilla JavaScript. Supabase backend. No frameworks.
```

---

## Quick Reference — Files to Edit for Each Fix

| Fix | File to Edit | What to Change |
|-----|-------------|----------------|
| Passwords | app.js | Replace doLogin(), add doLogout() |
| Passwords | Supabase Dashboard | Enable Auth → Email provider |
| Passwords | SQL | ALTER TABLE users DROP password, ADD auth_id |
| RLS | Supabase SQL Editor | Enable RLS + CREATE POLICY on all tables |
| Multi-tenancy | db.js | Update toArray(), add(), update() to inject organization_id |
| Multi-tenancy | app.js | Add currentOrgId variable, update afterLogin() |
| Multi-tenancy | SQL | ALTER TABLE + new organizations table |
| Business templates | db.js | Extend BUSINESS_CONFIGS object |
| Onboarding | index.html | Add onboarding wizard modal |
| Billing | Supabase Functions | New Edge Function for Stripe webhook |

---

*Document Version: 1.0 | NexPOS Commercial Fix Guide | May 2026*
*Copy all PROMPT sections into a new Claude conversation to generate working code instantly.*
