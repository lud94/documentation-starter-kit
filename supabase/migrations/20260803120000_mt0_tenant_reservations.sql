-- Lot MT-0 — imputation des réservations à un espace client (tenant).
--
-- ⚠️ LA MIGRATION 20260802090000_ai_budget_reservation.sql EST GELÉE.
-- Ce fichier est strictement ADDITIF : il ajoute une colonne, un index et une
-- fonction. Il ne modifie ni ne recrée aucun objet de C2a-1.
--
-- ── CE QUE CE LOT FAIT, ET SURTOUT CE QU'IL NE FAIT PAS ──────────────────────
-- Il rend une réservation IMPUTABLE. Il n'introduit ni budget par tenant, ni
-- période, ni arbitrage : `prospector_ai_reserve` conserve exactement sa
-- sémantique, et le plafond reste global. Les budgets par tenant sont MT-1.
--
-- ── HISTORIQUE : AUCUNE RÉTRO-ATTRIBUTION ────────────────────────────────────
-- Les lignes existantes gardent `tenant_id NULL`. Leur imputer un espace
-- reviendrait à inventer une attribution que personne n'a mesurée. NULL
-- signifie donc, et uniquement, « antérieur à MT-0 ». Aucune réservation
-- nouvelle ne peut être NULL : la fonction ci-dessous l'exige.

alter table public.prospector_ai_reservations
  add column if not exists tenant_id text;

comment on column public.prospector_ai_reservations.tenant_id is
  'Espace client imputé (prospector_workspaces.id, ''admin'', ou ''_system''). '
  'NULL = réservation antérieure au lot MT-0, jamais une réservation courante.';

-- Imputation par espace, filtrée sur l'état : c'est la forme des futures
-- lectures d'engagement par tenant (MT-1) et des relevés d'anomalie.
create index if not exists prospector_ai_reservations_tenant_state_idx
  on public.prospector_ai_reservations (tenant_id, state);

-- ── Réservation IMPUTÉE ──────────────────────────────────────────────────────
--
-- Enveloppe mince autour de `prospector_ai_reserve`, GELÉE et donc appelée
-- telle quelle : aucune logique budgétaire n'est dupliquée ici. Dupliquer
-- l'arbitrage aurait créé deux vérités à maintenir en parallèle — exactement
-- ce que la revue de C2a-1 avait refusé pour les codes d'état.
--
-- ── INTÉGRITÉ TENANT DE L'IDEMPOTENCE (lot MT-0c) ────────────────────────────
--
-- Défaut corrigé. La première version se contentait d'imputer le PREMIER
-- inscrivant (`update … where tenant_id is null`) et rendait quand même
-- `reserved` à un rejeu portant un AUTRE espace. L'attribution était juste, le
-- verdict ne l'était pas : l'appelant du second espace recevait une
-- autorisation de dépenser adossée à la réservation d'un tiers.
--
-- Depuis MT-0, `tenant_id` fait partie de l'identité financière d'une
-- réservation, au même titre que l'empreinte. Le contrat devient donc :
--   même id + même empreinte + même espace      → rejeu idempotent autorisé
--   même id + même empreinte + espace DIFFÉRENT → integrity_error
--   même id + empreinte différente              → integrity_error (RPC gelée)
--   ligne existante à tenant_id NULL            → integrity_error
--
-- Le dernier cas est délibéré : une ligne NULL signifie « antérieure à MT-0,
-- attribution inconnue ». La rétro-attribuer au passage d'un rejeu inventerait
-- une imputation historique que personne n'a mesurée. On refuse.
--
-- ── ORDRE DES VERROUS — inchangé, et c'est le point délicat ──────────────────
--
-- La vérification ne peut pas être un `check-then-act` non protégé : deux
-- appels concurrents portant le même identifiant et deux espaces différents
-- pourraient tous deux constater « aucune ligne » puis en créer une.
--
-- On prend donc le MÊME verrou global que C2a-1, DANS LE MÊME ORDRE, et avant
-- de lire l'existant. Les deux instructions ci-dessous sont copiées à
-- l'identique de l'étape 1 de `prospector_ai_reserve` ; la fonction gelée les
-- rejouera, sans effet, puisque la transaction détient déjà la ligne.
--
--   1. verrou global `ai:usd_micros`      ← identique à C2a-1
--   2. vérification d'intégrité tenant    ← nouveau, sous ce verrou
--   3. arbitrage budgétaire C2a-1         ← inchangé, délégué
--   4. imputation de la ligne créée       ← nouveau
--
-- Aucun second objet n'est verrouillé : l'ordre global reste à un seul cran,
-- donc aucun interblocage n'est introduit.
--
-- L'appel de fonction s'exécute dans la transaction de l'appelant : le verdict
-- et l'imputation sont donc atomiques ensemble, sans second aller-retour.
create or replace function public.prospector_ai_reserve_t(
  p_id uuid,
  p_fingerprint text,
  p_budget_micros bigint,
  p_estimate_micros bigint,
  p_agent text,
  p_model text,
  p_ttl_seconds integer,
  p_tenant_id text
)
returns table (result_state text, engaged_micros bigint, budget_micros bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state           text;
  v_engaged         bigint;
  v_budget          bigint;
  v_existing_tenant text;
  v_exists          boolean;
begin
  -- Validation AVANT tout verrou et toute écriture, comme les fonctions de
  -- C2a-1 : une sonde à argument invalide ne doit rien laisser derrière elle.
  if p_tenant_id is null or btrim(p_tenant_id) = '' then
    raise exception 'tenant_id obligatoire : une reservation ne peut pas etre anonyme';
  end if;

  -- 1. VERROU GLOBAL, TOUJOURS EN PREMIER — même ligne, même ordre que C2a-1.
  --    Il sérialise la vérification d'intégrité qui suit : sans lui, deux
  --    appels concurrents portant le même identifiant et deux espaces
  --    différents pourraient tous deux lire « aucune ligne » avant que l'un
  --    des deux ne la crée.
  insert into public.prospector_ai_ledger (key, micros)
  values ('ai:usd_micros', 0) on conflict (key) do nothing;
  perform 1 from public.prospector_ai_ledger
   where key = 'ai:usd_micros' for update;

  -- 2. INTÉGRITÉ TENANT, sous le verrou. `v_exists` capture `FOUND`
  --    IMMÉDIATEMENT : toute instruction suivante le réécrirait, et confondre
  --    « aucune ligne » avec « ligne à tenant_id NULL » inverserait le verdict.
  select r.tenant_id into v_existing_tenant
    from public.prospector_ai_reservations r
   where r.id = p_id;
  v_exists := found;

  if v_exists then
    -- Ligne héritée sans imputation : on REFUSE plutôt que d'inventer une
    -- attribution historique au passage d'un rejeu.
    if v_existing_tenant is null then
      return query select 'integrity_error'::text, 0::bigint, p_budget_micros;
      return;
    end if;
    -- Même identifiant, autre espace : ce n'est pas un rejeu, c'est une
    -- réservation d'autrui. Rendre `reserved` autoriserait un espace à
    -- dépenser sur la réservation d'un tiers.
    if v_existing_tenant is distinct from p_tenant_id then
      return query select 'integrity_error'::text, 0::bigint, p_budget_micros;
      return;
    end if;
  end if;

  -- 3. ARBITRAGE BUDGÉTAIRE — délégué tel quel. La fonction gelée reprend le
  --    verrou déjà détenu (sans effet) et tranche l'empreinte, l'engagement et
  --    le plafond. Aucune de ces règles n'est réécrite ici.
  --
  -- ⚠️ `select *` POSITIONNEL, et surtout PAS `select r.result_state, …`.
  -- Les paramètres OUT de cette fonction portent exactement les mêmes noms que
  -- les colonnes rendues par la fonction appelée. Les référencer par nom
  -- rouvrirait la classe de défaut de C2a-1d — « column reference is
  -- ambiguous » — qui est valide à la création et n'échoue qu'au premier appel,
  -- donc invisible en relecture. Le positionnel ne référence aucun identifiant.
  select * into v_state, v_engaged, v_budget
    from public.prospector_ai_reserve(
      p_id, p_fingerprint, p_budget_micros, p_estimate_micros,
      p_agent, p_model, p_ttl_seconds
    );

  -- 4. IMPUTATION de la ligne que CET appel vient de créer. Le `is null`
  --    subsiste par prudence : après l'étape 2, une ligne préexistante porte
  --    forcément déjà `p_tenant_id`, et l'écriture est alors sans effet.
  if v_state = 'reserved' then
    update public.prospector_ai_reservations r
       set tenant_id = p_tenant_id
     where r.id = p_id
       and r.tenant_id is null;
  end if;

  return query select v_state, v_engaged, v_budget;
end;
$$;

-- PostgreSQL accorde EXECUTE à PUBLIC par défaut : on le retire explicitement
-- avant d'accorder au seul rôle de service, comme pour les six RPC de C2a-1.
revoke execute on function public.prospector_ai_reserve_t(uuid, text, bigint, bigint, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.prospector_ai_reserve_t(uuid, text, bigint, bigint, text, text, integer, text)
  to service_role;
