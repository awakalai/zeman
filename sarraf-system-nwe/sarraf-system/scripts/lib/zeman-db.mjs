// Disposable PostgreSQL fixture shared by the accounting and business-flow gates.
//
// The fixture emulates only Supabase-owned auth/storage surfaces. Every public object must be
// created by the repository's complete, version-ordered migration history.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = process.env.ZEMAN_TEST_PGPORT || "55433";
const PGBIN = process.env.ZEMAN_PGBIN || "/usr/lib/postgresql/16/bin";
const AS_USER = process.getuid?.() === 0 ? (process.env.ZEMAN_PG_USER || "nobody") : null;
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const run = (command, args, options = {}) => {
  try {
    if (AS_USER) {
      const line = [command, ...args].map(shq).join(" ");
      return execFileSync("su", [AS_USER, "-s", "/bin/sh", "-c", line],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
    }
    return execFileSync(command, args,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (error) {
    const diagnostic = String(error.stderr || "").trim();
    if (diagnostic) error.message = diagnostic;
    throw error;
  }
};

const has = (binary) => existsSync(path.join(PGBIN, binary));
export const postgresAvailable = () => has("initdb") && has("pg_ctl") && has("psql");
export const PG_HINT = `no PostgreSQL at ${PGBIN}; set ZEMAN_PGBIN to run this gate.`;

export function startDatabase() {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const socketDir = mkdtempSync(path.join(tmpdir(), "zeman-sock-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "zeman-pg-"));
  if (AS_USER) {
    for (const dir of [dataDir, socketDir]) execFileSync("chown", ["-R", AS_USER, dir]);
  }

  let started = false;
  const stop = () => {
    try {
      if (started) run(path.join(PGBIN, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"]);
    } catch {}
    for (const dir of [dataDir, socketDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
  process.once("exit", stop);

  const psql = (sql, database = "zeman_verify") => run(path.join(PGBIN, "psql"),
    ["-h", socketDir, "-p", PORT, "-U", "postgres", "-d", database,
      "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql]);
  const psqlFile = (file, database = "zeman_verify") => run(path.join(PGBIN, "psql"),
    ["-h", socketDir, "-p", PORT, "-U", "postgres", "-d", database,
      "-v", "ON_ERROR_STOP=1", "-q", "-f", file]);

  try {
    run(path.join(PGBIN, "initdb"), ["-D", dataDir, "-A", "trust", "-U", "postgres"]);
    // Keep the disposable cluster entirely off TCP. This is both tighter isolation and lets the
    // gate run in CI sandboxes that prohibit opening even a loopback network listener.
    appendFileSync(path.join(dataDir, "postgresql.conf"), `
listen_addresses = ''
unix_socket_directories = '${socketDir.replaceAll("'", "''")}'
port = ${PORT}
`);
    run(path.join(PGBIN, "pg_ctl"), [
      "-D", dataDir, "-l", path.join(dataDir, "log"), "-w", "start",
    ]);
    started = true;
    psql("select 1", "postgres");
    psql("create database zeman_verify", "postgres");

    const prereq = path.join(socketDir, "supabase-prerequisites.sql");
    writeFileSync(prereq, `
      do $$ begin
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
        -- BYPASSRLS, as Supabase creates it. Without that the fixture models a service_role
        -- that is subject to row-level security, which the real one is not — and a gate built on
        -- a wrong model of the server's own key cannot see what the server's own key cannot do.
        -- app_users held no grant for it for weeks and nothing here noticed.
        if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $fn$;
      grant usage on schema auth to authenticated, anon, service_role;
      -- The sign-in table, as Supabase provides it. The manager's console reads the address to
      -- answer "which login is this?" when somebody cannot get in.
      create table if not exists auth.users (
        id uuid primary key, email text, created_at timestamptz not null default now());
      grant select on auth.users to authenticated, service_role;
      -- The second factor, as Supabase provides it. The app sends every administrator and every
      -- office through MfaGate, so a verified factor is not optional for them, and both INSPECT
      -- and the manager's console read this table to say whether that is actually true of a
      -- given account. Without it here, a gate cannot run the branch the live database takes —
      -- which is how the MFA question came to be asked in production before it was asked here.
      create table if not exists auth.mfa_factors (
        id uuid primary key default gen_random_uuid(),
        user_id uuid references auth.users(id),
        status text not null default 'unverified',
        created_at timestamptz not null default now());
      grant select on auth.mfa_factors to authenticated, service_role;
      create schema if not exists storage;
      create table if not exists storage.buckets (
        id text primary key, name text not null, public boolean not null default false,
        file_size_limit bigint, allowed_mime_types text[],
        created_at timestamptz not null default statement_timestamp());
      insert into storage.buckets(id, name) values ('receipts','receipts')
        on conflict (id) do nothing;
      create table if not exists storage.objects (
        id uuid default gen_random_uuid(), bucket_id text not null, name text not null,
        owner_id text, metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default statement_timestamp(),
        primary key(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated, anon, service_role;

      -- The half of Supabase Storage this fixture never modelled, and so never tested.
      --
      -- A browser uploading an image is an INSERT into storage.objects as authenticated,
      -- followed by an UPDATE once the bytes are stored and their size and type are known. The
      -- fixture created the table and stopped there: no grant, no permissive policy, and nothing
      -- in any gate ever inserted a row. So the restrictive policies this repository writes over
      -- that table have never once been executed, and one of them has been refusing every upload
      -- on the live system.
      --
      -- rimg_insert is the project's own permissive grant, reproduced here by name.
      grant select, insert, update, delete on storage.objects to authenticated;
      grant select on storage.buckets to authenticated;
      -- Exactly what the live project has, and nothing more. An earlier version of this fixture
      -- also created a permissive for-all policy, which the live database does not have — and
      -- a check written against that invention passes for a reason production cannot supply.
      -- The live policy list is one permissive INSERT and four restrictive ones; a restrictive
      -- policy only takes rows away, so with no permissive SELECT nobody reads this table at all.
      drop policy if exists rimg_rest on storage.objects;
      drop policy if exists rimg_insert on storage.objects;
      create policy rimg_insert on storage.objects
        for insert to authenticated with check (bucket_id = 'receipts');
    `);
    psqlFile(prereq);

    const migrations = readdirSync(path.join(root, "supabase", "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const versions = migrations.map((name) => name.split("_", 1)[0]);
    if (new Set(versions).size !== versions.length) {
      throw new Error("duplicate Supabase migration versions in the repository");
    }
    for (const migration of migrations) {
      psqlFile(path.join(root, "supabase", "migrations", migration));
    }

    psql(`
      update public.currencies set buy_rate=1, sell_rate=1, rate=1 where id='usd';
      update public.currencies set buy_rate=7.10, sell_rate=7.30, rate=7.20 where id='cny';
      update public.currencies set buy_rate=1400, sell_rate=1420, rate=1410 where id='iqd';
      insert into public.currencies(id,code,name,buy_rate,sell_rate,rate)
      values ('xxx','XXX','Unrated',null,null,null) on conflict do nothing;
      insert into public.app_users(id,name,role,auth_id,tenant_id)
      values ('u-a','A','admin','11111111-1111-1111-1111-111111111111','t-sarkhel')
      on conflict (id) do update set auth_id=excluded.auth_id;
      create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$;
      insert into public.receipt_daily_rates(
        id,currency,effective_date,rate_value,version,set_by,reason)
      values
        ('verify-rate-cny','CNY',current_date,7.2,1,'u-a','verified CNY accounting rate'),
        ('verify-rate-iqd','IQD',current_date,1410,1,'u-a','verified IQD accounting rate')
      on conflict do nothing;
    `);

    const psqlAsRole = (role, uid, sql) => run(path.join(PGBIN, "psql"), [
      "-h", socketDir, "-p", PORT, "-U", role, "-d", "zeman_verify",
      "-v", "ON_ERROR_STOP=1", "-tAq", "-c",
      `begin; select set_config('request.jwt.claim.sub','${uid}',true); ${sql}; commit;`,
    ]);

    return { psql, psqlFile, psqlAsRole, root, stop, migrations };
  } catch (error) {
    stop();
    throw error;
  }
}
