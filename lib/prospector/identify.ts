// Identification d'une entité importée (extension / Google / saisie) :
// est-ce une PERSONNE (contact) ou une ENTREPRISE (compte) ? Et enrichit le
// site web + la société sans consommer de jeton Pappers.
//
// Priorité :
//   1) signaux d'URL (gratuit, déterministe) — linkedin.com/in vs /company ;
//   2) présence simultanée d'un nom de personne ET d'une société (article) ;
//   3) agent web Exa → Claude (si clés posées) — sert AUSSI à trouver le site web ;
//   4) heuristique + réconciliation data.gouv (sans clé, sans invention).

import { getKey } from './keystore'
import { reconcileByName } from './datagouv'

export interface IdentifyInput { name?: string; title?: string; company?: string; url?: string }
export interface IdentifyResult {
  kind: 'person' | 'company'
  firstName?: string
  lastName?: string
  title?: string
  company?: string
  website?: string
  confidence: 'high' | 'medium' | 'low'
  mode: 'exa+claude' | 'claude-web' | 'heuristic' | 'url'
}


const COMPANY_HINTS = /\b(sas|sasu|sarl|sa|eurl|sci|selarl|scop|group|groupe|conseil|consulting|technolog\w*|solutions?|labs?|studio|agence|partners|associ[ée]s|holding|company|inc|ltd|llc|gmbh|corp)\b/i

// « Prénom Nom » : 2-3 tokens alphabétiques, sans indice d'entreprise.
function looksLikePerson(name: string): boolean {
  const n = (name || '').trim()
  const toks = n.split(/\s+/).filter(Boolean)
  if (toks.length < 2 || toks.length > 3) return false
  if (COMPANY_HINTS.test(n)) return false
  return toks.every((t) => /^[a-zà-ÿ][a-zà-ÿ'’-]*$/i.test(t))
}

function splitName(name: string): { firstName: string; lastName: string } {
  const [firstName, ...rest] = (name || '').trim().split(/\s+/)
  return { firstName: firstName || '', lastName: rest.join(' ') }
}

function cleanWebsite(raw?: string): string | undefined {
  const s = String(raw || '').trim()
  if (!s || !/\./.test(s)) return undefined
  return s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
}

// ── Heuristique (sans clé) : URL + forme du nom + réconciliation data.gouv. ─────
async function heuristicIdentify(input: IdentifyInput): Promise<IdentifyResult> {
  const name = (input.name || '').trim()
  const person = looksLikePerson(name)
  // Un nom de personne + une société explicite = contact (cas de l'article).
  if (person) {
    const { firstName, lastName } = splitName(name)
    return { kind: 'person', firstName, lastName, title: input.title || undefined, company: input.company || undefined, confidence: input.company ? 'medium' : 'low', mode: 'heuristic' }
  }
  // Sinon : entreprise. On confirme (best-effort) via data.gouv.
  const companyName = input.company || name
  let confidence: IdentifyResult['confidence'] = 'medium'
  try { const r = await reconcileByName(companyName); if (r) confidence = 'high' } catch { /* best-effort */ }
  return { kind: 'company', company: companyName, confidence, mode: 'heuristic' }
}

export async function identifyLead(input: IdentifyInput): Promise<IdentifyResult> {
  const url = (input.url || '').toLowerCase()
  const name = (input.name || '').trim()

  // 1) Signaux d'URL — les plus fiables, gratuits.
  if (/linkedin\.com\/in\//.test(url)) {
    const { firstName, lastName } = splitName(name)
    return { kind: 'person', firstName, lastName, title: input.title || undefined, company: input.company || undefined, confidence: 'high', mode: 'url' }
  }
  if (/linkedin\.com\/company\//.test(url)) {
    return { kind: 'company', company: input.company || name, confidence: 'high', mode: 'url' }
  }

  // 2) Cas non tranché par l'URL → heuristique GRATUITE (URL + forme du nom +
  //    data.gouv). PAS d'appel IA à l'import : détection simple, corrigeable en
  //    1 clic dans l'UI. L'agent web reste réservé à l'enrichissement (opt-in).
  return heuristicIdentify(input)
}

// Complète le site web d'une entreprise déjà connue (Comptes) via l'agent web.
// Renvoie undefined si aucune preuve — jamais deviné.
// Enrichissement COMPTE via le web (Claude seul) : trouve le site officiel, le
// PARCOURT et résume ce que data.gouv ne donne pas — secteur réel, activité,
// proposition de valeur, cible/clients, actus. N'invente rien (champ vide sinon).
export interface CompanyWeb { website?: string; summary?: string; sector?: string; effectif?: string; ca?: string; mode: string }

export async function enrichCompanyWeb(company: string, city?: string, siren?: string): Promise<CompanyWeb> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return { mode: 'off' }
  const model = getKey('SIGNALS_MODEL') || 'claude-opus-4-8'
  const pappers = siren ? `Consulte aussi la fiche PUBLIQUE Pappers (https://www.pappers.fr/entreprise/${siren}) pour le chiffre d'affaires, l'effectif et les infos légales.` : ''
  const system = `Tu es analyste commercial B2B. On te donne une entreprise française.
1) Trouve son SITE OFFICIEL via la recherche web et parcours-le. ${pappers}
2) Résume FACTUELLEMENT en FRANÇAIS ce qu'une fiche SIREN/NAF ne dit pas : secteur réel,
activité concrète (ce qu'elle vend), proposition de valeur, cible/clients, actualités visibles.
3) Relève, si publiquement disponibles, le chiffre d'affaires (avec l'année) et l'effectif.
N'INVENTE RIEN : laisse un champ vide si l'info n'est pas trouvée. Ne donne pas de fourchette inventée.
Réponds UNIQUEMENT en JSON: {"website","sector","summary","ca","effectif"}. summary = 3 à 5 phrases max.`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 1100,
        system,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: `Entreprise: ${company}${city ? ` (${city})` : ''}${siren ? ` · SIREN ${siren}` : ''}. Trouve le site, parcours-le, et renvoie le JSON demandé.` }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic ${res.status}`)
    const data = await res.json()
    const text: string = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return { mode: 'claude-web' }
    let p: any; try { p = JSON.parse(m[0]) } catch { return { mode: 'claude-web' } }
    return {
      website: cleanWebsite(p.website),
      sector: (p.sector && String(p.sector).trim()) || undefined,
      summary: (p.summary && String(p.summary).trim()) || undefined,
      ca: (p.ca && String(p.ca).trim()) || undefined,
      effectif: (p.effectif && String(p.effectif).trim()) || undefined,
      mode: 'claude-web',
    }
  } catch {
    return { mode: 'error' }
  }
}
