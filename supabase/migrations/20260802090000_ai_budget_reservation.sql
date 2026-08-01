-- categorie: additive
-- rollback: supprimer les SIX fonctions (prospector_ai_bump, _engaged, _reserve,
--           _settle, _resolve, _reconcile). Les DEUX tables sont CONSERVEES :
--             * prospector_ai_reservations porte l'historique financier, dont les
--               UNRESOLVED non tranchees - les perdre effacerait un passif ;
--             * prospector_ai_ledger porte le compteur de consommation ; le
--               supprimer ramenerait la depense connue a zero, donc RELEVERAIT le
--               plafond restant. Un rollback ne doit jamais rendre plus permissif.
--           La suppression des tables est une decision operateur explicite, jamais
--           un effet de bord du retrait des fonctions.
-- reversible: partielle

-- ============================================================================
-- C2a-1 — Reservation budgetaire atomique pour les appels Anthropic.
--
-- CE QUE CE LOT FERME
--   * les increments perdus : bumpUsage() faisait `select` puis `upsert` d'une
--     valeur calculee cote client. Deux ecritures simultanees ecrivaient chacune
--     `cur + by` et l'une ecrasait l'autre, base parfaitement disponible.
--   * le depassement silencieux : la lecture etait anterieure a la depense, sans
--     reservation. N instances concurrentes lisaient le meme `spent` et partaient
--     toutes.
--
-- LE VERROU. Toutes les fonctions prennent le MEME verrou EN PREMIER : la ligne
-- 'ai:usd_micros' de prospector_ai_ledger, en SELECT ... FOR UPDATE. C'est ce
-- verrou, et non une convention applicative, qui serialise toutes les instances
-- serverless. Aucune fonction ne verrouille une reservation avant cette ligne :
-- ordre uniforme, donc pas d'interblocage.
--
-- L'UNITE EST LE MICRO-DOLLAR (1e-6 USD), EN bigint.
--   * prospector_usage.count est `integer` DANS LA BASELINE DE PRODUCTION
--     (20260801185016_baseline_production.sql:101) et vaut au plus 2 147 483 647,
--     soit 2 147 $ en µUSD : il deborderait.
--   * cette colonne est de plus NULLABLE en production, contrairement a ce
--     qu'annoncait l'ancien schema.sql (`not null default 0`). Tout calcul
--     `count + x` y rendrait NULL.
--   Le compteur monetaire vit donc dans sa PROPRE table, et prospector_usage
--   n'est ni modifiee ni migree.
--
-- CE QUE CE LOT NE FAIT PAS. Aucune correction de l'historique. Le seed ci-dessous
-- convertit le compteur hérité, il ne reconstruit pas la depense reelle.
-- ============================================================================


-- ── Compteur monetaire durable ───────────────────────────────────────────────
create table if not exists public.prospector_ai_ledger (
  key        text        primary key,
  -- Le compteur de depense ne DECROIT jamais : une valeur negative releverait le
  -- plafond restant, c'est-a-dire exactement la panne que ce lot ferme. La
  -- contrainte est en base, pas seulement en applicatif : c'est la seule place
  -- qu'un futur appelant ne peut pas contourner.
  micros     bigint      not null default 0 check (micros >= 0),
  updated_at timestamptz not null default now()
);

alter table public.prospector_ai_ledger enable row level security;
-- Aucune policy : coherent avec les 6 tables existantes. La cle de service,
-- utilisee exclusivement cote serveur, contourne la RLS ; le navigateur n'accede
-- jamais a ces tables.
revoke all on table public.prospector_ai_ledger from anon, authenticated;


-- ── Seed du compteur depuis l'historique — APPROXIMATIF, ASSUME ──────────────
--
-- ⚠️ CECI N'EST PAS UNE RECONSTRUCTION DE LA DEPENSE REELLE.
--
-- `ai:cents` sous-comptait, et c'est mesure : recordAiUsage() faisait
-- Math.round(usd * 100), donc un appel Jarvis sur Haiku (1500 tokens d'entree,
-- 400 de sortie) coutait 0,28 cent et etait arrondi a ZERO. Les appels les plus
-- nombreux de la plateforme n'ont jamais ete comptes.
--
-- La valeur obtenue ici est donc un MINORANT de la depense historique reelle.
-- Elle est neanmoins conservee : demarrer a zero serait strictement plus
-- permissif que demarrer a un minorant.
--
-- La reconciliation avec la facturation reelle est le lot C2c. Elle n'est PAS
-- tentee ici : reconstruire un historique a partir d'un compteur dont on vient
-- de prouver qu'il ment produirait un chiffre faux presente comme exact.
insert into public.prospector_ai_ledger (key, micros)
select 'ai:usd_micros', coalesce(u.count, 0)::bigint * 10000
from public.prospector_usage u
where u.key = 'ai:cents'
on conflict (key) do nothing;

-- Cas d'une base sans historique : la ligne doit exister pour servir de verrou.
insert into public.prospector_ai_ledger (key, micros)
values ('ai:usd_micros', 0)
on conflict (key) do nothing;


-- ── Reservations ─────────────────────────────────────────────────────────────
--
-- Quatre etats, jamais « EXPIRED » : l'expiration est une CAUSE (consignee dans
-- outcome_code), pas une verite comptable. Une reservation expiree est une
-- reservation dont on ignore si elle a ete facturee — c'est exactement UNRESOLVED.
--
--   OPEN       pese estimated_micros au budget
--   SETTLED    settled_micros verses au compteur
--   RELEASED   pese 0 — certain non facture
--   UNRESOLVED pese estimated_micros, JAMAIS verse au compteur, sortie manuelle
create table if not exists public.prospector_ai_reservations (
  id                uuid        primary key,   -- genere par l'APPLICATION : cle d'idempotence
  fingerprint       text        not null,      -- hash canonique du corps Anthropic + endpoint
  state             text        not null default 'OPEN'
                                check (state in ('OPEN','SETTLED','RELEASED','UNRESOLVED')),
  estimated_micros  bigint      not null check (estimated_micros >= 0),
  settled_micros    bigint      check (settled_micros is null or settled_micros >= 0),
  expires_at        timestamptz not null,      -- explicite par ligne, jamais une constante implicite
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  agent             text,
  model             text,
  outcome_code      text,                      -- http_200 | http_400 | econnrefused | timeout | expired …
  resolved_by       text,                      -- reconciliation manuelle : qui
  resolution_reason text                       -- reconciliation manuelle : pourquoi
);

create index if not exists prospector_ai_reservations_open_idx
  on public.prospector_ai_reservations (expires_at) where state = 'OPEN';
create index if not exists prospector_ai_reservations_unresolved_idx
  on public.prospector_ai_reservations (created_at) where state = 'UNRESOLVED';

alter table public.prospector_ai_reservations enable row level security;
revoke all on table public.prospector_ai_reservations from anon, authenticated;


-- ── Increment atomique ───────────────────────────────────────────────────────
-- Remplace le `select` puis `upsert` non atomique. Une seule instruction, donc
-- aucune fenetre entre lecture et ecriture.
--
-- SURFACE MINIMALE, DELIBEREE. Pas de parametre `p_key` : C2a n'a besoin que d'un
-- compteur, 'ai:usd_micros'. Une cle libre aurait offert a un futur appelant la
-- possibilite d'incrementer un compteur qui n'entre dans aucun arbitrage - donc
-- de croire compter une depense sans qu'elle pese jamais au budget. Le jour ou un
-- second compteur sera necessaire, il faudra l'ajouter ici explicitement.
--
-- DELTA POSITIF UNIQUEMENT. Un delta negatif serait une remise de depense, donc
-- un relevement du plafond restant : refuse a la source plutot que rattrape par
-- la contrainte de table, pour que le message dise ce qui s'est passe.
create or replace function public.prospector_ai_bump(p_delta bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_micros bigint;
begin
  if p_delta is null or p_delta < 0 then
    raise exception 'prospector_ai_bump: delta negatif ou absent (%) - la consommation ne decroit jamais', p_delta;
  end if;
  insert into public.prospector_ai_ledger as l (key, micros, updated_at)
  values ('ai:usd_micros', p_delta, now())
  on conflict (key) do update
    set micros = l.micros + excluded.micros, updated_at = now()
  returning l.micros into v_micros;
  return v_micros;
end;
$$;


-- ── Engagement courant ───────────────────────────────────────────────────────
-- engage = consomme + reservations OPEN non expirees + passif UNRESOLVED.
-- Le compteur reste la consommation REGLEE ET CONNUE : une reservation incertaine
-- bloque du budget sans jamais etre presentee comme consommation.
create or replace function public.prospector_ai_engaged()
returns table (consumed_micros bigint, open_micros bigint, unresolved_micros bigint)
language sql
security definer
set search_path = ''
as $$
  select
    coalesce((select l.micros from public.prospector_ai_ledger l
              where l.key = 'ai:usd_micros'), 0)::bigint,
    -- TOUTES les OPEN, expirees comprises. Les exclure a l'echeance ferait
    -- DISPARAITRE leur poids entre l'expiration et le balayage : pendant cette
    -- fenetre, l'engagement chuterait et une reservation aurait pu etre accordee
    -- au-dela du plafond. Le balayage les deplace ensuite vers UNRESOLVED sans
    -- changer le total - l'engagement reste continu.
    coalesce((select sum(r.estimated_micros) from public.prospector_ai_reservations r
              where r.state = 'OPEN'), 0)::bigint,
    coalesce((select sum(r.estimated_micros) from public.prospector_ai_reservations r
              where r.state = 'UNRESOLVED'), 0)::bigint;
$$;


-- ── Reservation ──────────────────────────────────────────────────────────────
-- Renvoie state ∈ reserved | budget_exhausted | integrity_error | already_<etat>
create or replace function public.prospector_ai_reserve(
  p_id               uuid,
  p_fingerprint      text,
  p_budget_micros    bigint,
  p_estimate_micros  bigint,
  p_agent            text,
  p_model            text,
  p_ttl_seconds      integer
)
returns table (state text, engaged_micros bigint, budget_micros bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.prospector_ai_reservations%rowtype;
  v_engaged  bigint;
begin
  -- 1. VERROU, TOUJOURS EN PREMIER. Serialise toutes les instances concurrentes.
  --    La ligne est creee au besoin pour qu'il y ait toujours quelque chose a
  --    verrouiller, y compris sur une base neuve.
  insert into public.prospector_ai_ledger (key, micros)
  values ('ai:usd_micros', 0) on conflict (key) do nothing;
  perform 1 from public.prospector_ai_ledger
   where key = 'ai:usd_micros' for update;

  -- 2. Balayage paresseux des reservations expirees. Une OPEN depassee devient
  --    UNRESOLVED et JAMAIS RELEASED : le processus a pu mourir apres emission,
  --    donc on ignore si l'appel a ete facture. Fait ici plutot que dans une
  --    tache planifiee : pas de second ordonnanceur a maintenir, et pas d'ordre
  --    de verrous supplementaire.
  update public.prospector_ai_reservations
     set state = 'UNRESOLVED', resolved_at = now(), outcome_code = 'expired'
   where state = 'OPEN' and expires_at <= now();

  -- 3. Idempotence. Le meme identifiant rejoue doit rendre la MEME decision.
  select * into v_existing from public.prospector_ai_reservations where id = p_id;
  if found then
    -- Meme identifiant, intention facturable differente : on refuse. C'est un
    -- defaut d'appelant, pas un rejeu — l'accepter ferait partir une seconde
    -- depense sous couvert d'idempotence.
    if v_existing.fingerprint is distinct from p_fingerprint then
      return query select 'integrity_error'::text, 0::bigint, p_budget_micros;
      return;
    end if;
    if v_existing.state = 'OPEN' then
      return query select 'reserved'::text, 0::bigint, p_budget_micros;
    else
      return query select ('already_' || lower(v_existing.state))::text, 0::bigint, p_budget_micros;
    end if;
    return;
  end if;

  -- 4. Engagement, evalue DANS la transaction qui accorde la reservation.
  select e.consumed_micros + e.open_micros + e.unresolved_micros
    into v_engaged from public.prospector_ai_engaged() e;

  -- 5. Verdict. Aucune reservation n'est accordee si engage + estimation depasse
  --    le plafond. C'est l'invariant reellement garanti — le depassement residuel
  --    possible vient de settled > estimated sur les appels a outils serveur, que
  --    ce lot borne mais ne supprime pas.
  if p_budget_micros > 0 and v_engaged + p_estimate_micros > p_budget_micros then
    return query select 'budget_exhausted'::text, v_engaged, p_budget_micros;
    return;
  end if;

  insert into public.prospector_ai_reservations
    (id, fingerprint, estimated_micros, expires_at, agent, model)
  values
    (p_id, p_fingerprint, p_estimate_micros,
     now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 900), 60)),
     p_agent, p_model);

  return query select 'reserved'::text, v_engaged, p_budget_micros;
end;
$$;


-- ── Reglement ────────────────────────────────────────────────────────────────
-- Idempotent par la garde `state = 'OPEN'` : un second reglement ne touche
-- aucune ligne, donc n'impute jamais deux fois.
create or replace function public.prospector_ai_settle(
  p_id             uuid,
  p_settled_micros bigint,
  p_outcome        text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
  v_amount  bigint;
begin
  -- Un montant absent n'est PAS zero : on ignorerait alors une depense reelle en
  -- la comptant gratuite. L'appelant doit dire ce qu'il a depense.
  if p_settled_micros is null or p_settled_micros < 0 then
    raise exception 'prospector_ai_settle: montant absent ou negatif (%) - un reglement doit etre chiffre', p_settled_micros;
  end if;
  v_amount := p_settled_micros;

  perform 1 from public.prospector_ai_ledger where key = 'ai:usd_micros' for update;

  update public.prospector_ai_reservations
     set state = 'SETTLED', settled_micros = v_amount,
         resolved_at = now(), outcome_code = p_outcome
   where id = p_id and state = 'OPEN';
  get diagnostics v_updated = row_count;
  if v_updated = 0 then return 'noop'; end if;

  -- SEUL chemin qui alimente le compteur, et uniquement avec un cout REGLE.
  -- Aucune estimation n'y entre jamais.
  perform public.prospector_ai_bump(v_amount);
  return 'settled';
end;
$$;


-- ── Resolution non facturee / incertaine ─────────────────────────────────────
-- RELEASED : connexion jamais etablie, ou refus fournisseur avant inference.
-- UNRESOLVED : requete transmise, issue inconnue. Pese, sans jamais alimenter
-- le compteur.
create or replace function public.prospector_ai_resolve(
  p_id      uuid,
  p_state   text,
  p_outcome text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_updated integer;
begin
  if p_state not in ('RELEASED', 'UNRESOLVED') then
    raise exception 'prospector_ai_resolve: etat invalide %', p_state;
  end if;

  perform 1 from public.prospector_ai_ledger where key = 'ai:usd_micros' for update;

  update public.prospector_ai_reservations
     set state = p_state, resolved_at = now(), outcome_code = p_outcome,
         settled_micros = case when p_state = 'RELEASED' then 0 else null end
   where id = p_id and state = 'OPEN';
  get diagnostics v_updated = row_count;
  return case when v_updated = 0 then 'noop' else lower(p_state) end;
end;
$$;


-- ── Reconciliation manuelle d'une UNRESOLVED ─────────────────────────────────
-- Sortie d'UNRESOLVED : action OPERATEUR explicite, jamais automatique. Un
-- traitement automatique devrait deviner si l'appel a ete facture — c'est
-- precisement ce qu'on ignore.
create or replace function public.prospector_ai_reconcile(
  p_id                uuid,
  p_state             text,
  p_settled_micros    bigint,
  p_resolved_by       text,
  p_resolution_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
  v_amount  bigint;
begin
  if p_state not in ('SETTLED', 'RELEASED') then
    raise exception 'prospector_ai_reconcile: etat cible invalide %', p_state;
  end if;

  -- Tracabilite obligatoire, les DEUX champs. Une reconciliation est un acte
  -- comptable manuel : sans auteur ni motif, l'historique ne dit pas pourquoi un
  -- passif incertain a ete transforme en depense, ou efface.
  if p_resolved_by is null or length(trim(p_resolved_by)) = 0 then
    raise exception 'prospector_ai_reconcile: resolved_by obligatoire (tracabilite)';
  end if;
  if p_resolution_reason is null or length(trim(p_resolution_reason)) = 0 then
    raise exception 'prospector_ai_reconcile: resolution_reason obligatoire (tracabilite)';
  end if;

  -- « Facture » sans montant serait « facture zero » : on refuse plutot que de
  -- transformer une absence d'information en absence de depense.
  if p_state = 'SETTLED' and (p_settled_micros is null or p_settled_micros < 0) then
    raise exception 'prospector_ai_reconcile: SETTLED exige un montant explicite et positif (recu %)', p_settled_micros;
  end if;
  v_amount := case when p_state = 'SETTLED' then p_settled_micros else 0 end;

  perform 1 from public.prospector_ai_ledger where key = 'ai:usd_micros' for update;

  update public.prospector_ai_reservations
     set state = p_state, settled_micros = v_amount,
         resolved_at = now(), resolved_by = p_resolved_by,
         resolution_reason = p_resolution_reason
   where id = p_id and state = 'UNRESOLVED';
  get diagnostics v_updated = row_count;
  if v_updated = 0 then return 'noop'; end if;

  if p_state = 'SETTLED' then perform public.prospector_ai_bump(v_amount); end if;
  return lower(p_state);
end;
$$;


-- ── Permissions ──────────────────────────────────────────────────────────────
-- PostgreSQL accorde EXECUTE a PUBLIC par defaut a la creation : le revoke est
-- necessaire, pas decoratif. Seule la cle de service, utilisee cote serveur,
-- doit pouvoir engager une depense.
revoke execute on function public.prospector_ai_bump(bigint)                     from public, anon, authenticated;
revoke execute on function public.prospector_ai_engaged()                              from public, anon, authenticated;
revoke execute on function public.prospector_ai_reserve(uuid, text, bigint, bigint, text, text, integer) from public, anon, authenticated;
revoke execute on function public.prospector_ai_settle(uuid, bigint, text)             from public, anon, authenticated;
revoke execute on function public.prospector_ai_resolve(uuid, text, text)              from public, anon, authenticated;
revoke execute on function public.prospector_ai_reconcile(uuid, text, bigint, text, text) from public, anon, authenticated;

grant execute on function public.prospector_ai_bump(bigint)                      to service_role;
grant execute on function public.prospector_ai_engaged()                               to service_role;
grant execute on function public.prospector_ai_reserve(uuid, text, bigint, bigint, text, text, integer) to service_role;
grant execute on function public.prospector_ai_settle(uuid, bigint, text)              to service_role;
grant execute on function public.prospector_ai_resolve(uuid, text, text)               to service_role;
grant execute on function public.prospector_ai_reconcile(uuid, text, bigint, text, text) to service_role;
