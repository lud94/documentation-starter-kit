// FIXTURES TRANSITOIRES DU HARNESS DE TESTS (lot TEST-ROBUST-03).
//
// ── LA COURSE QUE CE MODULE FERME ────────────────────────────────────────────
// Les gardes de sécurité parcourent le dépôt en trois temps : `readdirSync`
// énumère, `statSync` qualifie, `readFileSync` lit. Entre l'énumération et la
// lecture il s'écoule un temps non nul — plusieurs centaines de millisecondes
// sur un dépôt de 200 fichiers.
//
// Or plusieurs tests déposent une fixture DANS une racine scannée, lancent leur
// propre garde, puis la suppriment dans un `finally`. Vitest exécute ces
// fichiers de test EN PARALLÈLE. Un garde peut donc :
//
//   1. énumérer `lib/` et y voir `lib/__sec_log_01_tmp__.ts` ;
//   2. pendant qu'il analyse les 150 fichiers suivants, l'autre test termine et
//      supprime la fixture ;
//   3. arriver au chemin mémorisé — `ENOENT`.
//
// L'échec observé était exactement celui-là : le garde des mutations Supabase
// tombait sur la fixture de SEC-LOG-01. La course est SYMÉTRIQUE — le garde des
// frontières d'erreur peut tout aussi bien tomber sur
// `lib/__check_robust_01_tmp__/fixture.ts`.
//
// ⚠️ CE N'EST PAS UNE ERREUR DE DÉTECTION. Les règles de sécurité sont
// correctes ; c'est l'accès au système de fichiers qui est fragile.
//
// ── CE QUE CE MODULE NE FAIT PAS ─────────────────────────────────────────────
// Il n'exclut PAS les fixtures du scan. Une fixture présente au moment où son
// propre garde la lit DOIT être analysée normalement : c'est tout l'objet des
// tests qui la déposent. Exclure les chemins temporaires rendrait ces tests
// incapables d'échouer — on aurait remplacé une course par un test mort.
//
// Il n'avale PAS non plus les `ENOENT` en général. Un fichier source qui
// disparaît en cours de scan est un fait anormal : dépôt en cours de
// réécriture, `git checkout` concurrent, disque défaillant. Le garde doit
// remonter l'erreur, pas la taire.
//
// La tolérance est donc doublement bornée : au CODE `ENOENT` d'une part, aux
// chemins portant le nom réservé du harness d'autre part.

/**
 * NOM RÉSERVÉ DES FIXTURES DE TEST.
 *
 * Convention déjà suivie par les deux fixtures existantes :
 *   lib/__sec_log_01_tmp__.ts            → segment `__sec_log_01_tmp__`
 *   lib/__check_robust_01_tmp__/fixture.ts → segment `__check_robust_01_tmp__`
 *
 * Les doubles tirets bas encadrants ne peuvent pas apparaître par accident dans
 * un nom de module applicatif ; le suffixe `_tmp__` dit ce que le fichier est.
 * Toute fixture future déposée dans une racine scannée doit suivre ce nom —
 * sans quoi elle rouvrira la course, et c'est voulu : la tolérance doit être
 * demandée explicitement, jamais accordée par défaut.
 */
export const SEGMENT_FIXTURE = /^__[A-Za-z0-9_]+_tmp__(\.[A-Za-z0-9]+)?$/

/**
 * Le chemin appartient-il à une fixture transitoire du harness ?
 *
 * Vrai si UN de ses segments porte le nom réservé — ce qui couvre aussi bien le
 * fichier isolé que le contenu d'un dossier de fixtures.
 *
 * @param {string} chemin chemin relatif à la racine, séparé par `/`
 */
export function estFixtureTransitoire(chemin) {
  return chemin.split('/').some((segment) => SEGMENT_FIXTURE.test(segment))
}

/**
 * Un `ENOENT`, et rien d'autre.
 *
 * ⚠️ `ENOTDIR` A ÉTÉ RETIRÉ (TEST-ROBUST-03.1). Il décrit une situation
 * différente : un composant du chemin attendu comme dossier n'en est plus un.
 * Ce n'est pas la disparition d'une fixture, et rien ne prouve qu'il faille la
 * masquer. Une tolérance s'accorde sur preuve du besoin, jamais par précaution —
 * chaque code ajouté ici est un cas où un garde se tait.
 */
function estDisparu(err) {
  return Boolean(err) && err.code === 'ENOENT'
}

/**
 * Exécute un accès au système de fichiers en tolérant la disparition d'une
 * fixture — et d'elle seule.
 *
 * Rend `{ present: true, valeur }`, ou `{ present: false }` si le chemin était
 * une fixture transitoire évanouie. Toute autre erreur — y compris un `ENOENT`
 * sur un vrai fichier source — est RELANCÉE telle quelle.
 *
 * @template T
 * @param {string} chemin chemin relatif, pour décider de la tolérance
 * @param {() => T} acces
 * @returns {{ present: true, valeur: T } | { present: false }}
 */
export function tolererDisparitionDeFixture(chemin, acces) {
  try {
    return { present: true, valeur: acces() }
  } catch (err) {
    if (estDisparu(err) && estFixtureTransitoire(chemin)) return { present: false }
    throw err
  }
}
