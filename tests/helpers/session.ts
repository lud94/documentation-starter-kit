// Outils de session pour les tests — lot SEC-AUTH-0.
//
// Deux besoins nés du lot :
//
// 1. UN SECRET DOIT EXISTER. Les tests s'appuyaient jusqu'ici, sans le dire,
//    sur le secret par défaut du dépôt (`prospector-dev-secret-change-me`).
//    Ce littéral est supprimé : chaque suite qui manipule des sessions doit
//    poser un secret explicite. C'est une valeur de TEST, sans aucune valeur
//    ailleurs, et elle n'est pas un secret réel.
//
// 2. IL FAUT POUVOIR FORGER DES JETONS ANORMAUX. `createSessionToken` refuse
//    désormais d'émettre une session sans rôle, avec un rôle inconnu, ou avec
//    un espace client interdit — c'est le but. Mais pour PROUVER que la lecture
//    les refuse, il faut les fabriquer hors de cette porte. `forgeSession`
//    signe un payload arbitraire avec le secret courant : exactement ce que
//    ferait quelqu'un en possession du secret (ou, hier, du littéral public).

/** Secret de TEST. Aucune valeur en dehors de la suite. ≥ 32 octets. */
export const TEST_SESSION_SECRET = 'secret-de-test-sec-auth-0-non-reel-1234567890'

/** Le secret public qui régnait par défaut avant SEC-AUTH-0. */
export const ANCIEN_SECRET_PUBLIC = 'prospector-dev-secret-change-me'

export function useTestSessionSecret(): void {
  process.env.APP_SESSION_SECRET = TEST_SESSION_SECRET
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Signe un payload ARBITRAIRE — y compris incohérent — avec le secret donné. */
export async function forgeSession(
  payload: Record<string, unknown>,
  secret: string = TEST_SESSION_SECRET,
): Promise<string> {
  const enc = new TextEncoder()
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `${body}.${b64url(await crypto.subtle.sign('HMAC', key, enc.encode(body)))}`
}

/** Horodatage d'expiration dans le futur, en secondes. */
export const futureExp = (seconds = 3600) => Math.floor(Date.now() / 1000) + seconds
