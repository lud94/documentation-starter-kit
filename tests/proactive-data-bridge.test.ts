// JARVIS-PROACTIVE-01D — Data Bridge V0.
//
// Ce fichier éprouve surtout ce que le bridge REFUSE de produire. C'est
// l'essentiel : un moteur de décision nourri d'evidences fabriquées produit des
// recommandations fausses avec l'aplomb des vraies.
import { describe, it, expect } from 'vitest'
import type { Lead } from '../types/prospector'
import {
  BRIDGE_PROVIDER,
  CORROBORATED_STATE_CONFIDENCE,
  RECORD_STATE_CONFIDENCE,
  accountIdForLead,
  evidenceFromLeads,
  personIdForLead,
  type TaskSnapshot,
} from '../lib/prospector/proactive/dataBridge'

const NOW = new Date('2026-03-01T10:00:00.000Z')
const SNAPSHOT_COMPLET: TaskSnapshot = { complete: true, openTaskLeadIds: [] }
const SNAPSHOT_INCOMPLET: TaskSnapshot = { complete: false }

/** Lead minimal VALIDE : tous les champs obligatoires de `Lead`, rien de plus. */
function lead(patch: Partial<Lead> = {}): Lead {
  return {
    id: 'ld_1',
    firstName: 'Alice',
    lastName: 'Martin',
    title: 'VP Sales',
    company: 'Acme SAS',
    score: 70,
    temperature: 'warm',
    status: 'tiede',
    stage: 'connected',
    email: 'alice@acme.test',
    phone: null,
    ...patch,
  }
}

const types = (leads: Lead[], tasks: TaskSnapshot = SNAPSHOT_COMPLET) =>
  evidenceFromLeads(leads, { now: NOW, tasks }).map((e) => e.type).sort()

describe('A. Absence de donnée = absence d\'EvidenceEvent', () => {
  it('aucun lead ⇒ aucune evidence', () => {
    expect(evidenceFromLeads([], { now: NOW, tasks: SNAPSHOT_COMPLET })).toEqual([])
  })

  it('un lead sans siren NI nom d\'entreprise est ignoré — aucun compte inventé', () => {
    expect(accountIdForLead(lead({ company: '   ', siren: undefined }))).toBeNull()
    expect(evidenceFromLeads([lead({ company: '', temperature: 'hot' })], {
      now: NOW, tasks: SNAPSHOT_COMPLET,
    })).toEqual([])
  })

  it('une entrée non-objet est ignorée sans faire tomber le bridge', () => {
    const valide = lead({ temperature: 'hot' })
    const leads: any[] = [null, undefined, 'lead', 42, valide]
    // Le lead valide produit exactement ce qu'il produirait seul : les entrées
    // aberrantes n'ajoutent rien et n'en retirent rien.
    expect(types(leads)).toEqual(types([valide]))
    expect(types(leads)).toContain('hot_lead')
  })

  it('une horloge invalide ⇒ rien, plutôt qu\'une date de repli', () => {
    expect(evidenceFromLeads([lead({ temperature: 'hot' })], {
      now: new Date('pas-une-date'), tasks: SNAPSHOT_COMPLET,
    })).toEqual([])
  })
})

describe('B. AUCUNE evidence d\'événement n\'est fabriquée', () => {
  // Le signal est du TEXTE LIBRE : sa date, sa source et son type sont perdus à
  // l'import (`capabilities.ts` ne recopie que `detail` et `icebreaker`).
  const AVEC_SIGNAL = lead({
    signal: 'recrute un Head of Sales (cybersécurité) après une levée de 12M€',
    temperature: 'warm',
    status: 'tiede',
  })

  it('un signal de recrutement ne produit PAS de sales_hiring', () => {
    expect(types([AVEC_SIGNAL])).not.toContain('sales_hiring')
  })

  it('un signal de levée ne produit PAS de recent_funding', () => {
    expect(types([AVEC_SIGNAL])).not.toContain('recent_funding')
  })

  it('aucun des quatre types « accélération commerciale » n\'est jamais émis', () => {
    const emis = types([
      AVEC_SIGNAL,
      lead({ id: 'ld_2', signal: 'nouveau VP Sales nommé' }),
      lead({ id: 'ld_3', signal: 'effectifs +40% en six mois', effectif: '50 à 99' }),
    ])
    for (const interdit of [
      'recent_funding', 'sales_hiring', 'new_sales_leader', 'headcount_acceleration',
    ]) {
      expect(emis, `${interdit} ne doit jamais être fabriqué`).not.toContain(interdit)
    }
  })

  it('stage `responded` ne produit PAS positive_reply — une réponse n\'est pas un accord', () => {
    expect(types([lead({ stage: 'responded', temperature: 'warm', status: 'tiede' })]))
      .not.toContain('positive_reply')
  })

  it('aucun relationship_inactive : aucune date de dernier contact n\'est persistée', () => {
    expect(types([lead({ stage: 'in_sequence' })])).not.toContain('relationship_inactive')
  })
})

describe('C. hot_lead — mappage d\'un état réellement persisté', () => {
  it('température `hot` seule ⇒ evidence de confiance simple', () => {
    const [ev] = evidenceFromLeads([lead({ temperature: 'hot', status: 'tiede' })], {
      now: NOW, tasks: SNAPSHOT_INCOMPLET,
    })
    expect(ev.type).toBe('hot_lead')
    expect(ev.confidence).toBe(RECORD_STATE_CONFIDENCE)
    expect(ev.assertionType).toBe('fact')
    expect(ev.scope).toBe('relationship')
    expect(ev.source).toEqual({ provider: BRIDGE_PROVIDER, reference: 'ld_1' })
  })

  it('statut `chaud` seul suffit aussi', () => {
    const [ev] = evidenceFromLeads([lead({ temperature: 'warm', status: 'chaud' })], {
      now: NOW, tasks: SNAPSHOT_INCOMPLET,
    })
    expect(ev.type).toBe('hot_lead')
    expect(ev.confidence).toBe(RECORD_STATE_CONFIDENCE)
  })

  it('les DEUX champs concordent ⇒ corroboration réelle, confiance supérieure', () => {
    const [ev] = evidenceFromLeads([lead({ temperature: 'hot', status: 'chaud' })], {
      now: NOW, tasks: SNAPSHOT_INCOMPLET,
    })
    expect(ev.confidence).toBe(CORROBORATED_STATE_CONFIDENCE)
    expect(CORROBORATED_STATE_CONFIDENCE).toBeGreaterThan(RECORD_STATE_CONFIDENCE)
  })

  it('ni chaud ni hot ⇒ aucune evidence de chaleur', () => {
    expect(types([lead({ temperature: 'cold', status: 'froid' })]))
      .not.toContain('hot_lead')
  })

  it('une fiche de compte (sans personne) porte l\'intérêt au niveau COMPTE', () => {
    const [ev] = evidenceFromLeads(
      [lead({ kind: 'account', firstName: '', lastName: '', temperature: 'hot' })],
      { now: NOW, tasks: SNAPSHOT_INCOMPLET },
    )
    expect(ev.scope).toBe('account')
    expect(ev.personId).toBeUndefined()
  })
})

describe('D. no_next_step — l\'absence doit être PROUVÉE', () => {
  const engage = lead({ stage: 'in_sequence' })

  it('instantané COMPLET + aucune tâche ouverte ⇒ evidence', () => {
    expect(types([engage], { complete: true, openTaskLeadIds: [] }))
      .toContain('no_next_step')
  })

  // ⚠️ LE CAS CENTRAL DU LOT. Une lecture de tâches ratée rend `[]`, ce qui
  // ressemble trait pour trait à « aucune tâche ». Conclure l'absence de
  // prochaine étape reviendrait à recommander une relance sur une panne.
  it('instantané INCOMPLET ⇒ AUCUNE evidence d\'absence', () => {
    expect(types([engage], SNAPSHOT_INCOMPLET)).not.toContain('no_next_step')
  })

  it('une tâche ouverte sur ce lead ⇒ aucune evidence', () => {
    expect(types([engage], { complete: true, openTaskLeadIds: ['ld_1'] }))
      .not.toContain('no_next_step')
  })

  it('une tâche ouverte sur un AUTRE lead ne compte pas', () => {
    expect(types([engage], { complete: true, openTaskLeadIds: ['ld_999'] }))
      .toContain('no_next_step')
  })

  it('seules les étapes où un engagement est ATTENDU sont concernées', () => {
    const attendues = ['connected', 'in_sequence', 'responded']
    const hors = ['to_invite', 'invited', 'meeting', 'closed']

    for (const stage of attendues) {
      expect(types([lead({ stage: stage as any })]), stage).toContain('no_next_step')
    }
    for (const stage of hors) {
      expect(types([lead({ stage: stage as any })]), stage).not.toContain('no_next_step')
    }
  })

  it('une fiche de compte sans personne n\'a pas de relation à relancer', () => {
    expect(types([lead({ kind: 'account', firstName: '', lastName: '', stage: 'in_sequence' })]))
      .not.toContain('no_next_step')
  })
})

describe('E. missing_context — l\'absence EST le fait constaté', () => {
  const nu = lead({
    email: null, phone: null, linkedinUrl: undefined,
    summary: undefined, webProfile: undefined, researchNotes: undefined, signal: undefined,
    stage: 'to_invite',
  })

  it('ni canal ni contexte ⇒ evidence', () => {
    expect(types([nu])).toContain('missing_context')
  })

  it('un seul canal suffit à faire disparaître l\'evidence', () => {
    for (const canal of [{ email: 'a@b.test' }, { phone: '+33100000000' }, { linkedinUrl: 'https://x' }]) {
      expect(types([lead({ ...nu, ...canal })]), JSON.stringify(canal))
        .not.toContain('missing_context')
    }
  })

  it('un seul élément de contexte suffit aussi', () => {
    for (const ctx of [{ summary: 'ESN de 40 personnes' }, { webProfile: 'profil' }, { researchNotes: 'notes' }, { signal: 'recrute' }]) {
      expect(types([lead({ ...nu, ...ctx })]), JSON.stringify(ctx))
        .not.toContain('missing_context')
    }
  })
})

describe('F. Identifiants stables et déterministes', () => {
  it('le siren prime sur le nom', () => {
    expect(accountIdForLead(lead({ siren: '552100554' }))).toBe('acc_siren_552100554')
  })

  it('à défaut, le nom est normalisé de façon stable', () => {
    expect(accountIdForLead(lead({ company: 'Acme SAS' }))).toBe('acc_name_acme_sas')
    expect(accountIdForLead(lead({ company: '  ACME   sas  ' }))).toBe('acc_name_acme_sas')
  })

  it('la personne n\'existe que si la fiche en décrit une', () => {
    expect(personIdForLead(lead())).toBe('ld_1')
    expect(personIdForLead(lead({ kind: 'account' }))).toBeUndefined()
    expect(personIdForLead(lead({ firstName: '', lastName: '' }))).toBeUndefined()
  })

  it('deux exécutions produisent des identifiants IDENTIQUES', () => {
    const entree = [lead({ temperature: 'hot' }), lead({ id: 'ld_2', stage: 'responded' })]
    const a = evidenceFromLeads(entree, { now: NOW, tasks: SNAPSHOT_COMPLET })
    const b = evidenceFromLeads(entree, { now: NOW, tasks: SNAPSHOT_COMPLET })
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id))
    expect(a).toEqual(b)
  })

  it('l\'identifiant ne contient AUCUN horodatage — il resterait instable', () => {
    const plusTard = new Date('2026-06-01T00:00:00.000Z')
    const a = evidenceFromLeads([lead({ temperature: 'hot' })], { now: NOW, tasks: SNAPSHOT_COMPLET })
    const b = evidenceFromLeads([lead({ temperature: 'hot' })], { now: plusTard, tasks: SNAPSHOT_COMPLET })
    expect(a[0].id).toBe(b[0].id)
    // Seul le contenu se rafraîchit : la réécriture remplacera la même ligne.
    expect(b[0].observedAt).toBe(plusTard.toISOString())
  })
})

describe('G. Datation honnête', () => {
  it('les evidences d\'ÉTAT ne portent AUCUNE date de survenue', () => {
    const [ev] = evidenceFromLeads([lead({ temperature: 'hot' })], {
      now: NOW, tasks: SNAPSHOT_COMPLET,
    })
    // Seule l'observation est datée, parce qu'elle seule l'est réellement.
    expect(ev.observedAt).toBe(NOW.toISOString())
    expect(ev.occurredAt).toBeUndefined()
    expect(ev.temporality).toBe('undated_state')
  })

  it('aucune evidence ne porte de date de validité inventée', () => {
    const evidences = evidenceFromLeads(
      [lead({ temperature: 'hot', stage: 'in_sequence' })],
      { now: NOW, tasks: SNAPSHOT_COMPLET },
    )
    expect(evidences.length).toBeGreaterThan(0)
    for (const ev of evidences) {
      expect(ev.expiresAt).toBeUndefined()
      expect(ev.lastVerifiedAt).toBeUndefined()
    }
  })

  it('le bridge ne mute jamais les leads reçus', () => {
    const entree = lead({ temperature: 'hot' })
    const copie = JSON.parse(JSON.stringify(entree))
    evidenceFromLeads([entree], { now: NOW, tasks: SNAPSHOT_COMPLET })
    expect(entree).toEqual(copie)
  })
})
