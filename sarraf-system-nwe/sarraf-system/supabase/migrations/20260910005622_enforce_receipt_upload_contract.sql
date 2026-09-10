-- Recovery Batch 3: one upload is at most twenty images, declares one platform, and keeps
-- one immutable membership. Historical batches stay readable; every new ingestion command
-- must satisfy the stricter contract at the API and again in this database function.
begin;

alter table public.receipt_batches add column if not exists platform text;

-- Backfill only when the historical evidence already states one unambiguous supported platform.
with one_platform as (
  select batch_id, min(lower(platform)) platform
  from public.receipts
  where lower(platform) in ('alipay','wechat')
  group by batch_id
  having count(distinct lower(platform)) = 1
)
update public.receipt_batches b
set platform = p.platform
from one_platform p
where b.id = p.batch_id and b.platform is null;

alter table public.receipt_batches drop constraint if exists receipt_batches_upload_count_g1;
alter table public.receipt_batches add constraint receipt_batches_upload_count_g1
  check (n between 0 and 20) not valid;
alter table public.receipt_batches validate constraint receipt_batches_upload_count_g1;

alter table public.receipt_batches drop constraint if exists receipt_batches_platform_g1;
alter table public.receipt_batches add constraint receipt_batches_platform_g1
  check (platform is null or platform in ('alipay','wechat')) not valid;
alter table public.receipt_batches validate constraint receipt_batches_platform_g1;

create or replace function public.sarraf_keep_receipt_group_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.batch_id is distinct from new.batch_id then
    raise exception using errcode='23514', message='receipt upload group is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.sarraf_keep_receipt_group_immutable() from public, anon, authenticated;

drop trigger if exists receipt_intake_group_immutable_g1 on public.receipt_intake_items;
create trigger receipt_intake_group_immutable_g1
before update of batch_id on public.receipt_intake_items
for each row execute function public.sarraf_keep_receipt_group_immutable();

drop trigger if exists receipt_group_immutable_g1 on public.receipts;
create trigger receipt_group_immutable_g1
before update of batch_id on public.receipts
for each row execute function public.sarraf_keep_receipt_group_immutable();

create or replace function public.sarraf_limit_receipt_group_membership()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_batch_platform text;
begin
  select platform into v_batch_platform
  from public.receipt_batches
  where id = new.batch_id
  for update;
  if not found then
    raise exception using errcode='23503', message='receipt upload group does not exist';
  end if;
  if (select count(*) from public.receipt_intake_items where batch_id = new.batch_id) >= 20 then
    raise exception using errcode='23514', message='receipt upload group cannot exceed twenty images';
  end if;
  return new;
end;
$$;
revoke all on function public.sarraf_limit_receipt_group_membership() from public, anon, authenticated;

drop trigger if exists receipt_intake_group_limit_g1 on public.receipt_intake_items;
create trigger receipt_intake_group_limit_g1
before insert on public.receipt_intake_items
for each row execute function public.sarraf_limit_receipt_group_membership();

create or replace function public.sarraf_enforce_receipt_group_platform()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_platform text;
begin
  select platform into v_platform from public.receipt_batches where id = new.batch_id;
  if v_platform is not null and lower(coalesce(new.platform,'')) <> v_platform then
    raise exception using errcode='23514', message='receipt platform differs from its upload group';
  end if;
  if v_platform is not null then new.platform := v_platform; end if;
  return new;
end;
$$;
revoke all on function public.sarraf_enforce_receipt_group_platform() from public, anon, authenticated;

drop trigger if exists receipt_group_platform_g1 on public.receipts;
create trigger receipt_group_platform_g1
before insert or update of platform on public.receipts
for each row execute function public.sarraf_enforce_receipt_group_platform();

create or replace function public.sarraf_keep_batch_platform_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.platform is not null and new.platform is distinct from old.platform then
    raise exception using errcode='23514', message='receipt upload platform is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.sarraf_keep_batch_platform_immutable() from public, anon, authenticated;

drop trigger if exists receipt_batch_platform_immutable_g1 on public.receipt_batches;
create trigger receipt_batch_platform_immutable_g1
before update of platform on public.receipt_batches
for each row execute function public.sarraf_keep_batch_platform_immutable();

do $patch$
declare v_src text; v_new text;
begin
  select pg_get_functiondef('public.sarraf_ingest_receipt_batch(jsonb,jsonb,text)'::regprocedure) into v_src;
  if position('receipt upload contract v1' in v_src) > 0 then return; end if;

  v_new := replace(v_src,
    $old$  v_currency text := upper(coalesce(nullif(btrim(p_batch->>'currency'),''),'UNKNOWN'));
  v_count int;$old$,
    $new$  v_currency text := upper(coalesce(nullif(btrim(p_batch->>'currency'),''),'UNKNOWN'));
  -- receipt upload contract v1
  v_platform text := lower(nullif(btrim(p_batch->>'platform'),''));
  v_count int;$new$);
  if v_new = v_src then raise exception 'receipt platform declaration was not added'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$  if (p_batch->>'direction') not in ('in','out','buy','sell') or v_currency !~ '^[A-Z]{3,8}$' then
    raise exception using errcode='22023', message='invalid batch metadata';
  end if;$old$,
    $new$  if (p_batch->>'direction') not in ('in','out','buy','sell') or v_currency !~ '^[A-Z]{3,8}$'
     or v_platform not in ('alipay','wechat') then
    raise exception using errcode='22023', message='invalid batch metadata';
  end if;$new$);
  if v_new = v_src then raise exception 'receipt batch metadata gate was not found'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    'if v_count < 1 or v_count > 25 then raise exception using errcode=''22023'', message=''invalid receipt count''; end if;',
    'if v_count < 1 or v_count > 20 then raise exception using errcode=''22023'', message=''invalid receipt count''; end if;');
  if v_new = v_src then raise exception 'receipt count gate was not found'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$    if (r->>'id') !~ '^[A-Za-z0-9-]{6,128}$' or r->>'batch_id' <> v_batch_id then
      raise exception using errcode='22023', message='invalid receipt identity';
    end if;
    v_path := r->>'image_path';$old$,
    $new$    if (r->>'id') !~ '^[A-Za-z0-9-]{6,128}$' or r->>'batch_id' <> v_batch_id then
      raise exception using errcode='22023', message='invalid receipt identity';
    end if;
    if lower(coalesce(r->>'platform','')) <> v_platform then
      raise exception using errcode='22023', message='receipt platform differs from its upload group';
    end if;
    v_path := r->>'image_path';$new$);
  if v_new = v_src then raise exception 'per-receipt platform gate was not found'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$    id,customer_id,customer_name,partner_id,direction,status,currency,total_gross,total_fee,total_net,n,dup_n,rejected_n,uploaded_by,source,receipt_stage
  ) values ($old$,
    $new$    id,customer_id,customer_name,partner_id,direction,status,currency,total_gross,total_fee,total_net,n,dup_n,rejected_n,uploaded_by,source,receipt_stage,platform
  ) values ($new$);
  if v_new = v_src then raise exception 'receipt batch insert columns were not found'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$    v_partner_id,p_batch->>'direction','new',v_currency,0,0,0,v_count,0,0,v_actor.id,left(coalesce(p_batch->>'source','app'),30),'reading'
  );$old$,
    $new$    v_partner_id,p_batch->>'direction','new',v_currency,0,0,0,v_count,0,0,v_actor.id,left(coalesce(p_batch->>'source','app'),30),'reading',v_platform
  );$new$);
  if v_new = v_src then raise exception 'receipt batch insert values were not found'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$left(r->>'platform',60),v_net,v_row_currency$old$,
    $new$v_platform,v_net,v_row_currency$new$);
  if v_new = v_src then raise exception 'receipt platform insert was not found'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$'source',left(coalesce(p_batch->>'source','app'),30)))$old$,
    $new$'source',left(coalesce(p_batch->>'source','app'),30),'platform',v_platform))$new$);
  if v_new = v_src then raise exception 'receipt audit platform was not added'; end if;

  execute v_new;
end;
$patch$;

commit;
