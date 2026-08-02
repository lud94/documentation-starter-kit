#!/usr/bin/env node
// ============================================================================
// C2a-1e — Smoke test API : la CLÉ ANON ne peut pas appeler les RPC financières.
//
// POURQUOI CE SECOND SCRIPT. Le smoke SQL teste `SET LOCAL ROLE anon`, c'est-à-dire
// les droits du RÔLE PostgreSQL. Le critère d'acceptation porte sur la CLÉ anon
// passant par PostgREST. Deux surfaces distinctes : le rôle peut être correctement
// privé de droits pendant que PostgREST mappe la clé vers un AUTRE rôle, ou que la
// clé soit révoquée, mal signée, ou porteuse d'un rôle inattendu. Le premier script
// prouve la serrure, le second prouve la porte.
//
// ─────────────────────────────────────────────────────────────────────────────
// EFFETS DE BORD : CE QUI EST GARANTI, ET CE QUI NE L'EST PAS
//
// PostgreSQL vérifie le privilège EXECUTE AVANT d'exécuter le corps. Le risque
// d'écriture n'existe donc QUE dans le cas de régression — permission ouverte.
// La question utile est : dans ce cas-là, que peut-il s'écrire ?
//
// GARANTI SANS ÉCRITURE (cinq sondes). Chacune reçoit un argument invalide que la
// fonction rejette à sa PREMIÈRE instruction, avant tout verrou et toute écriture.
// Vérifié ligne à ligne dans 20260802090000_ai_budget_reservation.sql :
//   • engaged()               — `language sql`, uniquement des SELECT ;
//   • bump(-1)                — `raise exception` au premier `if` ;
//   • settle(…, -1, …)        — idem ;
//   • resolve(…, 'INVALID')   — idem ;
//   • reconcile(…, 'INVALID') — idem.
//
// ⚠️ NON GARANTI (une sonde) : prospector_ai_reserve().
// Son corps écrit AVANT de pouvoir rendre un verdict de refus, dans cet ordre :
//   1. `insert into prospector_ai_ledger … on conflict do nothing`
//   2. `select … for update`  (verrou, sans écriture)
//   3. `update prospector_ai_reservations set state='UNRESOLVED' where state='OPEN'
//       and expires_at <= now()`   ← balayage paresseux, MUTANT
//   4. … et seulement ensuite le calcul du budget et `budget_exhausted`.
// Aucun choix d'arguments ne peut contourner l'étape 3 : elle est inconditionnelle
// vis-à-vis des paramètres. Prétendre le contraire — ce que faisait la version
// précédente de ce fichier — était faux.
//
// La migration étant GELÉE, elle n'est pas réordonnée pour arranger le test.
//
// CE QUI RÉDUIT LE RISQUE À UNE VALEUR CARACTÉRISÉE, à défaut de le supprimer :
//   a) les cinq sondes sûres tournent D'ABORD. Si l'une révèle une permission
//      ouverte, le script S'ARRÊTE et n'appelle jamais `reserve`. Le seul état
//      résiduel est donc « anon refusé sur les cinq, mais ouvert sur `reserve`
//      seule » — ce qui suppose un GRANT partiel fabriqué à la main ;
//   b) `Prefer: tx=rollback` est envoyé sur la sonde `reserve`, et la réponse est
//      inspectée : si PostgREST l'honore (`Preference-Applied`), toute écriture
//      éventuelle est annulée avec la transaction. Le script DIT si la préférence
//      a été appliquée — il ne le suppose pas ;
//   c) précondition documentée, à vérifier par l'exploitant avec la clé de service
//      avant de lancer ce script : aucune réservation `OPEN` échue. Si la table
//      est vide — cas attendu tant que C2a-2 n'existe pas — l'étape 3 ne trouve
//      aucune ligne et n'écrit rien.
//
// Les points (a) et (c) rendent l'écriture improbable ; ils ne la rendent pas
// impossible. C'est écrit ici plutôt que promis.
// ─────────────────────────────────────────────────────────────────────────────
//
// AUCUNE CLÉ DE SERVICE. Ce script n'en a pas besoin et refuse de tourner s'il en
// détecte une : elle contournerait la RLS et invaliderait le résultat.
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
if (process.env.STAGING_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Une clé de service est présente dans l\'environnement.')
  console.error('Ce test doit tourner SANS, sinon son résultat ne prouve rien.')
  process.exit(2)
}

// La clé n'est jamais affichée. Sa présence et sa longueur suffisent à diagnostiquer
// une variable vide ou tronquée sans rien divulguer.
console.log(`Cible   : ${URL_}`)
console.log(`Clé anon: présente (${ANON.length} caractères, valeur jamais affichée)`)
console.log('')

const sb = createClient(URL_, ANON, { auth: { persistSession: false } })

// ── Classification ───────────────────────────────────────────────────────────
// Trois verdicts, un seul vaut succès.
//
// ⚠️ LE PIÈGE : un 404 / PGRST202 (« fonction absente du cache de schéma ») n'est
// PAS une preuve de refus. Une fonction qui n'existe pas produit exactement le même
// échec qu'une fonction protégée. Le compter comme un succès reviendrait à déclarer
// sécurisée une base où la migration n'a jamais été appliquée. Non concluant fait
// donc échouer le script.
function classify(error, data) {
  if (!error) return { verdict: 'FAIL', why: `appel AUTORISÉ (réponse : ${JSON.stringify(data)?.slice(0, 120)})` }

  const code = error.code || ''
  const msg = (error.message || '').toLowerCase()

  if (code === '42501' || msg.includes('permission denied')) {
    return { verdict: 'OK', why: `refus de permission (code ${code || 'n/a'})` }
  }
  if (code === 'PGRST301' || msg.includes('jwt') || msg.includes('invalid api key')) {
    return { verdict: 'OK', why: `clé rejetée par PostgREST (code ${code})` }
  }
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('enotfound')
      || msg.includes('getaddrinfo') || msg.includes('certificate')) {
    return { verdict: 'INCONCLUSIVE',
      why: `la cible n'a pas répondu (${(error.message || '').slice(0, 90)}) — vérifier STAGING_SUPABASE_URL. `
         + 'Aucune conclusion possible sur les permissions.' }
  }
  if (code === 'PGRST202' || msg.includes('could not find the function')) {
    return { verdict: 'INCONCLUSIVE',
      why: `fonction introuvable (code ${code}) — la migration C2a-1 est-elle appliquée sur CETTE base ? `
         + 'Un objet absent produit le même échec qu\'un objet protégé : rien n\'est prouvé.' }
  }
  // Tout le reste : l'appel a franchi la permission puis a échoué pour une raison
  // métier. C'est une régression, pas une protection — et c'est précisément ce que
  // produisent nos arguments invalides quand EXECUTE est accordé.
  return { verdict: 'FAIL',
    why: `appel EXÉCUTÉ puis échec métier (code ${code || 'n/a'} : ${(error.message || '').slice(0, 110)}) `
       + '— la permission a été franchie ; un refus aurait rendu 42501' }
}

// ── Phase 1 — sondes garanties sans écriture ────────────────────────────────
// Chaque argument est invalide et rejeté à la première instruction de la fonction.
const SAFE_PROBES = [
  { name: 'prospector_ai_engaged',   args: {},                                             why: 'lecture pure' },
  { name: 'prospector_ai_bump',      args: { p_delta: -1 },                                 why: 'delta négatif : raise avant tout INSERT' },
  { name: 'prospector_ai_settle',    args: { p_id: randomUUID(), p_settled_micros: -1, p_outcome: 'anon-smoke' },
                                                                                            why: 'montant négatif : raise avant le verrou' },
  { name: 'prospector_ai_resolve',   args: { p_id: randomUUID(), p_state: 'INVALID', p_outcome: 'anon-smoke' },
                                                                                            why: 'état invalide : raise avant le verrou' },
  { name: 'prospector_ai_reconcile', args: { p_id: randomUUID(), p_state: 'INVALID', p_settled_micros: 0,
                                             p_resolved_by: 'anon-smoke', p_resolution_reason: 'anon-smoke' },
                                                                                            why: 'état invalide : raise avant le verrou' },
]

let failed = 0
for (const p of SAFE_PROBES) {
  const { data, error } = await sb.rpc(p.name, p.args)
  const { verdict, why } = classify(error, data)
  const mark = verdict === 'OK' ? ' OK ' : verdict === 'INCONCLUSIVE' ? ' ?? ' : 'FAIL'
  console.log(`[${mark}] ${p.name}() — ${why}`)
  if (verdict !== 'OK') failed++
}

// ── Barrière : on ne touche pas à `reserve` si quoi que ce soit cloche ───────
// `reserve` est la seule sonde qui pourrait écrire si la permission était ouverte.
// Si une sonde sûre a déjà révélé une ouverture — ou un doute —, l'appeler
// n'apprendrait rien de plus et ajouterait le seul risque de mutation du script.
if (failed > 0) {
  console.log('')
  console.error('ARRÊT AVANT prospector_ai_reserve().')
  console.error('Les sondes sûres n\'ont pas toutes prouvé le refus ; `reserve` est la seule')
  console.error('dont le corps écrit avant de pouvoir refuser (balayage OPEN → UNRESOLVED).')
  console.error('On ne l\'appelle pas tant que le doute n\'est pas levé.')
  console.error('')
  console.error(`ÉCHEC : ${failed} sonde(s) sur ${SAFE_PROBES.length} n'ont pas prouvé le refus.`)
  process.exit(1)
}

// ── Phase 2 — `reserve`, avec annulation de transaction demandée ────────────
// Raw fetch et non supabase-js : il faut poser `Prefer: tx=rollback` et LIRE
// l'en-tête `Preference-Applied` de la réponse, ce que le client n'expose pas.
// La porte testée reste la même — PostgREST, avec la clé anon.
console.log('')
console.log('Sonde prospector_ai_reserve() — la seule dont le corps peut écrire.')
console.log('Précondition supposée vérifiée par l\'exploitant : aucune réservation OPEN échue.')

let reserveVerdict = 'INCONCLUSIVE'
let reserveWhy = ''
let rollbackApplied = null
try {
  const r = await fetch(`${URL_.replace(/\/+$/, '')}/rest/v1/rpc/prospector_ai_reserve`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      'Content-Type': 'application/json',
      // Si PostgREST l'honore, toute écriture du corps est annulée avec la
      // transaction. On ne suppose pas qu'il l'honore : on le vérifie ci-dessous.
      Prefer: 'tx=rollback',
    },
    body: JSON.stringify({
      p_id: randomUUID(), p_fingerprint: 'anon-api-smoke'.padEnd(64, '0'),
      p_budget_micros: 1, p_estimate_micros: 999999999,
      p_agent: 'anon-smoke', p_model: 'none', p_ttl_seconds: 900,
    }),
  })
  rollbackApplied = (r.headers.get('preference-applied') || '').includes('tx=rollback')

  if (r.ok) {
    reserveVerdict = 'FAIL'
    reserveWhy = `appel AUTORISÉ (HTTP ${r.status}) — régression de permissions`
  } else {
    let body = {}
    try { body = await r.json() } catch { /* corps non JSON */ }
    const { verdict, why } = classify({ code: body.code, message: body.message || `HTTP ${r.status}` }, null)
    reserveVerdict = verdict
    reserveWhy = why
  }
} catch (e) {
  reserveVerdict = 'INCONCLUSIVE'
  reserveWhy = `la cible n'a pas répondu (${String(e?.message || e).slice(0, 90)}) — aucune conclusion possible`
}

const mark = reserveVerdict === 'OK' ? ' OK ' : reserveVerdict === 'INCONCLUSIVE' ? ' ?? ' : 'FAIL'
console.log(`[${mark}] prospector_ai_reserve() — ${reserveWhy}`)
console.log(rollbackApplied
  ? '       Prefer: tx=rollback APPLIQUÉ — toute écriture éventuelle a été annulée.'
  : '       Prefer: tx=rollback NON appliqué par PostgREST — si la permission avait été\n'
  + '       ouverte, le balayage OPEN → UNRESOLVED aurait été committé. À vérifier\n'
  + '       côté base avec la clé de service en cas de verdict FAIL.')
if (reserveVerdict !== 'OK') failed++

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log('')
if (failed > 0) {
  console.error(`ÉCHEC : ${failed} sonde(s) n'ont pas prouvé le refus.`)
  console.error('Un « ?? » signifie qu\'on ne peut rien conclure — traité comme un échec,')
  console.error('parce qu\'une garantie non prouvée ne vaut pas mieux qu\'une garantie absente.')
  process.exit(1)
}
console.log(`SMOKE API C2a-1e : VERT — la clé anon est refusée sur les ${SAFE_PROBES.length + 1} RPC financières.`)
console.log('Rappel de portée : les cinq premières sondes ne pouvaient rien écrire même')
console.log('autorisées ; `reserve` n\'offre pas cette garantie, seulement un risque réduit.')
