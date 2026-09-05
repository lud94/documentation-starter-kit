// ARCH-RULEPACK-001 — CAPACITÉS ET CONTRÔLE HUMAIN.
//
// ── DEUX NOTIONS QUE LE VOCABULAIRE COURANT CONFOND ─────────────────────────
//
//   PlayType          « ce qu'il serait PERTINENT de faire »      → métier
//   AuthorizedMotion  « ce qu'on a le DROIT de faire »            → autorité
//
// Les fondre produirait deux fautes symétriques : une capacité accordée ferait
// croire qu'une action est pertinente, et une recommandation pertinente
// s'autoriserait elle-même. Un play reste donc toujours calculé sur le fond ;
// l'autorisation se résout ensuite, séparément.
//
// ── CE MODULE NE CONSTRUIT PAS LE CONTROL PLANE ─────────────────────────────
// Il rend un VERDICT — « cette action exige une approbation » — que le Control
// Plane appliquera quand il existera. Il ne bloque rien lui-même, il n'appelle
// rien, il n'écrit rien.
// ⚠️ CYCLE DE TYPES ASSUMÉ, ET SEULEMENT DE TYPES : `types.ts` importe
// `AuthorizedMotion`/`HumanControl` d'ici, et ce module importe `PlayType` de
// là-bas. Les DEUX imports sont `import type`, donc effacés à l'émission
// (`isolatedModules` garantit l'élision) : il n'existe aucun cycle à
// l'exécution. `madge --circular` le signale malgré tout, car il ne distingue
// pas les imports de type — c'est un faux positif connu, pas une dette.
//
// Le fusionner serait pire : `PlayType` répond à « qu'est-ce qui est
// commercialement pertinent ? » et `AuthorizedMotion` à « qu'est-ce qui est
// permis ? ». Les mettre dans le même module inviterait à les confondre.
import type { PlayType } from './types'

/**
 * Capacité accordée à un utilisateur ou à un agent.
 *
 * La distinction structurante est l'EFFET EXTERNE : rédiger un brouillon est
 * réversible et invisible du prospect ; envoyer un message ne l'est pas.
 */
export type AuthorizedMotion =
  | 'prepare_outreach' // rédiger, préparer — aucun effet externe
  | 'contact_prospect' // effet EXTERNE, irréversible
  | 'enrich_data' // lecture/enrichissement de contexte
  | 'schedule_reminder' // rappel interne

export const AUTHORIZED_MOTIONS: readonly AuthorizedMotion[] = [
  'prepare_outreach',
  'contact_prospect',
  'enrich_data',
  'schedule_reminder',
]

/** Niveau accordé à UNE capacité. */
export type MotionControl = 'allowed' | 'approval_required' | 'forbidden'

/** Niveau de contrôle humain résultant, porté par la Recommendation. */
export type HumanControl = 'autonomous' | 'approval_required' | 'blocked'

/**
 * Quelles capacités chaque play EXIGE.
 *
 * Table du CŒUR, volontairement stable : un pack métier décide quel play
 * recommander, jamais ce qu'un play requiert comme droits. Laisser un pack
 * redéfinir cette table reviendrait à lui laisser s'accorder des capacités.
 */
export const PLAY_MOTIONS: Readonly<Record<PlayType, readonly AuthorizedMotion[]>> = {
  engage_or_reengage: ['prepare_outreach', 'contact_prospect'],
  follow_up: ['prepare_outreach', 'contact_prospect'],
  investigate: ['enrich_data'],
}

/** Ordre de sévérité. Sert à prendre systématiquement le plus strict. */
const SEVERITE: Readonly<Record<HumanControl, number>> = {
  autonomous: 0,
  approval_required: 1,
  blocked: 2,
}

/** Le plus STRICT de deux niveaux. Jamais le plus permissif. */
export function strictest(a: HumanControl, b: HumanControl): HumanControl {
  return SEVERITE[a] >= SEVERITE[b] ? a : b
}

/**
 * Traduction d'une capacité en niveau de contrôle.
 *
 * ⚠️ UNE CAPACITÉ ABSENTE VAUT `forbidden`. C'est le point fail-closed du
 * module : un contexte qui omet de mentionner une capacité ne l'accorde pas
 * tacitement. Oublier de dire n'est jamais autoriser.
 */
export function controlForMotion(
  motion: AuthorizedMotion,
  accordees: Readonly<Partial<Record<AuthorizedMotion, MotionControl>>>,
): HumanControl {
  const niveau = accordees?.[motion]
  if (niveau === 'allowed') return 'autonomous'
  if (niveau === 'approval_required') return 'approval_required'
  return 'blocked' // 'forbidden', absent, ou valeur inconnue
}

export interface MotionVerdict {
  control: HumanControl
  reason: string
  requiredMotions: readonly AuthorizedMotion[]
}

/**
 * Résout le contrôle humain d'un play, capacités accordées en main.
 *
 * Le résultat est le plus STRICT des niveaux exigés par le play : un play qui
 * requiert `prepare_outreach` (accordé) et `contact_prospect` (soumis à
 * approbation) exige une approbation. Le maillon le plus contraint gouverne.
 */
export function resolveMotionControl(
  play: PlayType,
  accordees: Readonly<Partial<Record<AuthorizedMotion, MotionControl>>>,
): MotionVerdict {
  const requises = PLAY_MOTIONS[play] ?? []

  // Un play sans capacité déclarée n'est pas un play autonome : c'est un play
  // dont on ignore ce qu'il exige. Fail closed.
  if (requises.length === 0) {
    return {
      control: 'blocked',
      reason: `Aucune capacité déclarée pour le play « ${play} ».`,
      requiredMotions: [],
    }
  }

  let control: HumanControl = 'autonomous'
  const bloquees: AuthorizedMotion[] = []
  const aValider: AuthorizedMotion[] = []

  for (const motion of requises) {
    const niveau = controlForMotion(motion, accordees)
    if (niveau === 'blocked') bloquees.push(motion)
    else if (niveau === 'approval_required') aValider.push(motion)
    control = strictest(control, niveau)
  }

  const reason =
    bloquees.length > 0
      ? `Capacité non accordée : ${bloquees.join(', ')}.`
      : aValider.length > 0
        ? `Approbation humaine requise pour : ${aValider.join(', ')}.`
        : 'Toutes les capacités requises sont accordées.'

  return { control, reason, requiredMotions: requises }
}
