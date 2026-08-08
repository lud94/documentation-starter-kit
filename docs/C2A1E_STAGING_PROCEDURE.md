# C2a-1e — Application de la migration C2a-1 au staging et smoke test

**Cette procédure ne peut pas être exécutée depuis la session d'assistance :** aucun
jeton d'accès Supabase, aucun rattachement de projet, aucune variable de connexion
n'y est disponible (`supabase projects list` → `Access token not provided`,
`supabase/.temp` absent). Les commandes ci-dessous sont à lancer par l'exploitant.

**Périmètre : staging uniquement.** Aucune commande de ce document ne doit viser la
production. Règle opératoire inchangée depuis A3b : **`--linked` ou `--db-url`
explicite, et vérification du projet visé avant chaque commande qui écrit.**

---

## Étape 1 — Rattachement et historique AVANT

```sh
npx supabase login                              # jeton personnel, hors dépôt
npx supabase link --project-ref <REF-STAGING>   # écrit dans supabase/.temp/, ignoré par git

# Contrôle de cible : la référence affichée doit être celle du STAGING.
cat supabase/.temp/project-ref

npx supabase migration list --linked            # ← HISTORIQUE AVANT, à conserver
```

**Attendu avant push :**

| Local | Remote | Nom |
|---|---|---|
| `20260801185016` | `20260801185016` | `baseline_production` |
| `20260802090000` | *(vide)* | `ai_budget_reservation` |

Si `20260801185016` n'apparaît **pas** côté `Remote`, s'arrêter : le staging n'a pas
la baseline, et appliquer C2a-1 par-dessus un schéma d'origine inconnue reviendrait
à déduire l'état plutôt qu'à le constater.

## Étape 2 — Application au staging

```sh
npx supabase db push --linked --dry-run   # affiche CE QUI SERAIT applique, n'applique rien
npx supabase db push --linked
```

Le `--dry-run` d'abord, systématiquement : il doit ne lister que
`20260802090000_ai_budget_reservation.sql`. S'il en liste d'autres, s'arrêter et
comprendre pourquoi avant d'écrire quoi que ce soit.

`--include-all` n'est **pas** utilisé : on n'applique que ce qui est en attente et
connu de l'historique.

## Étape 3 — Historique APRÈS

```sh
npx supabase migration list --linked            # ← HISTORIQUE APRÈS, à conserver
```

**Attendu :** les deux lignes alignées `Local` / `Remote`.

## Étape 4 — Existence des deux tables

Éditeur SQL du projet staging, en lecture seule :

```sql
select table_name,
       (select count(*) from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = t.table_name) as colonnes
from information_schema.tables t
where table_schema = 'public'
  and table_name in ('prospector_ai_ledger', 'prospector_ai_reservations')
order by 1;

-- RLS active sur les deux, aucune policy (cohérent avec les 6 tables legacy)
select tablename, rowsecurity from pg_tables
where schemaname = 'public' and tablename like 'prospector_ai_%';
select count(*) as policies from pg_policies
where schemaname = 'public' and tablename like 'prospector_ai_%';
```

**Attendu :** deux tables, `rowsecurity = true` sur les deux, `policies = 0`.

## Étape 5 — Smoke SQL : comportement des RPC et **droits du rôle `anon`**

```sh
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f scripts/smoke/c2a1_budget_smoke.sql
```

ou, sans client `psql` : coller le contenu du fichier dans l'éditeur SQL du projet
staging.

Le script couvre en un seul passage : `prospector_ai_engaged()`, une réservation
autorisée, une seconde refusée pour budget insuffisant, un règlement, la cohérence
engagement/consommation, et la non-régression des six tables legacy.

Il vérifie aussi les permissions — mais **au niveau du rôle PostgreSQL**, via
`SET LOCAL ROLE anon`. C'est une preuve de la clause `REVOKE EXECUTE … FROM anon`,
pas du chemin d'entrée réel. Voir l'étape 6.

**Le nettoyage n'est pas une étape : c'est la structure.** Tout est enveloppé dans
une transaction terminée par `ROLLBACK`. Aucune donnée de test ne peut survivre,
même si le script s'arrête en cours de route — il n'existe aucun chemin qui laisse
des lignes derrière lui. Un `DELETE` final aurait supposé qu'on arrive jusqu'à lui.

Conséquence assumée : le compteur `prospector_ai_ledger` n'est pas modifié
durablement. Un smoke test ne doit pas laisser une dépense fictive dans un compteur
budgétaire.

**Sortie attendue :** une suite de lignes `OK`, puis `SMOKE TEST C2a-1e : VERT`.
Toute anomalie lève une exception et arrête le script — il est vert ou il s'arrête.

## Étape 6 — Smoke API : **permissions de la clé anon via PostgREST**

```sh
STAGING_SUPABASE_URL='https://<ref-staging>.supabase.co' \
STAGING_SUPABASE_ANON_KEY='<clé anon staging>' \
  npm run smoke:anon
```

### Pourquoi deux scripts et non un seul

| Script | Ce qu'il prouve | Ce qu'il ne prouve pas |
|---|---|---|
| `c2a1_budget_smoke.sql` | Le **rôle PostgreSQL `anon`** n'a pas `EXECUTE` sur les RPC | Que la clé anon soit bien mappée sur ce rôle |
| `c2a1_anon_api_smoke.mjs` | La **clé anon**, via PostgREST, est refusée | Le comportement métier des RPC (couvert par le premier) |

Le critère d'acceptation porte sur la **clé**. Le rôle peut être correctement privé
de droits pendant que PostgREST mappe la clé anon vers un autre rôle, ou que la clé
soit révoquée, mal signée, ou porteuse d'un rôle inattendu. Le premier script prouve
la serrure, le second prouve la porte.

### Règles de verdict du smoke API

- **Refus de permission** (`42501`, ou clé rejetée) → **succès**, seul cas.
- **Appel autorisé** (réponse 2xx) → **échec** : régression de permissions.
- **Appel exécuté puis erreur métier** → **échec** : l'appel a franchi la porte.
- **Fonction introuvable** (`PGRST202`) → **non concluant, donc échec**. Un objet
  absent produit exactement le même échec qu'un objet protégé : le compter comme
  un succès reviendrait à déclarer sécurisée une base où la migration n'a jamais
  été appliquée.
- **Cible injoignable** → **non concluant, donc échec**, avec un message qui pointe
  la variable plutôt qu'une fausse régression.

### Précondition à vérifier AVANT de lancer le smoke API

Avec la clé de service, dans l'éditeur SQL staging :

```sql
select count(*) as open_echues
from prospector_ai_reservations
where state = 'OPEN' and expires_at <= now();
```

**Attendu : `0`.** Voir la section « effets de bord » ci-dessous — c'est cette
valeur qui rend le balayage de `reserve` sans effet si la permission était ouverte.
Tant que C2a-2 n'existe pas, la table est vide et le compte est trivialement nul.

### Garanties du smoke API — et la limite qui n'en est pas une

- **Aucune clé de service.** Le script s'arrête (code 2) s'il en détecte une dans
  l'environnement : sa présence contournerait la RLS et invaliderait le résultat.
- **La clé anon n'est jamais affichée** — seules sa présence et sa longueur le sont,
  ce qui suffit à diagnostiquer une variable vide ou tronquée.

#### Effets de bord : ce qui est garanti, et ce qui ne l'est pas

PostgreSQL vérifie `EXECUTE` **avant** d'exécuter le corps. Le risque d'écriture
n'existe donc que dans le cas de régression — permission ouverte.

**Cinq sondes sur six ne peuvent rien écrire, même autorisées.** Chacune reçoit un
argument invalide rejeté à la *première instruction* de la fonction, avant tout
verrou et toute écriture — vérifié ligne à ligne dans la migration :
`engaged()` (uniquement des `SELECT`), `bump(-1)`, `settle(…, -1, …)`,
`resolve(…, 'INVALID')`, `reconcile(…, 'INVALID')`.

**`prospector_ai_reserve()` n'offre pas cette garantie.** Son corps écrit avant de
pouvoir rendre un verdict de refus, dans cet ordre :

1. `insert into prospector_ai_ledger … on conflict do nothing` ;
2. `select … for update` — verrou, sans écriture ;
3. `update prospector_ai_reservations set state='UNRESOLVED' where state='OPEN' and expires_at <= now()`
   — **balayage paresseux, mutant** ;
4. seulement ensuite, le calcul du budget et `budget_exhausted`.

L'étape 3 est **inconditionnelle vis-à-vis des paramètres** : aucun choix
d'arguments ne la contourne. La migration étant gelée, elle n'est pas réordonnée
pour arranger le test.

**Ce qui réduit le risque à une valeur caractérisée, à défaut de le supprimer :**

- **Les cinq sondes sûres tournent d'abord, et le script s'arrête si l'une d'elles
  échoue ou reste non concluante.** `reserve` n'est jamais appelée tant qu'un doute
  subsiste. L'état résiduel se réduit donc à « anon refusé sur les cinq, mais ouvert
  sur `reserve` seule » — ce qui suppose un `GRANT` partiel fabriqué à la main.
- **`Prefer: tx=rollback`** est envoyé sur la sonde `reserve`, et l'en-tête
  `Preference-Applied` de la réponse est **inspecté puis rapporté**. Si PostgREST
  l'honore, toute écriture éventuelle est annulée avec la transaction. Le script
  dit lequel des deux cas s'est produit ; il ne le suppose pas.
- **Précondition ci-dessus** : sans réservation `OPEN` échue, l'étape 3 ne trouve
  aucune ligne et n'écrit rien.

Ces trois points rendent l'écriture improbable. Ils ne la rendent pas impossible,
et la formule « aucune donnée durable » serait donc fausse pour `reserve`.

**Sortie attendue :** six lignes `[ OK ]`, puis
`SMOKE API C2a-1e : VERT`. Aucun appel Anthropic n'est émis par l'une ou l'autre
des deux étapes : aucune clé Anthropic staging n'est requise, et aucune dépense
n'est engagée.


## Étape 7 — Non-régression des données applicatives

Le point 6 du smoke SQL compare les effectifs des six tables legacy avant et après.
Contrôle complémentaire, indépendant, à lancer **avant et après** l'étape 2 :

```sql
select 'leads' as t, count(*) from prospector_leads
union all select 'store',         count(*) from prospector_store
union all select 'settings',      count(*) from prospector_settings
union all select 'workspaces',    count(*) from prospector_workspaces
union all select 'pappers_cache', count(*) from prospector_pappers_cache
union all select 'usage',         count(*) from prospector_usage;
```

Les deux relevés doivent être identiques. La migration ne fait que **créer** des
objets neufs ; elle **lit** `prospector_usage` pour amorcer le compteur et ne
l'écrit jamais.

---

## Ce qui reste explicitement hors de ce lot

- `AI_BUDGET_RESERVATION` **n'est pas activé**. La migration pose la mécanique ;
  aucun code applicatif ne l'appelle encore — c'est C2a-2.
- **Aucune clé Anthropic staging** n'est posée.
- **Aucune migration production.** L'application en production reste conditionnée
  à A3c (adoption de l'historique) et à la porte de sauvegarde.
- **Aucune fusion dans `main`.**

## Rollback de cette étape

Si le smoke test échoue, la migration reste appliquée mais **inerte** : aucun code
ne l'appelle tant que C2a-2 n'existe pas. Il n'y a donc pas d'urgence à défaire.

Pour la retirer malgré tout : supprimer les six fonctions
(`prospector_ai_bump`, `_engaged`, `_reserve`, `_settle`, `_resolve`, `_reconcile`).
**Ne pas supprimer les deux tables** — `prospector_ai_reservations` porte un passif
et `prospector_ai_ledger` porte la consommation connue ; le supprimer ramènerait la
dépense à zéro et **relèverait** le plafond restant. Un rollback ne doit jamais
rendre plus permissif.
