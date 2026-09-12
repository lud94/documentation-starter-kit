// Actions Jarvis in-app en attente de confirmation — SEC-JARVIS-APP-01.
//
// Le navigateur n'est PAS une autorité d'exécution.
// Une action proposée par Jarvis reste côté serveur.
// Le client ne reçoit qu'un identifiant opaque de confirmation.
//
// Flux :
//   planJarvis()
//      ↓
//   createAppPending(ws, action)
//      ↓
//   navigateur reçoit seulement confirmationId
//      ↓
//   consumeAppPending(confirmationId, ws)
//      ↓
//   executeJarvis(action serveur)
//
// Une action ne peut être consommée qu'une fois et uniquement depuis
// l'espace qui l'a créée.

import {
  claimItemIfField,
  insertItemIfAbsent,
  deleteExpired,
} from '../supabase/store'

const NS = '_channels'
const KIND_PENDING = 'apppending'

/**
 * Durée de vie d'une confirmation in-app.
 *
 * Cinq minutes suffisent : l'utilisateur regarde déjà le panneau Jarvis
 * lorsqu'il reçoit la demande de confirmation.
 */
export const APP_PENDING_TTL_MS = 5 * 60 * 1000

export interface AppPendingAction {
  id: string
  ws: string
  action: any
  at: number
  expiresAt: number
}

/**
 * Nonce de confirmation : 128 bits aléatoires.
 * Il ne contient ni action, ni workspace, ni donnée métier.
 */
export function appConfirmationId(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)

  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Conserve l'action côté serveur et retourne uniquement son identifiant opaque.
 */
export async function createAppPending(
  ws: string,
  action: any,
): Promise<string | null> {
  const owner = (ws || '').trim()

  if (!owner || !action) return null

  const now = Date.now()
  const id = appConfirmationId()

  const row: AppPendingAction = {
    id,
    ws: owner,
    action,
    at: now,
    expiresAt: now + APP_PENDING_TTL_MS,
  }

  if (!(await insertItemIfAbsent(KIND_PENDING, id, row, NS))) {
    return null
  }

  // Nettoyage best-effort des anciennes confirmations abandonnées.
  await deleteExpired(
    KIND_PENDING,
    NS,
    new Date(now - 2 * APP_PENDING_TTL_MS).toISOString(),
  )

  return id
}

/**
 * Consomme une confirmation UNE SEULE FOIS.
 *
 * Le prédicat workspace fait partie de la même opération atomique que
 * la suppression : connaître un nonce ne permet pas de le consommer depuis
 * un autre espace.
 */
export async function consumeAppPending(
  id: string,
  ws: string,
): Promise<AppPendingAction | null> {
  const cid = (id || '').trim()
  const owner = (ws || '').trim()

  if (!owner || !/^[0-9a-f]{32}$/.test(cid)) {
    return null
  }

  const row = await claimItemIfField<AppPendingAction>(
    KIND_PENDING,
    cid,
    NS,
    'ws',
    owner,
  )

  if (!row) return null

  // Une confirmation expirée est quand même consommée :
  // elle ne pourra jamais être rejouée.
  if (!row.expiresAt || Date.now() > row.expiresAt) {
    return null
  }

  return row
}

/**
 * Annulation explicite.
 *
 * Même opération atomique et même frontière workspace que la confirmation.
 */
export async function dropAppPending(
  id: string,
  ws: string,
): Promise<boolean> {
  const cid = (id || '').trim()
  const owner = (ws || '').trim()

  if (!owner || !/^[0-9a-f]{32}$/.test(cid)) {
    return false
  }

  return (
    await claimItemIfField(
      KIND_PENDING,
      cid,
      NS,
      'ws',
      owner,
    )
  ) !== null
}