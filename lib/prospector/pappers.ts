// Intégration Pappers — dirigeants d'une entreprise par SIREN.
// https://api.pappers.fr — nécessite PAPPERS_API_KEY (free tier dispo).
// Sans clé : renvoie [] pour laisser le fallback mock opérer en amont.

import type { ResolvedContact } from '../../types/prospector'

export function pappersConfigured(): boolean {
  return !!process.env.PAPPERS_API_KEY
}

export async function fetchDirigeants(siren: string): Promise<ResolvedContact[]> {
  const key = process.env.PAPPERS_API_KEY
  if (!key || !siren) return []

  const url = `https://api.pappers.fr/v2/entreprise?api_token=${encodeURIComponent(key)}&siren=${encodeURIComponent(siren)}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) return []
  const data = await res.json().catch(() => null)
  if (!data) return []

  const reps: any[] = data.representants || data.dirigeants || []
  return reps
    .filter((r) => r && (r.nom || r.nom_complet))
    .slice(0, 5)
    .map((r): ResolvedContact => {
      const prenom = (r.prenom || r.prenom_usuel || '').trim()
      const nom = (r.nom || '').trim()
      const name = r.nom_complet || `${prenom} ${nom}`.trim()
      return {
        name,
        persona: 'Founder/CEO',
        title: r.qualite || 'Dirigeant',
        source: 'pappers',
      }
    })
}
