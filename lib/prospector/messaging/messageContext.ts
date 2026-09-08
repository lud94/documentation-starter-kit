// JS-015_MESSAGING_ARCHITECTURE_V0_001 — B1 : LE CONTRAT DE HANDOFF.
//
// ── CE QUE CE MODULE EST ────────────────────────────────────────────────────
// MessageReadyContextV0 : le handoff STRUCTURÉ vers le futur Message Engine,
// et sa validation STRICTE fail-closed. Chaque décision commerciale (QUI,
// POURQUOI, QUAND, QUELLE ACTION, QUELLE OFFRE, QUEL CANAL) arrive DÉJÀ prise
// par l'amont — le validateur REFUSE, il n'infère JAMAIS une décision absente.
//
// ── CE QUE CE MODULE N'EST PAS ──────────────────────────────────────────────
// Pas un moteur : pas de résolution d'identité, pas de Final NBA, pas de choix
// d'offre, pas de LLM, pas d'E/S. PUR.
//
// ── PROPRIÉTÉS GELÉES (B0) ──────────────────────────────────────────────────
// Recommendation Prospector ≠ selectedAction : le Candidate Play INFORME
// Jarvis, il ne devient JAMAIS l'action autoritaire — ce module n'importe
// RIEN du moteur proactif et son entrée n'a aucun champ de recommandation.
// WHY NOW ≠ WHY TALK. offerRef ≠ offerAngle. WhatsApp : hors contrat V0.
// Identité non RESOLVED ⇒ fermé. Version de schéma inconnue ⇒ fermé (R4-C3).
//
// ── TYPES ÉPISTÉMIQUES CANONIQUES (R4-C2) ───────────────────────────────────
// La force d'évidence et l'autorité temporelle sont les types CANONIQUES du
// repo (proactive/types), importés en TYPE-ONLY — jamais dupliqués, jamais
// ré-inventés en vocabulaire messaging.
import type { EvidenceStrengthV0, SignalTemporalAuthority } from '../proactive/types'
// Import RUNTIME borné et AUTORISÉ : le validateur canonique de jour calendaire
// RÉEL appartient déjà au module de types acyclique — jamais dupliqué ici.
import { jourReel } from '../proactive/types'

// ── VOCABULAIRES V0 — FERMÉS (B0, ne pas étendre sans gel) ──────────────────

export const SELECTED_ACTIONS_V0 = Object.freeze(['START_OUTREACH', 'FOLLOW_UP', 'REPLY'] as const)
export type SelectedActionV0 = typeof SELECTED_ACTIONS_V0[number]

export const MESSAGE_CHANNELS_V0 = Object.freeze(['linkedin', 'email'] as const)
export type MessageChannelV0 = typeof MESSAGE_CHANNELS_V0[number]

export const RECIPIENT_IDENTITY_STATES_V0 = Object.freeze(['RESOLVED', 'NEEDS_REVIEW', 'UNRESOLVED'] as const)
export type RecipientIdentityStateV0 = typeof RECIPIENT_IDENTITY_STATES_V0[number]

export const RELATIONSHIP_STATES_V0 = Object.freeze(
  ['COLD', 'KNOWN', 'ACTIVE_THREAD', 'REPLY_RECEIVED', 'CUSTOMER'] as const)
export type RelationshipStateV0 = typeof RELATIONSHIP_STATES_V0[number]

export const OUTREACH_OBJECTIVES_V0 = Object.freeze(
  ['OPEN_CONVERSATION', 'LEARN_HIGH_VALUE_UNKNOWN', 'ADVANCE_CONVERSATION'] as const)
export type OutreachObjectiveV0 = typeof OUTREACH_OBJECTIVES_V0[number]

// ── ÉVIDENCE DE COMMUNICATION — PROVENANCE OBLIGATOIRE ──────────────────────
//
// « Research Shown ⊆ eligible Research Used » n'est prouvable que si chaque
// item porte sa lignée. Un `Lead.icebreaker` brut n'a NI ref NI source NI
// date : il est STRUCTURELLEMENT inadmissible ici (aucun champ ne peut le
// porter sans provenance).

export interface CommunicationEvidenceItemV0 {
  /** Ref d'évidence/assertion canonique (ev_/cev_/csn_/sa_…). JAMAIS vide. */
  readonly evidenceRef: string
  /** Énoncé factuel COMMUNICABLE, adossé à la ref — pas une hypothèse. */
  readonly statement: string
  /** Provenance minimale reconstructible. */
  readonly provenance: { readonly sourceRef: string; readonly observedAt: string }
  readonly strength?: EvidenceStrengthV0
  readonly temporalAuthority?: SignalTemporalAuthority
  /** L'incertitude et les contre-signaux SURVIVENT jusqu'ici — jamais gommés. */
  readonly uncertainty?: string
  readonly counterSignalRefs?: readonly string[]
}

// ── BUDGETS ET CONTRAINTES DE CLAIMS ────────────────────────────────────────

/**
 * Budgets — entiers ≥ 0. ZÉRO EST LÉGITIME (R2-C1) : un budget nul signifie
 * « aucun octroi au rédacteur », jamais « contexte malformé ». Un message
 * relationnel/interrogatif sans recherche exposée est représentable ; le
 * contexte peut conserver communicationEvidence pour la provenance/l'audit —
 * zéro octroi n'exige pas d'effacer l'évidence amont.
 */
export interface MessagingBudgetsV0 {
  /** Nombre max d'assertions factuelles externes dans le message (0 = aucune). */
  readonly assertionBudget: number
  /** Nombre max d'items d'évidence CONSOMMABLES par le rédacteur (0 = aucun). */
  readonly evidenceBudget: number
  /** Nombre max d'items MONTRABLES (Research Shown) — ≤ evidenceBudget. */
  readonly researchShownBudget: number
}

/**
 * Contraintes épistémiques PRÉSERVÉES par ref (R2-C3) — TRANSPORT SANS PERTE,
 * jamais interprétation : B1 ne décide aucun seuil de fraîcheur ni règle de
 * formulation ; il garantit que B2 recevra, DISTINCTEMENT, ce que l'évidence
 * portait. Les contre-signaux restent des contre-signaux — jamais aplatis en
 * incertitude générique.
 */
export interface EpistemicConstraintV0 {
  readonly uncertainty?: string
  readonly temporalAuthority?: SignalTemporalAuthority
  readonly counterSignalRefs?: readonly string[]
  readonly strength?: EvidenceStrengthV0
}

/**
 * Contraintes de claims DÉRIVÉES en amont (évidence + incertitude + autorité
 * temporelle + budgets + interdits). PAS de l'improvisation de copywriter.
 * `showableEvidenceRefs` DOIT être un sous-ensemble des refs de
 * communicationEvidence — c'est la matérialisation de Shown ⊆ Used.
 * `forbiddenClaims` reste STRUCTURELLEMENT SÉPARÉ (jamais fusionné ici).
 */
export interface ClaimConstraintsV0 {
  readonly showableEvidenceRefs: readonly string[]
  /** Assertions dont la formulation certaine est INTERDITE (incertitude vivante). */
  readonly uncertainAssertionRefs: readonly string[]
  /** ≤ assertionBudget ; 0 = aucune assertion octroyée. */
  readonly maxAssertions: number
  /** Épistémique PAR REF — présent quand l'évidence le porte, distinct par nature. */
  readonly epistemicByRef: Readonly<Record<string, EpistemicConstraintV0>>
}

export interface ForbiddenClaimsV0 {
  /** Termes/claims interdits — BLOQUANTS dans le nouveau chemin, jamais advisory. */
  readonly terms: readonly string[]
}

// ── LE CONTRAT ──────────────────────────────────────────────────────────────

export interface MessageReadyContextV0 {
  schemaVersion: 'message-ready-context-v0.1'
  recipientRef: string
  recipientIdentityState: RecipientIdentityStateV0
  /** Décision Jarvis Final NBA / amont EXPLICITE — jamais une Recommendation. */
  selectedAction: SelectedActionV0
  outreachObjective: OutreachObjectiveV0
  /** Ref de Situation sélectionnée (handoff Prospector/Jarvis). */
  selectedSituation: string
  /** POURQUOI MAINTENANT — raisonnement compte/domaine. Jamais fabriqué par la persona. */
  whyNow: string
  /** POURQUOI LUI/ELLE — pertinence du destinataire. Ne crée JAMAIS un whyNow. */
  whyTalk: string
  /** Identité d'offre amont. Le moteur ne choisit JAMAIS une autre offre. */
  offerRef: string
  /** Cadrage commercial amont de CETTE offre. */
  offerAngle: string
  personaRole: string
  relationshipState: RelationshipStateV0
  relationshipContextRef?: string
  channel: MessageChannelV0
  /** Question d'information à haute valeur (optionnelle, jamais inventée). */
  highValueUnknown?: string
  budgets: MessagingBudgetsV0
  claimConstraints: ClaimConstraintsV0
  forbiddenClaims: ForbiddenClaimsV0
  communicationEvidence: readonly CommunicationEvidenceItemV0[]
}

// ── VALIDATION STRICTE — FAIL CLOSED, ZÉRO INFÉRENCE ────────────────────────

const VALIDATED = Symbol('message-ready-context-validated')

/** Contexte VALIDÉ — le SEUL type que la frontière du Message Engine accepte. */
export interface ValidatedMessageReadyContextV0 {
  readonly [VALIDATED]: true
  readonly context: MessageReadyContextV0
}

export type ContextRejectionReason =
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_EPISTEMIC_EVIDENCE'
  | 'IDENTITY_NOT_RESOLVED'
  | 'UNSUPPORTED_CHANNEL'
  | 'MISSING_SELECTED_ACTION'
  | 'MISSING_OUTREACH_OBJECTIVE'
  | 'MISSING_WHY_NOW'
  | 'MISSING_WHY_TALK'
  | 'MISSING_OFFER_REF'
  | 'MISSING_OFFER_ANGLE'
  | 'MISSING_RECIPIENT'
  | 'MISSING_SELECTED_SITUATION'
  | 'MISSING_PERSONA_ROLE'
  | 'INVALID_RELATIONSHIP_STATE'
  | 'MALFORMED_BUDGETS'
  | 'EVIDENCE_WITHOUT_PROVENANCE'
  | 'CLAIM_CONSTRAINT_INCONSISTENT'
  | 'MISSING_FORBIDDEN_CLAIMS'

export type ContextValidation =
  | { ok: true; validated: ValidatedMessageReadyContextV0 }
  | { ok: false; reasons: readonly ContextRejectionReason[] }

const texteNonVide = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

// ── GARDES RUNTIME DES TYPES ÉPISTÉMIQUES CANONIQUES (micro-patch) ──────────
// Les types TypeScript disparaissent au runtime : ces listes locales sont
// VÉRIFIÉES À LA COMPILATION contre les unions canoniques — si l'union
// canonique évolue, la garde cesse de compiler au lieu de diverger.
const STRENGTH_KINDS = ['EXTERNAL_CONFIRMED_CANONICAL', 'INTERNAL_RECORD', 'INTERNAL_CORROBORATED_RECORD'] as const satisfies readonly EvidenceStrengthV0['kind'][]
type _ForceExhaustive = Exclude<EvidenceStrengthV0['kind'], typeof STRENGTH_KINDS[number]> extends never ? true : never
const _forceExhaustive: _ForceExhaustive = true
void _forceExhaustive

const TEMPORAL_BASES = ['DATED_EVENT_DAY', 'EXTERNAL_STATE_OBSERVED_DAY'] as const satisfies readonly SignalTemporalAuthority['basis'][]
type _TemporalExhaustive = Exclude<SignalTemporalAuthority['basis'], typeof TEMPORAL_BASES[number]> extends never ? true : never
const _temporalExhaustive: _TemporalExhaustive = true
void _temporalExhaustive

/** Forme canonique EvidenceStrengthV0 — {kind} EXACT, rien d'autre. */
const forceCanonique = (v: unknown): v is EvidenceStrengthV0 =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
  && (STRENGTH_KINDS as readonly string[]).includes((v as any).kind)
  && Object.keys(v).length === 1

/** Forme canonique SignalTemporalAuthority — basis canonique + jour RÉEL (jourReel). */
const temporelCanonique = (v: unknown): v is SignalTemporalAuthority =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
  && (TEMPORAL_BASES as readonly string[]).includes((v as any).basis)
  && jourReel((v as any).referenceDay)
  && Object.keys(v).length === 2

const refsContreSignauxValides = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((r) => texteNonVide(r))

/** Égalité de VALEUR des faits épistémiques (objets canoniques plats/tableaux). */
const memeValeur = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
/** R2-C1 — ZÉRO est un budget légitime : entier ≥ 0 ; négatif/non-entier restent invalides. */
const entierNonNegatif = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0

/**
 * Valide SANS inférer. Une décision commerciale absente est un REFUS, jamais
 * un défaut deviné — le validateur ne connaît ni Lead, ni Recommendation, ni
 * historique : il juge le contexte tel que l'amont l'a ASSUMÉ.
 */
export function validateMessageReadyContext(input: unknown): ContextValidation {
  const reasons: ContextRejectionReason[] = []
  const c = (input ?? {}) as Partial<MessageReadyContextV0> & Record<string, unknown>

  // R4-C3 — version de schéma : v0.1 EXACTEMENT. Absente, inconnue ou future
  // ⇒ fermé — jamais de montée/descente silencieuse de version.
  if (c.schemaVersion !== 'message-ready-context-v0.1') {
    reasons.push('UNSUPPORTED_SCHEMA_VERSION')
  }

  // Identité : seul RESOLVED passe. NEEDS_REVIEW/UNRESOLVED ⇒ fermé.
  if (c.recipientIdentityState !== 'RESOLVED') reasons.push('IDENTITY_NOT_RESOLVED')
  if (!texteNonVide(c.recipientRef)) reasons.push('MISSING_RECIPIENT')

  // Canal : registre V0 fermé — 'whatsapp' (ou tout autre) est REFUSÉ ici,
  // sans supprimer le legacy UI : il n'est simplement pas ADMIS au contrat.
  if (!(MESSAGE_CHANNELS_V0 as readonly string[]).includes(c.channel as string)) {
    reasons.push('UNSUPPORTED_CHANNEL')
  }

  // Décisions amont OBLIGATOIRES — un objet Recommendation, une chaîne libre
  // ou une absence ne satisfont JAMAIS selectedAction.
  if (!(SELECTED_ACTIONS_V0 as readonly string[]).includes(c.selectedAction as string)) {
    reasons.push('MISSING_SELECTED_ACTION')
  }
  if (!(OUTREACH_OBJECTIVES_V0 as readonly string[]).includes(c.outreachObjective as string)) {
    reasons.push('MISSING_OUTREACH_OBJECTIVE')
  }
  if (!texteNonVide(c.selectedSituation)) reasons.push('MISSING_SELECTED_SITUATION')
  if (!texteNonVide(c.whyNow)) reasons.push('MISSING_WHY_NOW')
  if (!texteNonVide(c.whyTalk)) reasons.push('MISSING_WHY_TALK')
  if (!texteNonVide(c.offerRef)) reasons.push('MISSING_OFFER_REF')
  if (!texteNonVide(c.offerAngle)) reasons.push('MISSING_OFFER_ANGLE')
  if (!texteNonVide(c.personaRole)) reasons.push('MISSING_PERSONA_ROLE')
  if (!(RELATIONSHIP_STATES_V0 as readonly string[]).includes(c.relationshipState as string)) {
    reasons.push('INVALID_RELATIONSHIP_STATE')
  }

  // Budgets : entiers ≥ 0 (zéro = zéro octroi, LÉGITIME), Shown ≤ Used.
  const b = c.budgets as MessagingBudgetsV0 | undefined
  if (!b || !entierNonNegatif(b.assertionBudget) || !entierNonNegatif(b.evidenceBudget)
    || !entierNonNegatif(b.researchShownBudget) || b.researchShownBudget > b.evidenceBudget) {
    reasons.push('MALFORMED_BUDGETS')
  }

  // Évidence : chaque item DOIT porter ref + provenance (source + date), et
  // — micro-patch — ses champs épistémiques DÉCLARÉS doivent avoir la forme
  // canonique RUNTIME : force {kind canonique}, autorité temporelle
  // {basis canonique + jour calendaire RÉEL}, incertitude non vide,
  // contre-signaux = tableau de chaînes non vides. Une ref DUPLIQUÉE est
  // aussi refusée : la politique de claims est indexée par ref — deux items
  // homonymes pourraient porter des états épistémiques contradictoires.
  const evidence = Array.isArray(c.communicationEvidence) ? c.communicationEvidence : null
  if (evidence === null) {
    reasons.push('EVIDENCE_WITHOUT_PROVENANCE')
  } else {
    const refsVues = new Set<string>()
    for (const item of evidence as CommunicationEvidenceItemV0[]) {
      if (!texteNonVide(item?.evidenceRef) || !texteNonVide(item?.statement)
        || !texteNonVide(item?.provenance?.sourceRef) || !texteNonVide(item?.provenance?.observedAt)) {
        reasons.push('EVIDENCE_WITHOUT_PROVENANCE')
        break
      }
      if (refsVues.has(item.evidenceRef)) { reasons.push('INVALID_EPISTEMIC_EVIDENCE'); break }
      refsVues.add(item.evidenceRef)
      if ((item as any).strength !== undefined && !forceCanonique((item as any).strength)) {
        reasons.push('INVALID_EPISTEMIC_EVIDENCE'); break
      }
      if ((item as any).temporalAuthority !== undefined && !temporelCanonique((item as any).temporalAuthority)) {
        reasons.push('INVALID_EPISTEMIC_EVIDENCE'); break
      }
      if ((item as any).uncertainty !== undefined && !texteNonVide((item as any).uncertainty)) {
        reasons.push('INVALID_EPISTEMIC_EVIDENCE'); break
      }
      if ((item as any).counterSignalRefs !== undefined && !refsContreSignauxValides((item as any).counterSignalRefs)) {
        reasons.push('INVALID_EPISTEMIC_EVIDENCE'); break
      }
    }
  }

  // Contraintes de claims : Shown ⊆ Used STRUCTUREL — toute ref montrable
  // absente de communicationEvidence est une incohérence, donc un refus.
  const cc = c.claimConstraints as ClaimConstraintsV0 | undefined
  if (!cc || !Array.isArray(cc.showableEvidenceRefs) || !Array.isArray(cc.uncertainAssertionRefs)
    || !entierNonNegatif(cc.maxAssertions)
    || typeof cc.epistemicByRef !== 'object' || cc.epistemicByRef === null || Array.isArray(cc.epistemicByRef)) {
    reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
  } else if (evidence !== null) {
    const refsUtilisables = new Set((evidence as CommunicationEvidenceItemV0[]).map((e) => e?.evidenceRef))
    if (cc.showableEvidenceRefs.some((r) => !refsUtilisables.has(r))) {
      reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
    }
    // L'épistémique préservé ne peut viser que des refs réellement utilisées.
    if (Object.keys(cc.epistemicByRef).some((r) => !refsUtilisables.has(r))) {
      reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
    }
    // R4-C5 — uncertainAssertionRefs STRICT : chaque entrée est une chaîne
    // non vide, référence une évidence utilisée, ET porte une VRAIE
    // incertitude dans epistemicByRef. Réciproquement, toute ref dont
    // l'épistémique porte une incertitude réelle DOIT y figurer.
    // (CONTRE-SIGNAL ≠ INCERTITUDE : un contre-signal seul n'y entre pas.)
    const incertitudeReelle = (r: string) => {
      const e = cc.epistemicByRef[r]
      return e !== undefined && typeof e.uncertainty === 'string' && e.uncertainty.trim().length > 0
    }
    if (cc.uncertainAssertionRefs.some((r) =>
      typeof r !== 'string' || r.trim().length === 0 || !refsUtilisables.has(r) || !incertitudeReelle(r))) {
      reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
    }
    const declares = new Set(cc.uncertainAssertionRefs)
    for (const [r, e] of Object.entries(cc.epistemicByRef)) {
      if (typeof e?.uncertainty === 'string' && e.uncertainty.trim().length > 0 && !declares.has(r)) {
        reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
        break
      }
    }
    // ── Micro-patch : FORME runtime de chaque entrée epistemicByRef. ────────
    for (const e of Object.values(cc.epistemicByRef)) {
      if (typeof e !== 'object' || e === null || Array.isArray(e)
        || (e.uncertainty !== undefined && !texteNonVide(e.uncertainty))
        || ((e as any).strength !== undefined && !forceCanonique((e as any).strength))
        || ((e as any).temporalAuthority !== undefined && !temporelCanonique((e as any).temporalAuthority))
        || ((e as any).counterSignalRefs !== undefined && !refsContreSignauxValides((e as any).counterSignalRefs))) {
        reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
        break
      }
    }
    // ── Micro-patch : COHÉRENCE DE LIGNÉE évidence ↔ epistemicByRef. ────────
    // epistemicByRef est une PRÉSERVATION DÉRIVÉE : aucun fait épistémique ne
    // peut y être inventé, aucun fait porté par l'évidence ne peut en
    // disparaître ni y différer. Égalité de VALEUR — zéro interprétation,
    // zéro seuil, zéro score. Les contre-signaux restent des contre-signaux.
    if (evidence !== null) {
      const CHAMPS = ['uncertainty', 'temporalAuthority', 'counterSignalRefs', 'strength'] as const
      for (const item of evidence as CommunicationEvidenceItemV0[]) {
        const entree = cc.epistemicByRef[item?.evidenceRef] as EpistemicConstraintV0 | undefined
        const porteQuelqueChose = CHAMPS.some((ch) => (item as any)?.[ch] !== undefined)
        if (porteQuelqueChose && entree === undefined) {
          reasons.push('CLAIM_CONSTRAINT_INCONSISTENT'); break
        }
        if (entree === undefined) continue
        let incoherent = false
        for (const ch of CHAMPS) {
          if (!memeValeur((item as any)?.[ch], (entree as any)?.[ch])) { incoherent = true; break }
        }
        if (incoherent) { reasons.push('CLAIM_CONSTRAINT_INCONSISTENT'); break }
      }
    }
    if (b) {
      // R2-C1 — cohérence des octrois nuls : Shown=0 ⇒ AUCUNE ref montrable ;
      // le montrable respecte AUSSI le budget d'évidence consommable ; et
      // maxAssertions ne dépasse jamais l'assertionBudget (0 ⇒ 0).
      if (cc.showableEvidenceRefs.length > b.researchShownBudget) {
        reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
      }
      if (cc.showableEvidenceRefs.length > b.evidenceBudget) {
        reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
      }
      if (cc.maxAssertions > b.assertionBudget) {
        reasons.push('CLAIM_CONSTRAINT_INCONSISTENT')
      }
    }
  }

  // R4-C6 — les termes interdits doivent être SÛRS au runtime : chaque item
  // est une chaîne non vide après trim. Un nombre, null, un objet ou une
  // chaîne blanche ferait exploser l'application aval — on REFUSE, on ne
  // coerce pas, on n'écarte pas en silence.
  const fc = c.forbiddenClaims as ForbiddenClaimsV0 | undefined
  if (!fc || !Array.isArray(fc.terms)
    || fc.terms.some((t) => typeof t !== 'string' || t.trim().length === 0)) {
    reasons.push('MISSING_FORBIDDEN_CLAIMS')
  }

  if (reasons.length > 0) return { ok: false, reasons: Object.freeze([...new Set(reasons)]) }

  // ── PROJECTION CANONIQUE DE SORTIE (micro-patch) ──────────────────────────
  // On ne marque JAMAIS l'objet de l'appelant : un champ non déclaré
  // (rawLead, rawResearchDump, propriété imbriquée parasite) survivrait dans
  // le contexte marqué et franchirait la frontière du moteur. Le contexte
  // marqué est un objet NEUF, construit champ par champ — projection, jamais
  // inférence : aucune valeur manquante n'est devinée, les optionnels
  // malformés n'atteignent pas la sortie.
  const v = c as MessageReadyContextV0
  const projetEpistemique = (e: EpistemicConstraintV0): EpistemicConstraintV0 => Object.freeze({
    ...(e.uncertainty !== undefined ? { uncertainty: e.uncertainty } : {}),
    ...(e.temporalAuthority !== undefined ? { temporalAuthority: e.temporalAuthority } : {}),
    ...(e.counterSignalRefs !== undefined ? { counterSignalRefs: Object.freeze([...e.counterSignalRefs]) } : {}),
    ...(e.strength !== undefined ? { strength: e.strength } : {}),
  })
  const epistemicByRef: Record<string, EpistemicConstraintV0> = {}
  for (const [r, e] of Object.entries(v.claimConstraints.epistemicByRef)) {
    epistemicByRef[r] = projetEpistemique(e)
  }
  const canonique: MessageReadyContextV0 = Object.freeze({
    schemaVersion: 'message-ready-context-v0.1' as const,
    recipientRef: v.recipientRef,
    recipientIdentityState: v.recipientIdentityState,
    selectedAction: v.selectedAction,
    outreachObjective: v.outreachObjective,
    selectedSituation: v.selectedSituation,
    whyNow: v.whyNow,
    whyTalk: v.whyTalk,
    offerRef: v.offerRef,
    offerAngle: v.offerAngle,
    personaRole: v.personaRole,
    relationshipState: v.relationshipState,
    ...(texteNonVide(v.relationshipContextRef) ? { relationshipContextRef: v.relationshipContextRef } : {}),
    channel: v.channel,
    ...(texteNonVide(v.highValueUnknown) ? { highValueUnknown: v.highValueUnknown } : {}),
    budgets: Object.freeze({
      assertionBudget: v.budgets.assertionBudget,
      evidenceBudget: v.budgets.evidenceBudget,
      researchShownBudget: v.budgets.researchShownBudget,
    }),
    claimConstraints: Object.freeze({
      showableEvidenceRefs: Object.freeze([...v.claimConstraints.showableEvidenceRefs]),
      uncertainAssertionRefs: Object.freeze([...v.claimConstraints.uncertainAssertionRefs]),
      maxAssertions: v.claimConstraints.maxAssertions,
      epistemicByRef: Object.freeze(epistemicByRef),
    }),
    forbiddenClaims: Object.freeze({ terms: Object.freeze([...v.forbiddenClaims.terms]) }),
    communicationEvidence: Object.freeze(v.communicationEvidence.map((item) => Object.freeze({
      evidenceRef: item.evidenceRef,
      statement: item.statement,
      provenance: Object.freeze({ sourceRef: item.provenance.sourceRef, observedAt: item.provenance.observedAt }),
      ...(item.strength !== undefined ? { strength: item.strength } : {}),
      ...(item.temporalAuthority !== undefined ? { temporalAuthority: item.temporalAuthority } : {}),
      ...(item.uncertainty !== undefined ? { uncertainty: item.uncertainty } : {}),
      ...(item.counterSignalRefs !== undefined ? { counterSignalRefs: Object.freeze([...item.counterSignalRefs]) } : {}),
    }))),
  })
  return {
    ok: true,
    validated: Object.freeze({ [VALIDATED]: true as const, context: canonique }),
  }
}

/** Garde de frontière : SEUL un objet issu de validateMessageReadyContext passe. */
export function isValidatedContext(value: unknown): value is ValidatedMessageReadyContextV0 {
  return typeof value === 'object' && value !== null && (value as any)[VALIDATED] === true
}
