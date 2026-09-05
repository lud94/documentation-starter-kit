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
| **C2a — réservation atomique** | **En cours** — C2a-0, C2a-1, C2a-1e **fermés** ; **C2a-2 implémenté**, mode `OFF` | Requis avant le niveau de sécurité financière définitif |
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

### C2a-2 — réservation dans la passerelle : implémenté, non activé

`AI_BUDGET_RESERVATION` accepte trois valeurs : `OFF` (défaut d'exécution),
`OBSERVE`, `ENFORCE`. **Aucun environnement n'est activé** — le défaut du code
est `OFF`, et toute valeur non reconnue vaut `OFF`, jamais `ENFORCE`.

Une réservation est posée par **vraie requête HTTP Anthropic**, dans
`anthropicPost()` — donc y compris pour `/api/ai/diagnose`, qui échappait au
comptage. Un `callClaude()` pathologique (4 tours × 4 tentatives de dégradation)
produit jusqu'à 16 réservations, ce qui est le nombre exact de dépenses.

`OBSERVE` transmet un plafond **nul** au RPC : `prospector_ai_reserve` ne teste
le budget que `if p_budget_micros > 0`, donc `budget_exhausted` y est
inatteignable par construction. La décision hypothétique `would_have_blocked`
est calculée à part, à partir de `AI_BUDGET_OBSERVE_LIMIT` — variable
**strictement informative**, qui n'emprunte aucun chemin capable de refuser un
appel. En `OBSERVE`, le garde **C1 est neutralisé dans `callClaude()`** : sans
cela un `ANTHROPIC_BUDGET` oublié refuserait des appels en amont de la
passerelle, et la fenêtre mesurerait un trafic déjà écrêté — donc un taux de
refus sous-estimé, l'erreur dans le sens le plus dangereux pour une calibration.
La présence de la variable est signalée comme configuration incohérente. `OFF` et
`ENFORCE` conservent C1 inchangé.

**Le zéro n'est pas une absence.** `ANTHROPIC_BUDGET=0` signifie « aucune dépense
autorisée » (contrat C1), alors que `p_budget_micros = 0` signifie « aucun
plafond » côté RPC. Les confondre inverserait la sémantique. Le cas est donc
tranché dans la passerelle, avant toute RPC et tout `fetch` — ce qui ferme le
contournement des appelants directs d'`anthropicPost()`, `/api/ai/diagnose` en
tête, que C1 ne couvrait pas. Quatre cas distincts : absent = aucun plafond ;
`0` = hard stop ; `> 0` = plafond transmis ; illisible = fail closed.

**Coût non bornable.** `web_fetch` n'a pas de coût d'outil : seuls les tokens du
contenu récupéré sont facturés. Ils ne sont bornables que par
`max_content_tokens` — **qui n'est déclaré sur aucun des deux sites** qui
utilisent l'outil (`lib/prospector/signals.ts`, `pages/api/ai/diagnose.ts`).
L'estimation porte donc `complete: false` et nomme la composante manquante ; la
valeur 0 correspondante ne doit **jamais** être lue comme un coût nul. En
`OBSERVE` l'appel passe ; en `ENFORCE` avec un plafond positif il est refusé,
plutôt que d'arbitrer un plafond sur une estimation qui n'est pas un majorant.
Même règle pour un **type d'outil serveur non modélisé** : seuls `web_search` et
`web_fetch` ont un modèle de coût supporté ; tout autre type rend l'estimation
incomplète, car il peut se facturer au token, à la seconde ou au volume.

`RELEASED` n'est accordé qu'aux statuts dont la non-facturation est établie
(400, 401, 403, 404, 413, 422, 429) — **une liste, pas un intervalle** : un
`status < 500 ⇒ RELEASED` universel libérerait des codes dont on ne sait rien.
Tout le reste, y compris un 4xx non répertorié et toute exception de transport,
tombe en `UNRESOLVED`.

`/api/ai/diagnose` : dès qu'**une** sonde est refusée par le garde, le verdict
parle du budget et de rien d'autre. Sans ce tri, la sonde `web_fetch` — qui ne
déclare pas `max_content_tokens`, donc refusée en `ENFORCE` sous plafond — se
serait lue comme une incapacité de la clé Anthropic, jamais sollicitée.

Télémétrie de calibration : journaux structurés (marqueur `c2a2.telemetry`),
corrélés à la comptabilité par `reservation_id`. Aucune donnée métier, aucun
prompt, aucune réponse, aucune clé. **La table financière reste la source de
vérité** ; un agrégat tiré des journaux doit se recouper avec
`sum(settled_micros)`, faute de quoi ce sont les journaux qui sont invalides.

Reste ouvert avant `ENFORCE` : bornes `max_content_tokens` à définir, plafond
représentatif à dériver des mesures, réglages surdimensionnés à instruire
(`signals.ts` lance 6 passes `research` en parallèle). Aucun de ces réglages
métier n'est modifié par ce lot.

### C2a-2c — instruments de calibration, aucune politique changée

**Ce que les mesures staging ont réfuté.** `bodyBytes / 3` n'est pas un majorant :
Sonnet sans outil, corps de 2 400 octets → 800 tokens estimés contre **945
réels** (−18 %). Le ratio de 3 octets par token est une moyenne de prose
anglaise ; nos corps sont du JSON structuré en français. **Aucun coefficient
n'est réajusté** — corriger « /3 » sur cinq observations remplacerait une erreur
mesurée par une autre, non mesurée. La valeur reste, explicitement étiquetée
indicative.

**Déclarer un outil serveur coûte, même sans exécution.** Même sonde, même
prompt (~59 tokens de corps) : `web_search` déclaré → 2 809 tokens d'entrée ;
`web_fetch` déclaré → 4 619. Aucune page n'a été récupérée dans le second cas —
`output_tokens = 4`, et `web_fetch` ne peut fetcher qu'une URL déjà présente dans
la conversation, or le prompt n'en contenait aucune. **Déclaré ≠ exécuté.**

**Ce que la documentation Anthropic établit**, vérifié à la source :

| Composante | Bornable avant l'appel ? | Par quoi |
|---|---|---|
| Sortie | oui | `max_tokens`, plafond dur |
| Frais `web_search` | oui | `max_uses` × 0,01 $ (*$10 per 1,000 searches*) |
| **Tokens de résultats `web_search`** | **non** | aucun paramètre ne les borne |
| `web_fetch` — contenu texte | oui si `max_content_tokens` posé | approximatif |
| **`web_fetch` — contenu binaire (PDF)** | **non** | *« The limit applies to text content, not to binary content such as PDFs »* — ~125 000 tokens pour 500 kB |

`web_fetch` n'a **aucun frais par requête** (*« no additional charges beyond
standard token costs »*) : son compteur est un signal d'usage, jamais un coût.

**Deux listes désormais distinctes**, et c'est délibéré :
`unbounded` porte la vérité complète ; `incomplete` porte le sous-ensemble sur
lequel la porte `ENFORCE` refuse **aujourd'hui**, contrat C2a-2b **conservé à
l'identique**. `incomplete ⊆ unbounded`, l'inclusion étant stricte dès qu'un
`web_search` ou un `web_fetch` borné en texte est déclaré. **L'écart entre les
deux est la décision différée** : `ENFORCE` doit-il devenir un plafond dur
strict, un garde opérationnel tolérant, ou deux niveaux distincts ? Ce lot livre
l'instrument de mesure, pas l'arbitrage.

**Précomptage fournisseur** (`lib/prospector/tokenCount.ts`,
`POST /v1/messages/count_tokens`) : gratuit, pool de limites de débit
indépendant, il voit l'entrée réelle **et** l'overhead de déclaration des outils
(*« Server tool token counts only apply to the first sampling call »*).
⚠️ **Ce n'est pas une borne** — Anthropic le donne pour une *estimation* pouvant
différer légèrement. **Aucun chemin de requête ne l'appelle dans ce lot** : ni en
`OFF`, ni en `OBSERVE`, ni devant un appel Messages, et il ne change aucune
décision `ENFORCE`. La politique d'appel sera arbitrée séparément. Sonde
`scripts/smoke/c2a2c_token_count_probe.mjs` (T1/T2/T3), livrée **non exécutée**.

**Écart de mesure connu, non corrigé :** la documentation dit qu'une recherche en
erreur n'est pas facturée, sans dire si `web_search_requests` l'inclut. Le
règlement peut donc sur-régler — sens conservateur, jamais un sous-comptage. La
télémétrie porte désormais de quoi trancher (compteur fournisseur vs blocs
réussis/en erreur).

**Versions des outils**, constatées et **non modifiées** : Prospector utilise
`web_search_20250305` (basique, **sans filtrage dynamique** — donc tous les
résultats entrent dans le contexte, ce qui est précisément la composante non
bornée) et `web_fetch_20260209` (filtrage dynamique). Dernières documentées :
`web_search_20260318` et `web_fetch_20260318`. `response_inclusion: "excluded"`
(20260318+) supprimerait les blocs de résultat de la réponse — raison
supplémentaire de faire des compteurs fournisseur la source primaire.

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
