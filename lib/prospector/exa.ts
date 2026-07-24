// Exa — capteur de signaux. Recherche neuronale + contenu de page.
// https://exa.ai — nécessite EXA_API_KEY. Sans clé : renvoie [] (fallback amont).
// Rôle : trouver les pages d'annonces/actu fraîches qui portent le signal,
// et en renvoyer le CONTENU brut que Claude extraira ensuite.

import { getKey } from './keystore'

export interface ExaDoc { title: string; url: string; text: string; publishedDate?: string }

export function exaConfigured(): boolean {
  return !!getKey('EXA_API_KEY')
}

// Domaines où vivent les signaux (annonces emploi FR + presse startup/levées).
const SIGNAL_DOMAINS = [
  'welcometothejungle.com', 'linkedin.com', 'indeed.fr', 'hellowork.com',
  'maddyness.com', 'frenchweb.fr', 'lesechos.fr', 'usine-digitale.fr', 'eu-startups.com',
]

export async function searchExa(thesis: string, numResults = 12): Promise<ExaDoc[]> {
  const key = getKey('EXA_API_KEY')
  if (!key || !thesis) return []

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': key, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      query: thesis,
      type: 'auto',
      numResults,
      includeDomains: SIGNAL_DOMAINS,
      startPublishedDate: recentIso(90), // 90 derniers jours → fraîcheur
      contents: { text: { maxCharacters: 1200 } },
    }),
  })
  if (!res.ok) throw new Error(`Exa ${res.status} — ${(await res.text()).slice(0, 150)}`)
  const data = await res.json()
  return (data.results || []).map((r: any): ExaDoc => ({
    title: r.title || '',
    url: r.url || '',
    text: r.text || '',
    publishedDate: r.publishedDate,
  }))
}

// Date ISO à J-`days` (l'app tourne côté serveur Next : Date est disponible).
function recentIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
}
