// Recherche par SIGNAL — agent Claude (web search) qui détecte des entreprises
// émettant un signal (annonce de recrutement, levée, actu) et propose un icebreaker.
// Chaque entreprise est ensuite RÉCONCILIÉE sur un SIREN réel (data.gouv) pour
// filtrer les hallucinations. Sans ANTHROPIC_API_KEY : fallback mock.

import type { SignalHit } from '../../types/prospector'
import { reconcileByName } from './datagouv'

export function signalsConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

const SYSTEM = `Tu es un agent de veille commerciale B2B pour une agence française.
On te donne une thèse de prospection (ex: "startups fintech qui recrutent des sales", "sociétés de conseil en cybersécurité en levée de fonds").
Utilise la recherche web pour trouver des ENTREPRISES FRANÇAISES réelles qui émettent ce signal MAINTENANT
(annonces d'emploi sur Welcome to the Jungle / LinkedIn / Indeed, actualités de levée, presse).
Pour chacune, renvoie un signal précis et exploitable et une accroche (icebreaker) personnalisée, courte, sans blabla commercial.
Ne renvoie que des entreprises réelles et nommées. Réponds UNIQUEMENT en JSON valide.`

function jsonInstruction(max: number) {
  return `Renvoie un objet JSON: {"hits":[{"company","signalType","detail","icebreaker","sector","city","sourceUrl"}]} avec au plus ${max} entrées. signalType ∈ ["recrutement","levée","actu","autre"].`
}

async function callClaude(thesis: string, max: number): Promise<SignalHit[]> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return []
  const model = process.env.SIGNALS_MODEL || 'claude-opus-4-8'

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: `Thèse: ${thesis}\n\n${jsonInstruction(max)}` }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status} — ${(await res.text()).slice(0, 150)}`)
  const data = await res.json()

  // concatène les blocs texte de la réponse
  const text: string = (data.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return []
  const parsed = JSON.parse(match[0])
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

export async function searchSignals(thesis: string, max = 8): Promise<{ mock: boolean; hits: SignalHit[] }> {
  let hits: SignalHit[]
  let mock = false
  try {
    hits = signalsConfigured() ? await callClaude(thesis, max) : mockHits(thesis)
    if (!signalsConfigured()) mock = true
  } catch {
    hits = mockHits(thesis)
    mock = true
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
  return { mock, hits: reconciled }
}
