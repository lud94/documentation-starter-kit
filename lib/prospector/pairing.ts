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

export async function unlinkChannel(chatKey: string): Promise<void> {
  await deleteItem(KIND_LINK, chatKey, NS)
}

// Liste des canaux appairés à un espace (pour l'Admin).
export async function listChannelsFor(ws: string): Promise<PairLink[]> {
  const links = await listItems<PairLink>(KIND_LINK, NS)
  return links.filter((x) => x.ws === ws)
}
