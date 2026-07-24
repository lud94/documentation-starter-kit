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

-- Sécurité : RLS activé, aucune policy publique.
-- La service_role key (côté serveur) bypasse la RLS ; le navigateur n'accède jamais à ces tables.
alter table prospector_settings   enable row level security;
alter table prospector_workspaces enable row level security;
