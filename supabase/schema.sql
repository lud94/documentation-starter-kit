-- Schéma Supabase pour Prospector — à exécuter dans Supabase → SQL Editor.
-- Persiste les réglages (clés API, hash mot de passe, secret MFA) et les espaces clients.
-- Accès uniquement via la service_role key côté serveur (jamais exposée au navigateur).

-- 1) Réglages clé/valeur (keystore durable)
create table if not exists prospector_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);

-- 2) Espaces clients
create table if not exists prospector_workspaces (
  id          text primary key,
  name        text not null,
  leads       integer not null default 0,
  users       integer not null default 1,
  plan        text not null default 'Starter',
  created_at  timestamptz not null default now()
);
-- Colonnes ajoutées (espaces clients : email d'accès, statut, permissions)
alter table prospector_workspaces add column if not exists client_email text;
alter table prospector_workspaces add column if not exists status text default 'active';
alter table prospector_workspaces add column if not exists permissions jsonb;
alter table prospector_workspaces add column if not exists client_password_hash text;

-- 3) Cache Pappers par SIREN (évite de repayer un dirigeant déjà résolu)
create table if not exists prospector_pappers_cache (
  siren       text primary key,
  data        jsonb,
  created_at  timestamptz not null default now()
);

-- 4) Compteurs d'usage (ex. appels Pappers réels facturés)
create table if not exists prospector_usage (
  key         text primary key,
  count       integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- 5) Leads persistés (créés via sourcing / ajout manuel / import / extension)
create table if not exists prospector_leads (
  id          text primary key,
  data        jsonb,
  created_at  timestamptz not null default now()
);
alter table prospector_leads enable row level security;

-- Sécurité : RLS activé, aucune policy publique.
-- La service_role key (côté serveur) bypasse la RLS ; le navigateur n'accède jamais à ces tables.
alter table prospector_settings       enable row level security;
alter table prospector_workspaces     enable row level security;
alter table prospector_pappers_cache  enable row level security;
alter table prospector_usage          enable row level security;
