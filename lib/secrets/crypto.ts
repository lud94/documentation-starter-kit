// PRIMITIVE CRYPTOGRAPHIQUE CANONIQUE — lot SEC-SECRETS-0B.
//
// ⚠️ AUCUN SECRET RÉEL N'EST MIGRÉ DANS CE LOT. Ce module est la serrure ; les
// secrets y entreront plus tard. Il ne connaît ni `getKey`, ni `setKeys`, ni
// Supabase, ni aucun fournisseur, et n'a aucun appelant en production.
//
// ── LA PROPRIÉTÉ QU'IL FAUT OBTENIR ─────────────────────────────────────────
// Chiffrer ne suffit pas. Une base compromise en ÉCRITURE — ou simplement un
// export réimporté de travers — permettrait de RECOPIER un chiffré d'une ligne
// vers une autre :
//
//     ligne (Fabel, anthropic)   ─── copier le ciphertext ───▶  ligne (Client-B, anthropic)
//
// Sans lien cryptographique avec le contexte, le déchiffrement réussirait, et
// Client-B utiliserait la clé Anthropic de Fabel. Le chiffrement aurait
// parfaitement fonctionné, et l'isolation aurait échoué.
//
// La réponse est l'AAD (« donnée additionnelle authentifiée ») d'AES-GCM : le
// contexte n'est pas chiffré, il est AUTHENTIFIÉ. Déchiffrer sous un contexte
// différent de celui du scellement fait échouer la vérification du tag. Un
// chiffré déplacé devient donc illisible, quel que soit l'accès à la base.
//
// ── UNE SEULE PRIMITIVE ─────────────────────────────────────────────────────
// `sealSecret` et `openSecret`, et rien d'autre. Aucune variante « sans
// contexte », aucune option permissive : c'est ainsi qu'on évite qu'un appelant
// pressé se fabrique un chemin plus simple et moins sûr.
//
// Uniquement `node:crypto`. Aucune dépendance nouvelle, aucun algorithme maison.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { SecretCryptoError } from './errors'
import { isValidKid, type Keyring } from './keyring'

export const ENVELOPE_VERSION = 1
export const ALG = 'A256GCM' as const
/** 12 octets : la taille recommandée pour GCM, et la seule acceptée ici. */
export const IV_BYTES = 12
/** 16 octets : tag GCM pleine longueur. Un tag tronqué affaiblit l'authentification. */
export const TAG_BYTES = 16

// ── CONTEXTE ────────────────────────────────────────────────────────────────

/**
 * Nomenclature FERMÉE, et volontairement RÉDUITE (lot 0B.1).
 *
 * ── POURQUOI `user` ET `ephemeral` ONT DISPARU ──────────────────────────────
 * SEC-SECRETS-0B les annonçait comme pris en charge. C'était faux, et d'une
 * façon qui compte : une primitive cryptographique qui accepte une portée
 * PROMET de l'authentifier correctement. Or il n'existe encore aucun contrat
 * d'identité pour `user` (qui est le sujet ? l'administrateur, un client, une
 * session ?) ni aucun cycle de vie pour `ephemeral` (quelle expiration ? quel
 * stockage ? qui purge ?). Sceller sous ces portées aurait produit des chiffrés
 * dont personne n'aurait su, plus tard, quel contexte ils affirmaient — et
 * l'AAD les aurait figés pour toujours dans cette ambiguïté.
 *
 * « Non pris en charge » ne veut pas dire abandonné : cela veut dire qu'aucune
 * garantie cryptographique ne sera vendue avant que l'architecture n'ait défini
 * ce qu'elle garantit. Les ajouter plus tard est facile ; défaire des chiffrés
 * déjà scellés sous un contexte mal défini ne l'est pas.
 */
export const SECRET_SCOPES = ['platform', 'tenant'] as const
export type SecretScope = typeof SECRET_SCOPES[number]

export interface SecretContext {
  scope: SecretScope
  secretName: string
  /** OBLIGATOIRE pour `tenant`. Ignoré — et facultatif — pour `platform`. */
  workspaceId?: string | null
  provider?: string | null
  credentialId?: string | null
  secretVersion?: number | null
}

function champOptionnel(v: unknown, nom: string): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || !v.trim()) {
    throw new SecretCryptoError('secret_context_invalid', `${nom} : chaîne non vide ou absence attendue`)
  }
  return v.trim()
}

/**
 * Sérialisation CANONIQUE du contexte, liée à la tête de l'enveloppe.
 *
 * ── DEUX PIÈGES ÉVITÉS ICI ──────────────────────────────────────────────────
 *
 * 1. L'ORDRE DES PROPRIÉTÉS. `JSON.stringify(objetDeLAppelant)` suit l'ordre
 *    d'insertion : deux appelants décrivant le MÊME contexte produiraient deux
 *    AAD différents, donc des chiffrés mutuellement illisibles. On reconstruit
 *    donc un objet dans un ordre FIXE, écrit ici et nulle part ailleurs.
 *
 * 2. L'AMBIGUÏTÉ DE CONCATÉNATION. Un AAD de la forme `a|b|c` se laisse
 *    confondre : `{ws:"x|y", provider:"z"}` et `{ws:"x", provider:"y|z"}`
 *    donnent la même chaîne. JSON échappe les séparateurs, la lecture reste
 *    sans ambiguïté.
 *
 * ⚠️ LA TÊTE DE L'ENVELOPPE EST DANS L'AAD. `envelopeVersion`, `alg` et `kid`
 * sont authentifiés eux aussi. Sans cela, ces champs seraient des métadonnées
 * en clair modifiables : substituer un `kid` ou annoncer un autre algorithme
 * passerait inaperçu. Ici, toute retouche de la tête fait échouer le tag.
 */
function aad(ctx: SecretContext, kid: string): Buffer {
  if (!SECRET_SCOPES.includes(ctx?.scope as SecretScope)) {
    // Couvre aussi bien une valeur inventée que `user` et `ephemeral`, qui ne
    // sont plus pris en charge : rien n'est interprété « au mieux ».
    throw new SecretCryptoError('secret_context_invalid', 'scope hors nomenclature')
  }
  if (typeof ctx.secretName !== 'string' || !ctx.secretName.trim()) {
    throw new SecretCryptoError('secret_context_invalid', 'secretName absent')
  }
  // ⚠️ UN SECRET DE TENANT SANS TENANT N'EXISTE PAS (lot 0B.1). La version
  // précédente l'acceptait : `workspaceId` était optionnel pour toutes les
  // portées, et l'AAD scellait simplement `null`. Le chiffré restait cohérent
  // avec lui-même — donc indéchiffrable sous un vrai workspace — mais la
  // propriété annoncée était fausse : la primitive prétendait cloisonner par
  // espace un contexte qui n'en nommait aucun. Un appelant qui oubliait de
  // passer l'espace obtenait un scellement « réussi », et l'erreur ne se
  // découvrait qu'à la relecture.
  if (ctx.scope === 'tenant') {
    const ws = typeof ctx.workspaceId === 'string' ? ctx.workspaceId.trim() : ''
    if (!ws) {
      throw new SecretCryptoError('secret_context_invalid',
        'scope tenant : workspaceId obligatoire et non vide')
    }
  }
  const version = ctx.secretVersion
  if (version !== undefined && version !== null
      && (typeof version !== 'number' || !Number.isInteger(version) || version < 0)) {
    throw new SecretCryptoError('secret_context_invalid', 'secretVersion : entier positif ou absence attendue')
  }

  const canonique = {
    aadVersion: 1,
    envelopeVersion: ENVELOPE_VERSION,
    alg: ALG,
    kid,
    scope: ctx.scope,
    secretName: ctx.secretName.trim(),
    workspaceId: champOptionnel(ctx.workspaceId, 'workspaceId'),
    provider: champOptionnel(ctx.provider, 'provider'),
    credentialId: champOptionnel(ctx.credentialId, 'credentialId'),
    secretVersion: version === undefined ? null : version,
  }
  return Buffer.from(JSON.stringify(canonique), 'utf8')
}

// ── ENVELOPPE ───────────────────────────────────────────────────────────────

export interface SecretEnvelope {
  envelopeVersion: number
  alg: string
  kid: string
  iv: string
  ciphertext: string
  tag: string
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/

/**
 * Décodage base64url, isolé dans un helper nommé.
 *
 * Ce n'est pas qu'une commodité : `scripts/check-supabase-mutations.mjs`
 * signale tout `.from(` suivi d'un `.update(` dans la même fenêtre de texte, et
 * `Buffer.from(iv) … decipher.update(ct)` déclenchait ce filet. Le garde-fou a
 * raison d'être bavard — il vaut mieux qu'il signale trop que trop peu — donc
 * on écarte le motif plutôt que d'ajouter une dérogation qui l'aveuglerait sur
 * ce fichier pour toujours.
 */
function b64(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

/**
 * Décode un champ base64url, avec une longueur EXIGÉE quand elle est connue.
 *
 * `Buffer.from(s, 'base64url')` est indulgent : il ignore les caractères
 * invalides au lieu d'échouer. `"!!!!"` deviendrait un tampon vide, et une
 * enveloppe manifestement corrompue passerait pour une enveloppe seulement
 * courte. On valide donc l'alphabet AVANT de décoder.
 */
function decodeB64(champ: string, nom: string, octetsAttendus?: number): Buffer {
  if (typeof champ !== 'string' || !champ || !B64URL_RE.test(champ)) {
    throw new SecretCryptoError('secret_envelope_invalid', `${nom} : base64url attendu`)
  }
  const buf = b64(champ)
  if (buf.length === 0) {
    throw new SecretCryptoError('secret_envelope_invalid', `${nom} : vide après décodage`)
  }
  if (octetsAttendus !== undefined && buf.length !== octetsAttendus) {
    throw new SecretCryptoError('secret_envelope_invalid',
      `${nom} : ${buf.length} octets, ${octetsAttendus} exigés`)
  }
  return buf
}

/** Analyse une enveloppe sérialisée. Refuse tout ce qui n'est pas exactement attendu. */
export function parseEnvelope(serialisee: string): SecretEnvelope {
  let obj: any
  try {
    obj = JSON.parse(serialisee)
  } catch {
    throw new SecretCryptoError('secret_envelope_invalid', 'JSON illisible')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SecretCryptoError('secret_envelope_invalid', 'objet attendu')
  }
  // ⚠️ AUCUNE TOLÉRANCE DE VERSION NI D'ALGORITHME. Accepter « ce qu'on ne
  // connaît pas » est le mécanisme même d'une attaque par déclassement : il
  // suffirait d'annoncer un algorithme plus faible pour être servi.
  if (obj.envelopeVersion !== ENVELOPE_VERSION) {
    throw new SecretCryptoError('secret_envelope_invalid', `version d'enveloppe non prise en charge`)
  }
  if (obj.alg !== ALG) {
    throw new SecretCryptoError('secret_envelope_invalid', 'algorithme non pris en charge')
  }
  // ⚠️ MÊME RÈGLE QUE LE TROUSSEAU (lot 0B.1). L'enveloppe se contentait d'une
  // « chaîne non vide » : un `kid` de 400 caractères, en majuscules ou hors
  // alphabet passait l'analyse et n'était refusé qu'en aval, sous le motif
  // trompeur « clé absente du trousseau ». Un identifiant mal formé est une
  // ENVELOPPE invalide, pas une clé manquante — et la distinction compte pour
  // qui diagnostique.
  if (!isValidKid(obj.kid)) {
    throw new SecretCryptoError('secret_envelope_invalid', 'kid absent ou mal formé')
  }
  // Longueurs vérifiées ici : elles ne dépendent pas de la clé, et une IV ou un
  // tag de taille inattendue est une enveloppe corrompue, pas un échec d'auth.
  decodeB64(obj.iv, 'iv', IV_BYTES)
  decodeB64(obj.tag, 'tag', TAG_BYTES)
  decodeB64(obj.ciphertext, 'ciphertext')

  return {
    envelopeVersion: obj.envelopeVersion, alg: obj.alg, kid: obj.kid,
    iv: obj.iv, ciphertext: obj.ciphertext, tag: obj.tag,
  }
}

// ── SCELLEMENT / OUVERTURE ──────────────────────────────────────────────────

function cle(keyring: Keyring, kid: string): Uint8Array {
  const k = keyring?.keys?.get(kid)
  if (!k) throw new SecretCryptoError('secret_key_missing', `génération de clé « ${kid} » absente du trousseau`)
  return k
}

/**
 * Scelle un secret pour UN contexte donné. Rend l'enveloppe SÉRIALISÉE, prête
 * à être stockée telle quelle dans une colonne texte.
 *
 * ⚠️ TOUJOURS AVEC `currentKid`. Un nouvel écrit n'utilise jamais une ancienne
 * génération : c'est ce qui fait qu'une rotation finit par se terminer, les
 * anciens `kid` cessant d'être référencés à mesure que les valeurs sont
 * réécrites.
 *
 * L'IV est tiré de `randomBytes` — jamais d'un compteur, jamais dérivé du
 * contenu, et évidemment jamais de `Math.random()`. En GCM, réutiliser un IV
 * avec la même clé est catastrophique : cela révèle le XOR des clairs et
 * compromet l'authentification.
 */
export function sealSecret(plaintext: string, ctx: SecretContext, keyring: Keyring): string {
  if (typeof plaintext !== 'string') {
    throw new SecretCryptoError('secret_context_invalid', 'plaintext : chaîne attendue')
  }
  // ⚠️ UN SECRET VIDE EST REFUSÉ, et ce n'est pas une limite technique : GCM
  // scelle très bien une chaîne vide. C'est un choix. Sceller le vide, c'est
  // presque toujours avoir laissé passer une valeur non renseignée — et le
  // résultat serait pire qu'une erreur : une ligne chiffrée d'apparence
  // normale, qui ferait passer le secret pour CONFIGURÉ alors qu'il est
  // absent. Effacer un secret doit se faire en supprimant sa ligne, pas en y
  // scellant du vide.
  if (plaintext.length === 0) {
    throw new SecretCryptoError('secret_context_invalid', 'plaintext vide : un secret absent se supprime, il ne se scelle pas')
  }
  const kid = keyring?.currentKid
  if (typeof kid !== 'string' || !kid) {
    throw new SecretCryptoError('secret_keyring_invalid', 'currentKid absent')
  }
  const donnees = aad(ctx, kid)          // valide le contexte au passage
  const key = cle(keyring, kid)
  const iv = randomBytes(IV_BYTES)

  try {
    const c = createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(donnees)
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
    const tag = c.getAuthTag()
    const env: SecretEnvelope = {
      envelopeVersion: ENVELOPE_VERSION, alg: ALG, kid,
      iv: iv.toString('base64url'),
      ciphertext: ct.toString('base64url'),
      tag: tag.toString('base64url'),
    }
    return JSON.stringify(env)
  } catch (e) {
    if (e instanceof SecretCryptoError) throw e
    // ⚠️ L'exception d'OpenSSL ne remonte pas : elle peut citer la donnée.
    throw new SecretCryptoError('secret_decrypt_failed', 'scellement impossible')
  }
}

/**
 * Ouvre une enveloppe SOUS LE CONTEXTE ATTENDU.
 *
 * Rend le clair, ou lève. Il n'existe aucun repli : ni contexte plus permissif,
 * ni essai avec une autre clé du trousseau, ni « on tente sans AAD ». Tenter
 * plusieurs clés reviendrait à transformer l'authentification en oracle, et
 * accepter un contexte plus large annulerait toute la propriété défendue ici.
 *
 * Tout échec d'authentification — chiffré retouché, tag modifié, IV changé,
 * contexte différent, chiffré déplacé vers une autre ligne — rend le MÊME
 * verdict : `secret_decrypt_failed`. GCM ne distingue pas ces cas, et prétendre
 * le contraire renseignerait un attaquant.
 */
export function openSecret(serialisee: string, ctx: SecretContext, keyring: Keyring): string {
  const env = parseEnvelope(serialisee)
  const key = cle(keyring, env.kid)
  const donnees = aad(ctx, env.kid)      // le kid vient de l'enveloppe : il est authentifié

  try {
    const d = createDecipheriv('aes-256-gcm', key, b64(env.iv))
    d.setAAD(donnees)
    d.setAuthTag(b64(env.tag))
    const clair = Buffer.concat([d.update(b64(env.ciphertext)), d.final()])
    return clair.toString('utf8')
  } catch (e) {
    if (e instanceof SecretCryptoError) throw e
    throw new SecretCryptoError('secret_decrypt_failed', 'authentification en échec')
  }
}

/**
 * Cette enveloppe a-t-elle été scellée avec la génération courante ?
 *
 * Sert au futur rechiffrement paresseux : lire, constater l'ancienneté,
 * réécrire avec `currentKid`. C'est ce qui fera tomber à zéro le nombre de
 * chiffrés référençant une ancienne clé, et rendra son retrait autorisable.
 */
export function isCurrentKid(serialisee: string, keyring: Keyring): boolean {
  return parseEnvelope(serialisee).kid === keyring.currentKid
}
