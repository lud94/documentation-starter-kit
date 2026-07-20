# Handoff — Session LeadFlow / Prospector

> Rédigé pour reprise dans une nouvelle session Claude (accès Google Drive requis).
> Contexte : Ludwig, CEO Smart.AI.

---

## 1. Où on en est concrètement (fait, déployé, fonctionnel)

**Repo GitHub** : `lud94/documentation-starter-kit` — commencé comme template Nextra, entièrement transformé en app Next.js.

**Déployé sur Vercel** (branche `main`) : https://documentation-starter-kit-rho-eosin.vercel.app

**Ce qui a été construit — interface "LeadFlow" (ex-Prospector) :**
- Stack : Next.js 13 (Pages Router) + TypeScript + Tailwind CSS
- 3 pages : `/` (Tableau de bord), `/search` (Nouvelle recherche), `/prospects` (liste/table des leads)
- Design : thème clair, cards blanches, dégradé violet `#667eea → #764ba2`, calqué sur un mockup fourni par Ludwig
- État global : store simple avec persistance `localStorage` (`store/leads.ts`), pas de vraie DB
- 2 routes API (`pages/api/search-leads.ts`, `pages/api/send-email.ts`) qui proxient vers des **webhooks n8n existants** (workflow "LEAD 2.0") :
  - Recherche leads → webhook n8n → Apify (`code_crafter~leads-finder`) → retour JSON de leads (personne + entreprise)
  - Envoi email → webhook n8n → Agent IA (LangChain + vector store RAG) → génère email personnalisé HTML → envoie via Gmail

**Fichiers clés du repo :**
```
pages/index.tsx          → Dashboard (stats, activité récente, secteurs)
pages/search.tsx         → Formulaire recherche (industry, location, jobTitle, employeeRange, revenue)
pages/prospects.tsx      → Table des leads + bouton "Envoyer" par ligne
pages/api/search-leads.ts
pages/api/send-email.ts
components/Layout.tsx    → Topbar + navigation
store/leads.ts           → State global + localStorage
types/lead.ts            → Types TypeScript (Lead, Person, Company, SearchParams)
```

**Non résolu / à vérifier :** le format exact retourné par le webhook n8n (le nœud `Respond to Webhook` fait `JSON.stringify($items())`) — le parsing côté frontend gère deux cas mais n'a pas encore été testé avec un vrai run n8n.

---

## 2. Le pivot stratégique en cours (pas encore codé)

Ludwig a partagé un **agent de veille commerciale** développé dans une autre conversation Claude, initialement pensé pour un client (Fabel/Geoffroy, courtier en bureaux), et veut l'**intégrer dans LeadFlow** comme brique générique multi-clients.

### Concept validé : le "gate de coût"

```
DataGoov (sourcing brut)  → gratuit
     ↓
GATE SIGNAL/SCORING       → quasi gratuit (API structurées)
     ↓ ne garde que les comptes "chauds"
Unipile (recherche LinkedIn persona)  → CHER
     ↓
Enrichissement + rédaction IA          → CHER (tokens)
     ↓
Prospector/LeadFlow (séquences, contact, suivi)
```

Principe : filtrer par signal avant de dépenser sur l'enrichissement coûteux (LinkedIn/tokens).

### Décision actée par Ludwig
- **Pas d'orchestrateur externe type n8n pour cette brique.** Tout doit être codé directement (comme le reste de "Prospector"), avec des instructions claires. → Confirme l'option **code dans Next.js**, pas de nouveau n8n.

### Cible ICP actuelle (SmartAI, pas Fabel)
- Entreprises **< 250 salariés**
- Secteur **tech / startups** principalement
- Persona jugé le plus mature pour adopter l'IA dans ses process sales/marketing

### Documents fournis par Ludwig (existent, à relire dans le Drive : fichier "Claude Prospector")
1. **`README_Agent_Veille_Prospector.md`** — architecture de l'agent de veille (généré pour Fabel), 3 régimes de sources (API structurée / web / LinkedIn manuel), scoring, 5 points de couplage avec Prospector, risques ouverts, checklist déploiement.
2. **`scoring_veille.py`** — moteur de scoring Python de référence, générique (piloté par `config_<client>.json`) : filtre légal → filtre ICP → règles dures → scoring (fraîcheur × force × fiabilité + bonus composite) → quarantaine → coupe capacité.
3. **`PROMPT_Agent_Veille_V1.md`** — prompt système pour un agent LLM généraliste qui exécute la procédure de veille (détection, croisement, filtre légal non négociable, scoring, honnêteté épistémique, boucle d'apprentissage).
4. **`Signaux_Fabel_a_valider.docx`** — doc lisible humain listant les signaux à valider avec le client.
5. **`config_fabel.json`** — config JSON avec 10 signaux (dont 3 "web" : levée de fonds, implantation Paris, croissance annoncée), filtres ICP, seuils de scoring, capacité.
6. **`Prospector_Lab_V14.docx`** — **système séparé et non lié au sourcing** : un outil de rédaction/coaching de messages (React + appel direct API Anthropic), usage founder-led manuel sur 10-20 comptes, consomme un "Dispositif" produit à la main sur claude.ai (Projets avec web search natif). Statut encore à clarifier : Ludwig veut-il le remplacer par LeadFlow industrialisé, ou le garder à part ?

---

## 3. Points de red-team non résolus (à trancher avant de coder la suite)

1. **Prospector Lab V14 — scope ambigu.** Est-ce un système à fusionner dans LeadFlow, ou un outil séparé à laisser tel quel ? Pas encore répondu par Ludwig.

2. **Entité scorée : compte ou personne ?** Le moteur `scoring_veille.py` existant score des **entreprises** (SIREN). Le nouveau besoin (ICP tech/startup, signaux LinkedIn : intitulé de poste, likes, publications) nécessite un scoring **au niveau personne**, absent du modèle actuel (`Compte` n'a pas de champ persona). À concevoir : `Persona` comme entité distincte, avec sa propre logique de signal, en plus ou à la place du `Compte`.

3. **Capacité réelle d'Unipile — à vérifier avant de designer.** Unipile est une API de messagerie unifiée LinkedIn (recherche + inbox), pas un scraper de profil public. Il faut confirmer concrètement :
   - Unipile expose-t-il vraiment les likes/posts/liens externes d'un profil, ou seulement recherche + messaging ?
   - Sous quel compte LinkedIn ça tourne (risque de ban/CGU déjà identifié comme risque ouvert dans le README original, §7).

4. **Déclenchement du run hebdomadaire sans orchestrateur.** "Pas de n8n" règle le *comment* mais pas le *quand*. Options : bouton manuel dans l'UI LeadFlow (recommandé en v1, cohérent avec l'usage founder-led actuel), ou cron (Vercel Cron) plus tard.

5. **DataGoov / SIRENE pour repérer "tech/startup" — proxy faible.** Les codes NAF (62.x, 58.29, 63.11...) donnent un secteur mais pas la maturité IA réelle. Signaux réels à considérer : levées de fonds, offres d'emploi sales/marketing (déjà dans le stack via France Travail), stack technique (Salesforce/HubSpot etc. — pas de source API actuelle, nécessiterait scraping/LinkedIn), activité LinkedIn du persona.

6. **Config à réécrire pour SmartAI.** `config_fabel.json` contient des signaux propres au métier de Geoffroy (EMPLOI_ACTIF, FRANCHISSEMENT_TRANCHE, SECTEUR_TENSION, SECTEUR_REPLI...). Le moteur (`scoring_veille.py`) est générique et réutilisable tel quel, mais il faut écrire un nouveau `config_smartai.json` avec des signaux propres à la cible tech/startup < 250 salariés.

---

## 4. Prochaine étape proposée (au moment du handoff)

1. Récupérer le fichier "Claude Prospector" sur Google Drive (bloqué dans cette session — problème d'autorisation OAuth du connecteur Google Drive, à retester dans la nouvelle session)
2. Trancher les 6 points de red-team ci-dessus avec Ludwig
3. Étendre le moteur `scoring_veille.py` avec l'entité `Persona`
4. Écrire `config_smartai.json`
5. Intégrer le moteur de scoring directement en code TypeScript dans le repo Next.js (pas de service externe), avec déclenchement manuel dans l'UI en v1

---

## 5. Notes pratiques / gotchas rencontrés en session

- **Déploiement Vercel** : bien vérifier que la branche de production pointe vers `main` (le repo a aussi une branche `claude/elegant-gates-jen674` utilisée pendant le dev, mergée dans `main`).
- **Build TypeScript** : `Set` ne peut pas être itéré directement avec `[...set]` sous la target TS par défaut de Next — utiliser `Array.from(set)` à la place (rencontré dans `store/leads.ts`).
- **Webhooks n8n** : contiennent un token Apify en clair dans l'URL du nœud HTTP Request du workflow original (`apify_api_...`) — à rotation recommandée si le JSON du workflow est partagé ou committé quelque part.
