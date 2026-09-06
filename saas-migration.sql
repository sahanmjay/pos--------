-- ═══════════════════════════════════════════════════════════
-- NexPOS SaaS Migration — Run this in Supabase SQL Editor
-- Converts single-tenant POS into multi-tenant SaaS platform
-- ═══════════════════════════════════════════════════════════

-- 1. SUPER ADMINS TABLE (Platform owners - separate from business users)
CREATE TABLE IF NOT EXISTS public.super_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login TIMESTAMPTZ
);

-- 2. SUBSCRIPTION PLANS
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_users INTEGER DEFAULT 3,
  max_products INTEGER DEFAULT 100,
  max_monthly_sales INTEGER DEFAULT 500,
  features JSONB DEFAULT '{}',
  price_monthly NUMERIC DEFAULT 0
);

-- 3. PLATFORM ACTIVITY LOG (Super admin level)
CREATE TABLE IF NOT EXISTS public.platform_log (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT DEFAULT '',
  action TEXT NOT NULL,
  target_org UUID,
  target_name TEXT DEFAULT '',
  details JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT now()
);

-- 4. EXTEND ORGANIZATIONS TABLE
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT '';
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS plan_id TEXT DEFAULT 'free';
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS max_users INTEGER DEFAULT 3;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS max_products INTEGER DEFAULT 100;

-- 5. PLATFORM SETTINGS (AI keys, provider configs, platform-wide toggles)
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6. RLS POLICIES
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_super_admins" ON public.super_admins FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_subscription_plans" ON public.subscription_plans FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.platform_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_platform_log" ON public.platform_log FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_platform_settings" ON public.platform_settings FOR ALL USING (true) WITH CHECK (true);

-- 7. SEED SUPER ADMIN
INSERT INTO public.super_admins (username, password, display_name, email)
VALUES ('superadmin', 'super@123', 'Platform Owner', 'admin@nexpos.cloud')
ON CONFLICT (username) DO NOTHING;

-- 8. SEED SUBSCRIPTION PLANS
INSERT INTO public.subscription_plans (id, name, max_users, max_products, max_monthly_sales, features, price_monthly) VALUES
  ('free', 'Free', 3, 100, 500, '{"reports":false,"ai":false}', 0),
  ('starter', 'Starter', 10, 500, 2000, '{"reports":true,"ai":false}', 2500),
  ('pro', 'Professional', 25, 2000, 10000, '{"reports":true,"ai":true}', 7500),
  ('enterprise', 'Enterprise', 999, 99999, 999999, '{"reports":true,"ai":true,"priority_support":true}', 15000)
ON CONFLICT (id) DO NOTHING;

-- 9. SEED PLATFORM SETTINGS (AI & SaaS defaults)
INSERT INTO public.platform_settings (key, value) VALUES
  ('ai_provider', 'google'),
  ('ai_model', 'gemini-1.5-flash'),
  ('ai_enabled', 'true'),
  ('ai_plan_requirement', 'pro'),
  ('ai_api_key', '')
ON CONFLICT (key) DO NOTHING;

-- 10. UPDATE EXISTING ORG WITH DEFAULTS
UPDATE public.organizations SET is_active = TRUE WHERE is_active IS NULL;
UPDATE public.organizations SET plan_id = 'free' WHERE plan_id IS NULL;

