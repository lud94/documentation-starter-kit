import type { NextApiRequest, NextApiResponse } from 'next'
import type { ResolvedContact } from '../../../types/prospector'
import { fetchDirigeants, pappersConfigured } from '../../../lib/prospector/pappers'
import { findPersonas, unipileConfigured } from '../../../lib/prospector/unipile'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { getCachedDirigeants, setCachedDirigeants, bumpUsage } from '../../../lib/supabase/pappersCache'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Contact RÉEL issu du dirigeant data.gouv (aucune invention).
// Pas d'email ni d'URL LinkedIn fabriqués : on ne remplit que ce qu'on sait.
function dirigeantContact(dirigeant?: string): ResolvedContact[] {
  const name = (dirigeant || '').trim()
  if (!name) return []
  return [{ name, persona: 'Founder/CEO', title: 'Dirigeant', source: 'sirene' }]
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const siren = str(req.query.siren)
  const company = str(req.query.company)
  const dirigeant = str(req.query.dirigeant) || undefined
  const personas = (str(req.query.personas) || 'Founder/CEO,Head of Sales,Head of Marketing').split(',').map((p) => p.trim()).filter(Boolean)

  const usingReal = pappersConfigured() || unipileConfigured()

  try {
    // Aucun connecteur de personas configuré → on NE devine RIEN.
    // Seul le dirigeant réel (data.gouv/SIRENE) peut remonter. Sinon : 0 contact.
    if (!usingReal) {
      const contacts = dirigeantContact(dirigeant)
      return res.status(200).json({ mock: false, connected: false, contacts })
    }

    // Pappers : cache par SIREN → on ne repaie pas un dirigeant déjà résolu.
    const pappers = async (): Promise<ResolvedContact[]> => {
      if (!pappersConfigured() || !siren) return []
      const cached = await getCachedDirigeants(siren)
      if (cached) return cached // hit → 0 appel facturé
      const fresh = await fetchDirigeants(siren)
      await bumpUsage('pappers_calls') // 1 appel réel facturé
      if (fresh.length) await setCachedDirigeants(siren, fresh)
      return fresh
    }
    const [dirs, personaContacts] = await Promise.all([
      pappers(),
      unipileConfigured() ? findPersonas(company, personas) : Promise.resolve([]),
    ])
    // Fusion : dirigeants Pappers + personas Unipile. On complète le dirigeant
    // par data.gouv s'il manque, mais JAMAIS de personas inventés.
    const merged: ResolvedContact[] = [...dirs, ...personaContacts]
    const hasFounder = merged.some((c) => /founder|ceo|dirigeant/i.test(c.persona))
    if (!hasFounder) merged.push(...dirigeantContact(dirigeant))
    return res.status(200).json({ mock: false, connected: true, contacts: merged })
  } catch (e: any) {
    // Erreur réseau connecteur → on ne casse pas l'UI, mais on n'invente pas :
    // au pire, le dirigeant réel, sinon rien.
    return res.status(200).json({ mock: false, connected: false, error: e?.message, contacts: dirigeantContact(dirigeant) })
  }
}
