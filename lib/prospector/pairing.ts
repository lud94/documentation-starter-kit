// Appairage d'un canal de messagerie (Telegram, WhatsApp…) à un ESPACE Prospector.
// Un identifiant de chat ne prouve RIEN par lui-même : l'utilisateur doit d'abord
// générer un code à usage unique dans l'app, puis l'envoyer au bot. Sans ce lien,
// le bot refuse toute demande.
import { listItems, upsertItem, deleteItem } from '../supabase/store'

const NS = '_channels'          // espace technique (hors données client)
const KIND_CODE = 'paircode'    // codes en attente
const KIND_LINK = 'pairlink'    // liens établis : chatKey → workspace
const TTL_MS = 15 * 60 * 1000   // code valable 15 minutes

export interface PairLink { id: string; ws: string; label?: string; at: number }

// Code à 6 chiffres, lisible et court (usage unique + expiration).
export async function createPairingCode(ws: string): Promise<{ code: string; expiresInMin: number }> {
  const code = String(Math.floor(100000 + Math.random() * 900000))
  await upsertItem(KIND_CODE, code, { id: code, ws, at: Date.now() }, NS)
  return { code, expiresInMin: 15 }
}

// Consomme un code et crée le lien durable chatKey → workspace.
export async function redeemPairingCode(code: string, chatKey: string, label?: string): Promise<string | null> {
  const c = (code || '').trim()
  if (!/^\d{6}$/.test(c)) return null
  const codes = await listItems<{ id: string; ws: string; at: number }>(KIND_CODE, NS)
  const hit = codes.find((x) => x.id === c)
  if (!hit) return null
  await deleteItem(KIND_CODE, c, NS)                     // usage unique
  if (Date.now() - (hit.at || 0) > TTL_MS) return null   // expiré
  await upsertItem(KIND_LINK, chatKey, { id: chatKey, ws: hit.ws, label, at: Date.now() }, NS)
  return hit.ws
}

// Résout l'espace d'un chat déjà appairé.
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
