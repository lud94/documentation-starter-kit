// LEAD_GATE_E2E_001 — le VRAI gate de liaison Lead, appelé directement.
//
// ⚠️ On teste `compteDuCandidat` EXPORTÉ TEL QUEL — jamais une
// réimplémentation. Entité résolue SEULE ≠ compte résolu : le gate exige une
// fiche RÉELLEMENT persistée du workspace portant EXACTEMENT le SIREN officiel.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etat = vi.hoisted(() => ({
  parNom: {} as Record<string, any>,
  leads: [] as any[],
  leadsMuets: false,
}))

vi.mock('../lib/prospector/datagouv', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/datagouv')>()),
  lookupByName: async (name: string) =>
    etat.parNom[String(name).trim()] ?? { found: false, resolution: 'not_found' },
  lookupBySiren: async () => ({ found: false, resolution: 'not_found' }),
}))
vi.mock('../lib/supabase/leads', async (orig) => ({
  ...(await orig<typeof import('../lib/supabase/leads')>()),
  listLeadsStrict: async () => (etat.leadsMuets ? { ok: false } : { ok: true, leads: etat.leads }),
}))

import { compteDuCandidat } from '../pages/api/signals/promote'
import { registerCandidates, readCandidate } from '../lib/prospector/proactive/signalCandidates'
import {
  ENTITY_RESOLUTION_ADJUDICATION_KIND,
} from '../lib/prospector/proactive/entityResolution'
import type { SignalHit } from '../types/prospector'

const g: any = globalThis as any
const WS = 'ws_lead_gate'
const SIREN_A = '899270979'
const SIREN_B = '111222333'
const T0 = () => new Date('2026-09-02T10:00:00.000Z')

const hit = (company: string, siren?: string): SignalHit => ({
  company, signalType: 'levée', detail: '', icebreaker: '',
  sourceUrl: 'https://presse.exemple.fr/a', verified: false,
  claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: '2026-07-08',
  eventDatePrecision: 'DAY', sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
  ...(siren ? { siren } : {}),
  extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v3' },
} as SignalHit)

async function candidat(company = 'Defacto', siren?: string) {
  const [cid] = await registerCandidates([hit(company, siren)], WS, T0)
  const lu = await readCandidate(cid!, WS)
  if (lu.ok === false) throw new Error(lu.state)
  return lu.candidate
}
const leadPour = (siren: string, id = `lead_${siren}`) => ({
  id, kind: 'account', firstName: '', lastName: '', title: '', company: 'Defacto',
  score: 0, temperature: 'cold', status: 'froid', stage: 'to_invite',
  email: null, phone: null, siren,
})

beforeEach(() => {
  if (g.__prospectorStore) g.__prospectorStore.clear()
  etat.parNom = {}
  etat.leads = []
  etat.leadsMuets = false
})

describe('LEAD GATE — le vrai compteDuCandidat', () => {
  it('1 — entité RÉSOLUE + workspace SANS Lead : SIGNAL_NOT_RESOLVED (409) — la résolution seule ne suffit JAMAIS', async () => {
    const c = await candidat()
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    expect(await compteDuCandidat(c, WS)).toEqual({ ok: false, state: 'SIGNAL_NOT_RESOLVED', code: 409 })
  })

  it('2 — entité RÉSOLUE A + Lead siren=A : ok=true, LE lead exact, autorité d’entité portée', async () => {
    const c = await candidat()
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    etat.leads = [leadPour(SIREN_A)]
    const r = await compteDuCandidat(c, WS)
    if (r.ok === false) throw new Error(r.state)
    expect(r.lead.id).toBe(`lead_${SIREN_A}`)
    expect(r.lead.siren).toBe(SIREN_A)
    expect(r.entite.authority).toBe('AUTO_EXACT_REGISTRY')
  })

  it('3 — entité RÉSOLUE A + Lead siren=B seulement : SIGNAL_NOT_RESOLVED — jamais un rapprochement', async () => {
    const c = await candidat()
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    etat.leads = [leadPour(SIREN_B)]
    expect(await compteDuCandidat(c, WS)).toEqual({ ok: false, state: 'SIGNAL_NOT_RESOLVED', code: 409 })
  })

  it('4 — magasin de Leads muet : LEAD_STORE_UNAVAILABLE (503), distinct de « non résolu »', async () => {
    const c = await candidat()
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    etat.leadsMuets = true
    expect(await compteDuCandidat(c, WS)).toEqual({ ok: false, state: 'LEAD_STORE_UNAVAILABLE', code: 503 })
  })

  it('5 — entité NON RÉSOLUE (ambiguë) : SIGNAL_NOT_RESOLVED, même avec un Lead plausible présent', async () => {
    const c = await candidat()
    etat.parNom['Defacto'] = {
      found: false, resolution: 'ambiguous', ambiguous: true,
      candidates: [{ siren: SIREN_A, name: 'DEFACTO', city: 'PARIS', naf: '62.01Z' }],
    }
    etat.leads = [leadPour(SIREN_A)]
    expect(await compteDuCandidat(c, WS)).toEqual({ ok: false, state: 'SIGNAL_NOT_RESOLVED', code: 409 })
  })

  it('6 — conflit d’identité (candidateSiren ≠ officiel) : ENTITY_IDENTITY_CONFLICT (409)', async () => {
    const c = await candidat('Defacto', SIREN_B)
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    etat.leads = [leadPour(SIREN_A)]
    expect(await compteDuCandidat(c, WS)).toEqual({ ok: false, state: 'ENTITY_IDENTITY_CONFLICT', code: 409 })
  })

  it('7 — historique d’adjudication corrompu : ENTITY_RESOLUTION_HISTORY_TAMPERED (409), jamais un passage', async () => {
    const c = await candidat()
    // Ligne d'adjudication corrompue rattachée (lien brut) à une observation de
    // ce candidat — la dérivation échoue fermé (durcissement §3).
    g.__prospectorStore.set(`${ENTITY_RESOLUTION_ADJUDICATION_KIND}|${WS}|era_corrompue`, {
      id: 'era_corrompue', workspaceId: WS, observationId: 42, corrompu: true,
    })
    etat.parNom['Defacto'] = { found: true, resolution: 'resolved', siren: SIREN_A }
    etat.leads = [leadPour(SIREN_A)]
    expect(await compteDuCandidat(c, WS)).toEqual({ ok: false, state: 'ENTITY_RESOLUTION_HISTORY_TAMPERED', code: 409 })
  })
})
