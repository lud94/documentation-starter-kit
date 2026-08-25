// JARVIS-PROACTIVE-01D
// Data Bridge V0 — des données Prospector RÉELLES vers des EvidenceEvent.
//
// ── LA RÈGLE QUI GOUVERNE CE FICHIER ────────────────────────────────────────
// ABSENCE DE DONNÉE = ABSENCE D'EVIDENCE. Jamais une date inventée, jamais une
// source inventée, jamais une confiance inventée, jamais un type déduit d'une
// prose. Ce module produit peu, et c'est voulu : un moteur de décision nourri
// d'evidences fabriquées produit des recommandations fausses avec l'assurance
// des vraies.
//
// ── CE QUE LE MODÈLE DE DONNÉES ACTUEL PERMET, ET CE QU'IL NE PERMET PAS ────
// `Lead` (types/prospector.ts) NE PORTE AUCUNE DATE. Pas de `createdAt`, pas de
// `lastContactAt`, pas de date de signal. La ligne `prospector_leads` a bien un
// `created_at`, mais il date l'insertion en base, pas l'événement métier.
//
// Conséquence directe et non contournable : ce bridge ne peut produire que des
// evidences d'ÉTAT — « à l'instant `now`, la fiche affirme X » — et jamais des
// evidences d'ÉVÉNEMENT — « le 12 mars, l'entreprise a levé des fonds ».
//
// C'est pourquoi chaque evidence produite ici porte `temporality:
// 'undated_state'` et AUCUN `occurredAt` : seule l'observation est datée, parce
// qu'elle seule l'est réellement. Dater l'observation est honnête ; laisser
// croire que cette date est celle du fait ne l'est pas. Le type rend désormais
// la confusion impossible plutôt que déconseillée.
//
// Conséquence directe, et voulue : ces evidences ne contribuent à AUCUNE
// urgence. Une situation qui n'en est faite que d'elles a `urgency: 0`. Ce n'est
// pas une dégradation, c'est l'énoncé exact de ce qu'on sait — rien ne permet
// d'affirmer qu'il faut agir maintenant. Confiance et pertinence, elles, restent
// pleinement calculées, et la recommandation reste possible.
//
// ── POINT D'INTÉGRATION FUTUR : LES SIGNAUX ─────────────────────────────────
// `Lead` NE DOIT PAS devenir un magasin d'événements. La doctrine cible est :
//
//     source / SignalHit → normalisation → EvidenceEvent persistant → Situation
//
// `SignalHit` (types/prospector.ts) porte DÉJÀ ce qu'il faut : `date`,
// `sourceUrl`, `sourceName`, `signalType`, `amount`, `role`. Ces champs sont
// perdus à l'import — `capabilities.ts` ne recopie que `detail` et `icebreaker`
// sur le lead. La correction n'est donc PAS d'enrichir `Lead` de dates, mais de
// normaliser le `SignalHit` en `EvidenceEvent` AVANT qu'il ne soit aplati, et de
// le persister via `persistence.ts`. Le lead conservera sa projection texte pour
// l'affichage, sans jamais être la source de vérité temporelle.
//
// Ces evidences-là porteront `temporality: 'dated_event'` et une `EvidenceSource`
// réelle — et elles seules pourront produire une urgence et débloquer
// `sales_scale_up` / `strong_signal_low_context`. Ce pipeline n'appartient pas à
// 01D et n'est pas commencé ici.
import { isAccountLead } from '../leadKind'
import type { Lead } from '../../../types/prospector'
import type {
  AssertionType,
  EvidenceEvent,
  EvidenceScope,
} from './types'
import type { EvidenceType } from './catalog'

export const BRIDGE_VERSION = 'v0.1'

/** Provenance réelle : notre propre base. Ni devinée, ni empruntée à un tiers. */
export const BRIDGE_PROVIDER = 'prospector_crm'

/**
 * ── LES DEUX SEULES CONFIANCES DE CE BRIDGE ─────────────────────────────────
 * Elles expriment une chose précise : à quel point l'état persisté reflète
 * encore la réalité. Ce n'est pas la certitude d'avoir bien lu la fiche — celle-
 * là vaudrait 1 — mais la certitude que la fiche a toujours raison.
 *
 * Elles restent sous 1 pour une raison factuelle : AUCUNE de ces fiches n'est
 * horodatée. Un `temperature: 'hot'` saisi il y a dix-huit mois est indiscernable
 * d'un signal d'hier. Ne pas pouvoir vérifier la fraîcheur est une bonne raison
 * de ne jamais affirmer une certitude totale.
 *
 * Deux valeurs, pas dix : un barème fin donnerait l'illusion d'une mesure là où
 * il n'y a qu'un jugement assumé.
 */
export const RECORD_STATE_CONFIDENCE = 0.8
/** Deux champs indépendants de la fiche concordent : la corroboration est réelle. */
export const CORROBORATED_STATE_CONFIDENCE = 0.9

/**
 * INSTANTANÉ DES TÂCHES — la complétude doit être PROUVÉE, jamais supposée.
 *
 * ⚠️ C'EST LE POINT LE PLUS DÉLICAT DU LOT. L'evidence `no_next_step` se déduit
 * d'une ABSENCE : « aucune tâche ouverte ne référence ce lead ». Or `listItems`
 * rend `[]` aussi bien pour une collection vide que pour une base injoignable.
 * Lire les tâches ici transformerait donc une panne en « ce lead n'a pas de
 * prochaine étape », c'est-à-dire en une recommandation de relance fondée sur
 * rien.
 *
 * Le bridge ne lit donc RIEN lui-même. L'appelant doit affirmer, sous sa
 * responsabilité, que sa lecture a réussi. `complete: false` ⇒ aucune evidence
 * d'absence n'est produite. C'est la même doctrine que `KidInventory` dans
 * `lib/secrets/keyring.ts` : ne pas savoir n'autorise rien.
 */
export type TaskSnapshot =
  | { complete: true; openTaskLeadIds: readonly string[] }
  | { complete: false }

export interface BridgeContext {
  now: Date
  tasks: TaskSnapshot
}

/**
 * Étapes où un prochain engagement est ATTENDU.
 *
 * `to_invite` et `invited` en sont exclues : rien n'y a encore commencé, donc
 * l'absence de prochaine étape n'y signifie rien. `meeting` en est exclue aussi
 * — un rendez-vous EST le prochain engagement. `closed` est terminée.
 */
const STAGES_ATTENDANT_UN_ENGAGEMENT: ReadonlySet<string> = new Set([
  'connected',
  'in_sequence',
  'responded',
])

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Identifiant de compte STABLE et DÉTERMINISTE.
 *
 * `siren` d'abord : c'est un identifiant officiel, vérifié à l'import via
 * data.gouv. À défaut, le nom d'entreprise normalisé — imparfait (deux
 * établissements homonymes fusionneraient) mais déterministe et vérifiable.
 *
 * Sans siren NI nom, on ne fabrique pas d'identifiant : le lead est ignoré.
 * Un compte inventé polluerait durablement toutes les situations agrégées.
 */
export function accountIdForLead(lead: Lead): string | null {
  if (nonEmpty(lead.siren)) return `acc_siren_${lead.siren.trim()}`
  if (nonEmpty(lead.company)) {
    const slug = lead.company
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (slug) return `acc_name_${slug}`
  }
  return null
}

/**
 * Un lead décrit-il une PERSONNE ?
 *
 * ⚠️ LA CLASSIFICATION COMPTE/CONTACT N'APPARTIENT PAS À CE MODULE. Elle a une
 * définition canonique unique — `isAccountLead` de `lib/prospector/leadKind.ts`
 * — écrite précisément pour supprimer des prédicats concurrents qui classaient
 * la MÊME ligne différemment selon l'écran.
 *
 * Ce fichier testait auparavant `lead.kind === 'account'` en direct.
 *
 * ⚠️ HONNÊTETÉ SUR LA PORTÉE DE CE CHANGEMENT : les deux formulations sont
 * AUJOURD'HUI équivalentes — vérifié exhaustivement sur les 72 combinaisons de
 * `(kind, firstName, lastName, id)`, zéro divergence. La raison est que le
 * second critère ci-dessous absorbe le seul cas où l'heuristique legacy
 * d'`isAccountLead` se distingue : une fiche sans `kind` et sans nom est classée
 * compte par la définition canonique, et se voit de toute façon refuser un
 * `personId` faute de nom.
 *
 * Ce n'est donc PAS une correction de bug, et le prétendre serait fabriquer une
 * justification. C'est une correction de DÉPENDANCE : ce module cesse de
 * redéfinir localement une notion dont le dépôt possède une définition unique.
 * L'équivalence actuelle est une coïncidence de l'implémentation présente ; le
 * jour où `leadKind.ts` affinera sa règle — un `kind` supplémentaire, une autre
 * heuristique legacy — ce fichier suivra au lieu de diverger en silence. C'est
 * exactement le scénario qui avait rendu `jarvisAgent.ts` et l'UI incohérents
 * sur la même ligne de la même table.
 *
 * Le second critère RESTE nécessaire et ne fait pas doublon : `isAccountLead`
 * répond « ce lead est-il une entreprise ? », pas « une personne est-elle
 * nommée ? ». Un lead déclaré `kind: 'contact'` mais dépourvu de prénom et de
 * nom — forme que `addLeadsFromCsv` sait produire — n'est pas un compte, et ne
 * porte pourtant aucune identité individuelle.
 */
export function personIdForLead(lead: Lead): string | undefined {
  if (isAccountLead(lead)) return undefined
  if (!nonEmpty(lead.firstName) && !nonEmpty(lead.lastName)) return undefined
  return nonEmpty(lead.id) ? lead.id : undefined
}

function stableEvidenceId(
  type: EvidenceType,
  accountId: string,
  personId: string | undefined,
): string {
  const cible = personId ?? 'account'
  const raw = `${type}_${accountId}_${cible}`
  return `ev_${raw.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function buildStateEvidence(params: {
  type: EvidenceType
  scope: EvidenceScope
  accountId: string
  personId?: string
  leadId: string
  confidence: number
  value?: string | number | boolean
  assertionType?: AssertionType
  now: Date
}): EvidenceEvent {
  const iso = params.now.toISOString()

  return {
    id: stableEvidenceId(params.type, params.accountId, params.personId),
    accountId: params.accountId,
    personId: params.personId,
    scope: params.scope,
    type: params.type,
    value: params.value,
    // Provenance RÉELLE : la fiche, désignée par son identifiant. Aucun
    // fournisseur externe n'est invoqué, aucune URL n'est fabriquée.
    source: { provider: BRIDGE_PROVIDER, reference: params.leadId },
    // `fact` : la fiche affirme cet état, c'est un fait vérifiable de notre base.
    // Ce n'est pas une affirmation sur la vérité du monde — d'où la confiance
    // strictement inférieure à 1.
    assertionType: params.assertionType ?? 'fact',
    confidence: params.confidence,
    // ⚠️ AUCUN `occurredAt` — le type l'interdit, et c'est le fond du sujet.
    // Ces evidences constatent un état ; personne ne sait depuis quand il est
    // vrai. Y recopier `now` faisait passer une fiche « chaude » saisie il y a
    // dix-huit mois pour un signal du jour, et le Situation Engine en tirait une
    // urgence maximale. Seule l'OBSERVATION est datée, parce qu'elle seule l'est
    // réellement.
    temporality: 'undated_state',
    observedAt: iso,
  }
}

/**
 * ── CE QUI EST DÉLIBÉRÉMENT ABSENT DE CE BRIDGE ─────────────────────────────
 *
 * `recent_funding`, `sales_hiring`, `new_sales_leader`,
 * `headcount_acceleration` — leur seul porteur possible serait `lead.signal`.
 * Or `signal` est une CHAÎNE LIBRE. Vérifié dans `capabilities.ts` (import par
 * signal) : seuls `hit.detail` et `hit.icebreaker` sont recopiés sur le lead ;
 * `hit.date`, `hit.sourceUrl`, `hit.sourceName` et `hit.signalType` sont
 * ABANDONNÉS. En produire une evidence exigerait d'inventer trois choses à la
 * fois — la date, la source et le type — donc exactement les trois que ce lot
 * interdit. Rien n'est émis.
 *
 * `positive_reply` — `stage: 'responded'` atteste qu'une réponse existe, pas
 * qu'elle est POSITIVE. Un refus poli met aussi le lead dans cette étape. En
 * déduire une réponse positive serait inventer un sentiment.
 *
 * `relationship_inactive` — exige une date de dernier contact. Aucune n'est
 * persistée : `Interaction` existe comme type mais n'est produit nulle part
 * ailleurs que dans les mocks de `capabilities.ts`.
 */
function evidenceForLead(lead: Lead, context: BridgeContext): EvidenceEvent[] {
  const accountId = accountIdForLead(lead)
  if (!accountId) return []
  if (!nonEmpty(lead.id)) return []

  const personId = personIdForLead(lead)
  const out: EvidenceEvent[] = []

  // ── hot_lead ──────────────────────────────────────────────────────────────
  // Deux champs indépendants portent la même notion dans ce produit :
  // `temperature: 'hot'` et `status: 'chaud'`. Quand les deux concordent, la
  // corroboration est réelle et mérite une confiance supérieure.
  const chaudParTemperature = lead.temperature === 'hot'
  const chaudParStatut = lead.status === 'chaud'

  if (chaudParTemperature || chaudParStatut) {
    out.push(
      buildStateEvidence({
        type: 'hot_lead',
        // Sans personne identifiée, l'intérêt reste une propriété du compte.
        scope: personId ? 'relationship' : 'account',
        accountId,
        personId,
        leadId: lead.id,
        confidence:
          chaudParTemperature && chaudParStatut
            ? CORROBORATED_STATE_CONFIDENCE
            : RECORD_STATE_CONFIDENCE,
        value: chaudParTemperature ? lead.temperature : lead.status,
        now: context.now,
      }),
    )
  }

  // ── no_next_step ──────────────────────────────────────────────────────────
  // Déduite d'une absence : elle exige donc que l'absence soit PROUVÉE.
  if (
    context.tasks.complete &&
    personId &&
    STAGES_ATTENDANT_UN_ENGAGEMENT.has(lead.stage)
  ) {
    const aUneTacheOuverte = context.tasks.openTaskLeadIds.includes(lead.id)

    if (!aUneTacheOuverte) {
      out.push(
        buildStateEvidence({
          type: 'no_next_step',
          scope: 'relationship',
          accountId,
          personId,
          leadId: lead.id,
          confidence: RECORD_STATE_CONFIDENCE,
          value: lead.stage,
          now: context.now,
        }),
      )
    }
  }

  // ── missing_context ───────────────────────────────────────────────────────
  // Fait vérifiable sur NOS PROPRES données : la fiche ne porte ni moyen de
  // contact, ni élément de contexte. C'est la seule evidence que l'absence
  // justifie pleinement, parce que l'absence EST le fait constaté.
  const aUnCanal = nonEmpty(lead.email) || nonEmpty(lead.linkedinUrl) || nonEmpty(lead.phone)
  const aDuContexte =
    nonEmpty(lead.summary) ||
    nonEmpty(lead.webProfile) ||
    nonEmpty(lead.researchNotes) ||
    nonEmpty(lead.signal)

  if (!aUnCanal && !aDuContexte) {
    out.push(
      buildStateEvidence({
        type: 'missing_context',
        scope: personId ? 'person' : 'account',
        accountId,
        personId,
        leadId: lead.id,
        confidence: RECORD_STATE_CONFIDENCE,
        value: true,
        now: context.now,
      }),
    )
  }

  return out
}

/**
 * Convertit des leads en EvidenceEvent.
 *
 * Fonction PURE : aucun réseau, aucune lecture de base, aucune mutation. Tout
 * ce dont elle a besoin lui est fourni, y compris l'heure.
 */
export function evidenceFromLeads(
  leads: readonly Lead[],
  context: BridgeContext,
): EvidenceEvent[] {
  if (!Array.isArray(leads)) return []
  if (!context?.now || !Number.isFinite(context.now.getTime())) return []

  const out: EvidenceEvent[] = []
  for (const lead of leads) {
    if (!lead || typeof lead !== 'object') continue
    out.push(...evidenceForLead(lead, context))
  }
  return out
}
