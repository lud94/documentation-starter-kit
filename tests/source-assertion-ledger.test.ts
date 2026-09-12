// SIGNAL_ARCHITECTURE_V1 — LE REGISTRE DES ASSERTIONS DE SOURCE.
//
// ⚠️ CE QUI EST RÉELLEMENT EXERCÉ. `normalizeSourceUrl`, `sourceAssertionId`,
// `buildSourceAssertions`, `saveSourceAssertion` ET la couche de persistance
// `lib/supabase/store` sont le code de PRODUCTION. Le magasin n'est PAS doublé :
// on emploie son repli mémoire, dont `insertItemIfAbsent` a exactement la même
// sémantique « au plus un » que l'INSERT PostgreSQL — c'est la seule façon de
// prouver que l'écriture est bien une INSERTION et non un remplacement.
//
// Aucun réseau. Aucune horloge système : `observedAt` est injecté.
import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildSourceAssertions,
  isSourceAssertion,
  normalizeSourceUrl,
  readSourceAssertion,
  saveSourceAssertion,
  sourceAssertionId,
  sourceAssertionsEnabled,
  SOURCE_ASSERTION_KIND,
} from '../lib/prospector/proactive/sourceAssertion'
import { PROACTIVE_KIND_LIST } from '../lib/prospector/proactive/persistence'
import {
  bridgeSignals,
  promoteToEvidence,
  sourceEvidenceFromHit,
  type Grounding,
  type HumanFactConfirmation,
  type SourceEvidence,
  type SourceLineage,
} from '../lib/prospector/proactive/signalBridge'
import { readFileSync } from 'node:fs'

import { listItems } from '../lib/supabase/store'
import type { SignalHit } from '../types/prospector'

const WS = 'ws_alpha'
const AUTRE_WS = 'ws_beta'
const COMPTE = 'acc_siren_552100554'
const OBSERVED = '2026-08-20T09:00:00.000Z'
const RECUPERE = '2026-08-19T07:30:00.000Z'
const CLE_LEVEE = `recent_funding|${COMPTE}|2026-08-12`
const AUTRE_CLE = `recent_funding|${COMPTE}|2026-09-01`

const ANCRE: Grounding = { kind: 'VERIFIED_ANCHOR', anchor: 'la cloture de sa Serie A de 12 millions' }

function leveeBouclee(url: string, p: Partial<SignalHit> = {}): SignalHit {
  return {
    company: 'Acme', signalType: 'levée', detail: '', icebreaker: '',
    sourceUrl: url, verified: false,
    claimNature: 'EVENT', eventStatus: 'COMPLETED',
    eventDate: '2026-08-12', eventDatePrecision: 'DAY',
    sourcePublishedAt: null, roleStatus: 'UNKNOWN', roleFunction: 'UNKNOWN',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' },
    ...p,
  } as SignalHit
}

function source(
  url: string,
  o: { site?: string | null; lineage?: SourceLineage; grounding?: Grounding
       retrievedAt?: string; hit?: Partial<SignalHit> } = {},
): SourceEvidence {
  const s = sourceEvidenceFromHit(
    leveeBouclee(url, o.hit), o.site ?? null,
    o.lineage ?? { kind: 'ORIGINAL' }, o.grounding ?? ANCRE,
    'retrievedAt' in o ? o.retrievedAt : RECUPERE,
  )
  if (!s) throw new Error('fixture invalide')
  return s
}

/**
 * Source de grade A — le site officiel déclaré au registre.
 *
 * ⚠️ POURQUOI LA PLUPART DES CAS L'EMPLOIENT. `qualifyingSources` n'admet une
 * source B qu'à DEUX éditeurs indépendants au moins : un article de presse seul
 * ne qualifie pas, et une fixture mono-source en grade B mesurerait le refus de
 * la politique au lieu du registre. Deux documents A distincts du même site
 * qualifient chacun — ce qui donne au passage le cas le plus dur pour
 * l'identité : MÊME éditeur, MÊME evidence, documents DIFFÉRENTS.
 */
function sourceA(chemin = '/presse/serie-a'): SourceEvidence {
  return source(`https://acme.fr${chemin}`, { site: 'https://acme.fr' })
}

/** Paire d'éditeurs indépendants — le seul chemin qualifiant en grade B. */
function paireB(o: Parameters<typeof source>[1] = {}): SourceEvidence[] {
  return [source('https://maddyness.com/a', o), source('https://sifted.eu/b', o)]
}

function confirme(sourceUrls: string[], cle = CLE_LEVEE): HumanFactConfirmation {
  return {
    kind: 'HUMAN_CONFIRMED', canonicalKey: cle, confirmedBy: 'actor_7f2c',
    confirmedAt: '2026-08-20T10:00:00.000Z', sourceUrls,
  }
}

/** Promotion RÉELLE, puis assertions dérivées de ses sources qualifiantes. */
function assertionsPour(sources: SourceEvidence[], ws = WS) {
  const r = promoteToEvidence({
    accountId: COMPTE, observedAt: OBSERVED, sources,
    confirmations: [confirme(sources.map((s) => s.url))],
  })
  if (r.ok === false) throw new Error(`promotion refusée : ${r.reason}`)
  return {
    evidence: r.evidence,
    assertions: buildSourceAssertions({
      workspaceId: ws, accountId: COMPTE, canonicalClaimKey: r.canonicalKey,
      evidence: r.evidence, qualifyingSources: r.qualifyingSources,
    }),
  }
}

beforeEach(() => {
  // ⚠️ ON VIDE LA MÊME `Map`, ON NE LA REMPLACE PAS. `lib/supabase/store` capture
  // sa référence au chargement du module : réaffecter le global laisserait le
  // magasin de production pointer sur l'ancienne, et l'état fuirait d'un test à
  // l'autre — trois lignes là où le test en attend une.
  const magasin: Map<string, any> = (globalThis as any).__prospectorStore
  if (magasin) magasin.clear()
  delete process.env.SIGNAL_ARCH_V1_SOURCE_ASSERTIONS
})

// ── IDENTITÉ ────────────────────────────────────────────────────────────────

describe('I — identité déterministe', () => {
  it('I1 — même URL + même revendication ⇒ même identifiant', () => {
    expect(sourceAssertionId(WS, CLE_LEVEE, 'https://a.fr/x'))
      .toBe(sourceAssertionId(WS, CLE_LEVEE, 'https://a.fr/x'))
  })

  it('I2 — URL différente, même revendication ⇒ identifiants DIFFÉRENTS', () => {
    expect(sourceAssertionId(WS, CLE_LEVEE, 'https://a.fr/x'))
      .not.toBe(sourceAssertionId(WS, CLE_LEVEE, 'https://b.fr/y'))
  })

  it('I3 — même URL, revendication différente ⇒ identifiants différents', () => {
    expect(sourceAssertionId(WS, CLE_LEVEE, 'https://a.fr/x'))
      .not.toBe(sourceAssertionId(WS, AUTRE_CLE, 'https://a.fr/x'))
  })

  it('I4 — MÊME Evidence.id, assertions DISTINCTES : le cœur du lot', () => {
    // ⚠️ LE TEST DÉCISIF. Deux articles de la même levée convergent
    // DÉLIBÉRÉMENT vers un seul `Evidence.id` — c'est ce que le Kernel exige.
    // Si l'identité d'une assertion dépendait de `evidenceId`, les deux
    // n'en feraient qu'une, et le registre ne conserverait rien.
    const { evidence, assertions } = assertionsPour(paireB())

    expect(assertions).toHaveLength(2)
    expect(assertions[0].evidenceId).toBe(evidence.id)
    expect(assertions[1].evidenceId).toBe(evidence.id)   // MÊME evidence
    expect(assertions[0].id).not.toBe(assertions[1].id)  // assertions DISTINCTES
  })

  it('I5 — espaces distincts ⇒ identifiants distincts', () => {
    expect(sourceAssertionId(WS, CLE_LEVEE, 'https://a.fr/x'))
      .not.toBe(sourceAssertionId(AUTRE_WS, CLE_LEVEE, 'https://a.fr/x'))
  })

  it('une assertion dont l’identifiant ne correspond plus au contenu est refusée', () => {
    const { assertions } = assertionsPour([sourceA()])
    expect(isSourceAssertion(assertions[0])).toBe(true)
    // Mutée d'une revendication vers une autre en gardant son identifiant.
    expect(isSourceAssertion({ ...assertions[0], canonicalClaimKey: AUTRE_CLE })).toBe(false)
    expect(isSourceAssertion({ ...assertions[0], sourceUrl: 'https://autre.fr/z' })).toBe(false)
    expect(isSourceAssertion({ ...assertions[0], workspaceId: AUTRE_WS })).toBe(false)
  })
})

// ── NORMALISATION D'URL ─────────────────────────────────────────────────────

describe('normalisation d’URL — conservatrice', () => {
  it('minuscule le schéma et l’hôte, retire `www.` et le fragment', () => {
    expect(normalizeSourceUrl('HTTPS://WWW.Maddyness.com/a#intro'))
      .toBe('https://maddyness.com/a')
  })

  it('CONSERVE la query : deux documents adressés par query restent distincts', () => {
    expect(normalizeSourceUrl('https://a.fr/p?id=42')).toBe('https://a.fr/p?id=42')
    expect(normalizeSourceUrl('https://a.fr/p?id=42'))
      .not.toBe(normalizeSourceUrl('https://a.fr/p?id=43'))
  })

  it('CONSERVE le port non par défaut : deux serveurs restent distincts', () => {
    expect(normalizeSourceUrl('https://a.fr:8443/p')).toBe('https://a.fr:8443/p')
    expect(normalizeSourceUrl('https://a.fr:8443/p')).not.toBe(normalizeSourceUrl('https://a.fr/p'))
  })

  it('CONSERVE la barre finale : `/a` et `/a/` PEUVENT différer', () => {
    expect(normalizeSourceUrl('https://a.fr/x')).not.toBe(normalizeSourceUrl('https://a.fr/x/'))
  })

  it('n’applique AUCUNE équivalence agressive — `utm_*` est conservé', () => {
    // Dédoublement VISIBLE plutôt que fusion INVISIBLE : deux assertions.
    expect(normalizeSourceUrl('https://a.fr/p?utm_source=x')).toBe('https://a.fr/p?utm_source=x')
  })

  it('refuse ce qui n’est pas un document http(s)', () => {
    for (const v of ['', '   ', 'mailto:x@y.fr', 'javascript:alert(1)', '/relatif', 'a.fr/p', null, 42]) {
      expect(normalizeSourceUrl(v as any)).toBeNull()
    }
  })

  it('une source illisible ne produit AUCUNE assertion — jamais une inventée', () => {
    const s = sourceA()
    const casse = { ...s, url: 'pas-une-url' } as SourceEvidence
    const r = buildSourceAssertions({
      workspaceId: WS, accountId: COMPTE, canonicalClaimKey: CLE_LEVEE,
      evidence: assertionsPour([s]).evidence, qualifyingSources: [casse],
    })
    expect(r).toEqual([])
  })
})

// ── PROMOTION MULTI-SOURCES ─────────────────────────────────────────────────

describe('M — une assertion PAR source qualifiante', () => {
  it('M1 — une source qualifiante ⇒ une assertion', () => {
    expect(assertionsPour([sourceA()]).assertions).toHaveLength(1)
  })

  it('M2 — trois sources qualifiantes ⇒ trois assertions', () => {
    const trois = [...paireB(), source('https://frenchweb.fr/c')]
    expect(assertionsPour(trois).assertions).toHaveLength(3)
  })

  it('M3 — chaque assertion porte SA PROPRE provenance', () => {
    // ⚠️ Recopier la provenance de la principale sur les autres attribuerait à
    // un éditeur le grade et l'ancrage d'un autre : un mensonge d'audit.
    const a = source('https://maddyness.com/a')                     // ancrée, sans date
    const b = source('https://sifted.eu/b', {
      grounding: { kind: 'UNVERIFIABLE' },
      hit: { sourcePublishedAt: '2026-08-13' },
    })
    const { assertions } = assertionsPour([a, b])

    const parUrl = new Map(assertions.map((x) => [x.sourceUrl, x]))
    const pa = parUrl.get('https://maddyness.com/a')!.provenance
    const pb = parUrl.get('https://sifted.eu/b')!.provenance

    expect(pa.publisher).toBe('maddyness.com')
    expect(pa.grounding).toBe('VERIFIED_ANCHOR')
    expect('sourcePublishedAt' in pa).toBe(false)

    expect(pb.publisher).toBe('sifted.eu')
    expect(pb.grounding).toBe('UNVERIFIABLE')
    expect(pb.sourcePublishedAt).toBe('2026-08-13')
  })

  it('M4 — le choix de la source PRINCIPALE ne change pas le nombre d’assertions', () => {
    const [a, b] = paireB()
    const ordre1 = assertionsPour([a, b])
    const ordre2 = assertionsPour([b, a])
    expect(ordre1.assertions).toHaveLength(2)
    expect(ordre2.assertions).toHaveLength(2)
    // `evidence.source.url` ne décrit QU'UNE source ; le registre les a toutes.
    expect(ordre1.assertions.map((x) => x.id).sort())
      .toEqual(ordre2.assertions.map((x) => x.id).sort())
  })

  it('une source ÉCARTÉE par la politique ne produit aucune assertion', () => {
    // Un agrégateur (grade C) ne qualifie pas : l'inscrire au registre lui
    // donnerait l'apparence d'avoir porté la décision.
    const { assertions } = assertionsPour([sourceA(), source('https://news.google.com/x')])
    expect(assertions).toHaveLength(1)
    expect(assertions[0].sourceUrl).toBe('https://acme.fr/presse/serie-a')
  })

  it('le même document deux fois dans un lot ⇒ une seule assertion', () => {
    const { assertions } = assertionsPour([
      source('https://maddyness.com/a'),
      source('https://WWW.maddyness.com/a'),
      source('https://sifted.eu/b'),
    ])
    expect(assertions).toHaveLength(2)   // le `www.` ne fabrique pas un 2e document
  })
})

// ── PERSISTANCE : AJOUT SEUL ────────────────────────────────────────────────

async function lignes(ws = WS) {
  return (await listItems<any>(SOURCE_ASSERTION_KIND, ws))
}

describe('S/C — ajout seul, séquentiel et concurrent', () => {
  it('S1 — A puis B plus tard : DEUX lignes, A survit', async () => {
    const { assertions: aa } = assertionsPour([sourceA('/presse/a')])
    expect((await saveSourceAssertion(aa[0], WS))).toEqual({ ok: true, created: true })

    // Seconde adjudication, MÊME revendication canonique, autre document.
    const { assertions: bb } = assertionsPour([sourceA('/presse/b')])
    expect((await saveSourceAssertion(bb[0], WS))).toEqual({ ok: true, created: true })

    const toutes = await lignes()
    expect(toutes).toHaveLength(2)
    expect(toutes.map((x) => x.sourceUrl).sort())
      .toEqual(['https://acme.fr/presse/a', 'https://acme.fr/presse/b'])
  })

  it('S2 — l’Evidence peut être écrasée, les deux assertions restent lisibles', async () => {
    // ⚠️ CE TEST DIT UNE LIMITE, PAS UNE CORRECTION. L'agrégat Evidence est
    // TOUJOURS écrasé par une seconde adjudication — `EVIDENCE_PROVENANCE_
    // OVERWRITE_001` reste ouvert. Ce qui change, c'est que la matière source
    // ne disparaît plus avec lui.
    const { evidence: e1, assertions: aa } = assertionsPour([sourceA('/presse/a')])
    await saveSourceAssertion(aa[0], WS)
    const { evidence: e2, assertions: bb } = assertionsPour([sourceA('/presse/b')])
    await saveSourceAssertion(bb[0], WS)

    expect(e2.id).toBe(e1.id)                       // convergence canonique
    expect(e2.source.url).not.toBe(e1.source.url)   // la projection a bien bougé

    const relueA = await readSourceAssertion(aa[0].id, WS)
    const relueB = await readSourceAssertion(bb[0].id, WS)
    expect(relueA.ok === true && relueA.value?.sourceUrl).toBe('https://acme.fr/presse/a')
    expect(relueB.ok === true && relueB.value?.sourceUrl).toBe('https://acme.fr/presse/b')
  })

  it('C1 — A et B écrites CONCURREMMENT : aucune ne peut écraser l’autre', async () => {
    const { assertions: aa } = assertionsPour([sourceA('/presse/a')])
    const { assertions: bb } = assertionsPour([sourceA('/presse/b')])
    // Clés disjointes : l'entrelacement n'a aucune prise. C'est la FORME du
    // modèle qui l'assure, pas un verrou.
    await Promise.all([saveSourceAssertion(aa[0], WS), saveSourceAssertion(bb[0], WS)])
    expect(await lignes()).toHaveLength(2)
  })

  it('C2 — A et A concurrentes ⇒ UNE seule ligne, insertion idempotente', async () => {
    const { assertions } = assertionsPour([sourceA()])
    const r = await Promise.all([
      saveSourceAssertion(assertions[0], WS),
      saveSourceAssertion(assertions[0], WS),
    ])
    expect(await lignes()).toHaveLength(1)
    expect(r.filter((x) => x.ok === true && x.created)).toHaveLength(1)
    expect(r.filter((x) => x.ok === true && !x.created)).toHaveLength(1)
  })
})

// ── INSTANTANÉ : LE REJEU NE RÉÉCRIT PAS L'HISTOIRE ─────────────────────────

describe('P — instantané historique immuable', () => {
  /** Rejoue la MÊME assertion avec une qualification devenue différente. */
  async function rejouerAvec(modif: Partial<any>) {
    const { assertions } = assertionsPour([sourceA()])
    await saveSourceAssertion(assertions[0], WS)
    const rejeu = { ...assertions[0], provenance: { ...assertions[0].provenance, ...modif } }
    await saveSourceAssertion(rejeu, WS)
    const relue = await readSourceAssertion(assertions[0].id, WS)
    return relue.ok === true ? relue.value! : null
  }

  it('P1 — le grade d’origine survit à un rejeu sous une autre politique', async () => {
    expect((await rejouerAvec({ grade: 'C' }))!.provenance.grade).toBe('A')
  })

  it('P2 — la lignée d’origine survit', async () => {
    expect((await rejouerAvec({ lineage: 'UNKNOWN' }))!.provenance.lineage).toBe('ORIGINAL')
  })

  it('P3 — l’ancrage d’origine survit', async () => {
    expect((await rejouerAvec({ grounding: 'UNVERIFIABLE' }))!.provenance.grounding)
      .toBe('VERIFIED_ANCHOR')
  })

  it('P4 — `sourcePublishedAt` absente reste ABSENTE', () => {
    const { assertions } = assertionsPour([sourceA()])
    expect('sourcePublishedAt' in assertions[0].provenance).toBe(false)
  })

  it('P5 — `observedAt` ne se substitue JAMAIS à une date de publication', () => {
    const { assertions } = assertionsPour([sourceA()])
    expect(assertions[0].observedAt).toBe(OBSERVED)
    expect(assertions[0].provenance.sourcePublishedAt).toBeUndefined()
    expect(assertions[0].provenance.retrievedAt).toBe(RECUPERE)
    expect(assertions[0].provenance.retrievedAt).not.toBe(assertions[0].observedAt)
  })
})

// ── CLOISONNEMENT ───────────────────────────────────────────────────────────

describe('W — cloisonnement par espace client', () => {
  it('W1 — même revendication, même URL, deux espaces ⇒ deux lignes isolées', async () => {
    const s = [sourceA()]
    const a = assertionsPour(s, WS)
    const b = assertionsPour(s, AUTRE_WS)
    await saveSourceAssertion(a.assertions[0], WS)
    await saveSourceAssertion(b.assertions[0], AUTRE_WS)

    expect(await lignes(WS)).toHaveLength(1)
    expect(await lignes(AUTRE_WS)).toHaveLength(1)
    expect(a.assertions[0].id).not.toBe(b.assertions[0].id)
  })

  it('W2 — un identifiant d’un espace ne désigne rien dans l’autre', async () => {
    const a = assertionsPour([sourceA()], WS)
    await saveSourceAssertion(a.assertions[0], WS)
    const ailleurs = await readSourceAssertion(a.assertions[0].id, AUTRE_WS)
    expect(ailleurs.ok === true && ailleurs.value).toBeNull()
  })

  it('W3 — une assertion de l’espace A ne peut pas être écrite dans l’espace B', async () => {
    const a = assertionsPour([sourceA()], WS)
    expect(await saveSourceAssertion(a.assertions[0], AUTRE_WS))
      .toEqual({ ok: false, reason: 'invalid' })
    expect(await lignes(AUTRE_WS)).toHaveLength(0)
  })

  it('espace vide ⇒ aucune assertion construite ni écrite', async () => {
    expect(buildSourceAssertions({
      workspaceId: '   ', accountId: COMPTE, canonicalClaimKey: CLE_LEVEE,
      evidence: assertionsPour([sourceA()]).evidence,
      qualifyingSources: [sourceA()],
    })).toEqual([])
  })
})

// ── SÛRETÉ / ISOLATION DES PANNES ───────────────────────────────────────────

describe('F — drapeau et isolation', () => {
  it('F1 — drapeau absent ⇒ registre éteint', () => {
    expect(sourceAssertionsEnabled()).toBe(false)
    for (const v of ['', '  ', '0', 'false', 'oui', 'yes', 'on']) {
      process.env.SIGNAL_ARCH_V1_SOURCE_ASSERTIONS = v
      expect(sourceAssertionsEnabled()).toBe(false)
    }
    for (const v of ['1', 'true', 'TRUE', ' true ']) {
      process.env.SIGNAL_ARCH_V1_SOURCE_ASSERTIONS = v
      expect(sourceAssertionsEnabled()).toBe(true)
    }
  })

  it('F4 — le registre n’est PAS exposé par la route générique du magasin', () => {
    // ⚠️ GARDE DÉCISIVE. `pages/api/store/index.ts` autorise le NAVIGATEUR à
    // écrire et supprimer tout `kind` de `PROACTIVE_KIND_LIST`. Un journal
    // d'audit que son sujet peut réécrire ne prouve rien.
    expect(PROACTIVE_KIND_LIST).not.toContain(SOURCE_ASSERTION_KIND as any)
  })

  it('une promotion refusée ne produit aucune assertion', () => {
    const r = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: [sourceA()], confirmations: [],
    })
    expect(r.evidence).toHaveLength(0)
    expect(r.promotions).toHaveLength(0)
  })

  it('`bridgeSignals` expose les sources qualifiantes de chaque promotion', () => {
    const r = bridgeSignals({
      accountId: COMPTE, observedAt: OBSERVED,
      sources: paireB(),
      confirmations: [confirme(['https://maddyness.com/a', 'https://sifted.eu/b'])],
    })
    expect(r.evidence).toHaveLength(1)
    expect(r.promotions).toHaveLength(1)
    expect(r.promotions[0].qualifyingSources).toHaveLength(2)
  })
})

// ── ÉTATS : VERSIONNÉS PAR JOUR D'OBSERVATION DE LA SOURCE ──────────────────
//
// ⚠️ LA COLLISION QUE CES TESTS FERMENT. `canonicalClaimKey` d'un état vaut
// `sales_hiring|<compte>|STATE` — CONSTANTE dans le temps. Même URL + même
// compte rendaient donc le MÊME identifiant à jamais. Et comme l'écriture est
// une INSERTION, la seconde observation n'était pas écrasée : elle n'était
// SILENCIEUSEMENT PAS ENREGISTRÉE, `saveSourceAssertion` rendant
// `{ ok: true, created: false }` — indiscernable d'un rejeu légitime.

const CLE_ETAT = `sales_hiring|${COMPTE}|STATE`
const CARRIERES = 'https://careers.acme.fr/jobs'

/** Poste Sales OUVERT — la seule revendication d'état promouvable aujourd'hui. */
function etatSales(retrievedAt: string | undefined): SourceEvidence {
  const hit = {
    company: 'Acme', signalType: 'recrutement', detail: '', icebreaker: '',
    sourceUrl: CARRIERES, verified: false,
    claimNature: 'STATE', eventStatus: 'UNKNOWN',
    eventDate: null, eventDatePrecision: 'UNKNOWN', sourcePublishedAt: null,
    roleStatus: 'OPEN', roleFunction: 'SALES',
    extraction: { mode: 'claude-web', promptVersion: 'signal-acquisition-v2' },
  } as unknown as SignalHit
  const s = sourceEvidenceFromHit(hit, 'https://careers.acme.fr',
    { kind: 'ORIGINAL' }, ANCRE, retrievedAt)
  if (!s) throw new Error('fixture invalide')
  return s
}

/**
 * Promotion d'un ÉTAT, avec les DEUX horloges dissociées.
 *
 * `recupereA` = quand Prospector a vu la page carrière.
 * `adjugeA`   = quand une personne l'a confirmée. En production, `promote.ts`
 *               l'écrit avec `new Date()` : c'est bien l'adjudication.
 */
function assertionsEtat(recupereA: string | undefined, adjugeA: string, ws = WS) {
  const sources = [etatSales(recupereA)]
  const r = promoteToEvidence({
    accountId: COMPTE, observedAt: adjugeA, sources,
    confirmations: [confirme([CARRIERES], CLE_ETAT)],
  })
  if (r.ok === false) throw new Error(`promotion refusée : ${r.reason}`)
  return {
    evidence: r.evidence,
    assertions: buildSourceAssertions({
      workspaceId: ws, accountId: COMPTE, canonicalClaimKey: r.canonicalKey,
      evidence: r.evidence, qualifyingSources: r.qualifyingSources,
    }),
  }
}

describe('R1 — l’identité d’état vient de `retrievedAt`, jamais de `observedAt`', () => {
  it('T1 — récupérée le 1er, adjugée le 5 ⇒ le jour retenu est le 1er', () => {
    // ⚠️ LE CŒUR DE LA CORRECTION. Sur une source MUTABLE, dater l'observation
    // du jour de l'adjudication enregistre l'état du monde du 1er sous une date
    // à laquelle personne ne l'a observé. C'est une falsification d'historique,
    // pas un décalage.
    const { assertions } = assertionsEtat('2026-09-01T06:00:00.000Z', '2026-09-05T14:00:00.000Z')
    expect(assertions).toHaveLength(1)
    expect(assertions[0].sourceObservedDay).toBe('2026-09-01')
    expect(assertions[0].observedAt).toBe('2026-09-05T14:00:00.000Z')  // non resémantisé
    expect(assertions[0].assertionTemporality).toBe('undated_state')
  })

  it('T2 — deux récupérations distinctes ⇒ DEUX assertions', async () => {
    const a = assertionsEtat('2026-09-01T06:00:00.000Z', '2026-09-05T14:00:00.000Z')
    const b = assertionsEtat('2026-09-15T06:00:00.000Z', '2026-09-20T14:00:00.000Z')
    expect(a.assertions[0].id).not.toBe(b.assertions[0].id)
    expect(a.evidence.id).toBe(b.evidence.id)   // MÊME evidence : la convergence tient

    await saveSourceAssertion(a.assertions[0], WS)
    await saveSourceAssertion(b.assertions[0], WS)
    const toutes = await lignes()
    expect(toutes).toHaveLength(2)
    expect(toutes.map((x) => x.sourceObservedDay).sort()).toEqual(['2026-09-01', '2026-09-15'])
  })

  it('T3 — même jour UTC récupéré, adjudications différentes ⇒ UNE assertion', () => {
    const a = assertionsEtat('2026-09-01T06:00:00.000Z', '2026-09-05T14:00:00.000Z')
    const b = assertionsEtat('2026-09-01T22:45:00.000Z', '2026-09-08T09:00:00.000Z')
    expect(a.assertions[0].id).toBe(b.assertions[0].id)
  })

  it('T4 — `observedAt` seul NE CHANGE PAS l’identité d’un état', () => {
    const a = assertionsEtat('2026-09-01T06:00:00.000Z', '2026-09-05T14:00:00.000Z')
    const b = assertionsEtat('2026-09-01T06:00:00.000Z', '2027-01-01T00:00:00.000Z')
    expect(b.assertions[0].id).toBe(a.assertions[0].id)
    expect(b.assertions[0].observedAt).not.toBe(a.assertions[0].observedAt)
  })

  it('T5 — `retrievedAt` absent ou non strict ⇒ AUCUNE assertion d’état', () => {
    // ⚠️ FAIL CLOSED. On ignore QUAND cet état a été observé ; le dater d'autre
    // chose inventerait la seule information qui fait son identité.
    // L'adjudication, elle, reste parfaitement valide — l'evidence est produite.
    for (const mauvais of [undefined, '2026-09-01', 'hier', '2026-09-01T24:00:00.000Z']) {
      const r = assertionsEtat(mauvais as any, '2026-09-05T14:00:00.000Z')
      expect(r.evidence.id).toBeTruthy()      // la promotion aboutit
      expect(r.assertions).toEqual([])        // le registre s'abstient
    }
  })

  it('T6 — l’identité d’un ÉVÉNEMENT est inchangée, octet pour octet', () => {
    // ⚠️ VERROU DE NON-RÉGRESSION LITTÉRAL. Cette valeur a été relevée AVANT la
    // correction. Ajouter un jour à l'identité d'un événement ferait de deux
    // découvertes du même fait daté deux assertions — la fausse nouveauté que
    // ce registre existe pour empêcher.
    const { assertions } = assertionsPour([sourceA()])
    expect(assertions[0].id).toBe('sa_5a07eb5746391b23bd232460dac2a2c6')
    expect(assertions[0].assertionTemporality).toBe('dated_event')
    expect('sourceObservedDay' in assertions[0]).toBe(false)
  })

  it('le jour est dérivé par `toISOString`, jamais par une horloge LOCALE', () => {
    // ⚠️ VERROU STRUCTUREL, ET IL FAUT DIRE POURQUOI. Un jour local et un jour
    // UTC sont IDENTIQUES quand le processus tourne en UTC — ce qui est le cas
    // de la CI. Aucune assertion de valeur ne peut donc distinguer les deux :
    // un mutant remplaçant `toISOString()` par `getFullYear/getMonth/getDate`
    // resterait vert ici et fausserait l'identité sur toute machine décalée.
    //
    // On verrouille donc la FORME, comme le fait déjà
    // `tests/signal-product-reachability.test.ts` pour la frontière de vérité.
    const code = readFileSync(
      new URL('../lib/prospector/proactive/sourceAssertion.ts', import.meta.url), 'utf8')
    const corps = code.slice(code.indexOf('export function sourceObservedDay'))
      .slice(0, code.slice(code.indexOf('export function sourceObservedDay')).indexOf('\n}'))
    expect(corps).toMatch(/toISOString\(\)\.slice\(0, 10\)/)
    expect(corps).not.toMatch(/getFullYear|getMonth|getDate|getHours/)
  })

  it('le jour est UTC, jamais local — conséquence dite', () => {
    // 01 h 30 à Paris le 2 septembre = 23 h 30 UTC le 1er.
    const { assertions } = assertionsEtat('2026-09-01T23:30:00.000Z', '2026-09-05T14:00:00.000Z')
    expect(assertions[0].sourceObservedDay).toBe('2026-09-01')
  })

  it('le validateur exige le jour sur un état, et l’interdit sur un événement', () => {
    const etat = assertionsEtat('2026-09-01T06:00:00.000Z', '2026-09-05T14:00:00.000Z').assertions[0]
    const evt = assertionsPour([sourceA()]).assertions[0]
    expect(isSourceAssertion(etat)).toBe(true)
    expect(isSourceAssertion(evt)).toBe(true)

    const { sourceObservedDay, ...etatSansJour } = etat as any
    expect(isSourceAssertion(etatSansJour)).toBe(false)
    expect(isSourceAssertion({ ...evt, sourceObservedDay: '2026-09-01' })).toBe(false)
    expect(isSourceAssertion({ ...etat, sourceObservedDay: '2026-09-02' })).toBe(false)
    expect(isSourceAssertion({ ...etat, assertionTemporality: 'autre' })).toBe(false)
  })

  it('rejeu du même jour récupéré ⇒ une seule ligne, idempotent', async () => {
    const a = assertionsEtat('2026-09-01T06:00:00.000Z', '2026-09-05T14:00:00.000Z')
    expect(await saveSourceAssertion(a.assertions[0], WS)).toEqual({ ok: true, created: true })
    expect(await saveSourceAssertion(a.assertions[0], WS)).toEqual({ ok: true, created: false })
    expect(await lignes()).toHaveLength(1)
  })
})
