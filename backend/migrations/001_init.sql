-- =====================================================================
-- Saha Harita - 001_init.sql
-- Bu dosya ne yapar:
--   * Tabloları oluşturur: teams, team_members, mahalleler, sokaklar,
--     isletmeler, ziyaretler (SPEC.md veri modeli).
--   * updated_at alanını tetikleyicilerle doldurur: istemcinin gönderdiği
--     düzenleme zamanını korur, son yazan kazanır (LWW). Eski bir yazma
--     sokaklar ve isletmeler için sessizce atlanır (guard_last_write_wins).
--   * updated_by alanını auth.uid() ile doldurur.
--   * is_team_member() yardımcı fonksiyonu ile satır güvenliği (RLS) kurar:
--     bir satır yalnızca kendi takımının üyeleri tarafından görülebilir
--     ve yazılabilir.
--   * ziyaretler tablosuna yalnızca ekleme ve okuma izni verir (silme ve
--     güncelleme yok). Diğer iş tablolarında da silme politikası yoktur.
--   * sokaklar ve isletmeler tablolarını Supabase realtime yayınına ekler.
--
-- Tekrar çalıştırılabilir olacak şekilde yazılmıştır (idempotent):
-- create ... if not exists, create or replace, drop ... if exists.
-- Supabase SQL Editor'de tek seferde çalıştırmak yeterlidir.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tablolar
-- ---------------------------------------------------------------------

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id  uuid not null references public.teams(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  role     text not null default 'member' check (role in ('admin', 'member')),
  primary key (team_id, user_id)
);

create table if not exists public.mahalleler (
  id                uuid primary key default gen_random_uuid(),
  team_id           uuid not null references public.teams(id) on delete cascade,
  ilce              text not null default 'Ümraniye',
  ad                text not null,
  lat               double precision,
  lon               double precision,
  bbox              jsonb,
  osm_relation_id   bigint,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id) on delete set null,
  constraint mahalleler_team_ilce_ad_key unique (team_id, ilce, ad)
);

-- Mahalle silinirse sokak verisi (OSM'den yeniden çekilebilir) da silinir.
create table if not exists public.sokaklar (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references public.teams(id) on delete cascade,
  mahalle_id      uuid not null references public.mahalleler(id) on delete cascade,
  ad              text,
  osm_way_ids     bigint[],
  geom            jsonb not null
                    check (geom->>'type' in ('LineString', 'MultiLineString')),
  durum           text not null default 'gezilmedi'
                    check (durum in ('gezilmedi', 'gezildi')),
  gezilme_zamani  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null
);

-- Mahalle silinmesin diye restrict: işletme kayıtları kazara silinmesin.
-- Sokak silinirse işletme kalır, sokak_id boşa çıkar.
create table if not exists public.isletmeler (
  id               uuid primary key default gen_random_uuid(),
  team_id          uuid not null references public.teams(id) on delete cascade,
  mahalle_id       uuid not null references public.mahalleler(id) on delete restrict,
  sokak_id         uuid references public.sokaklar(id) on delete set null,
  ad               text not null,
  platform         text,
  yetkili          text,
  telefon          text,
  adres            text,
  lat              double precision,
  lon              double precision,
  durum            text not null default 'ziyaret_edilmedi'
                     check (durum in (
                       'ziyaret_edilmedi',
                       'ziyaret_edildi_ilgileniyor',
                       'ziyaret_edildi_ilgilenmiyor',
                       'kayit_tamamlandi',
                       'panel_kuruldu',
                       'tekrar_ziyaret'
                     )),
  sonraki_aksiyon  text,
  notlar           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null
);

-- Ziyaret (GPS izi) kayıtları: ekleme only. Kullanıcı silinse bile kayıt
-- takımda kalır (user_id boşalır).
create table if not exists public.ziyaretler (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  sokak_id    uuid references public.sokaklar(id) on delete set null,
  isletme_id  uuid references public.isletmeler(id) on delete set null,
  lat         double precision not null,
  lon         double precision not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Indexler (team_id ve mahalle_id üzerinde, ayrıca sync ve join alanları)
-- ---------------------------------------------------------------------

create index if not exists team_members_user_id_idx   on public.team_members (user_id);
create index if not exists mahalleler_team_id_idx     on public.mahalleler (team_id);
create index if not exists sokaklar_team_id_idx       on public.sokaklar (team_id);
create index if not exists sokaklar_mahalle_id_idx    on public.sokaklar (mahalle_id);
create index if not exists sokaklar_team_updated_idx  on public.sokaklar (team_id, updated_at);
create index if not exists isletmeler_team_id_idx     on public.isletmeler (team_id);
create index if not exists isletmeler_mahalle_id_idx  on public.isletmeler (mahalle_id);
create index if not exists isletmeler_sokak_id_idx    on public.isletmeler (sokak_id);
create index if not exists isletmeler_team_updated_idx on public.isletmeler (team_id, updated_at);
create index if not exists ziyaretler_team_id_idx     on public.ziyaretler (team_id);
create index if not exists ziyaretler_sokak_id_idx    on public.ziyaretler (sokak_id);
create index if not exists ziyaretler_isletme_id_idx  on public.ziyaretler (isletme_id);

-- ---------------------------------------------------------------------
-- 3. Tetikleyici fonksiyonlar
-- ---------------------------------------------------------------------

-- updated_at: istemcinin gönderdiği düzenleme zamanı korunur (son yazan kazanır,
-- düzenleme zamanına göre). Gönderilmemişse, eskiyse veya gelecekteyse
-- (saat sapması) sunucu zamanı yazılır.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is null
     or new.updated_at <= old.updated_at
     or new.updated_at > now() then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- Son yazan kazanır (LWW) koruması: gelen güncelleme satırdaki mevcut
-- updated_at değerinden eskiyse (çevrimdışı kuyruktan geç gelen eski yazma)
-- satır hiç değiştirilmez. Hata fırlatılmaz; güncelleme sessizce atlanır, böylece
-- istemci kuyruğu hata almadan ilerler. Sunucudaki yeni değer realtime ile
-- istemciye zaten gelir.
-- NEW yerine NULL döndürülür, OLD değil: OLD döndürülseydi sonraki tetikleyiciler
-- (updated_at) satırı yine de güncelleyip sahte bir "yeni" zaman yazardı.
-- Tetikleyiciler ad sırasına göre çalışır; bu fonksiyonun tetikleyicisi adı
-- "_a_lww_guard" olduğu için updated_at tetikleyicisinden önce çalışır.
create or replace function public.guard_last_write_wins()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is not null and new.updated_at <= old.updated_at then
    return null;
  end if;
  return new;
end;
$$;

-- updated_by: oturum açmış kullanıcının id'si yazılır. Servis anahtarıyla
-- (auth.uid() boş) yapılan yazmalarda mevcut değer korunur.
create or replace function public.set_updated_by()
returns trigger
language plpgsql
as $$
begin
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Yardımcı fonksiyonlar (RLS için)
-- ---------------------------------------------------------------------

create or replace function public.is_team_member(team uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.team_members tm
    where tm.team_id = team
      and tm.user_id = auth.uid()
  );
$$;

create or replace function public.is_team_admin(team uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.team_members tm
    where tm.team_id = team
      and tm.user_id = auth.uid()
      and tm.role = 'admin'
  );
$$;

-- Yeni takım oluşturup oluşturanı admin yapar. Uygulama bunu RPC ile çağırır.
create or replace function public.create_team(team_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Önce giriş yapmalısınız';
  end if;

  insert into public.teams (name) values (team_name) returning id into new_id;
  insert into public.team_members (team_id, user_id, role)
    values (new_id, auth.uid(), 'admin');
  return new_id;
end;
$$;

revoke execute on function public.is_team_member(uuid) from public, anon;
revoke execute on function public.is_team_admin(uuid) from public, anon;
revoke execute on function public.create_team(text) from public, anon;
grant execute on function public.is_team_member(uuid) to authenticated, service_role;
grant execute on function public.is_team_admin(uuid) to authenticated, service_role;
grant execute on function public.create_team(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Tetikleyiciler (drop if exists -> create, idempotent)
-- ---------------------------------------------------------------------

drop trigger if exists mahalleler_set_updated_at on public.mahalleler;
create trigger mahalleler_set_updated_at
  before update on public.mahalleler
  for each row execute function public.set_updated_at();

drop trigger if exists mahalleler_set_updated_by on public.mahalleler;
create trigger mahalleler_set_updated_by
  before insert or update on public.mahalleler
  for each row execute function public.set_updated_by();

drop trigger if exists sokaklar_set_updated_at on public.sokaklar;
create trigger sokaklar_set_updated_at
  before update on public.sokaklar
  for each row execute function public.set_updated_at();

drop trigger if exists sokaklar_set_updated_by on public.sokaklar;
create trigger sokaklar_set_updated_by
  before insert or update on public.sokaklar
  for each row execute function public.set_updated_by();

drop trigger if exists isletmeler_set_updated_at on public.isletmeler;
create trigger isletmeler_set_updated_at
  before update on public.isletmeler
  for each row execute function public.set_updated_at();

drop trigger if exists isletmeler_set_updated_by on public.isletmeler;
create trigger isletmeler_set_updated_by
  before insert or update on public.isletmeler
  for each row execute function public.set_updated_by();

-- LWW guard. Ad "_a_lww_guard" bilerek "_set_updated_at" öncesinde gelir:
-- PostgreSQL aynı olaydaki tetikleyicileri ad sırasına göre çalıştırır
-- (belgelenmiş davranış). Guard, istemcinin gönderdiği updated_at'i
-- yeniden yazılmadan önce görmelidir.
drop trigger if exists sokaklar_a_lww_guard on public.sokaklar;
create trigger sokaklar_a_lww_guard
  before update on public.sokaklar
  for each row execute function public.guard_last_write_wins();

drop trigger if exists isletmeler_a_lww_guard on public.isletmeler;
create trigger isletmeler_a_lww_guard
  before update on public.isletmeler
  for each row execute function public.guard_last_write_wins();

-- ---------------------------------------------------------------------
-- 6. Satır güvenliği (RLS)
-- ---------------------------------------------------------------------

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.mahalleler   enable row level security;
alter table public.sokaklar     enable row level security;
alter table public.isletmeler   enable row level security;
alter table public.ziyaretler   enable row level security;

-- teams: üyeler görür; güncelleme yalnızca admin. Ekleme create_team ile.
drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams
  for select to authenticated
  using (public.is_team_member(id));

drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams
  for update to authenticated
  using (public.is_team_admin(id))
  with check (public.is_team_admin(id));

-- team_members: üyeler kendi satırını ve takımındakileri görür.
-- Ekleme, değiştirme ve silme yalnızca takım admini (veya kişinin kendisi ayrılırken silme).
drop policy if exists team_members_select on public.team_members;
create policy team_members_select on public.team_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_team_member(team_id));

drop policy if exists team_members_insert on public.team_members;
create policy team_members_insert on public.team_members
  for insert to authenticated
  with check (public.is_team_admin(team_id));

drop policy if exists team_members_update on public.team_members;
create policy team_members_update on public.team_members
  for update to authenticated
  using (public.is_team_admin(team_id))
  with check (public.is_team_admin(team_id));

drop policy if exists team_members_delete on public.team_members;
create policy team_members_delete on public.team_members
  for delete to authenticated
  using (user_id = auth.uid() or public.is_team_admin(team_id));

-- mahalleler: select / insert / update takım üyesine. Delete politikası yok.
drop policy if exists mahalleler_select on public.mahalleler;
create policy mahalleler_select on public.mahalleler
  for select to authenticated
  using (public.is_team_member(team_id));

drop policy if exists mahalleler_insert on public.mahalleler;
create policy mahalleler_insert on public.mahalleler
  for insert to authenticated
  with check (public.is_team_member(team_id));

drop policy if exists mahalleler_update on public.mahalleler;
create policy mahalleler_update on public.mahalleler
  for update to authenticated
  using (public.is_team_member(team_id))
  with check (public.is_team_member(team_id));

-- sokaklar
drop policy if exists sokaklar_select on public.sokaklar;
create policy sokaklar_select on public.sokaklar
  for select to authenticated
  using (public.is_team_member(team_id));

drop policy if exists sokaklar_insert on public.sokaklar;
create policy sokaklar_insert on public.sokaklar
  for insert to authenticated
  with check (public.is_team_member(team_id));

drop policy if exists sokaklar_update on public.sokaklar;
create policy sokaklar_update on public.sokaklar
  for update to authenticated
  using (public.is_team_member(team_id))
  with check (public.is_team_member(team_id));

-- isletmeler
drop policy if exists isletmeler_select on public.isletmeler;
create policy isletmeler_select on public.isletmeler
  for select to authenticated
  using (public.is_team_member(team_id));

drop policy if exists isletmeler_insert on public.isletmeler;
create policy isletmeler_insert on public.isletmeler
  for insert to authenticated
  with check (public.is_team_member(team_id));

drop policy if exists isletmeler_update on public.isletmeler;
create policy isletmeler_update on public.isletmeler
  for update to authenticated
  using (public.is_team_member(team_id))
  with check (public.is_team_member(team_id));

-- ziyaretler: yalnızca select ve insert. Kayıt kendi user_id'siyle eklenir.
drop policy if exists ziyaretler_select on public.ziyaretler;
create policy ziyaretler_select on public.ziyaretler
  for select to authenticated
  using (public.is_team_member(team_id));

drop policy if exists ziyaretler_insert on public.ziyaretler;
create policy ziyaretler_insert on public.ziyaretler
  for insert to authenticated
  with check (public.is_team_member(team_id) and user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 7. Realtime yayını (sokaklar, isletmeler)
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sokaklar'
  ) then
    alter publication supabase_realtime add table public.sokaklar;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'isletmeler'
  ) then
    alter publication supabase_realtime add table public.isletmeler;
  end if;
end;
$$;
