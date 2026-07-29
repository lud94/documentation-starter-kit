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
import { callClaude, parseJson, cacheKey } from './llm'

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


// Nettoie un nom d'entreprise des libellés parasites récupérés d'une page
// (« siren redsen » → « redsen », « SIRET 123 Acme » → « Acme »).
function cleanCompanyName(s: string): string {
  const cleaned = (s || '')
    .replace(/\b(siren|siret|rcs|tva|naf|entreprise|soci[ée]t[ée]|ste)\b/gi, '')
    .replace(/\b\d{9,14}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || (s || '').trim()
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
// Défaut PRUDENT : sans signal fort de personne (URL /in/), un import est un COMPTE.
// On ne classe en PERSONNE que si un nom plausible ET une société DISTINCTE sont
// fournis (cas « X, dirigeant de la société Y » d'un article). Sinon → compte,
// corrigeable en 1 clic (« C'est un compte » / « Renseigner un contact »).
async function heuristicIdentify(input: IdentifyInput): Promise<IdentifyResult> {
  // Défaut UNIQUE : COMPTE. On ne crée jamais de contact « deviné » à l'import.
  // (Le seul cas contact est un profil LinkedIn /in/, traité dans identifyLead.)
  // Si l'import est en réalité une personne → bouton « C'est un contact » sur le compte.
  const companyName = cleanCompanyName(input.company || input.name || '')
  let confidence: IdentifyResult['confidence'] = 'medium'
  try { const r = await reconcileByName(companyName); if (r) confidence = 'high' } catch { /* best-effort */ }
  return { kind: 'company', company: companyName, confidence, mode: 'heuristic' }
}

export async function identifyLead(input: IdentifyInput): Promise<IdentifyResult> {
  const url = (input.url || '').toLowerCase()
  const name = (input.name || '').trim()

  // SEUL un profil LinkedIn /in/ crée un CONTACT. Tout le reste → COMPTE.
  if (/linkedin\.com\/in\//.test(url)) {
    const { firstName, lastName } = splitName(name)
    return { kind: 'person', firstName, lastName, title: input.title || undefined, company: input.company || undefined, confidence: 'high', mode: 'url' }
  }
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
  const pappers = siren ? `Consulte aussi la fiche PUBLIQUE Pappers (https://www.pappers.fr/entreprise/${siren}) pour le chiffre d'affaires, l'effectif et les infos légales.` : ''
  const system = `Tu es analyste commercial B2B. On te donne une entreprise française.
1) Trouve son SITE OFFICIEL via la recherche web et parcours-le. ${pappers}
2) Résume FACTUELLEMENT en FRANÇAIS ce qu'une fiche SIREN/NAF ne dit pas : secteur réel,
activité concrète (ce qu'elle vend), proposition de valeur, cible/clients, actualités visibles.
3) Relève, si publiquement disponibles, le chiffre d'affaires (avec l'année) et l'effectif.
N'INVENTE RIEN : laisse un champ vide si l'info n'est pas trouvée. Ne donne pas de fourchette inventée.
Réponds UNIQUEMENT en JSON: {"website","sector","summary","ca","effectif"}. summary = 3 à 5 phrases max.`
  try {
    // Cache 7 j par entreprise : réenrichir la même boîte ne coûte plus rien.
    // web_search limité à 3 usages (chaque recherche est facturée + gonfle l'entrée).
    const r = await callClaude({
      task: 'extract', agent: 'Enrichissement web', system,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: `Entreprise: ${company}${city ? ` (${city})` : ''}${siren ? ` · SIREN ${siren}` : ''}. Trouve le site, parcours-le, et renvoie le JSON demandé.` }],
      cache: cacheKey(['enrich', siren || company, city || '']),
    })
    if (r.blocked) return { mode: 'blocked' }
    const p = parseJson<any>(r.text)
    if (!p) return { mode: 'claude-web' }
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
