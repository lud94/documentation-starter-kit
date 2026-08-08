// Coffre des secrets de plateforme — la seule couche qui voit un clair.
// Lot SEC-SECRETS-0C.1.
//
// ── LA SÉPARATION ───────────────────────────────────────────────────────────
// Ce module scelle et ouvre. Il n'importe PAS Supabase : il ne sait pas où les
// enveloppes sont rangées, et ne saurait pas y écrire directement même s'il le
// voulait. `lib/supabase/platformSecrets.ts` range et relit, sans jamais pouvoir
// ouvrir. Un clair ne peut donc exister que dans les variables locales d'une
// fonction de ce fichier — nulle part ailleurs, et jamais dans une ligne de base,
// un journal, un message d'erreur ou une réponse HTTP.
//
// ── CE QUE CE LOT NE FAIT PAS ───────────────────────────────────────────────
// Aucune valeur héritée n'est transférée ici. `prospector_settings` n'est pas lu,
// aucune variable d'environnement n'est consultée comme repli. Un secret absent
// du coffre est ABSENT : il ne « retombe » pas sur l'ancien emplacement. Un repli
// silencieux ferait coexister deux vérités et rendrait la révocation illusoire —
// on croirait avoir révoqué pendant que l'ancienne valeur continuerait de servir.
import { sealSecret, openSecret, type SecretContext } from './crypto'
import { loadKeyringFromEnv } from './keyring'
import type { KidInventory } from './keyring'
import { SecretCryptoError } from './errors'
import {
  PLATFORM_SECRET_NAMES, isPlatformSecretName,
  readPlatformSecretRow, referencedPlatformKidsRaw,
  createPlatformSecret, replacePlatformSecret, promotePlatformSecret,
  revokePlatformSecret, rewrapPlatformSecret, adoptLegacyTotpEnvelope,
  type PlatformSecretName, type PlatformSecretStatus, type PlatformSecretOutcome,
} from '../supabase/platformSecrets'

export { PLATFORM_SECRET_NAMES, isPlatformSecretName }
export type { PlatformSecretName, PlatformSecretStatus }

/**
 * Contexte AAD d'un secret de plateforme.
 *
 * ⚠️ LES DIMENSIONS DE PORTÉE SONT FORCÉES À `null`, elles ne sont pas
 * « laissées vides ». L'AAD lie le chiffré à son contexte exact : une enveloppe
 * scellée ici ne peut s'ouvrir que sous `scope: 'platform'`, ce nom-là et cette
 * version-là. Quelqu'un capable d'écrire dans la base ne peut donc pas déplacer
 * l'enveloppe du webhook vers la ligne du jeton de bot, ni rejouer une ancienne
 * génération sous une version courante : le déchiffrement échoue, il ne rend pas
 * une valeur plausible.
 *
 * `secretVersion` fait partie de l'AAD. C'est ce qui interdit le REJEU : une
 * enveloppe de version N recopiée sur une ligne de version N+1 est illisible.
 */
export function platformSecretContext(name: PlatformSecretName, version: number): SecretContext {
  if (!isPlatformSecretName(name)) {
    throw new SecretCryptoError('secret_context_invalid', 'nom de secret de plateforme inconnu')
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new SecretCryptoError('secret_context_invalid', 'version de secret absente ou invalide')
  }
  return {
    scope: 'platform',
    secretName: name,
    workspaceId: null,
    provider: null,
    credentialId: null,
    secretVersion: version,
  }
}

/** Issue d'une écriture, telle que les appelants la voient. */
export type VaultWrite =
  | { ok: true; outcome: Exclude<PlatformSecretOutcome, 'stale' | 'denied'>; version: number }
  | { ok: false; outcome: PlatformSecretOutcome | 'verify_failed'; version?: number }

/** Issue d'une lecture. `absent` et `unreadable` ne sont PAS le même fait. */
export type VaultRead =
  | { ok: true; value: string; version: number; status: PlatformSecretStatus }
  | { ok: false; reason: 'absent' | 'revoked' | 'wrong_state' | 'unreadable' }

function keyring() {
  // Charge à l'usage, jamais à l'import : une instance mal configurée doit
  // pouvoir démarrer et être diagnostiquée. Une exception ici est un échec de
  // l'opération, pas un échec de chargement du module.
  return loadKeyringFromEnv()
}

/**
 * ÉCRITURE VÉRIFIÉE — l'ordre est le contrat de ce lot.
 *
 *   valider → contexte → SCELLER → RPC → issue reconnue → RELIRE → OUVRIR
 *
 * Deux points méritent d'être dits explicitement :
 *
 * 1. ON SCELLE AVANT D'ÉCRIRE, jamais l'inverse. Une écriture d'abord suivie
 *    d'un scellement laisserait une fenêtre où la base porte une valeur que
 *    personne n'a authentifiée.
 *
 * 2. UNE RPC RÉUSSIE NE SUFFIT PAS. Tant que la ligne écrite n'a pas été relue
 *    ET rouverte sous le contexte exact, on ne sait pas qu'elle est lisible : on
 *    sait seulement que la base a accepté des octets. Pour le sceau TOTP, la
 *    différence est celle entre « la 2FA est posée » et « l'administrateur est
 *    enfermé dehors ». Échec de vérification ⇒ `verify_failed`, jamais `ok`.
 *
 * ⚠️ AUCUN ROLLBACK AUTOMATIQUE en cas d'échec de vérification. Défaire
 * demanderait une écriture supplémentaire, sous une version qu'on vient
 * justement de constater incertaine — et cette écriture-là pourrait détruire une
 * génération valide écrite entre-temps par quelqu'un d'autre. L'état est laissé
 * tel quel, signalé, et tranché par un opérateur. Un coffre ne se répare pas tout
 * seul en écrivant à l'aveugle.
 */
async function ecrireEtVerifier(
  name: PlatformSecretName,
  plaintext: string,
  versionAttendue: number,
  appliquer: (envelope: string) => Promise<PlatformSecretOutcome>,
  succes: readonly PlatformSecretOutcome[],
): Promise<VaultWrite> {
  if (!isPlatformSecretName(name)) return { ok: false, outcome: 'denied' }
  if (typeof plaintext !== 'string' || !plaintext) return { ok: false, outcome: 'denied' }

  let envelope: string
  try {
    envelope = sealSecret(plaintext, platformSecretContext(name, versionAttendue), keyring())
  } catch {
    // Trousseau absent, clef invalide, contexte incohérent : on n'écrit rien.
    // Aucun détail ne remonte — il décrirait la configuration cryptographique.
    return { ok: false, outcome: 'denied' }
  }

  const outcome = await appliquer(envelope)
  if (!succes.includes(outcome)) return { ok: false, outcome }

  const relue = await readPlatformSecretRow(name)
  if (!relue || relue.secretVersion !== versionAttendue || !relue.envelope) {
    return { ok: false, outcome: 'verify_failed', version: relue?.secretVersion }
  }
  try {
    openSecret(relue.envelope, platformSecretContext(name, relue.secretVersion), keyring())
  } catch {
    return { ok: false, outcome: 'verify_failed', version: relue.secretVersion }
  }
  return { ok: true, outcome: outcome as any, version: relue.secretVersion }
}

/** Lecture ouverte, restreinte aux états où le secret fait autorité. */
async function lire(
  name: PlatformSecretName,
  etatsAcceptes: readonly PlatformSecretStatus[],
): Promise<VaultRead> {
  const row = await readPlatformSecretRow(name)
  if (!row) return { ok: false, reason: 'absent' }
  if (row.status === 'revoked') return { ok: false, reason: 'revoked' }
  if (!etatsAcceptes.includes(row.status)) return { ok: false, reason: 'wrong_state' }
  if (!row.envelope) return { ok: false, reason: 'unreadable' }
  try {
    const value = openSecret(row.envelope, platformSecretContext(name, row.secretVersion), keyring())
    return { ok: true, value, version: row.secretVersion, status: row.status }
  } catch {
    // Mauvaise clef, enveloppe déplacée, AAD non concordante, trousseau absent :
    // on ne sait pas ce que vaut cette ligne, donc elle ne vaut rien.
    return { ok: false, reason: 'unreadable' }
  }
}

/**
 * État d'un secret SANS déchiffrement.
 *
 * Sert aux surfaces qui ont seulement besoin de savoir « la 2FA est-elle
 * active ? » ou « le webhook est-il confirmé ? ». Aucune raison de charger le
 * trousseau ni d'ouvrir une enveloppe pour répondre à une question booléenne —
 * et un chemin qui ne déchiffre pas est un chemin qui ne peut pas fuiter.
 */
export async function platformSecretStatus(name: PlatformSecretName): Promise<PlatformSecretStatus | 'absent'> {
  const row = await readPlatformSecretRow(name)
  return row ? row.status : 'absent'
}

/**
 * Inventaire des kid, au format attendu par `assertSafeKeyringTransition`.
 *
 * ⚠️ `complete: true` ne signifie ici que « ce coffre a été lu entièrement ».
 * Si d'autres tables portent un jour des chiffrés, leur inventaire devra être
 * joint à celui-ci AVANT toute décision de rotation ; prendre cette valeur pour
 * l'inventaire global autoriserait le retrait d'une clef encore utilisée
 * ailleurs.
 */
export async function referencedPlatformKids(): Promise<KidInventory> {
  const r = await referencedPlatformKidsRaw()
  return r.complete ? { complete: true, referencedKids: r.kids } : { complete: false }
}

// ── Sceau TOTP administrateur ───────────────────────────────────────────────
// staged → active → revoked. Le passage par `staged` n'est pas une formalité :
// un sceau devenu actif sans qu'un code valide ait été présenté peut enfermer
// dehors le seul administrateur, sans recours.

/** Pose un sceau TOTP NON encore prouvé. N'écrase rien : `exists` si présent. */
export function stageAdminTotpSecret(seed: string): Promise<VaultWrite> {
  return ecrireEtVerifier('admin_totp_secret', seed, 1,
    (e) => createPlatformSecret('admin_totp_secret', e), ['created'])
}

/** Prouvé : le sceau devient l'autorité. La valeur ne change pas, la version non plus. */
export async function promoteAdminTotpSecret(expectedVersion: number): Promise<VaultWrite> {
  const outcome = await promotePlatformSecret('admin_totp_secret', expectedVersion)
  if (outcome !== 'promoted') return { ok: false, outcome }
  // Rien n'a été scellé : on vérifie l'ÉTAT, pas la lisibilité — la valeur est
  // exactement celle qui était déjà là, et elle a été ouverte pour être prouvée.
  const row = await readPlatformSecretRow('admin_totp_secret')
  if (!row || row.status !== 'active' || row.secretVersion !== expectedVersion) {
    return { ok: false, outcome: 'verify_failed', version: row?.secretVersion }
  }
  return { ok: true, outcome: 'promoted', version: row.secretVersion }
}

export async function revokeAdminTotpSecret(expectedVersion: number): Promise<VaultWrite> {
  return tombstone('admin_totp_secret', expectedVersion)
}

/** Rend le sceau UNIQUEMENT s'il est actif. Un sceau `staged` n'authentifie personne. */
export function readAdminTotpSecret(): Promise<VaultRead> {
  return lire('admin_totp_secret', ['active'])
}

// ── Secret de webhook Telegram ──────────────────────────────────────────────
// pending_provider → active → revoked. C'est le FOURNISSEUR qui détient la
// vérité : tant que Telegram n'a pas accepté le `setWebhook`, la base ne doit pas
// affirmer que ce secret est celui qui sera présenté.

/** Écrit le secret AVANT l'appel fournisseur, en `pending_provider`. */
export function putTelegramWebhookPending(secret: string): Promise<VaultWrite> {
  return ecrireEtVerifier('telegram_webhook_secret', secret, 1,
    (e) => createPlatformSecret('telegram_webhook_secret', e), ['created'])
}

/** Telegram a accepté : le secret devient celui qu'on exige des entrants. */
export async function confirmTelegramWebhookActive(expectedVersion: number): Promise<VaultWrite> {
  const outcome = await promotePlatformSecret('telegram_webhook_secret', expectedVersion)
  if (outcome !== 'promoted') return { ok: false, outcome }
  const row = await readPlatformSecretRow('telegram_webhook_secret')
  if (!row || row.status !== 'active' || row.secretVersion !== expectedVersion) {
    return { ok: false, outcome: 'verify_failed', version: row?.secretVersion }
  }
  return { ok: true, outcome: 'promoted', version: row.secretVersion }
}

export function revokeTelegramWebhook(expectedVersion: number): Promise<VaultWrite> {
  return tombstone('telegram_webhook_secret', expectedVersion)
}

/**
 * Le vérificateur d'entrants accepte `pending_provider` ET `active`.
 *
 * ⚠️ CE N'EST PAS UN RELÂCHEMENT. Entre l'écriture et la confirmation, Telegram
 * peut déjà présenter ce secret : le refuser rejetterait des messages
 * authentiques. Ce qui compte pour un entrant, c'est que le secret présenté soit
 * CELUI QU'ON A ÉMIS — et il l'est dans les deux états. `revoked` reste refusé :
 * là, on a explicitement retiré l'autorité.
 */
export function readTelegramWebhookSecret(): Promise<VaultRead> {
  return lire('telegram_webhook_secret', ['pending_provider', 'active'])
}

// ── Jeton du bot Telegram ───────────────────────────────────────────────────
// active → revoked. Aucune promotion : un jeton BotFather est valide dès sa
// réception, il n'y a rien à prouver.

export function putTelegramBotToken(token: string): Promise<VaultWrite> {
  return ecrireEtVerifier('telegram_bot_token', token, 1,
    (e) => createPlatformSecret('telegram_bot_token', e), ['created'])
}

export function revokeTelegramBotToken(expectedVersion: number): Promise<VaultWrite> {
  return tombstone('telegram_bot_token', expectedVersion)
}

export function readTelegramBotToken(): Promise<VaultRead> {
  return lire('telegram_bot_token', ['active'])
}

// ── Opérations communes ─────────────────────────────────────────────────────

/**
 * Révocation : la pierre tombale porte version+1, sans enveloppe.
 *
 * On VÉRIFIE que la ligne est bien devenue une pierre tombale. Une révocation
 * qu'on croit faite et qui ne l'est pas est le pire des deux mondes : on cesse
 * de surveiller un secret qui continue de servir.
 */
async function tombstone(name: PlatformSecretName, expectedVersion: number): Promise<VaultWrite> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return { ok: false, outcome: 'denied' }
  const outcome = await revokePlatformSecret(name, expectedVersion)
  if (outcome !== 'revoked') return { ok: false, outcome }
  const row = await readPlatformSecretRow(name)
  if (!row || row.status !== 'revoked' || row.envelope !== null || row.kid !== null) {
    return { ok: false, outcome: 'verify_failed', version: row?.secretVersion }
  }
  return { ok: true, outcome: 'revoked', version: row.secretVersion }
}

/**
 * Nouvelle génération d'un secret existant, sous compare-and-swap.
 *
 * Fonctionne aussi depuis une pierre tombale : révoquer ne doit pas condamner un
 * emplacement. La version repart de `expectedVersion + 1`, jamais de 1 — sans
 * quoi un appelant détenant une vieille version verrait son CAS réussir après un
 * cycle complet, et écraserait une génération qu'il n'a jamais observée.
 */
export function replacePlatformSecretValue(
  name: PlatformSecretName, plaintext: string, expectedVersion: number,
): Promise<VaultWrite> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return Promise.resolve({ ok: false, outcome: 'denied' } as VaultWrite)
  }
  return ecrireEtVerifier(name, plaintext, expectedVersion + 1,
    (e) => replacePlatformSecret(name, e, expectedVersion), ['replaced'])
}

/**
 * Re-scellement sous une nouvelle clef — MÊME clair, MÊME version.
 *
 * Le clair est obtenu en ouvrant l'enveloppe courante : c'est la seule façon de
 * re-sceller sans que l'appelant ait à manipuler le secret. Il ne quitte jamais
 * cette fonction.
 *
 * La version ne bouge pas parce que le secret n'a pas changé — seule sa clef de
 * protection change. L'incrémenter invaliderait le CAS de tous les appelants
 * légitimes à chaque rotation, ce qui pousserait à ne plus jamais tourner.
 */
export async function rewrapPlatformSecretValue(name: PlatformSecretName): Promise<VaultWrite> {
  const row = await readPlatformSecretRow(name)
  if (!row || row.status === 'revoked' || !row.envelope || !row.kid) {
    return { ok: false, outcome: 'denied' }
  }
  const ctx = platformSecretContext(name, row.secretVersion)
  let clair: string
  try {
    clair = openSecret(row.envelope, ctx, keyring())
  } catch {
    // On ne peut pas re-sceller ce qu'on ne sait pas lire. Écrire ici
    // remplacerait un chiffré illisible par un chiffré vide de sens.
    return { ok: false, outcome: 'denied' }
  }
  const ancienKid = row.kid
  return ecrireEtVerifier(name, clair, row.secretVersion,
    (e) => rewrapPlatformSecret(name, row.secretVersion, ancienKid, e), ['rewrapped'])
}

/**
 * Adoption du sceau TOTP hérité — ACTIF d'emblée, et c'est délibéré.
 *
 * Le sceau déjà en service est déjà prouvé : le téléphone de l'administrateur
 * génère des codes valides aujourd'hui. Le faire passer par `staged` exigerait
 * une nouvelle preuve pour un sceau qui n'a pas changé, et laisserait la
 * deuxième authentification INACTIVE entre les deux. Migrer un secret n'est pas
 * le faire tourner.
 *
 * L'étroitesse est ce qui rend l'exception acceptable : uniquement ce nom-là,
 * uniquement en l'absence de ligne, toujours en version 1. Elle ne peut ni
 * écraser une génération vivante, ni ressusciter une pierre tombale, ni rendre
 * actif un secret Telegram sans sa confirmation fournisseur.
 */
export function adoptLegacyAdminTotpSecret(seed: string): Promise<VaultWrite> {
  return ecrireEtVerifier('admin_totp_secret', seed, 1,
    (e) => adoptLegacyTotpEnvelope(e), ['adopted'])
}
