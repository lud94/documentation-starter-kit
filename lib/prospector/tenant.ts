// Contexte TENANT — racine de confiance des appels LLM (lot MT-0).
//
// ── POURQUOI UN MODULE DÉDIÉ ─────────────────────────────────────────────────
// Avant ce lot, AUCUNE route appelant Claude ne résolvait d'espace client :
// `pages/api/missions/plan.ts`, `pages/api/enrich/person.ts` et
// `pages/api/jarvis/chat.ts` ne contenaient pas une seule occurrence de
// `workspace`. La seule résolution existante vivait en local dans
// `pages/api/leads/index.ts` — non partagée, et bâtie pour la persistance de
// leads, pas pour arbitrer une dépense.
//
// ⚠️ CE HELPER N'EST PAS UNE COPIE DE `activeWorkspace()`. Cette fonction
// traitait `!claims` — c'est-à-dire AUCUNE SESSION — comme un administrateur.
// Acceptable pour lire une liste de leads derrière un middleware qui a déjà
// refusé les non-authentifiés ; inacceptable comme racine de confiance d'une
// dépense fournisseur, parce que la moindre route publique oubliée devient un
// administrateur anonyme. Ici, aucune session valide ⇒ AUCUN tenant.
//
// ── TROIS ORIGINES, JAMAIS QUATRE ────────────────────────────────────────────
//   client   session valide, `role: 'client'` → tenant = `claims.ws`, IMPOSÉ.
//            Aucune valeur de body, de query ou de cookie ne peut s'y substituer :
//            ce chemin ne les lit pas du tout.
//   admin    session valide → espace actif du sélecteur, dont l'EXISTENCE et
//            l'utilisabilité sont vérifiées en base.
//   system   contexte EXPLICITE, réservé à une liste blanche de chemins
//            réellement systèmes. Jamais déduit, jamais implicite.
//
// `'admin'` n'est PAS le tenant système : c'est l'espace de travail propre de
// l'administrateur, qui porte de vraies données. Les confondre imputerait une
// consommation de diagnostic à un espace métier.
//
// ⚠️ `null` n'est jamais un tenant. Sur un chemin métier, l'absence de tenant
// FERME (fail closed). La colonne `tenant_id` restée NULL en base ne désigne
// que l'historique antérieur à ce lot.
import type { NextApiRequest } from 'next'
import { readSession, SESSION_COOKIE } from '../auth/session'
import { getWorkspaceById } from '../supabase/workspaces'

export type TenantKind = 'client' | 'admin' | 'system'

export interface TenantContext {
  /** Identifiant d'espace (`ws_*`, `'admin'`) ou le tenant système. */
  id: string
  kind: TenantKind
  /** Renseigné pour `kind: 'system'` — l'étiquette du chemin autorisé. */
  systemTag?: string
}

/**
 * Tenant des appels réellement systèmes. Volontairement distinct de `'admin'`,
 * et volontairement pas `null` : une ligne à NULL doit continuer de signifier
 * « antérieur à MT-0 », jamais « appel courant sans tenant ».
 */
export const SYSTEM_TENANT_ID = '_system'

/** Espace propre de l'administrateur. Un espace métier, pas un tenant système. */
export const ADMIN_TENANT_ID = 'admin'

/** Cookie du sélecteur d'espace actif de l'Admin (déjà en place). */
export const ACTIVE_WS_COOKIE = 'ps_active_ws'

/**
 * Liste blanche des chemins autorisés à s'exécuter en contexte système.
 *
 * Toute addition ici doit être justifiée en revue : elle crée un chemin de
 * dépense qui échappe à l'imputation client. Un chemin métier ne doit JAMAIS
 * y figurer — il doit résoudre un vrai tenant ou refuser.
 */
export const SYSTEM_TAGS = [
  'diagnose',   // pages/api/ai/diagnose.ts — sondes de capacité, Admin uniquement
] as const
export type SystemTag = typeof SYSTEM_TAGS[number]

/**
 * Contexte système EXPLICITE. Une étiquette hors liste blanche est refusée :
 * on ne peut pas obtenir un contexte système « par accident ».
 */
export function systemTenant(tag: SystemTag): TenantContext {
  if (!(SYSTEM_TAGS as readonly string[]).includes(tag)) {
    throw new Error(`contexte système refusé pour une étiquette non listée : ${tag}`)
  }
  return { id: SYSTEM_TENANT_ID, kind: 'system', systemTag: tag }
}

/**
 * Tenant d'un espace résolu hors session — jeton d'ingestion par espace
 * (`resolveWorkspaceByToken`) ou appairage de canal (`resolveChannelWs`).
 *
 * Ces chemins sont publics au sens du middleware mais portent leur PROPRE
 * garde, qui rend déjà un identifiant d'espace vérifié. On les traite en
 * `client` : ce sont des espaces métier, imputables comme tels.
 * Un identifiant vide rend `null` — l'appelant doit refuser.
 */
export async function tenantFromVerifiedWorkspace(
  wsId: string | null | undefined,
): Promise<TenantContext | null> {
  const id = (wsId || '').trim()
  if (!id) return null
  if (id === SYSTEM_TENANT_ID) return null // jamais usurpable depuis l'extérieur
  if (id === ADMIN_TENANT_ID) return { id: ADMIN_TENANT_ID, kind: 'admin' }
  return (await workspaceUsable(id)) ? { id, kind: 'client' } : null
}

/**
 * L'espace existe-t-il ENCORE et est-il utilisable ?
 *
 * ── LE DÉFAUT QUE CECI FERME (lot SEC-0c) ───────────────────────────────────
 * Les trois racines de confiance — session client, jeton d'ingestion, canal
 * appairé — établissaient l'AUTHENTICITÉ d'un identifiant d'espace, jamais sa
 * VALIDITÉ COURANTE :
 *
 *   • la session est un HMAC apatride de 12 h, sans révocation ; `authClient()`
 *     ne teste `status = 'suspended'` qu'À LA CONNEXION ;
 *   • le jeton d'ingestion est dérivé par HMAC de l'identifiant d'espace : il
 *     reste valide tant que sa version ne bouge pas ;
 *   • un lien de canal Telegram est durable par construction.
 *
 * Conséquence mesurée : SUSPENDRE ou SUPPRIMER un espace ne l'empêchait pas de
 * travailler — jusqu'à douze heures pour une session, INDÉFINIMENT pour un
 * jeton ou un canal. Une suspension qui ne suspend rien n'est pas une mesure
 * de sécurité, c'est un affichage.
 *
 * ── LE COÛT, ASSUMÉ ──────────────────────────────────────────────────────────
 * Une lecture par requête, sur la clé primaire de `prospector_workspaces`.
 * La branche ADMIN la payait déjà depuis MT-0 ; les autres branches ne sont
 * pas moins sensibles. AUCUN CACHE n'est introduit : un cache borne le délai de
 * révocation, et ce délai serait précisément la fenêtre qu'on vient de fermer.
 * Le jour où le profil de charge l'exigera, il faudra écrire ce délai noir sur
 * blanc — pas le découvrir.
 *
 * Base indisponible ⇒ `false`. Un espace non vérifiable n'est pas un espace.
 */
async function workspaceUsable(id: string): Promise<boolean> {
  try {
    const ws = await getWorkspaceById(id)
    return !!ws && ws.status !== 'suspended'
  } catch {
    return false
  }
}

/**
 * Résout le tenant d'une requête HTTP authentifiée par session.
 *
 * Rend `null` — et l'appelant DOIT refuser — dans tous les cas douteux :
 * pas de session valide, session client sans espace, espace admin inexistant
 * ou suspendu.
 */
export async function resolveTenantFromRequest(req: NextApiRequest): Promise<TenantContext | null> {
  const claims = await readSession(req.cookies?.[SESSION_COOKIE])

  // Aucune session valide ⇒ aucun tenant. C'est la correction centrale par
  // rapport à `activeWorkspace()`, qui promouvait ce cas en administrateur.
  if (!claims) return null

  if (claims.role === 'client') {
    const id = (claims.ws || '').trim()
    // Une session client sans espace est incohérente : on ferme plutôt que de
    // retomber sur un espace par défaut. Le body et la query ne sont jamais lus.
    if (!id || id === SYSTEM_TENANT_ID) return null
    // Un client ne peut pas revendiquer l'espace propre de l'administrateur,
    // même si son jeton le porte : `authClient()` ne l'émet jamais, donc un tel
    // jeton est forcément anormal.
    if (id === ADMIN_TENANT_ID) return null
    // SEC-0c — la signature prouve l'authenticité de l'identifiant, pas que
    // l'espace soit ENCORE utilisable. Sans cette lecture, une suspension
    // n'aurait d'effet qu'à l'expiration du jeton, douze heures plus tard.
    if (!(await workspaceUsable(id))) return null
    return { id, kind: 'client' }
  }

  // Administrateur — y compris les sessions héritées sans `role`, qui ne sont
  // acceptées QUE parce que leur signature a été vérifiée ci-dessus.
  const requested = (req.cookies?.[ACTIVE_WS_COOKIE] || '').trim() || ADMIN_TENANT_ID
  if (requested === SYSTEM_TENANT_ID) return null

  // L'espace propre de l'admin n'a pas de ligne dédiée dans
  // `prospector_workspaces` : il est valide par construction.
  if (requested === ADMIN_TENANT_ID) return { id: ADMIN_TENANT_ID, kind: 'admin' }

  // Tout autre espace doit EXISTER et être utilisable. Une valeur arbitraire
  // posée dans le cookie ne doit pas devenir un tenant.
  try {
    const ws = await getWorkspaceById(requested)
    if (!ws || ws.status === 'suspended') return null
    return { id: ws.id, kind: 'admin' }
  } catch {
    // Base indisponible : on ferme. Un tenant non vérifiable n'est pas un tenant.
    return null
  }
}

/** Vrai si le contexte peut porter une dépense imputable. */
export function isBillableTenant(t: TenantContext | null | undefined): boolean {
  return !!t && !!t.id && (t.kind === 'client' || t.kind === 'admin' || t.kind === 'system')
}
