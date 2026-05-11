# POS Security Hardening Guide — Vercel Deployment
### Role: Systems Security Developer | Stack: Next.js / Vercel

---

## SECTION 1 — THREAT MODEL (Read This First)

Before hardening anything, understand what you're protecting against:

| Threat | Risk Level | Attack Vector |
|---|---|---|
| Unauthorized POS access | Critical | Stolen credentials, shared passwords |
| Session hijacking | Critical | JWT theft, XSS, MITM |
| SQL injection via API routes | Critical | Malicious input in sale/product endpoints |
| Void/refund fraud by cashiers | High | Insider manipulation of transaction records |
| Price override tampering | High | Direct API calls bypassing UI |
| Brute force login | High | Automated credential stuffing |
| Audit log tampering | High | Deleting or editing own audit records |
| Exposed environment variables | High | Public repo, client-side env leak |
| IDOR (access other locations' data) | High | Changing IDs in API requests |
| Token replay attacks | Medium | Reusing old valid JWTs |
| Vercel function timeout abuse | Medium | Slow-loris style API exhaustion |
| Exposed admin routes | Medium | Unprotected `/api/admin/*` endpoints |

---

## SECTION 2 — AUTHENTICATION HARDENING

### 2.1 Never Roll Your Own Auth
Use **NextAuth.js** (now Auth.js) or **Clerk** — do not write custom JWT logic from scratch.

```
Recommended stack:
- Auth.js (NextAuth v5) for session management
- bcryptjs (rounds: 12) for password hashing
- nanoid for secure token generation
- zod for input validation on all auth endpoints
```

### 2.2 Password Policy — Enforce in Code, Not Just UI

```javascript
// zod schema — apply to registration AND password change
const passwordSchema = z.string()
  .min(10, "Minimum 10 characters")
  .regex(/[A-Z]/, "Must contain uppercase")
  .regex(/[a-z]/, "Must contain lowercase")
  .regex(/[0-9]/, "Must contain number")
  .regex(/[^A-Za-z0-9]/, "Must contain special character");

// Hash with high cost factor
const hash = await bcrypt.hash(password, 12);
```

### 2.3 Multi-Factor Authentication (MFA)
- **Admin role: MFA mandatory** — use TOTP (Google Authenticator / Authy)
- **Manager role: MFA strongly recommended**
- **Cashier role: PIN + password is acceptable** (fast POS login)

```javascript
// TOTP implementation
import { authenticator } from 'otplib';

// Verify MFA token on every sensitive action:
// - Login for Admin/Manager
// - Void over threshold
// - EOD close
// - User creation/deactivation
const isValid = authenticator.verify({
  token: userProvidedToken,
  secret: user.mfaSecret  // stored encrypted in DB
});
```

### 2.4 Session Configuration

```javascript
// auth.config.js
export const authConfig = {
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60,        // 8 hours max (one shift)
    updateAge: 30 * 60,          // refresh every 30 min of activity
  },
  jwt: {
    maxAge: 8 * 60 * 60,
  },
  cookies: {
    sessionToken: {
      options: {
        httpOnly: true,          // JS cannot read this cookie
        secure: true,            // HTTPS only
        sameSite: "strict",      // no cross-site sending
        path: "/",
      }
    }
  }
}
```

### 2.5 Login Brute Force Protection

```javascript
// Rate limit login attempts — store in Redis (Upstash on Vercel)
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(5, "15 m"), // 5 attempts per 15 min
});

// In your POST /api/auth/login handler:
const identifier = `login_${ip}_${email}`;
const { success, remaining } = await ratelimit.limit(identifier);

if (!success) {
  // Lock account after 5 failures, notify admin
  await logAuditEvent('ACCOUNT_LOCKOUT', { email, ip });
  return res.status(429).json({ 
    error: "Too many attempts. Account locked for 15 minutes." 
  });
}
```

### 2.6 Account Lockout Policy
- 5 failed attempts → lock for 15 minutes
- 10 cumulative failures in 24h → lock until admin unlocks
- All lockouts must appear in the audit log
- Admin gets notified (email or in-app alert)

---

## SECTION 3 — AUTHORIZATION (WHO CAN DO WHAT)

### 3.1 Middleware-Level Route Protection

```javascript
// middleware.ts — runs on EVERY request before it hits your pages/API
import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // Not logged in — redirect to login
  if (!session) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const role = session.user.role;

  // Route-to-role enforcement
  const routeRoles = {
    "/api/admin":     ["ADMIN"],
    "/api/users":     ["ADMIN"],
    "/api/reports":   ["ADMIN", "MANAGER", "FINANCE"],
    "/api/voids":     ["ADMIN", "MANAGER", "SUPERVISOR"],
    "/api/refunds":   ["ADMIN", "MANAGER", "SUPERVISOR"],
    "/api/sales":     ["ADMIN", "MANAGER", "SUPERVISOR", "CASHIER"],
    "/api/products":  ["ADMIN", "MANAGER"],
  };

  for (const [route, allowedRoles] of Object.entries(routeRoles)) {
    if (pathname.startsWith(route) && !allowedRoles.includes(role)) {
      await logAuditEvent('UNAUTHORIZED_ACCESS_ATTEMPT', {
        userId: session.user.id,
        route: pathname,
        role,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
});

export const config = {
  matcher: ["/api/:path*", "/dashboard/:path*", "/admin/:path*"]
};
```

### 3.2 NEVER Trust the Client — Verify Role on Every API Call

```javascript
// Every API route must re-verify — middleware is not enough alone
export async function POST(req) {
  const session = await getServerSession(authOptions);
  
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!["ADMIN", "MANAGER"].includes(session.user.role)) {
    return new Response("Forbidden", { status: 403 });
  }
  
  // Only now process the request
}
```

### 3.3 Location/Terminal Scoping (IDOR Prevention)

```javascript
// Cashiers must ONLY see data for their assigned location
// WRONG — trusts client-supplied locationId:
const sales = await db.sales.findMany({ 
  where: { locationId: req.body.locationId }  // ❌ attacker can change this
});

// CORRECT — use the session's assigned location:
const sales = await db.sales.findMany({
  where: { 
    locationId: session.user.locationId,      // ✅ from verified session
    terminalId: session.user.terminalId       // ✅ further scoped
  }
});
```

### 3.4 Dual Authorization for Destructive Actions
Voids over a threshold, refunds, EOD close — require a second authorized user:

```javascript
// Two-person integrity pattern
async function authorizeVoid(voidRequest, authorizerCredentials) {
  // 1. Verify the authorizer is a different user than the requester
  if (authorizerCredentials.userId === voidRequest.requestedBy) {
    throw new Error("Cannot self-authorize a void");
  }
  
  // 2. Verify authorizer has permission
  const authorizer = await db.users.findUnique({ 
    where: { id: authorizerCredentials.userId } 
  });
  if (!["ADMIN","MANAGER","SUPERVISOR"].includes(authorizer.role)) {
    throw new Error("Insufficient role to authorize void");
  }
  
  // 3. Log both users
  await logAuditEvent('VOID_AUTHORIZED', {
    requestedBy: voidRequest.requestedBy,
    authorizedBy: authorizer.id,
    saleId: voidRequest.saleId,
    amount: voidRequest.amount,
  });
}
```

---

## SECTION 4 — API SECURITY

### 4.1 Input Validation on Every Endpoint

```javascript
// NEVER trust incoming data — validate everything with zod
import { z } from "zod";

const createSaleSchema = z.object({
  locationId:  z.string().uuid(),
  terminalId:  z.string().uuid(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity:  z.number().int().positive().max(9999),
    unitPrice: z.number().positive().max(1000000),
  })).min(1).max(100),
  paymentMethod: z.enum(["CASH", "CARD", "CREDIT", "SPLIT"]),
});

export async function POST(req) {
  const body = await req.json();
  const result = createSaleSchema.safeParse(body);
  
  if (!result.success) {
    return Response.json({ 
      error: "Invalid input", 
      details: result.error.flatten() 
    }, { status: 400 });
  }
  
  // Use result.data — never the raw body
  const { items, locationId } = result.data;
}
```

### 4.2 SQL Injection Prevention
Use Prisma or Drizzle ORM — never raw string concatenation:

```javascript
// NEVER do this:
const result = await db.query(
  `SELECT * FROM sales WHERE id = ${req.body.id}`  // ❌ SQL injection
);

// ALWAYS do this (Prisma):
const result = await db.sale.findUnique({
  where: { id: result.data.id }                    // ✅ parameterized
});

// If you MUST use raw SQL, use parameterized queries:
const result = await db.$queryRaw`
  SELECT * FROM sales WHERE id = ${Prisma.sql`${id}`}
`;
```

### 4.3 Rate Limiting All API Routes

```javascript
// Different limits for different endpoints
const rateLimits = {
  "/api/auth/login":    Ratelimit.slidingWindow(5, "15 m"),
  "/api/sales":         Ratelimit.slidingWindow(100, "1 m"),  // high volume OK
  "/api/voids":         Ratelimit.slidingWindow(10, "1 h"),   // suspicious if high
  "/api/refunds":       Ratelimit.slidingWindow(10, "1 h"),
  "/api/admin/users":   Ratelimit.slidingWindow(20, "1 h"),
  "/api/reports":       Ratelimit.slidingWindow(30, "1 m"),   // heavy queries
};
```

### 4.4 HTTP Security Headers — vercel.json

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        },
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        },
        {
          "key": "Permissions-Policy",
          "value": "camera=(), microphone=(), geolocation=(), payment=()"
        },
        {
          "key": "Strict-Transport-Security",
          "value": "max-age=63072000; includeSubDomains; preload"
        },
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://your-api-domain.com; frame-ancestors 'none';"
        },
        {
          "key": "X-XSS-Protection",
          "value": "1; mode=block"
        }
      ]
    }
  ]
}
```

### 4.5 CORS — Lock Down Strictly

```javascript
// next.config.js
const nextConfig = {
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", 
            value: process.env.ALLOWED_ORIGIN },   // your POS domain only
          { key: "Access-Control-Allow-Methods", 
            value: "GET,POST,PUT,DELETE,OPTIONS" },
          { key: "Access-Control-Allow-Headers", 
            value: "Content-Type, Authorization" },
          { key: "Access-Control-Allow-Credentials", 
            value: "true" },
        ],
      },
    ];
  },
};
```

---

## SECTION 5 — VERCEL-SPECIFIC HARDENING

### 5.1 Environment Variables — Critical Rules

```
# NEVER prefix sensitive vars with NEXT_PUBLIC_ — that exposes them client-side

# WRONG:
NEXT_PUBLIC_DATABASE_URL=postgres://...    ❌ visible to browser
NEXT_PUBLIC_JWT_SECRET=supersecret        ❌ visible to browser

# CORRECT:
DATABASE_URL=postgres://...               ✅ server-only
JWT_SECRET=supersecret                    ✅ server-only
NEXTAUTH_SECRET=supersecret               ✅ server-only

# Only expose what the browser genuinely needs:
NEXT_PUBLIC_APP_URL=https://yourpos.com   ✅ safe — not a secret
```

### 5.2 Required Environment Variables Checklist

```bash
# Auth
NEXTAUTH_SECRET=            # 32+ random chars: openssl rand -base64 32
NEXTAUTH_URL=               # https://yourpos.vercel.app

# Database (use connection pooling — PgBouncer/Supabase pooler)
DATABASE_URL=               # server-only, pooled connection string
DATABASE_DIRECT_URL=        # for migrations only

# Rate limiting
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Encryption key for sensitive fields (MFA secrets, etc.)
ENCRYPTION_KEY=             # 32 bytes: openssl rand -hex 32

# Alerts
ADMIN_ALERT_EMAIL=
SMTP_HOST=
SMTP_USER=
SMTP_PASS=

# Allowed origins
ALLOWED_ORIGIN=             # https://yourpos.vercel.app
```

### 5.3 Vercel Project Settings — Do These Now

```
Vercel Dashboard → Your Project → Settings:

1. Environment Variables
   → Add all secrets listed above
   → Set correct environment: Production / Preview / Development separately
   → Never put production DB in Preview environment

2. Deploy Protection (Vercel Pro)
   → Enable "Password Protection" for Preview deployments
   → Prevents clients/attackers seeing your staging environment

3. Allowed Domains (if using Vercel Postgres)
   → Restrict connections to Vercel's IP ranges only

4. Branch Protection
   → Only deploy from main branch to production
   → Require PR reviews before merge

5. Log Drains
   → Connect to a log aggregator (Logtail / Axiom / Datadog)
   → Never rely on Vercel's built-in logs for security events (they expire)
```

### 5.4 Vercel Edge Config for Feature Flags / IP Blocking

```javascript
// Block suspicious IPs at the edge (before your app runs)
import { get } from "@vercel/edge-config";

export async function middleware(req) {
  const blockedIPs = await get("blocked_ips"); // managed in Vercel dashboard
  const clientIP = req.headers.get("x-forwarded-for");
  
  if (blockedIPs?.includes(clientIP)) {
    return new Response("Access denied", { status: 403 });
  }
}
```

---

## SECTION 6 — AUDIT LOG HARDENING

### 6.1 Immutable Audit Log Design

```javascript
// Audit records must NEVER be editable or deletable — even by Admin
// Use append-only table with no UPDATE/DELETE permissions for app user

// Database user permissions:
// app_user: SELECT, INSERT on audit_log         ✅
// app_user: UPDATE, DELETE on audit_log         ❌ revoke this

// Prisma schema
model AuditLog {
  id          String   @id @default(cuid())
  eventType   String
  userId      String
  userRole    String
  terminalId  String?
  locationId  String?
  saleId      String?
  oldValue    Json?
  newValue    Json?
  ipAddress   String
  userAgent   String
  timestamp   DateTime @default(now())
  
  // No updatedAt — this record never changes
  @@index([userId, timestamp])
  @@index([eventType, timestamp])
  @@index([locationId, timestamp])
}
```

### 6.2 What Must Be Logged

```javascript
// Every security event — no exceptions
const AUDIT_EVENTS = {
  // Auth events
  LOGIN_SUCCESS:           'LOGIN_SUCCESS',
  LOGIN_FAILURE:           'LOGIN_FAILURE',
  LOGOUT:                  'LOGOUT',
  ACCOUNT_LOCKED:          'ACCOUNT_LOCKED',
  PASSWORD_CHANGED:        'PASSWORD_CHANGED',
  MFA_ENABLED:             'MFA_ENABLED',
  MFA_FAILED:              'MFA_FAILED',
  
  // Transaction events
  SALE_COMPLETED:          'SALE_COMPLETED',
  SALE_VOIDED:             'SALE_VOIDED',
  REFUND_ISSUED:           'REFUND_ISSUED',
  DISCOUNT_APPLIED:        'DISCOUNT_APPLIED',
  PRICE_OVERRIDDEN:        'PRICE_OVERRIDDEN',
  CASH_DRAWER_OPENED:      'CASH_DRAWER_OPENED',
  
  // Admin events
  USER_CREATED:            'USER_CREATED',
  USER_DEACTIVATED:        'USER_DEACTIVATED',
  ROLE_CHANGED:            'ROLE_CHANGED',
  PRODUCT_PRICE_CHANGED:   'PRODUCT_PRICE_CHANGED',
  
  // Security events
  UNAUTHORIZED_ATTEMPT:    'UNAUTHORIZED_ATTEMPT',
  RATE_LIMIT_HIT:          'RATE_LIMIT_HIT',
  SUSPICIOUS_PATTERN:      'SUSPICIOUS_PATTERN',
  
  // EOD events
  SHIFT_OPENED:            'SHIFT_OPENED',
  SHIFT_CLOSED:            'SHIFT_CLOSED',
  EOD_SUBMITTED:           'EOD_SUBMITTED',
  EOD_DISCREPANCY:         'EOD_DISCREPANCY',
};
```

### 6.3 Anomaly Detection Rules

```javascript
// Run these checks after every sale/void/refund
async function detectAnomalies(event) {
  const rules = [
    {
      name: "HIGH_VOID_RATE",
      check: async () => {
        const recentVoids = await db.auditLog.count({
          where: { 
            userId: event.userId, 
            eventType: 'SALE_VOIDED',
            timestamp: { gte: subHours(new Date(), 1) }
          }
        });
        return recentVoids > 5; // more than 5 voids in an hour
      },
    },
    {
      name: "REFUND_EXCEEDS_SALES",
      check: async () => {
        const [refunds, sales] = await Promise.all([
          db.refund.aggregate({ 
            _sum: { amount: true },
            where: { cashierId: event.userId, createdAt: { gte: startOfDay(new Date()) }}
          }),
          db.sale.aggregate({ 
            _sum: { total: true },
            where: { cashierId: event.userId, createdAt: { gte: startOfDay(new Date()) }}
          }),
        ]);
        return (refunds._sum.amount || 0) > (sales._sum.total || 0) * 0.3; // refunds > 30% of sales
      },
    },
    {
      name: "OFF_HOURS_LOGIN",
      check: async () => {
        const hour = new Date().getHours();
        return hour < 5 || hour > 23; // login between midnight-5am
      },
    },
  ];

  for (const rule of rules) {
    if (await rule.check()) {
      await notifyAdmin(rule.name, event);
      await logAuditEvent('SUSPICIOUS_PATTERN', { rule: rule.name, ...event });
    }
  }
}
```

---

## SECTION 7 — DATA SECURITY

### 7.1 Sensitive Field Encryption at Rest

```javascript
// Encrypt sensitive fields before storing — even if DB is compromised
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes

export function encrypt(text) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encryptedText) {
  const [ivHex, tagHex, encryptedHex] = encryptedText.split(':');
  const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encryptedHex, 'hex')) + decipher.final('utf8');
}

// Fields to encrypt:
// - MFA secrets
// - Bank account numbers (for payroll)
// - NIC numbers (for workers)
// - Customer credit card references
```

### 7.2 Database Security

```sql
-- Create separate DB users with minimum required permissions

-- App user (runtime): read/write on business data, append-only on audit
CREATE USER pos_app WITH PASSWORD 'strongpassword';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pos_app;
REVOKE UPDATE, DELETE ON audit_log FROM pos_app;  -- audit is append-only

-- Migration user: full access but used only during deployments
CREATE USER pos_migrate WITH PASSWORD 'differentstrongpassword';
GRANT ALL PRIVILEGES ON DATABASE posdb TO pos_migrate;

-- Readonly user: for reports/analytics (Finance role)
CREATE USER pos_readonly WITH PASSWORD 'anotherpassword';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pos_readonly;
REVOKE SELECT ON audit_log FROM pos_readonly;  -- audit is admin-only
```

### 7.3 No Sensitive Data in Logs

```javascript
// Sanitize before logging — NEVER log passwords, tokens, card numbers
function sanitizeForLog(obj) {
  const sensitiveKeys = ['password', 'token', 'secret', 'card', 'cvv', 'pin', 'mfaSecret'];
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => 
      sensitiveKeys.some(sk => k.toLowerCase().includes(sk)) 
        ? [k, '[REDACTED]'] 
        : [k, v]
    )
  );
}
```

---

## SECTION 8 — INCIDENT RESPONSE PLAN

### If You Detect a Breach:

```
STEP 1 — Contain (within 15 minutes)
  □ Rotate NEXTAUTH_SECRET in Vercel → forces ALL sessions to expire
  □ Rotate DATABASE_URL password
  □ Rotate ENCRYPTION_KEY (requires re-encrypting sensitive fields)
  □ Block suspicious IP via Vercel Edge Config

STEP 2 — Assess (within 1 hour)
  □ Pull full audit log for past 24 hours
  □ Identify what data was accessed / modified
  □ Identify which accounts were involved

STEP 3 — Notify
  □ Notify affected staff
  □ If customer/worker data exposed — legal obligation to notify within 72h
  □ Document everything with timestamps

STEP 4 — Recover
  □ Force password reset for all users
  □ Require MFA re-setup
  □ Review and patch the vulnerability before going back online

STEP 5 — Post-Mortem
  □ Write incident report: what happened, how, impact, fix
  □ Update threat model with new attack vector
  □ Add new detection rule to anomaly checker
```

---

## SECTION 9 — SECURITY CHECKLIST (Do Before Going Live)

```
AUTHENTICATION
  □ Passwords hashed with bcrypt rounds=12
  □ Sessions expire after 8 hours (one shift)
  □ Brute force protection on login (5 attempts, 15min lockout)
  □ MFA enabled and mandatory for Admin/Manager
  □ No hardcoded credentials anywhere in codebase
  □ All auth secrets in Vercel env vars (not in code)

AUTHORIZATION
  □ Middleware enforces role on every route
  □ Every API route re-verifies session server-side
  □ Location scoping prevents cross-location data access
  □ Dual authorization required for voids/refunds above threshold
  □ Cashiers cannot access report or admin routes

API SECURITY
  □ Zod validation on every API endpoint input
  □ ORM used — no raw SQL string concatenation
  □ Rate limiting on all endpoints (Upstash Redis)
  □ CORS locked to your domain only
  □ Security headers set in vercel.json

DATA
  □ No sensitive env vars prefixed NEXT_PUBLIC_
  □ MFA secrets encrypted at rest
  □ NIC/personal data encrypted at rest
  □ Audit log is append-only (no UPDATE/DELETE permissions)
  □ Separate DB users for app, migrations, readonly

VERCEL SETTINGS
  □ Preview deployments password-protected
  □ Production env vars different from development
  □ Log drain connected to external service
  □ Only main branch deploys to production

MONITORING
  □ Anomaly detection running (void rate, off-hours login)
  □ Admin alert on account lockout
  □ Admin alert on unauthorized access attempt
  □ Incident response plan documented and shared with team

CODE
  □ GitHub repo is private
  □ .env file is in .gitignore
  □ Dependencies audited: npm audit --audit-level=high
  □ No console.log() with sensitive data in production
```

---

---

# AI PROMPTS — Use These to Build the Security Layer

Copy-paste these prompts into Claude, ChatGPT, or Cursor AI to implement each section.

---

## PROMPT 1 — Full Auth Setup with NextAuth + Brute Force Protection

```
I have a Next.js 14 POS system deployed on Vercel. Set up complete authentication with the following requirements:

Tech stack: Next.js 14 App Router, NextAuth v5 (Auth.js), Prisma ORM, PostgreSQL (Supabase), Upstash Redis for rate limiting.

Requirements:
1. Credentials provider with email + password login
2. Password hashing with bcrypt rounds=12
3. Rate limit login to 5 attempts per 15 minutes per IP+email combination using Upstash Redis sliding window
4. After 5 failures: lock account in DB, log ACCOUNT_LOCKOUT to audit_log table, return 429 with message
5. Session strategy: JWT, maxAge 8 hours, updateAge 30 minutes
6. Session cookie: httpOnly=true, secure=true, sameSite=strict
7. Session must include: userId, email, role (ENUM: ADMIN, MANAGER, SUPERVISOR, CASHIER, FINANCE), locationId, terminalId
8. On every successful login: write LOGIN_SUCCESS to audit_log with ip, userAgent, timestamp
9. On every failed login: write LOGIN_FAILURE to audit_log

Provide: auth.config.ts, auth.ts, middleware.ts, and the Prisma schema for User and AuditLog models.
```

---

## PROMPT 2 — Role-Based Middleware + Route Protection

```
I have a Next.js 14 POS system with these roles: ADMIN, MANAGER, SUPERVISOR, CASHIER, FINANCE.

Write a complete middleware.ts that:
1. Protects all /dashboard, /api, and /admin routes — redirect unauthenticated users to /login
2. Enforces these route-to-role mappings:
   - /api/admin/* and /api/users/* → ADMIN only
   - /api/reports/* → ADMIN, MANAGER, FINANCE
   - /api/voids and /api/refunds → ADMIN, MANAGER, SUPERVISOR
   - /api/sales → all authenticated roles
   - /api/products (POST/PUT/DELETE) → ADMIN, MANAGER only
3. On a forbidden access attempt:
   - Return 403 JSON response
   - Log UNAUTHORIZED_ACCESS_ATTEMPT to audit_log with: userId, role, attempted route, ip, timestamp
4. Scope all data queries: extract locationId from session and attach to all DB queries so cashiers can only see their own location's data — show me a reusable helper function for this called withLocationScope(session, query)

Show full middleware.ts and the withLocationScope helper.
```

---

## PROMPT 3 — Immutable Audit Log System

```
I need a production-grade audit logging system for a Next.js 14 POS app on Vercel with Prisma + PostgreSQL.

Requirements:
1. Prisma model: AuditLog with fields: id (cuid), eventType (String), userId, userRole, terminalId?, locationId?, saleId?, oldValue (Json?), newValue (Json?), ipAddress, userAgent, timestamp (DateTime @default now). No updatedAt field.
2. A logAuditEvent(type, data, req) utility function that:
   - Extracts ip from x-forwarded-for header
   - Sanitizes data — redacts any keys containing: password, token, secret, pin, card, cvv
   - Never throws — wraps in try/catch and silently fails so it never breaks the main operation
3. List of all event types as a TypeScript const enum (use the events from the security document)
4. An anomaly detection function checkAnomalies(event) that runs async after writing the audit log and:
   - Checks: voids > 5 in last hour for same user
   - Checks: refunds > 30% of same-user same-day sales
   - Checks: login between midnight and 5am
   - On detection: logs SUSPICIOUS_PATTERN and calls notifyAdmin(ruleName, event)
5. A DB migration / raw SQL snippet that revokes UPDATE and DELETE on audit_log for the app DB user

Provide TypeScript implementation ready for Next.js App Router API routes.
```

---

## PROMPT 4 — API Input Validation + SQL Injection Prevention

```
I have a Next.js 14 POS API with these endpoints. For each one, write:
- A Zod validation schema
- The full API route handler with session check, role check, and validation
- Error responses that don't leak internal details

Endpoints needed:
1. POST /api/sales/create — body: { locationId (uuid), terminalId (uuid), items: [{productId (uuid), quantity (int 1-9999), unitPrice (number > 0 < 1000000)}], paymentMethod (enum: CASH|CARD|CREDIT|SPLIT) }
   - Must verify locationId matches session.user.locationId (IDOR prevention)
   - On success: log SALE_COMPLETED to audit_log

2. POST /api/voids — body: { saleId (uuid), reason (string 10-500 chars), authorizerId (uuid), authorizerPin (string) }
   - Verify authorizerId is different from session.user.id
   - Verify authorizer has SUPERVISOR or above role
   - Verify sale belongs to session user's location
   - On success: lock the sale record (set status=VOIDED, no further edits possible)
   - Log SALE_VOIDED with both user IDs

3. GET /api/reports/daily-sales — query: { date (ISO date string), locationId (uuid) }
   - FINANCE and above only
   - locationId must match session unless role is ADMIN (can see all)

Use Prisma for all DB operations. No raw SQL.
```

---

## PROMPT 5 — Security Headers + Vercel Configuration

```
I have a Next.js 14 POS app deployed on Vercel. Generate:

1. A complete vercel.json with security headers for all routes:
   - X-Frame-Options: DENY
   - X-Content-Type-Options: nosniff
   - Referrer-Policy: strict-origin-when-cross-origin
   - Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
   - Content-Security-Policy that allows: self, inline styles (needed for Next.js), Google Fonts, no frame ancestors
   - Permissions-Policy blocking camera, microphone, geolocation, payment
   - X-XSS-Protection: 1; mode=block

2. next.config.js with:
   - CORS headers on /api/* allowing only ALLOWED_ORIGIN env var
   - Headers that prevent the app from being embedded in iframes

3. A middleware.ts snippet that adds rate limiting using Upstash Redis with these limits:
   - /api/auth/login: 5 per 15 minutes per IP
   - /api/voids: 10 per hour per user
   - /api/refunds: 10 per hour per user
   - /api/reports: 30 per minute per user
   - /api/sales: 200 per minute per terminal (high volume is normal)
   - All others: 60 per minute per IP

4. A .env.example file listing every required environment variable with comments explaining each one and whether it's server-only or can be NEXT_PUBLIC_.
```

---

## PROMPT 6 — Sensitive Data Encryption

```
I need to encrypt sensitive fields in my Next.js 14 + Prisma POS system before storing them in PostgreSQL.

Fields to encrypt:
- User.mfaSecret (TOTP secret)
- Worker.nicNumber (national ID)
- Worker.bankAccountNumber
- Customer.contactNumber (for credit accounts)

Requirements:
1. Encryption utility using Node.js built-in crypto with AES-256-GCM
2. Key comes from ENCRYPTION_KEY env var (32 bytes hex)
3. Each encrypted value stores: iv + authTag + ciphertext as a single string
4. Prisma middleware that automatically encrypts on write and decrypts on read for the listed fields — so the rest of the app doesn't need to call encrypt/decrypt manually
5. A one-time migration script that encrypts existing plaintext values in the DB
6. Unit tests for the encrypt/decrypt round-trip

Stack: Next.js 14, Prisma, TypeScript. Provide complete implementation.
```

---

## PROMPT 7 — MFA Implementation (TOTP)

```
Add TOTP-based MFA to my Next.js 14 POS system using the otplib library.

Requirements:
1. MFA setup flow:
   - POST /api/auth/mfa/setup → generates TOTP secret, returns QR code URL and backup codes (10 codes, each single-use)
   - Secret stored encrypted in DB (use my existing encrypt() utility)
   - POST /api/auth/mfa/verify-setup → verifies first TOTP token, marks MFA as enabled

2. MFA enforcement:
   - After successful password login, if user has MFA enabled: set session state to 'mfa_pending' instead of 'authenticated'
   - Redirect to /mfa-verify page
   - POST /api/auth/mfa/verify → verify token, upgrade session to 'authenticated'
   - If 'mfa_pending' session tries to access any route other than /mfa-verify → redirect to /mfa-verify

3. MFA is MANDATORY for ADMIN and MANAGER roles — they cannot complete login without it
4. Backup codes: hashed with bcrypt in DB, each invalidated after single use, log MFA_BACKUP_CODE_USED to audit_log

5. MFA disable flow (Admin only):
   - Can disable MFA for another user (not self)
   - Requires Admin's own MFA confirmation first
   - Logs MFA_DISABLED with admin userId and target userId

Provide: API routes, session state machine, and the MFA verify page component.
```

---

## PROMPT 8 — Anomaly Detection + Admin Alerting

```
Build an anomaly detection and alerting system for my Next.js 14 POS on Vercel.

Detection rules to implement:
1. HIGH_VOID_RATE: same cashier voids more than 5 sales in 1 hour
2. LARGE_VOID: single void exceeds LKR 50,000
3. REFUND_ABUSE: cashier's refunds exceed 30% of their same-day total sales
4. OFF_HOURS_LOGIN: any login between 00:00-05:00 local time
5. RAPID_TRANSACTIONS: more than 20 sales in 5 minutes from same terminal (potential bot)
6. MULTIPLE_PRICE_OVERRIDES: same cashier overrides price more than 3 times in 1 hour
7. ACCOUNT_SHARING: same account logged in from 2 different IPs within 10 minutes

Implementation:
- checkAnomalies(eventType, eventData, session) function called after every audit log write
- Each rule is async and queries the audit_log table
- On trigger: 
  (a) write SUSPICIOUS_PATTERN to audit_log with rule name and evidence
  (b) send email alert to ADMIN_ALERT_EMAIL env var using Resend (or Nodemailer)
  (c) for ACCOUNT_SHARING: immediately invalidate all sessions for that user

Email alert format: plain text, includes rule name, user name, location, timestamp, and a link to the audit log filtered for that user.

Provide the full checkAnomalies function and email utility. Use Resend for email (Vercel-compatible).
```

---

*Document prepared by: Systems Security Developer*
*Context: POS System on Vercel — Security Hardening Guide*
*Date: May 2026*
