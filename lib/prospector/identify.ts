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
import { searchExaWeb, exaConfigured, type ExaDoc } from './exa'
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

export function identifyMode(): 'exa+claude' | 'claude-web' | 'heuristic' {
  if (getKey('ANTHROPIC_API_KEY') && exaConfigured()) return 'exa+claude'
  if (getKey('ANTHROPIC_API_KEY')) return 'claude-web'
  return 'heuristic'
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

// ── Agent Exa → Claude : classe l'entité et retrouve site web + société. ───────
async function agentIdentify(input: IdentifyInput): Promise<IdentifyResult | null> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return null
  const model = getKey('SIGNALS_MODEL') || 'claude-opus-4-8'
  const q = [input.name, input.company, input.title].filter(Boolean).join(' ')

  let docs: ExaDoc[] = []
  const useExa = exaConfigured()
  if (useExa) { try { docs = await searchExaWeb(q) } catch { docs = [] } }

  const corpus = docs.map((d, i) => `[${i + 1}] ${d.title}\nURL: ${d.url}\n${d.text}`).join('\n\n')
  const system = `Tu classifies une entité importée par un commercial B2B.
Détermine si l'élément désigne une PERSONNE (un individu, futur contact) ou une ENTREPRISE (un compte).
${useExa ? "On te fournit des extraits web. N'invente RIEN au-delà de ces extraits." : 'Utilise la recherche web pour vérifier.'}
Retrouve, si tu en as la preuve, le site web officiel de l'entreprise et le nom exact de la société.
Ne devine JAMAIS un site web ou une donnée absente : laisse le champ vide si tu n'as pas la preuve.
Réponds UNIQUEMENT en JSON: {"kind":"person"|"company","firstName","lastName","title","company","website"}.`

  const body: any = {
    model,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: `Élément importé:\nnom: ${input.name || ''}\ntitre: ${input.title || ''}\nsociété: ${input.company || ''}\nurl: ${input.url || ''}\n\n${useExa ? `Extraits web:\n${corpus}\n\n` : ''}Classe et enrichis.` }],
  }
  if (!useExa) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}`)
  const data = await res.json()
  const text: string = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let p: any
  try { p = JSON.parse(m[0]) } catch { return null }
  const kind = p.kind === 'person' ? 'person' : 'company'
  return {
    kind,
    firstName: p.firstName || undefined,
    lastName: p.lastName || undefined,
    title: p.title || input.title || undefined,
    company: p.company || input.company || undefined,
    website: cleanWebsite(p.website),
    confidence: 'high',
    mode: useExa ? 'exa+claude' : 'claude-web',
  }
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

  // 2) Cas non tranché par l'URL → agent web si clés posées, sinon heuristique.
  if (identifyMode() !== 'heuristic') {
    try { const r = await agentIdentify(input); if (r) return r } catch { /* repli heuristique */ }
  }
  return heuristicIdentify(input)
}

// Complète le site web d'une entreprise déjà connue (Comptes) via l'agent web.
// Renvoie undefined si aucune preuve — jamais deviné.
export async function findCompanyWebsite(company: string, city?: string): Promise<{ website?: string; mode: string }> {
  const mode = identifyMode()
  if (mode === 'heuristic') return { website: undefined, mode }
  try {
    const r = await agentIdentify({ name: company, company, title: city })
    return { website: r?.website, mode }
  } catch {
    return { website: undefined, mode }
  }
}
