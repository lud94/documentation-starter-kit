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

## Étape 5 et 6 — Smoke test et permissions

```sh
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f scripts/smoke/c2a1_budget_smoke.sql
```

ou, sans client `psql` : coller le contenu du fichier dans l'éditeur SQL du projet
staging.

Le script couvre en un seul passage : `prospector_ai_engaged()`, une réservation
autorisée, une seconde refusée pour budget insuffisant, un règlement, la cohérence
engagement/consommation, le refus de la clé `anon` sur les quatre RPC, et la
non-régression des six tables legacy.

**Le nettoyage n'est pas une étape : c'est la structure.** Tout est enveloppé dans
une transaction terminée par `ROLLBACK`. Aucune donnée de test ne peut survivre,
même si le script s'arrête en cours de route — il n'existe aucun chemin qui laisse
des lignes derrière lui. Un `DELETE` final aurait supposé qu'on arrive jusqu'à lui.

Conséquence assumée : le compteur `prospector_ai_ledger` n'est pas modifié
durablement. Un smoke test ne doit pas laisser une dépense fictive dans un compteur
budgétaire.

**Aucun appel Anthropic**, donc aucune clé Anthropic staging requise, et aucune
dépense.

**Sortie attendue :** une suite de lignes `OK`, puis `SMOKE TEST C2a-1e : VERT`.
Toute anomalie lève une exception et arrête le script — il est vert ou il s'arrête.

## Étape 7 — Non-régression des données applicatives

Le point 6 du script compare les effectifs des six tables legacy avant et après.
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
