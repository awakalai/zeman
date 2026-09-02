-- ملی: پارە دەچێتە شوێنێکی ناودار
--
-- «حسابەکان خۆم داخڵی بکەم وەک چۆنە پارەی تر داخڵ ئەکەم. بۆ نموونە (داخڵکردنی حساب) ناوێکی بۆ
--  دادەنێم (کی کارد، ئێف ئایبی، هتد).»
--
-- «لە قاسەدا دەبێت پارەی جیاوازیش هەبێت نەک تەنها کاش. دەبێت ئەو پارانەش بوونیان هەبێت کە لە
--  حساب بانکییەکانمە. واتا قاسەی گشتی وەک ئێستا بێت هەر بەس بەشێکی تری بۆ زیادببێت
--  (پارەی کاش)(پارەی ناو حسابەکانت).»
--
-- The ledger has carried cash_account_id since 202609010011 and the read model has reported
-- cash and accounts separately since 202609010014. What was missing is the way in: every
-- manual money movement went to the cash and nowhere else, because sarraf_post_ledger_command
-- never read the column. So an account could only ever be filled by a trade, never by the
-- owner saying «ئەم پارەیە لە کی کاردەوە هاتووە».
--
-- ── A balance check that was already wrong, and is about to matter ────────────────────────────
--
-- sarraf_locked_cash_balance(cur, partner) sums every ledger row with that partner_id. When
-- nothing had ever named an account or an office that was the cashbox exactly, which is why it
-- has been correct until now. The moment an account holds money, "the cash" would silently
-- include it, and a withdrawal from the cash could be approved against dinars sitting in a bank.
--
-- sarraf_locked_holding_balance names the holding instead of assuming it: cash is the rows that
-- name no partner, no office and no account, and an account is the rows that name it. On today's
-- data the two functions return the same number for every currency — the difference only appears
-- once this migration's own feature is used. The old function is left in place untouched for the
-- partner-transfer path, which is about partners and not about places.

begin;

create or replace function public.sarraf_locked_holding_balance(
  p_cur_id text, p_cash_account_id text default null
) returns numeric
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_balance numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'zeman:holding:'||coalesce(p_cash_account_id,'cash')||':'||p_cur_id, 0));
  select coalesce(sum(amount),0) into v_balance from public.ledger
   where cur_id = p_cur_id
     and partner_id is null and office_id is null
     and cash_account_id is not distinct from p_cash_account_id;
  return v_balance;
end;
$$;

comment on function public.sarraf_locked_holding_balance(text,text) is
  'باڵانسی یەک شوێن بە دیاریکراوی — کاش، یان حسابێکی ناودار — لەژێر قوفڵ.';

revoke all on function public.sarraf_locked_holding_balance(text,text) from public,anon,authenticated;

-- ── The way in ───────────────────────────────────────────────────────────────────────────────
--
-- One new field on a ledger row, cash_account_id, honoured on the four single-row movements a
-- person makes by hand. A row that does not name one behaves exactly as it did before, so every
-- existing caller, every queued approval and every replayed command is unaffected.
--
-- A partner transfer still may not name an account: it is a movement between the business and a
-- partner, and giving it a second dimension would let one command mean four different things.
create or replace function public.sarraf_post_ledger_command(
  p_ledger jsonb,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype; v_replay jsonb; v_result jsonb; x jsonb;
  v_max_usd numeric:=0; v_amount numeric; v_cur text; v_id text; v_date timestamptz;
  v_partner text; v_investor text; v_owner text; v_type text; v_rows jsonb:='[]'::jsonb;
  v_count integer;v_main_delta numeric;v_partner_delta numeric;v_balance numeric;
  v_investor_balance numeric;v_distinct_ids integer;v_cur_max text;
  v_account text; v_account_name text;
begin
  v_actor:=public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('post_ledger');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'post_ledger');
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_ledger)<>'array' or jsonb_array_length(p_ledger) not between 1 and 50 then
    raise exception using errcode='22023',message='ledger command must contain 1 to 50 rows';
  end if;
  v_count:=jsonb_array_length(p_ledger);
  for x in select value from jsonb_array_elements(p_ledger) loop
    v_amount:=nullif(x->>'amount','')::numeric; v_cur:=nullif(btrim(x->>'cur_id'),'');
    if v_amount is null or v_amount=0 or not exists(select 1 from public.currencies where id=v_cur) then
      raise exception using errcode='22023',message='invalid ledger row';
    end if;
    v_date:=coalesce(nullif(x->>'date','')::timestamptz,statement_timestamp());
    perform public.sarraf_assert_period_open(v_date);
    v_max_usd:=greatest(v_max_usd,coalesce(abs(public.sarraf_usd_value_at(v_amount,v_cur,'mid',null)),0));
  end loop;

  -- This endpoint has only three valid intents: one capital movement, one expense/payout, or
  -- one balanced main↔partner transfer.  It is not a generic browser escape hatch into ledger.
  if v_count=1 then
    x:=p_ledger->0;v_type:=nullif(btrim(x->>'type'),'');v_amount:=(x->>'amount')::numeric;
    v_cur:=nullif(btrim(x->>'cur_id'),'');v_owner:=nullif(btrim(x->>'owner'),'');
    v_investor:=nullif(btrim(x->>'investor_id'),'');v_partner:=nullif(btrim(x->>'partner_id'),'');
    v_account:=nullif(btrim(x->>'cash_account_id'),'');
    if nullif(btrim(x->>'tx_id'),'') is not null or v_partner is not null then
      raise exception using errcode='22023',message='manual ledger rows cannot name a transaction or custody partner';
    elsif v_type in ('deposit','withdraw') then
      if (v_type='deposit' and v_amount<=0) or (v_type='withdraw' and v_amount>=0)
         or v_owner not in ('self','investor')
         or (v_owner='self' and v_investor is not null)
         or (v_owner='investor' and (v_investor is null or not exists(
           select 1 from public.app_users where id=v_investor and role='investor' and not deleted))) then
        raise exception using errcode='22023',message='invalid capital movement';end if;
    elsif v_type='expense' then
      if v_amount>=0 or v_owner is not null or v_investor is not null then
        raise exception using errcode='22023',message='invalid expense movement';end if;
    elsif v_type='investor_payout' then
      if v_amount>=0 or v_owner is not null or v_investor is null or not exists(
        select 1 from public.app_users where id=v_investor and role='investor' and not deleted) then
        raise exception using errcode='22023',message='invalid investor payout';end if;
    else
      raise exception using errcode='22023',message='unsupported manual ledger movement';
    end if;

    -- A named place must be this business's own and still open. Reading the name here also
    -- gives the audit line something a person recognises.
    if v_account is not null then
      select name into v_account_name from public.cash_accounts
       where id=v_account and active and tenant_id=public.sarraf_tenant();
      if v_account_name is null then
        raise exception using errcode='22023',message='ئەو حسابەی ناوت بردووە نەدۆزرایەوە';
      end if;
      if not exists(select 1 from public.cash_accounts where id=v_account and cur_id=v_cur) then
        raise exception using errcode='22023',message='ئەو حسابە بەم دراوە نییە';
      end if;
    end if;

    -- The place named is the place checked. Money cannot leave the cash because an account
    -- holds it, and cannot leave an account because the cash holds it.
    v_balance:=public.sarraf_locked_holding_balance(v_cur,v_account);
    if v_amount<0 and v_balance+v_amount<0 then
      raise exception using errcode='23514',
        message=case when v_account is null then 'main cashbox has insufficient balance'
                     else format('%s ی تێدا نییە', coalesce(v_account_name,'ئەو حسابە')) end;end if;
    if v_type='withdraw' and v_owner='investor' then
      perform pg_advisory_xact_lock(hashtextextended('zeman:investor-capital:'||v_investor||':'||v_cur,0));
      select coalesce(sum(amount),0) into v_investor_balance from public.ledger
       where cur_id=v_cur and owner='investor' and investor_id=v_investor
         and type in ('deposit','withdraw');
      if v_investor_balance+v_amount<0 then
        raise exception using errcode='23514',message='investor capital cannot become negative';end if;
    end if;
  elsif v_count=2 then
    if exists(select 1 from jsonb_array_elements(p_ledger) e
               where nullif(btrim(e->>'cash_account_id'),'') is not null) then
      raise exception using errcode='22023',message='a partner transfer moves money between the business and a partner, not between places';
    end if;
    select min(nullif(btrim(e->>'cur_id'),'')),max(nullif(btrim(e->>'cur_id'),'')),
           max(nullif(btrim(e->>'partner_id'),'')),
           coalesce(sum((e->>'amount')::numeric) filter(where nullif(btrim(e->>'partner_id'),'') is null),0),
           coalesce(sum((e->>'amount')::numeric) filter(where nullif(btrim(e->>'partner_id'),'') is not null),0),
           count(distinct nullif(btrim(e->>'id'),''))
      into v_cur,v_cur_max,v_partner,v_main_delta,v_partner_delta,v_distinct_ids
      from jsonb_array_elements(p_ledger) e;
    if v_cur is distinct from v_cur_max or v_partner is null or v_distinct_ids<>2
       or abs(v_main_delta+v_partner_delta)>0.0000000001
       or v_main_delta=0 or v_partner_delta=0
       or exists(select 1 from jsonb_array_elements(p_ledger) e
          where e->>'type'<>'transfer'
             or nullif(btrim(e->>'owner'),'') is not null
             or nullif(btrim(e->>'investor_id'),'') is not null
             or nullif(btrim(e->>'tx_id'),'') is not null)
       or (select count(*) from jsonb_array_elements(p_ledger) e
            where nullif(btrim(e->>'partner_id'),'') is null)<>1
       or not exists(select 1 from public.app_users where id=v_partner and role='partner' and not deleted) then
      raise exception using errcode='22023',message='partner transfer must be one exact balanced pair';end if;
    -- Main is always locked first, then the partner, in both transfer directions.
    v_balance:=public.sarraf_locked_holding_balance(v_cur,null);
    v_investor_balance:=public.sarraf_locked_cash_balance(v_cur,v_partner);
    if v_balance+v_main_delta<0 or v_investor_balance+v_partner_delta<0 then
      raise exception using errcode='23514',message='transfer source has insufficient balance';end if;
  else
    raise exception using errcode='22023',message='manual ledger command shape is not supported';
  end if;

  if public.sarraf_requires_approval('post_ledger',v_max_usd,false) then
    return public.sarraf_queue_approval('post_ledger',null,
      jsonb_build_object('p_ledger',p_ledger,'p_command_key',p_command_key,'p_action',p_action,'p_detail',p_detail),
      v_max_usd,p_detail,p_command_key);
  end if;

  for x in select value from jsonb_array_elements(p_ledger) loop
    v_id:=nullif(btrim(x->>'id'),''); v_type:=nullif(btrim(x->>'type'),'');
    v_cur:=nullif(btrim(x->>'cur_id'),''); v_amount:=(x->>'amount')::numeric;
    v_date:=coalesce(nullif(x->>'date','')::timestamptz,statement_timestamp());
    v_partner:=nullif(btrim(x->>'partner_id'),''); v_investor:=nullif(btrim(x->>'investor_id'),'');
    v_owner:=nullif(btrim(x->>'owner'),''); v_account:=nullif(btrim(x->>'cash_account_id'),'');
    perform public.sarraf_assert_period_open(v_date);
    if v_id is null or v_type is null then raise exception using errcode='22023',message='ledger identity is required'; end if;
    if v_partner is not null and not exists(select 1 from public.app_users where id=v_partner and role='partner' and not deleted) then
      raise exception using errcode='22023',message='invalid partner ledger row'; end if;
    if v_investor is not null and not exists(select 1 from public.app_users where id=v_investor and role='investor' and not deleted) then
      raise exception using errcode='22023',message='invalid investor ledger row'; end if;
    insert into public.ledger(id,type,owner,investor_id,cur_id,amount,partner_id,cash_account_id,tx_id,note,date,
      command_key,created_by,commission_rate_snapshot,commission_amount_snapshot)
    values(v_id,v_type,v_owner,v_investor,v_cur,v_amount,v_partner,v_account,nullif(x->>'tx_id',''),
      left(x->>'note',1000),v_date,p_command_key,v_actor.id,null,null);
    v_rows:=v_rows||to_jsonb(v_id);
  end loop;
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'ledger_ids',v_rows);
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'post_ledger',v_result);
end;
$$;

revoke all on function public.sarraf_post_ledger_command(jsonb,text,text,text) from public,anon;
grant execute on function public.sarraf_post_ledger_command(jsonb,text,text,text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_locked_holding_balance(text,text) owner to sarraf_definer;
alter function public.sarraf_post_ledger_command(jsonb,text,text,text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
