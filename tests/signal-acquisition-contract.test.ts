// SIGNAL-ACQUISITION-CONTRACT-001 — CONTRAT SÉMANTIQUE DE L'ACQUISITION.
//
// ⚠️ CE QUI EST RÉELLEMENT TESTÉ ICI N'EST PAS « le parseur sait lire un JSON ».
// C'est la FRONTIÈRE : l'extraction a le droit de lire la source, le code
// déterministe n'a le droit de lire que des valeurs closes. Les tests les plus
// importants de ce fichier sont donc ceux qui vérifient qu'une prose évocatrice
// — « VP Sales », « plans to open » — ne FABRIQUE PAS de sémantique quand le
// champ structuré dit `UNKNOWN`. Un parseur qui « aiderait » en devinant
// réintroduirait exactement le jugement de langage que ce lot supprime.
import { describe, expect, it } from 'vitest'

import {
  PROMPT_VERSION,
  buildThesis,
  parseHits,
  semantiqueRequete,
  type SignalQuery,
} from '../lib/prospector/signals'
import type { SignalExtraction } from '../types/prospector'

const EXTRACTION: SignalExtraction = {
  mode: 'claude-web',
  promptVersion: PROMPT_VERSION,
  model: 'claude-sonnet-5',
}

/** Enveloppe minimale valide : sans `company` ni `sourceUrl`, tout est filtré. */
function reponse(...hits: Record<string, unknown>[]): string {
  return JSON.stringify({
    hits: hits.map((h) => ({
      company: 'Acme',
      sourceUrl: 'https://exemple.fr/a',
      ...h,
    })),
  })
}

function unSeul(...hits: Record<string, unknown>[]) {
  const r = parseHits(reponse(...hits), EXTRACTION)
  expect(r).toHaveLength(1)
  return r[0]
}

// ── NATURE : ÉVÉNEMENT vs ÉTAT ──────────────────────────────────────────────

describe('SIGNAL-ACQUISITION-CONTRACT-001 — nature de l’observation', () => {
  it('Série A bouclée → EVENT / COMPLETED', () => {
    const h = unSeul({
      signalType: 'levée',
      claimNature: 'EVENT',
      eventStatus: 'COMPLETED',
      eventDate: '2026-08-12',
      eventDatePrecision: 'DAY',
    })
    expect(h.claimNature).toBe('EVENT')
    expect(h.eventStatus).toBe('COMPLETED')
  })

  it('levée seulement annoncée → EVENT / ANNOUNCED_FUTURE', () => {
    const h = unSeul({ claimNature: 'EVENT', eventStatus: 'ANNOUNCED_FUTURE' })
    expect(h.eventStatus).toBe('ANNOUNCED_FUTURE')
  })

  it('ouverture de bureau réalisée → EVENT / COMPLETED', () => {
    const h = unSeul({ claimNature: 'EVENT', eventStatus: 'COMPLETED' })
    expect(h).toMatchObject({ claimNature: 'EVENT', eventStatus: 'COMPLETED' })
  })

  it('ouverture de bureau prévue → EVENT / ANNOUNCED_FUTURE', () => {
    const h = unSeul({ claimNature: 'EVENT', eventStatus: 'ANNOUNCED_FUTURE' })
    expect(h).toMatchObject({ claimNature: 'EVENT', eventStatus: 'ANNOUNCED_FUTURE' })
  })

  it('poste actuellement ouvert → STATE, sans date de survenue', () => {
    const h = unSeul({
      signalType: 'recrutement',
      claimNature: 'STATE',
      roleStatus: 'OPEN',
      roleFunction: 'SALES',
    })
    expect(h.claimNature).toBe('STATE')
    // Un état n'a pas de date de début connue : aucune n'est fabriquée.
    expect(h.eventDate).toBeNull()
    expect(h.eventDatePrecision).toBe('UNKNOWN')
  })

  it('un STATE conserve son eventDate quand la source en donne un', () => {
    // Le parseur ne CROISE pas nature et date : il normalise chaque champ pour
    // lui-même. Arbitrer entre les deux serait une inférence, et c'est le rôle
    // de l'adaptateur — pas de l'acquisition.
    const h = unSeul({
      claimNature: 'STATE',
      eventDate: '2026-08-12',
      eventDatePrecision: 'DAY',
    })
    expect(h.claimNature).toBe('STATE')
    expect(h.eventDate).toBe('2026-08-12')
  })
})

// ── POSTES ──────────────────────────────────────────────────────────────────

describe('SIGNAL-ACQUISITION-CONTRACT-001 — sémantique de poste', () => {
  it('Account Executive ouvert → OPEN / SALES', () => {
    const h = unSeul({ claimNature: 'STATE', roleStatus: 'OPEN', roleFunction: 'SALES' })
    expect(h).toMatchObject({ roleStatus: 'OPEN', roleFunction: 'SALES' })
  })

  it('Workplace Manager ouvert → OPEN / OFFICE_PEOPLE', () => {
    const h = unSeul({ claimNature: 'STATE', roleStatus: 'OPEN', roleFunction: 'OFFICE_PEOPLE' })
    expect(h).toMatchObject({ roleStatus: 'OPEN', roleFunction: 'OFFICE_PEOPLE' })
  })

  it('VP Sales nommé → EVENT / FILLED / SALES', () => {
    const h = unSeul({ claimNature: 'EVENT', roleStatus: 'FILLED', roleFunction: 'SALES' })
    expect(h).toMatchObject({ claimNature: 'EVENT', roleStatus: 'FILLED', roleFunction: 'SALES' })
  })

  it('CEO nommé → EVENT / FILLED / EXEC_OTHER, jamais SALES', () => {
    const h = unSeul({ claimNature: 'EVENT', roleStatus: 'FILLED', roleFunction: 'EXEC_OTHER' })
    expect(h.roleFunction).toBe('EXEC_OTHER')
    expect(h.roleFunction).not.toBe('SALES')
  })
})

// ── DATES ───────────────────────────────────────────────────────────────────

describe('SIGNAL-ACQUISITION-CONTRACT-001 — dates', () => {
  it('2026-08-12 / DAY → conservé au jour', () => {
    const h = unSeul({ eventDate: '2026-08-12', eventDatePrecision: 'DAY' })
    expect(h).toMatchObject({ eventDate: '2026-08-12', eventDatePrecision: 'DAY' })
  })

  it('2026-08 / MONTH → reste un mois, JAMAIS 2026-08-01', () => {
    const h = unSeul({ eventDate: '2026-08', eventDatePrecision: 'MONTH' })
    expect(h.eventDate).toBe('2026-08')
    expect(h.eventDatePrecision).toBe('MONTH')
    expect(h.eventDate).not.toBe('2026-08-01')
    expect(h.eventDate).not.toBe('2026-08-31')
  })

  it('précision DAY annoncée sur une valeur mensuelle → refus des DEUX', () => {
    // Contradiction, pas approximation : croire l'une des deux affirmations
    // serait deviner laquelle est fausse.
    const h = unSeul({ eventDate: '2026-08', eventDatePrecision: 'DAY' })
    expect(h.eventDate).toBeNull()
    expect(h.eventDatePrecision).toBe('UNKNOWN')
  })

  it('précision MONTH annoncée sur une valeur au jour → refus des DEUX', () => {
    const h = unSeul({ eventDate: '2026-08-12', eventDatePrecision: 'MONTH' })
    expect(h.eventDate).toBeNull()
    expect(h.eventDatePrecision).toBe('UNKNOWN')
  })

  it('jour inexistant au calendrier → UNKNOWN / null', () => {
    // ⚠️ RÉGRESSION `Date.parse` : `2026-02-30` y devient le 2 mars.
    for (const d of ['2026-02-30', '2026-13-01', '2026-08-32', '2026-00-10']) {
      const h = unSeul({ eventDate: d, eventDatePrecision: 'DAY' })
      expect(h.eventDate, d).toBeNull()
      expect(h.eventDatePrecision, d).toBe('UNKNOWN')
    }
  })

  it('année bissextile : 2028-02-29 valide, 2027-02-29 refusé', () => {
    expect(unSeul({ eventDate: '2028-02-29', eventDatePrecision: 'DAY' }).eventDate)
      .toBe('2028-02-29')
    expect(unSeul({ eventDate: '2027-02-29', eventDatePrecision: 'DAY' }).eventDate)
      .toBeNull()
  })

  it('format libre ou absurde → UNKNOWN / null', () => {
    for (const d of ['12/08/2026', 'août 2026', '2026', '', null, 42, {}]) {
      const h = unSeul({ eventDate: d, eventDatePrecision: 'DAY' })
      expect(h.eventDate).toBeNull()
      expect(h.eventDatePrecision).toBe('UNKNOWN')
    }
  })

  it('précision UNKNOWN → date toujours nulle, même si une valeur est fournie', () => {
    const h = unSeul({ eventDate: '2026-08-12', eventDatePrecision: 'UNKNOWN' })
    expect(h.eventDate).toBeNull()
  })

  it('date de publication distincte de la date de survenue', () => {
    const h = unSeul({
      eventDate: '2026-06-03',
      eventDatePrecision: 'DAY',
      sourcePublishedAt: '2026-08-12',
    })
    expect(h.eventDate).toBe('2026-06-03')
    expect(h.sourcePublishedAt).toBe('2026-08-12')
    expect(h.sourcePublishedAt).not.toBe(h.eventDate)
  })

  it('une publication seule ne devient JAMAIS une date de survenue', () => {
    const h = unSeul({ sourcePublishedAt: '2026-08-12' })
    expect(h.sourcePublishedAt).toBe('2026-08-12')
    expect(h.eventDate).toBeNull()
    expect(h.eventDatePrecision).toBe('UNKNOWN')
  })

  it('publication mensuelle ou invalide → null (jamais promue au jour)', () => {
    for (const d of ['2026-08', '2026-02-30', 'hier', null]) {
      expect(unSeul({ sourcePublishedAt: d }).sourcePublishedAt, String(d)).toBeNull()
    }
  })
})

// ── LE CŒUR DU LOT : AUCUNE SÉMANTIQUE FABRIQUÉE DEPUIS LA PROSE ────────────

describe('SIGNAL-ACQUISITION-CONTRACT-001 — la prose ne produit AUCUNE sémantique', () => {
  it('« VP Sales » dans detail/role ne fabrique pas roleFunction SALES', () => {
    const h = unSeul({
      detail: 'Acme nomme un nouveau VP Sales pour accélérer sa croissance commerciale.',
      role: 'VP Sales',
      roleFunction: 'UNKNOWN',
      roleStatus: 'UNKNOWN',
    })
    expect(h.roleFunction).toBe('UNKNOWN')
    expect(h.roleStatus).toBe('UNKNOWN')
  })

  it('« plans to open » dans detail ne fabrique pas ANNOUNCED_FUTURE', () => {
    const h = unSeul({
      detail: 'Acme plans to open a new office in Lyon next year.',
      eventStatus: 'UNKNOWN',
      claimNature: 'UNKNOWN',
    })
    expect(h.eventStatus).toBe('UNKNOWN')
    expect(h.claimNature).toBe('UNKNOWN')
  })

  it('« a bouclé sa Série A » ne fabrique pas COMPLETED', () => {
    const h = unSeul({
      detail: 'Acme a bouclé sa Série A de 12 M€ le 12 août 2026.',
      signalType: 'levée',
      amount: '12 M€',
      eventStatus: 'UNKNOWN',
    })
    expect(h.eventStatus).toBe('UNKNOWN')
  })

  it('le champ hérité `date` ne renseigne JAMAIS eventDate', () => {
    // C'est l'ambiguïté que ce lot refuse de trancher en silence.
    const h = unSeul({ date: '2026-08-12' })
    expect(h.date).toBe('2026-08-12')
    expect(h.eventDate).toBeNull()
    expect(h.sourcePublishedAt).toBeNull()
  })
})

// ── ABSENCE ET VALEURS HORS DOMAINE ─────────────────────────────────────────

describe('SIGNAL-ACQUISITION-CONTRACT-001 — l’absence est explicite', () => {
  it('aucun champ sémantique fourni → UNKNOWN explicites, jamais undefined', () => {
    const h = unSeul({})
    expect(h.claimNature).toBe('UNKNOWN')
    expect(h.eventStatus).toBe('UNKNOWN')
    expect(h.eventDatePrecision).toBe('UNKNOWN')
    expect(h.roleStatus).toBe('UNKNOWN')
    expect(h.roleFunction).toBe('UNKNOWN')
    expect(h.eventDate).toBeNull()
    expect(h.sourcePublishedAt).toBeNull()
    for (const cle of ['claimNature', 'eventStatus', 'eventDatePrecision', 'roleStatus', 'roleFunction'] as const) {
      expect(h[cle]).not.toBeUndefined()
    }
  })

  it('valeur hors domaine → UNKNOWN, jamais recopiée', () => {
    const h = unSeul({
      claimNature: 'PROBABLY_EVENT',
      eventStatus: 'completed',      // casse différente : refusée
      roleStatus: 'ouvert',
      roleFunction: 'COMMERCIAL',
    })
    expect(h.claimNature).toBe('UNKNOWN')
    expect(h.eventStatus).toBe('UNKNOWN')
    expect(h.roleStatus).toBe('UNKNOWN')
    expect(h.roleFunction).toBe('UNKNOWN')
  })

  it('valeur non textuelle → UNKNOWN', () => {
    const h = unSeul({ claimNature: 1, eventStatus: true, roleFunction: ['SALES'] })
    expect(h).toMatchObject({
      claimNature: 'UNKNOWN', eventStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    })
  })
})

// ── PROVENANCE D'EXTRACTION ─────────────────────────────────────────────────

describe('SIGNAL-ACQUISITION-CONTRACT-001 — provenance', () => {
  it('chaque hit porte la provenance de son extraction', () => {
    const h = unSeul({})
    expect(h.extraction).toEqual(EXTRACTION)
  })

  it('la provenance est COPIÉE, jamais partagée entre deux hits', () => {
    const r = parseHits(reponse({ company: 'A' }, { company: 'B' }), EXTRACTION)
    expect(r).toHaveLength(2)
    expect(r[0].extraction).not.toBe(r[1].extraction)
    expect(r[0].extraction).not.toBe(EXTRACTION)
    expect(r[0].extraction).toEqual(r[1].extraction)
  })

  it('la version de prompt est celle publiée par le module', () => {
    expect(unSeul({}).extraction.promptVersion).toBe(PROMPT_VERSION)
  })
})

// ── COMPORTEMENT HISTORIQUE PRÉSERVÉ ────────────────────────────────────────

describe('SIGNAL-ACQUISITION-CONTRACT-001 — non-régression du parseur', () => {
  it('sans nom d’entreprise ou sans source, l’entrée est écartée', () => {
    expect(parseHits(JSON.stringify({ hits: [{ company: 'Acme' }] }), EXTRACTION)).toEqual([])
    expect(parseHits(JSON.stringify({ hits: [{ sourceUrl: 'https://x.fr' }] }), EXTRACTION)).toEqual([])
  })

  it('signalType hors domaine → « autre »', () => {
    expect(unSeul({ signalType: 'inconnu' }).signalType).toBe('autre')
    expect(unSeul({ signalType: 'levée' }).signalType).toBe('levée')
  })

  it('texte non JSON ou JSON illisible → aucun hit, aucune exception', () => {
    expect(parseHits('pas de json ici', EXTRACTION)).toEqual([])
    expect(parseHits('{ ceci nest pas du json }', EXTRACTION)).toEqual([])
    expect(parseHits('{}', EXTRACTION)).toEqual([])
  })

  it('les champs historiques restent inchangés', () => {
    const h = unSeul({
      detail: 'un fait', icebreaker: 'une accroche', sector: 'SaaS',
      city: 'Lyon', sourceName: 'Maddyness', amount: '12 M€', role: 'AE',
    })
    expect(h).toMatchObject({
      detail: 'un fait', icebreaker: 'une accroche', sector: 'SaaS',
      city: 'Lyon', sourceName: 'Maddyness', amount: '12 M€', role: 'AE',
      verified: false,
    })
  })
})

// ── R1a — IDENTITÉ DE CACHE ─────────────────────────────────────────────────
//
// ⚠️ CE QUI EST EN JEU N'EST PAS LE COÛT D'UN APPEL MANQUÉ. Une réponse produite
// par l'ANCIEN contrat, resservie et ÉTIQUETÉE de la version COURANTE, ferait
// mentir `extraction.promptVersion`. Un cache manqué se paie une fois ; une
// provenance fausse contamine tout ce qui s'appuiera dessus.

/** Identité fonctionnelle telle qu'elle est réellement passée à `cacheKey`. */
function identite(thesis: string, max: number, q?: SignalQuery): string {
  return semantiqueRequete(thesis, max, q).cacheParts.join(' ')
}

describe('SIGNAL-ACQUISITION-CONTRACT-001a — identité de cache', () => {
  it('la version du contrat fait PARTIE de l’identité', () => {
    expect(semantiqueRequete('thèse', 8).cacheParts).toContain(PROMPT_VERSION)
  })

  it('même thèse + même max + version DIFFÉRENTE → identités différentes', () => {
    // La bascule de version est simulée sans muter la constante : la partie
    // « version » est remplacée dans le vecteur produit.
    const actuel = semantiqueRequete('thèse', 8).cacheParts
    const futur = actuel.map((p) => (p === PROMPT_VERSION ? 'signal-acquisition-v99' : p))
    expect(futur.join(' ')).not.toBe(actuel.join(' '))
  })

  it('une clé HÉRITÉE ne peut pas correspondre au nouveau contrat', () => {
    // Forme exacte d'avant R1a : ni version de contrat, ni ciblage.
    const heritee = ['signal-web', 'thèse', '8', 'v3'].join(' ')
    expect(identite('thèse', 8)).not.toBe(heritee)
    expect(semantiqueRequete('thèse', 8).cacheParts).not.toContain('v3')
  })

  it('même thèse LIBRE + même max + q.types différents → identités différentes', () => {
    // ⚠️ LE CŒUR DU DÉFAUT. `buildThesis` rend la thèse libre telle quelle, sans
    // y refléter `q.types` : la thèse seule ne résume donc pas la requête.
    const libre: SignalQuery = { thesis: 'Scale-ups françaises', months: 6 }
    const a: SignalQuery = { ...libre, types: ['serie_a'] }
    const b: SignalQuery = { ...libre, types: ['recrutement_sales'] }

    const thesisA = buildThesis(a)
    const thesisB = buildThesis(b)
    expect(thesisA).toBe(thesisB)                                  // thèse identique…
    expect(identite(thesisA, 8, a)).not.toBe(identite(thesisB, 8, b)) // …identité, non.
  })

  it('les sources préférées entrent dans l’identité', () => {
    const presse: SignalQuery = { thesis: 'T', types: ['serie_a'] }
    const jobs: SignalQuery = { thesis: 'T', types: ['recrutement_tech'] }
    expect(semantiqueRequete('T', 8, presse).hint)
      .not.toBe(semantiqueRequete('T', 8, jobs).hint)
    expect(identite('T', 8, presse)).not.toBe(identite('T', 8, jobs))
  })

  it('requête sémantiquement identique → identité STRICTEMENT identique', () => {
    const q1: SignalQuery = { thesis: 'T', types: ['serie_a', 'seed'], months: 6 }
    const q2: SignalQuery = { thesis: 'T', types: ['serie_a', 'seed'], months: 6 }
    expect(identite('T', 8, q1)).toBe(identite('T', 8, q2))
    expect(identite('T', 8)).toBe(identite('T', 8))
  })

  it('thèse ou max différents → identités différentes', () => {
    expect(identite('A', 8)).not.toBe(identite('B', 8))
    expect(identite('A', 8)).not.toBe(identite('A', 9))
  })

  it('les chaînes de la clé sont CELLES du prompt, pas une seconde normalisation', () => {
    const q: SignalQuery = { thesis: 'T', types: ['serie_a'] }
    const { focus, hint, cacheParts } = semantiqueRequete('T', 8, q)
    expect(cacheParts).toContain(focus)
    expect(cacheParts).toContain(hint)
    expect(focus).not.toBe('')
    expect(hint).not.toBe('')
  })

  it('sans `q` du tout, les deux fragments sont vides', () => {
    const { focus, hint } = semantiqueRequete('T', 8)
    expect(focus).toBe('')
    expect(hint).toBe('')
  })

  it('`q` absent et `q` vide sont des requêtes DIFFÉRENTES, et la clé le dit', () => {
    // Comportement PRÉEXISTANT de `domainsFor` : sans type coché il rend TOUS
    // les domaines de référence, alors que `q` absent n'en rend aucun. Les deux
    // prompts diffèrent donc réellement — et c'est précisément ce que la clé
    // doit refléter. Les confondre resservirait une réponse produite avec une
    // autre consigne de sources.
    const vide = semantiqueRequete('T', 8, {} as SignalQuery)
    expect(vide.hint).not.toBe('')
    expect(identite('T', 8)).not.toBe(identite('T', 8, {} as SignalQuery))
  })
})
