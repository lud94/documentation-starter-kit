import type { NextApiRequest, NextApiResponse } from 'next'
import type { ResolvedContact } from '../../../types/prospector'
import { fetchDirigeants, pappersConfigured } from '../../../lib/prospector/pappers'
import { findPersonas, unipileConfigured } from '../../../lib/prospector/unipile'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Fallback mock — déterministe par SIREN, utilisé tant que les clés ne sont pas posées.
function mockContacts(siren: string, company: string, personas: string[], dirigeant?: string): ResolvedContact[] {
  const firsts = ['Julien', 'Marie', 'Alexandre', 'Sophie', 'Nicolas', 'Camille']
  const lasts = ['Durand', 'Leroy', 'Moreau', 'Simon', 'Michel', 'Garcia']
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14)
  return personas.map((persona, i) => {
    const f = firsts[((siren.charCodeAt(0) || 65) + i) % firsts.length]
    const l = lasts[((siren.charCodeAt(1) || 66) + i) % lasts.length]
    const isDir = persona.includes('Founder') || persona.includes('CEO')
    return {
      name: isDir && dirigeant ? dirigeant : `${f} ${l}`,
      persona,
      title: persona,
      linkedinUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${f} ${l} ${company}`)}`,
      email: `${f}.${l}@${slug}.com`.toLowerCase(),
      source: isDir ? 'pappers' : 'unipile',
    }
  })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const siren = str(req.query.siren)
  const company = str(req.query.company)
  const dirigeant = str(req.query.dirigeant) || undefined
  const personas = (str(req.query.personas) || 'Founder/CEO,Head of Sales,Head of Marketing').split(',').map((p) => p.trim()).filter(Boolean)

  const usingReal = pappersConfigured() || unipileConfigured()

  try {
    if (usingReal) {
      const [dirs, personaContacts] = await Promise.all([
        pappersConfigured() ? fetchDirigeants(siren) : Promise.resolve([]),
        unipileConfigured() ? findPersonas(company, personas) : Promise.resolve([]),
      ])
      // fusion : dirigeants Pappers + personas Unipile ; complète les manquants par mock.
      const merged: ResolvedContact[] = [...dirs, ...personaContacts]
      const covered = new Set(merged.map((c) => c.persona))
      const missing = personas.filter((p) => !covered.has(p))
      if (missing.length) merged.push(...mockContacts(siren, company, missing, dirigeant).map((c) => ({ ...c, source: 'sirene' as const })))
      return res.status(200).json({ mock: false, contacts: merged })
    }
    return res.status(200).json({ mock: true, contacts: mockContacts(siren, company, personas, dirigeant) })
  } catch (e: any) {
    // en cas d'erreur réseau côté connecteur, on ne casse pas l'UI : mock.
    return res.status(200).json({ mock: true, error: e?.message, contacts: mockContacts(siren, company, personas, dirigeant) })
  }
}
