# Migrations Supabase

## Principe

**La source de vérité du schéma est `supabase/migrations/`**, gérée par le CLI Supabase.
L'historique des migrations appliquées est tenu par le CLI lui-même, dans le schéma
`supabase_migrations` de la base. **Aucune table de suivi maison n'est créée** : en
fabriquer une dupliquerait un mécanisme natif et créerait deux vérités.

`supabase/schema.sql` est **hérité et figé**. Il ne doit plus être édité. Il sera
supprimé une fois la baseline distante récupérée et comparée (voir « Bascule »).

## Version du CLI

**`supabase@2.111.0`**, figée en version exacte dans `package.json`. Le format des
fichiers de migration et le comportement de `db pull` / `db diff` dépendent de la
version du CLI : une version flottante ferait varier la sortie d'une machine à l'autre.

## Rattachement au projet distant

Le rattachement n'est **jamais versionné**. `supabase link` écrit dans
`supabase/.temp/`, qui est ignoré par git. Aucun identifiant de projet, aucune URL,
aucune clé ne doit apparaître dans un fichier commité — `config.toml` inclus.

```sh
supabase login                       # jeton personnel, stocké hors du dépôt
supabase link --project-ref <ref>    # <ref> fourni hors du dépôt
```

## Créer une migration

```sh
npm run db:new -- nom_explicite      # crée migrations/<horodatage>_nom_explicite.sql
```

Le nommage est celui du CLI : `<horodatage>_<nom>.sql`. **Une migration publiée n'est
jamais réécrite** — on en ajoute une nouvelle. Réécrire une migration déjà appliquée
ailleurs produit des bases divergentes sans que personne ne le voie.

## En-tête obligatoire

Chaque migration commence par trois lignes. Elles remplacent la règle du « script
inverse systématique », qui produisait des scripts jamais exécutés donc faux.

```sql
-- categorie: additive | destructive | data
-- rollback: <la méthode concrète, pas une intention>
-- reversible: oui | non | partielle
```

| Catégorie | Ce que c'est | Retour arrière |
|---|---|---|
| `additive` | Nouvelle table, nouvelle colonne nullable, nouvel index | Suppression des objets créés. Réversible sans perte. |
| `destructive` | Suppression, renommage, changement de type, contrainte resserrée | **Non réversible par script.** Exige une sauvegarde vérifiée *avant* application, et le retour arrière est une restauration. |
| `data` | Transformation de contenu | Correction en avant par une migration suivante. Une inversion est presque toujours illusoire. |

Une migration `destructive` sans sauvegarde vérifiée mentionnée dans son en-tête ne
doit pas être appliquée.

## Appliquer

```sh
npm run db:status     # migrations locales vs distantes
npm run db:push       # applique les migrations en attente
```

En production, l'application se fait après sauvegarde, jamais en même temps qu'un
déploiement applicatif : on veut pouvoir attribuer une panne à l'un ou à l'autre.

## Bascule depuis `schema.sql` (lot A3b — bloqué)

Non réalisable tant que les accès au projet Supabase ne sont pas disponibles.

1. `supabase link` puis `supabase db pull` → produit la baseline **réelle** dans
   `migrations/`.
2. Reconstruire une base locale vierge à partir de cette seule baseline
   (`supabase db reset`).
3. **Comparer** le résultat à ce que décrit `schema.sql` : tables, colonnes, clés,
   RLS. Consigner les écarts — ils sont attendus, `schema.sql` n'ayant jamais été
   un instantané généré.
4. **Seulement si la reconstruction et la comparaison sont concluantes**, supprimer
   `supabase/schema.sql`.

Tant que l'étape 3 n'a pas eu lieu, `schema.sql` reste en place avec son avertissement :
il vaut mieux un fichier hérité clairement marqué qu'une baseline inventée.

## Ce qui n'est pas versionné

Jetons et clés, référence du projet distant, contenu de `supabase/.temp/`,
sauvegardes. Rien de tout cela n'entre dans le dépôt.
