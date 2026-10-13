-- ═══════════════════════════════════════════════════════════
-- Crystal Restaurant & Cafe — create the admin login in the cloud
-- The "admincrystal" account existed only in one browser on one computer,
-- so other windows and tills could not sign in with it.
--
-- 1. Change YOUR-PASSWORD below to the password you want.
-- 2. Run once in Supabase → SQL Editor.
-- If the username already exists for this business, only the password and
-- active flag are updated.
-- ═══════════════════════════════════════════════════════════
DO $$
DECLARE
  org UUID;
  matches INT;
  new_password TEXT := 'admincrystal456';
BEGIN
  IF new_password = 'YOUR-PASSWORD' OR length(new_password) < 3 THEN
    RAISE EXCEPTION 'Set new_password first. Nothing was changed.';
  END IF;
  SELECT count(*) INTO matches FROM public.organizations WHERE name ILIKE 'Crystal Restaurant%';
  IF matches <> 1 THEN
    RAISE EXCEPTION 'Expected one business named "Crystal Restaurant…", found %. Nothing was changed.', matches;
  END IF;
  SELECT id INTO org FROM public.organizations WHERE name ILIKE 'Crystal Restaurant%';

  IF EXISTS (SELECT 1 FROM public.users WHERE organization_id = org AND lower(username) = 'admincrystal') THEN
    UPDATE public.users SET password = new_password, is_active = true
    WHERE organization_id = org AND lower(username) = 'admincrystal';
  ELSE
    INSERT INTO public.users (username, password, display_name, role, is_active, organization_id)
    VALUES ('admincrystal', new_password, 'crystal admin', 'Admin', true, org);
  END IF;
END $$;
