#!/usr/bin/env node
// Sonde de PRÉCOMPTAGE C2a-2c — isole l'overhead de déclaration des outils
// serveur, sans émettre le moindre appel facturable.
//
// ⚠️ NON EXÉCUTÉE PAR LA CI, ET NON EXÉCUTÉE PENDANT L'IMPLÉMENTATION.
// Elle est livrée prête à l'emploi ; son lancement est une décision d'exploitant.
//
// ── CE QU'ELLE MESURE ────────────────────────────────────────────────────────
// Trois appels `POST /v1/messages/count_tokens` — gratuits, aucune génération,
// pool de limites de débit indépendant de Messages :
//
//   T1  même prompt, AUCUN outil          → input initial seul
//   T2  même prompt + web_search déclaré  → T1 + overhead de déclaration search
//   T3  même prompt + web_fetch déclaré   → T1 + overhead de déclaration fetch
//
// ── L'HYPOTHÈSE QU'ELLE TRANCHE ──────────────────────────────────────────────
// Mesures staging (réelles, via Messages) sur EXACTEMENT ce prompt :
//   sans outil   ~59 tokens estimés par bodyBytes/3
//   + web_search  input_tokens = 2 809
//   + web_fetch   input_tokens = 4 619   (et AUCUNE page fetchée : output_tokens = 4,
//                                         et le prompt ne contient aucune URL)
//
// Si (T2 − T1) ≈ 2 809 − T1 et (T3 − T1) ≈ 4 619 − T1, l'hypothèse « l'écart
// est l'expansion de la définition d'outil » est confirmée, et le précomptage
// devient un instrument exploitable. Si les écarts divergent, il existe une
// composante que le comptage ne voit pas, et il ne faut PAS s'en servir.
//
// T1 confronté aux 945 tokens réels du cas « Sonnet sans outil » dit
// directement si le comptage suit l'entrée réelle là où bodyBytes/3 la
// sous-estimait de 18 %.
//
// ── CE QU'ELLE NE PERMET PAS DE CONCLURE ─────────────────────────────────────
//   • rien sur les tokens de résultats web_search (dynamiques) ;
//   • rien sur le contenu web_fetch (dynamique, et non borné pour le binaire) ;
//   • rien sur les tours `pause_turn` suivants, qui repartent avec les résultats
//     accumulés en entrée ;
//   • rien sur la variance en usage réel.
// Le comptage est DÉTERMINISTE pour un couple (modèle, corps) : un seul passage
// suffit — contrairement aux mesures Messages, qui en demanderaient plusieurs.
//
// ── GARANTIES ────────────────────────────────────────────────────────────────
//   • aucun token généré, aucune dépense, aucune écriture ;
//   • refuse de viser autre chose que le point de terminaison de comptage ;
//   • n'affiche JAMAIS la clé, ni le prompt, ni aucune réponse — uniquement des
//     entiers et des différences.
//
// Usage :
//   ANTHROPIC_API_KEY=… node scripts/smoke/c2a2c_token_count_probe.mjs [modèle]

const ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens'

// Verrou : ce script ne doit jamais pouvoir servir à émettre une génération.
if (!ENDPOINT.endsWith('/count_tokens')) {
  console.error('Point de terminaison inattendu — cette sonde ne doit viser que le comptage.')
  process.exit(2)
}

const KEY = process.env.ANTHROPIC_API_KEY || ''
if (!KEY) {
  console.error('ANTHROPIC_API_KEY absente. Aucune requête émise.')
  process.exit(2)
}

// Modèle : celui de la tâche `research`, sauf argument explicite.
const MODEL = process.argv[2] || process.env.SIGNALS_MODEL || 'claude-sonnet-5'

// Prompt IDENTIQUE à celui des sondes de /api/ai/diagnose — c'est ce qui rend
// la comparaison avec les mesures staging légitime. Ne pas le modifier sans
// invalider les points de comparaison ci-dessus.
const MESSAGES = [{ role: 'user', content: 'Réponds juste: OK' }]

// Versions EXACTEMENT celles utilisées par Prospector aujourd'hui. Ce lot ne
// change aucune version d'outil ; mesurer une autre version ne dirait rien de
// notre coût réel.
const VARIANTS = [
  { id: 'T1', label: 'sans outil', tools: undefined },
  { id: 'T2', label: '+ web_search_20250305', tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] },
  { id: 'T3', label: '+ web_fetch_20260209', tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1 }] },
]

async function count(tools) {
  const body = { model: MODEL, messages: MESSAGES }
  if (tools) body.tools = tools
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`HTTP ${r.status} — ${text.slice(0, 200)}`)
  }
  const data = await r.json()
  if (!Number.isSafeInteger(data?.input_tokens)) {
    throw new Error(`input_tokens illisible : ${JSON.stringify(data?.input_tokens)}`)
  }
  return data.input_tokens
}

// Repères RÉELS mesurés sur staging avec ce même prompt (via Messages).
const OBSERVED = { T2: 2809, T3: 4619 }

const results = {}
console.log(`Modèle : ${MODEL}`)
console.log(`Clé : présente (${KEY.length} caractères — valeur jamais affichée)\n`)

for (const v of VARIANTS) {
  try {
    results[v.id] = await count(v.tools)
    console.log(`[ OK ] ${v.id}  ${String(results[v.id]).padStart(6)} tokens   ${v.label}`)
  } catch (e) {
    console.error(`[FAIL] ${v.id}  ${v.label} — ${e.message}`)
    process.exit(1)
  }
}

console.log('\n── Overheads de déclaration isolés ──')
for (const id of ['T2', 'T3']) {
  const overhead = results[id] - results.T1
  const expected = OBSERVED[id] - results.T1
  const ecart = overhead - expected
  const pct = expected === 0 ? 'n/a' : `${((ecart / expected) * 100).toFixed(1)} %`
  console.log(`${id} − T1 = ${overhead} tokens ; attendu d'après le réel (${OBSERVED[id]} − T1) = ${expected} ; écart ${ecart} (${pct})`)
}

console.log(`
── Lecture ──
Écarts faibles  → l'overhead de déclaration est bien ce que le comptage voit :
                  le précomptage fournisseur est un instrument exploitable.
Écarts marqués  → une composante échappe au comptage : NE PAS s'en servir comme
                  instrument de décision budgétaire sans l'avoir comprise.

Rappel : le comptage est donné pour une ESTIMATION par Anthropic, jamais pour
une borne. Aucun de ces chiffres ne prouve qu'un plafond ne sera pas dépassé.
`)
