// Erreurs de la couche secrets — BORNÉES PAR CONSTRUCTION (lot SEC-SECRETS-0B).
//
// ── POURQUOI UN TYPE DÉDIÉ ──────────────────────────────────────────────────
// Les exceptions d'OpenSSL, de `JSON.parse` et de `Buffer` citent volontiers ce
// qu'elles n'ont pas su traiter : le texte fautif, la longueur exacte, parfois
// la donnée elle-même. Relayées telles quelles, elles transporteraient une clé
// maîtresse, un chiffré ou un secret en clair jusqu'à un journal ou une réponse
// HTTP. On ne laisse donc AUCUNE exception de bibliothèque franchir cette
// couche : chacune est convertie en un code stable et un message qu'on a écrit.
//
// Règle absolue pour `detail` : il décrit une FORME (« 17 octets décodés, 32
// exigés »), jamais une VALEUR. Aucun appelant n'a besoin de voir la donnée
// pour comprendre le refus, et un opérateur non plus.

export type SecretErrorCode =
  | 'secret_crypto_unavailable'   // trousseau non configuré
  | 'secret_keyring_invalid'      // trousseau présent mais inexploitable
  | 'secret_key_missing'          // le kid demandé n'est pas dans le trousseau
  | 'secret_context_invalid'      // contexte incomplet, mal typé, ou hors nomenclature
  | 'secret_envelope_invalid'     // enveloppe illisible : version, algo, encodage, longueurs
  | 'secret_decrypt_failed'       // authentification GCM en échec — le seul verdict possible
  | 'secret_rotation_unsafe'      // une transition de trousseau rendrait des chiffrés illisibles

export class SecretCryptoError extends Error {
  readonly code: SecretErrorCode
  /** Complément de FORME, jamais de valeur. Volontairement court. */
  readonly detail: string

  constructor(code: SecretErrorCode, detail = '') {
    // Le message n'est que le code et un complément que NOUS avons rédigé.
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'SecretCryptoError'
    this.code = code
    this.detail = detail.slice(0, 200)
  }
}

/** Vrai si l'erreur vient de cette couche — les autres ne doivent pas remonter. */
export function isSecretCryptoError(e: unknown): e is SecretCryptoError {
  return e instanceof SecretCryptoError
}
