import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { planJarvis, executeJarvis, isWrite } from '../../../lib/prospector/jarvisAgent'
import { resolveExtensionToken } from '../../../lib/prospector/wstoken'
import { tenantFromVerifiedWorkspace } from '../../../lib/prospector/tenant'
import {
  decideCors, applyCors, readCredential, LIMITS, bounded, boundedOrReject,
  createExtensionPending, consumeExtensionPending, dropExtensionPending,
} from '../../../lib/prospector/extensionGate'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// Canal EXTENSION (widget flottant sur le web) — adaptateur mince.
// Utilise le MÊME cerveau Jarvis que Telegram : mêmes capacités partout.
// Protégé par le jeton d'ingestion (qui détermine aussi l'espace de destination).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const cors = decideCors(req.headers.origin as string | undefined)
  applyCors(res, cors)
  if (!cors.allowed) return res.status(403).json({ error: 'origin_not_allowed' })
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  // Credential dans l'en-tête uniquement, et portée `jarvis` exigée : un jeton
  // de capture volé ne pilote pas l'agent.
  const token = readCredential(req)
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  const ws = await resolveExtensionToken(token, 'jarvis')
  if (!ws) return res.status(401).json({ error: 'unauthorized' })
  // MT-0 / SEC-0c — l'espace doit ENCORE être utilisable au moment de l'appel.
  const tenant = await tenantFromVerifiedWorkspace(ws)
  if (!tenant) return res.status(403).json({ error: 'forbidden' })

  // La directive est REFUSÉE si elle dépasse : tronquée en son milieu, elle
  // deviendrait une instruction que l'utilisateur n'a pas écrite.
  const message = boundedOrReject(body?.message, LIMITS.message)
  if (message === null) return res.status(413).json({ error: 'payload_too_large' })
  // ⚠️ DONNÉES DE PAGE = NON FIABLES. `url` et `title` viennent du navigateur :
  // ce sont des données métier contextuelles, jamais un élément d'autorité. Ni
  // l'espace, ni la portée, ni l'action n'en dérivent — et `body.workspace_id`,
  // `body.tenant` ou `body.action` ne sont tout simplement pas lus.
  const url = bounded(body?.url, LIMITS.url)
  const title = bounded(body?.title, LIMITS.title)
  // Jamais tronqué : sa forme exacte est vérifiée par la consommation.
  const confirmationId = String(body?.confirmationId || '')

  try {
    // ── 2e appel : CONFIRMATION ────────────────────────────────────────────
    //
    // ⚠️ FAILLE CENTRALE FERMÉE (lot SEC-EXT-0). La route acceptait
    // `confirm: true` accompagné de `action`, et exécutait cette action telle
    // quelle : elle venait donc du NAVIGATEUR. Une page hostile, une extension
    // compromise, ou un simple `curl` muni du jeton pouvaient soumettre
    // l'action de leur choix — sans qu'aucun plan de Jarvis ne l'ait proposée.
    //
    // Le corps ne porte plus qu'un identifiant opaque. L'action est relue dans
    // le stockage serveur, et la réclamation est atomique : au plus une
    // exécution, jamais deux.
    if (confirmationId) {
      const pending = await consumeExtensionPending(confirmationId, ws)
      if (!pending) return res.status(200).json({ reply: 'Cette demande a expiré ou a déjà été traitée.', done: false })
      return res.status(200).json({
        reply: await executeJarvis(tenant, pending.action, tenant.id, pending.url || url), done: true,
      })
    }

    if (String(body?.cancel || '')) { await dropExtensionPending(String(body.cancel), ws); return res.status(200).json({ reply: 'Annulé.', done: true }) }

    const plan = await planJarvis(tenant, message, { url, title, channel: 'extension' })
    // Écriture → confirmation. L'action reste CÔTÉ SERVEUR ; le client ne
    // reçoit qu'un identifiant, et ne peut rien renvoyer d'autre.
    if (plan.action && isWrite(plan.action)) {
      const cid = await createExtensionPending(ws, 'jarvis', plan.action, url)
      if (!cid) return res.status(200).json({ reply: GENERIC_ERROR, action: null })
      return res.status(200).json({ reply: plan.reply, confirmationId: cid, needsConfirm: true })
    }
    if (plan.action) {
      return res.status(200).json({ reply: plan.reply, result: await executeJarvis(tenant, plan.action, tenant.id, url) })
    }
    return res.status(200).json({ reply: plan.reply || "Je n'ai pas d'action à proposer ici.", action: null })
  } catch (e: any) {
    // Le détail reste côté serveur : il révélait tables, points de terminaison
    // et traces applicatives à qui savait provoquer une erreur.
    console.error('secext.agent_error', JSON.stringify({ message: String(e?.message || e).slice(0, 300) }))
    return res.status(200).json({ reply: GENERIC_ERROR, action: null })
  }
}

const GENERIC_ERROR = "Une erreur interne a empêché l'action. Réessaie dans un instant." 
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
