// Applique la fixture temporaire à l'instance Supabase LOCALE.
//
// ⚠️ TEMPORAIRE — à supprimer avec la fixture après le lot A3b : `supabase db reset`
// appliquera alors les migrations réelles, et ce script n'aura plus d'objet.
//
// Sécurité : on passe par `supabase db query --local`, dont le CLI garantit
// lui-même que la cible est l'instance locale. Aucune URL de base n'est construite
// ni lue ici — appliquer du SQL non versionné à une base distante est précisément
// ce que le workflow de migrations vise à rendre impossible.
//
// Note : `supabase db query` ne lit PAS l'entrée standard (le SQL est un argument
// positionnel ou un fichier via --file). Vérifié sur le CLI 2.111.0.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const FIXTURE = 'tests/integration/fixtures/prospector_leads.sql'

if (!existsSync(FIXTURE)) {
  console.error(`Fixture introuvable : ${FIXTURE}`)
  console.error('Si le lot A3b est passé, ce script doit être supprimé au profit de `supabase db reset`.')
  process.exit(1)
}

try {
  execFileSync('npx', ['supabase', 'db', 'query', '--local', '--file', FIXTURE], { stdio: 'inherit' })
  console.log(`Fixture appliquée à la base locale (${FIXTURE}).`)
  console.log('Récupérer ensuite la clé de service locale : npx supabase status -o env')
} catch {
  console.error("Échec de l'application de la fixture. L'instance locale est-elle démarrée ? (npx supabase start)")
  process.exit(1)
}
