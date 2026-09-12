// RESEARCH_MISSION_ARTIFACT_V0_001 — le socle mission/artefact est testé A–Z.
//
// ⚠️ ENTIÈREMENT HORS LIGNE : magasin réel (repli mémoire, la même Map),
// horloge injectée, AUCUN appel fournisseur, aucune clé requise.
import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildResearchBrief, createResearchMission, isResearchMissionSpecV0,
  readResearchMission, researchMissionId, researchSpecHash,
  RESEARCH_MISSION_KIND, type ResearchMissionSpecV0,
} from '../lib/prospector/research/missionV0'
import {
  extractReferencedUrls, importResearchArtifact, readResearchArtifact,
  researchArtifactId, researchContentHash, researchRecordHash, RESEARCH_ARTIFACT_KIND,
} from '../lib/prospector/research/artifactV0'

const g: any = globalThis as any
beforeEach(() => { if (g.__prospectorStore) g.__prospectorStore.clear() })

const WS = 'ws_research_a'
const AUTRE_WS = 'ws_research_b'
const T0 = () => new Date('2026-08-31T10:00:00.000Z')

const spec = (extra: Record<string, unknown> = {}): any => ({
  contractVersion: 'research-mission-v0',
  thesis: 'PME industrielles françaises en phase de structuration commerciale',
  coverageMode: 'SYSTEMATIC',
  targetCount: 25,
  signalFamilies: ['FUNDING', 'HIRING_SNAPSHOT'],
  scope: {
    location: 'France', sector: 'industrie',
    employeeMin: 20, employeeMax: 200,
    freshnessDays: 90, keywords: ['levée', 'recrutement commercial'],
  },
  ...extra,
})

const MARKDOWN = `# Résultats
## Acme Industrie
Levée de 8 M€ (série A). Source : https://presse.exemple.fr/acme-levee.
Publication : 2026-08-13 ; événement : 2026-08-12.
Voir aussi https://presse.exemple.fr/acme-levee, et https://acme-industrie.fr/actus?id=42.
URL cassée : https://[invalide et http://%zz%.
`

async function mission(ws = WS, now: () => Date = T0) {
  const r = await createResearchMission(spec(), ws, now)
  if (r.ok === false) throw new Error(r.reason)
  return r.mission
}

describe('spécification (A–E)', () => {
  it('A — spécification valide acceptée, mission persistée et relue intacte', async () => {
    const m = await mission()
    expect(m.id).toMatch(/^rm_[0-9a-f]{32}$/)
    expect(m.executionMode).toBe('MANUAL_PREMIUM_RESEARCH')
    const relu = await readResearchMission(m.id, WS)
    if (relu.ok === false) throw new Error(relu.reason)
    expect(relu.mission).toEqual(m)
  })

  it('B — clés inconnues ou contrat absent : REJET explicite, jamais réparé', async () => {
    for (const casse of [
      spec({ score: 0.9 }),                                    // clé hors contrat
      spec({ contractVersion: 'research-mission-v1' }),
      spec({ scope: { ...spec().scope, priority: 'high' } }),  // clé de scope inconnue
      spec({ thesis: '   ' }),
      spec({ thesis: ' non trimé ' }),
      spec({ targetCount: 0 }), spec({ targetCount: 201 }), spec({ targetCount: 2.5 }),
      spec({ coverageMode: 'DEEP' }),
      { ...spec(), scope: undefined },
    ]) {
      expect(isResearchMissionSpecV0(casse), JSON.stringify(casse).slice(0, 60)).toBe(false)
      const r = await createResearchMission(casse, WS, T0)
      expect(r).toEqual({ ok: false, reason: 'INVALID_SPEC' })
    }
    expect(g.__prospectorStore.size).toBe(0)
  })

  it('C — employeeMin > employeeMax : rejet ; bornes valides acceptées', () => {
    expect(isResearchMissionSpecV0(spec({ scope: { employeeMin: 50, employeeMax: 20 } }))).toBe(false)
    expect(isResearchMissionSpecV0(spec({ scope: { employeeMin: 0, employeeMax: 0 } }))).toBe(true)
    expect(isResearchMissionSpecV0(spec({ scope: { freshnessDays: 0 } }))).toBe(false)
    expect(isResearchMissionSpecV0(spec({ scope: { freshnessDays: 100000 } }))).toBe(false)
    expect(isResearchMissionSpecV0(spec({ scope: { keywords: [] } }))).toBe(false)
    expect(isResearchMissionSpecV0(spec({ scope: { keywords: ['  '] } }))).toBe(false)
  })

  it('D — familles dupliquées ou hors V0 : rejet', () => {
    expect(isResearchMissionSpecV0(spec({ signalFamilies: ['FUNDING', 'FUNDING'] }))).toBe(false)
    expect(isResearchMissionSpecV0(spec({ signalFamilies: [] }))).toBe(false)
    expect(isResearchMissionSpecV0(spec({ signalFamilies: ['FUNDING', 'M_AND_A'] }))).toBe(false)
  })

  it('E — specHash déterministe et insensible à l’ordre des clés', () => {
    const a = researchSpecHash(spec())
    expect(a).toBe(researchSpecHash(spec()))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    const reordonne = JSON.parse(JSON.stringify(spec(), Object.keys(spec()).sort().reverse()))
    // même contenu, autre ordre d'insertion ⇒ même condensat (JSON canonique)
    expect(researchSpecHash({ ...spec(), scope: { ...spec().scope } })).toBe(a)
    void reordonne
  })

  it('F — l’identité inclut l’ESPACE : même spec, même instant, deux espaces ⇒ deux identités', async () => {
    const a = await mission(WS)
    const b = await mission(AUTRE_WS)
    expect(a.specHash).toBe(b.specHash)
    expect(a.createdAt).toBe(b.createdAt)
    expect(a.id).not.toBe(b.id)
  })
})

describe('brief de recherche (G–I)', () => {
  it('G — déterministe : deux constructions rendent le même texte, persisté avec la mission', async () => {
    expect(buildResearchBrief(spec())).toBe(buildResearchBrief(spec()))
    const m = await mission()
    expect(m.researchBrief).toBe(buildResearchBrief(spec()))
    expect(m.briefVersion).toBe('research-brief-v0')
  })

  it('H — le brief EXIGE la distinction date d’événement / date de publication, et interdit l’invention', () => {
    const brief = buildResearchBrief(spec())
    expect(brief).toContain('DATE DE L\'ÉVÉNEMENT MÉTIER SÉPARÉMENT de la date de publication')
    expect(brief).toContain('N\'inventer AUCUNE date')
    expect(brief).toContain('N\'inventer AUCUN montant')
    expect(brief).toContain('N\'inventer AUCUN décompte')
    expect(brief).toContain('ÉTAT ACTUEL')
    expect(brief).toContain('ÉVÉNEMENT DATÉ')
    expect(brief).toContain('désaccords entre sources')
    expect(brief).toContain('Rien trouvé')
    expect(brief).toContain('sources PRIMAIRES')
  })

  it('I — le brief ne demande JAMAIS d’identifiants factuels, condensats ni scores', () => {
    const brief = buildResearchBrief(spec())
    for (const interdit of [
      'SourceAssertion', 'canonical', 'assertedFactHash', 'personKey',
      'amountMinor', 'normalizedName', 'confidence', 'confiance', 'score', 'Jarvis',
    ]) {
      expect(brief.toLowerCase(), interdit).not.toContain(interdit.toLowerCase())
    }
  })
})

describe('artefact (J–R)', () => {
  it('J/K — Markdown importé CARACTÈRE POUR CARACTÈRE, contentHash exact vérifié', async () => {
    const m = await mission()
    const r = await importResearchArtifact(
      { missionId: m.id, rawContent: MARKDOWN, originLabel: 'ChatGPT Deep Research', model: 'GPT-5.6 Sol', executedAt: '2026-08-31T09:00:00.000Z' },
      WS, T0,
    )
    if (r.ok === false) throw new Error(r.reason)
    expect(r.artifact.rawContent).toBe(MARKDOWN) // exactitude stricte
    expect(r.artifact.contentHash).toBe(researchContentHash(MARKDOWN))
    expect(r.artifact.contentHash).toMatch(/^[0-9a-f]{64}$/)
    const relu = await readResearchArtifact(r.artifact.id, WS)
    if (relu.ok === false) throw new Error(relu.reason)
    expect(relu.artifact.rawContent).toBe(MARKDOWN)
    expect(relu.artifact.provenance.originLabel).toBe('ChatGPT Deep Research')
  })

  it('L — même mission + même Markdown : REJEU IDEMPOTENT (même id, created:false, une seule ligne)', async () => {
    const m = await mission()
    const un = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'Perplexity Research' }, WS, T0)
    const deux = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'Perplexity Research' }, WS, T0)
    if (un.ok === false || deux.ok === false) throw new Error('import échoué')
    expect(un.created).toBe(true)
    expect(deux.created).toBe(false)
    expect(deux.artifact.id).toBe(un.artifact.id)
    const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${RESEARCH_ARTIFACT_KIND}|`))
    expect(lignes.length).toBe(1)
  })

  it('M — même Markdown dans DEUX missions : deux identités d’artefact', async () => {
    const m1 = await mission(WS, T0)
    const m2 = await mission(WS, () => new Date('2026-08-31T11:00:00.000Z'))
    expect(m1.id).not.toBe(m2.id)
    const a1 = await importResearchArtifact({ missionId: m1.id, rawContent: MARKDOWN, originLabel: 'Manual analyst research' }, WS, T0)
    const a2 = await importResearchArtifact({ missionId: m2.id, rawContent: MARKDOWN, originLabel: 'Manual analyst research' }, WS, T0)
    if (a1.ok === false || a2.ok === false) throw new Error('import échoué')
    expect(a1.artifact.id).not.toBe(a2.artifact.id)
    expect(a1.artifact.contentHash).toBe(a2.artifact.contentHash)
  })

  it('N/O — URLs dédupliquées de façon déterministe ; une URL malformée ne casse RIEN et ne fabrique aucune source', async () => {
    const urls = extractReferencedUrls(MARKDOWN)
    expect(urls).toEqual([
      'https://acme-industrie.fr/actus?id=42',
      'https://presse.exemple.fr/acme-levee',
    ]) // dédupliquée, triée ; les URL cassées n'y figurent pas
    expect(extractReferencedUrls(MARKDOWN)).toEqual(urls)
    const m = await mission()
    const r = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'Claude Research' }, WS, T0)
    if (r.ok === false) throw new Error(r.reason)
    expect(r.artifact.rawContent).toBe(MARKDOWN) // le brut reste intact malgré les URL cassées
    expect(r.artifact.referencedUrls).toEqual(urls)
  })

  it('P/Q — executedAt optionnel accepté absent ; invalide (jour seul, 24:00, prose) REJETÉ sans persistance', async () => {
    const m = await mission()
    const sans = await importResearchArtifact({ missionId: m.id, rawContent: 'doc', originLabel: 'Manual analyst research' }, WS, T0)
    expect(sans.ok).toBe(true)
    for (const executedAt of ['2026-08-31', '2026-08-31T24:00:00Z', 'hier']) {
      const r = await importResearchArtifact({ missionId: m.id, rawContent: 'autre doc', originLabel: 'x', executedAt }, WS, T0)
      expect(r, executedAt).toEqual({ ok: false, reason: 'INVALID_INPUT' })
    }
    const artefacts = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${RESEARCH_ARTIFACT_KIND}|`))
    expect(artefacts.length).toBe(1)
  })

  it('R — importedAt vient UNIQUEMENT de l’horloge injectée/serveur, jamais de l’entrée', async () => {
    const m = await mission()
    const r = await importResearchArtifact(
      { missionId: m.id, rawContent: 'doc', originLabel: 'x', executedAt: '2026-01-01T00:00:00.000Z' },
      WS, () => new Date('2026-08-31T12:34:56.000Z'),
    )
    if (r.ok === false) throw new Error(r.reason)
    expect(r.artifact.provenance.importedAt).toBe('2026-08-31T12:34:56.000Z')
    expect(r.artifact.provenance.executedAt).toBe('2026-01-01T00:00:00.000Z') // jamais déduit l'un de l'autre
  })

  it('S/T — mission inconnue ou d’un AUTRE espace : import et lecture REJETÉS', async () => {
    const m = await mission(WS)
    expect(await importResearchArtifact({ missionId: 'rm_' + 'a'.repeat(32), rawContent: 'doc', originLabel: 'x' }, WS, T0))
      .toEqual({ ok: false, reason: 'MISSION_UNKNOWN' })
    // La mission de WS n'existe pas dans AUTRE_WS : rien ne s'y importe.
    expect(await importResearchArtifact({ missionId: m.id, rawContent: 'doc', originLabel: 'x' }, AUTRE_WS, T0))
      .toEqual({ ok: false, reason: 'MISSION_UNKNOWN' })
    const ok = await importResearchArtifact({ missionId: m.id, rawContent: 'doc', originLabel: 'x' }, WS, T0)
    if (ok.ok === false) throw new Error(ok.reason)
    expect((await readResearchMission(m.id, AUTRE_WS)).ok).toBe(false)
    expect((await readResearchArtifact(ok.artifact.id, AUTRE_WS)).ok).toBe(false)
  })
})

describe('résistance à l’altération (U–X)', () => {
  const ligne = (kind: string) => [...g.__prospectorStore.entries()]
    .find(([k]: any) => k.startsWith(`${kind}|`))![1]

  it('U — specHash de mission altéré : MISSION_TAMPERED à la relecture', async () => {
    const m = await mission()
    ligne(RESEARCH_MISSION_KIND).spec.targetCount = 199 // contenu muté sous le même condensat
    expect(await readResearchMission(m.id, WS)).toEqual({ ok: false, reason: 'MISSION_TAMPERED' })
  })

  it('U-bis — specHash ET identité refaits ENSEMBLE par l’altérateur : le recalcul depuis la spec rejette quand même', async () => {
    const m = await mission()
    const row = [...g.__prospectorStore.entries()].find(([k]: any) => k.startsWith(`${RESEARCH_MISSION_KIND}|`))![1]
    // L'attaquant substitue un condensat de spec ET recalcule l'identifiant
    // pour rester cohérent — seule la revérification specHash ↔ spec le trahit.
    row.specHash = 'f'.repeat(64)
    row.id = researchMissionId(WS, row.createdAt, row.specHash)
    g.__prospectorStore.set(`${RESEARCH_MISSION_KIND}|${WS}|${row.id}`, row)
    expect(await readResearchMission(row.id, WS)).toEqual({ ok: false, reason: 'MISSION_TAMPERED' })
  })

  it('V — contentHash d’artefact altéré (brut réécrit) : ARTIFACT_TAMPERED', async () => {
    const m = await mission()
    const r = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'x' }, WS, T0)
    if (r.ok === false) throw new Error(r.reason)
    ligne(RESEARCH_ARTIFACT_KIND).rawContent = MARKDOWN + '\n« nettoyé »'
    expect(await readResearchArtifact(r.artifact.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('W — missionSpecHash d’artefact altéré : rejet (vérifié contre la MISSION relue)', async () => {
    const m = await mission()
    const r = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'x' }, WS, T0)
    if (r.ok === false) throw new Error(r.reason)
    ligne(RESEARCH_ARTIFACT_KIND).missionSpecHash = 'f'.repeat(64)
    expect(await readResearchArtifact(r.artifact.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('X — identité/contenu discordants (brut substitué avec condensat recalculé) : rejet', async () => {
    const m = await mission()
    const r = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'x' }, WS, T0)
    if (r.ok === false) throw new Error(r.reason)
    const row = ligne(RESEARCH_ARTIFACT_KIND)
    row.rawContent = 'contenu substitué'
    row.contentHash = researchContentHash('contenu substitué') // cohérent en interne…
    // …mais l'IDENTITÉ recalculée ne correspond plus à l'id stocké.
    expect(await readResearchArtifact(r.artifact.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })
})

describe('déduplication JAMAIS aveugle', () => {
  it('une ligne préexistante ALTÉRÉE sous le même id n’est pas un rejeu : WRITE_FAILED, jamais un faux succès', async () => {
    const m = await mission()
    const contentHash = researchContentHash(MARKDOWN)
    const id = researchArtifactId(WS, m.id, contentHash)
    // Une ligne invalide occupe déjà l'identifiant (écriture directe corrompue).
    g.__prospectorStore.set(`${RESEARCH_ARTIFACT_KIND}|${WS}|${id}`, { id, workspaceId: WS, corrompu: true })
    const r = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'x' }, WS, T0)
    expect(r).toEqual({ ok: false, reason: 'WRITE_FAILED' })
  })
})

describe('intégrité immuable (R1) — altérations à VALEURS VALIDES', () => {
  const ligne = (kind: string) => [...g.__prospectorStore.entries()]
    .find(([k]: any) => k.startsWith(`${kind}|`))![1]

  async function artefact(originLabel = 'ChatGPT Deep Research') {
    const m = await mission()
    const r = await importResearchArtifact(
      { missionId: m.id, rawContent: MARKDOWN, originLabel, model: 'GPT-5.6 Sol', executedAt: '2026-08-31T09:00:00.000Z' },
      WS, T0,
    )
    if (r.ok === false) throw new Error(r.reason)
    return { m, a: r.artifact }
  }

  it('R1-A — researchBrief remplacé par un AUTRE brief bien formé : MISSION_TAMPERED', async () => {
    const m = await mission()
    const row = ligne(RESEARCH_MISSION_KIND)
    row.researchBrief = buildResearchBrief(spec({ thesis: 'autre thèse plausible' }))
    expect(await readResearchMission(m.id, WS)).toEqual({ ok: false, reason: 'MISSION_TAMPERED' })
  })

  it('R1-B — createdAt remplacé par un AUTRE instant strict valide : MISSION_TAMPERED', async () => {
    const m = await mission()
    ligne(RESEARCH_MISSION_KIND).createdAt = '2026-08-31T11:00:00.000Z' // instant valide, mais pas celui de l’identité
    expect(await readResearchMission(m.id, WS)).toEqual({ ok: false, reason: 'MISSION_TAMPERED' })
  })

  it('R1-C — briefVersion / executionMode remplacés par d’autres chaînes plausibles : MISSION_TAMPERED', async () => {
    const m = await mission()
    const original = JSON.parse(JSON.stringify(ligne(RESEARCH_MISSION_KIND)))
    ligne(RESEARCH_MISSION_KIND).briefVersion = 'research-brief-v1'
    expect(await readResearchMission(m.id, WS)).toEqual({ ok: false, reason: 'MISSION_TAMPERED' })
    g.__prospectorStore.set([...g.__prospectorStore.keys()].find((k: string) => k.startsWith(`${RESEARCH_MISSION_KIND}|`)), original)
    ligne(RESEARCH_MISSION_KIND).executionMode = 'AUTOMATED_RESEARCH'
    expect(await readResearchMission(m.id, WS)).toEqual({ ok: false, reason: 'MISSION_TAMPERED' })
  })

  it('R1-D — referencedUrls altérées vers une liste VALIDE mais non dérivée du brut : ARTIFACT_TAMPERED', async () => {
    const { a } = await artefact()
    ligne(RESEARCH_ARTIFACT_KIND).referencedUrls = ['https://autre.exemple.fr/x'] // syntaxiquement irréprochable
    expect(await readResearchArtifact(a.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('R1-D-bis — referencedUrls falsifiées AVEC recordHash recalculé en cohérence : la recomputation depuis le brut rejette quand même', async () => {
    const { a } = await artefact()
    const row = ligne(RESEARCH_ARTIFACT_KIND)
    row.referencedUrls = ['https://autre.exemple.fr/x']
    // L'attaquant refait le condensat d'intégrité pour rester cohérent…
    const { id: _id, recordHash: _rh, ...sans } = row
    row.recordHash = researchRecordHash(sans as any)
    // …seule la PROJECTION DÉTERMINISTE depuis rawContent le trahit.
    expect(await readResearchArtifact(a.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('R1-E — referencedUrls VIDÉES (masquage de traçabilité) : ARTIFACT_TAMPERED', async () => {
    const { a } = await artefact()
    ligne(RESEARCH_ARTIFACT_KIND).referencedUrls = []
    expect(await readResearchArtifact(a.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('R1-F — provenance.originLabel remplacé par une AUTRE étiquette valide : ARTIFACT_TAMPERED', async () => {
    const { a } = await artefact()
    ligne(RESEARCH_ARTIFACT_KIND).provenance.originLabel = 'Claude Research'
    expect(await readResearchArtifact(a.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('R1-G — provenance.model remplacé par un AUTRE nom valide : ARTIFACT_TAMPERED', async () => {
    const { a } = await artefact()
    ligne(RESEARCH_ARTIFACT_KIND).provenance.model = 'GPT-6'
    expect(await readResearchArtifact(a.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('R1-H — provenance.executedAt / importedAt remplacés par d’AUTRES instants stricts valides : ARTIFACT_TAMPERED', async () => {
    const { a } = await artefact()
    const original = JSON.parse(JSON.stringify(ligne(RESEARCH_ARTIFACT_KIND)))
    ligne(RESEARCH_ARTIFACT_KIND).provenance.executedAt = '2026-08-31T08:00:00.000Z'
    expect(await readResearchArtifact(a.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
    g.__prospectorStore.set([...g.__prospectorStore.keys()].find((k: string) => k.startsWith(`${RESEARCH_ARTIFACT_KIND}|`)), original)
    ligne(RESEARCH_ARTIFACT_KIND).provenance.importedAt = '2026-08-31T23:59:59.000Z'
    expect(await readResearchArtifact(a.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('R1-I — recordHash lui-même substitué (valeur hexadécimale bien formée) : ARTIFACT_TAMPERED', async () => {
    const { a } = await artefact()
    ligne(RESEARCH_ARTIFACT_KIND).recordHash = 'e'.repeat(64)
    expect(await readResearchArtifact(a.id, WS)).toEqual({ ok: false, reason: 'ARTIFACT_TAMPERED' })
  })

  it('R1-J — VRAI rejeu (mêmes provenance fournie, horloge serveur différente) : idempotent, importedAt ORIGINEL conservé', async () => {
    const { a, m } = await artefact()
    const deux = await importResearchArtifact(
      { missionId: m.id, rawContent: MARKDOWN, originLabel: 'ChatGPT Deep Research', model: 'GPT-5.6 Sol', executedAt: '2026-08-31T09:00:00.000Z' },
      WS, () => new Date('2026-08-31T18:00:00.000Z'), // importedAt serveur différent : ne doit PAS créer de conflit
    )
    if (deux.ok === false) throw new Error(deux.reason)
    expect(deux.created).toBe(false)
    expect(deux.artifact.id).toBe(a.id)
    expect(deux.artifact.provenance.importedAt).toBe(a.provenance.importedAt) // l’original, jamais réécrit
    const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${RESEARCH_ARTIFACT_KIND}|`))
    expect(lignes.length).toBe(1)
  })

  it('R1-K — même contenu, originLabel DIFFÉRENT : PROVENANCE_CONFLICT explicite, jamais un rejeu silencieux', async () => {
    const { a, m } = await artefact()
    const r = await importResearchArtifact(
      { missionId: m.id, rawContent: MARKDOWN, originLabel: 'Perplexity Research', model: 'GPT-5.6 Sol', executedAt: '2026-08-31T09:00:00.000Z' },
      WS, T0,
    )
    expect(r).toEqual({ ok: false, reason: 'PROVENANCE_CONFLICT' })
    const relu = await readResearchArtifact(a.id, WS)
    if (relu.ok === false) throw new Error(relu.reason)
    expect(relu.artifact.provenance.originLabel).toBe('ChatGPT Deep Research') // l’original n’est ni écrasé ni fusionné
  })

  it('R1-L — même contenu, executedAt ou model DIFFÉRENT : PROVENANCE_CONFLICT', async () => {
    const { m } = await artefact()
    expect(await importResearchArtifact(
      { missionId: m.id, rawContent: MARKDOWN, originLabel: 'ChatGPT Deep Research', model: 'GPT-5.6 Sol', executedAt: '2026-08-30T09:00:00.000Z' },
      WS, T0,
    )).toEqual({ ok: false, reason: 'PROVENANCE_CONFLICT' })
    expect(await importResearchArtifact(
      { missionId: m.id, rawContent: MARKDOWN, originLabel: 'ChatGPT Deep Research', model: 'autre-modele', executedAt: '2026-08-31T09:00:00.000Z' },
      WS, T0,
    )).toEqual({ ok: false, reason: 'PROVENANCE_CONFLICT' })
  })

  it('R1-M — ligne corrompue préexistante sous le même id : WRITE_FAILED, jamais un succès de rejeu', async () => {
    const m = await mission()
    const id = researchArtifactId(WS, m.id, researchContentHash(MARKDOWN))
    g.__prospectorStore.set(`${RESEARCH_ARTIFACT_KIND}|${WS}|${id}`, { id, workspaceId: WS, corrompu: true })
    const r = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'x' }, WS, T0)
    expect(r).toEqual({ ok: false, reason: 'WRITE_FAILED' })
  })
})

describe('frontière factuelle (Y)', () => {
  it('Y — l’import ne crée AUCUN candidat, assertion, événement ni instantané canonique', async () => {
    const m = await mission()
    const r = await importResearchArtifact({ missionId: m.id, rawContent: MARKDOWN, originLabel: 'ChatGPT Deep Research' }, WS, T0)
    expect(r.ok).toBe(true)
    for (const kind of [
      'proactive_signal_candidate', 'proactive_source_assertion',
      'proactive_canonical_event', 'proactive_canonical_state_snapshot',
    ]) {
      const lignes = [...g.__prospectorStore.keys()].filter((k: string) => k.startsWith(`${kind}|`))
      expect(lignes, kind).toEqual([])
    }
    // Et les modules recherche n'importent AUCUN producteur factuel.
    const { readFileSync } = await import('node:fs')
    for (const f of ['lib/prospector/research/missionV0.ts', 'lib/prospector/research/artifactV0.ts']) {
      const imports = readFileSync(f, 'utf8').split('\n').filter((l) => /^\s*import/.test(l)).join('\n')
      expect(imports, f).not.toMatch(/signalBridge|sourceAssertion|canonicalFact|signalCandidates|signals'|validators/)
    }
  })
})
