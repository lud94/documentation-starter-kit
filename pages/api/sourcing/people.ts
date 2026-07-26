import type { NextApiRequest, NextApiResponse } from 'next'
import { unipileConfigured } from '../../../lib/prospector/unipile'
import { hydrateKeystore } from '../../../lib/prospector/keystore'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Recherche de PERSONNES sur LinkedIn (façon Sales Navigator) via Unipile.
// Mock tant qu'Unipile n'est pas connecté. Filtres : poste, secteur, localisation.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const role = str(req.query.role)
  const location = str(req.query.location)
  const sector = str(req.query.sector)

  if (unipileConfigured()) {
    // TODO câblage réel : Unipile /linkedin/search (people) avec keywords = role + sector + location.
    // Format à valider au 1er appel réel → on retombe sur mock si erreur.
  }

  // Mock déterministe (prêt à remplacer par Unipile)
  const firsts = ['Julien', 'Marie', 'Alexandre', 'Sophie', 'Nicolas', 'Camille', 'Thomas', 'Léa']
  const lasts = ['Durand', 'Leroy', 'Moreau', 'Simon', 'Michel', 'Garcia', 'Bernard', 'Petit']
  const companies = ['Cardo', 'Flowly', 'Beacon', 'Vecto', 'Nomia', 'Swan', 'Lago', 'Dust']
  const people = Array.from({ length: 8 }, (_, i) => {
    const name = `${firsts[i % firsts.length]} ${lasts[(i * 3) % lasts.length]}`
    return {
      id: `pp_${i}`,
      name,
      title: role || 'Head of Sales',
      company: companies[i % companies.length],
      location: location || 'Paris',
      sector: sector || 'SaaS B2B',
      linkedinUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}`,
    }
  })
  res.status(200).json({ mock: !unipileConfigured(), people })
}
