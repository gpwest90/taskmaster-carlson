-- ===== Carlson Taskmaster: The Button =====
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to re-run: it creates what's missing, upgrades older versions in place,
-- and keeps everyone's link keys. (Upgrading from v1 deletes v1 test clicks and
-- re-seals every letter.)
--
-- Security model: the site is public, so the publishable key is public too.
-- The tables have row level security on and no policies, so that key can't
-- read or write them directly. The site can only call the functions below,
-- and each one needs a contestant's (or the admin's) secret key.
--
-- Game rules the database enforces:
--   * A contestant's clock starts when they break their seal (open_letter).
--   * A click only counts before expires_at; it then sets
--     expires_at = click time + the dial setting at that moment.
--   * Each of the four screws records when it came out. All four out = panel off.
--   * The dial (1–7 days, default 2) can only be turned once the panel is off.
--     (The page itself only offers 1–5.)


-- ===== Tables =====

create table if not exists public.contestants (
  id             bigint generated always as identity primary key,
  name           text not null,
  access_key     text not null unique
                   default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  opened_at      timestamptz,                      -- null = letter still sealed
  expires_at     timestamptz,                      -- current deadline; null until opened
  dial_hours     integer not null default 48,      -- hours a click grants
  screw_1_out_at timestamptz,                      -- null = screw still in
  screw_2_out_at timestamptz,
  screw_3_out_at timestamptz,
  screw_4_out_at timestamptz
);

create table if not exists public.clicks (
  id            bigint generated always as identity primary key,
  contestant_id bigint not null references public.contestants (id) on delete cascade,
  clicked_at    timestamptz not null default now(),
  hours_granted integer not null,                  -- dial setting at the time of the click
  expires_at    timestamptz not null               -- deadline this click produced
);

-- ----- Upgrade from v1 (no-ops on a fresh install) -----
alter table public.contestants
  drop column if exists started_at,
  drop column if exists last_click_at,
  add column if not exists opened_at      timestamptz,
  add column if not exists expires_at     timestamptz,
  add column if not exists dial_hours     integer not null default 48,
  add column if not exists screw_1_out_at timestamptz,
  add column if not exists screw_2_out_at timestamptz,
  add column if not exists screw_3_out_at timestamptz,
  add column if not exists screw_4_out_at timestamptz;

do $$
begin
  -- v1 clicks have no dial setting or deadline to backfill, so drop them.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clicks' and column_name = 'expires_at'
  ) then
    delete from public.clicks where true;
    alter table public.clicks
      add column hours_granted integer not null,
      add column expires_at    timestamptz not null;
  end if;
end;
$$;

alter table public.contestants alter column dial_hours set default 48;

-- ----- Constraints (dropped and re-added so re-runs stay clean) -----
alter table public.contestants
  drop constraint if exists contestants_dial_hours_check,
  add  constraint contestants_dial_hours_check
         check (dial_hours between 24 and 168 and dial_hours % 24 = 0),
  drop constraint if exists contestants_opened_check,
  add  constraint contestants_opened_check
         check ((opened_at is null) = (expires_at is null));

alter table public.clicks
  drop constraint if exists clicks_hours_granted_check,
  add  constraint clicks_hours_granted_check
         check (hours_granted between 24 and 168 and hours_granted % 24 = 0);

create index if not exists clicks_contestant_time_idx
  on public.clicks (contestant_id, clicked_at);

alter table public.contestants enable row level security;
alter table public.clicks      enable row level security;
revoke all on public.contestants, public.clicks from anon, authenticated;


-- ===== Admin key =====

create table if not exists public.admin_settings (
  id        boolean primary key default true check (id),  -- only ever one row
  admin_key text not null
              default substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)
);
alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from anon, authenticated;
insert into public.admin_settings default values on conflict do nothing;


-- ===== Functions =====
-- Old v1 versions had different return types, so drop before recreating.
drop function if exists public.get_status(text);
drop function if exists public.record_click(text);
drop function if exists public.admin_overview(text);

-- ----- Internal helpers (not callable from the site) -----

create or replace function public.is_admin(p_admin_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admin_settings where admin_key = p_admin_key);
$$;

-- Everything a page needs to know about one contestant.
-- state: 'sealed' (letter not opened) | 'alive' | 'out' (time ran out)
create or replace function public.status_of(c public.contestants)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'name',          c.name,
    'state',         case
                       when c.opened_at is null   then 'sealed'
                       when now() < c.expires_at  then 'alive'
                       else 'out'
                     end,
    'opened_at',     c.opened_at,
    'expires_at',    c.expires_at,
    'dial_hours',    c.dial_hours,
    'screws_out_at', jsonb_build_array(c.screw_1_out_at, c.screw_2_out_at,
                                       c.screw_3_out_at, c.screw_4_out_at),
    'panel_off',     c.screw_1_out_at is not null and c.screw_2_out_at is not null
                     and c.screw_3_out_at is not null and c.screw_4_out_at is not null,
    'click_count',   (select count(*) from public.clicks k where k.contestant_id = c.id),
    'server_now',    now()
  );
$$;

-- Fetches and locks a contestant row by key; raises if the key is unknown.
create or replace function public.lock_contestant(p_key text)
returns public.contestants
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.contestants;
begin
  select * into c from public.contestants where access_key = p_key for update;
  if not found then
    raise exception 'Unknown contestant key';
  end if;
  return c;
end;
$$;

-- ----- Contestant functions -----

-- Returns null for an unknown key.
create or replace function public.get_status(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.status_of(c) from public.contestants c where c.access_key = p_key;
$$;

-- Breaking the seal starts the clock. Opening again changes nothing.
create or replace function public.open_letter(p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.contestants := public.lock_contestant(p_key);
begin
  if c.opened_at is null then
    update public.contestants
       set opened_at  = now(),
           expires_at = now() + make_interval(hours => c.dial_hours)
     where id = c.id;
  end if;
  return public.get_status(p_key);
end;
$$;

-- Logs a click and resets the countdown using the current dial setting.
-- The deadline is checked here, on the database's clock, so a late click
-- is refused no matter what the browser does.
create or replace function public.record_click(p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c         public.contestants := public.lock_contestant(p_key);
  v_expires timestamptz;
begin
  if c.opened_at is null then
    raise exception 'Letter not opened yet';
  end if;
  if now() >= c.expires_at then
    raise exception 'Time is up: this button is closed';
  end if;

  v_expires := now() + make_interval(hours => c.dial_hours);
  insert into public.clicks (contestant_id, hours_granted, expires_at)
       values (c.id, c.dial_hours, v_expires);
  update public.contestants set expires_at = v_expires where id = c.id;

  return public.get_status(p_key);
end;
$$;

-- Records when a screw (1–4) came out. The first time sticks.
create or replace function public.remove_screw(p_key text, p_screw integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.contestants := public.lock_contestant(p_key);
begin
  if p_screw not between 1 and 4 then
    raise exception 'Screw must be 1 to 4';
  end if;
  if c.opened_at is null or now() >= c.expires_at then
    raise exception 'The device is not active';
  end if;

  update public.contestants set
    screw_1_out_at = case when p_screw = 1 then coalesce(screw_1_out_at, now()) else screw_1_out_at end,
    screw_2_out_at = case when p_screw = 2 then coalesce(screw_2_out_at, now()) else screw_2_out_at end,
    screw_3_out_at = case when p_screw = 3 then coalesce(screw_3_out_at, now()) else screw_3_out_at end,
    screw_4_out_at = case when p_screw = 4 then coalesce(screw_4_out_at, now()) else screw_4_out_at end
  where id = c.id;

  return public.get_status(p_key);
end;
$$;

-- Turns the dial (1–7 days). Only reachable once all four screws are out.
-- Applies from the next click; the current countdown is unchanged.
create or replace function public.set_dial(p_key text, p_days integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.contestants := public.lock_contestant(p_key);
begin
  if p_days not between 1 and 7 then
    raise exception 'Dial must be 1 to 7 days';
  end if;
  if c.opened_at is null or now() >= c.expires_at then
    raise exception 'The device is not active';
  end if;
  if c.screw_1_out_at is null or c.screw_2_out_at is null
     or c.screw_3_out_at is null or c.screw_4_out_at is null then
    raise exception 'The panel is still on';
  end if;

  update public.contestants set dial_hours = p_days * 24 where id = c.id;
  return public.get_status(p_key);
end;
$$;

-- ----- Admin functions -----

-- Every contestant (with their link key), plus every click for the timeline.
create or replace function public.admin_overview(p_admin_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_admin_key) then
    raise exception 'Not authorised';
  end if;

  return jsonb_build_object(
    'server_now', now(),
    'contestants', coalesce((
      select jsonb_agg(public.status_of(c) || jsonb_build_object('access_key', c.access_key)
                       order by c.id)
      from public.contestants c
    ), '[]'::jsonb),
    'clicks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name',          c.name,
               'clicked_at',    k.clicked_at,
               'hours_granted', k.hours_granted,
               'expires_at',    k.expires_at
             ) order by k.clicked_at)
      from public.clicks k
      join public.contestants c on c.id = k.contestant_id
    ), '[]'::jsonb)
  );
end;
$$;

-- Back to the start: every letter re-sealed, screws back in, dial at 2 days,
-- all clicks deleted. Link keys are kept.
create or replace function public.admin_reset(p_admin_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_admin_key) then
    raise exception 'Not authorised';
  end if;

  -- "where true": Supabase blocks unfiltered deletes/updates from the API.
  delete from public.clicks where true;
  update public.contestants set
    opened_at      = null,
    expires_at     = null,
    dial_hours     = 48,
    screw_1_out_at = null,
    screw_2_out_at = null,
    screw_3_out_at = null,
    screw_4_out_at = null
  where true;
end;
$$;

-- ----- Who can call what -----
revoke execute on function public.is_admin(text)                     from public, anon, authenticated;
revoke execute on function public.status_of(public.contestants)      from public, anon, authenticated;
revoke execute on function public.lock_contestant(text)              from public, anon, authenticated;

revoke execute on function public.get_status(text)                   from public;
revoke execute on function public.open_letter(text)                  from public;
revoke execute on function public.record_click(text)                 from public;
revoke execute on function public.remove_screw(text, integer)        from public;
revoke execute on function public.set_dial(text, integer)            from public;
revoke execute on function public.admin_overview(text)               from public;
revoke execute on function public.admin_reset(text)                  from public;

grant execute on function public.get_status(text)                    to anon, authenticated;
grant execute on function public.open_letter(text)                   to anon, authenticated;
grant execute on function public.record_click(text)                  to anon, authenticated;
grant execute on function public.remove_screw(text, integer)         to anon, authenticated;
grant execute on function public.set_dial(text, integer)             to anon, authenticated;
grant execute on function public.admin_overview(text)                to anon, authenticated;
grant execute on function public.admin_reset(text)                   to anon, authenticated;


-- ===== Seed the five contestants (only if the table is empty) =====
insert into public.contestants (name)
select n from unnest(array[
  'Kathryn Carlson',
  'Elizabeth Robb',
  'Mike Robb',
  'Lindsay Veazey',
  'John Veazey'
]) as n
where not exists (select 1 from public.contestants);


-- ===== Everyone's link key (ADMIN row is the key for clicker-admin.html) =====
select 'ADMIN' as name, admin_key as access_key from public.admin_settings
union all
select name, access_key from (select name, access_key from public.contestants order by id) c;
