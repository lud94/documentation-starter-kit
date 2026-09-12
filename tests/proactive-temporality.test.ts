import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'
// JARVIS-PROACTIVE-01D (red-team) — INCONNU N'EST PAS RÉCENT.
//
// ── LES DEUX DÉFAUTS ÉPROUVÉS ICI ───────────────────────────────────────────
// 1. UNE DATE INVENTÉE. `occurredAt` était obligatoire pour tous ; une donnée
//    d'ÉTAT non horodatée y recevait `now`, ce qui la rendait indiscernable d'un
//    événement survenu à l'instant. Le Situation Engine, qui lit la fraîcheur de
//    `occurredAt`, en tirait `urgency: 1` : une fiche « chaude » saisie il y a
//    dix-huit mois devenait aussi pressante qu'une levée de fonds du matin.
//
// 2. UN DÉFAUT PERMISSIF. Le marqueur de temporalité était optionnel, « absent
//    ⇒ dated_event ». Une ingestion qui oublie le champ voyait donc ses
//    evidences promues au rang de faits datés, porteuses d'urgence, sans que
//    personne ne l'ait décidé. Oublier de dire ce qu'on sait ne vaut pas
//    affirmation.
//
// Le contrat est désormais une union discriminée : la temporalité est
// obligatoire, et `undated_state` n'a PAS de `occurredAt` — le type l'interdit.
import { describe, it, expect } from 'vitest'
import type { Lead } from '../types/prospector'
import type { EvidenceEvent } from '../lib/prospector/proactive/types'
import { evaluateSituations } from '../lib/prospector/proactive/situationEngine'
import { evidenceFromLeads, type TaskSnapshot } from '../lib/prospector/proactive/dataBridge'
import { evaluate } from '../lib/prospector/proactive/orchestrator'

const NOW = new Date('2026-03-01T10:00:00.000Z')
const COMPLET: TaskSnapshot = { complete: true, openTaskLeadIds: [] }

const CONTEXTE = {
  now: NOW,
  accountId: 'acc_1',
  personId: 'p_1',
  lensId: 'sales-default',
      lensVersion: 'v0.1',
      relevance: 0.9,
}

/** Paire d'evidences suffisante pour produire `commercial_momentum_stalled`. */
function paire(
  temporality: 'dated_event' | 'undated_state',
  occurredAt = NOW.toISOString(),
): EvidenceEvent[] {
  const commun = {
    accountId: 'acc_1',
    personId: 'p_1',
    scope: 'relationship' as const,
    source: { provider: 'prospector_crm' },
    assertionType: 'fact' as const,
    confidence: 0.8,
    observedAt: NOW.toISOString(),
    // Un état non daté NE PORTE PAS de date de survenue : le type l'interdit.
    ...(temporality === 'dated_event'
      ? { temporality, occurredAt }
      : { temporality }),
  }
  return [
    { ...commun, id: 'ev_hot', type: 'hot_lead' },
    { ...commun, id: 'ev_next', type: 'no_next_step' },
  ] as EvidenceEvent[]
}

function lead(patch: Partial<Lead> = {}): Lead {
  return {
    id: 'ld_1', firstName: 'Alice', lastName: 'Martin', title: 'VP Sales',
    company: 'Acme SAS', siren: '552100554',
    score: 90, temperature: 'hot', status: 'chaud', stage: 'in_sequence',
    email: 'alice@acme.test', phone: null,
    ...patch,
  }
}

describe('A. Un état non daté ne reçoit AUCUNE fraîcheur artificielle', () => {
  it('même `occurredAt`, deux temporalités, deux urgences opposées', () => {
    // Le SEUL écart entre les deux appels est le marqueur de temporalité.
    const date = evaluateSituations(paire('dated_event'), CONTEXTE)
    const nonDate = evaluateSituations(paire('undated_state'), CONTEXTE)

    expect(date).toHaveLength(1)
    expect(nonDate).toHaveLength(1)

    // Un événement réellement survenu à l'instant : fraîcheur maximale, légitime.
    expect(date[0].urgency).toBe(1)

    // Le même horodatage, mais déclaré « date métier inconnue » : aucune urgence.
    expect(nonDate[0].urgency).toBe(0)
  })

  it('l\'urgence d\'un état non daté n\'est jamais maximale, quelle que soit la date d\'observation', () => {
    for (const observation of [
      NOW.toISOString(),
      '2026-02-28T10:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    ]) {
      const [situation] = evaluateSituations(paire('undated_state', observation), CONTEXTE)
      expect(situation.urgency, observation).toBe(0)
    }
  })

  it('la situation existe malgré tout : seule l\'urgence est retenue, pas la décision', () => {
    const [situation] = evaluateSituations(paire('undated_state'), CONTEXTE)
    expect(situation.type).toBe('commercial_momentum_stalled')
    // Confiance et pertinence restent pleinement calculées.
    expect(situation.confidence).toBe(0.8)
    expect(situation.relevance).toBe(0.9)
  })
})

describe('B. Une evidence réellement datée continue de porter l\'urgence', () => {
  it('un événement daté avec une date RÉCENTE conserve toute son urgence', () => {
    const [situation] = evaluateSituations(paire('dated_event'), CONTEXTE)
    expect(situation.urgency).toBe(1)
  })

  it('la fraîcheur reste dégressive selon l\'âge réel', () => {
    const cas: [string, number][] = [
      ['2026-02-25T10:00:00.000Z', 1],    // 4 jours
      ['2026-02-10T10:00:00.000Z', 0.8],  // 19 jours
      ['2025-12-20T10:00:00.000Z', 0.6],  // 71 jours
      ['2025-01-01T10:00:00.000Z', 0.4],  // > 90 jours
    ]
    for (const [occurredAt, attendu] of cas) {
      const [situation] = evaluateSituations(paire('dated_event', occurredAt), CONTEXTE)
      expect(situation.urgency, occurredAt).toBe(attendu)
    }
  })

  it('MÉLANGE : seule l\'evidence datée porte l\'urgence, l\'état non daté ne la gonfle pas', () => {
    // ⚠️ Le moteur ne retient qu'UNE evidence par type (la plus fiable, puis la
    // plus récemment observée). Pour un mélange qui a du sens, les deux
    // temporalités portent donc des types DIFFÉRENTS : l'état non daté sur
    // `hot_lead`, le fait daté — et ancien — sur `no_next_step`.
    const melange: EvidenceEvent[] = [
      paire('undated_state')[0], // hot_lead, date métier inconnue
      {
        id: 'ev_next_date_ancien',
        accountId: 'acc_1',
        personId: 'p_1',
        scope: 'relationship',
        type: 'no_next_step',
        source: { provider: 'externe' },
        assertionType: 'fact',
        confidence: 0.8,
        temporality: 'dated_event',
        occurredAt: '2025-01-01T10:00:00.000Z', // > 90 jours
        observedAt: NOW.toISOString(),
      },
    ]

    const [situation] = evaluateSituations(melange, CONTEXTE)
    // L'urgence vient du seul fait daté — donc ANCIEN — et non du « maintenant »
    // trompeur de l'état.
    expect(situation.urgency).toBe(0.4)
  })

  it('deux evidences du MÊME type : le non daté sélectionné n\'apporte aucune urgence', () => {
    // Cas limite à connaître : la sélection par type se fait sur la confiance,
    // pas sur la temporalité. Un état non daté plus « confiant » évince un fait
    // daté — et l'urgence tombe alors à 0. C'est fermé, jamais gonflé.
    const memeType: EvidenceEvent[] = [
      { ...paire('undated_state')[0], confidence: 0.9 },
      { ...paire('undated_state')[1] },
      {
        ...paire('dated_event', '2026-02-28T10:00:00.000Z')[0],
        id: 'ev_hot_date',
        confidence: 0.7,
      },
    ]
    const [situation] = evaluateSituations(memeType, CONTEXTE)
    expect(situation.urgency).toBe(0)
  })
})

describe('C. Le bridge marque TOUT ce qu\'il produit comme non daté', () => {
  it('chaque evidence issue d\'un lead porte `undated_state`', () => {
    const evidences = evidenceFromLeads(
      [lead(), lead({
        id: 'ld_2', firstName: '', lastName: '', kind: 'account',
        email: null, phone: null, linkedinUrl: undefined,
        summary: undefined, webProfile: undefined, researchNotes: undefined, signal: undefined,
      })],
      { now: NOW, tasks: COMPLET },
    )

    expect(evidences.length).toBeGreaterThan(0)
    for (const ev of evidences) {
      expect(ev.temporality, ev.type).toBe('undated_state')
      // AUCUNE date de survenue : c'est tout l'objet du correctif.
      expect(ev.occurredAt, ev.type).toBeUndefined()
      // Seule l'observation est datée, parce qu'elle seule l'est réellement.
      expect(ev.observedAt).toBe(NOW.toISOString())
    }
  })

  it('aucune evidence du bridge ne se déclare `dated_event`', () => {
    const evidences = evidenceFromLeads([lead(), lead({ id: 'ld_2', stage: 'responded' })], {
      now: NOW, tasks: COMPLET,
    })
    expect(evidences.some((e) => e.temporality === 'dated_event')).toBe(false)
  })
})

describe('D. Bout en bout : aucune urgence fabriquée ne remonte jusqu\'à la décision', () => {
  it('la situation issue de données Prospector a une urgence NULLE', () => {
    const out = evaluate({ leads: [lead()], now: NOW, tasks: COMPLET, businessContext: TEST_BUSINESS_CONTEXT })

    expect(out.situations).toHaveLength(1)
    expect(out.situations[0].urgency).toBe(0)
  })

  it('la priorité n\'est PAS gonflée par une fraîcheur inventée', () => {
    // Score 90 ⇒ relevance 0.9. Avant le correctif, urgency valait 1 et la
    // recommandation ressortait en priorité HAUTE sur la seule foi d'un état
    // dont personne ne connaît la date.
    const out = evaluate({ leads: [lead({ score: 90 })], now: NOW, tasks: COMPLET, businessContext: TEST_BUSINESS_CONTEXT })

    expect(out.recommendations).toHaveLength(1)
    expect(out.recommendations[0].priority).toBe('low')
    // La recommandation reste possible : c'est l'urgence qui manque, pas la
    // pertinence.
    expect(out.recommendations[0].decision).toBe('recommend')
    expect(out.recommendations[0].confidence).toBeGreaterThan(0)
  })

  it('la temporalité survit à l\'aller-retour de persistance', async () => {
    const { saveEvidence, readEvidence } = await import('../lib/prospector/proactive/persistence')
    const g = globalThis as any
    if (g.__prospectorStore) g.__prospectorStore.clear()

    const [ev] = evidenceFromLeads([lead()], { now: NOW, tasks: COMPLET })
    expect((await saveEvidence(ev, 'ws_alpha')).ok).toBe(true)

    const relue = await readEvidence(ev.id, 'ws_alpha')
    expect(relue.ok && relue.value?.temporality).toBe('undated_state')
  })

  it('une temporalité inconnue est REFUSÉE à l\'écriture', async () => {
    const { saveEvidence } = await import('../lib/prospector/proactive/persistence')
    const [ev] = evidenceFromLeads([lead()], { now: NOW, tasks: COMPLET })

    for (const temporality of ['recent', 'maybe', '', 42, null]) {
      const bancal: any = { ...ev, temporality }
      expect(await saveEvidence(bancal, 'ws_alpha'), String(temporality))
        .toEqual({ ok: false, reason: 'denied' })
    }
  })
})

describe('E. Le contrat temporel est STRICT — aucune valeur par défaut', () => {
  const base = {
    id: 'ev_x',
    accountId: 'acc_1',
    personId: 'p_1',
    scope: 'relationship' as const,
    type: 'hot_lead' as const,
    source: { provider: 'test' },
    assertionType: 'fact' as const,
    confidence: 0.8,
    observedAt: NOW.toISOString(),
  }

  it('temporalité ABSENTE ⇒ evidence inutilisable, jamais promue en `dated_event`', () => {
    const sansMarqueur: any = { ...base, occurredAt: NOW.toISOString() }
    const autre: any = { ...sansMarqueur, id: 'ev_y', type: 'no_next_step' }

    // Avec l'ancien défaut permissif, ces deux-là auraient produit une situation
    // à urgence maximale. Elles ne produisent plus rien du tout.
    expect(evaluateSituations([sansMarqueur, autre], CONTEXTE)).toEqual([])
  })

  it('temporalité INCONNUE ⇒ refus, pas d\'interprétation au mieux', () => {
    for (const temporality of ['recent', 'maybe', '', null, 42]) {
      const a: any = { ...base, temporality, occurredAt: NOW.toISOString() }
      const b: any = { ...a, id: 'ev_y', type: 'no_next_step' }
      expect(evaluateSituations([a, b], CONTEXTE), String(temporality)).toEqual([])
    }
  })

  it('`dated_event` SANS occurredAt ⇒ inutilisable (contradiction dans les termes)', () => {
    const a: any = { ...base, temporality: 'dated_event' }
    const b: any = { ...a, id: 'ev_y', type: 'no_next_step' }
    expect(evaluateSituations([a, b], CONTEXTE)).toEqual([])
  })

  it('`dated_event` avec une occurredAt INVALIDE ⇒ inutilisable', () => {
    const a: any = { ...base, temporality: 'dated_event', occurredAt: 'pas-une-date' }
    const b: any = { ...a, id: 'ev_y', type: 'no_next_step' }
    expect(evaluateSituations([a, b], CONTEXTE)).toEqual([])
  })

  it('`undated_state` n\'a BESOIN d\'aucun occurredAt pour être exploitable', () => {
    const a: any = { ...base, temporality: 'undated_state' }
    const b: any = { ...a, id: 'ev_y', type: 'no_next_step' }

    const [situation] = evaluateSituations([a, b], CONTEXTE)
    expect(situation.type).toBe('commercial_momentum_stalled')
    expect(situation.urgency).toBe(0)
  })

  it('la persistance refuse toute temporalité absente, inconnue ou contradictoire', async () => {
    const { saveEvidence, listEvidence } = await import('../lib/prospector/proactive/persistence')
    const g = globalThis as any
    if (g.__prospectorStore) g.__prospectorStore.clear()

    const refus: any[] = [
      { ...base, occurredAt: NOW.toISOString() },                       // marqueur absent
      { ...base, temporality: 'recent', occurredAt: NOW.toISOString() },// marqueur inconnu
      { ...base, temporality: 'dated_event' },                          // daté sans date
      { ...base, temporality: 'dated_event', occurredAt: 'nawak' },     // date invalide
      { ...base, temporality: 'undated_state', occurredAt: NOW.toISOString() }, // état daté
    ]
    for (const item of refus) {
      expect(await saveEvidence(item, 'ws_alpha'), JSON.stringify(item.temporality))
        .toEqual({ ok: false, reason: 'denied' })
    }
    // Rien n'a été écrit : aucune de ces formes n'a été « réparée ».
    expect(await listEvidence('ws_alpha')).toEqual([])

    // Les deux formes légitimes, elles, passent.
    expect((await saveEvidence({ ...base, temporality: 'undated_state' } as any, 'ws_alpha')).ok).toBe(true)
    expect((await saveEvidence({
      ...base, id: 'ev_date', temporality: 'dated_event', occurredAt: NOW.toISOString(),
    } as any, 'ws_alpha')).ok).toBe(true)
  })
})
