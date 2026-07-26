import type { NextApiRequest, NextApiResponse } from 'next'
import { getKey, hydrateKeystore } from '../../../lib/prospector/keystore'
import { upsertLead } from '../../../lib/supabase/leads'
import type { Lead } from '../../../types/prospector'

// Point d'entrée pour l'extension navigateur (Jarvis web).
// Protégé par un jeton (INGEST_TOKEN) — pas par la session, car appelé depuis
// une autre origine. Crée un lead à partir d'une URL LinkedIn + infos de base.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS : autorise l'extension à appeler.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ingest-token')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  await hydrateKeystore()
  const ref = getKey('INGEST_TOKEN')
  const token = String(req.headers['x-ingest-token'] || (typeof req.body === 'object' ? req.body?.token : '') || '')
  if (!ref) return res.status(401).json({ error: 'Aucun jeton configuré côté Prospector (Admin → Connexions → INGEST_TOKEN, puis Enregistrer).' })
  if (!token) return res.status(401).json({ error: 'Jeton absent dans l\'extension (champ Réglages vide).' })
  if (token.trim() !== ref.trim()) return res.status(401).json({ error: 'Jeton différent de celui enregistré dans Prospector.' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const name = String(body?.name || '').trim()
  const [firstName, ...rest] = name.split(' ')
  const lead: Lead = {
    id: `ld_${Math.random().toString(36).slice(2, 10)}`,
    firstName: firstName || 'Prénom', lastName: rest.join(' '),
    title: String(body?.title || '').trim() || 'À qualifier',
    company: String(body?.company || '').trim() || '—',
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite',
    email: body?.email || null, phone: null,
    // On ne renseigne linkedinUrl que si l'URL est vraiment un profil LinkedIn.
    linkedinUrl: /linkedin\.com\/in\//i.test(String(body?.url || '')) ? String(body.url).trim() : undefined,
  }
  const ok = await upsertLead(lead, 'admin')
  res.status(ok ? 200 : 502).json({ ok, id: lead.id })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
