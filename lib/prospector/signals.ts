// Recherche par SIGNAL — agent Claude (web search) qui détecte des entreprises
// émettant un signal (annonce de recrutement, levée, actu) et propose un icebreaker.
// Chaque entreprise est ensuite RÉCONCILIÉE sur un SIREN réel (data.gouv) pour
// filtrer les hallucinations. Sans ANTHROPIC_API_KEY : fallback mock.

import type { SignalHit } from '../../types/prospector'
import { reconcileByName } from './datagouv'
import { searchExa, exaConfigured, type ExaDoc } from './exa'
import { getKey } from './keystore'
import { callClaude as llmCall, cacheKey } from './llm'

const SIGNAL_AGENT = 'Recherche signal'

export function signalsConfigured(): boolean {
  return !!getKey('ANTHROPIC_API_KEY')
}

// Décrit la voie active pour l'affichage (transparence coût/source).
export function signalsMode(): 'exa+claude' | 'claude-web' | 'mock' {
  if (getKey('ANTHROPIC_API_KEY') && exaConfigured()) return 'exa+claude'
  if (getKey('ANTHROPIC_API_KEY')) return 'claude-web'
  return 'mock'
}

// ── Catalogue de signaux : chaque type a son vocabulaire et ses sources ──────────
// Permet une recherche CIBLÉE (ex: uniquement les Série A des 6 derniers mois)
// au lieu d'une thèse en texte libre.
export interface SignalTypeDef { key: string; label: string; group: 'financement' | 'croissance' | 'direction'; terms: string; domains: string[] }

const PRESS = ['maddyness.com', 'frenchweb.fr', 'lesechos.fr', 'usine-digitale.fr', 'eu-startups.com', 'journaldunet.com', 'lejournaldesentreprises.com', 'bfmtv.com', 'latribune.fr']
const JOBS = ['welcometothejungle.com', 'indeed.fr', 'hellowork.com', 'apec.fr', 'linkedin.com']

export const SIGNAL_TYPES: SignalTypeDef[] = [
  { key: 'preseed', label: 'Pré-seed', group: 'financement', terms: 'levée pré-seed, pre-seed round, amorçage', domains: PRESS },
  { key: 'seed', label: 'Seed', group: 'financement', terms: 'levée seed, tour d\'amorçage', domains: PRESS },
  { key: 'serie_a', label: 'Série A', group: 'financement', terms: 'levée de fonds Série A, Series A round', domains: PRESS },
  { key: 'serie_b', label: 'Série B', group: 'financement', terms: 'levée de fonds Série B, Series B round', domains: PRESS },
  { key: 'serie_c', label: 'Série C+', group: 'financement', terms: 'levée de fonds Série C, Série D, late stage', domains: PRESS },
  { key: 'rachat', label: 'Rachat / M&A', group: 'financement', terms: 'acquisition, rachat, fusion, M&A', domains: PRESS },
  { key: 'recrutement_sales', label: 'Recrute des sales', group: 'croissance', terms: 'recrute Head of Sales, Account Executive, SDR, business developer', domains: JOBS },
  { key: 'recrutement_tech', label: 'Recrute de la tech', group: 'croissance', terms: 'recrute développeurs, CTO, ingénieurs', domains: JOBS },
  { key: 'ouverture', label: 'Ouverture de bureau', group: 'croissance', terms: 'ouvre un bureau, nouvelle implantation, expansion', domains: PRESS },
  { key: 'international', label: 'Expansion internationale', group: 'croissance', terms: 'expansion internationale, se lance à l\'étranger', domains: PRESS },
  { key: 'nomination', label: 'Nomination dirigeant', group: 'direction', terms: 'nomination, nouveau directeur, arrive en tant que, rejoint le comité', domains: PRESS },
  { key: 'lancement', label: 'Lancement produit', group: 'direction', terms: 'lance un nouveau produit, nouvelle offre', domains: PRESS },
]

export interface SignalQuery {
  thesis?: string          // thèse libre (mode expert)
  types?: string[]         // clés de SIGNAL_TYPES
  sector?: string
  location?: string
  months?: number          // fenêtre de fraîcheur (défaut 6)
  keywords?: string        // mots-clés additionnels
}

// Construit une thèse précise à partir des critères cochés.
export function buildThesis(q: SignalQuery): string {
  if (q.thesis?.trim()) return q.thesis.trim()
  const defs = SIGNAL_TYPES.filter((t) => (q.types || []).includes(t.key))
  const parts: string[] = []
  if (defs.length) parts.push(`Entreprises françaises ayant émis ce signal : ${defs.map((d) => `${d.label} (${d.terms})`).join(' OU ')}`)
  if (q.sector) parts.push(`secteur ${q.sector}`)
  if (q.location) parts.push(`en/à ${q.location}`)
  if (q.keywords?.trim()) parts.push(`mots-clés : ${q.keywords.trim()}`)
  parts.push(`sur les ${q.months || 6} derniers mois`)
  return parts.join(' · ')
}

// Domaines à privilégier selon les types cochés.
export function domainsFor(q: SignalQuery): string[] {
  const defs = SIGNAL_TYPES.filter((t) => (q.types || []).includes(t.key))
  if (!defs.length) return Array.from(new Set([...PRESS, ...JOBS]))
  return Array.from(new Set(defs.flatMap((d) => d.domains)))
}

const SYSTEM = `Tu es un agent de veille commerciale B2B pour une agence française.
On te donne une THÈSE DE PROSPECTION précise. Trouve des ENTREPRISES FRANÇAISES RÉELLES qui émettent ce signal.

RÈGLES STRICTES :
1. Le signal doit être RÉCENT (respecte la fenêtre demandée) et VÉRIFIABLE : donne la source (URL) et la DATE.
2. Pour une levée de fonds : précise le TOUR (pré-seed/seed/Série A/B/C), le MONTANT et l'INVESTISSEUR si connus.
3. Pour un recrutement : précise le POSTE ouvert.
4. N'INVENTE AUCUNE entreprise, aucun montant, aucune date. Si tu n'es pas sûr, n'inclus pas l'entrée.
5. Entreprises FRANÇAISES uniquement (ou avec une implantation française claire).
6. L'icebreaker doit s'appuyer sur le FAIT trouvé, être court, sans flatterie ni jargon commercial.

Réponds UNIQUEMENT en JSON valide.`

function jsonInstruction(max: number) {
  return `Renvoie un objet JSON: {"hits":[{"company","signalType","detail","icebreaker","sector","city","sourceUrl","date","amount"}]} avec au plus ${max} entrées.
signalType ∈ ["recrutement","levée","actu","autre"]. "detail" = le fait précis et daté. "amount" = montant de la levée si applicable (sinon "").`
}

async function callClaude(thesis: string, max: number, q?: SignalQuery): Promise<SignalHit[]> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return []
  // Sources ciblées selon le type de signal (presse pour les levées, jobboards
  // pour les recrutements) → moins de bruit, résultats plus fiables.
  const allowed = q ? domainsFor(q) : []
  const tool: any = { type: 'web_search_20250305', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'FR' } }
  if (allowed.length) tool.allowed_domains = allowed
  const r = await llmCall({
    task: 'research', agent: SIGNAL_AGENT, system: SYSTEM,
    tools: [tool],
    messages: [{ role: 'user', content: `Thèse: ${thesis}\n\n${jsonInstruction(max)}` }],
    cache: cacheKey(['signal-web', thesis, String(max)]),
  })
  if (r.blocked) return []
  return parseHits(r.text)
}

// Claude EXTRACTEUR : à partir des documents Exa, sort les entreprises + signaux
// + icebreakers. Pas de web tool ici (Exa a déjà cherché) → plus rapide/moins cher.
async function extractWithClaude(thesis: string, docs: ExaDoc[], max: number): Promise<SignalHit[]> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key || docs.length === 0) return []
  // Économie : on borne le corpus (8 docs, 900 car.) — l'entrée est facturée.
  const corpus = docs.slice(0, 8)
    .map((d, i) => `[${i + 1}] ${d.title}\nURL: ${d.url}\n${(d.text || '').slice(0, 900)}`)
    .join('\n\n')

  const r = await llmCall({
    task: 'research', agent: SIGNAL_AGENT,
    system: `${SYSTEM}\nOn te fournit des extraits web déjà collectés. N'invente RIEN au-delà de ces extraits. Attribue à chaque entreprise l'URL source d'où vient le signal.`,
    messages: [{ role: 'user', content: `Thèse: ${thesis}\n\nExtraits web:\n${corpus}\n\n${jsonInstruction(max)}` }],
  })
  if (r.blocked) return []
  return parseHits(r.text)
}

function parseHits(text: string): SignalHit[] {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return []
  let parsed: any
  try { parsed = JSON.parse(match[0]) } catch { return [] }
  return (parsed.hits || []).map((h: any): SignalHit => ({
    company: String(h.company || '').trim(),
    signalType: ['recrutement', 'levée', 'actu'].includes(h.signalType) ? h.signalType : 'autre',
    detail: String(h.detail || ''),
    icebreaker: String(h.icebreaker || ''),
    sector: h.sector || undefined,
    city: h.city || undefined,
    sourceUrl: h.sourceUrl || undefined,
    verified: false,
  }))
}

// Mock déterministe pour tester l'UX sans clé.
function mockHits(thesis: string): SignalHit[] {
  const t = thesis || 'recrutement sales'
  return [
    { company: 'Pigment', signalType: 'recrutement', detail: `Recrute un Head of Sales — ${t}`, icebreaker: `Vu que Pigment ouvre un poste de Head of Sales, la structuration de l'équipe commerciale est sûrement un sujet chaud en ce moment.`, sector: 'SaaS B2B', city: 'Paris', sourceUrl: 'https://www.welcometothejungle.com', verified: false },
    { company: 'Descartes Underwriting', signalType: 'levée', detail: 'Levée de fonds récente (Série B)', icebreaker: `Félicitations pour la levée — c'est souvent le moment où l'acquisition doit passer à l'échelle.`, sector: 'Insurtech', city: 'Paris', sourceUrl: 'https://www.maddyness.com', verified: false },
    { company: 'HarfangLab', signalType: 'recrutement', detail: 'Recrute plusieurs SDR (cybersécurité)', icebreaker: `HarfangLab scale son équipe SDR — la répétabilité du process outbound devient vite le nerf de la guerre.`, sector: 'Cybersécurité', city: 'Paris', sourceUrl: 'https://www.linkedin.com/jobs', verified: false },
  ]
}

// `q` (critères structurés) est optionnel : sans lui, on garde la thèse libre.
export async function searchSignals(thesis: string, max = 8, q?: SignalQuery): Promise<{ mock: boolean; mode: string; hits: SignalHit[]; thesis: string }> {
  const mode = signalsMode()
  let hits: SignalHit[]
  let mock = false
  try {
    if (mode === 'exa+claude') {
      const docs = await searchExa(thesis, 12, q ? { domains: domainsFor(q), months: q.months } : undefined)
      hits = docs.length ? await extractWithClaude(thesis, docs, max) : await callClaude(thesis, max, q)
    } else if (mode === 'claude-web') {
      hits = await callClaude(thesis, max, q)
    } else {
      hits = mockHits(thesis); mock = true
    }
  } catch {
    hits = mockHits(thesis); mock = true
  }

  // Réconciliation SIREN — vérifie l'existence réelle, filtre les hallucinations.
  const reconciled = await Promise.all(
    hits.map(async (h) => {
      const r = await reconcileByName(h.company)
      return r
        ? { ...h, siren: r.siren, sector: h.sector || r.sector, city: h.city || r.city, verified: true }
        : { ...h, verified: false }
    }),
  )
  return { mock, mode, hits: reconciled, thesis }
}
