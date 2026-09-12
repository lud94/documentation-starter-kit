// Actions en attente de confirmation sur un canal externe — lot SEC-TG.
//
// ── LE MODÈLE PRÉCÉDENT, ET POURQUOI IL NE TENAIT PAS ───────────────────────
// Le bouton Telegram portait `callback_data: 'ok'` ou `'no'`, et l'action était
// retrouvée par l'identifiant du chat :
//
//     listItems(tgpending)  →  find(chatKey)  →  deleteItem  →  execute
//
// Quatre défauts dans cinq lignes :
//   1. « ok » ne désigne RIEN. Un bouton d'un message d'il y a une heure
//      confirme l'action en attente du moment, quelle qu'elle soit ;
//   2. `listItems → find → delete → execute` est un check-then-act : deux
//      rappels simultanés lisent la même ligne, la suppriment tous deux (la
//      suppression est idempotente) et EXÉCUTENT tous deux ;
//   3. rien ne lie l'action à l'espace qui l'a créée : un chat ré-appairé vers
//      un autre client exécutait l'action de l'ancien dans le nouveau ;
//   4. aucune expiration.
//
// ── LE MODÈLE RETENU ────────────────────────────────────────────────────────
// Le bouton ne transporte plus qu'un IDENTIFIANT DE CONFIRMATION opaque. Ni
// l'action, ni l'espace, ni le moindre paramètre exécutable ne transitent par
// Telegram — le serveur retrouve tout depuis son propre stockage.
//
//   tgpending        id = nonce     → { chatKey, ws, action, at, expiresAt }
//   tgpendingactive  id = chatKey   → { cid }   ← UNE seule attente par chat
//
// La consommation est un compare-and-delete : `claimItemIfField` supprime la
// ligne SEULEMENT si elle appartient encore au chat qui présente le bouton, et
// rend l'action à UN SEUL appelant. Il n'y a aucune lecture préalable, donc
// aucune fenêtre.
import { claimItem, claimItemIfField, insertItemIfAbsent, deleteExpired } from '../supabase/store'

const NS = '_channels'
const KIND_PENDING = 'tgpending'        // action en attente, clé = identifiant de confirmation
const KIND_HOLDER = 'tgpendingactive'   // UNE attente par chat, clé = le chat

/**
 * Durée de vie d'une confirmation. DIX MINUTES, et le choix se justifie.
 *
 * Une confirmation répond à un message que l'utilisateur vient de recevoir :
 * elle n'a pas besoin de la longévité d'un code d'appairage (15 min), qu'on va
 * chercher dans une autre application. Mais elle doit survivre à une
 * interruption ordinaire — une notification, un trajet, une réunion courte.
 *
 * Plus court frustrerait sur mobile ; plus long allongerait sans contrepartie
 * la fenêtre pendant laquelle un bouton oublié reste actionnable, y compris par
 * quelqu'un qui aurait accès au téléphone. Dix minutes est le point où ces deux
 * courbes se croisent pour un usage nomade.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000

export interface PendingAction {
  id: string          // identifiant de confirmation (nonce)
  chatKey: string     // canal qui a demandé l'action
  ws: string          // espace au moment de la CRÉATION
  action: any         // charge utile serveur, jamais transmise au canal
  url?: string
  at: number
  expiresAt: number
}

/**
 * Identifiant de confirmation — 128 bits d'aléa cryptographique, en hexadécimal.
 *
 * Ni dérivé du chat, ni de l'espace, ni de l'action : un identifiant dérivé
 * serait devinable par qui connaît ses composantes. `callback_data` est limité
 * à 64 octets côté Telegram ; « confirm: » + 32 caractères tient largement.
 */
export function confirmationId(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Enregistre une action en attente et rend son identifiant de confirmation.
 *
 * Toute attente PRÉCÉDENTE du même chat est invalidée : un bouton d'un message
 * antérieur ne doit rien pouvoir confirmer, ni son action d'origine, ni — pire
 * encore — celle qui l'a remplacée. Le titulaire (`tgpendingactive`), dont
 * l'identifiant EST le chat, l'impose par la clé primaire.
 *
 * Rend `null` si l'attente n'a pas pu être posée. L'appelant doit alors refuser
 * de proposer la confirmation : mieux vaut ne pas afficher de bouton qu'en
 * afficher un qui ne mènera nulle part.
 */
export async function createPendingAction(
  chatKey: string, ws: string, action: any, url?: string,
): Promise<string | null> {
  const chat = (chatKey || '').trim()
  const owner = (ws || '').trim()
  if (!chat || !owner || !action) return null

  const now = Date.now()
  const cid = confirmationId()
  const row: PendingAction = {
    id: cid, chatKey: chat, ws: owner, action, url, at: now, expiresAt: now + PENDING_TTL_MS,
  }
  if (!(await insertItemIfAbsent(KIND_PENDING, cid, row, NS))) return null

  // Le titulaire est repris ATOMIQUEMENT : celui qui l'obtient est responsable
  // d'effacer l'attente qu'il portait.
  const prev = await claimItem<{ id: string; cid: string }>(KIND_HOLDER, chat, NS)
  if (prev?.cid) await claimItem(KIND_PENDING, prev.cid, NS)

  if (!(await insertItemIfAbsent(KIND_HOLDER, chat, { id: chat, cid, at: now }, NS))) {
    // Un autre message du même chat a pris le titre entre-temps. On retire sa
    // propre ligne plutôt que de laisser une confirmation orpheline vivante.
    await claimItem(KIND_PENDING, cid, NS)
    return null
  }

  await sweepExpired()
  return cid
}

/**
 * Consomme une confirmation. Rend l'action UNE SEULE FOIS, ou `null`.
 *
 * ── POURQUOI `claimItemIfField` ET PAS `claimItem` ──────────────────────────
 * Le prédicat sur `chatKey` fait partie de la MÊME instruction que la
 * suppression. Un identifiant de confirmation intercepté ne peut donc pas être
 * rejoué depuis un autre chat : la ligne n'est pas supprimée, rien n'est rendu,
 * et le propriétaire légitime conserve sa confirmation intacte.
 *
 * Un `getItem` puis `claimItem` aurait rouvert exactement la fenêtre fermée par
 * SEC-0f.1 sur l'appairage.
 *
 * L'EXPIRATION est vérifiée après la réclamation : une confirmation périmée est
 * tout de même consommée — elle a été présentée, elle ne doit plus l'être.
 */
export async function consumePendingAction(
  cid: string, chatKey: string,
): Promise<PendingAction | null> {
  const id = (cid || '').trim()
  const chat = (chatKey || '').trim()
  if (!id || !chat) return null
  // Forme attendue : 32 hexadécimaux. Un `callback_data` trafiqué n'atteint
  // même pas la base.
  if (!/^[0-9a-f]{32}$/.test(id)) return null

  const row = await claimItemIfField<PendingAction>(KIND_PENDING, id, NS, 'chatKey', chat)
  if (!row) return null

  // Le titulaire est libéré, mais SEULEMENT s'il désigne encore cette attente :
  // un message plus récent a pu prendre le titre entre-temps, et le sien ne
  // doit pas être effacé par la consommation d'un ancien bouton.
  await claimItemIfField(KIND_HOLDER, chat, NS, 'cid', id)

  if (!row.expiresAt || Date.now() > row.expiresAt) return null
  return row
}

/** Annulation explicite — même consommation atomique que la confirmation. */
export async function cancelPendingAction(cid: string, chatKey: string): Promise<boolean> {
  return (await consumePendingAction(cid, chatKey)) !== null
}

/**
 * Purge par ÂGE des attentes abandonnées. Une confirmation jamais cliquée ne
 * s'efface autrement jamais : sans cela, chaque proposition non suivie
 * laisserait une ligne dans un namespace partagé par tous les clients.
 *
 * Deux TTL de marge, et jamais sur le chemin d'une consommation.
 */
async function sweepExpired(): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * PENDING_TTL_MS).toISOString()
  await deleteExpired(KIND_PENDING, NS, cutoff)
  await deleteExpired(KIND_HOLDER, NS, cutoff)
}
