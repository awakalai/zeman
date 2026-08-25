-- One business changing its rate changed the other's.
--
-- currencies holds id, code, name, symbol and dec — what a currency *is*, which is shared and
-- should be — and also rate, buy_rate and sell_rate, which are what one exchange thinks a yuan
-- is worth today. Those are not shared. They are the number every total on a screen is computed
-- from, and letting the buyer in one city set the figure the buyer in another values their
-- inventory by is the plainest leak in the system: not a row somebody might notice, but every
-- amount they look at, quietly wrong.
--
-- tenant_rates was built for this and half-wired. sarraf_usd_value already reads it before
-- falling back to currencies, so the accounting has been per-business since it landed. What was
-- never moved is the save command and the list the interface reads: sarraf_save_rates still
-- writes the shared row, and the application selects straight from currencies. So the screens,
-- the pricing shown to a customer, and the rate anybody actually types were all installation-wide.
--
-- Three things here. tenant_rates learns the spread. The save command writes the caller's
-- business rather than everybody's. And there is one function the interface reads instead of the
-- table, which returns the catalogue with the caller's own rates applied — so a business that has
-- set nothing still sees the installation's figures, and today's single business is unchanged.
begin;

-- ── the spread belongs to the business too ──────────────────────────────────
--
-- Only `rate` was here, because sarraf_usd_value is the only reader that existed when this table
-- was written and one ratio is all it needs. The interface quotes a buy and a sell.
alter table public.tenant_rates add column if not exists buy_rate  numeric(20,8);
alter table public.tenant_rates add column if not exists sell_rate numeric(20,8);

do $ck$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_rates_spread_positive') then
    alter table public.tenant_rates add constraint tenant_rates_spread_positive
      check ((buy_rate is null or buy_rate > 0) and (sell_rate is null or sell_rate > 0));
  end if;
end
$ck$;

comment on column public.tenant_rates.buy_rate is
  'What this business pays for the currency. Null means it quotes no spread and uses rate.';
comment on column public.tenant_rates.sell_rate is
  'What this business charges for the currency. Null means it quotes no spread and uses rate.';

-- ── what the interface should read ──────────────────────────────────────────
--
-- The catalogue, with the caller's own rates where they have set any and the installation's
-- where they have not. One function, so that the fallback is written once and no screen can be
-- the one that forgot it.
--
-- `own_rate` says which it is. A business looking at a figure it did not set should be able to
-- tell, rather than discovering it the first time the number moves under them.
create or replace function public.sarraf_currencies()
returns table (
  -- "dec" is quoted because DEC is reserved in SQL as short for DECIMAL; unquoted it is a
  -- syntax error in a returns-table list, which is where this failed.
  id text, code text, name text, symbol text, "dec" integer, external boolean,
  rate numeric, buy_rate numeric, sell_rate numeric,
  rate_updated timestamptz, own_rate boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.id, c.code, c.name, c.symbol, c."dec", c.external,
         coalesce(t.rate, c.rate)             as rate,
         coalesce(t.buy_rate, c.buy_rate)     as buy_rate,
         coalesce(t.sell_rate, c.sell_rate)   as sell_rate,
         coalesce(t.updated_at, c.rate_updated) as rate_updated,
         t.tenant_id is not null              as own_rate
    from public.currencies c
    left join public.tenant_rates t
      on t.cur_id = c.id and t.tenant_id = public.sarraf_tenant()
   order by c.code;
$$;

comment on function public.sarraf_currencies() is
  'The currency list as one business sees it: its own rates where set, the installation''s where not.';

revoke all on function public.sarraf_currencies() from public, anon;
grant execute on function public.sarraf_currencies() to authenticated;

-- ── saving a rate saves it for one business ─────────────────────────────────
--
-- Everything about the command stays: the same idempotency, the same refusals, the same history.
-- What changes is the row it lands on. An administrator inside a business writes tenant_rates
-- for that business. The manager, who belongs to none, writes the installation's own figures in
-- currencies — the defaults a business inherits until it sets its own.
-- Dropped first, not replaced. The installed function carries parameter defaults and `create or
-- replace` cannot take them away — `cannot remove parameter defaults from existing function`,
-- the same refusal this repository hit once before for the same reason. The grants go back
-- below, because dropping takes them with it.
drop function if exists public.sarraf_save_rates(jsonb,jsonb,text,text,text);

create function public.sarraf_save_rates(
  p_rows jsonb, p_history jsonb, p_command_key text, p_action text, p_detail text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users; v_replay jsonb; v_result jsonb; x jsonb;
  v_id text; v_rate numeric; v_buy numeric; v_sell numeric; v_n int := 0;
  v_tenant text;
begin
  v_actor := public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('save_rates');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text || ':' || p_command_key, 0));
  v_replay := public.sarraf_command_replay(v_actor.auth_id, p_command_key, 'save_rates');
  if v_replay is not null then return v_replay; end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception using errcode = '22023', message = 'invalid rates payload';
  end if;

  v_tenant := v_actor.tenant_id;

  for x in select value from jsonb_array_elements(p_rows) loop
    v_id   := nullif(btrim(x->>'id'), '');
    v_rate := nullif(btrim(coalesce(x->>'rate', '')), '')::numeric;
    v_buy  := nullif(btrim(coalesce(x->>'buy_rate', '')), '')::numeric;
    v_sell := nullif(btrim(coalesce(x->>'sell_rate', '')), '')::numeric;

    -- An older payload that carries only a spread still means one ratio: the midpoint is the
    -- single number the rest of the system reads, and refusing such a payload outright would
    -- strand any caller that has not been updated.
    if v_rate is null and v_buy is not null and v_sell is not null then
      v_rate := (v_buy + v_sell) / 2;
    elsif v_rate is null then
      v_rate := coalesce(v_buy, v_sell);
    end if;

    if not exists (select 1 from public.currencies where id = v_id) then
      raise exception using errcode = '22023', message = 'invalid currency rate';
    end if;
    -- Zero and negative are refused here rather than dividing the whole system by them later.
    if v_rate is null or v_rate <= 0
       or (v_buy is not null and v_buy <= 0) or (v_sell is not null and v_sell <= 0) then
      raise exception using errcode = '22023', message = 'invalid currency rate';
    end if;

    if v_tenant is null then
      -- The manager belongs to no business. What they set is the installation's default, which
      -- a business reads until it has a figure of its own.
      update public.currencies
         set rate = v_rate,
             buy_rate = coalesce(v_buy, buy_rate),
             sell_rate = coalesce(v_sell, sell_rate),
             rate_updated = statement_timestamp()
       where id = v_id;
    else
      -- coalesce against the row already there, not against the shared one: a save that says
      -- nothing about the spread must leave this business's spread alone, and must not quietly
      -- adopt the installation's.
      insert into public.tenant_rates(tenant_id, cur_id, rate, buy_rate, sell_rate, updated_by)
      values (v_tenant, v_id, v_rate, v_buy, v_sell, v_actor.id)
      on conflict (tenant_id, cur_id) do update
        set rate = excluded.rate,
            buy_rate = coalesce(excluded.buy_rate, public.tenant_rates.buy_rate),
            sell_rate = coalesce(excluded.sell_rate, public.tenant_rates.sell_rate),
            updated_at = statement_timestamp(),
            updated_by = excluded.updated_by;
    end if;

    insert into public.rate_history(id, cur_id, rate, buy_rate, sell_rate, changed_by, command_key)
    values ('rate-' || md5(v_id || ':' || p_command_key), v_id, v_rate, v_buy, v_sell,
            v_actor.id, p_command_key)
    on conflict (id) do nothing;
    v_n := v_n + 1;
  end loop;

  -- The rows the interface hands over as history, kept for the ids it generated. Ignored where
  -- a row names no currency, because a history line that cannot say what it is about is noise.
  if jsonb_typeof(p_history) = 'array' then
    for x in select value from jsonb_array_elements(p_history) loop
      if nullif(btrim(coalesce(x->>'cur_id', '')), '') is not null then
        insert into public.rate_history(id, cur_id, rate, changed_by, command_key)
        values (coalesce(nullif(btrim(x->>'id'), ''), gen_random_uuid()::text),
                x->>'cur_id',
                nullif(btrim(coalesce(x->>'rate', '')), '')::numeric,
                nullif(btrim(coalesce(x->>'changed_by', '')), ''),
                p_command_key)
        on conflict (id) do nothing;
      end if;
    end loop;
  end if;

  perform public.sarraf_write_audit(v_actor.id, p_action, p_detail);
  v_result := jsonb_build_object('ok', true, 'updated', v_n,
                                 'scope', coalesce(v_tenant, 'installation'));
  return public.sarraf_store_command(v_actor.auth_id, p_command_key, 'save_rates', v_result);
end;
$$;

revoke all on function public.sarraf_save_rates(jsonb,jsonb,text,text,text) from public, anon;
grant execute on function public.sarraf_save_rates(jsonb,jsonb,text,text,text) to authenticated;

-- The function must belong to the role that cannot bypass row-level security, like the 131 that
-- were moved in 202608250001. Created here as postgres, it would otherwise arrive able to write
-- across businesses — the exact thing being fixed, reintroduced by the fix for it.
do $own$
begin
  if exists (select 1 from pg_roles where rolname = 'sarraf_definer') then
    execute 'grant create on schema public to sarraf_definer';
    execute 'alter function public.sarraf_save_rates(jsonb,jsonb,text,text,text) owner to sarraf_definer';
    execute 'alter function public.sarraf_currencies() owner to sarraf_definer';
    execute 'revoke create on schema public from sarraf_definer';
  end if;
end
$own$;

commit;
