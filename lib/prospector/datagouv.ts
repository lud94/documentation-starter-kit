// Intégration API Recherche d'entreprises (data.gouv / SIRENE-INSEE)
// https://recherche-entreprises.api.gouv.fr — publique, gratuite, sans clé.
// Renvoie des ENTREPRISES (pas des contacts) : SIREN, NAF, effectif, ville, dirigeant.
// Le persona/contact et le scoring signal se font en aval (LinkedIn/Unipile + gate).

import type { SourcedLead } from '../../types/prospector'

// Code tranche d'effectif INSEE → libellé
const TRANCHE: Record<string, string> = {
  '00': '0 salarié', '01': '1-2', '02': '3-5', '03': '6-9', '11': '10-19', '12': '20-49',
  '21': '50-99', '22': '100-199', '31': '200-249', '32': '250-499', '41': '500-999',
  '42': '1000-1999', '51': '2000-4999', '52': '5000-9999', '53': '10000+',
}

// Secteur (UI) → code NAF principal (best-effort)
const SECTOR_TO_NAF: Record<string, string> = {
  'technology': '6201Z', 'saas b2b': '6201Z', 'ia / ml': '6201Z', 'martech': '6201Z',
  'cybersécurité': '6202A', 'fintech': '6419Z', 'finance': '6419Z', 'consulting': '7022Z',
  'real estate': '6831Z', 'healthcare': '8610Z', 'marketing': '7311Z', 'media': '5814Z',
  'logistics': '5229B', 'construction': '4120A', 'education': '8559A', 'manufacturing': '2599B',
  'retail': '4711D', 'hospitality': '5510Z', 'energy': '3514Z', 'legal': '6910Z',
}

// Taille (UI) → code(s) tranche effectif
const SIZE_TO_TRANCHE: Record<string, string> = {
  '1-10': '01,02,03', '11-20': '11', '21-50': '12', '51-100': '21',
  '101-250': '22,31', '251-500': '32', '501-1000': '41', '1000+': '42,51,52,53',
}

const CITY_TO_DEP: Record<string, string> = {
  'paris': '75', 'lyon': '69', 'marseille': '13', 'bordeaux': '33', 'lille': '59',
  'nantes': '44', 'toulouse': '31', 'nice': '06', 'strasbourg': '67', 'montpellier': '34', 'rennes': '35',
}

export interface SourcingQuery { sector?: string; location?: string; size?: string }

export function buildSearchUrl(q: SourcingQuery): string {
  const params = new URLSearchParams()

  const naf = SECTOR_TO_NAF[(q.sector || '').toLowerCase()]
  if (naf) params.set('activite_principale', naf)

  const loc = (q.location || '').trim()
  if (loc) {
    if (/^\d{2,3}$/.test(loc)) params.set('departement', loc)
    else if (CITY_TO_DEP[loc.toLowerCase()]) params.set('departement', CITY_TO_DEP[loc.toLowerCase()])
    else params.set('q', loc)
  }

  const tr = q.size ? SIZE_TO_TRANCHE[q.size] : undefined
  if (tr) params.set('tranche_effectif_salarie', tr)

  // L'API exige un paramètre `q` (texte) : on en met toujours un.
  if (!params.has('q')) params.set('q', q.sector || 'entreprise')

  params.set('page', '1')
  params.set('per_page', '15')

  return `https://recherche-entreprises.api.gouv.fr/search?${params.toString()}`
}

export async function debugSearch(q: SourcingQuery) {
  const url = buildSearchUrl(q)
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Prospector/1.0' } })
  const body = await res.text()
  return { url, status: res.status, body: body.slice(0, 500) }
}

export async function fetchCompanies(q: SourcingQuery): Promise<{ total: number; results: SourcedLead[] }> {
  const url = buildSearchUrl(q)
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Prospector/1.0 (+https://smartagency-ai.com)' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`DataGouv API ${res.status} — ${body.slice(0, 150)}`)
  }
  const data = await res.json()

  const results: SourcedLead[] = (data.results || []).map((r: any) => {
    const dir = (r.dirigeants || []).find((d: any) => d && d.nom)
    const eff = TRANCHE[r.tranche_effectif_salarie]
    const city = r.siege?.libelle_commune
    const signals: string[] = []
    if (eff) signals.push(`${eff} sal.`)
    if (city) signals.push(city)
    return {
      id: String(r.siren),
      name: dir ? `${String(dir.prenoms || '').split(' ')[0]} ${dir.nom}`.trim() : '—',
      title: dir?.qualite || 'Dirigeant',
      company: r.nom_complet || r.nom_raison_sociale || 'Entreprise',
      sector: q.sector || r.activite_principale || '',
      score: 0, // non scoré : le gate signal interviendra ensuite
      signals,
    }
  })

  return { total: data.total_results ?? results.length, results }
}
