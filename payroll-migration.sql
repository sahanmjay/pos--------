-- ═══════════════════════════════════════════════════════════
-- NexPOS — Payroll Migration
-- ═══════════════════════════════════════════════════════════

-- 1. Update Users table with Salary fields
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS ot_rate NUMERIC DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_paid_date DATE;

-- 2. Create Payroll table
CREATE TABLE IF NOT EXISTS public.payroll (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES public.users(id),
  employee_name TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_hours NUMERIC DEFAULT 0,
  ot_hours NUMERIC DEFAULT 0,
  basic_pay NUMERIC NOT NULL,
  ot_pay NUMERIC DEFAULT 0,
  advances_deducted NUMERIC DEFAULT 0,
  total_salary NUMERIC NOT NULL,
  paid_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  organization_id UUID REFERENCES public.organizations(id)
);

-- 3. Create Advances table
CREATE TABLE IF NOT EXISTS public.advances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES public.users(id),
  employee_name TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'PENDING', -- PENDING, DEDUCTED
  date DATE DEFAULT CURRENT_DATE,
  organization_id UUID REFERENCES public.organizations(id)
);

-- 4. Enable RLS and Create Policies
ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_payroll" ON public.payroll FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.advances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_advances" ON public.advances FOR ALL USING (true) WITH CHECK (true);
