#!/usr/bin/env node
// ============================================================================
// C2a-1e — Smoke test API : la CLÉ ANON ne peut pas appeler les RPC financières.
//
// POURQUOI CE SECOND SCRIPT. Le smoke SQL teste `SET LOCAL ROLE anon`, c'est-à-dire
// les droits du RÔLE PostgreSQL. Ce n'est pas le critère d'acceptation, qui porte
// sur la CLÉ anon passant par PostgREST. Deux surfaces distinctes :
//   • le rôle peut être correctement privé de droits alors que PostgREST est
//     configuré pour mapper la clé anon vers un AUTRE rôle ;
//   • la clé peut être révoquée, mal signée, ou porter un rôle inattendu.
// Le premier prouve la permission en base, le second prouve la porte d'entrée.
//
// AUCUNE CLÉ DE SERVICE. Ce script n'en a pas besoin et ne doit pas en recevoir :
// il vérifie précisément ce qu'on peut faire SANS privilège.
//
// AUCUNE DONNÉE DURABLE, MÊME EN CAS DE RÉGRESSION. Les paramètres sont choisis
// pour que chaque appel, s'il était autorisé, s'arrête avant toute écriture :
//   • engaged  → lecture pure ;
//   • reserve  → estimation > budget, donc `budget_exhausted` rendu AVANT l'insert ;
//   • settle   → identifiant inexistant, donc `noop` sans imputation ;
//   • bump(0)  → n'ajoute aucun micro-dollar (seul `updated_at` serait touché).
// Un test de permissions qui laisse des traces quand il échoue est un test qui
// aggrave l'incident qu'il signale.
//
// Usage :
//   STAGING_SUPABASE_URL=... STAGING_SUPABASE_ANON_KEY=... \
//     node scripts/smoke/c2a1_anon_api_smoke.mjs
// ============================================================================
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const URL_ = process.env.STAGING_SUPABASE_URL
const ANON = process.env.STAGING_SUPABASE_ANON_KEY

if (!URL_ || !ANON) {
  console.error('STAGING_SUPABASE_URL et STAGING_SUPABASE_ANON_KEY sont requises.')
  console.error('Aucune clé de service ne doit être fournie : ce script vérifie')
  console.error('ce qui est possible SANS privilège.')
  process.exit(2)
}
// Garde-fou : une clé de service passée par erreur invaliderait tout le test —
// elle contourne la RLS et possède les droits d'exécution. Mieux vaut s'arrêter.
if (process.env.STAGING_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Une clé de service est présente dans l\'environnement.')
  console.error('Ce test doit tourner SANS, sinon son résultat ne prouve rien.')
  process.exit(2)
}

// La clé n'est jamais affichée. Seule sa présence et sa longueur le sont, ce qui
// suffit à diagnostiquer une variable vide ou tronquée sans rien divulguer.
console.log(`Cible   : ${URL_}`)
console.log(`Clé anon: présente (${ANON.length} caractères, valeur jamais affichée)`)
console.log('')

const sb = createClient(URL_, ANON, { auth: { persistSession: false } })

// ── Classification d'une réponse ────────────────────────────────────────────
//
// Trois verdicts, et un seul vaut succès.
//
// ⚠️ LE PIÈGE : un 404 / PGRST202 (« fonction absente du cache de schéma ») N'EST
// PAS une preuve de refus. Une fonction qui n'existe pas produit exactement le
// même « échec » qu'une fonction protégée. Le compter comme un succès reviendrait
// à déclarer sécurisée une base où la migration n'a jamais été appliquée. On le
// classe donc NON CONCLUANT, et non concluant fait échouer le script.
function classify(error, data) {
  if (!error) return { verdict: 'FAIL', why: `appel AUTORISÉ (réponse : ${JSON.stringify(data)?.slice(0, 120)})` }

  const code = error.code || ''
  const msg = (error.message || '').toLowerCase()

  // Refus de permission — le seul succès.
  if (code === '42501' || msg.includes('permission denied')) {
    return { verdict: 'OK', why: `refus de permission (code ${code || 'n/a'})` }
  }
  // Clé rejetée avant même d'atteindre la fonction : également un refus valable.
  if (code === 'PGRST301' || msg.includes('jwt') || msg.includes('invalid api key')) {
    return { verdict: 'OK', why: `clé rejetée par PostgREST (code ${code})` }
  }
  // La requête n'a jamais atteint PostgREST : URL fausse, DNS, réseau. Rien n'est
  // prouvé, et le dire précisément évite de faire chercher une régression de
  // permissions là où il n'y a qu'une variable mal renseignée.
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('enotfound')
      || msg.includes('getaddrinfo') || msg.includes('certificate')) {
    return { verdict: 'INCONCLUSIVE',
      why: `la cible n'a pas répondu (${(error.message || '').slice(0, 90)}) — vérifier STAGING_SUPABASE_URL. `
         + 'Aucune conclusion possible sur les permissions.' }
  }
  // Fonction introuvable : on ne peut RIEN conclure sur les permissions.
  if (code === 'PGRST202' || msg.includes('could not find the function')) {
    return { verdict: 'INCONCLUSIVE',
      why: `fonction introuvable (code ${code}) — la migration C2a-1 est-elle appliquée sur CETTE base ? `
         + 'Un objet absent produit le même échec qu\'un objet protégé : rien n\'est prouvé.' }
  }
  // Tout le reste : l'appel a probablement été EXÉCUTÉ puis a échoué pour une
  // raison métier. C'est une régression de permissions, pas une protection.
  return { verdict: 'FAIL',
    why: `appel exécuté puis échec métier (code ${code || 'n/a'} : ${(error.message || '').slice(0, 120)}) `
       + '— un refus de permission aurait rendu 42501' }
}

// ── Sondes ───────────────────────────────────────────────────────────────────
const PROBES = [
  {
    name: 'prospector_ai_engaged',
    args: {},
    note: 'lecture pure',
  },
  {
    name: 'prospector_ai_reserve',
    // Estimation très supérieure au plafond : si l'appel passait, la fonction
    // rendrait `budget_exhausted` AVANT d'insérer quoi que ce soit.
    args: {
      p_id: randomUUID(), p_fingerprint: 'anon-api-smoke'.padEnd(64, '0'),
      p_budget_micros: 1, p_estimate_micros: 999999999,
      p_agent: 'anon-smoke', p_model: 'none', p_ttl_seconds: 900,
    },
    note: 'ne peut rien insérer même si autorisé',
  },
  {
    name: 'prospector_ai_settle',
    // Identifiant inexistant : `noop`, aucune imputation possible.
    args: { p_id: randomUUID(), p_settled_micros: 0, p_outcome: 'anon-smoke' },
    note: 'identifiant inexistant, aucune imputation',
  },
  {
    name: 'prospector_ai_bump',
    // Delta nul : aucun micro-dollar ajouté même si l'appel passait.
    args: { p_delta: 0 },
    note: 'delta nul, aucun montant ajouté',
  },
]

let failed = 0
for (const p of PROBES) {
  const { data, error } = await sb.rpc(p.name, p.args)
  const { verdict, why } = classify(error, data)
  const mark = verdict === 'OK' ? ' OK ' : verdict === 'INCONCLUSIVE' ? ' ?? ' : 'FAIL'
  console.log(`[${mark}] ${p.name}() — ${why}`)
  if (verdict !== 'OK') failed++
}

console.log('')
if (failed > 0) {
  console.error(`ÉCHEC : ${failed} sonde(s) sur ${PROBES.length} n'ont pas prouvé le refus.`)
  console.error('Un « ?? » signifie qu\'on ne peut rien conclure — traité comme un échec,')
  console.error('parce qu\'une garantie non prouvée ne vaut pas mieux qu\'une garantie absente.')
  process.exit(1)
}
console.log(`SMOKE API C2a-1e : VERT — la clé anon est refusée sur les ${PROBES.length} RPC financières.`)
