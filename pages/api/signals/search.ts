import type { NextApiRequest, NextApiResponse } from 'next'
import {
  searchSignals, buildThesis, SIGNAL_TYPES,
  QUICK_SEARCH_MAX_HITS, type SignalQuery,
} from '../../../lib/prospector/signals'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import {
  startAcquisitionBudget,
  QUICK_SEARCH_BUDGET_MS,
} from '../../../lib/prospector/acquisitionBudget'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'
import { registerCandidates } from '../../../lib/prospector/proactive/signalCandidates'
import { logSafeError } from '../../../lib/observability/safeError'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Recherche longue (Exa + Claude web + réconciliation SIREN) → il faut laisser
// le temps à la fonction serverless, sinon timeout silencieux côté client.
export const config = { maxDuration: 60 }

// Recherche par signal. Deux modes :
//  • thèse libre (GET ?thesis=…) — mode expert, inchangé
//  • critères structurés (POST { types, sector, location, months, keywords })
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ── L'ÉCHÉANCE APPARTIENT À LA ROUTE, ET ELLE DÉMARRE ICI ────────────────
  // ⚠️ AVANT `hydrateKeystore`, la résolution du tenant et la construction de la
  // thèse. Une version antérieure laissait `searchSignals` fabriquer son propre
  // budget par défaut : l'horloge des 45 s démarrait donc APRÈS ce travail, et
  // le total réel de la requête pouvait dépasser la fenêtre serverless alors
  // même que « l'acquisition » se croyait dans les temps.
  //
  // ⚠️ ET CE BUDGET EST UNE POLITIQUE DE *QUICK SEARCH*, pas du moteur de
  // signaux. `searchSignals` n'en fabrique plus aucun : une acquisition en
  // Mission passera SON PROPRE budget de lot, plus court. Laisser un défaut dans
  // le moteur imposerait la politique de cette route à tous ses appelants futurs.
  const budget = startAcquisitionBudget(QUICK_SEARCH_BUDGET_MS)

  await hydrateKeystore()

  // Catalogue des types de signaux, pour construire l'UI.
  if (req.method === 'GET' && str(req.query.catalog) === '1') {
    return res.status(200).json({ types: SIGNAL_TYPES.map(({ key, label, group }) => ({ key, label, group })) })
  }

  const body = req.method === 'POST' ? (typeof req.body === 'string' ? safeParse(req.body) : req.body) : null
  const q: SignalQuery = body ? {
    thesis: String(body.thesis || ''),
    types: Array.isArray(body.types) ? body.types.slice(0, 6) : [],
    sector: String(body.sector || ''),
    location: String(body.location || ''),
    months: Math.min(Math.max(Number(body.months) || 6, 1), 18),
    keywords: String(body.keywords || ''),
  } : { thesis: str(req.query.thesis).trim(), months: 6 }

  // MT-0 — espace client obligatoire avant tout appel LLM. Fail closed.
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'Espace client indéterminé : appel IA refusé.' })

  const thesis = buildThesis(q)
  if (!thesis || thesis.length < 5) return res.status(400).json({ error: 'Précise au moins un type de signal ou une thèse.' })

  try {
    // ── QUICK SEARCH : UNE TRANCHE BORNÉE, PAS UNE ACQUISITION EXHAUSTIVE ──
    // ⚠️ 25 ÉTAIT LE PIRE RÉGLAGE SUR LE CHEMIN LE PLUS COURT. À `months = 1`,
    // `monthSlices` rend UNE tranche, donc `per = 25` : demander « moins de
    // période » demandait en réalité PLUS de travail en une seule passe. C'est
    // pourquoi réduire la fenêtre ne corrigeait pas le 504.
    //
    // Ce plafond ne borne QUE la Quick Search. L'acquisition en Mission
    // accumulera davantage de candidats sur plusieurs lots, eux aussi bornés.
    const resultat = await searchSignals(tenant, thesis, QUICK_SEARCH_MAX_HITS, q, budget)

    // ── DÉLAI DÉPASSÉ : AUCUN CANDIDAT N'EST CRÉÉ ──────────────────────────
    // ⚠️ COUVERTURE INCONNUE ⇒ ZÉRO CANDIDAT. Enregistrer les hits d'une
    // acquisition inachevée figerait dans le registre serveur une vue partielle
    // que personne n'a validée, et elle deviendrait promouvable en fait.
    //
    // ⚠️ AUJOURD'HUI REDONDANT, ET DIT COMME TEL. `searchSignals` rend déjà
    // `hits: []` sur TIMEOUT, et son chemin d'exception ne peut pas avoir peuplé
    // `hits`. Vérifié par mutation : retirer ce bloc ne fait échouer aucun test.
    // On le garde comme invariant explicite de la route — le jour où
    // l'agrégation par lots complets arrivera (ticket Mission), `hits` POURRA
    // être non vide sur un TIMEOUT, et c'est ici que la décision devra se
    // prendre. Ne pas le présenter comme la garde : la garde est en amont.
    if (resultat.state === 'TIMEOUT') {
      return res.status(200).json({ ...resultat, hits: [] })
    }

    // ── ÉMISSION DES CANDIDATS — CÔTÉ SERVEUR, ICI ET NULLE PART AILLEURS ───
    // ⚠️ C'EST LE SEUL ENDROIT OÙ UN CANDIDAT NAÎT. Les `hits` viennent d'être
    // produits par `searchSignals` : ils n'ont transité par aucun navigateur.
    // On en fige la part porteuse de vérité dans le registre de l'espace, et on
    // ne rend au client qu'un identifiant opaque.
    //
    // Sans cela, `/api/signals/promote` n'aurait rien à quoi comparer ce qu'un
    // navigateur lui présente — et devrait le croire sur parole.
    const ids = await registerCandidates(resultat.hits || [], tenant.id)
    const hits = (resultat.hits || []).map((h, i) => ({ ...h, candidateId: ids[i] || undefined }))

    res.status(200).json({ ...resultat, hits })
  } catch (e: any) {
    logSafeError('signals.search_error', e, { operation: 'signals_search' })
    res.status(502).json({ error: 'Recherche de signaux indisponible pour le moment.' })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
