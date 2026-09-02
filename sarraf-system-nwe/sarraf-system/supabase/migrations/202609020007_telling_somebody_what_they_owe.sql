-- نۆتیفیکەیشنی قەرز
--
-- «یان نۆتفیکەیشن بۆ ئەوان بنێرم کە ئەوەنە قەرزارن.»
--
-- The notification table has existed since 202608280009 and every kind it knew about was about
-- a receipt. Debt is the other half of what a person needs to be told, and there was no way to
-- tell them: the owner's only options were to phone them or to say nothing.
--
-- ── Written by a command, as every notification is ──────────────────────────────────────────
--
-- No browser inserts here — the table grants `authenticated` select and update and nothing else,
-- so this command is the only way a debt reminder comes into being. It says a true thing about
-- one debt, addressed to the party that actually owes it, and it is idempotent on its key so a
-- double press is one reminder rather than two.

begin;

alter table public.zeman_notifications drop constraint if exists zeman_notifications_kind_check;
alter table public.zeman_notifications add constraint zeman_notifications_kind_check check (kind in (
  'receipt_received','receipt_accepted','receipt_rejected','receipt_replaced','batch_arrived',
  'debt_reminder'));

alter table public.zeman_notifications drop constraint if exists zeman_notifications_subject_kind_check;
alter table public.zeman_notifications add constraint zeman_notifications_subject_kind_check
  check (subject_kind in ('receipt','batch','transaction','debt'));

-- ── The one way in ──────────────────────────────────────────────────────────────────────────
--
-- Every notification written before this one came from a trigger, and a trigger runs as the
-- superuser, so no policy ever had to say who may write here. This command is not a trigger —
-- verify:isolation requires it to run as sarraf_definer, which policies do apply to — so the
-- permission has to be stated, and stating it narrowly is better than the blanket the triggers
-- have: sarraf_definer may INSERT, only inside a tenant it can see, and nothing else changes.
grant insert on public.zeman_notifications to sarraf_definer;

--
-- Written as two scalar subqueries and a column comparison rather than as
-- sarraf_tenant_visible(tenant_id): the function takes the row as an argument, so the planner
-- calls it once per row instead of once per statement. verify:scale refuses that shape and it
-- caught this policy — on a table that gains a row every time anybody is told anything,
-- once-per-row is fine at ten rows and is not at ten thousand.
drop policy if exists zeman_notifications_written_by_command on public.zeman_notifications;
create policy zeman_notifications_written_by_command on public.zeman_notifications
  for insert to sarraf_definer
  with check (
    (select public.sarraf_sees_all_tenants())
    or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))
  );

create or replace function public.sarraf_remind_debtor(
  p_debt_id text, p_note text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_debt public.debts%rowtype;
  v_recipient text; v_name text; v_result jsonb; v_id text;
begin
  v_actor := public.sarraf_require_admin(false);

  if p_command_key !~ '^debt-reminder:[A-Za-z0-9:_-]{8,200}$' then
    raise exception using errcode='22023', message='invalid reminder command';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key, 0));
  v_prev := public.sarraf_command_replay(v_actor.auth_id, p_command_key, 'remind_debtor');
  if v_prev is not null then return v_prev; end if;

  select * into v_debt from public.debts where id = p_debt_id;
  if not found then raise exception using errcode='P0002', message='ئەو قەرزە نەدۆزرایەوە'; end if;

  -- Only a live debt, and only one somebody else owes. Reminding a person of a debt that is
  -- settled, forgiven or void is telling them something untrue; reminding them of a debt the
  -- business owes THEM is telling them the opposite of the truth.
  if v_debt.status in ('settled','written_off','void') then
    raise exception using errcode='23514',
      message=format('ئەم قەرزە پێشتر %s بووە — ناتوانرێت بیرخستنەوەی بۆ بنێردرێت', v_debt.status);
  end if;
  if v_debt.debtor_type = 'zeman' then
    raise exception using errcode='22023',
      message='ئەم قەرزە هی ئێمەیە — ناتوانین بیرخستنەوەی قەرز بۆ کەسێک بنێرین کە خۆمان قەرزاری ئەوین';
  end if;
  if v_debt.debtor_id is null then
    raise exception using errcode='22023', message='ئەم قەرزە هیچ کەسێکی ناودار نییە';
  end if;

  select id, name into v_recipient, v_name from public.app_users
   where id = v_debt.debtor_id and not deleted;
  if v_recipient is null then
    raise exception using errcode='22023',
      message='ئەو کەسە لەم سیستەمەدا هەژماری نییە، بۆیە بیرخستنەوەکە بەدەستی ناگات';
  end if;

  v_id := 'zn-' || md5(p_command_key || ':' || v_debt.id);
  insert into public.zeman_notifications(id, recipient_id, kind, title, body,
                                         subject_kind, subject_id, actor_id)
  values (v_id, v_recipient, 'debt_reminder',
          left(format('قەرزی %s %s', trim(to_char(v_debt.outstanding_principal,'FM999999999990.00')),
                      v_debt.currency), 200),
          left(coalesce(nullif(btrim(coalesce(p_note,'')),''),
                        format('بڕی %s %s ماوە لەسەر: %s',
                               trim(to_char(v_debt.outstanding_principal,'FM999999999990.00')),
                               v_debt.currency, v_debt.reason)), 700),
          'debt', v_debt.id, v_actor.id);

  perform public.sarraf_write_audit(v_actor.id, 'بیرخستنەوەی قەرز',
    left(format('%s — %s %s', coalesce(v_name, v_recipient),
                trim(to_char(v_debt.outstanding_principal,'FM999999999990.00')),
                v_debt.currency), 700));

  v_result := jsonb_build_object('notification_id', v_id, 'debt_id', v_debt.id,
    'recipient_id', v_recipient, 'currency', v_debt.currency,
    'outstanding', v_debt.outstanding_principal, 'replayed', false);
  return public.sarraf_store_command(v_actor.auth_id, p_command_key, 'remind_debtor', v_result);
end;
$$;

comment on function public.sarraf_remind_debtor(text,text,text) is
  'بیرخستنەوەیەک بۆ ئەو کەسەی قەرزارە، بە بڕی ماوە — تەنها بۆ قەرزێکی کراوە کە کەسێکی تر قەرزاری بێت.';

revoke all on function public.sarraf_remind_debtor(text,text,text) from public, anon;
grant execute on function public.sarraf_remind_debtor(text,text,text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_remind_debtor(text,text,text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
