import type { NextApiRequest, NextApiResponse } from 'next'
import { getKey, hydrateKeystore } from '../../../lib/prospector/keystore'
import { upsertLead } from '../../../lib/supabase/leads'
import { lookupByName } from '../../../lib/prospector/datagouv'
import { identifyLead } from '../../../lib/prospector/identify'
import { resolveWorkspaceByToken } from '../../../lib/prospector/wstoken'
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
  // Multi-tenant : le jeton détermine l'espace de destination (admin ou client).
  const ws = await resolveWorkspaceByToken(token)
  if (!ws) return res.status(401).json({ error: 'Jeton invalide (ni admin, ni client connu).' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const name = String(body?.name || '').trim()
  const url = String(body?.url || '')
  const isProfile = /linkedin\.com\/in\//i.test(url)

  // Classification personne (contact) vs entreprise (compte) : URL → agent web
  // (Exa→Claude si clés) → heuristique + data.gouv. Aucune donnée devinée.
  const id = await identifyLead({ name, title: String(body?.title || ''), company: String(body?.company || ''), url })
  const isPerson = id.kind === 'person'

  const lead: Lead = {
    id: `ld_${Math.random().toString(36).slice(2, 10)}`,
    kind: isPerson ? 'contact' : 'account',
    firstName: isPerson ? (id.firstName || name.split(' ')[0] || '') : '',
    lastName: isPerson ? (id.lastName || name.split(' ').slice(1).join(' ')) : '',
    title: isPerson ? (id.title || String(body?.title || '').trim() || 'À qualifier') : '',
    company: (id.company || String(body?.company || '').trim() || (isPerson ? '—' : name) || '—'),
    score: 0, temperature: 'warm', status: 'froid', stage: 'to_invite',
    email: body?.email || null, phone: null,
    website: id.website || undefined,
    // On ne renseigne linkedinUrl que si l'URL est vraiment un profil LinkedIn.
    linkedinUrl: isProfile ? url.trim() : undefined,
  }

  // Vérification entreprise via data.gouv (gratuit, officiel) AVANT enregistrement.
  const companyName = lead.company && lead.company !== '—' ? lead.company : ''
  if (companyName) {
    try {
      const v = await lookupByName(companyName)
      if (v.found) {
        lead.company = v.name || lead.company
        lead.siren = v.siren
        lead.active = v.active
        lead.naf = v.naf
        lead.city = v.city
        lead.dirigeant = v.dirigeant
        lead.effectif = v.effectif
        if (!lead.website && v.website) lead.website = v.website
        // On NE fabrique PAS de personne : le dirigeant reste une métadonnée du compte.
      }
    } catch { /* vérif best-effort */ }
  }

  const ok = await upsertLead(lead, ws)
  res.status(ok ? 200 : 502).json({ ok, id: lead.id })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
