// JS-006_ROLE_CARDS_V0_002 — CONTRAT ROLECARD V0 : REGISTRE + ADAPTATEUR.
//
// ── UNE RÉALITÉ MÉTIER, PLUSIEURS PROJECTIONS DE RÔLE ───────────────────────
// Un rôle ne crée AUCUNE vérité séparée : Evidence / Signal / Situation /
// Recommendation restent partagés et le moteur actuel reste AVEUGLE au rôle.
// Le rôle change la projection, la pertinence, la profondeur d'information et
// la posture produit — jamais les faits.
//
// ── CE QUE CE MODULE EST, ET N'EST PAS ──────────────────────────────────────
//   EST     : le contrat versionné, le registre des quatre cartes V0, et
//             l'adaptateur FERMÉ des indices de rôle hérités.
//   N'EST PAS: une autorité de sécurité (JS-020), un modèle de motion
//             (JS-011), un BusinessContext (JS-012), un catalogue de Missions
//             (JS-007), ni une surveillance (JS-013).
//
// ── RÔLE ≠ AUTORISATION — ET C'EST STRUCTUREL ───────────────────────────────
// `autonomyDefaults` est une POSTURE PRODUIT DÉCLARATIVE. Elle n'accorde
// aucun droit : les outils de Mission, les approbations, le cloisonnement d'espace,
// `authorizedMotions` et les gardes de capacité restent les seules autorités
// d'exécution. Ce module n'est importé par AUCUN chemin d'exécution — un test
// structurel le verrouille, et l'autorisation effective viendra de JS-020 :
//   permission effective = portée utilisateur/rôle ∩ politique d'espace
//                          ∩ Mission ∩ politique de capacité.
//
// ── SOURCE DE VÉRITÉ DU RÔLE UTILISATEUR — PAS ICI, PAS ENCORE ─────────────
// `BusinessContextV0.role` est un INDICE HÉRITÉ, cloisonné à l'ESPACE, alors
// que plusieurs utilisateurs d'un même espace auront des rôles différents.
// L'affectation canonique par utilisateur/membership est une frontière future
// (onboarding / JS-020). Ce module se contente de RÉSOUDRE l'indice hérité —
// fermé, exact, sans repli — vers une carte canonique ou un état explicite.
//
// ── LECTURE ≠ REVALIDATION ──────────────────────────────────────────────────
// Tout est constant et pur : aucune E/S, aucun LLM, aucun réseau, aucune
// écriture, aucune création de Mission. Le silence est un résultat valide
// pour chaque rôle — « aucun changement matériel » ne produit ni vérité ni
// attention (la cadence de veille appartient à JS-013).

export const ROLECARD_SCHEMA_VERSION = 'rolecard-v0.1'
export const ROLECARD_VERSION = 'v0.1'

/**
 * IDENTIFIANTS CANONIQUES V0 — union FERMÉE.
 *
 * ⚠️ PAS de CEO, pas d'admin/client (c'est l'authentification, pas un rôle
 * produit), pas de « broker » (vertical Fabel : hors cartes Sales V0), pas de
 * hiérarchie RBAC générique. SDR et BDR fusionnés en V0 — une scission future
 * serait additive.
 */
export type RoleKind =
  | 'SDR_BDR'
  | 'ACCOUNT_EXECUTIVE'
  | 'ACCOUNT_MANAGER_KAM'
  | 'HEAD_OF_SALES'

export const ROLE_KINDS: readonly RoleKind[] = Object.freeze([
  'SDR_BDR',
  'ACCOUNT_EXECUTIVE',
  'ACCOUNT_MANAGER_KAM',
  'HEAD_OF_SALES',
])

/**
 * INTENTIONS DE MISSION PAR RÔLE — catalogue FERMÉ, local au contrat V0.
 *
 * ⚠️ CE NE SONT PAS des références à des objets Mission existants, et cela ne
 * crée AUCUN MissionType (JS-007). Aucune Mission n'est créée ni activée du
 * seul fait qu'un utilisateur porte un rôle : l'activation reste explicite et
 * gouvernée. Ces identifiants disent seulement « ce que ce rôle vient
 * typiquement faire ici ».
 */
export type RoleMissionIntent =
  | 'FIND_NEW_OPPORTUNITIES'
  | 'QUALIFY_NEW_LEADS'
  | 'FOLLOW_UP_COMMITMENTS'
  | 'PREPARE_CALLS'
  | 'ADVANCE_OWNED_OPPORTUNITIES'
  | 'PREPARE_DEAL_MEETING'
  | 'REVIEW_STRATEGIC_ACCOUNTS'
  | 'MONITOR_ACCOUNT'
  | 'EXPANSION_REVIEW'
  | 'PREPARE_ACCOUNT_MEETING'
  | 'WEEKLY_FORECAST_REVIEW'
  | 'PIPELINE_GAP_REVIEW'
  | 'TEAM_ATTENTION_REVIEW'
  | 'NEXT_QUARTER_PREP'

/**
 * PROFIL D'ATTENTION — ce que le rôle PEUT déclarer sans implémenter JS-019.
 *
 * ⚠️ Déclare des catégories, une granularité, une sensibilité — JAMAIS un
 * score de priorité final, une vérité de situation, un classement d'affaires,
 * une confiance factuelle ni une éligibilité de recommandation. La priorité
 * finale/globale reste Jarvis Sales Attention.
 */
export interface RoleAttentionProfile {
  readonly scope: 'INDIVIDUAL_ITEMS' | 'PORTFOLIO' | 'TEAM_AGGREGATE'
  readonly granularity: 'PER_LEAD' | 'PER_ACCOUNT' | 'PER_PIPELINE'
  readonly interruptionSensitivity: 'HIGH' | 'MEDIUM' | 'LOW'
  /** CATÉGORIES d'intérêt (étiquettes fermées côté carte) — pas un classement. */
  readonly caresAbout: readonly string[]
}

/**
 * POSTURE PRODUIT PAR DÉFAUT — DÉCLARATIVE UNIQUEMENT.
 *
 * ⚠️ N'accorde RIEN : ni contournement des outils de Mission, ni de l'approbation,
 * ni du cloisonnement d'espace, ni des `authorizedMotions`, ni des gardes de
 * capacité. L'autorité de LECTURE n'est pas non plus encodée ici — elle reste
 * hors RoleCard. JS-020 formalisera la permission effective.
 */
export interface RoleAutonomyDefaults {
  readonly posture: 'READ_ONLY' | 'DRAFT_ALLOWED' | 'APPROVAL_EXPECTED'
}

export interface RoleCardV0 {
  readonly schemaVersion: typeof ROLECARD_SCHEMA_VERSION
  readonly roleCardId: string
  readonly roleCardVersion: string
  readonly roleKind: RoleKind

  /** Intentions de RÉSULTAT génériques au rôle — jamais la stratégie du tenant. */
  readonly objectives: readonly string[]
  readonly attentionProfile: RoleAttentionProfile
  readonly defaultMissionIntents: readonly RoleMissionIntent[]
  /** FORME de la portée par défaut — l'autorisation effective viendra de JS-020. */
  readonly dataScopeDefaults: {
    readonly kind: 'PROSPECTS_AND_TARGETS' | 'OWNED_BOOK' | 'CLIENT_PORTFOLIO' | 'TEAM_PIPELINE'
  }
  readonly informationDepth:
    | 'ACTIONABLE_SUMMARY'
    | 'ACCOUNT_DOSSIER'
    | 'RELATIONSHIP_HISTORY'
    | 'AGGREGATE_TRENDS'
  readonly autonomyDefaults: RoleAutonomyDefaults
}

function carte(
  roleKind: RoleKind,
  contenu: Omit<RoleCardV0, 'schemaVersion' | 'roleCardId' | 'roleCardVersion' | 'roleKind'>,
): RoleCardV0 {
  return Object.freeze({
    schemaVersion: ROLECARD_SCHEMA_VERSION,
    roleCardId: `rolecard_${roleKind.toLowerCase()}`,
    roleCardVersion: ROLECARD_VERSION,
    roleKind,
    ...contenu,
  })
}

/**
 * LE REGISTRE — quatre cartes, constantes, dérivées (jamais persistées).
 *
 * ⚠️ AUCUN PARTAGE D'OBJET ENTRE CARTES : chaque carte porte SES objectifs,
 * SES intentions, SON profil. Un défaut « acquisition » recopié sur un KAM
 * serait exactement le modèle-BDR-réutilisé que la doctrine interdit.
 */
export const ROLE_CARDS: Readonly<Record<RoleKind, RoleCardV0>> = Object.freeze({
  SDR_BDR: carte('SDR_BDR', {
    objectives: Object.freeze([
      'Construire du pipeline qualifié sur les comptes cibles',
      'Qualifier les nouveaux leads entrants et sortants',
      'Tenir les engagements de relance pris',
      'Préparer les appels de découverte',
    ]),
    attentionProfile: Object.freeze({
      scope: 'INDIVIDUAL_ITEMS' as const,
      granularity: 'PER_LEAD' as const,
      interruptionSensitivity: 'HIGH' as const,
      caresAbout: Object.freeze(['acquisition_signals', 'funding', 'hiring_growth', 'expansion']),
    }),
    defaultMissionIntents: Object.freeze([
      'FIND_NEW_OPPORTUNITIES', 'QUALIFY_NEW_LEADS', 'FOLLOW_UP_COMMITMENTS', 'PREPARE_CALLS',
    ] as const),
    dataScopeDefaults: Object.freeze({ kind: 'PROSPECTS_AND_TARGETS' as const }),
    informationDepth: 'ACTIONABLE_SUMMARY',
    autonomyDefaults: Object.freeze({ posture: 'DRAFT_ALLOWED' as const }),
  }),

  ACCOUNT_EXECUTIVE: carte('ACCOUNT_EXECUTIVE', {
    objectives: Object.freeze([
      'Faire progresser les opportunités possédées vers la signature',
      'Convertir le pipeline qualifié en revenu',
      'Préparer et mener les rendez-vous de vente',
    ]),
    attentionProfile: Object.freeze({
      scope: 'INDIVIDUAL_ITEMS' as const,
      granularity: 'PER_ACCOUNT' as const,
      interruptionSensitivity: 'HIGH' as const,
      caresAbout: Object.freeze(['deal_momentum', 'deal_risk', 'stakeholder_change', 'timing_leverage']),
    }),
    defaultMissionIntents: Object.freeze([
      'ADVANCE_OWNED_OPPORTUNITIES', 'PREPARE_DEAL_MEETING', 'FOLLOW_UP_COMMITMENTS',
    ] as const),
    dataScopeDefaults: Object.freeze({ kind: 'OWNED_BOOK' as const }),
    informationDepth: 'ACCOUNT_DOSSIER',
    autonomyDefaults: Object.freeze({ posture: 'DRAFT_ALLOWED' as const }),
  }),

  ACCOUNT_MANAGER_KAM: carte('ACCOUNT_MANAGER_KAM', {
    objectives: Object.freeze([
      'Suivre la santé du portefeuille client',
      'Passer en revue les comptes stratégiques',
      'Identifier et préparer les expansions',
      'Préparer les rendez-vous de compte',
    ]),
    attentionProfile: Object.freeze({
      scope: 'PORTFOLIO' as const,
      granularity: 'PER_ACCOUNT' as const,
      interruptionSensitivity: 'MEDIUM' as const,
      // Changements CÔTÉ CLIENT — jamais les défauts d'acquisition d'un BDR.
      caresAbout: Object.freeze(['client_health', 'executive_change', 'contraction_risk', 'expansion_leverage']),
    }),
    defaultMissionIntents: Object.freeze([
      'REVIEW_STRATEGIC_ACCOUNTS', 'MONITOR_ACCOUNT', 'EXPANSION_REVIEW', 'PREPARE_ACCOUNT_MEETING',
    ] as const),
    dataScopeDefaults: Object.freeze({ kind: 'CLIENT_PORTFOLIO' as const }),
    informationDepth: 'RELATIONSHIP_HISTORY',
    autonomyDefaults: Object.freeze({ posture: 'APPROVAL_EXPECTED' as const }),
  }),

  HEAD_OF_SALES: carte('HEAD_OF_SALES', {
    objectives: Object.freeze([
      'Revue hebdomadaire du forecast',
      'Identifier les trous de pipeline',
      "Piloter l'attention de l'équipe",
      'Préparer le trimestre suivant',
    ]),
    attentionProfile: Object.freeze({
      // AGRÉGATS ET EXCEPTIONS — jamais le bruit prospect individuel.
      scope: 'TEAM_AGGREGATE' as const,
      granularity: 'PER_PIPELINE' as const,
      interruptionSensitivity: 'LOW' as const,
      caresAbout: Object.freeze(['forecast_risk', 'pipeline_gaps', 'team_exceptions', 'strategic_accounts']),
    }),
    defaultMissionIntents: Object.freeze([
      'WEEKLY_FORECAST_REVIEW', 'PIPELINE_GAP_REVIEW', 'TEAM_ATTENTION_REVIEW', 'NEXT_QUARTER_PREP',
    ] as const),
    dataScopeDefaults: Object.freeze({ kind: 'TEAM_PIPELINE' as const }),
    informationDepth: 'AGGREGATE_TRENDS',
    autonomyDefaults: Object.freeze({ posture: 'APPROVAL_EXPECTED' as const }),
  }),
})

// ── RÉSOLUTION DE L'INDICE HÉRITÉ — FERMÉE, EXACTE, SANS REPLI ─────────────

export type RoleResolution =
  | { readonly ok: true; readonly card: RoleCardV0 }
  | { readonly ok: false; readonly state: 'ROLE_SELECTION_REQUIRED' }
  | { readonly ok: false; readonly state: 'NO_ROLECARD_VERTICAL' }
  | { readonly ok: false; readonly state: 'UNKNOWN_ROLE' }

/**
 * TABLE FERMÉE — chaque entrée est une DÉCISION, pas une devinette.
 *
 *   'sales_rep' → ROLE_SELECTION_REQUIRED : l'ancien défaut d'espace ne dit
 *     pas QUI est l'utilisateur — le mapper d'office sur SDR_BDR déciderait à
 *     sa place. L'utilisateur devra choisir.
 *   'broker' → NO_ROLECARD_VERTICAL : contexte Fabel — un vertical n'est pas
 *     une carte Sales, et on ne le blanchit pas en BDR.
 *
 * ⚠️ AUCUNE correspondance floue : pas de minuscule générique, pas
 * d'`includes`, pas de `startsWith`. « SalesRep » ne devient jamais
 * « sales_rep », « SDR » ne devient jamais SDR_BDR. Inconnu = inconnu —
 * jamais un rôle privilégié par défaut.
 */
// ── R1-A : CHAQUE RÉSOLUTION EST UNE CONSTANTE GELÉE. `Object.freeze` sur la
// TABLE seule laissait les OBJETS de résolution mutables : un consommateur
// aurait pu remplacer `.card` sur l'objet rendu et altérer TOUTES les
// résolutions futures. Chaque valeur est donc gelée individuellement, et le
// résolveur ne rend QUE ces constantes — jamais un objet neuf, jamais un
// objet modifiable.
const resolutionCanonique = (kind: RoleKind): RoleResolution =>
  Object.freeze({ ok: true as const, card: ROLE_CARDS[kind] })

const RESOLUTION_ROLE_SELECTION_REQUIRED: RoleResolution =
  Object.freeze({ ok: false as const, state: 'ROLE_SELECTION_REQUIRED' as const })
const RESOLUTION_NO_ROLECARD_VERTICAL: RoleResolution =
  Object.freeze({ ok: false as const, state: 'NO_ROLECARD_VERTICAL' as const })
const RESOLUTION_UNKNOWN_ROLE: RoleResolution =
  Object.freeze({ ok: false as const, state: 'UNKNOWN_ROLE' as const })

const TABLE_HERITAGE: Readonly<Record<string, RoleResolution>> = Object.freeze({
  SDR_BDR: resolutionCanonique('SDR_BDR'),
  ACCOUNT_EXECUTIVE: resolutionCanonique('ACCOUNT_EXECUTIVE'),
  ACCOUNT_MANAGER_KAM: resolutionCanonique('ACCOUNT_MANAGER_KAM'),
  HEAD_OF_SALES: resolutionCanonique('HEAD_OF_SALES'),
  business_developer: resolutionCanonique('SDR_BDR'),
  BUSINESS_DEVELOPER: resolutionCanonique('SDR_BDR'),
  sales_rep: RESOLUTION_ROLE_SELECTION_REQUIRED,
  broker: RESOLUTION_NO_ROLECARD_VERTICAL,
})

/**
 * Résout un indice de rôle hérité (`BusinessContextV0.role`, fixtures) vers
 * une carte canonique ou un état explicite. PURE : aucune E/S, aucune
 * mutation, aucune revalidation — et surtout aucune création de Mission.
 */
export function resolveRoleCard(legacyRoleHint: unknown): RoleResolution {
  if (typeof legacyRoleHint !== 'string') return RESOLUTION_UNKNOWN_ROLE
  // ⚠️ CORRESPONDANCE EXACTE sur la table — `hasOwnProperty` pour qu'un
  // héritage nommé « toString » ne remonte pas la chaîne de prototypes.
  if (!Object.prototype.hasOwnProperty.call(TABLE_HERITAGE, legacyRoleHint)) {
    return RESOLUTION_UNKNOWN_ROLE
  }
  return TABLE_HERITAGE[legacyRoleHint]
}
