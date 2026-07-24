import type { NextApiRequest, NextApiResponse } from 'next'
import { setKeys, MANAGED_KEYS, hydrateKeystore } from '../../../lib/prospector/keystore'

// Enregistre des clés API saisies depuis l'Admin (POST). Écrit en mémoire +
// Supabase (write-through). N'expose jamais les valeurs en GET.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Corps invalide' })

  const patch: Record<string, string> = {}
  for (const k of MANAGED_KEYS) {
    if (typeof body[k] === 'string') patch[k] = body[k]
  }
  setKeys(patch)
  res.status(200).json({ ok: true, saved: Object.keys(patch) })
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
