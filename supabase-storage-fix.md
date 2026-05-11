# Supabase Storage Security Fix
### POS Receipt System — thilakawardhana shop
**Priority: Fix Today | Estimated Time: 30 minutes**

---

## What You Are Fixing

Your WhatsApp receipts currently use a permanent public URL like this:
```
https://rakklmxpukcehbyjuxjy.supabase.co/storage/v1/object/public/receipts/receipt_25_1778519910531.pdf
```

Problems with this:
- The link never expires — valid forever
- Anyone can guess other receipt numbers (receipt_1_, receipt_2_ etc.)
- All customer names, purchases, and amounts are exposed
- Your Supabase project ID is now public

After this fix, receipts will use signed URLs that expire in 1 hour and files will have unguessable names.

---

## STEP 1 — Make Storage Bucket Private (5 minutes)

### In Supabase Dashboard:

1. Go to https://supabase.com/dashboard
2. Select your project → Storage (left sidebar)
3. Click on your `receipts` bucket
4. Click Edit bucket (top right)
5. Uncheck "Public bucket"
6. Click Save

Done. Existing public links will now return 400 errors — no one can access them anymore.

---

## STEP 2 — Switch to Signed URLs in Your Code (10 minutes)

Find where you generate the receipt URL in your codebase and replace it.

### Before (what you have now):
```javascript
// This creates a permanent public URL — REMOVE THIS
const { data } = supabase.storage
  .from('receipts')
  .getPublicUrl(filePath);

const receiptUrl = data.publicUrl;
```

### After (what you need):
```javascript
// This creates a URL that expires after 1 hour
const { data, error } = await supabase.storage
  .from('receipts')
  .createSignedUrl(filePath, 3600); // 3600 seconds = 1 hour

if (error) {
  console.error('Failed to create signed URL:', error);
  throw error;
}

const receiptUrl = data.signedUrl;
```

### If you want 24 hour expiry:
```javascript
const { data } = await supabase.storage
  .from('receipts')
  .createSignedUrl(filePath, 86400); // 86400 = 24 hours
```

---

## STEP 3 — Fix File Naming (10 minutes)

### The Problem With Current Names:
```
receipt_25_1778519910531.pdf
         ^^
   order number — anyone can guess receipt_1_, receipt_2_, receipt_24_
```

### Before:
```javascript
// Guessable filename — BAD
const fileName = `receipt_${orderId}_${Date.now()}.pdf`;
```

### After:
```javascript
// Unguessable filename — GOOD
import { randomUUID } from 'crypto'; // Node.js built-in, no install needed

const fileName = `receipt_${randomUUID()}.pdf`;
// Example: receipt_f47ac10b-58cc-4372-a567-0e02b2c3d479.pdf
```

### If you need to keep the order ID reference:
```javascript
import { randomUUID } from 'crypto';

const fileToken = randomUUID();
const fileName = `${fileToken}.pdf`;

// Store the mapping in your database:
await supabase.from('order_receipts').insert({
  order_id: orderId,
  file_path: `receipts/${fileName}`,
  created_at: new Date().toISOString(),
});
```

---

## STEP 4 — Enable Row Level Security on All Tables (10 minutes)

This prevents anyone who finds your project ref from reading your database via the API.

### In Supabase Dashboard:

1. Go to Table Editor (left sidebar)
2. For each table — click the table name
3. Click RLS disabled toggle at the top to enable it
4. Click Add policy

### Run this in SQL Editor to check which tables need RLS:
```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```
Any table showing rowsecurity = false needs RLS enabled.

### Basic policies to add for each table:
```sql
-- Allow authenticated users to read
CREATE POLICY "Authenticated read"
ON your_table_name FOR SELECT
TO authenticated
USING (true);

-- Allow authenticated users to insert
CREATE POLICY "Authenticated insert"
ON your_table_name FOR INSERT
TO authenticated
WITH CHECK (true);

-- Block all anonymous access
REVOKE ALL ON your_table_name FROM anon;
```

---

## STEP 5 — Regenerate Your Anon Key

Since your project ref is now public, rotate your API keys.

1. Supabase Dashboard → Settings → API
2. Under Project API keys → click Regenerate next to anon key
3. Update your Vercel environment variables:
```
NEXT_PUBLIC_SUPABASE_URL=https://rakklmxpukcehbyjuxjy.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_new_key_here
```
4. Redeploy on Vercel

WARNING: Old key stops working immediately after regeneration. Update your app env vars first, then regenerate.

---

## Full Updated Receipt Function

Replace your existing receipt upload code with this:

```javascript
// lib/generateReceipt.js
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// Use service role key on server side — never expose this to client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function generateAndUploadReceipt(orderData) {
  try {
    // 1. Generate your PDF (your existing code here)
    const pdfBuffer = await generatePDF(orderData);

    // 2. Unguessable filename
    const fileToken = randomUUID();
    const filePath = `receipts/${fileToken}.pdf`;

    // 3. Upload to PRIVATE bucket
    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(filePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (uploadError) throw uploadError;

    // 4. Save reference in database
    await supabase.from('order_receipts').insert({
      order_id: orderData.id,
      file_path: filePath,
      created_at: new Date().toISOString(),
    });

    // 5. Create signed URL (expires in 1 hour)
    const { data: signedData, error: signedError } = await supabase.storage
      .from('receipts')
      .createSignedUrl(filePath, 3600);

    if (signedError) throw signedError;

    return {
      success: true,
      signedUrl: signedData.signedUrl,
    };

  } catch (error) {
    console.error('Receipt generation failed:', error);
    return { success: false, error: error.message };
  }
}

// Use this when customer asks for receipt again after link expires
export async function regenerateReceiptUrl(orderId) {
  const { data: receipt } = await supabase
    .from('order_receipts')
    .select('file_path')
    .eq('order_id', orderId)
    .single();

  if (!receipt) throw new Error('Receipt not found');

  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(receipt.file_path, 3600);

  if (error) throw error;
  return data.signedUrl;
}
```

---

## WhatsApp Message Template Update

```javascript
// Tell the customer the link has an expiry time
const message = 
  `Hello! Thank you for your purchase at thilakawardhana shop\n\n` +
  `Your receipt for Order #${orderId}:\n${signedUrl}\n\n` +
  `This link is valid for 24 hours. Reply if you need it resent.`;
```

---

## Verification Checklist

After completing all steps verify each item:

STORAGE
  - receipts bucket is set to Private not Public
  - Old public URLs now return errors (test one in browser)
  - New signed URLs work and open the PDF
  - Signed URLs expire after expected time

CODE
  - getPublicUrl() removed from codebase (search for it in your editor)
  - createSignedUrl() used everywhere receipts are sent
  - File names use randomUUID() with no sequential order numbers in filename

DATABASE
  - RLS enabled on all tables (check pg_tables query above)
  - Anon role cannot read sensitive tables
  - order_receipts table exists to store file paths

ENVIRONMENT
  - SUPABASE_SERVICE_ROLE_KEY is server only — NOT prefixed NEXT_PUBLIC_
  - Anon key regenerated and updated in Vercel env vars
  - App redeployed after env var changes

---

*Fix guide for: thilakawardhana shop POS System*
*Issue: Public Supabase storage bucket exposing customer receipts*
*Date: May 2026*
