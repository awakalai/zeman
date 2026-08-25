-- What the live database actually contains.
--
-- Read-only. The workflow that runs this opens the transaction with `set transaction read only`,
-- so the server refuses any write here rather than trusting that none was written.
--
-- The question this exists to answer: which migrations has this database already had? They were
-- applied by hand, one at a time, over a fortnight, and nothing recorded which. Re-running one
-- that has already been applied is not harmless — six of them add table constraints, and
-- PostgreSQL has no `add constraint if not exists`, so a second attempt fails outright.
--
-- So each migration is asked about by the thing it creates. An object that exists is a migration
-- that ran.

\pset format aligned
\pset border 2
\pset null '—'

\echo ''
\echo '════════ 1. Constraints — the six migrations that cannot be re-run ════════'
\echo ''

with expected(constraint_name, migration) as (values
  ('receipt_batches_stage_a3',           '202608100002_receipt_matching'),
  ('receipt_batches_match_score_a3',     '202608100002_receipt_matching'),
  ('receipt_batches_stage_f2',           '202608100006_receipt_review_policy'),
  ('receipt_batches_decision_f2',        '202608100006_receipt_review_policy'),
  ('receipt_audit_events_event_type_f2', '202608100006_receipt_review_policy'),
  ('receipt_documents_rate_snapshot_ck', '202608140001_canonical_receipt_lifecycle'),
  ('currencies_rate_positive',           '202608140004_single_currency_ratio'),
  ('txs_business_flow_ck',               '202608180001_transaction_business_flows'),
  ('txs_direct_role_ck',                 '202608180001_transaction_business_flows'),
  ('customer_vaults_pending_positive',   '202608180008_rate_limit_and_pending')
)
select e.migration,
       e.constraint_name,
       case when c.conname is null then 'MISSING — migration has not run'
            else 'present — migration has run' end as state
  from expected e
  left join pg_constraint c on c.conname = e.constraint_name
 order by e.migration, e.constraint_name;

\echo ''
\echo '════════ 2. Tables, by the migration that creates them ════════'
\echo ''

with expected(obj, migration) as (values
  ('public.journal_entries',                 '202608120001_double_entry_core'),
  ('public.debts',                           '202608120002_cashbox_and_debt'),
  ('public.partner_accounts',                '202608120004_partner_and_office'),
  ('public.receipt_state_transitions',       '202608120005_receipt_state_machine'),
  ('public.chart_of_accounts',               '202608120006_transaction_journal'),
  ('public.receipt_documents',               '202608120007_receipt_intake_commands'),
  ('public.receipt_forwardings',             '202608120008_receipt_forwarding'),
  ('public.receipt_transaction_assignments', '202608140001_canonical_receipt_lifecycle'),
  ('public.vouchers',                        '202608170001_debt_register'),
  ('public.financial_commands',              '202608180002_core_command_contracts'),
  ('public.ocr_attestations',                '202608180007_ocr_attestation'),
  ('public.rate_limit_counters',             '202608180008_rate_limit_and_pending'),
  ('public.tenants',                         '202608240001_tenants'),
  ('public.tenant_rates',                    '202608240005_tenant_rates'),
  ('public.schema_migrations',               'the migration workflow itself')
)
select e.migration,
       e.obj as table_name,
       case when to_regclass(e.obj) is null then 'MISSING' else 'present' end as state
  from expected e
 order by e.migration;

\echo ''
\echo '════════ 3. Columns added by the later migrations ════════'
\echo ''

with expected(tbl, col, migration) as (values
  ('audit',     'user_id',     '202608200001_production_schema_alignment'),
  ('receipts',  'tx_date',     '202608200001 — must be type date, not text'),
  ('receipts',  'document_id', '202608220001_link_receipt_to_document'),
  ('app_users', 'admin_level', '202608230001_manager_role'),
  ('app_users', 'tenant_id',   '202608240001_tenants'),
  ('receipts',  'tenant_id',   '202608240002_tenant_columns'),
  ('txs',       'tenant_id',   '202608240002_tenant_columns')
)
select e.migration, e.tbl || '.' || e.col as column_name,
       coalesce(c.data_type, 'MISSING') as found_type
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
 order by e.migration, e.tbl, e.col;

\echo ''
\echo '════════ 4. Functions the newest work depends on ════════'
\echo ''

with expected(fn, migration) as (values
  ('sarraf_save_rates',            '202608200003_single_ratio_save'),
  ('sarraf_partner_batch_detail',  '202608210001_partner_batch_detail'),
  ('sarraf_partner_holdings',      '202608210001_partner_batch_detail'),
  ('sarraf_platform_key',          '202608210001_partner_batch_detail'),
  ('sarraf_receipt_both_sides',    '202608220001_link_receipt_to_document'),
  ('sarraf_schema_tables',         '202608220002_schema_drift_tables'),
  ('sarraf_tenant',                '202608240001_tenants'),
  ('sarraf_tenant_visible',        '202608240001_tenants'),
  ('sarraf_reset_installation',    '202608240003_reset_and_seed_tenants'),
  ('sarraf_tenant_coverage',       '202608240004_tenant_coverage'),
  ('sarraf_set_tenant_rate',       '202608240005_tenant_rates'),
  ('sarraf_manager_tenants',       '202608240006_manager_console'),
  ('sarraf_manager_create_tenant', '202608240006_manager_console')
)
select e.migration, e.fn,
       case when exists (
              select 1 from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = e.fn)
            then 'present' else 'MISSING' end as state
  from expected e
 order by e.migration, e.fn;

-- Everything below asks about tables that may not exist yet — that being the whole question. A
-- plain select on a missing table ends the run with ON_ERROR_STOP, so each one is checked for
-- first and reported as absent rather than fatal. The answers come back as notices, which is why
-- the workflow keeps stderr.
\echo ''
\echo '════════ 5, 6, 7 — accounts, businesses, and how much data is in there ════════'
\echo ''

do $report$
declare
  t text; n bigint; r record; has_level boolean;
begin
  -- Accounts, by rank if the rank column exists yet and by role if it does not.
  if to_regclass('public.app_users') is null then
    raise notice 'app_users — table does not exist';
  else
    select exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'app_users'
                      and column_name = 'admin_level') into has_level;
    -- Which business each account belongs to, not just how many there are. The manager should
    -- belong to none — they maintain the installation, and putting them in a business puts them
    -- inside somebody's books — and everybody else should belong to exactly one.
    for r in execute format(
      'select %s as rank, coalesce(tenant_id, ''<no business>'') as biz,
              count(*) as n, count(*) filter (where deleted) as gone
         from public.app_users group by 1, 2 order by 1, 2',
      case when has_level then 'coalesce(admin_level, role)' else 'role' end)
    loop
      raise notice 'account: % — % — % (% deactivated)', r.rank, r.biz, r.n, r.gone;
    end loop;
  end if;

  -- Businesses. None at all means the reset and seed has never completed.
  if to_regclass('public.tenants') is null then
    raise notice 'tenants — table does not exist, so multi-tenancy has not been applied';
  else
    n := 0;
    for r in select id, name, active from public.tenants order by id loop
      raise notice 'business: % — % — %', r.id, r.name, case when r.active then 'active' else 'suspended' end;
      n := n + 1;
    end loop;
    if n = 0 then
      raise notice 'businesses: none — the reset and seed has not run';
    end if;
  end if;

  -- How much is in there. This decides whether the reset would be clearing a fortnight of
  -- testing or something the owner would want back.
  foreach t in array array['receipts','receipt_batches','txs','ledger','system_event_log',
                           'journal_entries','debts','vouchers'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'rows in % — table does not exist', t;
    else
      execute format('select count(*) from public.%I', t) into n;
      raise notice 'rows in %: %', t, n;
    end if;
  end loop;
end
$report$;
