# Audit — chemin de contrôle du budget IA (`ANTHROPIC_BUDGET` / `prospector_usage`)

Analyse **en lecture seule**. Aucun comportement décrit ici n'a été modifié.
État du dépôt : branche `claude/elegant-gates-jen674`, commit `10a8d5f`.

Question posée : *le repli mémoire de `prospector_usage` peut-il diminuer ou
réinitialiser la consommation utilisée par `ANTHROPIC_BUDGET`, notamment en
environnement serverless multi-instance ?*

**Réponse : oui, par cinq chemins distincts, dont trois n'exigent aucune panne.**

---

## 1. Le chemin réel

| # | Étape | Emplacement |
|---|---|---|
| 1 | `callClaude()` — court-circuit cache avant toute vérification | `lib/prospector/llm.ts:145` |
| 2 | `budgetLeft()` — décision d'autoriser | `lib/prospector/llm.ts:153` |
| 3 | lecture du plafond `ANTHROPIC_BUDGET` (euros) | `lib/prospector/llm.ts` (`getKey`) |
| 4 | lecture de la consommation : `getUsageAll()['ai:cents'] / 100` | `lib/supabase/pappersCache.ts:58` |
| 5 | verdict `blocked = budget > 0 && spent >= budget` | `lib/prospector/llm.ts` |
| 6 | **appel HTTP Anthropic** | `lib/prospector/llm.ts` |
| 7 | `recordAiUsage()` — écriture **après** l'appel | `lib/prospector/llm.ts:196` |
| 8 | 12 × `bumpUsage()` en `Promise.all`, `try/catch` englobant | `lib/prospector/usage.ts:22-34` |
| 9 | `bumpUsage()` : `select` puis `upsert` | `lib/supabase/pappersCache.ts:33-46` |

`prospector_usage`, clé `ai:cents`, est la **seule** source du calcul de blocage.
Aucune autre table, aucun compteur en mémoire de processus ne participe à la
décision — sauf par repli, ce qui est précisément le problème.

## 2. Les cinq chemins de perte

**(a) La lecture en erreur renvoie zéro, sans même consulter la mémoire.**
`getUsageAll()` (`pappersCache.ts:62-65`) : `supabase-js` ne lève pas sur erreur
applicative, il renvoie `{ data: null, error }`. Le code ignore `error` et fait
`(data || []).forEach(...)`, donc **`{}`** → `spent = 0` → `blocked = false`.
Le `catch` en ligne 66 (qui, lui, rendrait `memUsage`) ne se déclenche que sur
exception réseau. Une table momentanément inaccessible ne dégrade pas le
contrôle : elle l'annule.

**(b) L'écriture est postérieure à la dépense.** Étape 7 après étape 6 : la
consommation n'est jamais réservée, seulement constatée. Sous rafale, N appels
concurrents lisent tous le même `spent` d'avant.

**(c) `recordAiUsage()` avale toute exception** (`usage.ts:22-34`). Un échec
d'écriture durable fige `spent` à sa dernière valeur écrite : le budget **ne
bloque plus jamais**, en silence, sans trace.

**(d) Le repli mémoire est par instance et meurt avec elle.** `memUsage` vit sur
`globalThis` (`pappersCache.ts:14`). En serverless, chaque instance froide
repart de `{}`. Deux effets cumulés : les incréments repliés en mémoire ne sont
jamais réconciliés vers la table, et un appelant servi par une instance neuve
lit `spent = 0`.

**(e) `bumpUsage()` perd des incréments même quand la base fonctionne.**
`select` puis `upsert` d'une valeur calculée côté client (`pappersCache.ts:41-43`)
est un read-modify-write non atomique : deux exécutions concurrentes écrivent
toutes deux `cur + by`, l'une écrase l'autre. Aucune contrainte ne le détecte —
c'est un `upsert`, pas un `insert`.

**(f, aggravant — introduit par moi au lot A2.)** `bumpUsage()` ligne 37 : si
`writeAllowed('prospector_usage')` est faux, l'incrément part en mémoire et la
fonction **renvoie un succès**. Mon garde-fou d'écriture a donc ajouté un sixième
chemin de fuite au compteur budgétaire. C'est un défaut de ma part, à corriger
avec le reste.

## 3. Multi-instance : le plafond est multiplié

Le compteur étant lu avant et écrit après, sans réservation ni atomicité, **N
instances concurrentes peuvent chacune dépenser jusqu'au plafond**. Le budget
n'est pas un plafond global : c'est un plafond par instance, dans le meilleur
des cas.

Second point, indépendant : `prospector_usage` n'a **pas** de `workspace_id`
(`supabase/schema.sql`). Le compteur est global à la plateforme. Un budget par
espace de travail, ou une refacturation, sont aujourd'hui impossibles.

## 4. Conclusion

Le contrôle budgétaire est **fail-open sur toute sa longueur**. En conditions
nominales mono-instance il fonctionne ; dès qu'il y a concurrence, instance
froide, ou indisponibilité de la table, il n'offre aucune garantie. Il ne doit
pas être présenté comme une protection de dépense.

## 5. Correction proposée (non appliquée)

À traiter dans un lot dédié, après arbitrage :

1. **Trois états explicites** au lieu de deux : budget non défini → pas de garde ;
   consommation lisible → comportement actuel ; **budget défini mais consommation
   illisible ou non inscriptible → refus**, motif `usage_unavailable`. C'est le
   seul changement qui transforme le fail-open en fail-closed.
2. **Incrément atomique** par RPC PostgreSQL :
   `insert ... on conflict (key) do update set count = prospector_usage.count + excluded.count`.
   Supprime (e) et rend la valeur lue fiable.
3. **Pré-charge pessimiste** : réserver une estimation avant l'appel, réconcilier
   après avec le coût réel. Supprime (b).
4. **Ne plus avaler les erreurs** dans `recordAiUsage()` : remonter un état
   « suivi de consommation dégradé » visible dans l'interface, plutôt qu'un
   silence.
5. **Retirer le repli mémoire du chemin budgétaire** (le conserver pour les
   compteurs non budgétaires) : un compteur qui ment est pire qu'un compteur
   absent.
6. Ajouter `workspace_id` à `prospector_usage` — dépend du lot A3b.

Les points 1, 2 et 4 sont indépendants et suffisent à supprimer les régressions
les plus graves. Le point 3 change le modèle de coût et mérite un arbitrage
séparé. Le point 6 est bloqué par la baseline de migrations.
