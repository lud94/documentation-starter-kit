# Mesure ESLint — état de référence

**Date de la mesure** : 31 juillet 2026 · **Commit** : `92426fa` · **Mode** : mesure, pas adoption

Ce document est le résultat d'une mesure faite avec une installation **temporaire et
non persistée** d'ESLint. Aucune dépendance ESLint n'a été ajoutée au dépôt, aucun
fichier `.eslintrc.json` n'a été commité. La décision d'adoption se prend sur ces
chiffres, pas sur une intuition.

## Procédure exacte

```sh
npm i -D --no-save eslint@8.57.1 eslint-config-next@13.5.11
echo '{"extends":"next/core-web-vitals"}' > .eslintrc.json
npx eslint . --ext .ts,.tsx --format json -o /tmp/eslint-report.json
# … analyse …
rm .eslintrc.json && npm install    # retour à l'état d'origine
```

`--no-save` empêche l'écriture dans `package.json`. Le `npm install` final rétablit
l'arbre de dépendances déclaré.

## Versions — contrainte non négociable

`eslint-config-next@13.5.11` déclare le pair `eslint: "^7.23.0 || ^8.0.0"`.
**ESLint 9 est donc incompatible** avec la version de Next du dépôt (13.5.11).
La seule version utilisable est `eslint@8.57.1`, dernière du cycle 8.

## Résultat

| Mesure | Valeur |
|---|---|
| Erreurs | **71** |
| Avertissements | **3** |
| Fichiers analysés | 103 |
| Fichiers concernés | **19** (18 %) |

### Par règle et par criticité

| Occurrences | Criticité | Règle | Nature |
|---|---|---|---|
| 70 | erreur | `react/no-unescaped-entities` | **Cosmétique** — apostrophes françaises non échappées dans du JSX. Aucun risque fonctionnel, correction mécanique. |
| 1 | erreur | `@next/next/no-html-link-for-pages` | **Réelle** — un `<a href>` là où un `<Link>` est attendu : perte de la navigation côté client sur ce lien. Seul défaut de fond détecté. |
| 3 | avertissement | `react-hooks/exhaustive-deps` | **À examiner au cas par cas** — dépendances de `useEffect` incomplètes. Parfois volontaire, parfois source de données périmées à l'écran. |

### Concentration

| Fichier | Occurrences |
|---|---|
| `pages/admin.tsx` | 28 |
| `pages/sourcing.tsx` | 10 |
| `pages/leads/[id].tsx` | 6 |
| `components/CreateLeadModal.tsx` | 4 |
| 15 autres fichiers | 1 à 3 chacun |

## Constat déterminant : ESLint casse `next build`

Vérifié, pas supposé. Avec `.eslintrc.json` présent à la racine :

```
Failed to compile.
142:141  Error: `'` can be escaped with `&apos;` …  react/no-unescaped-entities
BUILD_EXIT=1
```

Next 13 exécute ESLint pendant `next build` dès qu'une configuration existe, et
**traite les erreurs de lint comme des erreurs de compilation**. Ajouter ESLint sans
précaution rendrait donc le dépôt non déployable, y compris pour des apostrophes.

Deux parades possibles :
- `eslint: { ignoreDuringBuilds: true }` dans `next.config.js` — découple lint et build ;
- corriger les 71 erreurs avant d'introduire la configuration.

## Trajectoire recommandée

Le volume est **faible et très mécanique** : 70 des 71 erreurs sont des apostrophes,
corrigeables en une passe assistée, sans risque de régression fonctionnelle. Le seul
défaut de fond est unique et localisé.

La recommandation est donc **l'adoption directe, sans phase non bloquante** :

1. **Lot A4a** — corriger les 70 `react/no-unescaped-entities` (correction textuelle
   pure, aucune logique touchée) et le `no-html-link-for-pages`. Examiner les 3
   `exhaustive-deps` un par un : les corriger ou les neutraliser avec un commentaire
   justifiant chaque exception.
2. **Lot A4b** — introduire `.eslintrc.json`, `eslint@8.57.1`,
   `eslint-config-next@13.5.11` et le script `lint`, **avec
   `ignoreDuringBuilds: true`** pour découpler définitivement lint et déploiement,
   puis ajouter l'étape `npm run lint` en CI, **bloquante d'emblée**.

**Date de passage en bloquant proposée : immédiatement à l'issue du lot A4b**, sans
période de tolérance. Une phase non bloquante ne se justifie que face à une dette
volumineuse ; avec 71 erreurs dont 70 triviales, elle ne servirait qu'à faire durer
un avertissement que personne ne lirait.

## Ce que cette mesure ne dit pas

Elle ne couvre que les règles de `next/core-web-vitals`. Elle ne dit rien sur la
qualité du typage (`strict: false` dans `tsconfig.json` désactive l'essentiel des
vérifications de TypeScript), ni sur les règles d'accessibilité, ni sur la sécurité.
Ce sont des sujets distincts, à ne pas fondre dans l'adoption d'ESLint.
