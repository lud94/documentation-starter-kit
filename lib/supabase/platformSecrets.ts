// Accès Supabase au coffre des secrets de plateforme — lot SEC-SECRETS-0C.1.
//
// ── LA FRONTIÈRE QUE CE MODULE MATÉRIALISE ──────────────────────────────────
// C'est le SEUL module autorisé à parler à `prospector_platform_secrets`. Il ne
// connaît que des ENVELOPPES : des chaînes déjà scellées, qu'il transporte sans
// pouvoir les ouvrir. Il n'importe ni `lib/secrets/crypto`, ni le trousseau, et
// n'a donc aucun moyen de produire ou de lire un clair. Cette impuissance est
// délibérée : elle rend impossible qu'un secret en clair transite par la couche
// qui parle au réseau.
//
// Symétriquement, `lib/secrets/platformVault.ts` détient le clair et n'importe
// jamais Supabase. Les deux moitiés ne se rejoignent nulle part.
//
// ── AUCUN CACHE, AUCUNE HYDRATATION GLOBALE ─────────────────────────────────
// `hydrateKeystore()` charge tout en mémoire une fois par instance. Appliqué ici,
// ce motif garderait un secret révoqué vivant jusqu'au prochain démarrage à
// froid — c'est-à-dire que la révocation, l'opération la plus urgente du coffre,
// serait la plus lente à prendre effet. Chaque lecture retourne donc en base.
//
// ── LES ERREURS NE REMONTENT PAS BRUTES ─────────────────────────────────────
// PostgreSQL joint volontiers la ligne fautive au message d'une violation de
// contrainte (`DETAIL: Failing row contains …`). Cette ligne porte l'enveloppe.
// Elle ne contient aucun clair, mais elle n'a rien à faire dans un journal ni
// dans une réponse HTTP. Toute erreur est donc convertie en une valeur de retour
// close ; rien de ce que dit la base ne traverse ce module.
import { supabase } from './client'
import { writeAllowed } from '../env'

const TABLE = 'prospector_platform_secrets'

/** Les trois seuls noms. Doit rester identique à la CHECK de la migration. */
export const PLATFORM_SECRET_NAMES = [
  'admin_totp_secret',
  'telegram_webhook_secret',
  'telegram_bot_token',
] as const
export type PlatformSecretName = typeof PLATFORM_SECRET_NAMES[number]

export function isPlatformSecretName(v: unknown): v is PlatformSecretName {
  return typeof v === 'string' && (PLATFORM_SECRET_NAMES as readonly string[]).includes(v)
}

/** Les quatre états. `revoked` est une pierre tombale, pas une absence de ligne. */
export const PLATFORM_SECRET_STATUSES = ['staged', 'pending_provider', 'active', 'revoked'] as const
export type PlatformSecretStatus = typeof PLATFORM_SECRET_STATUSES[number]

/**
 * Une ligne du coffre, telle qu'elle est lue.
 *
 * `envelope` est scellée. Ce module ne prétend pas savoir ce qu'elle contient.
 */
export interface PlatformSecretRow {
  secretName: PlatformSecretName
  /** `null` sur une pierre tombale, et seulement là. */
  envelope: string | null
  kid: string | null
  secretVersion: number
  status: PlatformSecretStatus
}

/**
 * Issue d'une écriture.
 *
 * `denied` couvre TOUT ce qui n'est pas une réponse claire de la base :
 * environnement non autorisé à écrire, Supabase absent, RPC refusée, exception.
 * Un appelant ne peut pas distinguer ces cas — et n'en a pas besoin : aucun
 * d'eux n'est un succès. Les distinguer offrirait un oracle sur la configuration.
 */
export type PlatformSecretOutcome =
  | 'created' | 'exists'
  | 'replaced' | 'promoted' | 'revoked' | 'rewrapped' | 'adopted'
  | 'stale'
  | 'denied'

/** Les seules issues que la base est autorisée à prononcer. */
const OUTCOMES: readonly string[] = [
  'created', 'exists', 'replaced', 'promoted', 'revoked', 'rewrapped', 'adopted', 'stale',
]

function ligne(row: any): PlatformSecretRow | null {
  if (!row || !isPlatformSecretName(row.secret_name)) return null
  const version = Number(row.secret_version)
  if (!Number.isInteger(version) || version < 1) return null
  if (!(PLATFORM_SECRET_STATUSES as readonly string[]).includes(row.status)) return null
  const env = typeof row.envelope === 'string' && row.envelope ? row.envelope : null
  const kid = typeof row.kid === 'string' && row.kid ? row.kid : null
  // La cohérence état/contenu est déjà imposée en base. On la revérifie ici parce
  // qu'une ligne lue est une ENTRÉE : elle vient d'un processus distant, et une
  // base future ou mal migrée pourrait en produire une autre. Fermé par défaut.
  if (row.status === 'revoked') {
    if (env !== null || kid !== null) return null
  } else if (env === null || kid === null) {
    return null
  }
  return {
    secretName: row.secret_name,
    envelope: env,
    kid,
    secretVersion: version,
    status: row.status,
  }
}

/** Lit une ligne. `null` = absente, illisible, ou incohérente — jamais « vide ». */
export async function readPlatformSecretRow(name: PlatformSecretName): Promise<PlatformSecretRow | null> {
  if (!isPlatformSecretName(name)) return null
  const sb = supabase()
  if (!sb) return null
  try {
    const { data, error } = await sb.from(TABLE)
      .select('secret_name, envelope, kid, secret_version, status')
      .eq('secret_name', name)
      .maybeSingle()
    if (error || !data) return null
    return ligne(data)
  } catch {
    return null
  }
}

/**
 * Inventaire des `kid` encore référencés — l'entrée de `assertSafeKeyringTransition`.
 *
 * ⚠️ `complete: false` DÈS QUE LA LECTURE N'EST PAS SÛRE. Rendre une liste vide
 * sur une base injoignable ferait dire « aucune clef n'est utilisée », donc
 * « toutes les clefs peuvent être retirées » — la rotation détruirait alors le
 * seul exemplaire du sceau TOTP. Ne pas savoir n'autorise rien.
 *
 * ⚠️ La complétude ici est celle de CE coffre. Un appelant qui possède d'autres
 * porteurs de chiffrés doit intersecter les inventaires ; `complete: true` en
 * sortie de ce module n'est pas une complétude globale.
 */
export async function referencedPlatformKidsRaw(): Promise<{ complete: true; kids: string[] } | { complete: false }> {
  const sb = supabase()
  if (!sb) return { complete: false }
  try {
    const { data, error } = await sb.from(TABLE).select('kid').not('kid', 'is', null)
    if (error || !Array.isArray(data)) return { complete: false }
    const kids: string[] = []
    for (const r of data) {
      const k = (r as any)?.kid
      // Une ligne non textuelle dans une colonne qui ne devrait contenir que des
      // kid : on ne devine pas, on déclare l'inventaire non établi.
      if (typeof k !== 'string' || !k) return { complete: false }
      if (!kids.includes(k)) kids.push(k)
    }
    return { complete: true, kids }
  } catch {
    return { complete: false }
  }
}

/**
 * Appelle une RPC du coffre.
 *
 * `writeAllowed()` est évalué AVANT tout appel : le contrat d'environnement doit
 * pouvoir empêcher une préproduction d'écrire dans le coffre réel, et il ne le
 * peut que si la vérification précède le réseau.
 */
async function rpc(fn: string, args: Record<string, unknown>): Promise<PlatformSecretOutcome> {
  if (!writeAllowed(TABLE)) return 'denied'
  const sb = supabase()
  if (!sb) return 'denied'
  try {
    const { data, error } = await sb.rpc(fn, args)
    if (error) return 'denied'
    // La base est la seule autorité sur l'issue, mais son mot doit être connu :
    // une valeur inattendue est un désaccord de contrat, pas un succès nuancé.
    return OUTCOMES.includes(data as string) ? (data as PlatformSecretOutcome) : 'denied'
  } catch {
    return 'denied'
  }
}

export function createPlatformSecret(name: PlatformSecretName, envelope: string) {
  return rpc('prospector_platform_secret_create', { p_name: name, p_envelope: envelope })
}

export function replacePlatformSecret(name: PlatformSecretName, envelope: string, expectedVersion: number) {
  return rpc('prospector_platform_secret_replace',
    { p_name: name, p_envelope: envelope, p_expected_version: expectedVersion })
}

export function promotePlatformSecret(name: PlatformSecretName, expectedVersion: number) {
  return rpc('prospector_platform_secret_promote', { p_name: name, p_expected_version: expectedVersion })
}

export function revokePlatformSecret(name: PlatformSecretName, expectedVersion: number) {
  return rpc('prospector_platform_secret_revoke', { p_name: name, p_expected_version: expectedVersion })
}

export function rewrapPlatformSecret(
  name: PlatformSecretName, expectedVersion: number, oldKid: string, envelope: string,
) {
  return rpc('prospector_platform_secret_rewrap',
    { p_name: name, p_expected_version: expectedVersion, p_old_kid: oldKid, p_envelope: envelope })
}

/** Adoption du sceau TOTP hérité. Aucun paramètre de nom : il n'y a rien à choisir. */
export function adoptLegacyTotpEnvelope(envelope: string) {
  return rpc('prospector_platform_secret_adopt_legacy_totp', { p_envelope: envelope })
}
