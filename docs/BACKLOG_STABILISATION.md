# Backlog de stabilisation — état des lots

Document d'état, tenu à jour lot par lot. Il ne remplace pas les commits : il dit
où on en est et ce qui bloque quoi. Toute affirmation ici renvoie à un fichier,
un commit ou un document vérifiable.

Branche de travail : `claude/elegant-gates-jen674`. **Rien n'est fusionné dans
`main`, rien n'est déployé.**

---

## Sécurité financière (budget IA)

| Lot | État | Portée |
|---|---|---|
| **C1 — garde-fou fail-safe** | **Implémenté** (`6b6d213`) | P0 **fortement mitigé**, non fermé |
| **C2 — réservation atomique** | **Non commencé, bloquant** | Requis avant le niveau de sécurité financière définitif |
| **Usage par `workspace_id`** | Non commencé | Requis avant tout budget client individualisé |

### C1 — implémenté, P0 fortement mitigé

Ce qui est fermé : la lecture de consommation est durable ou l'appel est refusé ;
une erreur Supabase n'est plus jamais interprétée comme `spent = 0` ; le repli
mémoire ne peut plus autoriser un appel payant ; `writeAllowed('prospector_usage')`
faux bloque avant Anthropic ; `usage_unavailable` est distinct de
`budget_exhausted` jusque dans l'écran Admin.

Ce qui reste ouvert, et pourquoi le P0 n'est **pas** déclaré fermé : une écriture
de consommation peut échouer **après** un appel alors que les lectures suivantes
restent disponibles. Le compteur reste alors obsolète et `budgetLeft()` lit une
valeur périmée en toute confiance — pour lui, la lecture a réussi. Une base qui
accepte les `select` mais refuse les `upsert` (table en lecture seule, quota,
droit retiré) échappe donc entièrement au garde-fou.

Référence : `docs/AUDIT_BUDGET_IA.md`, `lib/prospector/llm.ts` (`budgetLeft`),
`lib/supabase/pappersCache.ts` (`readUsageDurable`), `tests/budget-guard.test.ts`.

### C2 — bloquant avant le niveau de sécurité financière définitif

**À traiter après A3b** (exige une migration, donc la baseline de migrations).
Contenu retenu : réservation / incrément **atomique avant l'appel**, réconciliation
avec le coût réel **après l'appel**.

Ce que C2 ferme et que C1 laisse ouvert :
- `bumpUsage()` est un `select` puis `upsert` non atomique — deux écritures
  simultanées écrivent chacune `cur + by` et l'une écrase l'autre ;
- la lecture reste antérieure à la dépense, sans réservation : N instances
  concurrentes peuvent dépasser le plafond ;
- l'échec d'écriture postérieur à l'appel, décrit ci-dessus.

**Tant que C2 n'est pas fait, `ANTHROPIC_BUDGET` ne doit pas être présenté comme
une garantie de dépense.** C'est une protection sérieuse en usage mono-instance
nominal, pas un plafond opposable.

### Usage par `workspace_id`

`prospector_usage` n'a pas de colonne `workspace_id` (`supabase/schema.sql`) : le
compteur est global à la plateforme. **Requis avant tout budget client
individualisé** et avant toute refacturation. Traité séparément, dans l'évolution
multi-tenant — pas dans C2.

---

## Lots de stabilisation précédents

| Lot | État | Note |
|---|---|---|
| A0 — correction de la documentation | Livré (`45c4bd0`) | |
| A1 / A1b — tests et empreinte de build | Livré (`92426fa`, `3d5106f`) | |
| A3a — structure de migrations | Livré (`2e17938`) | `supabase/migrations/` volontairement vide |
| **A3b — baseline de migrations** | **Non commencé, bloquant** | Exige les accès Supabase. Bloque C2 et la suppression de `schema.sql` |
| A2 — contrat d'environnement | Livré (`ab4b9c7`) | `APP_ENV_STRICT` **transitoire** |
| B — isolation par espace de travail | Livré (`10a8d5f`) | Tests d'intégration **écrits, jamais exécutés** |
| Outillage CI | Livré (`be0a2f0`) | Workflow d'intégration livré, **jamais exécuté** |
| A4a / A4b — adoption ESLint | Non commencé | `docs/LINT_BASELINE.md` |

### Points en attente d'une action extérieure

- **Exécution réelle des tests d'intégration B.** `.github/workflows/integration.yml`
  est livré mais n'a jamais tourné : `workflow_dispatch` n'est exposé que si le
  fichier est sur la branche par défaut, et le déclencheur `pull_request` suppose
  une PR ouverte. **Le lot B n'est pas déclarable déployable** tant que ces six
  cas n'ont pas été exécutés contre un vrai PostgreSQL.
- **`APP_ENV_STRICT` est transitoire.** À activer sur staging, puis en production,
  avant fusion ; le mode permissif sera retiré dans un lot ultérieur. ⚠️ Depuis C1,
  l'activation a une portée plus large qu'avant : avec un budget positif saisi, une
  incohérence d'environnement ne suspend plus seulement les écritures, elle coupe
  **toute la surface IA**. À constater sur staging avant production.
- **Staging Vercel / Supabase isolé.** Non créé (aucune ressource externe n'est
  créée depuis cette session). Prérequis de la fusion.
