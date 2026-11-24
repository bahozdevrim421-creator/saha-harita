# Saha Harita: shared contract (read before changing anything)

## Goal
Field-sales map app. Streets of each mahalle are shown on a map. Visited streets are green,
unvisited red. Visited businesses (restaurants) are pinned and tracked by status. Works on phone,
installable to home screen, online and offline, shared with a team, live-synced across devices.

## Decisions (already made, do not re-open)
- Backend: Supabase (hosted Postgres + auth + realtime + row level security). Free tier is enough.
  Reason: real multi-user sync and per-team access control; Google Sheets has API quotas, no
  realtime, and poor offline behaviour. Excel/Sheets stay as export only.
- Frontend: static site. Plain HTML, CSS and JavaScript, no build step. Leaflet for the map
  (OpenStreetMap tiles). @supabase/supabase-js from CDN. Installable PWA with a service worker.
- Hosting: any static host (Cloudflare Pages, Netlify, or a folder on sertacgungor.com).
  Google One is storage only, not hosting.
- Street data: OpenStreetMap via the Overpass API, fetched once per mahalle when online and cached
  locally (IndexedDB). The sandbox cannot reach OSM, so the import script is run by the user.
- Sync rule: last write wins per row, using `updated_at`. Offline edits go into an outbox queue
  (IndexedDB) and are flushed when the network returns.

## Folder layout
- `app/`      static frontend (owned by the frontend agent)
- `backend/`  SQL migrations, import scripts, setup notes (owned by the backend agent)
- `SPEC.md`   this file

## Data model (Postgres, schema `public`)
All business tables carry `team_id` and are protected by RLS: a row is visible and writable only to
members of that team.

- `teams(id uuid pk, name text, created_at timestamptz)`
- `team_members(team_id uuid fk, user_id uuid fk auth.users, role text check in ('admin','member'), primary key(team_id, user_id))`
- `mahalleler(id uuid pk, team_id uuid fk, ilce text default 'Ümraniye', ad text not null, lat double precision null, lon double precision null, bbox jsonb null, osm_relation_id bigint null, created_at, updated_at, updated_by uuid)`
- `sokaklar(id uuid pk, team_id uuid fk, mahalle_id uuid fk, ad text, osm_way_ids bigint[] null, geom jsonb not null, durum text not null default 'gezilmedi' check in ('gezilmedi','gezildi'), gezilme_zamani timestamptz null, created_at, updated_at, updated_by uuid)`
  - `geom` is GeoJSON LineString or MultiLineString: `{"type":"LineString","coordinates":[[lon,lat],...]}`
- `isletmeler(id uuid pk, team_id uuid fk, mahalle_id uuid fk, sokak_id uuid fk null, ad text not null, platform text null, yetkili text null, telefon text null, adres text null, lat double precision null, lon double precision null, durum text not null default 'ziyaret_edilmedi' check in ('ziyaret_edilmedi','ziyaret_edildi_ilgileniyor','ziyaret_edildi_ilgilenmiyor','kayit_tamamlandi','panel_kuruldu','tekrar_ziyaret'), sonraki_aksiyon text null, notlar text null, follow_up_tarih date null, son_ziyaret timestamptz null, created_at, updated_at, updated_by uuid)`
- `ziyaretler(id uuid pk, team_id uuid fk, user_id uuid fk, sokak_id uuid fk null, isletme_id uuid fk null, lat double precision, lon double precision, created_at timestamptz default now())`
  - GPS trail / visit log ("hareketlerim"). Append only.

Durum values are the same snake_case strings in DB and UI. The UI shows Turkish labels:
- ziyaret_edilmedi = Ziyaret edilmedi
- ziyaret_edildi_ilgileniyor = Ziyaret edildi - ilgileniyor
- ziyaret_edildi_ilgilenmiyor = Ziyaret edildi - ilgilenmiyor
- kayit_tamamlandi = Kayıt tamamlandı
- panel_kuruldu = Panel kuruldu
- tekrar_ziyaret = Tekrar ziyaret

`follow_up_tarih` and `son_ziyaret` were added as optional fields (frontend, sales panel).
  `follow_up_tarih` is the next follow-up date (date only, YYYY-MM-DD, null = none).
  `son_ziyaret` is the time of the last visit, set when `durum` moves into a visited value.
  Migration needed before live sync: `alter table public.isletmeler add column if not exists follow_up_tarih date null, add column if not exists son_ziyaret timestamptz null;`

`updated_at` is set by a trigger on every update. `updated_by` is set to `auth.uid()` by trigger.

## Frontend config
`app/config.js` exports:
```js
window.SAHA_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",   // placeholder until user fills in
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY",                  // public anon key only, never service role
  TEAM_ID: null,                                       // set after login/team join
  DEMO_MODE: true                                      // true = local-only storage, no backend
};
```
If `DEMO_MODE` is true or keys are placeholders, the app runs fully local (IndexedDB) so it can be
tested without any account.

## Sync and offline contract
- Every write goes to IndexedDB first, then to the outbox. The outbox is flushed to Supabase when online.
- Reads come from IndexedDB; realtime updates from Supabase refresh IndexedDB.
- Status changes must be idempotent. Retrying a flush must never create duplicate `ziyaretler` rows
  (use client-generated uuid as primary key).
- Mahalle street data is downloaded once per mahalle (Overpass) and stored locally. Re-download is manual.

## Import contract (backend agent writes it, frontend agent only reads the output)
- `backend/import_osm.mjs` (Node 18+, run by the user on their machine): given a mahalle name,
  queries Overpass for the mahalle boundary and named highways inside it, then writes
  `backend/out/<mahalle-slug>.json` with `{ad, lat, lon, bbox, sokaklar:[{ad, osm_way_ids, geom}]}`
  and optionally inserts into Supabase with the service role key (from env, never committed).
- `backend/migrations/001_init.sql`: schema, triggers, RLS policies, realtime publication.
- `backend/seed/umraniye_mahalleler.csv`: mahalle list (name only, coords blank where unknown).
- `backend/README.md`: Turkish, step by step setup.

## Rules for all agents
- Do not commit secrets. Keys go in config files only as placeholders.
- Do not add frameworks or a build step. Keep everything runnable by opening `index.html` or
  serving the folder.
- Turkish UI text. Code comments in English are fine.
- Run `node --check` on JS files and syntax-check SQL carefully by reading it; say what could not be run.
