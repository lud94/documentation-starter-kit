// Porte d'entrée des routes d'extension — lot SEC-EXT-0.
//
// Le navigateur est NON FIABLE. Il transporte une intention et un credential ;
// il ne transporte jamais l'autorité tenant, ni l'action à exécuter.
//
// Ce module regroupe les trois contrôles que les deux routes d'extension
// partagent, pour qu'ils ne puissent pas diverger :
//   1. l'origine autorisée (défense supplémentaire, jamais l'autorité) ;
//   2. le credential, lu UNIQUEMENT dans l'en-tête prévu ;
//   3. l'attente de confirmation, dont l'action ne quitte jamais le serveur.
import { claimItem, claimItemIfField, insertItemIfAbsent, deleteExpired } from '../supabase/store'
import { getKey } from './keystore'

// ── CORS ────────────────────────────────────────────────────────────────────
//
// ⚠️ `Access-Control-Allow-Origin: *` a disparu. CORS n'est PAS une frontière
// d'authentification — le jeton et sa portée le sont — mais renvoyer `*` sur une
// route qui accepte un credential invite n'importe quelle page à tenter sa
// chance, et rend l'exfiltration de la réponse triviale si un credential fuit.
//
// L'allowlist se déclare par `EXTENSION_ORIGINS` (identifiants d'extension
// séparés par des virgules). Absente, aucune origine navigateur n'est autorisée
// — mais la route reste appelable sans en-tête `Origin` (extension MV3 appelant
// depuis son service worker, tests, outils serveur), où CORS n'a aucun rôle.

/** Origines autorisées, telles que déclarées. Jamais de réflexion libre. */
export function allowedOrigins(): string[] {
  return (getKey('EXTENSION_ORIGINS') || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
}

export interface CorsDecision { allowed: boolean; origin: string | null }

/**
 * Décide du sort d'une origine. Une requête SANS `Origin` est acceptée : ce
 * n'est pas une requête de page web, et la refuser casserait les appels
 * légitimes du service worker sans rien protéger.
 */
export function decideCors(origin: string | undefined | null): CorsDecision {
  const o = (origin || '').trim()
  if (!o) return { allowed: true, origin: null }   // pas une requête de navigateur
  return { allowed: allowedOrigins().includes(o), origin: o }
}

/** Pose les en-têtes CORS. `Vary: Origin` : la réponse dépend de l'origine. */
export function applyCors(res: any, d: CorsDecision): void {
  res.setHeader('Vary', 'Origin')
  if (d.origin && d.allowed) {
    res.setHeader('Access-Control-Allow-Origin', d.origin)
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ingest-token')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  }
}

/**
 * Lit le credential — DANS L'EN-TÊTE, ET NULLE PART AILLEURS.
 *
 * ⚠️ `body.token` N'EST PLUS ACCEPTÉ. L'extension l'envoyait dans les deux, et
 * le serveur acceptait les deux. Un credential dans un corps JSON se retrouve
 * dans les journaux d'accès, les traces d'erreur et les outils de dévelopement
 * bien plus facilement que dans un en-tête nommé — et deux chemins d'entrée pour
 * un même secret, c'est un de trop à surveiller.
 */
export function readCredential(req: any): string {
  const h = req?.headers?.['x-ingest-token']
  return typeof h === 'string' ? h.trim() : ''
}

// ── Attente de confirmation ─────────────────────────────────────────────────

const NS = '_channels'
const KIND_PENDING = 'extpending'

/**
 * CINQ MINUTES. Plus court que les dix minutes du canal Telegram, et pour une
 * raison : la confirmation s'affiche dans un panneau que l'utilisateur regarde
 * à l'instant même, sur la page où il travaille. Il n'y a ni notification à
 * consulter plus tard, ni trajet entre deux applications. Une fenêtre plus
 * longue n'ajouterait que du temps pendant lequel un onglet oublié reste
 * actionnable.
 */
export const EXT_PENDING_TTL_MS = 5 * 60 * 1000

export interface ExtensionPending {
  id: string
  ws: string
  scope: string
  action: any
  url?: string
  at: number
  expiresAt: number
}

/** Identifiant de confirmation : 128 bits d'aléa, jamais dérivé de l'espace. */
export function extConfirmationId(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Enregistre l'action côté SERVEUR et rend son identifiant de confirmation.
 *
 * ⚠️ C'EST ICI QUE SE FERME LA FAILLE CENTRALE. `/api/jarvis/agent` acceptait
 * `confirm: true` accompagné de `action` — l'action venait donc du NAVIGATEUR.
 * Une page hostile, une extension compromise ou un simple `curl` muni du jeton
 * pouvaient soumettre l'action de leur choix, sans qu'aucun plan de Jarvis ne
 * l'ait jamais proposée. L'action ne quitte plus le serveur.
 */
export async function createExtensionPending(
  ws: string, scope: string, action: any, url?: string,
): Promise<string | null> {
  const owner = (ws || '').trim()
  if (!owner || !action) return null
  const now = Date.now()
  const id = extConfirmationId()
  const row: ExtensionPending = {
    id, ws: owner, scope, action, url, at: now, expiresAt: now + EXT_PENDING_TTL_MS,
  }
  if (!(await insertItemIfAbsent(KIND_PENDING, id, row, NS))) return null
  await deleteExpired(KIND_PENDING, NS, new Date(now - 2 * EXT_PENDING_TTL_MS).toISOString())
  return id
}

/**
 * Consomme une confirmation. Rend l'action UNE SEULE FOIS, ou `null`.
 *
 * Le prédicat sur `ws` fait partie de la MÊME instruction que la suppression :
 * un identifiant intercepté et rejoué avec le jeton d'un AUTRE espace ne
 * supprime rien et ne rend rien, et la confirmation de l'espace légitime reste
 * intacte.
 *
 * ⚠️ CE QUE CETTE LIAISON NE FAIT PAS. Elle lie l'attente à l'ESPACE, pas au
 * navigateur : deux onglets du même espace partagent le même jeton, et rien
 * dans le protocole ne les distingue. À l'intérieur d'un espace, la
 * confirmation reste donc « au plus une fois », mais pas « par le même onglet ».
 * Une identité de client par navigateur serait le seul moyen d'aller plus loin,
 * et elle n'existe pas aujourd'hui.
 */
export async function consumeExtensionPending(
  id: string, ws: string,
): Promise<ExtensionPending | null> {
  const cid = (id || '').trim()
  const owner = (ws || '').trim()
  if (!cid || !owner) return null
  // 32 hexadécimaux : une valeur trafiquée n'atteint même pas la base.
  if (!/^[0-9a-f]{32}$/.test(cid)) return null

  const row = await claimItemIfField<ExtensionPending>(KIND_PENDING, cid, NS, 'ws', owner)
  if (!row) return null
  if (!row.expiresAt || Date.now() > row.expiresAt) return null
  return row
}

/** Abandon explicite — même consommation atomique. */
export async function dropExtensionPending(id: string, ws: string): Promise<void> {
  if (/^[0-9a-f]{32}$/.test((id || '').trim())) await claimItem(KIND_PENDING, id.trim(), NS)
}
