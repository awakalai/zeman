-- An administrator is refused the sensitive things. They do not do them and then wait.
--
-- The owner's words: the admin should be able to do everything the owner can except the
-- sensitive details — and cannot do those, rather than doing them and waiting for the owner to
-- accept.
--
-- What was built is neither. Approval is decided by amount, not by rank: cross a threshold and
-- the command becomes a pending request whoever you are. So an administrator's large transaction
-- was accepted, parked, and left waiting — which is exactly the shape the owner said they did not
-- want — and the owner's own large transaction was parked too, waiting for a second administrator
-- to approve what the owner had already decided. In a business with one owner and one member of
-- staff, that second person is the member of staff, so the control ran backwards: the junior
-- approving the senior.
--
-- Two changes, and no command is touched.
--
-- The owner and the manager are the authority. Nobody approves them, because there is nobody
-- above them to do it — the owner is the top of their own business, and the manager is not in it.
--
-- The administrator is refused, in words that say what to do next. Not queued: a request sitting
-- in a list is a job somebody thinks is done, and the person who made it goes home.
begin;

create or replace function public.sarraf_requires_approval(
  p_operation text, p_amount_usd numeric, p_has_diff boolean default false)
returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  c public.control_settings%rowtype;
  v_level text;
begin
  if public.sarraf_approval_context() then return false; end if;

  -- Rank first, because it decides the question rather than colouring it. An owner is the top of
  -- their own business; a manager is not a party to it at all. Neither waits for anybody.
  v_level := public.sarraf_admin_level();
  if v_level in ('owner', 'manager') then return false; end if;

  -- Everything below is the rule exactly as it stood. Only the two lines above are new: the
  -- branches are copied rather than remembered, because the first attempt at this invented three
  -- of them — require_delete_approval, require_close_diff_approval and a delete_transaction
  -- operation — none of which exist, and the function failed on the first sensitive action
  -- rather than at the point it was written.
  select * into c from public.control_settings where singleton;
  return case p_operation
    when 'commit_transactions' then c.transaction_approval_usd is not null and p_amount_usd>=c.transaction_approval_usd
    when 'post_ledger' then c.cash_approval_usd is not null and p_amount_usd>=c.cash_approval_usd
    when 'account_move' then c.cash_approval_usd is not null and p_amount_usd>=c.cash_approval_usd
    when 'account_transfer' then c.transfer_approval_usd is not null and p_amount_usd>=c.transfer_approval_usd
    when 'edit_transaction' then c.require_edit_approval
    when 'void_transaction' then c.require_void_approval
    when 'close_day' then c.require_day_close_diff_approval and p_has_diff
    else false end;
end;
$$;

-- ── and the refusal itself ──────────────────────────────────────────────────
--
-- After the change above, the only caller that reaches this is an administrator who is not the
-- owner. So it stops being a request and becomes an answer: no, and here is who can.
--
-- The message names the operation and the amount, because "not permitted" tells somebody they
-- were stopped and not what to do about it. Kurdish, because the person reading it is standing at
-- a counter and this is the language they work in.
create or replace function public.sarraf_request_approval(
  p_operation text, p_command_key text, p_subject_key text, p_payload jsonb,
  p_amount_usd numeric, p_reason text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype;
begin
  v_actor := public.sarraf_require_admin(false);
  raise exception using
    errcode = '42501',
    message = format('ئەم کارە تەنها خاوەن کار دەیکات — داوای لە خاوەن کارەکەت بکە (%s%s)',
                     p_operation,
                     case when p_amount_usd is null then ''
                          else format(' — %s دۆلار', round(p_amount_usd, 2)) end),
    hint = 'sensitive operations are the owner''s; an administrator is refused rather than queued';
end;
$$;

comment on function public.sarraf_request_approval(text,text,text,jsonb,numeric,text) is
  'Refuses a sensitive operation attempted by an administrator, naming what to ask the owner for. It no longer queues anything: a request sitting in a list is a job somebody thinks is done.';

do $own$
begin
  if exists (select 1 from pg_roles where rolname = 'sarraf_definer') then
    execute 'grant create on schema public to sarraf_definer';
    execute 'alter function public.sarraf_requires_approval(text,numeric,boolean) owner to sarraf_definer';
    execute 'alter function public.sarraf_request_approval(text,text,text,jsonb,numeric,text) owner to sarraf_definer';
    execute 'revoke create on schema public from sarraf_definer';
  end if;
end
$own$;

commit;
