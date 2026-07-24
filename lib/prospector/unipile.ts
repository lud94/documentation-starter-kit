// Intégration Unipile — résolution de personas sur LinkedIn (sales/marketing…).
// https://developer.unipile.com — nécessite UNIPILE_DSN + UNIPILE_API_KEY
// et un compte LinkedIn connecté (UNIPILE_ACCOUNT_ID).
// Sans config : renvoie [] pour laisser le fallback mock opérer en amont.

import type { ResolvedContact } from '../../types/prospector'
import { getKey } from './keystore'

export function unipileConfigured(): boolean {
  return !!(getKey('UNIPILE_DSN') && getKey('UNIPILE_API_KEY') && getKey('UNIPILE_ACCOUNT_ID'))
}

// Mots-clés de recherche par persona ciblé.
const PERSONA_KEYWORDS: Record<string, string> = {
  'Founder/CEO': 'CEO OR Founder OR Président',
  'Head of Sales': 'Head of Sales OR VP Sales OR Directeur Commercial',
  'Head of Marketing': 'Head of Marketing OR CMO OR VP Marketing',
}

export async function findPersonas(companyName: string, personas: string[]): Promise<ResolvedContact[]> {
  const dsn = getKey('UNIPILE_DSN')
  const key = getKey('UNIPILE_API_KEY')
  const account = getKey('UNIPILE_ACCOUNT_ID')
  if (!dsn || !key || !account || !companyName) return []

  const out: ResolvedContact[] = []
  for (const persona of personas) {
    if (persona.includes('Founder') || persona.includes('CEO')) continue // couvert par Pappers
    const keywords = PERSONA_KEYWORDS[persona] || persona
    try {
      // Unipile LinkedIn people search (Sales Navigator / classic selon le compte).
      const url = `https://${dsn}/api/v1/linkedin/search?account_id=${encodeURIComponent(account)}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'X-API-KEY': key, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ api: 'classic', category: 'people', keywords: `${keywords} ${companyName}`, limit: 1 }),
      })
      if (!res.ok) continue
      const data = await res.json().catch(() => null)
      const first = data?.items?.[0]
      if (!first) continue
      out.push({
        name: first.name || `${first.first_name || ''} ${first.last_name || ''}`.trim(),
        persona,
        title: first.headline || persona,
        linkedinUrl: first.public_profile_url || first.profile_url,
        source: 'unipile',
      })
    } catch {
      // on ignore ce persona et on continue
    }
  }
  return out
}
