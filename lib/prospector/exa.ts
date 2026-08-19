// Exa — capteur de signaux. Recherche neuronale + contenu de page.
// https://exa.ai — nécessite EXA_API_KEY. Sans clé : renvoie [] (fallback amont).
// Rôle : trouver les pages d'annonces/actu fraîches qui portent le signal,
// et en renvoyer le CONTENU brut que Claude extraira ensuite.
import { ProviderError } from '../observability/safeError'

import { getKey } from './keystore'

export interface ExaDoc { title: string; url: string; text: string; publishedDate?: string }

export function exaConfigured(): boolean {
  return !!getKey('EXA_API_KEY')
}

// `opts` permet de cibler les sources et la fenêtre de fraîcheur selon le type de
// signal recherché (presse pour les levées, jobboards pour les recrutements).
export async function searchExa(thesis: string, numResults = 12, opts?: { domains?: string[]; months?: number }): Promise<ExaDoc[]> {
  const key = getKey('EXA_API_KEY')
  if (!key || !thesis) return []

  const days = Math.max(30, Math.min((opts?.months || 3) * 30, 540))
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': key, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      query: thesis,
      type: 'auto',
      numResults,
      // Liste blanche uniquement si l'appelant en demande une : par défaut, recherche
      // large (le site carrière d'une ESN est une source légitime), la pertinence
      // étant assurée par les post-filtres. Sans domaines, on exclut LinkedIn.
      ...(opts?.domains?.length
        ? { includeDomains: opts.domains }
        : { excludeDomains: ['linkedin.com'] }),
      startPublishedDate: recentIso(days),
      contents: { text: { maxCharacters: 1200 } },
    }),
  })
  // SEC-LOG-01 — le corps de réponse ne franchit pas l'erreur.
  if (!res.ok) throw new ProviderError({ code: 'provider_http', provider: 'exa', operation: 'search', status: res.status })
  const data = await res.json()
  return (data.results || []).map((r: any): ExaDoc => ({
    title: r.title || '',
    url: r.url || '',
    text: r.text || '',
    publishedDate: r.publishedDate,
  }))
}

// Recherche web GÉNÉRIQUE (pas restreinte aux domaines signaux) — sert à
// identifier une entité (personne vs entreprise) et à retrouver un site officiel.
export async function searchExaWeb(query: string, numResults = 6): Promise<ExaDoc[]> {
  const key = getKey('EXA_API_KEY')
  if (!key || !query) return []
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': key, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ query, type: 'auto', numResults, contents: { text: { maxCharacters: 1000 } } }),
  })
  // SEC-LOG-01 — le corps de réponse ne franchit pas l'erreur.
  if (!res.ok) throw new ProviderError({ code: 'provider_http', provider: 'exa', operation: 'search', status: res.status })
  const data = await res.json()
  return (data.results || []).map((r: any): ExaDoc => ({ title: r.title || '', url: r.url || '', text: r.text || '', publishedDate: r.publishedDate }))
}

// Date ISO à J-`days` (l'app tourne côté serveur Next : Date est disponible).
function recentIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
}
