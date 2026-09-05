-- ============================================================================
-- C2a-1e — Smoke test des RPC budgétaires sur un environnement PERSISTANT.
--
-- ⚠️ CE FICHIER N'EST PAS UNE MIGRATION. Il vit hors de supabase/migrations/ et
-- n'est jamais appliqué par `supabase db reset` ni par `supabase db push`.
--
-- NETTOYAGE GARANTI PAR CONSTRUCTION. Tout est enveloppé dans une transaction
-- qui se termine par ROLLBACK. Aucune ligne de test ne peut survivre, même si le
-- script échoue en cours de route : il n'y a pas de chemin où des données
-- resteraient. C'est plus sûr qu'un DELETE final, qui suppose qu'on arrive
-- jusqu'à lui.
--
-- Corollaire à connaître : le compteur prospector_ai_ledger n'est pas modifié
-- durablement par ce test. C'est voulu — un smoke test ne doit pas laisser de
-- dépense fictive dans un compteur budgétaire.
--
-- AUCUN APPEL ANTHROPIC. Les RPC sont exercées directement ; ce script ne
-- dépense pas un centime et n'a besoin d'aucune clé Anthropic.
--
-- Usage :
--   psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f scripts/smoke/c2a1_budget_smoke.sql
-- ou : coller le contenu dans l'éditeur SQL Supabase du projet STAGING.
--
-- Toute anomalie lève une exception : le script est vert ou il s'arrête.
-- ============================================================================

begin;

-- Identifiants de test reconnaissables, et de toute façon annulés par le ROLLBACK.
\set res_a '11111111-1111-1111-1111-111111111111'
\set res_b '22222222-2222-2222-2222-222222222222'


-- ── 0. Les deux tables existent-elles ? ──────────────────────────────────────
do $$
begin
  if to_regclass('public.prospector_ai_ledger') is null then
    raise exception 'ECHEC : table prospector_ai_ledger absente - la migration C2a-1 est-elle appliquee ?';
  end if;
  if to_regclass('public.prospector_ai_reservations') is null then
    raise exception 'ECHEC : table prospector_ai_reservations absente';
  end if;
  raise notice '  OK  les deux tables C2a-1 existent';
end $$;


-- ── 1. Photographie AVANT — sert au controle de non-regression du point 7 ───
create temporary table _smoke_before on commit drop as
select 'prospector_leads' as t, count(*) as n from public.prospector_leads
union all select 'prospector_store',            count(*) from public.prospector_store
union all select 'prospector_settings',         count(*) from public.prospector_settings
union all select 'prospector_workspaces',       count(*) from public.prospector_workspaces
union all select 'prospector_pappers_cache',    count(*) from public.prospector_pappers_cache
union all select 'prospector_usage',            count(*) from public.prospector_usage
union all select 'ai_ledger_micros',            coalesce((select micros from public.prospector_ai_ledger
                                                          where key = 'ai:usd_micros'), -1);


-- ── 2. Lecture de l'engagement ───────────────────────────────────────────────
do $$
declare e record;
begin
  select * into e from public.prospector_ai_engaged();
  if e.consumed_micros is null then
    raise exception 'ECHEC : prospector_ai_engaged() ne rend pas de consommation';
  end if;
  raise notice '  OK  engaged() -> consomme=% ouvert=% incertain=%',
    e.consumed_micros, e.open_micros, e.unresolved_micros;
end $$;


-- ── 3. Reservation AUTORISEE, puis seconde REFUSEE faute de marge ────────────
-- Budget de 1 000 000 µUSD (1,00 $). La premiere reservation en consomme 900 000,
-- la seconde en demande 200 000 : la somme depasse, donc elle doit etre refusee.
do $$
declare
  v_consumed bigint;
  v_budget   bigint := 1000000;
  r1 record;
  r2 record;
begin
  select consumed_micros into v_consumed from public.prospector_ai_engaged();
  -- Le plafond est relatif a ce qui est DEJA consomme sur cet environnement :
  -- un budget absolu trop bas ferait echouer le test sur un staging non vierge.
  v_budget := v_consumed + 1000000;

  select * into r1 from public.prospector_ai_reserve(
    '11111111-1111-1111-1111-111111111111'::uuid,
    repeat('a', 64), v_budget, 900000, 'smoke', 'claude-sonnet-5', 900);
  if r1.result_state <> 'reserved' then
    raise exception 'ECHEC : premiere reservation refusee (%), marge pourtant suffisante', r1.result_state;
  end if;
  raise notice '  OK  reservation autorisee';

  select * into r2 from public.prospector_ai_reserve(
    '22222222-2222-2222-2222-222222222222'::uuid,
    repeat('b', 64), v_budget, 200000, 'smoke', 'claude-sonnet-5', 900);
  if r2.result_state <> 'budget_exhausted' then
    raise exception 'ECHEC : seconde reservation acceptee (%) alors que le plafond est depasse', r2.result_state;
  end if;
  raise notice '  OK  seconde reservation refusee : budget_exhausted';
end $$;


-- ── 4. Reglement, puis coherence engagement / consommation ───────────────────
do $$
declare
  v_before bigint;
  v_after  bigint;
  v_open   bigint;
  v_ret    text;
begin
  select consumed_micros into v_before from public.prospector_ai_engaged();

  v_ret := public.prospector_ai_settle(
    '11111111-1111-1111-1111-111111111111'::uuid, 123456, 'http_200');
  if v_ret <> 'settled' then
    raise exception 'ECHEC : settle a rendu % au lieu de settled', v_ret;
  end if;

  select consumed_micros, open_micros into v_after, v_open from public.prospector_ai_engaged();

  -- La consommation augmente EXACTEMENT du montant regle : ni l'estimation
  -- (900 000), ni un arrondi ne doivent s'y glisser.
  if v_after - v_before <> 123456 then
    raise exception 'ECHEC : consommation +% attendue +123456', v_after - v_before;
  end if;
  -- Et la reservation ne pese plus : reglee, elle sort de l'engagement ouvert.
  if v_open <> 0 then
    raise exception 'ECHEC : % micros restent engages apres reglement', v_open;
  end if;
  raise notice '  OK  reglement impute au reel (123456), engagement ouvert revenu a 0';
end $$;


-- ── 5. Permissions : la cle anon ne peut engager aucune depense ──────────────
-- `set local role` est limite a la transaction. On teste les trois fonctions qui
-- engagent ou modifient de l'argent, plus la lecture.
do $$
declare
  v_allowed boolean;
  v_fn      text;
begin
  foreach v_fn in array array['engaged', 'bump', 'reserve', 'settle'] loop
    v_allowed := false;
    set local role anon;
    begin
      case v_fn
        when 'engaged' then perform public.prospector_ai_engaged();
        when 'bump'    then perform public.prospector_ai_bump(1);
        when 'reserve' then perform public.prospector_ai_reserve(
                              gen_random_uuid(), repeat('c', 64), 0, 1, 'x', 'y', 900);
        when 'settle'  then perform public.prospector_ai_settle(gen_random_uuid(), 1, 'x');
      end case;
      v_allowed := true;
    exception when insufficient_privilege then
      v_allowed := false;
    when others then
      -- Toute autre erreur signifie que l'appel a ETE AUTORISE puis a echoue
      -- pour une raison metier : c'est une regression de permissions.
      v_allowed := true;
    end;
    reset role;
    if v_allowed then
      raise exception 'REGRESSION DE PERMISSIONS : anon peut appeler prospector_ai_%()', v_fn;
    end if;
    raise notice '  OK  anon refuse sur prospector_ai_%()', v_fn;
  end loop;
end $$;


-- ── 6. Non-regression : aucune table legacy touchee ──────────────────────────
do $$
declare d record;
begin
  for d in
    select b.t, b.n as avant, a.n as apres from _smoke_before b
    join (
      select 'prospector_leads' as t, count(*) as n from public.prospector_leads
      union all select 'prospector_store',         count(*) from public.prospector_store
      union all select 'prospector_settings',      count(*) from public.prospector_settings
      union all select 'prospector_workspaces',    count(*) from public.prospector_workspaces
      union all select 'prospector_pappers_cache', count(*) from public.prospector_pappers_cache
      union all select 'prospector_usage',         count(*) from public.prospector_usage
    ) a on a.t = b.t
    where a.n <> b.n
  loop
    raise exception 'ECHEC : % a change (% -> %) - une table legacy a ete modifiee', d.t, d.avant, d.apres;
  end loop;
  raise notice '  OK  aucune table applicative legacy modifiee';
end $$;


-- ── 7. Annulation — le nettoyage n'est pas une etape, c'est la structure ─────
rollback;


-- ── 8. Verification APRES annulation : rien n'a survecu ──────────────────────
do $$
declare n integer;
begin
  select count(*) into n from public.prospector_ai_reservations
   where id in ('11111111-1111-1111-1111-111111111111'::uuid,
                '22222222-2222-2222-2222-222222222222'::uuid);
  if n <> 0 then
    raise exception 'ECHEC DE NETTOYAGE : % reservation(s) de test subsistent', n;
  end if;
  raise notice '  OK  aucune donnee de test residuelle';
  raise notice 'SMOKE TEST C2a-1e : VERT';
end $$;
