// Recherche par SIGNAL — agent Claude (web search) qui détecte des entreprises
// émettant un signal (annonce de recrutement, levée, actu) et propose un icebreaker.
// La DÉCOUVERTE ne fait aucun appel data.gouv : on ne garde que les résultats
// sourcés (URL + date obligatoires) et conformes au ciblage demandé. La
// vérification SIREN est un geste d'AJOUT → elle a lieu à l'import.
// Sans ANTHROPIC_API_KEY : aucune donnée (jamais de mock).

import type { SignalHit } from '../../types/prospector'
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

// ⚠️ Ces listes servent de `allowed_domains` à l'outil de recherche web
// d'Anthropic, qui REFUSE (400) tout domaine bloquant son crawler. Ne jamais y
// ajouter un domaine sans l'avoir testé (bfmtv.com et latribune.fr sont refusés).
// LinkedIn est volontairement exclu (pas de scraping LinkedIn).
const PRESS = ['maddyness.com', 'frenchweb.fr', 'usine-digitale.fr', 'eu-startups.com', 'journaldunet.com', 'lejournaldesentreprises.com', 'sifted.eu', 'tech.eu']
const JOBS = ['welcometothejungle.com', 'hellowork.com', 'apec.fr', 'cadremploi.fr', 'indeed.fr']

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
  return `Renvoie un objet JSON: {"hits":[{"company","signalType","detail","icebreaker","sector","city","sourceUrl","sourceName","date","amount","role"}]} avec au plus ${max} entrées.
signalType ∈ ["recrutement","levée","actu","autre"].
"detail" = le fait précis et daté (une phrase). "sourceName" = nom du média/site. "date" = date du signal (AAAA-MM ou AAAA-MM-JJ).
"amount" = montant de la levée si applicable (sinon ""). "role" = poste ouvert si recrutement (sinon "").
Chaque entrée DOIT avoir sourceUrl et date. Une entrée sans source vérifiable ne doit PAS être incluse.`
}

// Le SIGNAL DEMANDÉ doit être respecté : c'est la plainte n°1 (« je demande des
// recrutements, il me sort des levées »). On l'impose dans le prompt…
function focusInstruction(q?: SignalQuery): string {
  const defs = SIGNAL_TYPES.filter((t) => (q?.types || []).includes(t.key))
  if (!defs.length) return ''
  const wanted = Array.from(new Set(defs.map((d) => d.group === 'financement' ? (d.key === 'rachat' ? 'actu' : 'levée') : d.group === 'croissance' && d.key.startsWith('recrutement') ? 'recrutement' : 'actu')))
  return `\n\nCONTRAINTE DE CIBLAGE — l'utilisateur a demandé EXCLUSIVEMENT : ${defs.map((d) => d.label).join(', ')}.
N'inclus AUCUNE entreprise dont le signal ne correspond pas à cette demande, même si elle est intéressante.
signalType attendu : ${wanted.join(' ou ')}. Si tu ne trouves pas assez d'entreprises correspondantes, renvoie MOINS d'entrées — ne comble jamais avec autre chose.`
}

// …et on le vérifie après coup (le prompt ne suffit pas toujours).
function keepOnFocus(hits: SignalHit[], q?: SignalQuery): SignalHit[] {
  const defs = SIGNAL_TYPES.filter((t) => (q?.types || []).includes(t.key))
  if (!defs.length) return hits
  const groups = new Set(defs.map((d) => d.group))
  const wantsFinance = groups.has('financement')
  const wantsRecrut = defs.some((d) => d.key.startsWith('recrutement'))
  return hits.filter((h) => {
    if (h.signalType === 'levée') return wantsFinance
    if (h.signalType === 'recrutement') return wantsRecrut
    return true // 'actu'/'autre' : on garde (ouverture, nomination, lancement…)
  })
}

// Déduplication par nom normalisé (l'agent renvoie parfois « Acme » et « Acme SAS »).
function dedupe(hits: SignalHit[]): SignalHit[] {
  const seen = new Set<string>()
  const out: SignalHit[] = []
  for (const h of hits) {
    const key = h.company.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\b(sas|sasu|sarl|sa|group|groupe|france|technologies?)\b/g, '').replace(/[^a-z0-9]/g, '')
    if (!key || seen.has(key)) continue
    seen.add(key); out.push(h)
  }
  return out
}

async function callClaude(thesis: string, max: number, q?: SignalQuery): Promise<SignalHit[]> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return []
  // Sources ciblées selon le type de signal (presse pour les levées, jobboards
  // pour les recrutements) → moins de bruit, résultats plus fiables.
  const allowed = q ? domainsFor(q) : []
  const prompt = `Thèse: ${thesis}${focusInstruction(q)}\n\n${jsonInstruction(max)}`
  const run = (domains: string[]) => {
    const tool: any = { type: 'web_search_20250305', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'FR' } }
    if (domains.length) tool.allowed_domains = domains
    // Sans liste blanche, on interdit au moins LinkedIn (pas de scraping LinkedIn).
    else tool.blocked_domains = ['linkedin.com']
    return llmCall({
      task: 'research', agent: SIGNAL_AGENT, system: SYSTEM, tools: [tool],
      messages: [{ role: 'user', content: prompt }],
      cache: cacheKey(['signal-web', thesis, String(max), domains.length ? 'allow' : 'open']),
    })
  }

  let r
  try {
    r = await run(allowed)
  } catch (e: any) {
    // Anthropic renvoie un 400 si l'un des domaines de la liste blanche bloque son
    // crawler. Plutôt que d'échouer, on relance en recherche ouverte (le
    // post-filtre de ciblage garde la qualité) — l'utilisateur voit des résultats.
    if (!/not accessible|invalid_request_error/i.test(String(e?.message || ''))) throw e
    r = await run([])
  }
  if (r.blocked) return []
  return parseHits(r.text)
}

// Claude EXTRACTEUR : à partir des documents Exa, sort les entreprises + signaux
// + icebreakers. Pas de web tool ici (Exa a déjà cherché) → plus rapide/moins cher.
async function extractWithClaude(thesis: string, docs: ExaDoc[], max: number, q?: SignalQuery): Promise<SignalHit[]> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key || docs.length === 0) return []
  // Économie : on borne le corpus (8 docs, 900 car.) — l'entrée est facturée.
  const corpus = docs.slice(0, 8)
    .map((d, i) => `[${i + 1}] ${d.title}\nURL: ${d.url}\n${(d.text || '').slice(0, 900)}`)
    .join('\n\n')

  const r = await llmCall({
    task: 'research', agent: SIGNAL_AGENT,
    system: `${SYSTEM}\nOn te fournit des extraits web déjà collectés. N'invente RIEN au-delà de ces extraits. Attribue à chaque entreprise l'URL source d'où vient le signal.`,
    messages: [{ role: 'user', content: `Thèse: ${thesis}${focusInstruction(q)}\n\nExtraits web:\n${corpus}\n\n${jsonInstruction(max)}` }],
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
    sourceName: h.sourceName || undefined,
    date: h.date || undefined,
    amount: h.amount || undefined,
    role: h.role || undefined,
    verified: false,
  }))
  // Sans nom d'entreprise ni source vérifiable, un « signal » n'a aucune valeur.
  .filter((h: SignalHit) => h.company && h.sourceUrl)
}

// ⚠️ PLUS DE DONNÉES DE DÉMONSTRATION. Avant, un échec d'appel retombait sur des
// entreprises codées en dur (Pigment, Descartes…) présentées comme de vrais
// résultats, badge SIREN inclus. C'était le pire des mensonges possibles.
// Désormais : soit des résultats réels, soit une ERREUR EXPLICITE.

// `q` (critères structurés) est optionnel : sans lui, on garde la thèse libre.
export async function searchSignals(thesis: string, max = 8, q?: SignalQuery): Promise<{ mode: string; hits: SignalHit[]; thesis: string; error?: string }> {
  const mode = signalsMode()
  if (mode === 'mock') {
    return { mode, hits: [], thesis, error: 'Aucune clé IA configurée : ajoute ANTHROPIC_API_KEY dans Admin → Connexions pour activer la veille par signal.' }
  }

  let hits: SignalHit[] = []
  try {
    if (mode === 'exa+claude') {
      const docs = await searchExa(thesis, 12, q ? { domains: domainsFor(q), months: q.months } : undefined)
      hits = docs.length ? await extractWithClaude(thesis, docs, max, q) : await callClaude(thesis, max, q)
    } else {
      hits = await callClaude(thesis, max, q)
    }
  } catch (e: any) {
    // On remonte l'erreur RÉELLE (modèle indisponible, outil web non activé, quota…)
    // au lieu de fabriquer des résultats.
    return { mode, hits: [], thesis, error: String(e?.message || e).slice(0, 300) }
  }

  // Post-traitement LOCAL (gratuit, instantané) : on respecte le ciblage demandé
  // puis on déduplique. Aucun appel réseau ici.
  const clean = dedupe(keepOnFocus(hits, q))

  // ⚠️ PAS de vérification data.gouv ici. Vérifier 8 entreprises à chaque recherche
  // ralentissait tout (cause de timeout) et marquait « non vérifiée » des sociétés
  // réelles dont le nom ne matchait pas exactement. La vérification SIREN est un
  // geste d'AJOUT, pas de découverte → elle se fait à l'import (voir capabilities).
  return { mode, hits: clean, thesis }
}
