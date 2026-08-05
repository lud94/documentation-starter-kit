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
  v_state text;
  v_engaged bigint;
  v_budget bigint;
begin
  -- Validation AVANT tout verrou et toute écriture, comme les fonctions de
  -- C2a-1 : une sonde à argument invalide ne doit rien laisser derrière elle.
  if p_tenant_id is null or btrim(p_tenant_id) = '' then
    raise exception 'tenant_id obligatoire : une reservation ne peut pas etre anonyme';
  end if;

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

  -- Imputation du PREMIER inscrivant. Sur un rejeu idempotent (même id, même
  -- empreinte), la valeur déjà posée est conservée : une requête rejouée ne
  -- doit pas pouvoir déplacer une dépense d'un espace vers un autre.
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
