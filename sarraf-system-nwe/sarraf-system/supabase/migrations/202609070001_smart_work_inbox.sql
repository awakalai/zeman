-- Smart Work Inbox: the same bounded read model for owners and operational staff.
-- The action is navigation only; financial mutations still require their command RPCs.
begin;

create or replace function public.sarraf_action_inbox_v3(p_limit integer default 80)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 80), 1), 100);
  v_items jsonb := '[]'::jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin', 'office') then
    raise exception using errcode = '42501', message = 'operations are not authorized';
  end if;

  if v_actor.role = 'admin' then
    return public.sarraf_action_inbox_v2(v_limit);
  end if;

  with inbox as (
    select 'receipt_review'::text kind,
      case when coalesce(b.rejected_n, 0) > 0 or b.receipt_stage = 'needs_review' then 'high' else 'medium' end priority,
      'Receipt batch needs review'::text title,
      concat_ws(' · ', b.currency, coalesce(b.n, 0)::text || ' receipt(s)', replace(b.receipt_stage, '_', ' ')) detail,
      b.created_at, '#/receipts'::text path, b.id focus
    from public.receipt_batches b
    where b.tx_id is null and b.receipt_stage in ('received', 'reading', 'needs_review', 'verified')

    union all

    select 'pending_transaction', case when t.date < statement_timestamp() - interval '72 hours' then 'high' else 'medium' end,
      'Pending transaction', concat_ws(' · ', 'Order ' || coalesce(t.code::text, '—'), c.code, t.amount::text),
      t.date, '#/txs', null
    from public.txs t join public.currencies c on c.id = t.cur_id
    where not t.deleted and t.status = 'pending'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', i.kind, 'priority', i.priority, 'title', i.title, 'detail', i.detail,
    'created_at', i.created_at, 'path', i.path, 'focus', i.focus,
    'action', jsonb_build_object('kind', 'navigation', 'path', i.path)
  ) order by case i.priority when 'critical' then 0 when 'high' then 1 else 2 end, i.created_at), '[]'::jsonb)
    into v_items
    from (select * from inbox order by created_at limit v_limit) i;

  return jsonb_build_object('generated_at', statement_timestamp(), 'total', jsonb_array_length(v_items),
    'counts', (select coalesce(jsonb_object_agg(kind, total), '{}'::jsonb) from (
      select value->>'kind' kind, count(*) total from jsonb_array_elements(v_items) group by value->>'kind'
    ) grouped), 'items', v_items);
end;
$$;

revoke all on function public.sarraf_action_inbox_v3(integer) from public, anon;
grant execute on function public.sarraf_action_inbox_v3(integer) to authenticated;
comment on function public.sarraf_action_inbox_v3(integer) is
  'Bounded owner/staff read queue. Returned actions are navigation only; mutations use command RPCs.';
commit;
