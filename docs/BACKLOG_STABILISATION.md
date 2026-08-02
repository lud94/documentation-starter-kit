# Backlog de stabilisation — état des lots

Document d'état, tenu à jour lot par lot. Il ne remplace pas les commits : il dit
où on en est et ce qui bloque quoi. Toute affirmation ici renvoie à un fichier,
un commit ou un document vérifiable.

Branche de travail : `claude/elegant-gates-jen674`. **Rien n'est fusionné dans
`main`, aucune migration ni promotion production.** La branche déclenche en
revanche des déploiements et des checks Vercel automatiques : « rien n'est
déployé » serait faux.

---

## Sécurité financière (budget IA)

| Lot | État | Portée |
|---|---|---|
| **C1 — garde-fou fail-safe** | **Implémenté** (`6b6d213`) | P0 **fortement mitigé**, non fermé |
| **C2a — réservation atomique** | **En cours** — C2a-0 et C2a-1 **fermés** (26/26 tests d'intégration verts, run `30762229894`) | Requis avant le niveau de sécurité financière définitif |
| **C2c — réconciliation facturation** | Non commencé | Aucun chiffre plateforme n'est une facture avant ce lot |
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

### C2c — réconciliation avec la facturation Anthropic

**Non commencé.** Deux besoins distincts, réunis parce qu'ils dépendent tous deux
d'une source externe :

1. **Réconciliation courante.** `settled_micros` est un coût **calculé** à partir
   des tokens renvoyés et de tarifs saisis dans `lib/prospector/money.ts`.
   Anthropic ne nous communique aucun montant facturé. Tant que C2c n'existe pas,
   aucun chiffre de la plateforme ne doit être présenté comme une facture.
2. **Cutover de l'historique de production.** Le compteur `ai:usd_micros` est
   initialisé à `ai:cents × 10000` par la migration C2a-1. C'est une **conversion
   d'unité, pas une reconstruction** : `ai:cents` sous-comptait — mesuré, un appel
   Jarvis sur Haiku coûtait 0,28 cent et était arrondi à zéro, donc les appels les
   plus nombreux n'ont jamais été comptés. La valeur de départ est un **minorant**
   de la dépense historique réelle. C2a ne tente pas de la corriger : reconstruire
   un historique à partir d'un compteur dont on a prouvé qu'il ment produirait un
   chiffre faux présenté comme exact. La décision de réconciliation ou de remise à
   zéro au moment de la promotion en production appartient à C2c.

### Usage par `workspace_id`

`prospector_usage` n'a pas de colonne `workspace_id` (baseline A3b, ligne 99) : le
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
| **A3b — baseline de migrations** | **Livré** (`f3bc894`) | Baseline réelle de production ; `schema.sql` et la fixture temporaire supprimés |
| A2 — contrat d'environnement | Livré (`ab4b9c7`) | `APP_ENV_STRICT` **transitoire** |
| B — isolation par espace de travail | **Livré et vérifié** (`10a8d5f`) | 6/6 tests d'intégration verts contre PostgreSQL réel (run `30762229894`) |
| Outillage CI | Livré (`be0a2f0`, `ef739c1`, `ae13c75`) | Gardes mutations Supabase + passerelle Anthropic. Workflow d'intégration **opérationnel et vert** |
| A4a / A4b — adoption ESLint | Non commencé | `docs/LINT_BASELINE.md` |

### Points en attente d'une action extérieure

- **Tests d'intégration : opérationnels.** Déclenchés par la Draft PR #1,
  26/26 verts (run `30762229894`). Le lot B est vérifié contre un vrai PostgreSQL.
  La migration `20260802090000_ai_budget_reservation.sql` est **gelée** : toute
  évolution passe par une nouvelle migration, jamais par une correction en place.
- **C2a-1e — application au staging.** Procédure dans
  `docs/C2A1E_STAGING_PROCEDURE.md`, smoke test dans
  `scripts/smoke/c2a1_budget_smoke.sql`. **Non exécutée** : la session d'assistance
  n'a ni jeton Supabase ni rattachement de projet.
- **`APP_ENV_STRICT` est transitoire.** À activer sur staging, puis en production,
  avant fusion ; le mode permissif sera retiré dans un lot ultérieur. ⚠️ Depuis C1,
  l'activation a une portée plus large qu'avant : avec un budget positif saisi, une
  incohérence d'environnement ne suspend plus seulement les écritures, elle coupe
  **toute la surface IA**. À constater sur staging avant production.
- **Staging Vercel / Supabase isolé.** **Créé et validé** : `/api/config/status`
  rend `configured`, `matrixOk`, `supabaseOk`, `strict` vrais et `issues: []`.
- **A3c — adoption de l'historique de migrations en production.** Avant la première
  migration structurelle production, la baseline devra être marquée comme déjà
  appliquée dans l'historique natif Supabase, sans rejouer son SQL. Non fait.
- **Porte de sauvegarde production.** Aucune migration structurelle production
  autorisée avant l'existence d'une sauvegarde et d'une restauration vérifiables.
- **RLS / isolation locataire en base.** RLS active, aucune policy : l'isolation
  reste principalement applicative. Traité avec le modèle relationnel Prospector V3,
  pas bricolé dans le legacy.
