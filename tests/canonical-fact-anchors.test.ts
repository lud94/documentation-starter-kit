// SIGNAL_ARCHITECTURE_V1_WAVE2 — ANCRES FACTUELLES CANONIQUES.
//
// ⚠️ CE QUI EST RÉELLEMENT EXERCÉ. `buildCanonicalAnchors`, les fonctions
// d'identité, les gardes de forme, `buildSourceAssertions` ET la couche de
// persistance `lib/supabase/store` sont le code de PRODUCTION. Le magasin n'est
// PAS doublé : on emploie son repli mémoire, dont `insertItemIfAbsent` a la même
// sémantique « au plus un » que l'INSERT PostgreSQL — seul moyen de prouver que
// l'écriture est bien une INSERTION et non un remplacement.
//
// Aucun réseau. Aucune horloge système : tous les instants sont injectés.
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildCanonicalAnchors,
  canonicalEventId,
  canonicalFactsEnabled,
  canonicalSnapshotId,
  canonicalTypeFor,
  isCanonicalEvent,
  isCanonicalStateSnapshot,
  readCanonicalEvent,
  readCanonicalStateSnapshot,
  recordCanonicalAnchors,
  saveCanonicalEvent,
  saveCanonicalStateSnapshot,
  CANONICAL_EVENT_KIND,
  CANONICAL_STATE_SNAPSHOT_KIND,
} from '../lib/prospector/proactive/canonicalFact'
import { PROACTIVE_KIND_LIST } from '../lib/prospector/proactive/persistence'
import {
  promoteToEvidence,
  sourceEvidenceFromHit,
  type Grounding,
  type HumanFactConfirmation,
  type SourceEvidence,
} from '../lib/prospector/proactive/signalBridge'
import { listItems } from '../lib/supabase/store'
import type { SignalHit } from '../types/prospector'

const WS = 'ws_alpha'
const AUTRE_WS = 'ws_beta'
const COMPTE = 'acc_siren_552100554'
const JOUR_LEVEE = '2026-08-12'
const CLE_LEVEE = `recent_funding|${COMPTE}|${JOUR_LEVEE}`
const CLE_ETAT = `sales_hiring|${COMPTE}|STATE`
const CARRIERES = 'https://careers.acme.fr/jobs'

const ANCRE: Grounding = { kind: 'VERIFIED_ANCHOR', anchor: 'la cloture de sa Serie A de 12 millions' }

function confirme(sourceUrls: string[], cle: string): HumanFactConfirmation {
  return {
    kind: 'HUMAN_CONFIRMED', canonicalKey: cle, confirmedBy: 'actor_7f2c',
    confirmedAt: '2026-08-20T10:00:00.000Z', sourceUrls,
  }
}

/** Levée bouclée — source de grade A (site officiel déclaré au registre). */
function levee(o: { url?: string; retrievedAt?: string; hit?: Partial<SignalHit> } = {}): SourceEvidence {
  const url = o.url ?? 'https://acme.fr/presse/serie-a'
  const hit = {
    company: 'Acme', signalType: 'levée', detail: '', icebreaker: '',
    sourceUrl: url, verified: false,
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    eventDate: JOUR_LEVEE, eventDatePrecision: 'DAY',
    sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' },
    ...o.hit,
  } as unknown as SignalHit
  const s = sourceEvidenceFromHit(hit, 'https://acme.fr', { kind: 'ORIGINAL' }, ANCRE,
    'retrievedAt' in o ? o.retrievedAt : '2026-08-19T07:30:00.000Z')
  if (!s) throw new Error('fixture invalide')
  return s
}

/** Poste Sales ouvert — la seule revendication d'état promouvable. */
function etat(o: { url?: string; retrievedAt?: string } = {}): SourceEvidence {
  const url = o.url ?? CARRIERES
  const hit = {
    company: 'Acme', signalType: 'recrutement', detail: '', icebreaker: '',
    sourceUrl: url, verified: false,
    claimNature: 'STATE', eventStatus: 'UNKNOWN',
    eventDate: null, eventDatePrecision: 'UNKNOWN', sourcePublishedAt: null,
    roleStatus: 'OPEN', roleFunction: 'SALES',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' },
  } as unknown as SignalHit
  const s = sourceEvidenceFromHit(hit, 'https://careers.acme.fr', { kind: 'ORIGINAL' }, ANCRE,
    'retrievedAt' in o ? o.retrievedAt : '2026-09-01T06:00:00.000Z')
  if (!s) throw new Error('fixture invalide')
  return s
}

/** Promotion RÉELLE, puis dérivation des ancres. */
function ancres(sources: SourceEvidence[], cle: string, adjugeA = '2026-09-05T14:00:00.000Z', ws = WS) {
  const r = promoteToEvidence({
    accountId: COMPTE, observedAt: adjugeA, sources,
    confirmations: [confirme(sources.map((s) => s.url), cle)],
  })
  if (r.ok === false) throw new Error(`promotion refusée : ${r.reason}`)
  return {
    evidence: r.evidence,
    ...buildCanonicalAnchors({
      workspaceId: ws, accountId: COMPTE, canonicalClaimKey: r.canonicalKey,
      evidence: r.evidence, qualifyingSources: r.qualifyingSources,
    }),
  }
}

const lignes = (kind: string, ws = WS) => listItems<any>(kind, ws)

beforeEach(() => {
  // ⚠️ On VIDE la même `Map` : `lib/supabase/store` capture sa référence au
  // chargement du module, et la réaffecter laisserait l'état fuir d'un test
  // à l'autre.
  const magasin: Map<string, any> = (globalThis as any).__prospectorStore
  if (magasin) magasin.clear()
  delete process.env.SIGNAL_ARCH_V1_CANONICAL_FACTS
})

// ── CARTE D'AUTORITÉ ────────────────────────────────────────────────────────

describe('carte d’autorité — fermée, jamais heuristique', () => {
  it('mappe les deux seuls types réellement produits', () => {
    expect(canonicalTypeFor('recent_funding')).toBe('FUNDING_ROUND')
    expect(canonicalTypeFor('sales_hiring')).toBe('HIRING_SNAPSHOT')
  })

  it('refuse tout le reste — y compris ce qui « ressemble »', () => {
    // ⚠️ AUCUNE INFÉRENCE DEPUIS UNE CHAÎNE. Les types déclarés par les packs
    // mais produits par personne restent hors du chemin factuel.
    for (const t of [
      'new_sales_leader', 'headcount_acceleration', 'site_expansion', 'hiring_freeze',
      'recent_funding_round', 'funding', 'sales_hiring_v2', 'hot_lead', '', null, 42,
    ]) {
      expect(canonicalTypeFor(t as any)).toBeNull()
    }
  })

  it('ne se laisse pas atteindre par la chaîne de prototypes', () => {
    expect(canonicalTypeFor('toString')).toBeNull()
    expect(canonicalTypeFor('constructor')).toBeNull()
  })
})

// ── FUNDING ─────────────────────────────────────────────────────────────────

describe('F — ancre d’événement : le compte et le jour, rien d’autre', () => {
  it('F1 — rejeu de la même assertion ⇒ même ancre', () => {
    expect(ancres([levee()], CLE_LEVEE).event!.id).toBe(ancres([levee()], CLE_LEVEE).event!.id)
  })

  it('F2 — URL différentes, même levée ⇒ MÊME ancre', () => {
    // ⚠️ LE POINT CENTRAL. Deux documents distincts désignent UN fait du monde.
    // L'ancre les confond volontairement ; leurs assertions, elles, restent
    // distinctes dans le registre — c'est là que vit l'histoire des sources.
    const a = ancres([levee({ url: 'https://acme.fr/presse/a' })], CLE_LEVEE)
    const b = ancres([levee({ url: 'https://acme.fr/presse/b' })], CLE_LEVEE)
    expect(a.event!.id).toBe(b.event!.id)
  })

  it('F3 — création concurrente A/B ⇒ une seule ligne, même objet', async () => {
    const a = ancres([levee({ url: 'https://acme.fr/presse/a' })], CLE_LEVEE)
    const b = ancres([levee({ url: 'https://acme.fr/presse/b' })], CLE_LEVEE)
    const r = await Promise.all([
      saveCanonicalEvent(a.event!, WS), saveCanonicalEvent(b.event!, WS),
    ])
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(1)
    expect(r.filter((x) => x.ok === true && x.created)).toHaveLength(1)
    expect(r.filter((x) => x.ok === true && !x.created)).toHaveLength(1)
    // Aucune fusion n'était nécessaire : les deux documents sont identiques.
    expect(a.event).toEqual(b.event)
  })

  it('F4 — même compte, jour différent ⇒ ancres DIFFÉRENTES', () => {
    // Deux tours réels, deux faits. Aucune fenêtre de tolérance.
    const autre = ancres([levee({ hit: { eventDate: '2026-09-01' } })],
      `recent_funding|${COMPTE}|2026-09-01`)
    expect(autre.event!.id).not.toBe(ancres([levee()], CLE_LEVEE).event!.id)
  })

  it('F5 — `sourcePublishedAt` différente ⇒ MÊME ancre', () => {
    const a = ancres([levee()], CLE_LEVEE)
    const b = ancres([levee({ hit: { sourcePublishedAt: '2026-08-13' } })], CLE_LEVEE)
    expect(b.event!.id).toBe(a.event!.id)
  })

  it('F6 — `retrievedAt` différent ⇒ MÊME ancre', () => {
    const a = ancres([levee({ retrievedAt: '2026-08-19T07:30:00.000Z' })], CLE_LEVEE)
    const b = ancres([levee({ retrievedAt: '2026-11-30T22:00:00.000Z' })], CLE_LEVEE)
    expect(b.event!.id).toBe(a.event!.id)
  })

  it('F7 — `Evidence.observedAt` différent ⇒ MÊME ancre', () => {
    const a = ancres([levee()], CLE_LEVEE, '2026-09-05T14:00:00.000Z')
    const b = ancres([levee()], CLE_LEVEE, '2027-03-01T00:00:00.000Z')
    expect(b.event!.id).toBe(a.event!.id)
  })

  it('F8 — montant en prose différent ⇒ MÊME ancre', () => {
    // ⚠️ `amount` est de la prose produite par un modèle. L'y faire entrer
    // scinderait un fait unique sur une hallucination de formulation.
    const a = ancres([levee({ hit: { amount: '12 millions d’euros' } as any })], CLE_LEVEE)
    const b = ancres([levee({ hit: { amount: '€12M' } as any })], CLE_LEVEE)
    expect(b.event!.id).toBe(a.event!.id)
  })

  it('F9 — sans jour exact, AUCUNE ancre — et l’evidence reste valide', () => {
    // `mapClaim` refuse déjà une précision au mois ; on vérifie ici que la
    // frontière canonique ne fabrique rien à partir de ce qui la franchirait.
    const r = buildCanonicalAnchors({
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE_LEVEE,
      evidence: { ...ancres([levee()], CLE_LEVEE).evidence, occurredAt: '2026-02-30' } as any,
      qualifyingSources: [levee()],
    })
    expect(r.event).toBeNull()
    expect(r.snapshots).toEqual([])
  })

  it('un compte NON vérifié ne produit aucune ancre', () => {
    const base = ancres([levee()], CLE_LEVEE)
    for (const mauvais of ['acc_name_acme', 'acc_siren_12', '', 'acc_siren_abcdefghi']) {
      expect(buildCanonicalAnchors({
        workspaceId: WS, accountId: mauvais, canonicalClaimKey: CLE_LEVEE,
        evidence: base.evidence, qualifyingSources: [levee()],
      }).event).toBeNull()
    }
  })

  it('aucune assertion dérivable ⇒ aucune ancre', () => {
    // Une ancre sans appui reconstructible affirmerait un fait dont personne
    // ne peut retrouver la source.
    const base = ancres([levee()], CLE_LEVEE)
    expect(buildCanonicalAnchors({
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE_LEVEE,
      evidence: base.evidence, qualifyingSources: [],
    }).event).toBeNull()
  })

  it('l’ancre ne porte NI preuves, NI compteurs, NI statut mutable', () => {
    const e = ancres([levee()], CLE_LEVEE).event!
    expect(Object.keys(e).sort()).toEqual([
      'accountId', 'canonicalClaimKey', 'id', 'occurredAt', 'occurredAtPrecision',
      'type', 'workspaceId',
    ])
  })
})

// ── HIRING ──────────────────────────────────────────────────────────────────

describe('H — instantané d’état : un par jour d’observation de la source', () => {
  it('H1 — même source, même revendication, même jour ⇒ même instantané', () => {
    const a = ancres([etat()], CLE_ETAT)
    const b = ancres([etat()], CLE_ETAT)
    expect(a.snapshots).toHaveLength(1)
    expect(b.snapshots[0].id).toBe(a.snapshots[0].id)
  })

  it('H2 — URL différentes, même revendication et même jour ⇒ UN instantané', () => {
    // Deux pages observées le même jour attestent du MÊME état.
    const r = ancres([
      etat({ url: 'https://careers.acme.fr/jobs' }),
      etat({ url: 'https://careers.acme.fr/jobs?team=sales' }),
    ], CLE_ETAT)
    expect(r.snapshots).toHaveLength(1)
  })

  it('H3 — jour D1 vs D2 ⇒ instantanés DIFFÉRENTS', () => {
    const d1 = ancres([etat({ retrievedAt: '2026-09-01T06:00:00.000Z' })], CLE_ETAT)
    const d2 = ancres([etat({ retrievedAt: '2026-09-15T06:00:00.000Z' })], CLE_ETAT)
    expect(d2.snapshots[0].id).not.toBe(d1.snapshots[0].id)
    expect(d1.snapshots[0].stateObservedDay).toBe('2026-09-01')
    expect(d2.snapshots[0].stateObservedDay).toBe('2026-09-15')
  })

  it('H4 — `Evidence.observedAt` change ⇒ instantané INCHANGÉ', () => {
    // ⚠️ `observedAt` est l'instant d'ADJUDICATION. Une page relevée le 1er et
    // confirmée le 5 doit être ancrée au 1er : l'ancrer au 5 enregistrerait
    // l'état du monde sous une date où personne ne l'a observé.
    const a = ancres([etat()], CLE_ETAT, '2026-09-05T14:00:00.000Z')
    const b = ancres([etat()], CLE_ETAT, '2027-01-01T00:00:00.000Z')
    expect(b.snapshots[0].id).toBe(a.snapshots[0].id)
  })

  it('H5 — `retrievedAt` change de jour ⇒ instantané change', () => {
    const a = ancres([etat({ retrievedAt: '2026-09-01T23:30:00.000Z' })], CLE_ETAT)
    const b = ancres([etat({ retrievedAt: '2026-09-02T00:30:00.000Z' })], CLE_ETAT)
    expect(a.snapshots[0].stateObservedDay).toBe('2026-09-01')   // jour UTC
    expect(b.snapshots[0].stateObservedDay).toBe('2026-09-02')
    expect(b.snapshots[0].id).not.toBe(a.snapshots[0].id)
  })

  it('H6 — un instantané ne porte AUCUN `occurredAt`', () => {
    const s = ancres([etat()], CLE_ETAT).snapshots[0]
    expect('occurredAt' in s).toBe(false)
    expect(Object.keys(s).sort()).toEqual([
      'accountId', 'canonicalClaimKey', 'id', 'stateObservedDay', 'type', 'workspaceId',
    ])
    // Ni validité, ni supersession : la succession des jours EST l'historique.
    for (const champ of ['validFrom', 'validTo', 'supersededAt', 'supersededBy']) {
      expect(champ in s).toBe(false)
    }
  })

  it('H7 — l’instantané d’hier n’est JAMAIS muté par celui d’aujourd’hui', async () => {
    const d1 = ancres([etat({ retrievedAt: '2026-09-01T06:00:00.000Z' })], CLE_ETAT)
    await saveCanonicalStateSnapshot(d1.snapshots[0], WS)
    const d2 = ancres([etat({ retrievedAt: '2026-09-15T06:00:00.000Z' })], CLE_ETAT)
    await saveCanonicalStateSnapshot(d2.snapshots[0], WS)

    expect(await lignes(CANONICAL_STATE_SNAPSHOT_KIND)).toHaveLength(2)
    const relu = await readCanonicalStateSnapshot(d1.snapshots[0].id, WS)
    expect(relu.ok === true && relu.value?.stateObservedDay).toBe('2026-09-01')
  })

  it('`retrievedAt` absent ⇒ aucune assertion, donc aucun instantané', () => {
    expect(ancres([etat({ retrievedAt: undefined })], CLE_ETAT).snapshots).toEqual([])
  })

  it('une levée ne produit jamais d’instantané, un état jamais d’événement', () => {
    const f = ancres([levee()], CLE_LEVEE)
    const h = ancres([etat()], CLE_ETAT)
    expect(f.snapshots).toEqual([])
    expect(h.event).toBeNull()
  })
})

// ── GARDES DE FORME ─────────────────────────────────────────────────────────

describe('gardes de forme — l’identité est recalculable', () => {
  it('une ancre déplacée d’un fait vers un autre est refusée', () => {
    const e = ancres([levee()], CLE_LEVEE).event!
    expect(isCanonicalEvent(e)).toBe(true)
    expect(isCanonicalEvent({ ...e, occurredAt: '2026-09-01' })).toBe(false)
    expect(isCanonicalEvent({ ...e, accountId: 'acc_siren_999999999' })).toBe(false)
    expect(isCanonicalEvent({ ...e, workspaceId: AUTRE_WS })).toBe(false)
    expect(isCanonicalEvent({ ...e, occurredAtPrecision: 'MONTH' })).toBe(false)
    expect(isCanonicalEvent({ ...e, occurredAt: '2026-02-30' })).toBe(false)
  })

  it('un instantané déplacé de jour est refusé, et ne peut pas porter de survenue', () => {
    const s = ancres([etat()], CLE_ETAT).snapshots[0]
    expect(isCanonicalStateSnapshot(s)).toBe(true)
    expect(isCanonicalStateSnapshot({ ...s, stateObservedDay: '2026-09-02' })).toBe(false)
    expect(isCanonicalStateSnapshot({ ...s, canonicalClaimKey: 'autre' })).toBe(false)
    expect(isCanonicalStateSnapshot({ ...s, occurredAt: '2026-09-01' })).toBe(false)
  })
})

// ── SÉCURITÉ ────────────────────────────────────────────────────────────────

describe('S — les ancres sont SERVEUR, jamais exposées au navigateur', () => {
  it('S1/S2 — les `kind` canoniques sont hors de la liste blanche du magasin', () => {
    // ⚠️ GARDE DÉCISIVE. `pages/api/store/index.ts` bâtit sa liste blanche à
    // partir de `PROACTIVE_KIND_LIST` et y ouvre POST (upsert) et DELETE AU
    // NAVIGATEUR. Un fait canonique que son sujet peut réécrire ou effacer
    // n'ancre plus rien.
    expect(PROACTIVE_KIND_LIST).not.toContain(CANONICAL_EVENT_KIND as any)
    expect(PROACTIVE_KIND_LIST).not.toContain(CANONICAL_STATE_SNAPSHOT_KIND as any)
  })

  it('S2b — la route générique du magasin ne cite aucun `kind` canonique', () => {
    const code = readFileSync(new URL('../pages/api/store/index.ts', import.meta.url), 'utf8')
    expect(code).not.toMatch(/canonical/i)
  })

  it('S3 — une ancre de l’espace A ne peut pas être écrite ni lue dans B', async () => {
    const a = ancres([levee()], CLE_LEVEE, '2026-09-05T14:00:00.000Z', WS)
    expect(await saveCanonicalEvent(a.event!, AUTRE_WS)).toEqual({ ok: false, reason: 'invalid' })
    expect(await lignes(CANONICAL_EVENT_KIND, AUTRE_WS)).toHaveLength(0)

    await saveCanonicalEvent(a.event!, WS)
    const ailleurs = await readCanonicalEvent(a.event!.id, AUTRE_WS)
    expect(ailleurs.ok === true && ailleurs.value).toBeNull()
  })

  it('S3b — le même fait dans deux espaces ⇒ deux ancres indépendantes', () => {
    const a = ancres([levee()], CLE_LEVEE, '2026-09-05T14:00:00.000Z', WS)
    const b = ancres([levee()], CLE_LEVEE, '2026-09-05T14:00:00.000Z', AUTRE_WS)
    expect(a.event!.id).not.toBe(b.event!.id)
    expect(canonicalEventId(WS, COMPTE, JOUR_LEVEE))
      .not.toBe(canonicalEventId(AUTRE_WS, COMPTE, JOUR_LEVEE))
    expect(canonicalSnapshotId(WS, CLE_ETAT, '2026-09-01'))
      .not.toBe(canonicalSnapshotId(AUTRE_WS, CLE_ETAT, '2026-09-01'))
  })

  it('S4 — aucun accès direct au magasin hors de la couche cloisonnée', () => {
    // ⚠️ Toute écriture passe par `insertItemIfAbsent(kind, id, data, ws)` : le
    // `ws` est un paramètre OBLIGATOIRE de la primitive, il n'existe aucun
    // chemin non cloisonné. On verrouille l'absence d'`upsertItem`.
    const code = readFileSync(
      new URL('../lib/prospector/proactive/canonicalFact.ts', import.meta.url), 'utf8')
    const sansCommentaires = code.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n')
    expect(sansCommentaires).not.toMatch(/upsertItem/)
    expect(sansCommentaires).toMatch(/insertItemIfAbsent/)
  })
})

// ── ISOLATION DES PANNES ────────────────────────────────────────────────────

describe('I — drapeau et isolation', () => {
  it('I1 — drapeau absent ⇒ éteint ; seules `1`/`true` allument', () => {
    expect(canonicalFactsEnabled()).toBe(false)
    for (const v of ['', '  ', '0', 'false', 'oui', 'yes', 'on', 'enabled']) {
      process.env.SIGNAL_ARCH_V1_CANONICAL_FACTS = v
      expect(canonicalFactsEnabled()).toBe(false)
    }
    for (const v of ['1', 'true', 'TRUE', ' true ']) {
      process.env.SIGNAL_ARCH_V1_CANONICAL_FACTS = v
      expect(canonicalFactsEnabled()).toBe(true)
    }
  })

  it('I2 — identité canonique impossible ⇒ aucune écriture, rien ne casse', async () => {
    const base = ancres([levee()], CLE_LEVEE)
    const bilan = await recordCanonicalAnchors([{
      workspaceId: WS, accountId: 'acc_name_acme', canonicalClaimKey: CLE_LEVEE,
      evidence: base.evidence, qualifyingSources: [levee()],
    }], WS)
    expect(bilan).toEqual({ created: 0, existing: 0, failed: 0 })
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(0)
  })

  it('I3 — un lot vide est sans effet et sans erreur', async () => {
    expect(await recordCanonicalAnchors([], WS)).toEqual({ created: 0, existing: 0, failed: 0 })
  })

  it('le bilan ne contient aucun détail interne exploitable', async () => {
    const bilan = await recordCanonicalAnchors([], WS)
    expect(Object.keys(bilan).sort()).toEqual(['created', 'existing', 'failed'])
  })

  it('rejeu complet d’un lot ⇒ créé puis existant, une seule ligne', async () => {
    const base = ancres([levee()], CLE_LEVEE)
    const lot = [{
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE_LEVEE,
      evidence: base.evidence, qualifyingSources: [levee()],
    }]
    expect(await recordCanonicalAnchors(lot, WS)).toEqual({ created: 1, existing: 0, failed: 0 })
    expect(await recordCanonicalAnchors(lot, WS)).toEqual({ created: 0, existing: 1, failed: 0 })
    expect(await lignes(CANONICAL_EVENT_KIND)).toHaveLength(1)
  })
})
