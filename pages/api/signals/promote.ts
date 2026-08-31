// SIGNAL-PRODUCT-REACHABILITY-001 — LA FRONTIÈRE DE VÉRITÉ CÔTÉ SERVEUR.
//
// ── CE QUE CETTE ROUTE REND POSSIBLE ────────────────────────────────────────
//
//   utilisateur authentifié
//        → « je confirme CE fait »
//        → le SERVEUR dérive l'acteur, l'instant, l'espace, le contexte métier
//        → Signal Bridge  → KnownEvidenceEvent adjugé
//        → orchestrator.evaluate()  → Decision Kernel existant
//        → Situation / Recommendation
//        → persistEvaluation()
//        → réponse structurée
//
// ── CE QUE LE NAVIGATEUR NE DÉCIDE JAMAIS ───────────────────────────────────
// ⚠️ LE CLIENT N'EST AUTORITAIRE SUR RIEN DE CE QUI FAIT LA VÉRITÉ. Ni
// `confirmedBy`, ni `confirmedAt`, ni l'espace, ni le contexte métier, ni la
// confiance, ni `assertionType`, ni les identifiants d'evidence, ni le compte.
// Il exprime UNE chose : « je confirme ce candidat ». Tout le reste est
// reconstruit ici, à partir de données visibles du serveur.
//
// Accepter un `EvidenceEvent` ou un objet `HUMAN_CONFIRMED` fabriqué par le
// navigateur reviendrait à laisser l'appelant écrire sa propre vérité — et
// toutes les gardes du Bridge deviendraient décoratives.
//
// ── AUCUNE ACTION SORTANTE ──────────────────────────────────────────────────
// Cette route range des faits, des interprétations et des décisions. Elle
// n'envoie aucun message, ne déclenche aucune séquence, ne modifie aucun lead.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { loadBusinessContext } from '../../../lib/prospector/proactive/lens/contextStore'
import {
  bridgeSignals,
  sourceEvidenceFromHit,
  type BridgePromotion,
  type HumanFactConfirmation,
  type SourceEvidence,
} from '../../../lib/prospector/proactive/signalBridge'
import {
  recordSourceAssertions,
  sourceAssertionsEnabled,
  type AssertionBuildInput,
} from '../../../lib/prospector/proactive/sourceAssertion'
import {
  canonicalFactsEnabled,
  recordCanonicalAnchors,
} from '../../../lib/prospector/proactive/canonicalFact'
import { evaluate, persistEvaluation } from '../../../lib/prospector/proactive/orchestrator'
import { accountIdForLead } from '../../../lib/prospector/proactive/dataBridge'
import { listEvidenceStrict } from '../../../lib/prospector/proactive/persistence'
import { listLeadsStrict } from '../../../lib/supabase/leads'
import {
  hitFromCandidate,
  readCandidate,
  type SignalCandidate,
} from '../../../lib/prospector/proactive/signalCandidates'
import { lookupByName, type CompanyLookup } from '../../../lib/prospector/datagouv'
import { EXTERNAL_SIGNAL_PROVIDER } from '../../../lib/prospector/proactive/types'
import type { KnownEvidenceEvent } from '../../../lib/prospector/proactive/catalog'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'
import type { Lead } from '../../../types/prospector'

/**
 * États PRODUIT explicites.
 *
 * ⚠️ CHACUN APPELLE UN GESTE DIFFÉRENT, ET LES CONFONDRE ENVERRAIT CORRIGER LA
 * MAUVAISE CHOSE. « contexte métier à configurer » n'est pas « signal non
 * résolu », et « fait accepté sans Situation » n'est pas un échec — c'est un
 * résultat parfaitement valide qu'il ne faut jamais maquiller.
 */
export type PromoteState =
  | 'UNAUTHENTICATED'
  | 'WORKSPACE_UNRESOLVED'
  | 'BUSINESS_CONTEXT_REQUIRED'
  | 'BUSINESS_CONTEXT_INVALID'
  | 'SIGNAL_NOT_RESOLVED'
  | 'CLAIM_NOT_PROMOTABLE'
  | 'CONFIRMATION_SOURCE_MISMATCH'
  | 'NO_FACT_PRODUCED'
  | 'BUSINESS_CONTEXT_UNAVAILABLE'
  | 'PERSISTENCE_FAILED'
  | 'CANDIDATE_UNKNOWN'
  | 'CANDIDATE_STORE_UNAVAILABLE'
  | 'ENTITY_REGISTRY_UNAVAILABLE'
  | 'LEAD_STORE_UNAVAILABLE'
  | 'EVIDENCE_HISTORY_INVALID'
  | 'EVIDENCE_HISTORY_UNAVAILABLE'
  | 'ACCEPTED_NO_SITUATION'
  | 'ACCEPTED_WITH_RESULT'

/**
 * Ce que le navigateur a le droit d'envoyer — et RIEN de plus.
 *
 * `canonicalKey` et `reviewedSourceUrls` DÉSIGNENT le candidat que la personne
 * a examiné ; ils ne le constituent pas. Le serveur les confronte aux données
 * qu'il voit lui-même : un `canonicalKey` qui ne correspond à aucune
 * revendication reconstruite ne promeut rien.
 */
export interface PromoteRequest {
  /**
   * L'identifiant OPAQUE du candidat émis par `/api/signals/search`.
   *
   * ⚠️ C'EST TOUT CE QUE LE NAVIGATEUR DÉSIGNE. En R1b, cette route recevait
   * `hits: SignalHit[]` et construisait ses `SourceEvidence` à partir de cet
   * objet : un navigateur modifié choisissait donc lui-même `eventStatus`,
   * `eventDate`, `claimNature`, `roleStatus`, `sourceUrl`, puis soumettait une
   * `canonicalKey` cohérente avec ses propres valeurs. Les gardes du Bridge
   * s'appliquaient alors à une revendication écrite par l'attaquant.
   *
   * Les champs structurés sont désormais RELUS DU REGISTRE SERVEUR. Il n'y a
   * plus de charge utile porteuse de vérité dans cette requête.
   */
  candidateId: string
  /** La revendication EXACTE que la personne confirme. */
  canonicalKey: string
  /** Les sources qu'elle affirme avoir examinées. */
  reviewedSourceUrls: string[]
}

export interface PromoteResponse {
  state: PromoteState
  evidence?: number
  situations?: { id: string; type: string }[]
  recommendations?: { id: string; decision: string }[]
  reason?: string
}

/** Espace de session côté serveur. Jamais lu depuis le corps de la requête. */
function repondre(res: NextApiResponse, code: number, body: PromoteResponse) {
  return res.status(code).json(body)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return repondre(res, 405, { state: 'CLAIM_NOT_PROMOTABLE', reason: 'method' })
  }

  // ── 1. ACTEUR ET ESPACE — tous deux dérivés de la SESSION ────────────────
  const acteur = await resolveActorFromRequest(req)
  if (!acteur) return repondre(res, 403, { state: 'UNAUTHENTICATED' })
  const ws = acteur.tenant.id
  if (!ws) return repondre(res, 403, { state: 'WORKSPACE_UNRESOLVED' })

  try {
    // ── 2. CONTEXTE MÉTIER — autoritaire, jamais synthétisé ───────────────
    const contexte = await loadBusinessContext(ws)
    if (contexte.ok === false) {
      // ⚠️ « BASE MUETTE » EST REJOUABLE, « À CONFIGURER » NE L'EST PAS. Rendre
      // 409 pour les trois faisait lire une panne d'infrastructure comme un
      // conflit produit : un client, un proxy ou une supervision n'a alors
      // aucun moyen de savoir qu'un simple réessai suffirait.
      const code = contexte.state === 'BUSINESS_CONTEXT_UNAVAILABLE' ? 503 : 409
      return repondre(res, code, {
        state: contexte.state,
        reason: contexte.state === 'BUSINESS_CONTEXT_INVALID' ? contexte.reason : undefined,
      })
    }

    const corps = (typeof req.body === 'string' ? safeParse(req.body) : req.body) as PromoteRequest
    if (!corps || typeof corps.canonicalKey !== 'string' || corps.canonicalKey.trim() === '') {
      return repondre(res, 400, { state: 'CLAIM_NOT_PROMOTABLE', reason: 'claim' })
    }

    // ── 3. LE CANDIDAT — RELU DU REGISTRE, JAMAIS DE LA REQUÊTE ──────────
    // ⚠️ La lecture est cloisonnée par `ws`, issu de la session. Un identifiant
    // capté dans un autre espace ne désigne aucune ligne ici — et son condensat,
    // qui inclut l'espace, ne pourrait pas correspondre non plus.
    const lecture = await readCandidate(corps.candidateId, ws)
    if (lecture.ok === false) {
      // Panne de magasin ≠ candidat inconnu : l'une se réessaie, l'autre non.
      return lecture.state === 'CANDIDATE_STORE_UNAVAILABLE'
        ? repondre(res, 503, { state: 'CANDIDATE_STORE_UNAVAILABLE' })
        : repondre(res, 409, { state: 'CANDIDATE_UNKNOWN' })
    }
    const candidate = lecture.candidate

    // ── 4. ENTITÉ — LIAISON CANDIDAT → COMPTE, D'ORIGINE SERVEUR ─────────
    // ⚠️ LE NAVIGATEUR N'A PLUS DE SÉLECTEUR DE COMPTE. En R1b il envoyait
    // `resolvedSiren` : un candidat valide pour la société A devenait
    // attachable à la société B persistée en changeant ce seul champ. La
    // liaison se dérive maintenant de deux autorités dont aucune n'est le
    // client — le registre officiel, puis le fichier de leads de l'espace.
    const lead = await compteDuCandidat(candidate, ws)
    if (lead.ok === false) return repondre(res, lead.code, { state: lead.state })

    const accountId = accountIdForLead(lead.lead)
    if (!accountId || !/^acc_siren_\d{9}$/.test(accountId)) {
      return repondre(res, 409, { state: 'SIGNAL_NOT_RESOLVED' })
    }

    // ── 4. ADJUDICATION — construite PAR LE SERVEUR ───────────────────────
    // ⚠️ `confirmedBy` vient de l'identité authentifiée, `confirmedAt` de
    // l'horloge SERVEUR. Les accepter du client permettrait de signer au nom
    // d'un autre, ou d'antidater une confirmation.
    const confirmation: HumanFactConfirmation = {
      kind: 'HUMAN_CONFIRMED',
      canonicalKey: corps.canonicalKey.trim(),
      confirmedBy: acteur.actorId,
      confirmedAt: new Date().toISOString(),
      sourceUrls: Array.isArray(corps.reviewedSourceUrls)
        ? corps.reviewedSourceUrls.filter((u) => typeof u === 'string' && u.trim() !== '')
        : [],
    }
    if (confirmation.sourceUrls.length === 0) {
      return repondre(res, 400, { state: 'CONFIRMATION_SOURCE_MISMATCH', reason: 'sources' })
    }

    // ── 5. LE BRIDGE, INCHANGÉ ────────────────────────────────────────────
    // ⚠️ AUCUNE LIGNÉE FABRIQUÉE ICI. Une version antérieure passait
    // `{ kind: 'ORIGINAL' }` : le contrat d'acquisition ne prouve RIEN de la
    // lignée d'une source, et l'affirmer transformait n'importe quelle reprise
    // de communiqué en source indépendante. Cinq copies d'une même annonce
    // seraient alors devenues cinq corroborations.
    //
    // On laisse donc le défaut du Bridge — `UNKNOWN` — qui ne compte jamais
    // comme indépendance. Conséquence V0 ASSUMÉE : la corroboration par deux
    // sources B est inatteignable depuis cette route tant que la lignée n'est
    // pas établie en amont (MACHINE-GROUNDING-001 / acquisition). Une source A
    // qualifiante, elle, reste promouvable.
    //
    // ⚠️ LE `SignalHit` EST RECONSTITUÉ DU REGISTRE (`hitFromCandidate`), pas
    // reçu. C'est ce qui rend les gardes du Bridge à nouveau opérantes : elles
    // s'appliquent enfin à ce que le serveur a produit.
    const sources: SourceEvidence[] = []
    // ⚠️ `issuedAt` EST LA SEULE DATE DE RÉCUPÉRATION QUE LE SERVEUR CONNAISSE
    // RÉELLEMENT : l'instant où il a lui-même émis ce candidat. Elle n'est ni
    // `observedAt` (l'instant d'adjudication, plus bas) ni la date de
    // publication de la source. Une recherche du lundi confirmée le jeudi porte
    // bien deux dates distinctes, et les confondre effacerait le délai de revue.
    //
    // ⚠️ APPEL TENU SUR UNE SEULE LIGNE, VOLONTAIREMENT. Le verrou structurel
    // `tests/signal-product-reachability.test.ts` vérifie par expression
    // régulière que le site passé ici est bien `officialWebsite` — le registre
    // officiel — et jamais `lead.website`, que le navigateur peut influencer.
    // Couper l'appel sur plusieurs lignes désarmait ce verrou en silence.
    // ⚠️ EXCEPTION RECHERCHE (RESEARCH_ARTIFACT_COMPILER_V0_001 §12/§17) : un
    // candidat porteur d'une origine recherche N'A PAS de date de récupération
    // connue — `origin.sourceRetrievedAt` vaut `null` en V0, et l'`issuedAt`
    // (instant d'émission serveur) ne prouve RIEN de la récupération de la page.
    // On ne passe alors AUCUN `retrievedAt` — jamais un repli sur `issuedAt`.
    const dateRecuperation = candidate.claim.origin
      ? (candidate.claim.origin.sourceRetrievedAt ?? undefined)
      : candidate.issuedAt
    const s = sourceEvidenceFromHit(hitFromCandidate(candidate), lead.officialWebsite, undefined, undefined, dateRecuperation)
    if (s) sources.push(s)

    const pont = bridgeSignals({
      accountId,
      observedAt: new Date().toISOString(),
      sources,
      confirmations: [confirmation],
    })

    if (pont.evidence.length === 0) {
      const motif = pont.refusals[0]?.reason
      const etat: PromoteState =
        motif === 'CONFIRMATION_SOURCE_MISMATCH' ? 'CONFIRMATION_SOURCE_MISMATCH' : 'NO_FACT_PRODUCED'
      return repondre(res, 200, { state: etat, reason: motif })
    }

    // ── 6. LE KERNEL EXISTANT ─────────────────────────────────────────────
    // ⚠️ `tasks: { complete: false }` — LA REPRÉSENTATION EXPLICITE DE
    // L'INCONNU, et non une commodité. Cette route ne lit pas les tâches ;
    // affirmer `complete: true` ferait produire des evidences d'ABSENCE
    // (`no_next_step`) sur la foi d'une lecture jamais faite.
    // ── ACCUMULATION DES FAITS DÉJÀ ADJUGÉS ──────────────────────────────
    // ⚠️ SANS CECI, DEUX GESTES NE CONVERGENT JAMAIS. Chaque confirmation
    // n'évaluait que son propre fait : une levée confirmée lundi et un
    // recrutement confirmé mardi ne se rencontraient nulle part, alors que les
    // packs exigent précisément une convergence de familles distinctes. Le
    // produit ne pouvait donc structurellement produire aucune Situation
    // multi-faits.
    //
    // ── REGISTRE DES ASSERTIONS DE SOURCE — AVANT QUE LA PROJECTION N'ÉCRASE ──
    // ⚠️ ÉCRIT ICI, ET PAS APRÈS. `save()` écrit l'evidence par `upsertItem`,
    // qui REMPLACE le document : une seconde adjudication de la même
    // revendication efface la provenance de la première. Le registre doit donc
    // capter l'assertion AVANT cette écriture, sinon il n'enregistrerait que ce
    // qui a survécu — c'est-à-dire rien de ce qu'il existe pour conserver.
    //
    // ⚠️ COUCHE SECONDAIRE, ET STRICTEMENT SECONDAIRE. Une panne du registre ne
    // doit JAMAIS invalider une adjudication humaine : l'utilisateur a confirmé
    // un fait, et un journal d'audit indisponible ne rend pas ce fait faux.
    // L'échec est journalisé côté serveur et n'apparaît dans aucune réponse.
    await journaliserAssertions(pont.promotions, ws)

    // ⚠️ ET UNE HISTOIRE ILLISIBLE ARRÊTE TOUT. Voir `accumulerFaitsExternes`.
    const accumulation = await accumulerFaitsExternes(pont.evidence, accountId, ws)
    if (accumulation.ok === false) {
      return repondre(res, 503, {
        state: accumulation.reason === 'invalid'
          ? 'EVIDENCE_HISTORY_INVALID'
          : 'EVIDENCE_HISTORY_UNAVAILABLE',
      })
    }
    const externalEvidence = accumulation.values

    const evaluation = evaluate({
      leads: [lead.lead],
      now: new Date(),
      tasks: { complete: false },
      businessContext: contexte.context,
      externalEvidence,
    })

    // ── DURABILITÉ AVANT ANNONCE ─────────────────────────────────────────
    // ⚠️ LE RÉSULTAT DE L'ÉCRITURE ÉTAIT IGNORÉ. La route pouvait répondre
    // « fait accepté » alors que rien n'avait été écrit : l'utilisateur croyait
    // avoir adjugé, et la confirmation disparaissait. On n'annonce une
    // acceptation que si elle a survécu.
    const ecrit = await persistEvaluation(evaluation, ws)
    const attendu =
      ecrit.evidence >= evaluation.evidence.length &&
      ecrit.situations >= evaluation.situations.length &&
      ecrit.recommendations >= evaluation.recommendations.length
    if (!attendu) {
      // Réessayer reste sans danger : tous les identifiants sont déterministes.
      return repondre(res, 503, { state: 'PERSISTENCE_FAILED' })
    }

    // ⚠️ « FAIT ACCEPTÉ, AUCUNE SITUATION » EST UN RÉSULTAT VALIDE. Les règles
    // du pack exigent une convergence que ce seul fait ne fournit peut-être
    // pas. Inventer une recommandation pour rendre l'écran productif serait
    // exactement la fabrication que tout ce chantier existe pour empêcher.
    return repondre(res, 200, {
      state: evaluation.situations.length > 0 ? 'ACCEPTED_WITH_RESULT' : 'ACCEPTED_NO_SITUATION',
      evidence: pont.evidence.length,
      situations: evaluation.situations.map((s) => ({ id: s.id, type: s.type })),
      recommendations: evaluation.recommendations.map((r) => ({ id: r.id, decision: r.decision })),
    })
  } catch (e) {
    // Aucun détail interne ne part dans la réponse : seule la classe de panne.
    logSafeError('signals.promote_failed', e, { operation: 'signals_promote' })
    return repondre(res, 502, { state: 'NO_FACT_PRODUCED', reason: PUBLIC_ERROR })
  }
}

type LiaisonCompte =
  | { ok: true; lead: Lead; officialWebsite?: string }
  | { ok: false; state: PromoteState; code: number }

/**
 * La fiche PERSISTÉE à laquelle ce candidat se rattache — sans que le
 * navigateur n'ait voix au chapitre.
 *
 * ── LE DÉFAUT STRUCTUREL QUE R1d FERME ──────────────────────────────────────
 * R1c résolvait l'entité à partir de `candidate.claim.candidateSiren`. Or la
 * production ne le remplit JAMAIS : `parseHits()` ne pose aucun `siren` — ce
 * champ n'est écrit qu'APRÈS l'import et la résolution data.gouv. Le chemin
 * produit réel était donc toujours refusé en `SIGNAL_NOT_RESOLVED`. Mes tests
 * ne l'ont pas vu parce que leur fixture injectait un `siren` dans chaque hit
 * synthétique : ils validaient un contrat que l'acquisition ne produit pas.
 *
 * ── TROIS AUTORITÉS EN SÉRIE, AUCUNE N'EST LE CLIENT ────────────────────────
 *
 *   1. LE RÉSOLVEUR OFFICIEL, PAR RAISON SOCIALE. `lookupByName` interroge
 *      data.gouv et n'accepte que `resolution === 'resolved'` : une fenêtre de
 *      dix candidats, une correspondance stricte unique exigée. Homonymes ou
 *      simples approchants ⇒ ambigu ⇒ rien. La règle d'ambiguïté du registre
 *      ferme déjà, et on ne la réécrit pas ici.
 *
 *      ⚠️ CE N'EST PAS UN REPLI PAR NOM SUR LES FICHES PERSISTÉES. Le nom ne
 *      sert QU'À interroger le registre officiel ; il ne choisit jamais entre
 *      deux fiches de l'espace. C'est le SIREN officiel qui sélectionne.
 *
 *   2. LA COHÉRENCE DU CANDIDAT, SI ELLE EXISTE. Un `candidateSiren` présent
 *      n'est PAS une autorité : c'est une assertion à vérifier. S'il diffère du
 *      SIREN officiel résolu depuis la raison sociale, les deux se
 *      contredisent — et une contradiction ne se tranche pas en faveur du
 *      modèle. On refuse.
 *
 *      ⚠️ « ce SIREN existe au registre » ne prouve JAMAIS que le signal parle
 *      de cette entité. Un SIREN réel mais étranger au signal reste une
 *      information fausse.
 *
 *   3. LE FICHIER DE LEADS DE L'ESPACE, EN LECTURE STRICTE. Le SIREN officiel
 *      doit désigner une fiche RÉELLEMENT persistée. `listLeadsStrict` — et non
 *      `listLeads`, qui rend `[]` aussi bien pour un espace vide que pour un
 *      magasin muet : dire « entreprise non résolue » pendant une panne
 *      enverrait importer une fiche qui existe déjà.
 *
 * ⚠️ PANNE REGISTRE ⇒ REFUS, PAS « INTROUVABLE ». `searchCandidates` lève sur
 * indisponibilité plutôt que de rendre une liste vide : une entreprise qui
 * existe ne doit pas être déclarée inexistante parce que data.gouv était muet.
 */
async function compteDuCandidat(candidate: SignalCandidate, ws: string): Promise<LiaisonCompte> {
  const raisonSociale = String(candidate.claim.company || '').trim()
  if (!raisonSociale) return { ok: false, state: 'SIGNAL_NOT_RESOLVED', code: 409 }

  let officiel: CompanyLookup | null = null
  try {
    officiel = await lookupByName(raisonSociale)
  } catch {
    return { ok: false, state: 'ENTITY_REGISTRY_UNAVAILABLE', code: 503 }
  }

  // `found` seul ne suffit pas : seul `resolved` signifie « sans équivoque ».
  if (!officiel?.found || officiel.resolution !== 'resolved') {
    return { ok: false, state: 'SIGNAL_NOT_RESOLVED', code: 409 }
  }

  const sirenOfficiel = String(officiel.siren || '').trim()
  if (!/^\d{9}$/.test(sirenOfficiel)) {
    return { ok: false, state: 'SIGNAL_NOT_RESOLVED', code: 409 }
  }

  // Assertion de cohérence — jamais une autorité. Voir le point 2 ci-dessus.
  const propose = candidate.claim.candidateSiren
  if (propose && propose !== sirenOfficiel) {
    return { ok: false, state: 'SIGNAL_NOT_RESOLVED', code: 409 }
  }

  const lu = await listLeadsStrict(ws)
  if (lu.ok === false) return { ok: false, state: 'LEAD_STORE_UNAVAILABLE', code: 503 }

  const lead = lu.leads.find((l) => typeof l?.siren === 'string' && l.siren.trim() === sirenOfficiel)
  if (!lead) return { ok: false, state: 'SIGNAL_NOT_RESOLVED', code: 409 }

  // ⚠️ LE SITE OFFICIEL REMONTE AVEC LA FICHE, ET REMPLACE `lead.website`.
  // La politique de grade A du Bridge suppose un site DÉCLARÉ AU REGISTRE ;
  // `Lead.website` est une donnée produit ordinaire, modifiable par un import
  // ou un enrichissement. S'en servir laisserait n'importe quel hôte inscrit
  // sur une fiche décerner un grade A à une source qui n'en est pas une.
  return { ok: true, lead, officialWebsite: urlOfficielleAbsolue(officiel.website) }
}

/**
 * Met la valeur du REGISTRE sous une forme que `hostOf()` sait lire.
 *
 * ── LE DÉCALAGE FIXTURE / PRODUCTION QUE CECI FERME (R1e·P0-2) ──────────────
 * `extractWebsite()` (datagouv.ts:64-69) RETIRE le schéma : la production rend
 * `acme.fr`, pas `https://acme.fr`. Or `hostOf()` s'appuie sur `new URL(...)`,
 * qui n'accepte qu'une URL ABSOLUE. Le site officiel d'une entreprise ne
 * produisait donc aucun hôte, et sa propre page n'obtenait jamais le grade A :
 * la garde R1d était correcte, et inopérante en production.
 *
 * Mon test R1d ne l'a pas vu parce que son mock rendait `https://acme.fr` —
 * une forme que l'adaptateur réel ne produit jamais. Deuxième fois que la
 * fixture affirmait un contrat plus commode que le vrai.
 *
 * ── POURQUOI ICI, ET PAS DANS `hostOf()` ───────────────────────────────────
 * ⚠️ ON NE TOUCHE PAS À LA POLITIQUE DU BRIDGE. Rendre `hostOf()` tolérant aux
 * chaînes relatives changerait le sens de TOUS ses appelants — y compris ceux
 * qui classent des URLs de sources, où « ce n'est pas une URL absolue » doit
 * rester un refus. La normalisation appartient à la frontière registre→Bridge,
 * là où l'on sait que la valeur vient d'une autorité et ce qu'elle signifie.
 *
 * ⚠️ ENTRÉE D'ORIGINE OFFICIELLE UNIQUEMENT. Cette fonction n'est appelée que
 * sur le résultat de `lookupByName`. Jamais sur le corps de la requête, jamais
 * sur `Lead.website` : normaliser une valeur non autoritaire ne la rendrait pas
 * autoritaire, cela ne ferait que lui en donner l'apparence.
 *
 * Valeur vide, malformée, ou de schéma non HTTP(S) ⇒ `undefined`. Un site
 * illisible ne décerne aucun grade — il ne se devine pas.
 */
export function urlOfficielleAbsolue(valeur: unknown): string | undefined {
  if (typeof valeur !== 'string') return undefined
  const v = valeur.trim()
  if (!v) return undefined

  // Déjà absolue : on n'accepte que HTTP(S). `javascript:`, `data:`, `ftp:` et
  // consorts ne sont pas des sites d'entreprise.
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    try {
      const u = new URL(v)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined
    } catch {
      return undefined
    }
  }

  // Forme nue du registre (`acme.fr`, `acme.fr/contact`) : on la présente en
  // HTTPS. Le point est exigé — `//x` ou `acme` ne sont pas des noms d'hôte.
  if (!/^[^\s/]+\.[^\s/]+/.test(v)) return undefined
  try {
    const u = new URL(`https://${v}`)
    return u.hostname.includes('.') ? u.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * Faits externes DÉJÀ ADJUGÉS pour ce compte, plus ceux qu'on vient d'accepter.
 *
 * ⚠️ CE QUI EST FILTRÉ, ET POURQUOI. Seuls les faits de provenance EXTERNE
 * entrent : les evidences CRM sont déjà produites par `evidenceFromLeads` dans
 * l'orchestrateur, et les recharger les dédoublerait.
 *
 * ⚠️ LE FILTRE PAR COMPTE EST REDONDANT — ET ASSUMÉ COMME TEL. `situationEngine`
 * écarte DÉJÀ toute evidence dont l'`accountId` diffère de la cible
 * (`situationEngine.ts:73`), et l'évaluation ne porte que sur `leads: [lead]`.
 * Retirer cette ligne ne change donc AUCUN comportement observable aujourd'hui :
 * c'est une défense en profondeur, pas la garde de cloisonnement. Ne pas la
 * présenter comme telle — la vraie garde est dans le moteur, et c'est là qu'il
 * faut la vérifier.
 *
 * ⚠️ DÉDUPLICATION PAR IDENTIFIANT, LE NOUVEAU L'EMPORTE. Les identifiants sont
 * déterministes : reconfirmer le même fait doit le remplacer, jamais en créer
 * un second qui compterait deux fois dans une convergence.
 *
 * ⚠️ LECTURE STRICTE — ET MA JUSTIFICATION R1b ÉTAIT FAUSSE. J'avais écrit ici
 * qu'une panne de lecture allait « dans le sens fermé : moins de situations ».
 * C'est INEXACT avec l'arbitrage réel de `sales-core`. Un fait historique
 * manquant ne retire pas seulement `sales_scale_up` : il fait BASCULER le
 * résultat vers `strong_signal_low_context`, une AUTRE recommandation. Une
 * panne de stockage changeait donc le conseil rendu à l'utilisateur, au lieu de
 * simplement en retirer un. « Moins de données » n'est pas « plus prudent ».
 *
 * Une histoire illisible n'est pas une histoire vide : on s'arrête.
 */
/**
 * Enregistre UNE assertion par source qualifiante de chaque promotion.
 *
 * ⚠️ NE PROPAGE AUCUNE ERREUR, ET C'EST LE CONTRAT. Cette fonction ne peut pas
 * faire échouer une adjudication : elle est enveloppée d'un `try` qui absorbe
 * tout, y compris une exception de la couche de persistance. Un registre
 * d'audit qui casserait le produit qu'il observe serait un mauvais échange.
 *
 * ⚠️ AUCUN DÉTAIL NE PART DANS LA RÉPONSE HTTP. `logSafeError` seul — un état
 * d'écriture du registre renseignerait un appelant sur la configuration
 * interne, et il n'a rien à en faire.
 */
async function journaliserAssertions(
  promotions: readonly BridgePromotion[], ws: string,
): Promise<void> {
  const lots: AssertionBuildInput[] = promotions.map((p) => ({
    workspaceId: ws,
    accountId: p.evidence.accountId,
    canonicalClaimKey: p.canonicalKey,
    evidence: p.evidence,
    qualifyingSources: p.qualifyingSources,
  }))

  // ── LE REGISTRE COMMANDE. LES ANCRES EN DÉPENDENT. ──────────────────────
  // ⚠️ LES DEUX DRAPEAUX NE SONT PLUS INDÉPENDANTS, ET C'ÉTAIT UN DÉFAUT.
  // `CANONICAL_FACTS` allumé pendant que `SOURCE_ASSERTIONS` était éteint
  // écrivait des faits canoniques SANS AUCUNE assertion persistée : des ancres
  // orphelines, affirmant un fait dont l'appui n'était reconstructible nulle
  // part. Le registre est l'histoire ; l'ancre n'en est qu'une projection.
  if (!sourceAssertionsEnabled()) return

  const bilan = await recordSourceAssertions(lots, ws)
  // ⚠️ OBSERVABLE EN INTERNE, MUET VERS L'EXTÉRIEUR. Un état d'écriture
  // renseignerait un appelant sur la configuration interne, et il n'a rien à
  // en faire.
  if (bilan.failed > 0) {
    logSafeError('signals.source_assertion_write', new Error('ledger_write_failed'), {
      operation: 'signals_promote',
    })
  }

  if (!canonicalFactsEnabled()) return

  // ⚠️ SEULES LES ASSERTIONS CONFIRMÉES EN BASE SOUTIENNENT UNE ANCRE. Un objet
  // construit en mémoire ne prouve rien : si son écriture a échoué, le fait
  // qu'il soutiendrait n'aurait aucune trace durable. Un ensemble vide ne
  // produit donc aucune ancre — fail closed.
  const ancres = await recordCanonicalAnchors(lots, ws, new Set(bilan.durableIds))
  if (ancres.failed > 0) {
    logSafeError('signals.canonical_anchor_write', new Error('anchor_write_failed'), {
      operation: 'signals_promote',
    })
  }
}

async function accumulerFaitsExternes(
  nouveaux: readonly KnownEvidenceEvent[],
  accountId: string,
  ws: string,
): Promise<{ ok: true; values: KnownEvidenceEvent[] } | { ok: false; reason: 'invalid' | 'unavailable' }> {
  const parId = new Map<string, KnownEvidenceEvent>()

  const histoire = await listEvidenceStrict(ws)
  if (histoire.ok === false) return { ok: false, reason: histoire.reason }

  for (const e of histoire.values) {
    if (e?.accountId !== accountId) continue
    if (e?.source?.provider !== EXTERNAL_SIGNAL_PROVIDER) continue
    parId.set(e.id, e as KnownEvidenceEvent)
  }

  // Les faits fraîchement adjugés écrasent leur version antérieure.
  for (const e of nouveaux) parId.set(e.id, e)

  const values = [...parId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { ok: true, values }
}

function safeParse(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
