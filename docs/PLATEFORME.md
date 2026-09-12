# Prospector — état réel de la plateforme

Document d'inventaire, écrit pour servir de base à un brainstorm d'architecture.
Il décrit **ce qui existe dans le code**, en distinguant systématiquement ce qui
fonctionne réellement, ce qui attend une clé d'API, et ce qui est encore simulé.

Dernière mise à jour : branche `claude/elegant-gates-jen674`.

⚠️ **Écart production / branche — constat daté du 31 juillet 2026.** Au moment de
l'audit, `main` était en retard de **8 commits** sur cette branche, et les correctifs
décrits ici étaient compilés sans avoir jamais été exécutés. **Ce chiffre se périme à
chaque commit** : ne pas le citer sans l'avoir revérifié.

```sh
git fetch origin
git rev-list --left-right --count origin/main...claude/elegant-gates-jen674
git log --oneline origin/main..claude/elegant-gates-jen674
```

---

## 1. Ce qu'est Prospector

Plateforme d'acquisition B2B en sortant (outbound) pour ESN et cabinets de conseil.
La promesse : trouver des entreprises cibles, résoudre les bons interlocuteurs,
détecter un signal d'actualité qui justifie la prise de contact, et dérouler une
séquence multicanale — le tout piloté par un assistant conversationnel (Jarvis)
accessible depuis le web, une extension Chrome et Telegram.

**Modèle métier des données** : deux niveaux.
- Un **compte** (`kind: 'account'`) = une entreprise. C'est ce que crée un import.
- Un **contact** (`kind: 'contact'`) = une personne rattachée à un compte.
Un compte sans personne nommée reste un compte : il n'entre pas dans « à inviter ».

---

## 2. Stack et contraintes

| Élément | Choix | Remarque |
|---|---|---|
| Framework | Next.js 13, **Pages Router** | pas d'App Router, pas de Server Components |
| Langage | TypeScript | |
| Style | Tailwind | fond `#f0f2f8`, classe `.card`, dégradé `#667eea → #764ba2` |
| Hébergement | Vercel | fonctions serverless, `maxDuration = 60` sur les routes IA |
| Base | Supabase (PostgreSQL) | accès **serveur uniquement**, via la clé de service |
| Aucun autre service | — | pas de Redis, pas de file d'attente externe, pas de stockage objet |

**Piège serverless à connaître** : répondre au client avant d'avoir fini le travail
asynchrone gèle la fonction et le reste ne s'exécute jamais. Rencontré deux fois
(enregistrement des clés, puis webhook Telegram). Règle : on traite, **puis** on répond.

---

## 3. Modèle de persistance — point important pour toute refonte

Il n'y a **pas de schéma relationnel métier**. Les objets vivent en JSONB, répartis
entre une table dédiée aux leads (voir ci-dessous) et un magasin documentaire
générique :

```sql
prospector_store (kind text, id text, workspace_id text, data jsonb, updated_at)
-- clé primaire (kind, id, workspace_id)
```

`kind` vaut `list`, `sequence`, `mission`, `task`, `aicache`, `tgpending`, `wsver`… et
`data` porte l'objet JSON complet. **Il n'existe aucun `kind` `lead`, `account` ou
`contact`** : ces objets vivent dans `prospector_leads`. Il existe un repli en mémoire quand Supabase
n'est pas configuré.

Tables dédiées existantes :

| Table | Rôle |
|---|---|
| `prospector_leads` | **comptes ET contacts** — une ligne par `Lead`, `data` en JSONB. C'est ici que vit le cœur métier, **pas** dans `prospector_store` |
| `prospector_settings` | keystore durable (clés API, hash du mot de passe, secret MFA) |
| `prospector_workspaces` | **espaces clients** — c'est déjà le concept de « tenant » |
| `prospector_pappers_cache` | cache par SIREN |
| `prospector_usage` | compteurs de consommation |

⚠️ **Défaut connu, classé P0** : la clé primaire de `prospector_leads` est `id` **seul**
(`supabase/schema.sql:43`), alors que `prospector_store` est partitionné par
`(kind, id, workspace_id)`. Combiné à l'`onConflict: 'id'` de `lib/supabase/leads.ts`,
une écriture sur un identifiant existant écrase la ligne **et déplace son
`workspace_id`**. La lecture et la suppression filtrent correctement par espace ;
l'écriture, non.

**Conséquence pour un projet de couche signaux** : introduire des tables
relationnelles (`companies`, `signals`, `signal_evidence`…) n'est pas « ajouter des
tables », c'est faire cohabiter deux modèles de persistance et migrer les comptes
existants. Et le `tenant_id` d'une future spec correspond aux
`prospector_workspaces` déjà en place — ne pas créer de notion parallèle.

---

## 4. Authentification, rôles, multi-tenant

- Session par cookie signé (`lib/auth/session.ts`), MFA TOTP disponible.
- `middleware.ts` protège tout sauf une liste blanche (`/login`, les routes d'auth,
  le webhook Telegram, l'agent Jarvis de l'extension, `/api/version`).
- Deux rôles : **admin** (Smart.AI) et **client** (portail restreint `/client/*`).
- Chaque espace client a des **permissions** en JSONB qui filtrent la navigation.
- **Jetons par espace dérivés par HMAC**, avec numéro de version → révocation
  possible d'un seul client sans impacter les autres (`lib/prospector/wstoken.ts`).
- Les clés API sont **saisies dans l'application** (Admin → Connexions) et stockées
  dans le keystore. Seules `SUPABASE_*` et la clé de service restent en variables
  d'environnement Vercel, jamais exposées au navigateur.

---

## 5. Les écrans

### Actions du jour (`/actions`)
File de travail quotidienne : ce qu'il faut faire, dans l'ordre. Point d'entrée
par défaut d'un commercial.

### Tableau de bord (`/`)
Indicateurs de pipeline, activité récente, raccourcis.

### Sourcing (`/sourcing`) — 4 onglets
1. **Recherche par critères** — data.gouv / SIRENE en direct. Secteur (NAF),
   localisation, taille, âge. Filtres « actif seulement » et « exclure ceux déjà en
   pipeline », pagination avec chargement progressif, export CSV.
   *Statut : réel et fonctionnel.*
2. **Recherche par signal** — voir §8, c'est le sujet en cours.
3. **Personnes** — recherche de profils via Unipile.
   *Statut : simulé tant qu'Unipile n'est pas connecté (bandeau d'avertissement affiché).*
4. **Prospects** — résultats consolidés, résolution de contacts en lot (plafonnée).

### Pipeline & Leads (`/pipeline`)
Vue par onglets **Comptes** / **Contacts** / étapes du pipeline. Recherche, filtres,
actions individuelles. Import CSV. Création manuelle.

### Fiche compte / contact (`/leads/[id]`)
La fiche la plus riche : identité légale (SIREN, NAF, ville, effectif, dirigeant issu
de data.gouv), site web, contacts rattachés, signal et accroche, notes de recherche,
listes et séquences d'appartenance, historique. Héritage vivant compte → contact
pour les données d'entreprise. Bouton « Demander à une IA externe » (voir §7).

### Missions (`/missions`)
Module agentique : contrat de mission, écran de validation, orchestrateur pas à pas.
Une étape par appel d'API, l'état est persisté, pause obligatoire avant les étapes
sensibles ou coûteuses. Six outils fermés (`lib/prospector/missionTools.ts`), plafonds
`MAX_COMPANIES = 50`, `MAX_ENRICH = 10`.

### Listes (`/lists`)
CRUD complet, export CSV avec présélections de colonnes, déploiement d'une liste vers
une séquence.

### Séquences (`/sequences`)
Construction de séquences multicanales et suivi.
*Statut : l'envoi réel attend Unipile / le canal e-mail.*

### Inbox (`/inbox`)
Réponses et conversations.
*Statut : dépend des canaux, donc partiellement en attente.*

### Planning (`/planning`)
Tâches et rappels datés.

### Cerveau IA (`/brain`)
Prompts des agents et base de connaissance.
*Statut : **lecture seule assumée** — les prompts affichés sont versionnés dans le
code et ne pilotent pas l'IA depuis cet écran ; le RAG n'est pas branché. Les boutons
sont explicitement désactivés plutôt que faussement actifs.*

### Admin (`/admin`)
Connexions (clés API), espaces clients, usage et budget IA, canaux mobiles
(appairage Telegram), diagnostic, sécurité (MFA, réinitialisation).

### Portail client (`/client`, `/client/pipeline`, `/client/conversations`)
Vue restreinte pour un client final, filtrée par permissions.

---

## 6. Jarvis — un cerveau, trois canaux

Le même agent (`lib/prospector/jarvisAgent.ts`) sert :
1. **l'application web** — barre omniprésente + raccourci `⌘K` ;
2. **l'extension Chrome** — widget en shadow DOM, déplaçable ;
3. **Telegram** — webhook + appairage par code à 6 chiffres, à usage unique, 15 min.

`planJarvis()` interprète la demande et renvoie une action ; `executeJarvis()`
l'exécute. Actions disponibles : sourcing d'entreprises, recherche sur une personne,
réponse web, statistiques, recherche de lead, explication d'un compte, ajout de
compte ou de personne, ajout à une liste ou à une séquence, changement de statut,
prise de note.

**Toute action d'écriture demande une confirmation** — bouton dans l'app, boutons
inline sur Telegram.

---

## 7. Couche IA — coûts et garde-fous

Tout passe par un point de contrôle unique : `lib/prospector/llm.ts`.

- **Routage par tâche** : `chat` et `classify` → Haiku ; `plan`, `extract`, `write`,
  `research` → Sonnet. (Opus coûte environ 19 fois Haiku.)
- **Mise en cache du prompt système** côté Anthropic → tokens répétés facturés ~10 %.
- **Cache de résultats** 7 jours dans le magasin (`kind = 'aicache'`), clé incluant
  le modèle. Une réponse tronquée n'est jamais mise en cache.
- **Garde-fou de budget bloquant** : `ANTHROPIC_BUDGET`. Au-delà, l'appel est refusé
  avec un message explicite, pas dégradé en silence.
- **Reprise `pause_turn`** : la boucle d'outils serveur d'Anthropic est relancée au
  lieu d'être abandonnée à mi-chemin.
- **Dégradation sur option refusée** : sur une erreur 400, l'option mise en cause est
  retirée et l'appel rejoué (jusqu'à 3 fois). Une capacité non activée sur la clé
  donne un résultat dégradé, plus une page d'erreur.
- **`/api/ai/diagnose`** teste séparément l'appel simple, le réglage d'effort, la
  recherche web et la lecture de page, et rend un verdict lisible.

**IA externe** (`components/AskExternalAI.tsx`) : ouvre le Claude / ChatGPT /
Perplexity **de l'utilisateur** avec un prompt pré-rédigé, puis récupère le résultat
par collage. Coût nul en tokens. Bandeau d'avertissement, anonymisation des noms
possible, interrupteur par espace de travail.

---

## 8. Recherche par signal — l'état du sujet en cours

**Ce que ça fait** : un agent Claude avec recherche web cherche des entreprises
émettant un signal (levée, recrutement, actualité), et propose une accroche.

**Ce qui a été corrigé sur la branche** :
- plus aucune liste blanche de domaines (elle provoquait un échec total quand un
  domaine bloquait le crawler d'Anthropic — c'est la panne qui a occupé la journée) ;
- ciblage strict : contrainte dans le prompt **et** post-filtre serveur, pour que
  « ESN qui recrutent » ne remonte pas des levées de fonds ;
- toute entrée sans URL de source est rejetée ;
- vérification data.gouv déplacée **à l'import**, plus pendant la recherche ;
- balayage par mois (une passe par mois) au lieu d'une requête unique ;
- `web_fetch` activé quand le modèle le supporte, pour ouvrir les articles
  récapitulatifs plutôt que de lire des extraits ;
- suppression totale des données de démonstration : plus aucun résultat fabriqué.

**Ce qui ne marche toujours pas** : la **couverture**. Sur « toutes les levées des
3 derniers mois », l'agent remonte une poignée d'entreprises là où la presse
spécialisée en liste plusieurs dizaines. C'est structurel : un agent de recherche
web découvre des exemples, il n'énumère pas. Le problème n'est pas le prompt.

**Conclusion pour le brainstorm** : la détection de signal ne devrait pas reposer sur
un LLM qui cherche. Les pistes examinées sont le BODACC pour les augmentations de
capital (trace légale, gratuite, déduplicable), les portails ATS et pages carrière
pour le recrutement, Exa comme moteur de récupération avec filtre de fraîcheur réel,
et le LLM ramené à un rôle d'interprétation sur des preuves déjà collectées.

---

## 9. Intégrations — état honnête

| Intégration | État | Détail |
|---|---|---|
| **data.gouv / SIRENE** | ✅ réel | recherche multicritère, vérification par SIREN ou nom, dirigeant, effectif, site web. Gratuit, sans clé. NAF avec points (`62.01Z`). |
| **Anthropic** | ✅ réel | clé saisie en plateforme, budget, cache, diagnostic |
| **Exa** | ⚙️ codé, non branché | mode `exa+claude` complet, attend `EXA_API_KEY` |
| **Telegram** | ✅ réel | webhook, secret, appairage par espace, boutons de confirmation |
| **Unipile** | ⛔ non branché | recherche de personnes et personas → **résultats simulés**, signalés dans l'UI |
| **Pappers** | ⛔ écarté | décision produit : data.gouv fournit le dirigeant gratuitement |
| **E-mail sortant** | ⛔ non branché | Resend prévu (`RESEND_API_KEY`) |
| **LinkedIn direct** | ⛔ exclu | pas de scraping ; passera par Unipile uniquement |

---

## 10. Extension Chrome

`extension/` — manifeste v1.5.1, widget Jarvis en shadow DOM, déplaçable
(Pointer Events + `setPointerCapture`), icônes générées. Se connecte à l'espace via
un jeton dérivé par HMAC. Non publiée au Chrome Web Store (prévu en « non répertorié »).

---

## 11. Limites connues, à garder en tête pour toute refonte

1. **Pas de schéma relationnel métier** — tout est en JSON dans un magasin unique.
2. **Pas de veille automatique** — aucun cron, aucun collecteur, aucune notification
   proactive. Telegram sait recevoir et répondre, pas alerter.
3. **Pas d'historique d'événements** — un signal est un champ texte sur un lead, il
   n'existe ni table d'événements, ni preuve, ni déduplication, ni date d'événement
   distincte de la date de collecte.
4. **Pas de mesure de conversion** — rien ne dit si un signal a produit un message,
   une réponse ou un rendez-vous. Donc rien ne permet de savoir quel signal vaut
   quelque chose.
5. **Séquences non envoyées** — la mécanique existe, le canal manque.
6. **RGPD non traité** — aucun `person_ref`, aucune durée de conservation, aucune
   purge, aucun registre des traitements. Bloquant avant tout suivi de personnes.
7. **RLS activée, mais aucune politique** — correction d'une erreur de la version
   précédente de ce document, qui affirmait l'inverse. `row level security` est bien
   activé sur les six tables (`supabase/schema.sql:49, 60, 64-67`), sans aucune
   policy publique. La clé de service contourne la RLS par construction : ce qui
   protège réellement aujourd'hui, c'est que le navigateur ne joint jamais Supabase
   et que cette clé ne quitte pas le serveur. Des politiques deviendront nécessaires
   le jour où un accès client direct sera introduit.
8. **Écart production / branche** — commits non fusionnés au 31/07/2026 (voir
   l'en-tête pour la commande de vérification), dont tous les correctifs de la
   recherche par signal.

---

## 12. Repères de code

```
pages/                    écrans (Pages Router)
pages/api/                routes serveur
lib/prospector/
  capabilities.ts         ~100 fonctions métier appelées depuis le navigateur
  llm.ts                  point de contrôle unique des appels IA
  jarvisAgent.ts          cerveau partagé des 3 canaux
  signals.ts              recherche par signal
  datagouv.ts             SIRENE / recherche d'entreprises
  identify.ts             classification compte / personne (heuristique, sans IA)
  missionTools.ts         6 outils fermés des missions
  keystore.ts             clés API en base
  wstoken.ts              jetons par espace, révocables individuellement
  pairing.ts              appairage Telegram
  version.ts              empreinte de build
lib/supabase/store.ts     magasin documentaire générique
middleware.ts             garde de session + liste blanche
extension/                extension Chrome
```

---

## 13. Principes tenus dans ce code, à ne pas perdre

- **Aucune hallucination** : si l'information n'existe pas, le champ reste vide.
  Pas de nom de dirigeant inventé, pas de contact fabriqué, pas de résultat de
  démonstration présenté comme réel.
- **Un échec est un échec** : jamais une liste vide silencieuse à la place d'une
  erreur. Budget épuisé, réponse tronquée, source indisponible → message explicite.
- **Confirmation avant écriture**, sur tous les canaux.
- **Vérifier est un geste d'ajout**, pas de découverte : data.gouv n'est appelé qu'au
  moment où l'utilisateur retient une entreprise.
- **Boutons honnêtes** : ce qui n'est pas branché est désactivé et expliqué, pas
  faussement cliquable.
