// Recherche par SIGNAL — agent Claude (web search) qui détecte des entreprises
// émettant un signal (annonce de recrutement, levée, actu) et propose un icebreaker.
// La DÉCOUVERTE ne fait aucun appel data.gouv : on ne garde que les résultats
// sourcés (URL + date obligatoires) et conformes au ciblage demandé. La
// vérification SIREN est un geste d'AJOUT → elle a lieu à l'import.
// Sans ANTHROPIC_API_KEY : aucune donnée (jamais de mock).

import type { SignalHit } from '../../types/prospector'
import { searchExa, exaConfigured, type ExaDoc } from './exa'
import { getKey } from './keystore'
import { withBuild } from '../version'
import { callClaude as llmCall, cacheKey, pickModel } from './llm'
import type { TenantContext } from './tenant'
import { logSafeError, PUBLIC_ERROR } from '../observability/safeError'

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

// Sources de RÉFÉRENCE, utilisées comme simple préférence dans le prompt (et comme
// filtre côté Exa). Jamais en `allowed_domains` sur la recherche web d'Anthropic :
// elle refuse (400) tout domaine bloquant son crawler — bfmtv.com et latribune.fr
// l'ont fait tomber. LinkedIn est exclu (pas de scraping LinkedIn).
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

// web_fetch (ouvrir un article trouvé) n'existe que sur les modèles récents.
// L'envoyer à un modèle qui ne le supporte pas ferait échouer toute la requête.
function supportsWebFetch(model: string): boolean {
  return /(opus-5|sonnet-5|fable-5|opus-4-[678]|sonnet-4-6)/i.test(model)
}

// Consigne d'EXHAUSTIVITÉ. Sans elle, l'agent se contente de 1 ou 2 exemples
// « représentatifs » : c'est son comportement par défaut quand on lui demande de
// trouver des entreprises. Or la presse spécialisée publie des récapitulatifs
// mensuels qui en listent des dizaines — il faut lui dire d'aller les ouvrir.
const RECALL = `MÉTHODE — vise l'EXHAUSTIVITÉ, pas l'illustration :
1. Cherche d'abord les RÉCAPITULATIFS publiés par la presse spécialisée : « récap levées de fonds [mois] [année] », « les levées de la semaine », « baromètre des levées », « funding roundup France ».
2. OUVRE ces articles (outil web_fetch) au lieu de te contenter de l'extrait de résultat : le corps de l'article liste souvent 20 à 40 entreprises que l'extrait ne montre pas.
3. Énumère CHAQUE entreprise citée qui correspond au ciblage, une entrée par entreprise. Ne sélectionne pas « les plus intéressantes ».
4. Complète ensuite par des recherches ciblées pour les entreprises absentes des récapitulatifs.
Un résultat de 1 ou 2 entreprises sur une période de plusieurs mois est un ÉCHEC : il en existe beaucoup plus, cherche mieux.`

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

async function callClaude(tenant: TenantContext, thesis: string, max: number, q?: SignalQuery): Promise<SignalHit[]> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return []
  // Sources ciblées selon le type de signal (presse pour les levées, jobboards
  // pour les recrutements) → moins de bruit, résultats plus fiables.
  // ── Choix d'architecture (volontaire) ──
  // On NE met PAS de `allowed_domains` : une liste blanche est un point de
  // défaillance unique (un seul domaine bloquant le crawler d'Anthropic = 400 sur
  // TOUTE la requête) et elle amputerait la couverture (une ESN annonce souvent
  // son recrutement sur son propre site carrière, pas sur un jobboard connu).
  // Les sources de référence sont données comme PRÉFÉRENCE dans le prompt, et la
  // pertinence est garantie par focusInstruction() + keepOnFocus() côté serveur.
  const tools: any[] = [{
    type: 'web_search_20250305', name: 'web_search', max_uses: 10,
    user_location: { type: 'approximate', country: 'FR' },
    blocked_domains: ['linkedin.com'], // pas de scraping LinkedIn (Unipile s'en charge)
  }]
  // ⚠️ LEVIER PRINCIPAL DE COUVERTURE : sans web_fetch, l'agent ne lit que les
  // extraits de résultats de recherche — or un récapitulatif « les levées de juin »
  // liste 30 entreprises dans le CORPS de l'article, invisible dans l'extrait.
  // Avec web_fetch il ouvre l'article et les énumère toutes.
  if (supportsWebFetch(pickModel('research'))) {
    tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6, blocked_domains: ['linkedin.com'] })
  }
  const prefer = q ? domainsFor(q) : []
  const hint = prefer.length ? `\n\nSources à privilégier quand elles couvrent le sujet (non exclusif — le site officiel ou la page carrière de l'entreprise est une source valable) : ${prefer.join(', ')}.` : ''
  const r = await llmCall({
    tenant, task: 'research', agent: SIGNAL_AGENT, system: SYSTEM, tools,
    messages: [{ role: 'user', content: `Thèse: ${thesis}${focusInstruction(q)}${hint}\n\n${RECALL}\n\n${jsonInstruction(max)}` }],
    cache: cacheKey(['signal-web', thesis, String(max), 'v3']),
  })
  // Un budget épuisé est une ERREUR, pas « aucun résultat » : on le dit.
  if (r.blocked) throw new Error(r.error || 'Appel IA refusé (budget).')
  const hits = parseHits(r.text)
  // Réponse tronquée (plafond de tokens atteint) : le JSON est incomplet, donc
  // parseHits rend peu ou rien. On le signale au lieu d'afficher « 0 résultat ».
  if (!hits.length && r.truncated) throw new Error('Réponse IA tronquée (limite de tokens). Réduis le nombre de critères ou la période.')
  return hits
}

// Claude EXTRACTEUR : à partir des documents Exa, sort les entreprises + signaux
// + icebreakers. Pas de web tool ici (Exa a déjà cherché) → plus rapide/moins cher.
async function extractWithClaude(tenant: TenantContext, thesis: string, docs: ExaDoc[], max: number, q?: SignalQuery): Promise<SignalHit[]> {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key || docs.length === 0) return []
  // Économie : on borne le corpus (8 docs, 900 car.) — l'entrée est facturée.
  const corpus = docs.slice(0, 8)
    .map((d, i) => `[${i + 1}] ${d.title}\nURL: ${d.url}\n${(d.text || '').slice(0, 900)}`)
    .join('\n\n')

  const r = await llmCall({
    tenant, task: 'research', agent: SIGNAL_AGENT,
    system: `${SYSTEM}\nOn te fournit des extraits web déjà collectés. N'invente RIEN au-delà de ces extraits. Attribue à chaque entreprise l'URL source d'où vient le signal.`,
    messages: [{ role: 'user', content: `Thèse: ${thesis}${focusInstruction(q)}\n\nExtraits web:\n${corpus}\n\n${jsonInstruction(max)}` }],
  })
  if (r.blocked) throw new Error(r.error || 'Appel IA refusé (budget).')
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

// Découpe la fenêtre demandée en mois calendaires (3 passes au maximum, pour
// borner le coût). Chaque passe cible un mois nommé — c'est ce qui permet à
// l'agent de trouver le récapitulatif mensuel correspondant.
function monthSlices(months: number): string[] {
  const n = Math.min(Math.max(months, 1), 3)
  const fmt = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' })
  const now = new Date()
  return Array.from({ length: n }, (_, i) => fmt.format(new Date(now.getFullYear(), now.getMonth() - i, 1)))
}

// `q` (critères structurés) est optionnel : sans lui, on garde la thèse libre.
export async function searchSignals(tenant: TenantContext, thesis: string, max = 8, q?: SignalQuery): Promise<{ mode: string; hits: SignalHit[]; thesis: string; passes?: number; error?: string }> {
  const mode = signalsMode()
  if (mode === 'mock') {
    return { mode, hits: [], thesis, error: 'Aucune clé IA configurée : ajoute ANTHROPIC_API_KEY dans Admin → Connexions pour activer la veille par signal.' }
  }

  let hits: SignalHit[] = []
  let passes = 1
  try {
    if (mode === 'exa+claude') {
      // Exa : on garde le filtre de FRAÎCHEUR (le vrai apport : la fenêtre demandée
      // devient une contrainte réelle, pas un souhait adressé au modèle) mais PAS de
      // liste blanche de domaines — un signal se trouve aussi sur le site de
      // l'entreprise. Le tri de pertinence se fait par keepOnFocus() en sortie.
      const docs = await searchExa(thesis, 12, { months: q?.months })
      hits = docs.length ? await extractWithClaude(tenant, thesis, docs, max, q) : await callClaude(tenant, thesis, max, q)
      // Exa a bien répondu mais rien d'exploitable n'en sort (documents hors sujet) :
      // on repasse par la recherche web plutôt que de rendre une page vide.
      if (!hits.length) hits = await callClaude(tenant, thesis, max, q)
    } else {
      // Balayage par MOIS plutôt qu'une requête unique sur toute la période.
      // Une seule requête « 3 derniers mois » rend 1 ou 2 entreprises ; trois
      // requêtes « juin », « mai », « avril » en rendent bien davantage, parce que
      // chacune tombe sur le récapitulatif mensuel correspondant.
      const slices = monthSlices(q?.months || 6)
      const per = Math.max(8, Math.ceil(max / slices.length))
      const batches = await Promise.all(slices.map((label) =>
        callClaude(tenant, `${thesis}\n\nPÉRIODE À COUVRIR POUR CETTE RECHERCHE : ${label}. Ne renvoie que des signaux datés de ce mois-là.`, per, q)
          .catch(() => [] as SignalHit[]),
      ))
      hits = batches.flat()
      passes = slices.length
      // Si toutes les passes échouent, on relance une fois en global pour avoir
      // une vraie erreur plutôt qu'un silence.
      if (!hits.length) hits = await callClaude(tenant, thesis, max, q)
    }
  } catch (e: any) {
    // On remonte l'erreur RÉELLE (modèle indisponible, outil web non activé, quota…)
    // au lieu de fabriquer des résultats.
    // SEC-LOG-01 — ce champ part TEL QUEL dans la réponse HTTP 200 de
    // `/api/signals/search`. Le message d'exception n'y a donc pas sa place :
    // seule la classe de panne est communiquée, le détail va au journal.
    logSafeError('signals.search_failed', e, { operation: 'signals_search' })
    return { mode, hits: [], thesis, error: withBuild(PUBLIC_ERROR) }
  }

  // Post-traitement LOCAL (gratuit, instantané) : on respecte le ciblage demandé
  // puis on déduplique. Aucun appel réseau ici.
  const clean = dedupe(keepOnFocus(hits, q))

  // ⚠️ PAS de vérification data.gouv ici. Vérifier 8 entreprises à chaque recherche
  // ralentissait tout (cause de timeout) et marquait « non vérifiée » des sociétés
  // réelles dont le nom ne matchait pas exactement. La vérification SIREN est un
  // geste d'AJOUT, pas de découverte → elle se fait à l'import (voir capabilities).
  return { mode, hits: clean, thesis, passes }
}
