-- categorie: additive
-- rollback: supprimer les SIX RPC publiques + le validateur interne. La TABLE est
--           CONSERVEE : elle porte des enveloppes chiffrees dont la perte
--           detruirait le seul exemplaire du secret (le TOTP administrateur n'est
--           re-derivable nulle part). Supprimer la table est une decision
--           operateur explicite, jamais un effet de bord du retrait des fonctions.
-- reversible: partielle

-- ============================================================================
-- SEC-SECRETS-0C.1 — COFFRE DES SECRETS DE PLATEFORME.
--
-- CE LOT NE MIGRE AUCUNE VALEUR EXISTANTE. Il pose le contenant, ses regles et
-- ses transitions. Le transfert des valeurs heritees (prospector_settings,
-- variables d'environnement) est un lot distinct.
--
-- ── CE QUE CE COFFRE FERME ──────────────────────────────────────────────────
-- `prospector_settings` est une table cle/valeur EN CLAIR, ouverte en ecriture
-- a `service_role` comme a `anon` (baseline, GRANT ALL). Trois secrets de
-- plateforme y transitaient ou pouvaient y transiter : le sceau TOTP de
-- l'administrateur, le secret de webhook Telegram, le jeton du bot Telegram.
-- Une lecture de ligne suffisait a les obtenir ; une ecriture de ligne suffisait
-- a les remplacer.
--
-- Ici :
--   * la valeur n'existe qu'en ENVELOPPE scellee (AES-256-GCM + AAD, lot 0B) ;
--     le SQL ne voit jamais un octet de clair, et n'a aucun moyen d'en produire ;
--   * `service_role` n'a que SELECT. INSERT / UPDATE / DELETE directs sont
--     REFUSES. Toute ecriture passe par une RPC etroite qui impose la transition ;
--   * aucune RPC n'accepte un `status` libre. L'etat n'est pas un parametre :
--     c'est une consequence de l'operation demandee.
--
-- ── POURQUOI DES REVOKE EXPLICITES ──────────────────────────────────────────
-- La baseline contient
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       GRANT ALL ON TABLES TO service_role;   (et a anon)
-- Une table creee ici NAIT donc en GRANT ALL pour ces deux roles. « Ne pas
-- accorder » ne suffit pas : il faut RETIRER. Le REVOKE ci-dessous n'est pas une
-- precaution de style, c'est la seule chose qui rende la table non ecrivable.
-- ============================================================================


-- ── Le contenant ────────────────────────────────────────────────────────────
create table if not exists public.prospector_platform_secrets (
  -- CARDINALITE UN. La cle primaire est le NOM du secret : il ne peut exister
  -- qu'une seule generation vivante de chacun. Pas de workspace_id, pas de
  -- user_id, pas de provider : ces secrets sont ceux de la PLATEFORME. Y ajouter
  -- une dimension de portee ouvrirait la porte a « le meme secret, mais pour
  -- quelqu'un d'autre » — ce qui n'a pas de sens ici et creerait un second
  -- exemplaire a garder synchrone.
  secret_name    text        primary key
                   check (secret_name in
                     ('telegram_webhook_secret','telegram_bot_token','admin_totp_secret')),

  -- Enveloppe scellee, serialisee par lib/secrets/crypto.ts. JAMAIS de clair.
  -- NULL uniquement sur une pierre tombale (status = 'revoked').
  envelope       text,

  -- DERIVE, jamais fourni. Le `kid` est une propriete de l'enveloppe : le laisser
  -- ecrire separement permettrait a une ligne d'annoncer une clef et d'en porter
  -- une autre — et l'inventaire de rotation (assertSafeKeyringTransition) lit
  -- CETTE colonne pour decider si une clef est encore referencee. Un kid mensonger
  -- autoriserait donc le retrait d'une clef encore utilisee.
  kid            text        generated always as ((envelope::jsonb) ->> 'kid') stored,

  -- Generation. Strictement croissante, jamais remise a 1 : voir le contrat de
  -- version dans les RPC. C'est le jeton du compare-and-swap.
  secret_version integer     not null check (secret_version >= 1),

  -- AUCUN DEFAULT, deliberement. Un DEFAULT ferait exister un etat « par
  -- omission » : une insertion incomplete produirait une ligne d'apparence
  -- legitime. Ici, ne pas dire l'etat est une erreur, pas un cas nominal.
  status         text        not null
                   check (status in ('staged','pending_provider','active','revoked')),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- ── Coherence etat / contenu ──────────────────────────────────────────────
  -- ⚠️ `kid is not null` est ECRIT EXPLICITEMENT. En SQL, une CHECK qui s'evalue
  -- a UNKNOWN n'est PAS un rejet : elle PASSE. Sans cette clause, une enveloppe
  -- JSON valide mais depourvue de `kid` donnerait kid = NULL, donc
  -- `NULL ~ '...'` = UNKNOWN, donc `true and true and UNKNOWN` = UNKNOWN, donc
  -- ligne ACCEPTEE — avec une valeur qu'aucune rotation ne saurait plus suivre.
  constraint prospector_platform_secrets_state_ck check (
    (status in ('staged','pending_provider','active')
       and envelope is not null
       and kid is not null
       and kid ~ '^[a-z0-9][a-z0-9_-]{0,31}$')
    or
    -- Pierre tombale : l'etat 'revoked' n'est pas « une ligne supprimee », c'est
    -- une ligne qui AFFIRME l'absence. Elle ne porte plus rien a dechiffrer, donc
    -- elle n'epingle plus aucune clef dans l'inventaire de rotation.
    (status = 'revoked' and envelope is null and kid is null)
  ),

  -- ── Etats legaux PAR SECRET ───────────────────────────────────────────────
  -- Les trois secrets n'ont pas le meme cycle de vie, et melanger leurs etats
  -- rendrait chaque garde applicative optionnelle.
  --
  --   admin_totp_secret       staged -> active -> revoked
  --     'staged' existe parce qu'un sceau TOTP doit etre PROUVE (un code valide
  --     saisi) avant de devenir l'autorite d'authentification. Un sceau actif
  --     jamais verifie enferme dehors le seul administrateur.
  --
  --   telegram_webhook_secret pending_provider -> active -> revoked
  --     'pending_provider' parce que c'est le FOURNISSEUR qui detient la verite :
  --     tant que Telegram n'a pas accepte le setWebhook, la base ne doit pas
  --     affirmer que ce secret est celui qui sera presente. Ecrire 'active' avant
  --     confirmation ferait mentir la base, et le verificateur d'entrant
  --     rejetterait les messages reels.
  --
  --   telegram_bot_token      active -> revoked
  --     Aucun etat intermediaire : ce jeton est emis par BotFather, il est
  --     valide des sa reception. Il n'y a rien a prouver ni a confirmer, donc
  --     aucune promotion n'existe pour lui.
  constraint prospector_platform_secrets_kind_state_ck check (
    (secret_name = 'admin_totp_secret'       and status in ('staged','active','revoked'))
    or (secret_name = 'telegram_webhook_secret' and status in ('pending_provider','active','revoked'))
    or (secret_name = 'telegram_bot_token'      and status in ('active','revoked'))
  )
);

-- Inventaire de rotation : « quelles clefs sont encore referencees ? ». Partiel,
-- car une pierre tombale n'epingle rien.
create index if not exists prospector_platform_secrets_kid_idx
  on public.prospector_platform_secrets (kid) where kid is not null;

alter table public.prospector_platform_secrets enable row level security;

-- ── Privileges ──────────────────────────────────────────────────────────────
-- On RETIRE d'abord tout (y compris a service_role, cf. default privileges de la
-- baseline), puis on accorde la seule chose necessaire : la LECTURE. L'ecriture
-- directe n'est pas « deconseillee », elle est refusee par le moteur.
revoke all on table public.prospector_platform_secrets
  from public, anon, authenticated, service_role;
grant select on table public.prospector_platform_secrets to service_role;


-- ── Validateur interne d'enveloppe ──────────────────────────────────────────
-- N'est accorde a PERSONNE : seules les fonctions `security definer` ci-dessous
-- l'appellent, et elles s'executent avec les droits du proprietaire.
--
-- Il ne verifie PAS la cryptographie — le SQL n'a pas la clef et ne doit pas
-- l'avoir. Il verifie la seule chose qui engage la base : que l'objet est un
-- objet JSON portant un `kid` de forme connue. L'authenticite reelle est etablie
-- par l'AEAD au dechiffrement, cote application.
create or replace function public.prospector_platform_secret_assert_envelope(p_envelope text)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_json jsonb;
begin
  if p_envelope is null or btrim(p_envelope) = '' then
    raise exception 'platform_secret: enveloppe absente';
  end if;
  begin
    v_json := p_envelope::jsonb;
  exception when others then
    -- Message BORNE : on decrit la FORME attendue, on ne renvoie jamais l'entree.
    raise exception 'platform_secret: enveloppe non JSON';
  end;
  if jsonb_typeof(v_json) <> 'object' then
    raise exception 'platform_secret: enveloppe non objet';
  end if;
  if coalesce(v_json ->> 'kid', '') !~ '^[a-z0-9][a-z0-9_-]{0,31}$' then
    raise exception 'platform_secret: kid absent ou de forme invalide';
  end if;
end;
$$;


-- ── Etat initial d'une generation, DERIVE du nom ────────────────────────────
create or replace function public.prospector_platform_secret_initial_status(p_name text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_name
    when 'admin_totp_secret'       then 'staged'
    when 'telegram_webhook_secret' then 'pending_provider'
    when 'telegram_bot_token'      then 'active'
  end;
$$;


-- ============================================================================
-- CONTRAT DE VERSION — commun aux six RPC.
--
--   create           v absente -> 1
--   replace (valeur) v         -> v+1        (nouvelle generation)
--   promote          v         -> v          (meme valeur, autre etat)
--   revoke           v         -> v+1        (pierre tombale)
--   rewrap           v         -> v          (meme clair, autre clef)
--   adopt legacy     absente   -> 1
--
-- La version ne redescend JAMAIS a 1 apres une revocation : la pierre tombale
-- porte deja v+1, et `replace` repart de la. Sans quoi un appelant qui detient
-- un vieux `expected_version` verrait son CAS reussir apres un cycle complet —
-- c'est-a-dire ecraserait une generation qu'il n'a jamais observee.
--
-- Toutes les RPC rendent une CHAINE STABLE. Aucune ne rend un secret.
-- ============================================================================


-- ── CREATE : pose une premiere generation, ne remplace jamais rien ───────────
create or replace function public.prospector_platform_secret_create(
  p_name     text,
  p_envelope text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_updated integer;
begin
  v_status := public.prospector_platform_secret_initial_status(p_name);
  if v_status is null then
    raise exception 'platform_secret: nom inconnu';
  end if;
  perform public.prospector_platform_secret_assert_envelope(p_envelope);

  -- `on conflict do nothing` : l'existant n'est ni lu, ni ecrase, ni compare.
  insert into public.prospector_platform_secrets
    (secret_name, envelope, secret_version, status)
  values (p_name, p_envelope, 1, v_status)
  on conflict (secret_name) do nothing;

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return 'created';
  end if;
  return 'exists';
end;
$$;


-- ── REPLACE : nouvelle generation, sous compare-and-swap de version ──────────
create or replace function public.prospector_platform_secret_replace(
  p_name             text,
  p_envelope         text,
  p_expected_version integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_updated integer;
begin
  v_status := public.prospector_platform_secret_initial_status(p_name);
  if v_status is null then
    raise exception 'platform_secret: nom inconnu';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'platform_secret: version attendue absente ou invalide';
  end if;
  perform public.prospector_platform_secret_assert_envelope(p_envelope);

  -- AUCUNE condition sur `status` : une pierre tombale DOIT pouvoir redevenir une
  -- generation vivante, pour les trois secrets. Un coffre dont la revocation est
  -- definitive transforme la reponse a un incident en panne permanente — et
  -- pousse a revoquer trop tard, ce qui est exactement le contraire du but.
  update public.prospector_platform_secrets
     set envelope       = p_envelope,
         secret_version = secret_version + 1,
         status         = v_status,
         updated_at     = now()
   where secret_name    = p_name
     and secret_version = p_expected_version;

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return 'replaced';
  end if;
  return 'stale';
end;
$$;


-- ── PROMOTE : liste blanche de transitions, aucune valeur touchee ────────────
create or replace function public.prospector_platform_secret_promote(
  p_name             text,
  p_expected_version integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from    text;
  v_updated integer;
begin
  -- La transition n'est pas un parametre. Elle est deduite du nom, et il n'en
  -- existe que deux. `telegram_bot_token` n'a PAS de promotion : un jeton
  -- BotFather est valide des sa reception, il n'y a rien a prouver. Autoriser
  -- une promotion « generique » reviendrait a permettre de rendre actif ce qui
  -- n'a jamais ete verifie.
  v_from := case p_name
    when 'admin_totp_secret'       then 'staged'
    when 'telegram_webhook_secret' then 'pending_provider'
  end;
  if v_from is null then
    raise exception 'platform_secret: promotion inexistante pour ce secret';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'platform_secret: version attendue absente ou invalide';
  end if;

  -- Version INCHANGEE : la valeur ne change pas, seule son autorite change. Un
  -- increment ferait echouer le CAS d'un appelant qui detient pourtant la bonne
  -- generation.
  update public.prospector_platform_secrets
     set status     = 'active',
         updated_at = now()
   where secret_name    = p_name
     and secret_version = p_expected_version
     and status         = v_from;

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return 'promoted';
  end if;
  -- Mauvaise version OU mauvais etat : dans les deux cas l'appelant se trompe sur
  -- l'etat du monde. Une seule reponse, et surtout pas de detail qui aiderait a
  -- sonder la ligne.
  return 'stale';
end;
$$;


-- ── REVOKE : pose une pierre tombale ────────────────────────────────────────
create or replace function public.prospector_platform_secret_revoke(
  p_name             text,
  p_expected_version integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if public.prospector_platform_secret_initial_status(p_name) is null then
    raise exception 'platform_secret: nom inconnu';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'platform_secret: version attendue absente ou invalide';
  end if;

  -- L'enveloppe est EFFACEE, pas conservee « au cas ou ». Un secret revoque qui
  -- reste dechiffrable n'est pas revoque. La ligne subsiste pour porter la
  -- version : c'est elle qui empeche une generation ulterieure de repartir a 1.
  update public.prospector_platform_secrets
     set envelope       = null,
         secret_version = secret_version + 1,
         status         = 'revoked',
         updated_at     = now()
   where secret_name    = p_name
     and secret_version = p_expected_version
     and status        <> 'revoked';

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return 'revoked';
  end if;
  return 'stale';
end;
$$;


-- ── REWRAP : meme clair, meme version, autre clef ───────────────────────────
create or replace function public.prospector_platform_secret_rewrap(
  p_name             text,
  p_expected_version integer,
  p_old_kid          text,
  p_envelope         text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if public.prospector_platform_secret_initial_status(p_name) is null then
    raise exception 'platform_secret: nom inconnu';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'platform_secret: version attendue absente ou invalide';
  end if;
  if coalesce(p_old_kid, '') !~ '^[a-z0-9][a-z0-9_-]{0,31}$' then
    raise exception 'platform_secret: kid source absent ou de forme invalide';
  end if;
  perform public.prospector_platform_secret_assert_envelope(p_envelope);

  -- DOUBLE condition : version ET kid source. Le kid seul ne suffit pas (deux
  -- generations peuvent partager une clef) ; la version seule non plus (un
  -- rewrap concurrent aurait deja change la clef sans changer la version).
  --
  -- La VERSION NE BOUGE PAS : un re-scellement ne cree pas une nouvelle
  -- generation, c'est le MEME secret sous une autre clef. L'incrementer
  -- invaliderait le CAS de tous les appelants legitimes a chaque rotation.
  --
  -- `status <> 'revoked'` : on ne re-scelle pas une pierre tombale — il n'y a
  -- rien dedans, et lui rendre une enveloppe la ressusciterait sans transition.
  update public.prospector_platform_secrets
     set envelope   = p_envelope,
         updated_at = now()
   where secret_name    = p_name
     and secret_version = p_expected_version
     and kid            = p_old_kid
     and status        <> 'revoked';

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return 'rewrapped';
  end if;
  return 'stale';
end;
$$;


-- ── ADOPTION DU TOTP HERITE ─────────────────────────────────────────────────
-- SEUL point d'entree capable de creer un `admin_totp_secret` directement ACTIF.
--
-- POURQUOI IL EXISTE. Un sceau TOTP deja en service chez l'administrateur est
-- deja prouve : son telephone genere des codes valides aujourd'hui. Le faire
-- passer par 'staged' exigerait une nouvelle preuve pour un sceau qui n'a pas
-- change — et, entre les deux, l'authentification a deux facteurs serait
-- inactive. La migration d'un secret n'est pas sa rotation.
--
-- POURQUOI IL EST ETROIT. Il ne s'applique qu'a `admin_totp_secret`, seulement
-- en ABSENCE de ligne, toujours en version 1. Il ne peut donc ni ecraser une
-- generation vivante, ni ressusciter une pierre tombale, ni servir a rendre
-- actif un secret Telegram sans passer par sa confirmation fournisseur.
create or replace function public.prospector_platform_secret_adopt_legacy_totp(
  p_envelope text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  perform public.prospector_platform_secret_assert_envelope(p_envelope);

  insert into public.prospector_platform_secrets
    (secret_name, envelope, secret_version, status)
  values ('admin_totp_secret', p_envelope, 1, 'active')
  on conflict (secret_name) do nothing;

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return 'adopted';
  end if;
  return 'exists';
end;
$$;


-- ── Privileges d'execution ──────────────────────────────────────────────────
-- Rejouable : REVOKE puis GRANT, sans dependre de l'etat anterieur.
revoke execute on function public.prospector_platform_secret_assert_envelope(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.prospector_platform_secret_initial_status(text)
  from public, anon, authenticated, service_role;

revoke execute on function public.prospector_platform_secret_create(text, text)
  from public, anon, authenticated;
revoke execute on function public.prospector_platform_secret_replace(text, text, integer)
  from public, anon, authenticated;
revoke execute on function public.prospector_platform_secret_promote(text, integer)
  from public, anon, authenticated;
revoke execute on function public.prospector_platform_secret_revoke(text, integer)
  from public, anon, authenticated;
revoke execute on function public.prospector_platform_secret_rewrap(text, integer, text, text)
  from public, anon, authenticated;
revoke execute on function public.prospector_platform_secret_adopt_legacy_totp(text)
  from public, anon, authenticated;

grant execute on function public.prospector_platform_secret_create(text, text)
  to service_role;
grant execute on function public.prospector_platform_secret_replace(text, text, integer)
  to service_role;
grant execute on function public.prospector_platform_secret_promote(text, integer)
  to service_role;
grant execute on function public.prospector_platform_secret_revoke(text, integer)
  to service_role;
grant execute on function public.prospector_platform_secret_rewrap(text, integer, text, text)
  to service_role;
grant execute on function public.prospector_platform_secret_adopt_legacy_totp(text)
  to service_role;
