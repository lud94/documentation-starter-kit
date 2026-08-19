import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { planJarvis, executeJarvis, isWrite } from '../../../lib/prospector/jarvisAgent'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import {
  createAppPending,
  consumeAppPending,
  dropAppPending,
} from '../../../lib/prospector/appPending'
import { logSafeError } from '../../../lib/observability/safeError'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

const GENERIC_ERROR = "Une erreur interne a empêché l'action. Réessaie dans un instant."

// Canal IN-APP (barre ⌘K) — adaptateur mince, MÊME cerveau que l'extension et
// Telegram. L'espace vient de la session.
//
// SEC-JARVIS-APP-01 : une action d'écriture ne transite jamais par le navigateur.
// Le client reçoit uniquement un identifiant opaque de confirmation ; l'action
// reste stockée côté serveur jusqu'à sa confirmation ou son expiration.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' })
  }

  // MT-0 — espace client obligatoire avant tout appel LLM. Fail closed.
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) {
    return res.status(403).json({
      error: 'Espace client indéterminé : appel IA refusé.',
    })
  }

  const ws = tenant.id

  await hydrateKeystore()

  if (!getKey('ANTHROPIC_API_KEY')) {
    return res.status(200).json({
      reply: 'Configure ta clé Anthropic (Admin → Connexions) pour activer Jarvis.',
      off: true,
    })
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body

  const message = String(body?.message || '')

  // Jamais d'action fournie par le navigateur.
  // La confirmation ne transporte qu'un nonce opaque.
  const confirmationId = String(body?.confirmationId || '')
  const cancelId = String(body?.cancel || '')

  try {
    // ── CONFIRMATION ───────────────────────────────────────────────────────
    if (confirmationId) {
      const pending = await consumeAppPending(confirmationId, ws)

      if (!pending) {
        return res.status(200).json({
          reply: 'Cette demande a expiré ou a déjà été traitée.',
          done: false,
        })
      }

      return res.status(200).json({
        reply: await executeJarvis(
          tenant,
          pending.action,
          ws,
        ),
        done: true,
      })
    }

    // ── ANNULATION ─────────────────────────────────────────────────────────
    if (cancelId) {
      await dropAppPending(cancelId, ws)

      return res.status(200).json({
        reply: 'Annulé.',
        done: true,
      })
    }

    // ── NOUVELLE DIRECTIVE ─────────────────────────────────────────────────
    const plan = await planJarvis(tenant, message, { channel: 'app' })

    // Écriture → action conservée côté serveur.
    if (plan.action && isWrite(plan.action)) {
      const cid = await createAppPending(ws, plan.action)

      if (!cid) {
        return res.status(200).json({
          reply: GENERIC_ERROR,
          action: null,
        })
      }

      return res.status(200).json({
        reply: plan.reply,
        confirmationId: cid,
        needsConfirm: true,
      })
    }

    // Lecture → exécution directe.
    if (plan.action) {
      return res.status(200).json({
        reply: plan.reply,
        result: await executeJarvis(tenant, plan.action, ws),
      })
    }

    return res.status(200).json({
      reply: plan.reply || '…',
    })
  } catch (e: any) {
    // Le détail reste dans les logs serveur, jamais dans l'interface utilisateur.
    // SEC-LOG-01 — `e.message` pouvait porter le corps d'erreur du fournisseur,
    // donc un fragment de prompt ou de fiche. Seuls des champs autorisés partent.
    logSafeError('secjarvisapp.chat_error', e, { provider: 'anthropic', operation: 'chat' })

    return res.status(200).json({
      reply: GENERIC_ERROR,
      action: null,
    })
  }
}

function safeParse(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}