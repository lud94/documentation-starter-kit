import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { callClaude, parseJson } from '../../../lib/prospector/llm'
import { MISSION_TOOL_META } from '../../../types/prospector'
import type { Mission, MissionStep, MissionTool } from '../../../types/prospector'
import { MAX_COMPANIES, MAX_ENRICH } from '../../../lib/prospector/missionTools'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// Planificateur : demande libre → CONTRAT DE MISSION structuré.
// Il PLANIFIE seulement (rien n'est exécuté ici) : l'utilisateur valide ensuite.
const TOOLS = Object.keys(MISSION_TOOL_META) as MissionTool[]

const SYSTEM = `Tu es le planificateur de missions de Prospector (prospection B2B française).
Tu transformes une demande libre en CONTRAT DE MISSION exécutable, en n'utilisant QUE les outils autorisés.

OUTILS AUTORISÉS (aucun autre n'existe) :
- source_companies { sector?, location?, size?, limit } : cherche des entreprises sur data.gouv (gratuit). limit ≤ ${MAX_COMPANIES}.
  sector ∈ [Technology, SaaS B2B, IA / ML, Cybersécurité, Fintech, Finance, Consulting, Marketing, Media, Healthcare, Retail, Logistics, Construction, Education, Manufacturing, Legal, Energy, Real Estate, Hospitality]
  location = ville ou département français (ex: Paris, Lyon, 75). size ∈ [1-10, 11-20, 21-50, 51-100, 101-250, 251-500, 501-1000, 1000+]
- import_companies {} : crée les COMPTES trouvés dans le pipe.
- resolve_dirigeants {} : ajoute les dirigeants RÉELS (data.gouv) comme contacts.
- enrich_companies { limit } : enrichissement web par IA (site, activité, CA). COÛTE DES TOKENS. limit ≤ ${MAX_ENRICH}.
- create_list { name } : regroupe les leads créés dans une liste.
- create_sequence { name } : crée une séquence et y enrôle les contacts (créée EN PAUSE).

RÈGLES :
- L'ordre logique est : source_companies → import_companies → resolve_dirigeants → (enrich_companies) → create_list → create_sequence.
- N'ajoute que les étapes réellement demandées. Pas d'étape inutile.
- Une étape qui ÉCRIT ou qui COÛTE doit avoir "needsApproval": true si elle est massive (plus de 20 écritures) ou si elle consomme des tokens (enrich_companies). Sinon false.
- Si une information manque (secteur, ville, volume), fais une hypothèse RAISONNABLE, écris-la dans "assumptions", et liste ce qui manque dans "missing".
- N'invente aucune donnée d'entreprise : les outils vont chercher le réel.

Réponds UNIQUEMENT en JSON valide :
{ "title": "...", "objective": "...", "autonomy": "read_only"|"create",
  "assumptions": ["..."], "missing": ["..."],
  "steps": [ { "tool": "...", "label": "phrase courte en français", "params": {...}, "needsApproval": true|false } ] }`

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await hydrateKeystore()
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) return res.status(200).json({ error: 'Configure ta clé Anthropic (Admin → Connexions) pour planifier des missions.' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const request = String(body?.request || '').trim()
  if (!request) return res.status(400).json({ error: 'Demande vide.' })
  try {
    // Planification = raisonnement structuré → Sonnet par défaut (5× moins cher qu'Opus).
    const r = await callClaude({ task: 'plan', agent: 'Mission · plan', system: SYSTEM, messages: [{ role: 'user', content: `Demande : ${request}` }] })
    if (r.blocked) return res.status(200).json({ error: r.error })
    const p = parseJson<any>(r.text)
    if (!p) return res.status(200).json({ error: 'Plan illisible, reformule la demande.' })

    // Validation stricte : on ne garde que les outils connus, params bornés.
    const steps: MissionStep[] = (p.steps || [])
      .filter((s: any) => TOOLS.includes(s.tool))
      .slice(0, 8)
      .map((s: any, i: number) => {
        const params = { ...(s.params || {}) }
        if (s.tool === 'source_companies') params.limit = Math.min(Number(params.limit) || 20, MAX_COMPANIES)
        if (s.tool === 'enrich_companies') params.limit = Math.min(Number(params.limit) || 5, MAX_ENRICH)
        const meta = MISSION_TOOL_META[s.tool as MissionTool]
        return {
          id: `st_${i + 1}`, tool: s.tool, label: String(s.label || meta.label).slice(0, 120),
          params, status: 'pending' as const,
          needsApproval: !!s.needsApproval || !!meta.costly,
        }
      })
    if (!steps.length) return res.status(200).json({ error: 'Aucune étape exécutable pour cette demande.' })

    const mission: Mission = {
      id: `ms_${Math.random().toString(36).slice(2, 9)}`,
      title: String(p.title || 'Mission').slice(0, 80),
      request,
      objective: String(p.objective || '').slice(0, 400),
      status: 'draft',
      autonomy: steps.some((s) => MISSION_TOOL_META[s.tool].write) ? 'create' : 'read_only',
      steps,
      assumptions: (p.assumptions || []).map((x: any) => String(x)).slice(0, 6),
      missing: (p.missing || []).map((x: any) => String(x)).slice(0, 6),
      context: {}, log: [], cursor: 0, createdAt: Date.now(),
    }
    res.status(200).json({ mission })
  } catch (e: any) {
    res.status(200).json({ error: 'Planification impossible : ' + (e?.message || 'erreur') })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
