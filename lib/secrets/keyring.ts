// TROUSSEAU DE CLÉS MAÎTRESSES — lot SEC-SECRETS-0B.
//
// ⚠️ CE LOT NE CHIFFRE ENCORE AUCUN SECRET RÉEL. Il pose la serrure ; les
// secrets y entreront en SEC-SECRETS-0C et 0D. Rien ici ne lit, n'écrit ni ne
// migre `APP_TOTP_SECRET`, `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY` ni aucune
// autre valeur existante.
//
// ── POURQUOI UN TROUSSEAU, ET PAS « UNE CLÉ » ───────────────────────────────
// Une clé unique ne se remplace jamais : le jour où il faut la changer, tous
// les chiffrés existants deviennent illisibles. Il faut donc pouvoir DÉCHIFFRER
// avec plusieurs clés tout en CHIFFRANT avec une seule — c'est le rôle de
// `currentKid` et de la table `kid → clé`.
//
// ── LA CLÉ MAÎTRESSE RESTE HORS DE LA BASE ──────────────────────────────────
// Elle ne doit jamais vivre dans la base qu'elle protège : chiffrer les secrets
// avec une clé stockée à côté d'eux ne protège de rien. Ici elle vient de la
// configuration serveur, et ce module est le SEUL point de contact avec
// `process.env` — `lib/secrets/crypto.ts` ne connaît qu'un `Keyring` qu'on lui
// passe. C'est ce qui permettra de remplacer ce chargeur par un adaptateur KMS
// ou Secret Manager sans toucher à AES, à l'AAD ni à l'enveloppe.

import { SecretCryptoError } from './errors'

/** Nom de la variable serveur. Jamais lue ailleurs que dans ce module. */
export const KEYRING_ENV = 'PROSPECTOR_SECRET_KEYRING'

/** Taille imposée par AES-256. Ni plus, ni moins. */
export const KEY_BYTES = 32

/**
 * Un `kid` désigne une génération de clé. Format volontairement étroit : il
 * voyage dans l'enveloppe, donc dans la base, et sera comparé et journalisé.
 */
const KID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export interface Keyring {
  readonly currentKid: string
  /** `kid → clé de 32 octets`. Figée : personne ne mute un trousseau en place. */
  readonly keys: ReadonlyMap<string, Uint8Array>
}

/** Toutes les générations connues, triées — utile aux diagnostics et aux tests. */
export function keyringKids(k: Keyring): string[] {
  return Array.from(k.keys.keys()).sort()
}

function decodeKey(raw: unknown, kid: string): Uint8Array {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new SecretCryptoError('secret_keyring_invalid', `clé « ${kid} » : valeur absente ou non textuelle`)
  }
  let buf: Buffer
  try {
    // base64 et base64url sont acceptés en entrée : l'opérateur colle ce que son
    // générateur produit. Ce qui est vérifié, c'est la LONGUEUR DÉCODÉE.
    buf = Buffer.from(raw.trim(), 'base64')
  } catch {
    throw new SecretCryptoError('secret_keyring_invalid', `clé « ${kid} » : décodage impossible`)
  }
  if (buf.length !== KEY_BYTES) {
    // ⚠️ Le message dit la LONGUEUR ATTENDUE et la longueur obtenue, jamais la
    // valeur. Une clé trop courte n'est pas « complétée » ni dérivée : elle est
    // refusée. Étirer silencieusement une clé faible produirait un chiffrement
    // qui a l'air de fonctionner.
    throw new SecretCryptoError('secret_keyring_invalid',
      `clé « ${kid} » : ${buf.length} octets décodés, ${KEY_BYTES} exigés`)
  }
  return new Uint8Array(buf)
}

/**
 * Analyse un trousseau depuis sa forme JSON. Lève `secret_keyring_invalid` au
 * moindre doute — il n'existe aucun trousseau « partiellement valide ».
 *
 * Forme attendue : `{ "currentKid": "v2", "keys": { "v1": "...", "v2": "..." } }`
 */
export function parseKeyring(json: string): Keyring {
  const brut = (json || '').trim()
  if (!brut) throw new SecretCryptoError('secret_keyring_invalid', 'trousseau vide')

  let obj: any
  try {
    obj = JSON.parse(brut)
  } catch {
    // ⚠️ L'exception de `JSON.parse` cite le texte fautif — donc, ici, le
    // trousseau. Elle ne remonte pas.
    throw new SecretCryptoError('secret_keyring_invalid', 'JSON illisible')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SecretCryptoError('secret_keyring_invalid', 'objet attendu')
  }

  const currentKid = obj.currentKid
  if (typeof currentKid !== 'string' || !KID_RE.test(currentKid)) {
    throw new SecretCryptoError('secret_keyring_invalid', 'currentKid absent ou mal formé')
  }
  const keysObj = obj.keys
  if (!keysObj || typeof keysObj !== 'object' || Array.isArray(keysObj)) {
    throw new SecretCryptoError('secret_keyring_invalid', 'keys absent ou mal formé')
  }

  const keys = new Map<string, Uint8Array>()
  for (const kid of Object.keys(keysObj)) {
    if (!KID_RE.test(kid)) {
      throw new SecretCryptoError('secret_keyring_invalid', `identifiant de clé mal formé : « ${kid} »`)
    }
    keys.set(kid, decodeKey(keysObj[kid], kid))
  }
  if (keys.size === 0) throw new SecretCryptoError('secret_keyring_invalid', 'aucune clé')

  // Un `currentKid` qui ne désigne rien produirait un trousseau incapable de
  // chiffrer, découvert seulement au premier appel.
  if (!keys.has(currentKid)) {
    throw new SecretCryptoError('secret_keyring_invalid', `currentKid « ${currentKid} » absent de keys`)
  }
  return { currentKid, keys }
}

/**
 * Charge le trousseau depuis la configuration serveur.
 *
 * Absent ⇒ `secret_crypto_unavailable`. Aucune clé de repli, aucune valeur de
 * développement, aucun littéral : c'est la leçon de `DEFAULT_SECRET`
 * (SEC-AUTH-0), et elle vaut a fortiori pour une clé maîtresse.
 */
export function loadKeyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = (env[KEYRING_ENV] || '').trim()
  if (!raw) {
    throw new SecretCryptoError('secret_crypto_unavailable',
      `${KEYRING_ENV} n'est pas configurée : aucun secret ne peut être scellé ni ouvert`)
  }
  return parseKeyring(raw)
}

/** Le trousseau est-il utilisable ? Ne lève pas — pour les écrans d'état. */
export function keyringConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try { loadKeyringFromEnv(env); return true } catch { return false }
}

/**
 * Inventaire des `kid` encore référencés par au moins un chiffré.
 *
 * ⚠️ `complete: false` signifie « je n'ai pas pu établir la liste » — et c'est
 * une réponse légitime : la base peut être injoignable. Ce n'est PAS un
 * inventaire vide. La distinction est portée par le type, précisément pour
 * qu'on ne puisse pas confondre « aucune référence » avec « je ne sais pas ».
 *
 * SEC-SECRETS-0B ne parcourt aucune table : il fournit la primitive, le lot
 * suivant fournira l'inventaire.
 */
export type KidInventory =
  | { complete: true; referencedKids: readonly string[] }
  | { complete: false }

/**
 * Vérifie qu'une transition de trousseau ne rend AUCUN chiffré illisible.
 *
 * ── LE SCÉNARIO QUE CECI INTERDIT ───────────────────────────────────────────
 *
 *     trousseau v1        → des chiffrés portent kid=v1
 *     rotation → v1 + v2  → les nouveaux chiffrés portent v2
 *     rotation → v2 + v3  → v1 disparaît… et tout ce qu'elle scellait aussi
 *
 * Le modèle naïf « courante + précédente » perd la génération n-2 à la
 * deuxième rotation. Rien ne le signale : la perte se découvre le jour où l'on
 * essaie de lire un vieux chiffré, c'est-à-dire trop tard. Une rotation doit
 * donc être VÉRIFIÉE contre l'usage réel, pas contre un rang.
 *
 * Lève `secret_rotation_unsafe` dès qu'un `kid` encore référencé disparaîtrait,
 * et refuse tout retrait quand l'inventaire n'est pas établi.
 */
export function assertSafeKeyringTransition(
  ancien: Keyring,
  nouveau: Keyring,
  inventaire: KidInventory,
): void {
  const retires = keyringKids(ancien).filter((kid) => !nouveau.keys.has(kid))

  // Aucun retrait : ajouter une clé ou changer `currentKid` est toujours sûr.
  if (retires.length === 0) return

  if (!inventaire.complete) {
    // ⚠️ Ne pas savoir n'autorise pas. C'est exactement le fail-open corrigé
    // dans `getTokenVersion` (SEC-EXT-0.1) : une lecture impossible y passait
    // pour une absence.
    throw new SecretCryptoError('secret_rotation_unsafe',
      `retrait de ${retires.length} clé(s) refusé : l'inventaire des kid référencés n'a pas pu être établi`)
  }

  const encoreUtilises = retires.filter((kid) => inventaire.referencedKids.includes(kid))
  if (encoreUtilises.length) {
    throw new SecretCryptoError('secret_rotation_unsafe',
      `clé(s) encore référencée(s) par des chiffrés : ${encoreUtilises.join(', ')}`)
  }
}
