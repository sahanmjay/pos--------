# NexPOS - Complete Diagnosis & Fix Guide

**App URL:** `https://pos-mu-coral.vercel.app/`
**Report Date:** 2026-05-08

---

## 1. App Overview

NexPOS is a browser-based Point of Sale system built with plain HTML/CSS/JavaScript, using **Supabase** as its backend database. It is deployed as a static site on **Vercel**. The app includes modules for Point of Sale, Dashboard, Inventory Management, Sales History, Customer Management, Staff Management, Attendance, and Settings.

- **Frontend:** Plain HTML/CSS/JS (no framework like React/Next.js)
- **Backend:** Supabase (`rakklmxpukcehbyjuxjy.supabase.co`)
- **Hosting:** Vercel (static hosting)
- **Architecture:** Single-page application with client-side Supabase queries

---

## 2. Why You CAN'T Log In (Root Cause)

### The Problem: Your Database Is COMPLETELY EMPTY

The login system queries the Supabase `users` table for a matching username and password:

```javascript
supa.from('users').select('*').eq('username', u).eq('password', p)
```

However, **all 9 database tables are empty:**
- `users` - NO records
- `organizations` - NO records
- `products` - NO records
- `categories` - NO records
- `sales` - NO records
- `sale_items` - NO records
- `customers` - NO records
- `settings` - NO records
- `attendance` - NO records

The default credentials shown on the login page (`admin` / `123`) **do not exist** because the database was never seeded with any data.

### Additional Blocker: RLS (Row Level Security) Policy

Even if you try to insert data through the app, **Supabase's RLS policies block all inserts** via the anon key:

> `new row violates row-level security policy for table "organizations"` (Error Code: 42501)

This means the app cannot create any records on its own because the Row Level Security policies are too restrictive.

---

## 3. Why You CAN'T Do Any Work Through It

Since the database is empty and RLS blocks inserts, the app cannot:
- Authenticate any user
- Create or save any products
- Record any sales or transactions
- Store customer information
- Save business settings
- Track attendance

**Every feature depends on database records that do not exist and cannot be created** through the app's current configuration.

---

## 4. Complete Architecture Map

```
Vercel (Static Hosting - pos-mu-coral.vercel.app)
  index.html     -- Login screen + full app shell (SPA)
  style.css      -- All styling
  app.js         -- All application logic (POS, dashboard, etc.)
  db.js          -- Supabase client initialization + ORM queries

Supabase Backend (rakklmxpukcehbyjuxjy.supabase.co)
  9 Tables:
    - users (username, password, display_name, role, organization_id, status)
    - organizations (name, type, currency_symbol, tax_rate, phone, address)
    - products (name, sku, category_id, price, stock, status, organization_id)
    - categories (name, organization_id)
    - sales (sale_number, customer_id, total, discount, tax, payment_method, status, organization_id)
    - sale_items (sale_id, product_id, quantity, price, subtotal)
    - customers (name, phone, email, organization_id)
    - settings (organization_id, key, value)
    - attendance (user_id, date, clock_in, clock_out, status)

  RLS Policies: ENABLED (blocks anon inserts)
```

---

## 5. Security Issues Found

| Issue | Severity | Details |
|-------|----------|---------|
| Plaintext passwords | CRITICAL | Passwords stored as plain text in `users` table - no hashing |
| Exposed Supabase anon key | HIGH | The anon key is publicly visible in `db.js` source code |
| No session management | HIGH | User state stored in JS variable only - lost on page refresh |
| No CSRF protection | MEDIUM | No protection against cross-site request forgery |
| No input sanitization | MEDIUM | User inputs sent directly to Supabase without server-side validation |
| RLS too restrictive | MEDIUM | Blocks legitimate app operations via anon key |

---

## 6. Step-by-Step Fix Guide

### STEP 1: Fix Supabase RLS Policies (Required First)

Go to your **Supabase Dashboard** > SQL Editor and run the following SQL to allow inserts via the anon key:

```sql
-- Allow all operations on all tables for anon users
-- WARNING: This is for development only. For production, use proper policies.

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;

-- Create permissive policies for each table
CREATE POLICY "Allow all on organizations" ON organizations
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on users" ON users
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on products" ON products
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on categories" ON categories
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on sales" ON sales
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on sale_items" ON sale_items
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on customers" ON customers
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on settings" ON settings
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on attendance" ON attendance
  FOR ALL USING (true) WITH CHECK (true);
```

### STEP 2: Seed the Database (Required)

After fixing RLS, run this SQL to create the initial data:

```sql
-- 1. Create default organization
INSERT INTO organizations (id, name, type, currency_symbol, tax_rate, phone, address)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'My Business',
  'Retail Shop',
  '$',
  10.00,
  '+1 234 567 890',
  '123 Business Street'
);

-- 2. Create admin user (plaintext - we will fix this later)
INSERT INTO users (id, username, password, display_name, role, organization_id, status)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'admin',
  '123',
  'Administrator',
  'Admin',
  '00000000-0000-0000-0000-000000000001',
  'active'
);

-- 3. Create default categories
INSERT INTO categories (id, name, organization_id) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Beverages', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002', 'Snacks', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000003', 'Electronics', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000004', 'Clothing', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000005', 'Food', '00000000-0000-0000-0000-000000000001');

-- 4. Create sample products
INSERT INTO products (id, name, sku, category_id, price, stock, status, organization_id) VALUES
  ('20000000-0000-0000-0000-000000000001', 'Cola 500ml', 'BEV-001', '10000000-0000-0000-0000-000000000001', 1.50, 100, 'active', '00000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', 'Orange Juice', 'BEV-002', '10000000-0000-0000-0000-000000000001', 2.50, 50, 'active', '00000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000003', 'Chips Pack', 'SNK-001', '10000000-0000-0000-0000-000000000002', 1.00, 200, 'active', '00000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000004', 'Chocolate Bar', 'SNK-002', '10000000-0000-0000-0000-000000000002', 1.75, 150, 'active', '00000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000005', 'USB Cable', 'ELC-001', '10000000-0000-0000-0000-000000000003', 5.99, 30, 'active', '00000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000006', 'T-Shirt', 'CLT-001', '10000000-0000-0000-0000-000000000004', 15.00, 25, 'active', '00000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000007', 'Sandwich', 'FOD-001', '10000000-0000-0000-0000-000000000005', 3.50, 40, 'active', '00000000-0000-0000-0000-000000000001');

-- 5. Create default settings
INSERT INTO settings (organization_id, key, value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'currency_symbol', '$'),
  ('00000000-0000-0000-0000-000000000001', 'tax_rate', '10'),
  ('00000000-0000-0000-0000-000000000001', 'business_name', 'My Business'),
  ('00000000-0000-0000-0000-000000000001', 'business_type', 'Retail Shop');
```

### STEP 3: Verify Login Works

After seeding the database:
1. Go to `https://pos-mu-coral.vercel.app/`
2. Enter username: `admin`
3. Enter password: `123`
4. Click "Sign In"
5. You should now see the full POS dashboard

### STEP 4: (Optional but Recommended) Use Supabase Dashboard Quick Setup

Instead of running SQL manually, you can also:
1. Go to **Supabase Dashboard** > **Table Editor**
2. Click "Insert row" on each table
3. Add the records one by one using the UI

---

## 7. Long-Term Improvement Suggestions

### Priority: HIGH - Security Fixes

1. **Use Supabase Auth instead of custom login**
   - Replace the plaintext username/password check with `supabase.auth.signInWithPassword()`
   - This gives you proper session management, JWT tokens, and password hashing automatically

2. **Hash all existing passwords**
   - If keeping custom auth, at minimum use bcrypt/Argon2 for password hashing
   - Never store passwords in plain text

3. **Add session persistence**
   - Currently, refreshing the page logs you out because user state is only in a JS variable
   - Use `supabase.auth.getSession()` or store tokens in localStorage

4. **Use environment variables for Supabase keys**
   - Move the Supabase URL and anon key to environment variables
   - Never commit secrets to source code

### Priority: MEDIUM - App Improvements

5. **Add server-side validation**
   - Create API routes (Vercel Serverless Functions) to validate data before sending to Supabase
   - This prevents direct database manipulation from the browser console

6. **Implement proper RLS policies**
   - Instead of "allow all", use policies like: "users can only access data from their own organization"
   - Example: `USING (organization_id = auth.jwt() ->> 'organization_id')`

7. **Add error handling and loading states**
   - Show loading spinners during data fetches
   - Display user-friendly error messages instead of console errors

### Priority: LOW - UX Enhancements

8. **Add offline support** - Cache data locally so the app works without internet
9. **Add barcode scanner support** - For faster product lookup
10. **Add receipt email/SMS** - Send receipts to customers digitally
11. **Add multi-language support** - For international businesses

---

## 8. Quick Checklist

- [ ] Open Supabase Dashboard and go to SQL Editor
- [ ] Run the RLS fix SQL (STEP 1)
- [ ] Run the database seed SQL (STEP 2)
- [ ] Test login with admin / 123
- [ ] Verify all app features work (POS, Dashboard, Products, etc.)
- [ ] Change the default admin password immediately
- [ ] Plan security improvements (Supabase Auth, password hashing)

---

## 9. Summary

| Issue | Cause | Fix |
|-------|-------|-----|
| Cannot log in | Database `users` table is empty | Seed the database with admin user |
| Cannot do any work | All tables empty + RLS blocks inserts | Fix RLS policies + seed all tables |
| Page refresh loses login | No session management | Implement Supabase Auth |
| Security vulnerabilities | Plaintext passwords, exposed keys | Use Supabase Auth, env variables |

The core issue is simple: **the Supabase database was never initialized with data**. Once you seed the database and fix the RLS policies, the app should work as designed. The security issues are important to address but are separate from getting the app functional.
