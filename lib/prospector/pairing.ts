// Appairage d'un canal de messagerie (Telegram, WhatsApp…) à un ESPACE Prospector.
// Un identifiant de chat ne prouve RIEN par lui-même : l'utilisateur doit d'abord
// générer un code à usage unique dans l'app, puis l'envoyer au bot. Sans ce lien,
// le bot refuse toute demande.
import { listItems, getItem, upsertItem, deleteItem, claimItem } from '../supabase/store'
import { tenantFromVerifiedWorkspace } from './tenant'

const NS = '_channels'          // espace technique (hors données client)
const KIND_CODE = 'paircode'    // codes en attente
const KIND_LINK = 'pairlink'    // liens établis : chatKey → workspace
const KIND_FAIL = 'pairfail'    // compteur d'échecs par chat (anti-épuisement)
const TTL_MS = 15 * 60 * 1000   // code valable 15 minutes

/** Échecs tolérés par chat, puis refus uniforme jusqu'à la fin de la fenêtre. */
export const MAX_FAILURES = 5
export const FAILURE_WINDOW_MS = 15 * 60 * 1000
/** Longueur du code. Voir `pairingCode()` pour l'arbitrage. */
export const CODE_DIGITS = 8

export interface PairLink { id: string; ws: string; label?: string; at: number }

/**
 * Code d'appairage — secret à usage unique, à durée de vie courte.
 *
 * ── ENTROPIE (lots SEC-0c puis SEC-0d) ──────────────────────────────────────
 * SEC-0c a remplacé `Math.random()` : le xorshift128+ de V8 laisse reconstituer
 * son état à partir de quelques sorties, et n'importe quel client peut en
 * produire autant qu'il veut en générant des codes dans SON espace. La
 * PRÉDICTION est fermée par `crypto.getRandomValues`.
 *
 * Restait l'ÉPUISEMENT. À six chiffres, un attaquant disposant de 10 000 chats
 * et de cinq essais chacun couvre 5 × 10⁴ codes sur 10⁶ — environ 5 % de
 * chances par fenêtre, ce qui n'est pas un risque acceptable pour une prise de
 * contrôle d'espace. À huit chiffres, la même attaque tombe sous 0,05 %, et
 * chaque chiffre ajouté divise encore par dix. Le coût pour l'utilisateur est
 * de deux caractères saisis une seule fois, à l'appairage.
 *
 * Tirage uniforme par REJET : `% 90000000` sur un entier 32 bits favoriserait
 * légèrement les premiers codes. Le biais serait minuscule, mais il n'y a
 * aucune raison de l'accepter dans un secret.
 */
export function pairingCode(): string {
  const span = 9 * 10 ** (CODE_DIGITS - 1)
  const floor = 10 ** (CODE_DIGITS - 1)
  const buf = new Uint32Array(1)
  const LIMIT = Math.floor(0x1_0000_0000 / span) * span
  let v: number
  do { crypto.getRandomValues(buf); v = buf[0] } while (v >= LIMIT)
  return String(floor + (v % span))
}

export async function createPairingCode(ws: string): Promise<{ code: string; expiresInMin: number }> {
  const code = pairingCode()
  await upsertItem(KIND_CODE, code, { id: code, ws, at: Date.now() }, NS)
  return { code, expiresInMin: 15 }
}

interface FailCounter { id: string; n: number; since: number }

/** Le chat a-t-il épuisé ses essais dans la fenêtre courante ? */
async function rateLimited(chatKey: string): Promise<boolean> {
  const c = await getItem<FailCounter>(KIND_FAIL, chatKey, NS)
  if (!c) return false
  if (Date.now() - (c.since || 0) > FAILURE_WINDOW_MS) return false  // fenêtre écoulée
  return (c.n || 0) >= MAX_FAILURES
}

async function noteFailure(chatKey: string): Promise<void> {
  const c = await getItem<FailCounter>(KIND_FAIL, chatKey, NS)
  const fresh = !c || Date.now() - (c.since || 0) > FAILURE_WINDOW_MS
  await upsertItem(KIND_FAIL, chatKey,
    { id: chatKey, n: fresh ? 1 : (c!.n || 0) + 1, since: fresh ? Date.now() : c!.since }, NS)
}

/**
 * Consomme un code et crée le lien durable chatKey → espace.
 *
 * ── USAGE UNIQUE RÉEL (lot SEC-0d) ──────────────────────────────────────────
 * La version précédente faisait `listItems` → `find` → `deleteItem` : un
 * check-then-act. Deux requêtes concurrentes présentant le MÊME code lisaient
 * toutes deux la ligne avant que l'une ne la supprime, et toutes deux
 * appairaient leur chat. Sur du serverless multi-instance, ce n'est pas
 * théorique. `claimItem` remplace les trois étapes par un seul
 * `DELETE … RETURNING` : le gagnant est celui qui REÇOIT la ligne.
 *
 * ── AUCUN ORACLE ─────────────────────────────────────────────────────────────
 * Tous les refus — format invalide, code inconnu, code expiré, quota épuisé,
 * espace suspendu ou supprimé — rendent `null`. L'appelant émet un message
 * unique. Rien ne distingue « ce code n'existe pas » de « ce code existe mais
 * appartient à un espace suspendu ».
 *
 * Un code EXPIRÉ est tout de même consommé : il a été présenté, il ne doit pas
 * pouvoir l'être à nouveau.
 */
export async function redeemPairingCode(code: string, chatKey: string, label?: string): Promise<string | null> {
  const c = (code || '').trim()
  const key = (chatKey || '').trim()
  if (!key) return null

  // Le quota est vérifié AVANT toute lecture de code : un chat saturé n'apprend
  // plus rien du tout, pas même par le temps de réponse.
  if (await rateLimited(key)) return null

  if (!new RegExp(`^\\d{${CODE_DIGITS}}$`).test(c)) { await noteFailure(key); return null }

  // Réclamation atomique : au plus UNE requête obtient ce code.
  const hit = await claimItem<{ id: string; ws: string; at: number }>(KIND_CODE, c, NS)
  if (!hit) { await noteFailure(key); return null }
  if (Date.now() - (hit.at || 0) > TTL_MS) { await noteFailure(key); return null }

  // L'espace doit être ENCORE utilisable — même exigence que les trois racines
  // de confiance depuis SEC-0c. Appairer un chat à un espace suspendu ou
  // supprimé fabriquerait une racine de confiance périmée dès sa naissance.
  const tenant = await tenantFromVerifiedWorkspace(hit.ws)
  if (!tenant) return null

  await upsertItem(KIND_LINK, key, { id: key, ws: tenant.id, label, at: Date.now() }, NS)
  return tenant.id
}

export async function resolveChannelWs(chatKey: string): Promise<string | null> {
  const links = await listItems<PairLink>(KIND_LINK, NS)
  return links.find((x) => x.id === chatKey)?.ws || null
}

/**
 * Délie un canal — UNIQUEMENT si l'espace appelant en est propriétaire.
 *
 * ⚠️ DÉFAUT CORRIGÉ (lot SEC-0b). La signature précédente ne prenait que
 * `chatKey` et supprimait sans rien vérifier. Les liens vivent dans un espace
 * TECHNIQUE PARTAGÉ (`_channels`) : le cloisonnement par `workspace_id` du
 * magasin ne s'applique donc pas ici, et c'est le champ `ws` de la ligne qui
 * porte seul la propriété. Un client authentifié qui devinait un `chatKey` —
 * un identifiant de conversation Telegram est numérique, donc énumérable —
 * pouvait délier le canal mobile d'un AUTRE espace. Destructif et silencieux.
 *
 * Rend `false` quand le lien n'existe pas ET quand il appartient à autrui : les
 * deux cas sont volontairement indiscernables, sinon la réponse dirait à
 * l'appelant qu'un canal existe ailleurs.
 */
export async function unlinkChannel(chatKey: string, ws: string): Promise<boolean> {
  const owner = (ws || '').trim()
  if (!owner || !chatKey) return false
  const links = await listItems<PairLink>(KIND_LINK, NS)
  const link = links.find((x) => x.id === chatKey)
  if (!link || link.ws !== owner) return false
  await deleteItem(KIND_LINK, chatKey, NS)
  return true
}

// Liste des canaux appairés à un espace (pour l'Admin).
export async function listChannelsFor(ws: string): Promise<PairLink[]> {
  const links = await listItems<PairLink>(KIND_LINK, NS)
  return links.filter((x) => x.ws === ws)
}
