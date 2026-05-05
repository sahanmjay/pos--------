# Universal POS & Inventory Management System
### Product Requirements Document (PRD) — v1.0
> **Type:** SaaS · Multi-Tenant · Cloud-Based
> **Target:** Small to Medium Businesses (Retail · Wholesale · Manufacturing)

---

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [User Personas](#2-user-personas)
3. [Business Requirements](#3-business-requirements)
4. [Technical Requirements](#4-technical-requirements)
5. [Database Schema](#5-database-schema)
6. [API Design](#6-api-design)
7. [Security & Compliance](#7-security--compliance)
8. [Development Roadmap](#8-development-roadmap)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Open Questions & Risks](#10-open-questions--risks)

---

## 1. Project Overview

A cloud-based, multi-tenant Point of Sale (POS) and Inventory Management System built for small to medium-sized businesses. Vendors can self-register, create their organization (shop), and immediately manage inventory, run sales, track manufacturing, and view analytics — all from a single platform.

**Core Value Propositions:**
- One platform for retail, wholesale, and light manufacturing workflows
- Zero infrastructure overhead (fully managed SaaS)
- Role-based access so owners, managers, and cashiers each see only what they need
- Real-time stock visibility with low-stock alerts

---

## 2. User Personas

| Persona | Role | Primary Goals |
|---------|------|---------------|
| **Shop Owner (Admin)** | Full access | Monitor profits, manage staff, configure settings |
| **Manager** | Operational access | Manage inventory, approve discounts, view reports |
| **Cashier** | POS only | Process sales quickly, apply discounts, print receipts |
| **Platform Super Admin** | Anthropic-level | Manage tenants, billing, subscription enforcement |

---

## 3. Business Requirements

### 3.1 Inventory Management

- **Product Types:**
  - `PURCHASED` — items bought from external suppliers
  - `MANUFACTURED` — items produced in-house (linked to a Bill of Materials)
- **Stock Tracking:** Real-time quantity updates on every sale, purchase, or production run
- **Multi-Unit Support:** Pieces, Bundles, Meters, Kg, Liters, Boxes (configurable per product)
- **Product Variants:** Support for size/color variants under a single parent SKU *(e.g., Shirt → S/M/L in Red/Blue)*
- **Barcode/SKU:** Auto-generate or manually enter SKU; barcode scanner support on POS screen
- **Vendor (Supplier) Management:**
  - Store supplier contact details, payment terms, and credit limits
  - Record purchase orders (POs) and outstanding payables
  - Purchase history per supplier

> **Added:** Product variants and barcode support are critical for apparel/retail businesses and were missing from the original spec.

---

### 3.2 Sales & Point of Sale (POS)

- **Dual Pricing Mode:** Toggle between Retail Price and Wholesale Price at checkout (per session or per line item)
- **Discounting:**
  - Flat amount discount (e.g., LKR 500 off)
  - Percentage discount (e.g., 10% off)
  - Discount requires Manager approval above a configurable threshold
- **Payment Methods:**
  - Cash (with change calculation)
  - Card (record reference number)
  - Credit / Debt — linked to a specific customer account
  - Split payment (e.g., part cash + part card)
- **Customer Management:**
  - Create walk-in customer profiles
  - Track outstanding credit balances
  - Loyalty points or purchase history *(optional, Pro tier)*
- **Receipt & Invoice Generation:**
  - Thermal receipt (80mm) for POS printer
  - PDF invoice via email or download
  - Customizable header/footer with logo and shop details
- **Hold & Resume Cart:** Save a cart mid-transaction and resume later
- **Returns & Refunds:** Process item returns, update stock, and issue credit note or cash refund

> **Added:** Split payment, customer management, holds, and returns/refunds are standard POS requirements that will be needed almost immediately.

---

### 3.3 Manufacturing / Production Tracking

- **Bill of Materials (BOM):** Define which raw materials and quantities are needed to produce one unit of a finished product
- **Raw Material Tracking:** Fabric (meters), buttons, threads, zips — each with their own stock levels
- **Production Orders:** Log a production run (e.g., "Produce 50 units of Dress Model A"), which automatically deducts raw materials from stock
- **COGS Calculation:**
  - `COGS = Raw Material Cost + Direct Labor Cost + Overhead Allocation`
  - Labor cost entered manually or calculated from an hourly rate × estimated hours
- **Yield Tracking:** Record actual vs. expected output to flag waste or inefficiency

---

### 3.4 Multi-Tenancy (SaaS)

- **Complete Data Isolation:** Every table includes `organization_id`; all queries are scoped to the active tenant. Cross-tenant data access is architecturally impossible.
- **Subscription Tiers:**

| Feature | Basic (Free) | Pro | Enterprise |
|---------|-------------|-----|------------|
| Products | Up to 100 | Up to 1,000 | Unlimited |
| Staff Accounts | 2 | 10 | Unlimited |
| POS Terminals | 1 | 3 | Unlimited |
| Manufacturing Module | ❌ | ✅ | ✅ |
| API Access | ❌ | ❌ | ✅ |
| Priority Support | ❌ | ❌ | ✅ |

- **User Roles & Permissions:**

| Permission | Admin | Manager | Cashier |
|------------|-------|---------|---------|
| Manage Products | ✅ | ✅ | ❌ |
| Process Sales | ✅ | ✅ | ✅ |
| Apply Discounts (any) | ✅ | ✅ | Limited |
| View Reports | ✅ | ✅ | ❌ |
| Manage Staff | ✅ | ❌ | ❌ |
| Configure Settings | ✅ | ❌ | ❌ |

---

### 3.5 Analytics & Reporting

- **Dashboard KPIs:** Total revenue today / this week / this month, profit margin, units sold, top-selling products
- **Sales Reports:** Filter by date range, product, cashier, or payment method
- **Inventory Reports:** Current stock levels, stock valuation (at cost and at retail)
- **Low Stock Alerts:** Email + in-app notification when stock drops below a configurable threshold per product
- **Profit & Loss (Basic):** Revenue − COGS − discounts given = gross profit
- **Tax Reports:** VAT/NBT-compliant summary report (configurable tax rate per organization)
- **Export:** Download reports as CSV or PDF

---

## 4. Technical Requirements

### 4.1 Frontend

| Concern | Technology | Notes |
|---------|-----------|-------|
| Framework | **Next.js 15** (App Router) | Use server components where possible for performance |
| Styling | **Tailwind CSS v4** | Mobile-first, responsive design |
| UI Components | **shadcn/ui** | Accessible, customizable; avoid full UI kit lock-in |
| State Management | **TanStack Query v5** | For all server-state, caching, and background sync |
| Forms | **React Hook Form + Zod** | Consistent validation on client and server |
| POS UI | Keyboard-navigable | Cashiers prefer keyboard shortcuts over mouse |
| Offline Support | Service Worker + IndexedDB | POS must work during brief internet outages *(Pro+)* |

> **Added:** Offline support for POS is a critical real-world requirement. Internet drops at checkout are unacceptable.

### 4.2 Backend & Database

| Concern | Technology | Notes |
|---------|-----------|-------|
| Language | **TypeScript** (strict mode) | End-to-end type safety |
| Runtime | **Next.js API Routes / Route Handlers** | Or separate Express/Fastify if complexity grows |
| Database | **PostgreSQL** via **Neon.tech** | Serverless Postgres, scales to zero, branching for dev |
| ORM | **Drizzle ORM** | Better TypeScript inference and bundle size vs Prisma |
| Authentication | **Clerk** | Built-in multi-tenant orgs, SSO, MFA, webhooks |
| File Storage | **Cloudinary** | Image optimization, transformation, and CDN delivery |
| Background Jobs | **Trigger.dev** or **Vercel Cron** | For alerts, report generation, scheduled tasks |
| Email | **Resend** | Transactional emails (receipts, alerts, invites) |

> **Changed:** Drizzle recommended over Prisma for better performance on serverless edge functions. Neon.tech recommended for its branching feature (dev/staging/prod database branches). Clerk recommended over NextAuth for first-class multi-tenant org support.

### 4.3 Architecture Principles

- **Row-Level Security (RLS):** Enable PostgreSQL RLS policies as a second layer of tenant isolation (in addition to application-level `organization_id` filtering)
- **API Design:** RESTful route handlers under `/api/v1/`. Consider tRPC for type-safe internal API calls.
- **Environment separation:** Use Neon database branches for `development`, `staging`, and `production`
- **Rate Limiting:** Apply rate limits on all API routes to prevent abuse (e.g., Upstash Redis)

---

## 5. Database Schema

> **Convention:** All timestamps are `timestamptz` (UTC). Soft deletes via `deleted_at`. Every table has `organization_id` with a foreign key to `organizations`.

```sql
-- Core tenant table
CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  owner_id      UUID NOT NULL,            -- References users.id
  slug          TEXT UNIQUE NOT NULL,     -- URL-safe identifier for subdomain
  subscription_status TEXT NOT NULL DEFAULT 'basic', -- basic | pro | enterprise
  subscription_expires_at TIMESTAMPTZ,
  tax_rate      NUMERIC(5,2) DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'LKR',
  created_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- Users (linked to Clerk)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'cashier', -- admin | manager | cashier
  organization_id UUID NOT NULL REFERENCES organizations(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- Suppliers / Vendors
CREATE TABLE suppliers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name          TEXT NOT NULL,
  contact_phone TEXT,
  contact_email TEXT,
  address       TEXT,
  payment_terms TEXT,   -- e.g. "Net 30"
  created_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- Products
CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name          TEXT NOT NULL,
  sku           TEXT,
  barcode       TEXT,
  type          TEXT NOT NULL,            -- purchased | manufactured
  unit          TEXT NOT NULL DEFAULT 'piece',
  retail_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
  wholesale_price NUMERIC(12,2),
  cost_price    NUMERIC(12,2),            -- purchase cost or COGS
  stock_qty     NUMERIC(12,3) NOT NULL DEFAULT 0,
  low_stock_threshold NUMERIC(12,3) DEFAULT 5,
  supplier_id   UUID REFERENCES suppliers(id),
  image_url     TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  organization_id UUID NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- Bill of Materials (for manufactured products)
CREATE TABLE bom_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  finished_product_id UUID NOT NULL REFERENCES products(id),
  raw_material_id     UUID NOT NULL REFERENCES products(id),
  quantity_required   NUMERIC(12,3) NOT NULL,
  unit            TEXT NOT NULL
);

-- Customers (for credit sales)
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  credit_limit  NUMERIC(12,2) DEFAULT 0,
  outstanding_balance NUMERIC(12,2) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Sales (Transactions)
CREATE TABLE sales (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  cashier_id    UUID NOT NULL REFERENCES users(id),
  customer_id   UUID REFERENCES customers(id),
  sale_type     TEXT NOT NULL DEFAULT 'retail',  -- retail | wholesale
  subtotal      NUMERIC(12,2) NOT NULL,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount  NUMERIC(12,2) NOT NULL,
  payment_type  TEXT NOT NULL,            -- cash | card | credit | split
  payment_reference TEXT,                -- card transaction ref
  status        TEXT NOT NULL DEFAULT 'completed', -- completed | voided | returned
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Sale Line Items
CREATE TABLE sale_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       UUID NOT NULL REFERENCES sales(id),
  product_id    UUID NOT NULL REFERENCES products(id),
  quantity      NUMERIC(12,3) NOT NULL,
  unit_price    NUMERIC(12,2) NOT NULL,
  discount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(12,2) NOT NULL
);

-- Purchase Orders (from suppliers)
CREATE TABLE purchase_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id   UUID NOT NULL REFERENCES suppliers(id),
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | ordered | received | cancelled
  total_amount  NUMERIC(12,2),
  ordered_at    TIMESTAMPTZ,
  received_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE purchase_order_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id),
  product_id        UUID NOT NULL REFERENCES products(id),
  quantity_ordered  NUMERIC(12,3) NOT NULL,
  quantity_received NUMERIC(12,3) NOT NULL DEFAULT 0,
  unit_cost         NUMERIC(12,2) NOT NULL
);
```

---

## 6. API Design

All routes are prefixed with `/api/v1/`. Authentication via Clerk session token (Bearer). All responses include `organization_id` validation middleware.

```
# Auth & Onboarding
POST   /auth/register-organization

# Products
GET    /products                  ?page&search&type&lowStock
POST   /products
GET    /products/:id
PATCH  /products/:id
DELETE /products/:id

# POS / Sales
POST   /sales                     Create a completed sale
GET    /sales                     ?from&to&cashier&type
GET    /sales/:id
POST   /sales/:id/void
POST   /sales/:id/return

# Customers
GET    /customers
POST   /customers
GET    /customers/:id
PATCH  /customers/:id/payment     Record credit payment

# Suppliers & Purchase Orders
GET    /suppliers
POST   /purchase-orders
PATCH  /purchase-orders/:id/receive

# Reports
GET    /reports/sales-summary     ?from&to
GET    /reports/inventory
GET    /reports/profit-loss       ?from&to

# Settings
GET    /settings
PATCH  /settings
```

---

## 7. Security & Compliance

- **Authentication:** Clerk handles JWT issuance, refresh, MFA, and session revocation
- **Authorization:** Every API handler verifies `user.organization_id` matches the resource being accessed
- **Row-Level Security (RLS):** PostgreSQL RLS as a backstop — queries without a valid `organization_id` return zero rows
- **Input Validation:** Zod schemas on all API inputs; never trust client-supplied `organization_id`
- **Audit Log:** Log all write operations (who, what, when) to an `audit_logs` table
- **HTTPS Only:** Enforce HTTPS via Vercel; HSTS headers set
- **PII Handling:** Customer emails and phone numbers encrypted at rest using pgcrypto
- **Backup:** Neon.tech automated daily backups + point-in-time recovery

---

## 8. Development Roadmap

### Phase 1 — Foundation (Weeks 1–2)
- [ ] Initialize Next.js 15 project with TypeScript, Tailwind, shadcn/ui
- [ ] Configure Neon.tech database and Drizzle ORM (run initial migrations)
- [ ] Integrate Clerk: sign-up, login, organization creation
- [ ] Build organization onboarding flow (create shop, invite first user)
- [ ] Deploy skeleton to Vercel with environment variables configured

### Phase 2 — Inventory Module (Weeks 3–4)
- [ ] Product CRUD (list, create, edit, delete, image upload via Cloudinary)
- [ ] Supplier CRUD
- [ ] Purchase Order creation and "mark as received" flow (auto-updates stock)
- [ ] BOM builder for manufactured products
- [ ] Low stock alert logic (in-app notification + Resend email)

### Phase 3 — POS Interface (Weeks 5–6)
- [ ] POS screen: product search, add to cart, quantity edit
- [ ] Pricing toggle (retail / wholesale)
- [ ] Discount application (with Manager threshold enforcement)
- [ ] Payment processing screen (cash, card, credit, split)
- [ ] Thermal receipt layout (80mm) + PDF invoice generation
- [ ] Hold cart / resume cart

### Phase 4 — Manufacturing & Customers (Week 7)
- [ ] Production order form (select finished product, auto-calculate raw material deduction)
- [ ] COGS calculator with labor cost input
- [ ] Customer profiles and credit tracking
- [ ] Sales return / refund flow

### Phase 5 — Reports & Analytics (Week 8)
- [ ] Dashboard with KPI cards (Recharts for charts)
- [ ] Sales report with date range filter and CSV export
- [ ] Inventory valuation report
- [ ] Basic P&L report
- [ ] Tax summary report

### Phase 6 — Polish & Launch (Week 9–10)
- [ ] Role-based UI rendering (hide features cashiers can't use)
- [ ] Subscription tier enforcement (product count limits, staff limits)
- [ ] Audit log viewer (Admin only)
- [ ] Mobile POS testing (tablet-friendly layout)
- [ ] End-to-end testing with Playwright
- [ ] Staging → Production deployment

---

## 9. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| **POS Page Load** | < 1.5 seconds on 4G mobile |
| **API Response Time (p95)** | < 300ms |
| **Uptime SLA** | 99.9% (Vercel + Neon managed) |
| **Concurrent Users per Tenant** | Up to 20 (Pro), unlimited (Enterprise) |
| **Data Retention** | 7 years (for tax compliance) |
| **Accessibility** | WCAG 2.1 AA (keyboard navigation on POS) |

---

## 10. Open Questions & Risks

| # | Question / Risk | Owner | Priority |
|---|----------------|-------|----------|
| 1 | Which tax regime applies (VAT only, NBT+VAT, or configurable per org)? | Business | High |
| 2 | Is offline POS support required for MVP or a later phase? | Product | High |
| 3 | Should product variants (size/color) be in MVP or Phase 2? | Product | Medium |
| 4 | Multi-currency support needed? (e.g., LKR + USD for wholesale export) | Business | Medium |
| 5 | What POS hardware is targeted — dedicated terminal, tablet, laptop? | Business | Medium |
| 6 | Is a mobile app (iOS/Android) required, or is a mobile web app sufficient? | Product | Low |
| 7 | GDPR/PDPA compliance needed if customers are from the EU or regulated regions? | Legal | Low |

---

*Document Version: 1.0 | Last Updated: May 2026 | Status: Draft for Review*
