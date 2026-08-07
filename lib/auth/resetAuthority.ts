// L'AUTORITÉ DE RÉINITIALISATION — une ligne, un propriétaire (SEC-AUTH-0.1).
//
// ── LES DEUX DÉFAUTS FERMÉS ICI ─────────────────────────────────────────────
//
// 1. CONSOMMATION NON ATOMIQUE. `resetPassword` enchaînait :
//
//        checkResetToken()  →  setCredentials()  →  invalidateResetToken()
//
//    C'est un check-then-act, exactement le motif corrigé partout ailleurs dans
//    ce dépôt (SEC-0d, SEC-0e, SEC-0f.1). Deux requêtes portant le même lien —
//    un client qui rejoue, un préchargeur de lien, ou un attaquant qui tire
//    vingt fois — passaient toutes deux la vérification avant que la première
//    n'invalide. « Usage unique » n'était vrai que séquentiellement, et sur du
//    serverless multi-instance les requêtes sont réellement parallèles.
//
// 2. L'AUTORITÉ VIVAIT DANS LE KEYSTORE. `getKey` rend `store.get(name) ||
//    process.env[name]`. Une empreinte posée en variable d'environnement
//    SURVIVAIT donc à toute invalidation : `setKeys({ …: '' })` efface l'entrée
//    mémoire, et la lecture retombait aussitôt sur l'environnement. Un artefact
//    périmé redevenait une autorisation de changer le mot de passe
//    administrateur. Un secret consommable ne peut pas vivre dans un magasin
//    dont le repli est une valeur immuable.
//
// ── LE MODÈLE ───────────────────────────────────────────────────────────────
// Une SEULE ligne de `prospector_store` porte l'autorité :
//
//     (kind = 'authreset', id = 'admin', workspace_id = '_auth')
//     data = { hash: <sha256 hex du bearer>, exp: <ms> }
//
// Le bearer brut n'existe que dans la mémoire de la requête qui l'engendre, et
// dans l'email. Rien d'autre n'est stocké : ni mot de passe, ni secret de
// session, ni donnée client.
//
// La consommation est un `DELETE … WHERE data->>'hash' = $1 RETURNING` :
// PostgreSQL verrouille la ligne pour la durée de l'instruction, un seul
// appelant reçoit la donnée. Le gagnant est celui qui OBTIENT la ligne, jamais
// celui qui l'a lue.
//
// Aucune migration : la table et sa clé primaire `(kind, id, workspace_id)`
// existent depuis C2a-1.
import { upsertItem, claimItemIfField } from '../supabase/store'
import { supabaseConfigured } from '../supabase/client'
import { onVercel } from '../env'

export const RESET_KIND = 'authreset'
export const RESET_ID = 'admin'
/** Espace technique. Ce n'est ni un espace client, ni le tenant système. */
export const RESET_NS = '_auth'
export const RESET_TTL_MS = 30 * 60 * 1000

export interface ResetAuthority { hash: string; exp: number }

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Le magasin peut-il porter une AUTORITÉ ?
 *
 * `prospector_store` retombe sur une `Map` en mémoire quand Supabase n'est pas
 * configuré. C'est utile en développement, et ce serait faux ici : sur du
 * serverless, chaque instance a sa propre mémoire. Un jeton créé par l'instance
 * A serait inconnu de B (réinitialisation impossible) — mais surtout, chaque
 * instance porterait sa propre notion d'« usage unique », et le même lien
 * pourrait servir une fois par instance.
 *
 * Sur un déploiement, une base absente FERME donc la capacité, création comme
 * consommation. En local, le repli mémoire reste utilisable.
 */
export function resetStoreAuthoritative(): boolean {
  return supabaseConfigured() || !onVercel()
}

/**
 * Établit une nouvelle autorité et rend le bearer brut + son empreinte.
 *
 * `null` si le magasin n'est pas autoritaire ou si l'écriture échoue — auquel
 * cas l'appelant n'envoie aucun email et ne divulgue rien.
 *
 * ⚠️ UNE SEULE AUTORITÉ COURANTE. Une nouvelle demande REMPLACE la précédente :
 * la réinitialisation en cours est une autorité unique, pas une collection de
 * jetons encore valides. Deux demandes rapprochées invalident donc la première,
 * y compris si son email arrive plus tard — la sécurité prime sur l'ordre
 * d'arrivée des messages.
 */
export async function createResetAuthority(): Promise<{ token: string; hash: string } | null> {
  if (!resetStoreAuthoritative()) return null
  // 24 octets = 192 bits. Rien à ralentir : il n'y a pas de devinette possible.
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  const hash = await sha256Hex(token)
  const ok = await upsertItem(RESET_KIND, RESET_ID, { hash, exp: Date.now() + RESET_TTL_MS } as ResetAuthority, RESET_NS)
  if (!ok) return null
  return { token, hash }
}

/**
 * CONSOMME l'autorité si — et seulement si — elle porte l'empreinte du jeton
 * présenté. Rend `true` à UN SEUL appelant.
 *
 * `false` couvre indistinctement : jeton absent, faux, déjà consommé, expiré,
 * base muette, base absente sur un déploiement. « Je ne peux pas vérifier »
 * n'est jamais « le jeton est valide ».
 *
 * ⚠️ L'expiration est vérifiée APRÈS la réclamation. La ligne est donc
 * consommée même si elle était périmée — c'est voulu : un lien expiré n'a
 * aucune raison de rester réclamable.
 */
export async function claimResetAuthority(token: string): Promise<boolean> {
  if (!resetStoreAuthoritative()) return false
  const t = (token || '').trim()
  if (!t) return false
  const row = await claimItemIfField<ResetAuthority>(
    RESET_KIND, RESET_ID, RESET_NS, 'hash', await sha256Hex(t),
  )
  if (!row) return false
  const exp = Number(row.exp)
  return Number.isFinite(exp) && Date.now() < exp
}

/**
 * Invalide l'autorité SEULEMENT si elle est encore celle qu'on a créée.
 *
 * ── POURQUOI CONDITIONNELLE ─────────────────────────────────────────────────
 * Quand l'envoi de l'email échoue, il faut tuer le jeton que personne n'a reçu.
 * Mais une invalidation INCONDITIONNELLE supprimerait l'autorité d'une autre
 * demande arrivée entre-temps :
 *
 *     A crée hashA · B crée hashB · l'email de A échoue · A invalide → B mort
 *
 * B avait pourtant reçu son lien. La réinitialisation de l'administrateur
 * devenait impossible à volonté, en provoquant des échecs d'envoi : un déni de
 * service sur la seule voie de récupération du compte.
 *
 * La suppression est donc conditionnée à l'empreinte créée par CET appelant.
 */
export async function invalidateResetAuthority(hash: string): Promise<void> {
  if (!hash) return
  await claimItemIfField(RESET_KIND, RESET_ID, RESET_NS, 'hash', hash)
}
