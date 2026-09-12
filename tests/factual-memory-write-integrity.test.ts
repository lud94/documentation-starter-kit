// SIGNAL_ARCHITECTURE_V1 — INTÉGRITÉ D'ÉCRITURE DE LA MÉMOIRE FACTUELLE.
//
//   AUCUNE ANCRE CANONIQUE SANS AU MOINS UNE ASSERTION DE SOURCE DURABLE.
//
// ── LES DEUX DÉFAUTS QUE CES TESTS FERMENT ──────────────────────────────────
// 1. Les deux drapeaux étaient INDÉPENDANTS : `CANONICAL_FACTS` allumé pendant
//    que `SOURCE_ASSERTIONS` était éteint écrivait des ancres SANS aucune
//    assertion persistée — des faits dont l'appui n'était reconstructible
//    nulle part.
// 2. Les ancres étaient dérivées d'assertions construites EN MÉMOIRE, jamais
//    des assertions réellement écrites. Un échec du registre produisait donc
//    une ancre orpheline.
//
// ⚠️ CE QUI EST RÉELLEMENT EXERCÉ : le registre, la dérivation d'ancres et la
// couche de persistance sont le code de PRODUCTION. Le magasin n'est pas
// doublé — on emploie son repli mémoire.
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildCanonicalAnchors,
  recordCanonicalAnchors,
  CANONICAL_EVENT_KIND,
  CANONICAL_STATE_SNAPSHOT_KIND,
} from '../lib/prospector/proactive/canonicalFact'
import {
  buildSourceAssertions,
  recordSourceAssertions,
  SOURCE_ASSERTION_KIND,
  type AssertionBuildInput,
} from '../lib/prospector/proactive/sourceAssertion'
import { PROACTIVE_KIND_LIST } from '../lib/prospector/proactive/persistence'
import {
  promoteToEvidence,
  sourceEvidenceFromHit,
  type Grounding,
  type SourceEvidence,
} from '../lib/prospector/proactive/signalBridge'
import { listItems } from '../lib/supabase/store'
import type { SignalHit } from '../types/prospector'

const WS = 'ws_alpha'
const AUTRE_WS = 'ws_beta'
const COMPTE = 'acc_siren_552100554'
const CLE_LEVEE = `recent_funding|${COMPTE}|2026-08-12`
const ANCRE: Grounding = { kind: 'VERIFIED_ANCHOR', anchor: 'la cloture de sa Serie A de 12 millions' }

function levee(chemin: string): SourceEvidence {
  const s = sourceEvidenceFromHit({
    company: 'Acme', signalType: 'levée', detail: '', icebreaker: '',
    sourceUrl: `https://acme.fr${chemin}`, verified: false,
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    eventDate: '2026-08-12', eventDatePrecision: 'DAY',
    sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' },
  } as unknown as SignalHit, 'https://acme.fr', { kind: 'ORIGINAL' }, ANCRE,
    '2026-08-19T07:30:00.000Z')
  if (!s) throw new Error('fixture invalide')
  return s
}

function lot(chemins: string[], ws = WS): AssertionBuildInput {
  const sources = chemins.map(levee)
  const r = promoteToEvidence({
    accountId: COMPTE, observedAt: '2026-09-05T14:00:00.000Z', sources,
    confirmations: [{
      kind: 'HUMAN_CONFIRMED', canonicalKey: CLE_LEVEE, confirmedBy: 'actor_7f2c',
      confirmedAt: '2026-08-20T10:00:00.000Z', sourceUrls: sources.map((s) => s.url),
    }],
  })
  if (r.ok === false) throw new Error(`promotion refusée : ${r.reason}`)
  return {
    workspaceId: ws, accountId: COMPTE, canonicalClaimKey: r.canonicalKey,
    evidence: r.evidence, qualifyingSources: r.qualifyingSources,
  }
}

const lignes = (kind: string, ws = WS) => listItems<any>(kind, ws)

/**
 * REPRODUCTION FIDÈLE de l'ordre d'écriture de `promote.ts`.
 *
 * ⚠️ Le drapeau du registre COMMANDE. Les ancres ne sont dérivées que des
 * identifiants réellement confirmés en base, jamais des objets construits.
 */
async function ecrireMemoireFactuelle(
  lots: AssertionBuildInput[], ws: string,
  drapeaux: { assertions: boolean; canonical: boolean },
) {
  if (!drapeaux.assertions) return { durableIds: [] as string[], ancres: null }
  const bilan = await recordSourceAssertions(lots, ws)
  if (!drapeaux.canonical) return { durableIds: bilan.durableIds, ancres: null }
  const ancres = await recordCanonicalAnchors(lots, ws, new Set(bilan.durableIds))
  return { durableIds: bilan.durableIds, ancres }
}

beforeEach(() => {
  const magasin: Map<string, any> = (globalThis as any).__prospectorStore
  if (magasin) magasin.clear()
})

// ── MATRICE DES DRAPEAUX ────────────────────────────────────────────────────

describe('T1–T5 — matrice des drapeaux', () => {
  it('T1 — les deux ÉTEINTS ⇒ ni assertion, ni ancre', async () => {
    await ecrireMemoireFactuelle([lot(['/a'])], WS, { assertions: false, canonical: false })
    expect(await lignes(SOURCE_ASSERTION_KIND)).toHaveLength(0)
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(0)
  })

  it('T2 — registre ALLUMÉ, ancres ÉTEINTES ⇒ assertion oui, ancre non', async () => {
    await ecrireMemoireFactuelle([lot(['/a'])], WS, { assertions: true, canonical: false })
    expect(await lignes(SOURCE_ASSERTION_KIND)).toHaveLength(1)
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(0)
  })

  it('T3 — registre ÉTEINT, ancres ALLUMÉES ⇒ AUCUNE ancre écrite', async () => {
    // ⚠️ L'ÉTAT AUTREFOIS DANGEREUX. Les deux drapeaux étaient indépendants :
    // cette combinaison écrivait des ancres sans aucune assertion persistée.
    await ecrireMemoireFactuelle([lot(['/a'])], WS, { assertions: false, canonical: true })
    expect(await lignes(SOURCE_ASSERTION_KIND)).toHaveLength(0)
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(0)
  })

  it('T4 — les deux ALLUMÉS, assertion créée ⇒ ancre créée', async () => {
    const r = await ecrireMemoireFactuelle([lot(['/a'])], WS, { assertions: true, canonical: true })
    expect(r.durableIds).toHaveLength(1)
    expect(r.ancres).toEqual({ created: 1, existing: 0, failed: 0 })
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(1)
  })

  it('T5 — assertion DÉJÀ EXISTANTE ⇒ appui durable, ancre possible', async () => {
    // ⚠️ « EXISTE DÉJÀ » EST UN APPUI DURABLE, et se distingue d'une panne :
    // `saveSourceAssertion` relit la ligne, et une relecture en échec reste un
    // échec — jamais un faux succès.
    const l = [lot(['/a'])]
    await ecrireMemoireFactuelle(l, WS, { assertions: true, canonical: false })
    const r = await ecrireMemoireFactuelle(l, WS, { assertions: true, canonical: true })
    expect(r.durableIds).toHaveLength(1)
    expect(r.ancres!.created).toBe(1)
    expect(await lignes(SOURCE_ASSERTION_KIND)).toHaveLength(1)
  })
})

// ── DÉPENDANCE À LA DURABILITÉ ──────────────────────────────────────────────

describe('T6–T7 — l’ancre exige un appui DURABLE', () => {
  it('T6 — aucune assertion durable ⇒ AUCUNE ancre (orpheline impossible)', () => {
    // Simule l'échec de persistance du registre : les objets existent en
    // mémoire, aucun n'est confirmé en base.
    const l = lot(['/a'])
    expect(buildCanonicalAnchors({ ...l, durableAssertionIds: new Set() }).event).toBeNull()
    // Et un identifiant ÉTRANGER ne soutient rien non plus.
    expect(buildCanonicalAnchors({ ...l, durableAssertionIds: new Set(['sa_inconnue']) }).event)
      .toBeNull()
  })

  it('T7 — A et C durables, B en échec ⇒ ancre possible, A/C intactes', async () => {
    const l = lot(['/a', '/b', '/c'])
    const toutes = buildSourceAssertions(l).map((a) => a.id)
    expect(toutes).toHaveLength(3)

    // B n'est PAS compté comme persisté.
    const durables = toutes.filter((_, i) => i !== 1)
    const ancres = buildCanonicalAnchors({ ...l, durableAssertionIds: new Set(durables) })
    // ⚠️ UNE SEULE ASSERTION DURABLE SUFFIT : l'ancre IDENTIFIE le fait, elle
    // n'agrège pas ses appuis.
    expect(ancres.event).not.toBeNull()

    // Écriture réelle des deux survivantes : aucune suppression, aucune fusion.
    const bilan = await recordSourceAssertions([l], WS)
    expect(bilan.durableIds).toHaveLength(3)
    expect(await lignes(SOURCE_ASSERTION_KIND)).toHaveLength(3)
  })
})

// ── ÉCHEC D'ANCRAGE ─────────────────────────────────────────────────────────

describe('T8–T9 — l’échec d’ancrage ne détruit rien et se rejoue', () => {
  it('T8 — assertion durable, ancre non écrite ⇒ l’assertion SURVIT', async () => {
    const l = [lot(['/a'])]
    const bilan = await recordSourceAssertions(l, WS)
    // On n'écrit PAS l'ancre (panne simulée par omission).
    expect(await lignes(SOURCE_ASSERTION_KIND)).toHaveLength(1)
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(0)
    // ⚠️ AUCUN ROLLBACK, AUCUNE SUPPRESSION. Le registre est l'histoire ;
    // l'ancre n'en est qu'une projection, et une projection manquante ne
    // remet pas l'histoire en cause.
    expect(bilan.durableIds).toHaveLength(1)
  })

  it('T8b — AUCUN chemin de suppression n’existe dans la mémoire factuelle', () => {
    // ⚠️ PROPRIÉTÉ STRUCTURELLE, PAS COMPORTEMENTALE. « L'échec d'ancrage ne
    // supprime pas l'assertion » n'est pas testable par un scénario : il
    // n'existe AUCUN code de suppression à déclencher. On verrouille donc
    // l'absence — la seule forme de preuve disponible ici, et la plus forte :
    // un futur `deleteItem` dans ces modules casse la CI.
    for (const f of ['sourceAssertion.ts', 'canonicalFact.ts']) {
      const code = readFileSync(
        new URL(`../lib/prospector/proactive/${f}`, import.meta.url), 'utf8')
      const sansCommentaires = code.split('\n')
        .filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n')
      expect(sansCommentaires).not.toMatch(/deleteItem|deleteExpired|claimItem/)
      expect(sansCommentaires).not.toMatch(/upsertItem/)
    }
  })

  it('T9 — rejeu après échec d’ancrage ⇒ MÊME identité d’ancre', async () => {
    // ⚠️ C'EST CE QUI REND L'ÉCHEC RATTRAPABLE. L'identité de l'ancre est
    // entièrement déterminée par des champs stables (compte, jour) : un rejeu
    // ultérieur recrée exactement le même document, sans doublon.
    const l = [lot(['/a'])]
    const b1 = await recordSourceAssertions(l, WS)
    const avant = buildCanonicalAnchors({ ...l[0], durableAssertionIds: new Set(b1.durableIds) })

    const b2 = await recordSourceAssertions(l, WS)   // rejeu : « existe déjà »
    const apres = buildCanonicalAnchors({ ...l[0], durableAssertionIds: new Set(b2.durableIds) })

    expect(apres.event!.id).toBe(avant.event!.id)
    expect(apres.event).toEqual(avant.event)

    await recordCanonicalAnchors(l, WS, new Set(b2.durableIds))
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(1)
  })
})

// ── SÛRETÉ INCHANGÉE ────────────────────────────────────────────────────────

describe('T10–T12 — aucune régression de sûreté', () => {
  it('T10 — aucun `kind` de mémoire factuelle n’est exposé au navigateur', () => {
    for (const k of [SOURCE_ASSERTION_KIND, CANONICAL_EVENT_KIND, CANONICAL_STATE_SNAPSHOT_KIND]) {
      expect(PROACTIVE_KIND_LIST).not.toContain(k as any)
    }
  })

  it('T11 — le cloisonnement est intact : rien n’est écrit dans l’autre espace', async () => {
    await ecrireMemoireFactuelle([lot(['/a'])], WS, { assertions: true, canonical: true })
    expect(await lignes(SOURCE_ASSERTION_KIND, AUTRE_WS)).toHaveLength(0)
    expect(await lignes(CANONICAL_EVENT_KIND, AUTRE_WS)).toHaveLength(0)
  })

  it('T11b — des identifiants durables d’un AUTRE espace ne soutiennent rien', () => {
    // Les identifiants incluent l'espace dans leur condensat : ceux de B ne
    // peuvent pas servir d'appui à une ancre de A.
    const a = lot(['/a'], WS)
    const idsAilleurs = buildSourceAssertions(lot(['/a'], AUTRE_WS)).map((x) => x.id)
    expect(buildCanonicalAnchors({ ...a, durableAssertionIds: new Set(idsAilleurs) }).event)
      .toBeNull()
  })

  it('T12 — la route n’ancre jamais sans avoir d’abord écrit le registre', () => {
    const code = readFileSync(new URL('../pages/api/signals/promote.ts', import.meta.url), 'utf8')
    const bloc = code.slice(code.indexOf('async function journaliserAssertions'))
    // ⚠️ L'EXISTENCE AVANT L'ORDRE. Comparer deux `indexOf` ne suffit pas :
    // une garde ABSENTE rend `-1`, et `-1 < n` est vrai — le verrou passerait
    // sur le défaut même qu'il doit interdire.
    // SIGNAL_CANONICAL_GATE_V0_001 : le registre n'est plus facultatif — les
    // DEUX drapeaux sont exiges ENSEMBLE, AVANT toute ecriture, et un echec
    // d'ecriture BLOQUE (la route repond 503, jamais un succes sans histoire).
    const garde = bloc.indexOf('if (!sourceAssertionsEnabled() || !canonicalFactsEnabled())')
    const ecriture = bloc.indexOf('recordSourceAssertions(lots, ws)')
    expect(garde).toBeGreaterThanOrEqual(0)
    expect(ecriture).toBeGreaterThanOrEqual(0)
    expect(garde).toBeLessThan(ecriture)
    expect(bloc).toMatch(/recordCanonicalAnchors\(lots, ws, new Set\(bilan\.durableIds\)\)/)
    expect(bloc).toMatch(/reason: 'LEDGER_WRITE_FAILED'/)
  })
})
