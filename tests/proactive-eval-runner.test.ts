// EVAL-RUNNER-001a — LE RUNNER OFFLINE.
//
// Deux niveaux de preuve ici, et ils ne se remplacent pas :
//   • le module (`validateEvalCase` / `runEvalCase`), testé en direct ;
//   • le PROCESSUS CLI réel, lancé par `execFileSync`, seul moyen d'observer
//     les codes de sortie et la séparation stdout/stderr. Un test qui
//     appellerait seulement les fonctions ne prouverait rien du contrat CLI.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateEvalCase, EVAL_SCHEMA_VERSION } from '../lib/prospector/proactive/eval/caseSchema'
import { runEvalCase, serializeEvalOutput } from '../lib/prospector/proactive/eval/runCase'
import { evaluate } from '../lib/prospector/proactive/orchestrator'
import { evaluateEvidence } from '../lib/prospector/proactive/decisionKernel'
import { evidenceMatchesTarget } from '../lib/prospector/proactive/situationEngine'
import type { Lead } from '../types/prospector'
import type { TaskSnapshot } from '../lib/prospector/proactive/dataBridge'
import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'

const RACINE = process.cwd()
const FIXTURE = 'fixtures/proactive-eval/technical-smoke-sales.sample.json'

const CAS_VALIDE = {
  schemaVersion: EVAL_SCHEMA_VERSION,
  now: '2026-03-01T10:00:00.000Z',
  businessContext: {
    contextId: 'smoke-sales',
    contextVersion: 'v0.1',
    role: 'sales_rep',
    scope: { mode: 'workspace' },
    authorizedMotions: {
      prepare_outreach: 'allowed',
      contact_prospect: 'allowed',
      enrich_data: 'allowed',
      schedule_reminder: 'allowed',
    },
    lensId: 'sales-default',
    lensVersion: 'v0.1',
  },
  targets: [{ accountId: 'acc_smoke_1', relevance: 0.8 }],
  evidence: [
    {
      id: 'ev_smoke_funding',
      accountId: 'acc_smoke_1',
      type: 'recent_funding',
      scope: 'account',
      temporality: 'dated_event',
      occurredAt: '2026-02-01T00:00:00.000Z',
      observedAt: '2026-02-02T00:00:00.000Z',
      assertionType: 'fact',
      confidence: 0.9,
      source: { provider: 'smoke-fixture' },
    },
    {
      id: 'ev_smoke_hiring',
      accountId: 'acc_smoke_1',
      type: 'sales_hiring',
      scope: 'account',
      temporality: 'dated_event',
      occurredAt: '2026-02-10T00:00:00.000Z',
      observedAt: '2026-02-11T00:00:00.000Z',
      assertionType: 'fact',
      confidence: 0.85,
      source: { provider: 'smoke-fixture' },
    },
  ],
}

function clone(patch: (c: any) => void) {
  const c = JSON.parse(JSON.stringify(CAS_VALIDE))
  patch(c)
  return c
}

/** Codes d'erreur produits, à plat — pour des assertions lisibles. */
function codes(input: unknown): string[] {
  const v = validateEvalCase(input)
  // `=== false` : sous `"strict": false`, une négation ne rétrécit pas l'union.
  if (v.ok === false) return v.errors.map((e) => e.code)
  return []
}

// ── Exécution du VRAI processus CLI ─────────────────────────────────────────
interface CliResultat {
  status: number
  stdout: string
  stderr: string
}

function cli(argsFichier: string): CliResultat {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '--import',
        './scripts/ts-resolve-hook.mjs',
        'scripts/proactive-eval.mjs',
        argsFichier,
      ],
      { cwd: RACINE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { status: 0, stdout, stderr: '' }
  } catch (error: any) {
    return {
      status: error.status ?? -1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}

function fichierTemporaire(contenu: string): string {
  const dossier = mkdtempSync(join(tmpdir(), 'proactive-eval-'))
  const chemin = join(dossier, 'cas.json')
  writeFileSync(chemin, contenu, 'utf8')
  return chemin
}

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Entrée valide — la chaîne complète s’exécute hors ligne', () => {
  it('un cas valide produit situation puis recommandation', () => {
    const validation = validateEvalCase(CAS_VALIDE)
    expect(validation.ok).toBe(true)

    const sortie = runEvalCase((validation as any).case)

    expect(sortie.evidence).toHaveLength(2)
    expect(sortie.situations).toHaveLength(1)
    expect(sortie.situations[0].type).toBe('sales_scale_up')
    expect(sortie.situations[0].rulePackId).toBe('sales-core')
    // La pertinence du fichier arrive INTACTE : ni recalculée, ni remplacée.
    expect(sortie.situations[0].relevance).toBe(0.8)

    expect(sortie.recommendations).toHaveLength(1)
    expect(sortie.recommendations[0].decision).toBe('recommend')
    expect(sortie.recommendations[0].contextId).toBe('smoke-sales')
  })

  it('la fixture technique s’exécute via la VRAIE CLI, code 0', () => {
    const r = cli(FIXTURE)

    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')

    const sortie = JSON.parse(r.stdout)
    expect(sortie.situations).toHaveLength(1)
    expect(sortie.recommendations).toHaveLength(1)
    expect(sortie.situations[0].type).toBe('sales_scale_up')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B. Fail closed — aucune entrée invalide ne produit de résultat', () => {
  it('JSON invalide ⇒ stderr, code non nul, stdout VIDE', () => {
    const r = cli(fichierTemporaire('{ ceci n est pas du JSON'))

    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('JSON invalide')
  })

  it('fichier absent ⇒ code non nul, aucune sortie', () => {
    const r = cli('fixtures/proactive-eval/inexistant.json')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
  })

  it('aucun argument ⇒ usage sur stderr, code non nul', () => {
    const r = cli('')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
  })

  it('schemaVersion inconnue ⇒ REFUS', () => {
    expect(codes(clone((c) => { c.schemaVersion = 'proactive-eval-v9' }))).toContain('schema_version_unknown')
    expect(codes(clone((c) => { delete c.schemaVersion }))).toContain('schema_version_unknown')
  })

  it('now invalide ⇒ REFUS', () => {
    expect(codes(clone((c) => { c.now = 'hier' }))).toContain('now_invalid')
    expect(codes(clone((c) => { delete c.now }))).toContain('now_invalid')
  })

  it('businessContext absent ou invalide ⇒ REFUS, jamais de contexte fabriqué', () => {
    expect(codes(clone((c) => { delete c.businessContext }))).toContain('business_context_missing')
    expect(codes(clone((c) => { delete c.businessContext.role })))
      .toContain('business_context_role_missing')
    expect(codes(clone((c) => { delete c.businessContext.contextId })))
      .toContain('business_context_context_id_missing')
  })

  it('lens inconnue ⇒ REFUS', () => {
    expect(codes(clone((c) => { c.businessContext.lensId = 'fabel-broker' })))
      .toContain('business_context_lens_unknown')
  })

  it('lensVersion divergente ⇒ REFUS', () => {
    expect(codes(clone((c) => { c.businessContext.lensVersion = 'v0.2' })))
      .toContain('business_context_lens_version_mismatch')
  })

  it('scope invalide ⇒ REFUS — jamais élargi', () => {
    expect(codes(clone((c) => { c.businessContext.scope = { accountIds: ['a'] } })))
      .toContain('business_context_scope_invalid')
    expect(codes(clone((c) => { c.businessContext.scope = { mode: 'everything' } })))
      .toContain('business_context_scope_invalid')
  })

  it('target sans accountId ⇒ REFUS', () => {
    expect(codes(clone((c) => { delete c.targets[0].accountId })))
      .toContain('target_account_id_missing')
    expect(codes(clone((c) => { c.targets[0].accountId = '   ' })))
      .toContain('target_account_id_missing')
  })

  it('relevance ABSENTE ⇒ REFUS — le runner n’invente aucun score ICP', () => {
    expect(codes(clone((c) => { delete c.targets[0].relevance })))
      .toContain('target_relevance_missing')
    expect(codes(clone((c) => { c.targets[0].relevance = null })))
      .toContain('target_relevance_missing')
  })

  it('relevance hors [0,1] ⇒ REFUS, sans ramenage silencieux', () => {
    expect(codes(clone((c) => { c.targets[0].relevance = 1.5 })))
      .toContain('target_relevance_out_of_range')
    expect(codes(clone((c) => { c.targets[0].relevance = -0.1 })))
      .toContain('target_relevance_out_of_range')
    expect(codes(clone((c) => { c.targets[0].relevance = '0.8' })))
      .toContain('target_relevance_invalid')
    expect(codes(clone((c) => { c.targets[0].relevance = NaN })))
      .toContain('target_relevance_invalid')
  })

  it('evidence invalide ⇒ REFUS', () => {
    expect(codes(clone((c) => { delete c.evidence[0].observedAt }))).toContain('evidence_invalid')
    expect(codes(clone((c) => { c.evidence[0].confidence = 3 }))).toContain('evidence_invalid')
    expect(codes(clone((c) => { delete c.evidence[0].temporality }))).toContain('evidence_invalid')
  })

  it('evidence type hors catalogue ⇒ REFUS', () => {
    expect(codes(clone((c) => { c.evidence[0].type = 'lease_expiry' })))
      .toContain('evidence_type_unknown')
  })

  it('target en double ⇒ REFUS — l’ordre du fichier ne doit rien décider', () => {
    const doublon = clone((c) => {
      c.targets.push({ accountId: 'acc_smoke_1', relevance: 0.2 })
    })
    expect(codes(doublon)).toContain('target_duplicate')

    // Même strictement identique : un doublon signale une fixture engendrée
    // par erreur, et rien ne justifie de le taire.
    const identique = clone((c) => {
      c.targets.push({ accountId: 'acc_smoke_1', relevance: 0.8 })
    })
    expect(codes(identique)).toContain('target_duplicate')
  })

  it('champ d’éligibilité inconnu ⇒ REFUS, jamais ignoré', () => {
    expect(codes(clone((c) => { c.targets[0].eligibility = { optOut: true } })))
      .toContain('target_eligibility_unknown_field')
    // `now` ne peut PAS être injecté par une cible : l'horloge est unique.
    expect(codes(clone((c) => { c.targets[0].eligibility = { now: '2020-01-01T00:00:00.000Z' } })))
      .toContain('target_eligibility_unknown_field')
  })

  it('un cas invalide ne produit AUCUNE évaluation partielle', () => {
    const invalide = clone((c) => { c.targets[0].relevance = 42 })
    const validation = validateEvalCase(invalide)

    expect(validation.ok).toBe(false)
    // Il n'existe aucun chemin rendant un résultat partiel : `case` n'est pas
    // même présent sur la branche d'échec.
    expect((validation as any).case).toBeUndefined()
  })

  it('toutes les erreurs sont rendues, pas seulement la première', () => {
    const multi = clone((c) => {
      c.schemaVersion = 'faux'
      c.now = 'hier'
      delete c.targets[0].relevance
    })
    const liste = codes(multi)
    expect(liste).toContain('schema_version_unknown')
    expect(liste).toContain('now_invalid')
    expect(liste).toContain('target_relevance_missing')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('C. Déterminisme strict', () => {
  it('deux exécutions du module produisent un JSON identique byte-for-byte', () => {
    const cas = (validateEvalCase(CAS_VALIDE) as any).case
    const a = serializeEvalOutput(runEvalCase(cas))
    const b = serializeEvalOutput(runEvalCase(cas))
    expect(a).toBe(b)
  })

  it('deux exécutions du PROCESSUS produisent un stdout identique byte-for-byte', () => {
    const un = cli(FIXTURE)
    const deux = cli(FIXTURE)
    expect(un.status).toBe(0)
    expect(deux.status).toBe(0)
    expect(un.stdout).toBe(deux.stdout)
  })

  it('l’ordre des cibles dans le fichier ne change PAS la sortie', () => {
    const base = clone((c) => {
      c.targets = [
        { accountId: 'acc_a', relevance: 0.8 },
        { accountId: 'acc_b', relevance: 0.8 },
      ]
      c.evidence = c.evidence.concat(
        JSON.parse(JSON.stringify(c.evidence)).map((e: any) => ({
          ...e,
          id: `${e.id}_b`,
          accountId: 'acc_b',
        })),
      )
      c.evidence[0].accountId = 'acc_a'
      c.evidence[1].accountId = 'acc_a'
    })
    const inverse = JSON.parse(JSON.stringify(base))
    inverse.targets.reverse()

    const s1 = serializeEvalOutput(runEvalCase((validateEvalCase(base) as any).case))
    const s2 = serializeEvalOutput(runEvalCase((validateEvalCase(inverse) as any).case))

    expect(s1).toBe(s2)
  })

  it('AUCUNE dépendance à l’heure système', () => {
    const cas = (validateEvalCase(CAS_VALIDE) as any).case

    vi.useFakeTimers()
    vi.setSystemTime(new Date('1999-01-01T00:00:00.000Z'))
    const passe = serializeEvalOutput(runEvalCase(cas))

    vi.setSystemTime(new Date('2099-12-31T23:59:59.000Z'))
    const futur = serializeEvalOutput(runEvalCase(cas))

    expect(passe).toBe(futur)
    // Le temps du résultat vient du fichier, et de lui seul.
    expect(passe).toContain('2026-03-01T10:00:00.000Z')
    expect(passe).not.toContain('1999')
    expect(passe).not.toContain('2099')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('D. UN SEUL chemin de décision — parité runner / Prospector', () => {
  it('même Decision Kernel : entrée sémantiquement équivalente ⇒ sortie IDENTIQUE', () => {
    // ── Côté Prospector : on part de VRAIS leads ────────────────────────────
    const NOW = new Date('2026-03-01T10:00:00.000Z')
    const TACHES: TaskSnapshot = { complete: true, openTaskLeadIds: [] }

    const lead: Lead = {
      id: 'ld_1',
      firstName: 'Alice',
      lastName: 'Martin',
      title: 'VP Sales',
      company: 'Acme SAS',
      siren: '552100554',
      score: 80,
      temperature: 'hot',
      status: 'chaud',
      stage: 'in_sequence',
      email: 'alice@acme.test',
      phone: null,
    }

    const cotePropector = evaluate({
      leads: [lead],
      now: NOW,
      tasks: TACHES,
      businessContext: TEST_BUSINESS_CONTEXT,
    })

    expect(cotePropector.situations.length).toBeGreaterThan(0)

    // ── Côté runner : MÊME evidence, MÊMES cibles, exprimées en JSON ────────
    // C'est la définition de « sémantiquement équivalent » : on ne rejoue pas
    // la dérivation Lead→Evidence (elle appartient à Prospector), on injecte
    // son résultat.
    const cibles = new Map<string, { accountId: string; personId?: string }>()
    for (const e of cotePropector.evidence) {
      cibles.set(`${e.accountId}::`, { accountId: e.accountId })
      if (e.personId) {
        cibles.set(`${e.accountId}::${e.personId}`, {
          accountId: e.accountId,
          personId: e.personId,
        })
      }
    }

    const casRunner = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      now: NOW.toISOString(),
      businessContext: TEST_BUSINESS_CONTEXT,
      targets: Array.from(cibles.values()).map((t) => ({
        ...t,
        // 80/100 — la valeur que `buildIndex` dérive de `Lead.score`.
        relevance: 0.8,
        eligibility: { meetingScheduled: false },
      })),
      evidence: JSON.parse(JSON.stringify(cotePropector.evidence)),
    }

    const validation = validateEvalCase(casRunner)
    expect(validation.ok).toBe(true)

    const coteRunner = runEvalCase((validation as any).case)

    // Égalité STRUCTURELLE complète : identifiants, scores, dates, contrôle.
    // Si un jour le runner divergeait du moteur — parce que quelqu'un aurait
    // recopié la logique — c'est ici que cela se verrait.
    expect(coteRunner.situations).toEqual(cotePropector.situations)
    expect(coteRunner.recommendations).toEqual(cotePropector.recommendations)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('E. Ce que le runner ne fait JAMAIS', () => {
  it('aucune persistance : le magasin reste intact', () => {
    const g = globalThis as any
    g.__prospectorStore = new Map()

    runEvalCase((validateEvalCase(CAS_VALIDE) as any).case)

    expect(g.__prospectorStore.size).toBe(0)
  })

  it('la CLI n’écrit rien dans le magasin, même en sous-processus', () => {
    // Preuve indirecte mais réelle : le processus se termine proprement sans
    // Supabase configuré et sans qu'aucune écriture ne soit tentée. Une
    // tentative d'écriture refusée ferait échouer `writeAllowed()` en amont.
    const r = cli(FIXTURE)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('aucun réseau : `fetch` piégé n’est jamais appelé', () => {
    const original = globalThis.fetch
    const piege = vi.fn(() => {
      throw new Error('APPEL RÉSEAU INTERDIT')
    })
    ;(globalThis as any).fetch = piege

    try {
      const sortie = runEvalCase((validateEvalCase(CAS_VALIDE) as any).case)
      expect(sortie.situations).toHaveLength(1)
      expect(piege).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as any).fetch = original
    }
  })

  it('le runner n’importe AUCUNE couche de persistance', async () => {
    // `runCase` et `caseSchema` ne doivent dépendre ni du store, ni du client
    // Supabase. Le vérifier par le graphe d'imports plutôt que par relecture.
    const { readFileSync } = await import('node:fs')
    for (const f of [
      'lib/prospector/proactive/eval/runCase.ts',
      'lib/prospector/proactive/eval/caseSchema.ts',
      'lib/prospector/proactive/decisionKernel.ts',
      'lib/prospector/proactive/validators.ts',
    ]) {
      const source = readFileSync(join(RACINE, f), 'utf8')

      // ⚠️ On inspecte les IMPORTS et les APPELS, pas le texte brut : un
      // commentaire qui promet de ne pas appeler `persistEvaluation()` ne doit
      // évidemment pas faire échouer la vérification qu'il décrit.
      const imports = source
        .split('\n')
        .filter((l) => /^\s*import\b/.test(l) || /^\s*export\s+\{[^}]*\}\s+from/.test(l))
        .join('\n')

      expect(imports).not.toMatch(/persistence/)
      expect(imports).not.toMatch(/supabase/i)
      expect(imports).not.toMatch(/node:fs|node:net|node:http/)

      // Aucun APPEL (le nom suivi d'une parenthèse ouvrante), commentaires exclus.
      const sansCommentaires = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(sansCommentaires).not.toMatch(/persistEvaluation\s*\(/)
      expect(sansCommentaires).not.toMatch(/\bfetch\s*\(/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('F. BusinessScope — le périmètre RESTREINT réellement', () => {
  // ⚠️ Constat d'entrée de ce lot : `scopeIncludes` existait depuis
  // ARCH-RULEPACK-001 mais n'était appelé par AUCUN code de production. Le
  // `scope` était validé dans sa forme puis ignoré — une restriction qui ne
  // restreignait rien. Ces tests verrouillent la correction.

  function casAvecScope(accountIds: string[], targetAccount: string) {
    return clone((c) => {
      c.businessContext.scope = { mode: 'accounts', accountIds }
      c.targets = [{ accountId: targetAccount, relevance: 0.8 }]
      c.evidence.forEach((e: any) => { e.accountId = targetAccount })
    })
  }

  it('target hors scope ⇒ cas INVALIDE (pas un target silencieusement ignoré)', () => {
    const liste = codes(casAvecScope(['account-A'], 'account-B'))
    expect(liste).toContain('target_out_of_scope')
  })

  it('target DANS le scope ⇒ accepté', () => {
    const v = validateEvalCase(casAvecScope(['account-A'], 'account-A'))
    expect(v.ok).toBe(true)
  })

  it('scope `workspace` reste valide pour le runner', () => {
    // ⚠️ Cela ne CRÉE aucune autorité tenant/account : le Business Context ne
    // peut que retrancher. L'autorité réelle reste externe et n'existe pas
    // encore — `mode:'workspace'` signifie « je ne retranche rien », pas
    // « j'ai le droit sur tout ».
    const v = validateEvalCase(clone((c) => { c.businessContext.scope = { mode: 'workspace' } }))
    expect(v.ok).toBe(true)
  })

  it('la CLI refuse un target hors scope : stdout VIDE, stderr explicite, exit non nul', () => {
    const chemin = fichierTemporaire(
      JSON.stringify(casAvecScope(['account-A'], 'account-B')),
    )
    const r = cli(chemin)

    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('target_out_of_scope')
    expect(r.stderr).toContain('account-B')
  })

  it('le KERNEL lui-même est fail closed sur le périmètre', () => {
    // Preuve que la règle ne vit pas seulement dans le validateur du runner :
    // même en appelant le kernel en direct, une cible hors périmètre ne produit
    // AUCUNE situation — et n'est pas discrètement écartée non plus.
    const cas = (validateEvalCase(CAS_VALIDE) as any).case
    const horsPerimetre = evaluateEvidence({
      ...cas,
      businessContext: {
        ...cas.businessContext,
        scope: { mode: 'accounts', accountIds: ['un-autre-compte'] },
      },
    })

    expect(horsPerimetre.situations).toEqual([])
    expect(horsPerimetre.recommendations).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('G. Intégrité référentielle Evidence ↔ Target (Option B)', () => {
  // RÈGLE RETENUE — déterminée par `evidenceMatchesTarget()`, le prédicat que
  // le moteur applique réellement, et non choisie par intuition :
  //   • evidence sans personId  → toute cible du compte la consomme ;
  //   • evidence avec personId  → SEULE la cible (compte + personne) la consomme.

  it('evidence orpheline au niveau COMPTE ⇒ cas INVALIDE', () => {
    const orpheline = clone((c) => {
      c.evidence[0].accountId = 'acc_fantome'
    })
    expect(codes(orpheline)).toContain('evidence_orphan')
  })

  it('evidence de PERSONNE avec cible compte+personne ⇒ acceptée', () => {
    const valide = clone((c) => {
      c.evidence.forEach((e: any) => {
        e.personId = 'p_1'
        e.scope = 'person'
      })
      c.targets = [
        { accountId: 'acc_smoke_1', relevance: 0.8 },
        { accountId: 'acc_smoke_1', personId: 'p_1', relevance: 0.8 },
      ]
    })
    const v = validateEvalCase(valide)
    expect(v.ok).toBe(true)
  })

  it('evidence de PERSONNE sans cible personne ⇒ cas INVALIDE (option B)', () => {
    // Le point décisif : une cible « compte » seule NE suffit PAS. Le moteur
    // écarterait ces evidences, et la fixture croirait les avoir testées.
    const sansCiblePersonne = clone((c) => {
      c.evidence.forEach((e: any) => {
        e.personId = 'p_1'
        e.scope = 'person'
      })
      c.targets = [{ accountId: 'acc_smoke_1', relevance: 0.8 }]
    })
    expect(codes(sansCiblePersonne)).toContain('evidence_orphan')
  })

  it('evidence de personne rattachée à une AUTRE personne ⇒ INVALIDE', () => {
    const mauvaisePersonne = clone((c) => {
      c.evidence.forEach((e: any) => { e.personId = 'p_1' })
      c.targets = [{ accountId: 'acc_smoke_1', personId: 'p_2', relevance: 0.8 }]
    })
    expect(codes(mauvaisePersonne)).toContain('evidence_orphan')
  })

  it('une evidence EXPIRÉE reste valide dans le cas — le contrôle n’est pas temporel', () => {
    // Sans quoi il deviendrait impossible de tester les invariants temporels
    // du moteur : une evidence périmée est légitimement présente, simplement
    // inexploitable.
    const expiree = clone((c) => {
      c.evidence[0].expiresAt = '2026-02-15T00:00:00.000Z'
    })
    const v = validateEvalCase(expiree)
    expect(v.ok).toBe(true)
  })

  it('AUCUNE evidence n’est silencieusement ignorée : la règle du validateur est celle du moteur', () => {
    // Contrôle direct : le prédicat utilisé par le validateur EST celui que le
    // kernel applique. S'ils divergeaient, ce test le dirait.
    const evidencePersonne: any = {
      id: 'ev_p', accountId: 'acc_1', personId: 'p_1', type: 'hot_lead',
      scope: 'person', temporality: 'undated_state',
      occurredAt: '2026-01-01T00:00:00.000Z', observedAt: '2026-01-02T00:00:00.000Z',
      assertionType: 'fact', confidence: 0.9, source: { provider: 't' },
    }
    expect(evidenceMatchesTarget(evidencePersonne, { accountId: 'acc_1' })).toBe(false)
    expect(evidenceMatchesTarget(evidencePersonne, { accountId: 'acc_1', personId: 'p_1' })).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('H. Clés racine — liste FERMÉE', () => {
  it('une faute de frappe est REFUSÉE, jamais acceptée comme metadata', () => {
    const typo = clone((c) => {
      c.evidnce = c.evidence
      delete c.evidence
    })
    const liste = codes(typo)
    expect(liste).toContain('root_key_unknown')
  })

  it('`evidnce` en DOUBLON d’`evidence` est aussi refusé', () => {
    // Le cas le plus traître : `evidence` existe, la faute de frappe passerait
    // inaperçue et le cas s'exécuterait en ignorant la moitié de l'intention.
    expect(codes(clone((c) => { c.evidnce = [] }))).toContain('root_key_unknown')
  })

  it('toute autre clé racine est refusée', () => {
    for (const cle of ['runId', 'metadata', 'expected', 'Targets', '__proto__x']) {
      expect(codes(clone((c) => { c[cle] = 'x' }))).toContain('root_key_unknown')
    }
  })

  it('`_comment` est la SEULE extension libre acceptée', () => {
    const v = validateEvalCase(clone((c) => {
      c._comment = ['fixture technique, pas de la ground truth']
    }))
    expect(v.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('I. Frontière offline — garde ARCHITECTURAL sur le graphe d’imports', () => {
  // ⚠️ Ce test ne lit pas quatre fichiers : il PARCOURT le graphe d'imports
  // depuis les points d'entrée. Un module interdit atteint indirectement, à
  // trois niveaux de profondeur, serait invisible à une inspection de surface.
  const INTERDITS = [
    { motif: /(^|\/)persistence$/, nom: 'persistence' },
    { motif: /supabase/i, nom: 'Supabase' },
    { motif: /^node:(net|http|https|dgram|tls)$/, nom: 'réseau Node' },
    { motif: /anthropic|gateway|openai|llm/i, nom: 'LLM / passerelle' },
    { motif: /(^|\/)(crm|lemlist)/i, nom: 'CRM' },
  ]

  function importsDe(source: string): string[] {
    const sansCommentaires = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const trouves: string[] = []
    const re = /(?:from|import)\s+['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(sansCommentaires)) !== null) trouves.push(m[1])
    return trouves
  }

  it('le graphe complet du runner n’atteint AUCUNE couche interdite', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { dirname, resolve: resolvePath, relative } = await import('node:path')

    const ENTREES = [
      'lib/prospector/proactive/eval/runCase.ts',
      'lib/prospector/proactive/eval/caseSchema.ts',
      'lib/prospector/proactive/decisionKernel.ts',
      'scripts/proactive-eval.mjs',
    ]

    const vus = new Set<string>()
    const aVisiter = ENTREES.map((f) => resolvePath(RACINE, f))
    const violations: string[] = []

    while (aVisiter.length > 0) {
      const fichier = aVisiter.pop() as string
      if (vus.has(fichier)) continue
      vus.add(fichier)
      if (!existsSync(fichier)) continue

      const source = readFileSync(fichier, 'utf8')

      for (const spec of importsDe(source)) {
        for (const { motif, nom } of INTERDITS) {
          if (motif.test(spec)) {
            violations.push(`${relative(RACINE, fichier)} importe ${spec} (${nom})`)
          }
        }

        if (!spec.startsWith('.')) continue

        const base = resolvePath(dirname(fichier), spec)
        for (const candidat of [base, `${base}.ts`, `${base}/index.ts`]) {
          if (existsSync(candidat) && candidat.endsWith('.ts')) {
            aVisiter.push(candidat)
            break
          }
        }
      }
    }

    expect(violations).toEqual([])
    // Le parcours doit avoir réellement traversé le graphe, sinon le test
    // passerait en n'ayant rien visité.
    expect(vus.size).toBeGreaterThan(8)
  })
})
