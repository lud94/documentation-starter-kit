-- ⚠️ FIXTURE TEMPORAIRE — À SUPPRIMER APRÈS LE LOT A3b.
--
-- Raison d'être : `supabase/migrations/` est volontairement VIDE tant que la
-- baseline n'a pas été récupérée depuis le schéma distant réel (`supabase db pull`).
-- Les tests d'intégration ne peuvent donc appliquer aucune migration. Ce fichier
-- reproduit À L'IDENTIQUE la table telle qu'elle existe aujourd'hui, d'après
-- supabase/schema.sql lignes 42-49.
--
-- ⚠️ Ce fichier n'est PAS une migration et ne doit jamais être appliqué à une base
-- réelle. Dès que la baseline A3b existe :
--   1. remplacer son application par `supabase db reset` (migrations réelles) ;
--   2. SUPPRIMER ce fichier ;
--   3. retirer sa référence de tests/integration/leads-pg.test.ts.
-- Le laisser en place ferait diverger silencieusement le schéma testé du schéma réel.

create table if not exists prospector_leads (
  id           text primary key,           -- ⚠️ clé sur `id` SEUL : c'est le défaut P0
  data         jsonb,
  workspace_id text,
  created_at   timestamptz not null default now()
);

-- Reproduit fidèlement l'état de production. La clé de service contourne la RLS,
-- donc elle n'influe pas sur ces tests — elle est incluse pour l'exactitude.
alter table prospector_leads enable row level security;

-- PostgREST met son schéma en cache : sans ce signal, une table créée hors
-- migration reste invisible de l'API REST.
notify pgrst, 'reload schema';
