// QUICK-SIGNAL-SEARCH-BOUNDED-001 — L'ACQUISITION TIENT DANS SON BUDGET.
//
// ⚠️ CE QUE CES TESTS SONT. Des tests d'intégration de route et de module :
// seule la frontière RÉSEAU est doublée (`fetch` global). Le budget, la boucle
// `pause_turn`, `searchSignals`, la route et le registre de candidats sont le
// code de PRODUCTION réel.
//
// Aucun réseau. L'horloge est injectée là où le temps est le sujet, pour que le
// dépassement de délai soit DÉTERMINISTE et non dépendant de la machine.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  startAcquisitionBudget,
  expiredBudget,
  QUICK_SEARCH_BUDGET_MS,
  MIN_TRANSPORT_MS,
  QUICK_SEARCH_MAX_PROVIDER_CALLS,
  QUICK_SEARCH_MAX_WEB_SEARCHES,
  QUICK_SEARCH_MAX_WEB_FETCHES,
  QUICK_SEARCH_MAX_FETCH_CONTENT_TOKENS,
} from '../lib/prospector/acquisitionBudget'

/**
 * Plafond monétaire GÉNÉREUX pour les tests qui n'étudient PAS l'argent.
 *
 * ⚠️ Un budget sans plafond REFUSE désormais toute émission (fail closed). Les
 * tests de temps et de bornes doivent donc en fournir un, faute de quoi ils
 * mesureraient le refus monétaire au lieu de ce qu'ils prétendent mesurer.
 */
const PLAFOND_LARGE = 10_000_000n   // 10 $ en µUSD

/** Budget de test complet : temps + compteurs de PRODUCTION + argent. */
function budgetTest(ms = 45_000, now = horloge, maxMicros: bigint | null = PLAFOND_LARGE) {
  return startAcquisitionBudget(ms, now, {
    providerCalls: QUICK_SEARCH_MAX_PROVIDER_CALLS,
    webSearches: QUICK_SEARCH_MAX_WEB_SEARCHES,
    webFetches: QUICK_SEARCH_MAX_WEB_FETCHES,
    maxMicros,
  })
}

/**
 * Budget aux COMPTEURS D'OUTILS DÉLIBÉRÉMENT LARGES.
 *
 * ⚠️ POURQUOI IL EXISTE, ET CE QU'IL NE DOIT PAS MASQUER. Avec les plafonds de
 * production, la réservation est PESSIMISTE : chaque requête réserve les
 * `max_uses` DÉCLARÉS (10 recherches), et le plafond agrégé vaut 10 — donc une
 * seule requête fournisseur est possible, et toute continuation est refusée sur
 * `web_searches` AVANT d'atteindre la logique de délai.
 *
 * C'est le comportement voulu en production. Mais pour tester le mécanisme de
 * DÉLAI ou la LIMITE DE TOURS, il faut écarter le compteur qui préempte, sinon
 * le test mesurerait autre chose que ce qu'annonce son intitulé. Ce budget-ci
 * isole donc le mécanisme sous test ; les plafonds agrégés ont leurs propres
 * tests dédiés, plus bas.
 */
function budgetSansPlafondOutils(ms = 45_000) {
  return startAcquisitionBudget(ms, horloge, {
    providerCalls: 99, webSearches: 9_999, webFetches: 9_999, maxMicros: PLAFOND_LARGE,
  })
}

const etat = vi.hoisted(() => ({
  /** Requêtes sortantes observées : { url, aSignal, timeoutMs } */
  appels: [] as { url: string; aSignal: boolean }[],
  /** Corps de réponse Anthropic successifs. */
  reponses: [] as any[],
  /** Retard simulé (ms) ajouté à l'horloge à chaque appel Anthropic. */
  coutParAppel: 0,
  /** Horloge virtuelle. */
  maintenant: 1_000_000,
  exaDocs: [] as any[],
  leads: [] as any[],
  /** Clés configurées. Pilote `signalsMode()` — jamais un `spyOn` qui fuirait
   *  d'un test à l'autre et changerait le mode d'acquisition en silence. */
  cles: { ANTHROPIC_API_KEY: 'k-test' } as Record<string, string>,
}))

const horloge = () => etat.maintenant

// ⚠️ `Date.now` EST VIRTUALISÉ POUR TOUS. La route crée son propre budget à
// l'entrée du handler : sans cela, son échéance serait pilotée par l'horloge
// réelle et le dépassement de délai ne serait pas testable — ni déterministe.
vi.stubGlobal('Date', class extends Date {
  static now() { return etat.maintenant }
} as any)

vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => {},
  getKey: (n: string) => etat.cles[n] || '',
}))

vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveTenantFromRequest: async () => ({ id: 'ws_quick', kind: 'client' }),
}))

vi.mock('../lib/supabase/store', () => ({
  getItem: async () => null,
  getItemStrict: async () => ({ ok: true, value: null }),
  listItems: async () => [],
  listItemsStrict: async () => ({ ok: true, values: [] }),
  upsertItem: async (kind: string, id: string) => { etat.leads.push({ kind, id }); return true },
}))

// Frontière réseau UNIQUE. On enregistre si un `AbortSignal` accompagne l'appel :
// c'est précisément ce dont l'absence causait le 504.
vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
  const u = String(url)
  etat.appels.push({ url: u, aSignal: !!init?.signal })

  if (u.includes('api.exa.ai')) {
    return { ok: true, status: 200, json: async () => ({ results: etat.exaDocs }) } as any
  }
  // Anthropic : chaque transport consomme du temps sur l'horloge virtuelle.
  etat.maintenant += etat.coutParAppel
  const corps = etat.reponses.shift() ?? { content: [], stop_reason: 'end_turn', usage: {} }
  return { ok: true, status: 200, json: async () => corps, text: async () => '' } as any
}))

import { searchSignals, QUICK_SEARCH_MAX_HITS, EXA_TIMEOUT_MS } from '../lib/prospector/signals'
import handler from '../pages/api/signals/search'

const TENANT: any = { id: 'ws_quick', kind: 'client' }

/** Réponse Claude COMPLÈTE portant `n` entreprises exploitables. */
function reponseComplete(n = 2) {
  const hits = Array.from({ length: n }, (_, i) => ({
    company: `Acme ${i}`, signalType: 'levée', detail: 'Série A', icebreaker: '',
    sourceUrl: `https://acme${i}.fr/presse`, claimNature: 'EVENT',
    eventStatus: 'COMPLETED', eventDate: '2026-08-12', eventDatePrecision: 'DAY',
  }))
  return {
    content: [{ type: 'text', text: JSON.stringify({ hits }) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
  }
}

/** Réponse Claude INTERROMPUE portant du JSON plausible mais incomplet. */
function reponsePause() {
  return {
    content: [{ type: 'text', text: JSON.stringify({ hits: [{ company: 'Fantome', signalType: 'levée', sourceUrl: 'https://fantome.fr/x', detail: '', icebreaker: '', claimNature: 'EVENT', eventStatus: 'COMPLETED', eventDate: '2026-08-12', eventDatePrecision: 'DAY' }] }) }],
    stop_reason: 'pause_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
  }
}

async function appelerRoute(body: any) {
  const req: any = { method: 'POST', body, query: {}, cookies: {} }
  let status = 0
  let json: any = null
  const res: any = {
    status(c: number) { status = c; return res },
    json(b: any) { json = b; return res },
  }
  await handler(req, res)
  return { status, body: json }
}

beforeEach(() => {
  etat.appels = []
  etat.reponses = []
  etat.coutParAppel = 0
  etat.maintenant = 1_000_000
  etat.exaDocs = []
  etat.leads = []
  etat.cles = { ANTHROPIC_API_KEY: 'k-test' }   // mode 'claude-web' par défaut
  // La route lit son plafond monétaire dans l'ENVIRONNEMENT (jamais la base).
  process.env.QUICK_SEARCH_MAX_MICROS = '10000000'
  ;(fetch as any).mockClear()
})

// ── LE BUDGET LUI-MÊME ──────────────────────────────────────────────────────

describe('QUICK-SIGNAL-SEARCH-BOUNDED-001 — budget d’acquisition', () => {
  it('l’échéance est ABSOLUE : elle ne se recharge pas d’une étape à l’autre', () => {
    // ⚠️ C'est la propriété qui distingue un budget d'un simple timeout répété.
    // Une durée relative recalculée à chaque appel laisserait le total dériver —
    // exactement le défaut d'origine (4 × 50 s sous une fenêtre de 60 s).
    let t = 0
    const b = startAcquisitionBudget(45_000, () => t)
    expect(b.remainingMs()).toBe(45_000)
    t = 20_000
    expect(b.remainingMs()).toBe(25_000)
    t = 40_000
    expect(b.remainingMs()).toBe(5_000)
    expect(b.deadlineAt).toBe(45_000)   // inchangée
  })

  it('le budget restant PLAFONNE le timeout de transport, jamais l’inverse', () => {
    let t = 0
    const b = startAcquisitionBudget(45_000, () => t)
    t = 40_000                                  // il reste 5 s
    // Le plafond historique du transport est 50 s : il ne doit pas l'emporter.
    expect(b.transportTimeoutMs(50_000)).toBe(5_000)
    expect(b.transportTimeoutMs()).toBe(5_000)
  })

  it('un budget épuisé refuse tout engagement', () => {
    const b = expiredBudget()
    expect(b.expired()).toBe(true)
    expect(b.canAfford()).toBe(false)
    expect(b.remainingMs()).toBe(0)
  })

  it('`canAfford` refuse AVANT de dépenser, pas après', () => {
    let t = 0
    const b = startAcquisitionBudget(45_000, () => t)
    t = 45_000 - MIN_TRANSPORT_MS + 1           // juste en dessous du seuil
    expect(b.canAfford()).toBe(false)
    expect(b.expired()).toBe(false)             // du temps reste, mais pas assez
  })

  it('la fenêtre laisse une marge réelle sous la limite serverless de 60 s', () => {
    // Les 15 s couvrent le travail AUTOUR de l'acquisition — tenant, keystore,
    // registerCandidates, sérialisation — plus le démarrage à froid.
    expect(QUICK_SEARCH_BUDGET_MS).toBeLessThanOrEqual(45_000)
    expect(60_000 - QUICK_SEARCH_BUDGET_MS).toBeGreaterThanOrEqual(15_000)
  })
})

// ── LES TRANSPORTS SONT ABORTABLES ──────────────────────────────────────────

describe('QUICK-SIGNAL-SEARCH-BOUNDED-001 — transports bornés', () => {
  it('le transport Anthropic brut part AVEC un AbortSignal', async () => {
    // ⚠️ `rawPost` est le chemin du mode OFF, et OFF est le DÉFAUT
    // (`budgetMode.ts:38`). C'est donc le chemin le plus probable en production,
    // et c'était le seul totalement non borné.
    etat.reponses = [reponseComplete()]
    // ⚠️ BUDGET EXPLICITE. `searchSignals` n'en fabrique plus : la politique de
    // Quick Search appartient à la route, pas au moteur de signaux.
    await searchSignals(
      TENANT, 'levées Série A Paris', QUICK_SEARCH_MAX_HITS, { months: 1 } as any,
      budgetTest(),
    )

    const anthropic = etat.appels.filter((a) => a.url.includes('anthropic'))
    expect(anthropic.length).toBeGreaterThan(0)
    for (const a of anthropic) expect(a.aSignal).toBe(true)
  })

  it('le transport Exa part AVEC un AbortSignal', async () => {
    etat.exaDocs = [{ title: 'x', url: 'https://acme.fr/p', text: 'Série A' }]
    etat.reponses = [reponseComplete()]
    // `searchExa` n'est atteint qu'en mode exa+claude ; on l'appelle directement
    // pour prouver le contrat de transport sans dépendre de la configuration.
    etat.cles.EXA_API_KEY = 'k-exa'
    const { searchExa } = await import('../lib/prospector/exa')
    await searchExa('thèse', 3, { months: 1, timeoutMs: 5_000 })

    const exa = etat.appels.filter((a) => a.url.includes('exa.ai'))
    expect(exa.length).toBe(1)
    expect(exa[0].aSignal).toBe(true)
  })

  it('le chemin COMPTABLE reçoit aussi le plafond du budget', async () => {
    // ⚠️ DEUX CHEMINS DE TRANSPORT, DEUX FOIS LA MÊME GARDE. `rawPost` sert le
    // mode OFF ; `anthropicPost` sert OBSERVE/ENFORCE. Ne borner que le premier
    // laisserait le second s'accorder les 50 s de `REQUEST_TIMEOUT_MS` dans une
    // fenêtre de 45 s — le dépassement reviendrait par l'autre porte.
    //
    // Garde STRUCTURELLE : le mode comptable exige une base et des réservations
    // que ces tests ne simulent pas ; on vérifie donc que le plafond du budget
    // est bien celui qui est CÂBLÉ, et jamais la constante historique seule.
    const fs = await import('fs')
    const code = fs.readFileSync('lib/prospector/llm.ts', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')

    // Aucun transport ne s'autorise la constante historique sans passer par le budget.
    expect(code).not.toMatch(/AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/)
    expect(code).toMatch(/AbortSignal\.timeout\(timeoutMs \?\? REQUEST_TIMEOUT_MS\)/)
    // Et le plafond dérive bien du budget de l'appelant.
    expect(code).toMatch(/budget\.transportTimeoutMs\(REQUEST_TIMEOUT_MS\)/)
  })

  it('Exa a son propre plafond, plus court que la fenêtre entière', () => {
    // Exa précède Claude en séquentiel : sans plafond distinct, un fournisseur
    // lent mangerait la fenêtre et ne laisserait rien au raisonnement.
    expect(EXA_TIMEOUT_MS).toBeLessThan(QUICK_SEARCH_BUDGET_MS)
  })
})

// ── LA RÈGLE DE VÉRITÉ ──────────────────────────────────────────────────────

describe('QUICK-SIGNAL-SEARCH-BOUNDED-001 — un tour inachevé n’est pas un résultat', () => {
  it('une reprise `pause_turn` n’est PAS engagée sans budget suffisant', async () => {
    // Chaque transport coûte 20 s : après deux, il ne reste pas de quoi en payer
    // un troisième dans une fenêtre de 45 s.
    etat.coutParAppel = 20_000
    etat.reponses = [reponsePause(), reponsePause(), reponseComplete()]

    const r = await searchSignals(
      TENANT, 'levées Série A Paris', QUICK_SEARCH_MAX_HITS, { months: 1 } as any,
      budgetSansPlafondOutils(),
    )

    expect(r.state).toBe('TIMEOUT')
    // La troisième réponse (complète) n'a jamais été demandée.
    expect(etat.appels.filter((a) => a.url.includes('anthropic')).length).toBe(2)
    expect(etat.reponses.length).toBe(1)
  })

  it('le JSON d’un tour interrompu n’est JAMAIS transformé en candidats', async () => {
    // ⚠️ LA GARDE LA PLUS IMPORTANTE. La réponse interrompue contient un JSON
    // syntaxiquement VALIDE portant une entreprise « Fantome ». S'il était parsé,
    // elle deviendrait un SignalHit, puis un candidat serveur, puis promouvable
    // en fait — sur la foi d'un tour que l'API a elle-même déclaré inachevé.
    etat.coutParAppel = 20_000
    etat.reponses = [reponsePause(), reponsePause()]

    const r = await searchSignals(
      TENANT, 'levées Série A Paris', QUICK_SEARCH_MAX_HITS, { months: 1 } as any,
      budgetSansPlafondOutils(),
    )

    expect(r.state).toBe('TIMEOUT')
    expect(r.hits).toEqual([])
    expect(JSON.stringify(r)).not.toContain('Fantome')
  })

  it('DÉLAI DÉPASSÉ != AUCUN SIGNAL — les deux états sont distincts', async () => {
    etat.coutParAppel = 40_000
    etat.reponses = [reponsePause(), reponseComplete()]
    const expire = await searchSignals(
      TENANT, 'thèse', QUICK_SEARCH_MAX_HITS, { months: 1 } as any,
      budgetSansPlafondOutils(),
    )
    expect(expire.state).toBe('TIMEOUT')

    // Une recherche qui aboutit réellement sans rien trouver dit COMPLETE.
    etat.maintenant = 1_000_000; etat.coutParAppel = 0
    etat.reponses = [{ content: [{ type: 'text', text: '{"hits":[]}' }], stop_reason: 'end_turn', usage: {} }]
    const vide = await searchSignals(TENANT, 'thèse', QUICK_SEARCH_MAX_HITS, { months: 1 } as any)
    expect(vide.state).toBe('COMPLETE')
    expect(vide.hits).toEqual([])

    expect(expire.state).not.toBe(vide.state)
  })

  it('le repli global n’est pas engagé sans budget', async () => {
    // Le repli est un transport de plus : l'engager sans budget consommerait le
    // reste et échouerait quand même.
    etat.coutParAppel = 44_000
    etat.reponses = [
      { content: [{ type: 'text', text: '{"hits":[]}' }], stop_reason: 'end_turn', usage: {} },
      reponseComplete(),
    ]

    await searchSignals(
      TENANT, 'thèse', QUICK_SEARCH_MAX_HITS, { months: 1 } as any,
      budgetSansPlafondOutils(),
    )

    // Une seule passe : le repli n'a pas été tenté.
    expect(etat.appels.filter((a) => a.url.includes('anthropic')).length).toBe(1)
  })
})

// ── LE PÉRIMÈTRE DE LA QUICK SEARCH ─────────────────────────────────────────

describe('QUICK-SIGNAL-SEARCH-BOUNDED-001 — périmètre borné', () => {
  it('la Quick Search ne demande JAMAIS 25 entreprises en une passe', async () => {
    // ⚠️ 25 était le pire réglage sur le chemin le plus court : à `months = 1`,
    // `per = max(8, ceil(25/1)) = 25`. « Réduire la période » demandait donc
    // PLUS de travail — et c'est pourquoi le conseil affiché était faux.
    expect(QUICK_SEARCH_MAX_HITS).toBeLessThanOrEqual(10)
    expect(QUICK_SEARCH_MAX_HITS).toBeGreaterThanOrEqual(8)

    etat.reponses = [reponseComplete()]
    await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    const corps = (fetch as any).mock.calls
      .map((c: any[]) => String(c[1]?.body || ''))
      .filter((b: string) => b.includes('Thèse'))
    expect(corps.length).toBeGreaterThan(0)
    // L'instruction JSON envoyée au modèle ne demande pas 25 entreprises.
    for (const b of corps) expect(b).not.toMatch(/25 entreprises/)
  })

  it('la route ne code plus 25 en dur', async () => {
    const fs = await import('fs')
    const code = fs.readFileSync('pages/api/signals/search.ts', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toMatch(/searchSignals\([^)]*,\s*25\s*,/)
    expect(code).toMatch(/QUICK_SEARCH_MAX_HITS/)
  })
})

// ── LA ROUTE ET LE REGISTRE DE CANDIDATS ────────────────────────────────────

describe('QUICK-SIGNAL-SEARCH-BOUNDED-001 — contrat de la route', () => {
  // ── A. ÉCHÉANCE DÉPASSÉE ────────────────────────────────────────────────
  it('échéance dépassée → TIMEOUT, et ZÉRO candidat créé', async () => {
    // ⚠️ Une couverture inconnue ne doit rien figer dans le registre serveur :
    // un candidat enregistré devient promouvable en fait.
    //
    // L'horloge est virtuelle et la route crée SON budget à l'entrée : chaque
    // transport consomme 40 s, donc le second ne peut plus être payé.
    etat.coutParAppel = 40_000
    etat.reponses = [reponsePause(), reponseComplete()]

    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    expect(r.status).toBe(200)
    expect(r.body.state).toBe('TIMEOUT')
    expect(r.body.hits).toEqual([])
    expect(etat.leads.filter((l) => l.kind === 'proactive_signal_candidate')).toEqual([])
  })

  // ── B. LIMITE DE TOURS, DU TEMPS RESTANT ────────────────────────────────
  it('quatre reprises RAPIDES → arrêt CONTRÔLÉ, jamais TIMEOUT', async () => {
    // ⚠️ LA DISTINCTION QUE CE TEST PROTÈGE. Quatre `pause_turn` instantanés
    // épuisent la boucle en quelques millisecondes, avec 45 s encore au compteur.
    // Ce n'est PAS l'horloge qui a parlé : c'est une conversation qui ne
    // converge pas. Annoncer « réessaie dans quelques instants » enverrait
    // attendre un problème que l'attente ne résout pas.
    etat.coutParAppel = 0
    etat.reponses = [reponsePause(), reponsePause(), reponsePause(), reponsePause()]

    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    // ⚠️ DEPUIS LES PLAFONDS DE COÛT, la deuxième requête est refusée sur le
    // compteur agrégé de recherches AVANT d'atteindre la limite de tours : la
    // route rend donc `BUDGET_EXCEEDED`. Ce qui compte ici reste vrai et
    // inchangé — ce n'est PAS un délai dépassé, et rien n'est fabriqué.
    expect(r.body.state).toBe('BUDGET_EXCEEDED')
    expect(r.body.state).not.toBe('TIMEOUT')
    expect(r.body.hits).toEqual([])
    // Et le JSON du tour inachevé n'a jamais été lu.
    expect(JSON.stringify(r.body)).not.toContain('Fantome')
    expect(etat.leads.filter((l) => l.kind === 'proactive_signal_candidate')).toEqual([])
  })

  it('une Quick Search 3 mois n’exécute PAS trois passes mensuelles', async () => {
    // ⚠️ LE DÉFAUT FERMÉ : le balayage mensuel pouvait SAUTER des tranches faute
    // de budget et rendre quand même COMPLETE — une couverture partielle
    // présentée comme entière. La Quick Search est désormais UNE acquisition
    // bornée ; la fraîcheur reste portée par la thèse.
    etat.coutParAppel = 0
    etat.reponses = [reponseComplete(2)]

    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 3 })

    expect(r.body.state).toBe('COMPLETE')
    expect(etat.appels.filter((a) => a.url.includes('anthropic')).length).toBe(1)
    // La fenêtre demandée survit dans la thèse envoyée au modèle.
    expect(r.body.thesis).toContain('3 derniers mois')
  })

  it('budget à zéro AVANT l’appel → AUCUNE requête réseau', async () => {
    // ⚠️ « budget existant + aucun transport possible » ne doit produire NI un
    // appel non borné, NI un appel du tout.
    etat.reponses = [reponseComplete()]
    const r = await searchSignals(
      TENANT, 'thèse', QUICK_SEARCH_MAX_HITS, { months: 1 } as any,
      expiredBudget(),
    )
    expect(r.state).toBe('TIMEOUT')
    expect(etat.appels.length).toBe(0)
  })

  it('un appel BUDGÉTÉ ne part JAMAIS sans AbortSignal', async () => {
    // ⚠️ L'INVARIANT CENTRAL DE P0-2, sur toutes les requêtes observées d'un
    // parcours budgété : soit un signal strictement positif, soit rien du tout.
    // `timeoutMs = 0` ne doit jamais se lire « aucun timeout demandé ».
    etat.coutParAppel = 1_000
    etat.reponses = [reponseComplete()]
    await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    expect(etat.appels.length).toBeGreaterThan(0)
    for (const a of etat.appels) expect(a.aSignal).toBe(true)
  })

  it('un 400 près de l’échéance ne déclenche PAS de dégradation hors budget', async () => {
    // ⚠️ `send()` rejoue jusqu'à trois dégradations de 400 SANS repasser par les
    // appelants. Chacune est une requête réelle : près de l'échéance, elles
    // repartaient hors budget — et `anthropicPost` en dérivait un timeout nul,
    // ce qui rouvrait le transport non borné.
    etat.coutParAppel = 40_000
    ;(fetch as any).mockImplementationOnce(async (url: any, init: any) => {
      etat.appels.push({ url: String(url), aSignal: !!init?.signal })
      etat.maintenant += etat.coutParAppel
      return { ok: false, status: 400, json: async () => ({}), text: async () => 'unknown tool type web_fetch_20260209' } as any
    })

    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    // Une seule requête a été émise : la dégradation n'a pas été tentée.
    expect(etat.appels.length).toBe(1)
    expect(r.body.state).toBe('TIMEOUT')
    expect(etat.leads.filter((l) => l.kind === 'proactive_signal_candidate')).toEqual([])
  })

  it('Exa ne démarre pas avec un budget insuffisant', async () => {
    etat.cles.EXA_API_KEY = 'k-exa'          // mode 'exa+claude'
    etat.reponses = [reponseComplete()]

    const r = await searchSignals(
      TENANT, 'thèse', QUICK_SEARCH_MAX_HITS, { months: 1 } as any,
      expiredBudget(),
    )

    expect(r.state).toBe('TIMEOUT')
    expect(etat.appels.filter((a) => a.url.includes('exa.ai')).length).toBe(0)
  })

  it('la Quick Search demande ET rend AU PLUS 10 entreprises', async () => {
    // Le modèle en rend 25 : le plafond doit tenir au bord du produit, pas
    // seulement dans la requête.
    etat.reponses = [reponseComplete(25)]
    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 3 })

    expect(r.body.state).toBe('COMPLETE')
    expect(r.body.hits.length).toBeLessThanOrEqual(QUICK_SEARCH_MAX_HITS)
    // Et le registre n'a pas reçu davantage que ce qui est rendu.
    expect(etat.leads.filter((l) => l.kind === 'proactive_signal_candidate').length)
      .toBe(r.body.hits.length)
    expect(etat.leads.filter((l) => l.kind === 'proactive_signal_candidate').length)
      .toBeLessThanOrEqual(QUICK_SEARCH_MAX_HITS)
  })

  it('résultat rapide et valide → candidats enregistrés et réponse complète', async () => {
    etat.coutParAppel = 500
    etat.reponses = [reponseComplete(2)]

    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    expect(r.status).toBe(200)
    expect(r.body.state).toBe('COMPLETE')
    expect(r.body.hits.length).toBeGreaterThan(0)
    // R1e intact : chaque hit rendu porte un identifiant de candidat SERVEUR.
    for (const h of r.body.hits) expect(h.candidateId).toMatch(/^cand_[0-9a-f]{32}$/)
    expect(etat.leads.filter((l) => l.kind === 'proactive_signal_candidate').length)
      .toBe(r.body.hits.length)
  })

  it('le libellé « délai » de l’UI est réservé au SEUL état TIMEOUT', async () => {
    // ⚠️ GARDE STRUCTURELLE. Le conseil « réduis la période ou les critères » a
    // déjà été démenti par le terrain (1 mois échouait aussi). Un libellé de
    // délai appliqué à une limite de tours ferait la même erreur : envoyer
    // corriger ce qui n'est pas en cause.
    const fs = await import('fs')
    const ui = fs.readFileSync('pages/sourcing.tsx', 'utf8')

    // L'ancien conseil trompeur ne peut plus être AFFICHÉ. Il survit uniquement
    // dans un commentaire qui explique pourquoi il était faux — on filtre donc
    // les commentaires plutôt que de chercher la chaîne dans tout le fichier.
    const codeUi = ui
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(codeUi).not.toContain('réduis la période ou les critères')

    // Le libellé de délai n'est posé dans `sigError` que sous condition
    // explicite de TIMEOUT — jamais pour un PROVIDER_ERROR.
    const lignes = ui.split('\n')
    const iDelai = lignes.findIndex((l) => l.includes('setSigError') && l.includes('pas terminé dans le délai'))
    expect(iDelai).toBeGreaterThan(-1)
    // La ligne juste au-dessus porte la garde d'état.
    expect(lignes[iDelai - 1]).toContain("d.state === 'TIMEOUT'")
  })

  it('un PROVIDER_ERROR ne s’affiche jamais comme « aucun résultat »', async () => {
    // Le bloc « aucun résultat » est gardé par `!sigError` ; toute erreur — délai
    // ou fournisseur — alimente `sigError`, donc aucune ne peut se lire comme une
    // absence de signal constatée.
    const fs = await import('fs')
    const ui = fs.readFileSync('pages/sourcing.tsx', 'utf8')
    expect(ui).toMatch(/!sigRunning && !sigError && sigDone && sigHits\.length === 0/)
    expect(ui).toMatch(/else if \(d\.error\)/)
  })

  it('le navigateur ne reçoit jamais le détail d’une panne fournisseur', async () => {
    etat.reponses = []
    ;(fetch as any).mockImplementationOnce(async () => { throw new Error('ECONNRESET clé-secrète-interne') })

    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    expect(JSON.stringify(r.body)).not.toContain('ECONNRESET')
    expect(JSON.stringify(r.body)).not.toContain('clé-secrète-interne')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// QUICK-SIGNAL-SEARCH-COST-GUARDRAIL-001 — BORNÉ EN ARGENT, PAS SEULEMENT EN TEMPS
//
// ⚠️ LA LEÇON QUI FONDE CE BLOC. Le smoke staging a prouvé la borne de TEMPS :
// 42,45 s, aucun 504, arrêt propre. Et la requête a coûté cher quand même. Le
// fournisseur facture à l'USAGE D'OUTIL et au TOKEN D'ENTRÉE, pas à la seconde :
// une échéance serverless n'est pas un garde-fou financier.
// ════════════════════════════════════════════════════════════════════════════

describe('COST-GUARDRAIL — T1/T2 le contenu récupéré est borné et estimable', () => {
  it('T1 — chaque outil `web_fetch` de la Quick Search porte un `max_content_tokens` FINI', async () => {
    // ⚠️ C'ÉTAIT LA SEULE COMPOSANTE QUE RIEN NE BORNAIT. `money.ts` le dit
    // depuis C2a-2 : sans ce champ, le volume d'entrée injecté est NON BORNÉ.
    const fs = await import('fs')
    const src = fs.readFileSync('lib/prospector/signals.ts', 'utf8')
    const bloc = src.slice(src.indexOf('web_fetch_20260209'), src.indexOf('web_fetch_20260209') + 400)

    expect(bloc).toContain('max_content_tokens')
    expect(Number.isFinite(QUICK_SEARCH_MAX_FETCH_CONTENT_TOKENS)).toBe(true)
    expect(QUICK_SEARCH_MAX_FETCH_CONTENT_TOKENS).toBeGreaterThan(0)
    // La valeur vient d'UNE source partagée avec l'estimateur, pas d'un littéral
    // enfoui : les laisser diverger rendrait l'estimation fausse, en permissif.
    expect(bloc).toContain('QUICK_SEARCH_MAX_FETCH_CONTENT_TOKENS')
  })

  it('T2 — l’estimation de coût de la forme d’outils réelle est COMPLÈTE', async () => {
    const { estimateBreakdown } = await import('../lib/prospector/money')
    const complet = estimateBreakdown({
      model: 'claude-sonnet-5', maxTokens: 8000, bodyBytes: 4000,
      webSearchMaxUses: 10, webSearchDeclared: true,
      webFetchDeclared: true,
      webFetchMaxContentTokens: QUICK_SEARCH_MAX_FETCH_CONTENT_TOKENS * 6,
    })
    expect(complet.complete).toBe(true)
    expect(complet.incomplete).toEqual([])

    // MUTATION : retirer la borne rend l'estimation incomplète — donc refusée.
    const sansBorne = estimateBreakdown({
      model: 'claude-sonnet-5', maxTokens: 8000, bodyBytes: 4000,
      webSearchMaxUses: 10, webSearchDeclared: true, webFetchDeclared: true,
    })
    expect(sansBorne.complete).toBe(false)
    expect(sansBorne.incomplete).toContain('web_fetch_content')
  })
})

describe('COST-GUARDRAIL — « je ne sais pas estimer » ne vaut JAMAIS « j’autorise »', () => {
  it('un outil `web_fetch` SANS borne de contenu fait refuser l’appel, sans rien émettre', async () => {
    // ⚠️ GARDE DE FOND, testée sur le vrai transport. `signals.ts` déclare
    // désormais la borne — mais tout appelant futur qui l'oublierait doit être
    // refusé, pas servi. Une composante non bornable rend le plafond
    // inarbitrable : on ferme.
    const { callClaude } = await import('../lib/prospector/llm')

    // Le refus est une EXCEPTION typée qui remonte jusqu'à `searchSignals`,
    // lequel la convertit en `BUDGET_EXCEEDED`. Ici on observe la frontière basse.
    const appel = callClaude({
      tenant: TENANT, task: 'research', agent: 'test', system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
        // Volontairement SANS `max_content_tokens` : l'entrée est non bornable.
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2 },
      ],
      budget: budgetTest(),
    } as any)

    await expect(appel).rejects.toThrow('acquisition_budget')
    // Et surtout : aucune requête n'a été émise — le refus précède l'émission.
    expect(etat.appels.filter((a) => a.url.includes('anthropic')).length).toBe(0)
  })

  it('le MÊME appel, borne déclarée, est bien émis', async () => {
    // La garde n'est pas un mur : le cas légitime passe.
    etat.reponses = [reponseComplete()]
    const { callClaude } = await import('../lib/prospector/llm')

    await callClaude({
      tenant: TENANT, task: 'research', agent: 'test', system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2,
          max_content_tokens: QUICK_SEARCH_MAX_FETCH_CONTENT_TOKENS },
      ],
      budget: budgetTest(),
    } as any)

    expect(etat.appels.filter((a) => a.url.includes('anthropic')).length).toBe(1)
  })
})

describe('COST-GUARDRAIL — T3/T4/T5 plafonds AGRÉGÉS sur toute l’action', () => {
  it('T3 — le plafond d’appels fournisseur ne se réinitialise à aucun tour', () => {
    const b = startAcquisitionBudget(45_000, horloge, {
      providerCalls: 2, webSearches: 9_999, webFetches: 9_999, maxMicros: PLAFOND_LARGE,
    })
    expect(b.reserveCall()).toBeNull()
    expect(b.reserveCall()).toBeNull()
    // Le troisième est refusé — et le refus ne consomme rien.
    expect(b.reserveCall()).toBe('provider_calls')
    expect(b.snapshot().providerCalls).toBe(2)
  })

  it('T4 — le plafond de recherches web est TOTAL, pas par requête', () => {
    // ⚠️ LA DISTINCTION QUI COMPTE. `max_uses: 10` autorise 10 recherches PAR
    // REQUÊTE : sur quatre tours, quarante. Ce compteur borne l'action entière.
    const b = startAcquisitionBudget(45_000, horloge, {
      providerCalls: 99, webSearches: 10, webFetches: 9_999, maxMicros: PLAFOND_LARGE,
    })
    expect(b.reserveCall({ webSearches: 10 })).toBeNull()
    expect(b.reserveCall({ webSearches: 10 })).toBe('web_searches')
    expect(b.snapshot().webSearches).toBe(10)
  })

  it('T5 — le plafond de récupérations de page est TOTAL lui aussi', () => {
    const b = startAcquisitionBudget(45_000, horloge, {
      providerCalls: 99, webSearches: 9_999, webFetches: 6, maxMicros: PLAFOND_LARGE,
    })
    expect(b.reserveCall({ webFetches: 6 })).toBeNull()
    expect(b.reserveCall({ webFetches: 1 })).toBe('web_fetches')
    expect(b.snapshot().webFetches).toBe(6)
  })

  it('un refus ne consomme AUCUN compteur — pas de demi-réservation', () => {
    const b = startAcquisitionBudget(45_000, horloge, {
      providerCalls: 99, webSearches: 5, webFetches: 6, maxMicros: PLAFOND_LARGE,
    })
    expect(b.reserveCall({ webSearches: 99, webFetches: 6 })).toBe('web_searches')
    const s = b.snapshot()
    expect(s.providerCalls).toBe(0)
    expect(s.webSearches).toBe(0)
    expect(s.webFetches).toBe(0)
  })
})

describe('COST-GUARDRAIL — T6/T7 plafond monétaire de l’action', () => {
  it('T6 — dépassement du plafond ⇒ AUCUNE requête émise, BUDGET_EXCEEDED, hits vides', async () => {
    // Plafond volontairement minuscule : la première estimation le dépasse.
    process.env.QUICK_SEARCH_MAX_MICROS = '1'
    etat.reponses = [reponseComplete()]

    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    expect(r.status).toBe(200)
    expect(r.body.state).toBe('BUDGET_EXCEEDED')
    expect(r.body.hits).toEqual([])
    // ⚠️ LE POINT CENTRAL : la dépense n'a pas eu lieu, elle a été REFUSÉE.
    expect(etat.appels.filter((a) => a.url.includes('anthropic')).length).toBe(0)
  })

  it('T7 — plafond ABSENT ⇒ fail closed, aucune requête', async () => {
    // ⚠️ « je ne sais pas combien je peux dépenser » ne vaut pas « autant que je
    // veux ». Un garde-fou absent ferme ; il n'ouvre pas.
    delete process.env.QUICK_SEARCH_MAX_MICROS
    etat.reponses = [reponseComplete()]

    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    expect(r.body.state).toBe('BUDGET_EXCEEDED')
    expect(r.body.hits).toEqual([])
    expect(etat.appels.length).toBe(0)
  })

  it('plafond illisible ou nul ⇒ ferme également', async () => {
    for (const mauvais of ['', '  ', 'abc', '-5', '0', '1.5']) {
      etat.appels = []
      process.env.QUICK_SEARCH_MAX_MICROS = mauvais
      etat.reponses = [reponseComplete()]
      const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })
      expect(r.body.state).toBe('BUDGET_EXCEEDED')
      expect(etat.appels.length).toBe(0)
    }
  })
})

describe('COST-GUARDRAIL — T8/T9/T10 les états restent distincts', () => {
  it('T8 — TIMEOUT != BUDGET_EXCEEDED', async () => {
    etat.coutParAppel = 40_000
    etat.reponses = [reponsePause(), reponseComplete()]
    const r = await searchSignals(
      TENANT, 'thèse', QUICK_SEARCH_MAX_HITS, { months: 1 } as any,
      budgetSansPlafondOutils(),
    )
    expect(r.state).toBe('TIMEOUT')
    expect(r.state).not.toBe('BUDGET_EXCEEDED')
  })

  it('T9 — une requête bon marché et valide rend COMPLETE', async () => {
    etat.coutParAppel = 500
    etat.reponses = [reponseComplete(2)]
    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })
    expect(r.body.state).toBe('COMPLETE')
    expect(r.body.hits.length).toBeGreaterThan(0)
    for (const h of r.body.hits) expect(h.candidateId).toMatch(/^cand_[0-9a-f]{32}$/)
  })

  it('T10 — une panne fournisseur reste PROVIDER_ERROR', async () => {
    ;(fetch as any).mockImplementationOnce(async () => { throw new Error('ECONNRESET interne') })
    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })
    expect(r.body.state).toBe('PROVIDER_ERROR')
    expect(r.body.state).not.toBe('BUDGET_EXCEEDED')
  })
})

describe('COST-GUARDRAIL — T11/T12/T13/T14 persistance, fuite, contournement', () => {
  it('T11 — BUDGET_EXCEEDED ne persiste AUCUN candidat', async () => {
    process.env.QUICK_SEARCH_MAX_MICROS = '1'
    etat.reponses = [reponseComplete(5)]
    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })
    expect(r.body.state).toBe('BUDGET_EXCEEDED')
    expect(etat.leads.filter((l) => l.kind === 'proactive_signal_candidate')).toEqual([])
  })

  it('T12 — la réponse publique ne fuit rien', async () => {
    process.env.QUICK_SEARCH_MAX_MICROS = '1'
    etat.reponses = [reponseComplete()]
    const r = await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })
    const brut = JSON.stringify(r.body)

    for (const interdit of ['k-test', 'anthropic.com', 'Thèse', 'micros', 'Error', 'stack', 'at Object']) {
      expect(brut).not.toContain(interdit)
    }
    // Ni montant, ni tarif, ni compte de jetons dans le contrat public.
    expect(brut).not.toMatch(/µUSD|maxMicros|spentMicros|input_tokens/)
  })

  it('T13 — la dégradation HTTP 400 puise dans LE MÊME budget', async () => {
    // ⚠️ `send()` rejoue jusqu'à trois dégradations SANS repasser par les
    // appelants. Si elles créaient un budget neuf, le plafond serait
    // contournable par une simple requête invalide.
    process.env.QUICK_SEARCH_MAX_MICROS = '10000000'
    ;(fetch as any).mockImplementation(async (url: any, init: any) => {
      etat.appels.push({ url: String(url), aSignal: !!init?.signal })
      return { ok: false, status: 400, json: async () => ({}), text: async () => 'unknown tool type web_fetch_20260209' } as any
    })

    await appelerRoute({ types: ['levée'], location: 'Paris', months: 1 })

    // Le compteur agrégé (10 recherches réservées par requête) n'autorise qu'UNE
    // émission : la dégradation ne peut pas en obtenir une seconde.
    expect(etat.appels.filter((a) => a.url.includes('anthropic')).length).toBe(1)
  })

  it('T14 — une sortie par exception n’est pas enregistrée comme un coût nul', async () => {
    // ⚠️ ON N'INVENTE AUCUN JETON. Un tour interrompu AVANT réponse n'en fournit
    // aucun : il reste NON MESURÉ, ce qui est la vérité — pas un zéro. Et la
    // sûreté ne repose pas sur cette comptabilité : elle repose sur la
    // réservation faite AVANT l'émission.
    const fs = await import('fs')
    const code = fs.readFileSync('lib/prospector/llm.ts', 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

    // La comptabilisation est dans un `finally` : tous les chemins de sortie y passent.
    expect(code).toMatch(/finally\s*\{[\s\S]{0,400}recordAiUsage/)
    // Et elle n'écrit jamais un zéro fabriqué.
    expect(code).toMatch(/inTokens > 0 \|\| outTokens > 0/)
    // La réservation, elle, précède l'émission.
    expect(code).toMatch(/reserveCall\(/)
    expect(code).toMatch(/reserveMicros\(/)
  })
})
