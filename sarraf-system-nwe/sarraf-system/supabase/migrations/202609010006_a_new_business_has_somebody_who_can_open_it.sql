-- Creating a business left nobody able to sign into it (§ stage 11).
--
-- sarraf_manager_create_tenant makes the tenants row and copies the control settings, and that
-- is the whole of it. The business exists, owns nothing, and has no account attached — so the
-- manager's next act is to go to a different screen and create an owner, and if they forget,
-- the business sits there looking created and is unusable.
--
-- Selling this system means doing that once per customer, correctly, without remembering a
-- second step. So it is one act: the business, its settings, and the person who will open it.
--
-- ── How an account comes into being here ─────────────────────────────────────────────────────
--
-- Not by this function creating a login. A password is only ever typed into Supabase's own
-- dashboard — 202608260001 built it that way on purpose, and it is right: nothing in this
-- repository, this workflow, or this migration ever holds one. What is written is a row in
-- pending_accounts saying who a login will be when it is made, and the trigger on auth.users
-- reads it the moment that email first signs in.
--
-- So the manager creates the business and names the owner's email. The owner is then invited
-- through Supabase, and becomes the owner of that business the first time they arrive.

begin;

-- The manager writes the pending owner, and only the manager.
--
-- pending_accounts was read-only to everybody: 202608260001 granted SELECT and nothing else,
-- because until now the rows were written by migration. The command below writes one, and it
-- runs as sarraf_definer — which has no BYPASSRLS, deliberately — so the table has to say that
-- a manager may add a row. Nobody else may, and nobody may change or remove one.
grant insert on public.pending_accounts to authenticated;

drop policy if exists pending_accounts_manager_writes on public.pending_accounts;
create policy pending_accounts_manager_writes on public.pending_accounts
  for insert to authenticated
  with check ((select public.sarraf_sees_all_tenants()));


create or replace function public.sarraf_manager_open_business(
  p_id text, p_name text, p_owner_email text, p_owner_name text, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype;
  v_id text := btrim(coalesce(p_id, ''));
  v_email text := lower(btrim(coalesce(p_owner_email, '')));
  v_owner_name text := btrim(coalesce(p_owner_name, ''));
  v_app_id text;
  v_created jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may open a business';
  end if;

  -- Judged before anything is written. Half a business is worse than none: the id is in every
  -- row it will ever own, and a failure after the tenants row exists leaves an id that cannot
  -- be reused and a customer who cannot sign in.
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'the owner needs an email address';
  end if;
  if char_length(v_owner_name) < 2 then
    raise exception using errcode = '22023', message = 'the owner needs a name';
  end if;
  if exists (select 1 from public.pending_accounts where email = v_email) then
    raise exception using errcode = '23505', message = 'that email is already waiting for an account';
  end if;
  if exists (select 1 from public.app_users u
              join auth.users a on a.id = u.auth_id
             where lower(a.email) = v_email and not u.deleted) then
    raise exception using errcode = '23505', message = 'that email already has an account';
  end if;

  -- The business itself, with everything sarraf_manager_create_tenant does — called rather than
  -- copied, so the two cannot drift into creating different businesses.
  v_created := public.sarraf_manager_create_tenant(v_id, p_name, p_note);

  -- An id for the owner that reads as what it is, and cannot collide with one already taken.
  v_app_id := 'own-' || v_id;
  if exists (select 1 from public.app_users where id = v_app_id) then
    v_app_id := 'own-' || v_id || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  insert into public.pending_accounts(email, app_id, name, role, admin_level, tenant_id, note)
  values (v_email, v_app_id, v_owner_name, 'admin', 'owner', v_id,
          'خاوەنی یەکەمی ئەم بازرگانییە، لەلایەن ماناجەرەوە دانراوە');

  perform public.sarraf_write_audit(v_actor.id, 'کردنەوەی بازرگانییەکی نوێ',
    format('%s — خاوەن: %s', v_id, v_owner_name));

  return v_created || jsonb_build_object(
    'owner_email', v_email,
    'owner_name', v_owner_name,
    'owner_app_id', v_app_id,
    -- Said out loud, because it is the step that is not done here and the one a manager will
    -- otherwise wait for. The account exists the moment this person first signs in.
    'next', 'ئێستا لە Supabase → Authentication بانگهێشتی ئەم ئیمەیڵە بکە. یەکەم جار کە دەچێتە ژوورەوە، دەبێتە خاوەنی ئەم بازرگانییە.');
end;
$$;

comment on function public.sarraf_manager_open_business(text, text, text, text, text) is
  'A new customer, in one act: the business, its settings, and the pending owner account. No password is created or held anywhere — the owner is invited through Supabase and becomes the owner on first sign-in.';

grant create on schema public to sarraf_definer;
alter function public.sarraf_manager_open_business(text, text, text, text, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

revoke all on function public.sarraf_manager_open_business(text, text, text, text, text) from public, anon;
grant execute on function public.sarraf_manager_open_business(text, text, text, text, text) to authenticated;

commit;
