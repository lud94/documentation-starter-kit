// SIGNAL_ARCHITECTURE_V1_WAVE2 — ANCRES FACTUELLES CANONIQUES, IMMUABLES.
//
// ── CE QU'UNE ANCRE EST, ET CE QU'ELLE N'EST PAS ────────────────────────────
//
//   Une ancre IDENTIFIE un fait du monde. Elle ne le DOCUMENTE pas.
//
//   « il y a eu UNE levée pour CE compte CE jour-là »
//   « il y a eu UNE observation de recrutement Sales pour CE compte CE jour-là »
//
// Elle ne porte AUCUNE liste de preuves, AUCUN compteur d'éditeurs, AUCUN
// statut mutable, AUCUNE provenance recopiée. L'histoire au niveau source vit
// dans le registre des `SourceAssertion`, et elle y reste.
//
// ── POURQUOI PAS D'AGRÉGAT — LE BLOCAGE DE LA WAVE 2A ──────────────────────
// La conception précédente portait `evidenceIds[]`, `publishers[]`, des
// compteurs et un `lastConfirmedAt`. Tout cela exige un lire-modifier-écrire, et
// `prospector_store` n'offre ni fusion atomique, ni verrou optimiste, ni union
// JSONB : deux promotions concurrentes se seraient silencieusement écrasées.
// Ce lot a donc été BLOQUÉ, puis rouvert par le registre d'assertions.
//
// La sortie n'est pas un verrou, c'est une SUPPRESSION DU PROBLÈME. Une ancre
// est ENTIÈREMENT déterminée par son identité : deux écritures concurrentes de
// la même ancre produisent le même document, octet pour octet. Il n'y a donc
// rien à fusionner, et rien à perdre — non parce qu'une garde l'empêche, mais
// parce que la forme du modèle ne le permet pas.
//
// ── RELATION AVEC LE REGISTRE : DÉRIVATION, JAMAIS DOUBLE ÉCRITURE ─────────
// Les ancres sont DÉRIVÉES des assertions ; aucune assertion n'est mutée pour y
// inscrire un `canonicalEventId`. Le lien se retrouve par calcul —
// `workspaceId` + `canonicalClaimKey` (+ `sourceObservedDay` pour un état) —
// donc aucune cohérence bidirectionnelle n'est à maintenir.
import { createHash } from 'node:crypto'

import { getItemStrict, insertItemIfAbsent } from '../../supabase/store'
import { jourReel } from './signalBridge'
import {
  buildSourceAssertions,
  type AssertionBuildInput,
} from './sourceAssertion'
import { isPersonRef, personKeyV2 } from './acquisitionV2'

/**
 * `kind`s du magasin — SERVEUR UNIQUEMENT.
 *
 * ⚠️ VOLONTAIREMENT ABSENTS DE `PROACTIVE_KIND_LIST`, et ce n'est pas un oubli.
 * `pages/api/store/index.ts` bâtit sa liste blanche à partir de cette
 * constante-là, et cette route accepte du NAVIGATEUR un `POST` (`upsertItem`)
 * et un `DELETE` sur tout `kind` autorisé. Un fait canonique que son sujet peut
 * réécrire ou effacer n'ancre plus rien.
 *
 * Même doctrine que `SIGNAL_CANDIDATE_KIND` et `SOURCE_ASSERTION_KIND`.
 */
export const CANONICAL_EVENT_KIND = 'proactive_canonical_event'
export const CANONICAL_STATE_SNAPSHOT_KIND = 'proactive_canonical_state_snapshot'

/**
 * Drapeau d'activation — ENV UNIQUEMENT.
 *
 * ⚠️ PAS `getKey` : celui-ci consulte d'abord le magasin hydraté depuis
 * `prospector_settings`, et une ligne en base pourrait alors allumer un chemin
 * d'écriture depuis la surface qu'il alimente.
 *
 * Absent, vide ou illisible ⇒ ÉTEINT.
 */
export function canonicalFactsEnabled(): boolean {
  const brut = (process.env.SIGNAL_ARCH_V1_CANONICAL_FACTS || '').trim().toLowerCase()
  return brut === '1' || brut === 'true'
}

// ── CARTE D'AUTORITÉ — FERMÉE, EXPLICITE, SANS HEURISTIQUE ─────────────────
//
// ⚠️ AUCUNE INFÉRENCE DEPUIS UNE CHAÎNE. Pas de `includes('funding')`, pas de
// préfixe, pas de correspondance approximative. Un `EvidenceType` absent de
// cette table ne produit AUCUNE ancre — c'est ainsi que les types déclarés par
// les packs mais sans producteur (`new_sales_leader`, `site_expansion`,
// `hiring_freeze`…) restent hors du chemin factuel tant que rien ne les
// fabrique réellement.
export type CanonicalFactType =
  | 'FUNDING_ROUND'
  | 'HIRING_SNAPSHOT'
  | 'EXECUTIVE_APPOINTMENT'
  | 'EXECUTIVE_DEPARTURE'

const CARTE_AUTORITE: Readonly<Record<string, CanonicalFactType>> = Object.freeze({
  recent_funding: 'FUNDING_ROUND',
  sales_hiring: 'HIRING_SNAPSHOT',
  // ⚠️ PRODUCTEUR RÉEL : `mapClaim` V2. La direction vient d'un champ CLOS du
  // contrat d'acquisition (jamais de prose), et `UNKNOWN` est refusé AVANT le
  // mapping — aucun de ces deux types n'est atteignable sans direction établie.
  executive_appointment: 'EXECUTIVE_APPOINTMENT',
  executive_departure: 'EXECUTIVE_DEPARTURE',
})

/** Type canonique d'un `EvidenceType`, ou `null`. Table close, jamais devinée. */
export function canonicalTypeFor(evidenceType: unknown): CanonicalFactType | null {
  if (typeof evidenceType !== 'string') return null
  return Object.prototype.hasOwnProperty.call(CARTE_AUTORITE, evidenceType)
    ? CARTE_AUTORITE[evidenceType]
    : null
}

/**
 * ANCRE D'ÉVÉNEMENT DATÉ. Immuable, sans preuve attachée.
 *
 * ⚠️ AUCUN `evidenceIds`, AUCUN `publishers`, AUCUN compteur, AUCUN statut.
 * Ce sont ces champs-là qui exigeaient une fusion concurrente impossible.
 */
export interface CanonicalEvent {
  id: string
  workspaceId: string
  type: 'FUNDING_ROUND'
  accountId: string
  /** Date MÉTIER du fait. Jamais une date de publication ni de découverte. */
  occurredAt: string
  occurredAtPrecision: 'DAY'
  canonicalClaimKey: string
}

/**
 * ANCRE D'ÉTAT OBSERVÉ. Immuable, une par jour d'observation.
 *
 * ⚠️ AUCUN `occurredAt`. Un état n'a pas eu lieu, il DURE : lui inventer une
 * date de survenue reproduirait exactement le défaut que `undated_state` et
 * `occurredAt?: never` ont fermé au niveau Evidence.
 *
 * ⚠️ AUCUN `validFrom`/`validTo`/`supersededAt`. La succession des jours EST
 * l'historique ; muter l'instantané d'hier quand celui d'aujourd'hui arrive
 * exigerait une écriture multi-documents que ce lot refuse.
 */
export interface CanonicalStateSnapshot {
  id: string
  workspaceId: string
  type: 'HIRING_SNAPSHOT'
  accountId: string
  canonicalClaimKey: string
  /** Jour UTC d'observation de la SOURCE — issu de `SourceAssertion`. */
  stateObservedDay: string
}

// ── IDENTITÉS DÉTERMINISTES ────────────────────────────────────────────────
//
// ⚠️ `\n` COMME SÉPARATEUR : aucun des champs employés ne peut en contenir.
// ⚠️ L'ESPACE ENTRE DANS LE CONDENSAT, en défense en profondeur — la garde
// réelle reste la lecture cloisonnée `(kind, id, workspace_id)` et la RLS.

/**
 * Identité d'une levée : le COMPTE et le JOUR, rien d'autre.
 *
 * ⚠️ NI URL, NI ÉDITEUR, NI `retrievedAt`, NI `observedAt`, NI MONTANT. Deux
 * articles décrivant la même levée du 12 août désignent LE MÊME fait du monde ;
 * y glisser quoi que ce soit de la source en ferait deux — la fausse nouveauté
 * que toute cette chaîne existe pour empêcher. Le montant, lui, est de la prose
 * libre issue d'un modèle : l'y faire entrer scinderait sur une hallucination.
 */
export function canonicalEventId(
  workspaceId: string, accountId: string, occurredAt: string,
): string {
  const charge = `canonical-event:v1:${workspaceId}\nFUNDING_ROUND\n${accountId}\n${occurredAt}`
  return `cev_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

/**
 * Identité d'un instantané d'état : la revendication et le JOUR D'OBSERVATION.
 *
 * ⚠️ LE JOUR VIENT DE `SourceAssertion.sourceObservedDay`, donc de
 * `retrievedAt` — l'instant où Prospector a vu le document. JAMAIS de
 * `Evidence.observedAt`, qui est l'instant d'ADJUDICATION : une page carrière
 * relevée le 1er et confirmée le 5 serait ancrée au 5, c'est-à-dire à une date
 * où personne n'a observé cet état.
 */
export function canonicalSnapshotId(
  workspaceId: string, canonicalClaimKey: string, stateObservedDay: string,
): string {
  const charge =
    `canonical-state:v1:${workspaceId}\nHIRING_SNAPSHOT\n${canonicalClaimKey}\n${stateObservedDay}`
  return `csn_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

/**
 * ANCRE D'ÉVÉNEMENT DE DIRECTION — immuable (E2E_BRIDGE_001).
 *
 * ⚠️ IDENTITÉ : espace + type(direction) + compte + fonction + clé de personne
 * + jour. JAMAIS : `roleTitleRaw` (prose — « CRO » et « Chief Revenue
 * Officer » désignent le même fait), `roleSeniority` (attribut contestable,
 * pas identité), URL, éditeur, `Evidence.id`, `observedAt`, `retrievedAt`.
 *
 * ⚠️ LA CLÉ DE PERSONNE `NAME_ONLY` EST DÉJÀ SCOPÉE AU COMPTE
 * (`name:<nom>@<accountId>`) : deux homonymes dans deux entreprises ne peuvent
 * pas converger. Aucune entité personne inter-comptes n'existe ni n'est créée.
 */
export interface CanonicalExecutiveEvent {
  id: string
  workspaceId: string
  type: 'EXECUTIVE_APPOINTMENT' | 'EXECUTIVE_DEPARTURE'
  accountId: string
  roleFunction: string
  personKey: string
  occurredAt: string
  occurredAtPrecision: 'DAY'
  canonicalClaimKey: string
}

export function canonicalExecutiveEventId(
  workspaceId: string, type: CanonicalExecutiveEvent['type'], accountId: string,
  roleFunction: string, personKey: string, occurredAt: string,
): string {
  const charge =
    `canonical-event:v1:${workspaceId}\n${type}\n${accountId}\n${roleFunction}\n${personKey}\n${occurredAt}`
  return `cev_${createHash('sha256').update(charge, 'utf8').digest('hex').slice(0, 32)}`
}

const COMPTE_VERIFIE = /^acc_siren_\d{9}$/
const JOUR = /^\d{4}-\d{2}-\d{2}$/

export interface CanonicalAnchors {
  event: CanonicalEvent | null
  /**
   * Ancres de direction — TABLEAU, pas un singleton : rien dans la clé
   * canonique de la revendication ne contient la personne, deux sources
   * durables peuvent donc affirmer deux personnes distinctes le même jour.
   * Deux ancres visibles valent mieux qu'une fusion invisible.
   */
  execEvents: CanonicalExecutiveEvent[]
  snapshots: CanonicalStateSnapshot[]
}

/**
 * Entrée de dérivation — l'appui DURABLE est un paramètre OBLIGATOIRE.
 *
 * ── L'INVARIANT QUE CE TYPE FAIT TENIR ─────────────────────────────────────
 *
 *   AUCUNE ANCRE SANS AU MOINS UNE ASSERTION DE SOURCE DURABLE.
 *
 * ⚠️ « DURABLE » N'EST PAS « CONSTRUITE ». `buildSourceAssertions` rend des
 * objets en mémoire ; une ancre dérivée de ceux-là pourrait exister alors que
 * l'écriture du registre a échoué — un fait canonique sans le moindre appui
 * reconstructible. C'est exactement l'orphelin que ce champ interdit.
 *
 * ⚠️ OBLIGATOIRE, PAS OPTIONNEL, ET C'EST LE POINT. Un champ facultatif se
 * serait oublié en silence chez un futur appelant ; ici, l'omettre ne compile
 * pas. Et un ensemble VIDE ne produit aucune ancre — fail closed.
 */
export interface AnchorDerivationInput extends AssertionBuildInput {
  /** Identifiants d'assertions CONFIRMÉES en base — `LedgerReport.durableIds`. */
  durableAssertionIds: ReadonlySet<string>
}

/**
 * Dérive les ancres d'UNE promotion. Pure : aucune horloge, aucune I/O.
 *
 * ⚠️ LES ASSERTIONS SONT RECALCULÉES, PAS RELUES. `buildSourceAssertions` est
 * déterministe et pure ; la rappeler garantit que `sourceObservedDay` a ici
 * EXACTEMENT la valeur que le registre a écrite, sans lecture de base ni
 * seconde implémentation de la dérivation du jour.
 *
 * ⚠️ TOUTE AMBIGUÏTÉ ⇒ AUCUNE ANCRE. Compte non vérifié, temporalité
 * inattendue, jour inexistant au calendrier : on s'abstient. L'evidence, elle,
 * reste parfaitement valide — une ancre est une vue, jamais le fait.
 */
export function buildCanonicalAnchors(input: AnchorDerivationInput): CanonicalAnchors {
  const vide: CanonicalAnchors = { event: null, execEvents: [], snapshots: [] }

  const ws = typeof input?.workspaceId === 'string' ? input.workspaceId.trim() : ''
  if (ws === '') return vide
  if (!input?.evidence || !input.canonicalClaimKey) return vide

  const accountId = String(input.accountId || '')
  // ⚠️ L'ANCRE NE S'ATTACHE QU'À UNE ENTITÉ VÉRIFIÉE. Un repli par nom
  // (`acc_name_*`) collerait un fait du monde à un homonyme.
  if (!COMPTE_VERIFIE.test(accountId)) return vide

  const type = canonicalTypeFor(input.evidence.type)
  if (!type) return vide

  const durables = input?.durableAssertionIds
  // ⚠️ ABSENT OU VIDE ⇒ AUCUNE ANCRE. Un appelant qui ne sait pas quelles
  // assertions ont survécu ne sait pas non plus si le fait a un appui.
  if (!durables || typeof durables.has !== 'function') return vide

  // ⚠️ FILTRÉES SUR LA DURABILITÉ, PAS SUR LA CONSTRUCTION. Une assertion dont
  // l'écriture a échoué ne soutient rien : elle est écartée ici, sans que les
  // autres du même lot en pâtissent.
  const assertions = buildSourceAssertions(input).filter((a) => durables.has(a.id))

  if (type === 'FUNDING_ROUND') {
    // ⚠️ REVALIDÉ ICI, à la frontière. `mapClaim` a déjà exigé le jour exact,
    // mais une frontière qui fait confiance à l'amont n'est pas une frontière.
    if (input.evidence.temporality !== 'dated_event') return vide
    const occurredAt = (input.evidence as any).occurredAt
    if (!JOUR.test(String(occurredAt)) || !jourReel(occurredAt)) return vide

    // ⚠️ AUCUNE ANCRE SANS APPUI DURABLE. Les ancres sont DÉRIVÉES du registre :
    // en produire une alors qu'aucune source n'y a survécu créerait un fait
    // dont l'appui n'est reconstructible nulle part.
    //
    // UNE SEULE SUFFIT. Trois sources dont une seule s'écrit soutiennent tout
    // de même le fait : l'ancre n'agrège rien, elle identifie.
    if (assertions.length === 0) return vide

    return {
      event: {
        id: canonicalEventId(ws, accountId, occurredAt),
        workspaceId: ws,
        type: 'FUNDING_ROUND',
        accountId,
        occurredAt,
        occurredAtPrecision: 'DAY',
        canonicalClaimKey: input.canonicalClaimKey,
      },
      execEvents: [],
      snapshots: [],
    }
  }

  // ── EXECUTIVE_APPOINTMENT / EXECUTIVE_DEPARTURE ──────────────────────────
  if (type === 'EXECUTIVE_APPOINTMENT' || type === 'EXECUTIVE_DEPARTURE') {
    if (input.evidence.temporality !== 'dated_event') return vide
    const occurredAt = (input.evidence as any).occurredAt
    if (!JOUR.test(String(occurredAt)) || !jourReel(occurredAt)) return vide

    // ⚠️ L'ANCRE SE DÉRIVE DES ASSERTIONS DURABLES, ET DE LEURS INSTANTANÉS.
    // La personne et la fonction viennent du fait structuré que CHAQUE source
    // durable a affirmé — jamais d'un objet en mémoire, jamais de prose.
    const attendu = type === 'EXECUTIVE_APPOINTMENT' ? 'APPOINTMENT' : 'DEPARTURE'
    const execEvents: CanonicalExecutiveEvent[] = []
    const vusExec = new Set<string>()
    for (const a of assertions) {
      const fait = a.structuredFact
      if (!fait || fait.payload.family !== 'EXECUTIVE_CHANGE') continue
      const p = fait.payload
      // ⚠️ `UNKNOWN` N'ANCRE JAMAIS — fail closed, revalidé à cette frontière
      // même si `mapClaim` l'a déjà refusé en amont.
      if (p.direction !== attendu) continue
      if (!isPersonRef(p.person)) continue
      const personne = personKeyV2(p.person, accountId)
      if (personne === null) continue
      // Cohérence temporelle : l'instantané doit affirmer LE jour de la
      // revendication — un instantané daté d'ailleurs décrit un autre fait.
      if (fait.occurredAt !== occurredAt) continue

      const id = canonicalExecutiveEventId(ws, type, accountId, p.roleFunction, personne, occurredAt)
      if (vusExec.has(id)) continue
      vusExec.add(id)
      execEvents.push({
        id, workspaceId: ws, type, accountId,
        roleFunction: p.roleFunction, personKey: personne,
        occurredAt, occurredAtPrecision: 'DAY',
        canonicalClaimKey: input.canonicalClaimKey,
      })
    }

    execEvents.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    return { event: null, execEvents, snapshots: [] }
  }

  // ── HIRING_SNAPSHOT ──────────────────────────────────────────────────────
  if (input.evidence.temporality !== 'undated_state') return vide

  const snapshots: CanonicalStateSnapshot[] = []
  const vus = new Set<string>()
  for (const a of assertions) {
    // Cohérence exigée des DEUX côtés : une assertion datée sous une evidence
    // d'état, ou l'inverse, décrit une combinaison qu'aucun chemin ne produit.
    if (a.assertionTemporality !== 'undated_state') continue
    if (!a.sourceObservedDay || !JOUR.test(a.sourceObservedDay)) continue

    const id = canonicalSnapshotId(ws, input.canonicalClaimKey, a.sourceObservedDay)
    // ⚠️ PLUSIEURS SOURCES, UN SEUL INSTANTANÉ. Deux pages observées le même
    // jour attestent du MÊME état : l'identité les confond, et c'est voulu.
    // Leurs assertions restent distinctes dans le registre.
    if (vus.has(id)) continue
    vus.add(id)

    snapshots.push({
      id,
      workspaceId: ws,
      type: 'HIRING_SNAPSHOT',
      accountId,
      canonicalClaimKey: input.canonicalClaimKey,
      stateObservedDay: a.sourceObservedDay,
    })
  }

  snapshots.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  return { event: null, execEvents: [], snapshots }
}

// ── GARDES DE FORME — l'identité doit être RECALCULABLE ────────────────────

const nonVide = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

export function isCanonicalEvent(v: any): v is CanonicalEvent {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'FUNDING_ROUND') return false
  if (!nonVide(v.id) || !nonVide(v.workspaceId) || !nonVide(v.canonicalClaimKey)) return false
  if (!COMPTE_VERIFIE.test(String(v.accountId))) return false
  if (v.occurredAtPrecision !== 'DAY') return false
  if (!JOUR.test(String(v.occurredAt)) || !jourReel(v.occurredAt)) return false
  return v.id === canonicalEventId(v.workspaceId, v.accountId, v.occurredAt)
}

export function isCanonicalExecutiveEvent(v: any): v is CanonicalExecutiveEvent {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'EXECUTIVE_APPOINTMENT' && v.type !== 'EXECUTIVE_DEPARTURE') return false
  if (!nonVide(v.id) || !nonVide(v.workspaceId) || !nonVide(v.canonicalClaimKey)) return false
  if (!COMPTE_VERIFIE.test(String(v.accountId))) return false
  if (!nonVide(v.roleFunction) || !nonVide(v.personKey)) return false
  if (v.occurredAtPrecision !== 'DAY') return false
  if (!JOUR.test(String(v.occurredAt)) || !jourReel(v.occurredAt)) return false
  return v.id === canonicalExecutiveEventId(
    v.workspaceId, v.type, v.accountId, v.roleFunction, v.personKey, v.occurredAt,
  )
}

export function isCanonicalStateSnapshot(v: any): v is CanonicalStateSnapshot {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'HIRING_SNAPSHOT') return false
  if (!nonVide(v.id) || !nonVide(v.workspaceId) || !nonVide(v.canonicalClaimKey)) return false
  if (!COMPTE_VERIFIE.test(String(v.accountId))) return false
  if (!JOUR.test(String(v.stateObservedDay))) return false
  // ⚠️ UN INSTANTANÉ NE PORTE JAMAIS DE DATE DE SURVENUE.
  if ((v as any).occurredAt !== undefined) return false
  return v.id === canonicalSnapshotId(v.workspaceId, v.canonicalClaimKey, v.stateObservedDay)
}

export type AnchorWrite =
  | { ok: true; created: boolean }
  | { ok: false; reason: 'invalid' | 'write_failed' }

/**
 * Écrit UNE ancre — INSERTION SEULE, jamais un `upsert`.
 *
 * ⚠️ `upsertItem` REMPLACERAIT une ancre existante. Comme une ancre est
 * ENTIÈREMENT déterminée par son identité, le document réécrit serait
 * identique — mais autoriser le remplacement ouvrirait la porte à l'écriture
 * d'un contenu divergent sous un identifiant existant. L'insertion seule rend
 * cela impossible plutôt que peu probable.
 *
 * `insertItemIfAbsent` rend `false` pour « existe déjà » ET pour « base muette » :
 * on relit pour trancher, sans quoi un échec passerait pour une idempotence.
 */
async function ecrire(
  kind: string, ancre: { id: string; workspaceId: string }, ws: string,
  garde: (v: any) => boolean,
): Promise<AnchorWrite> {
  if (typeof ws !== 'string' || ws.trim() === '') return { ok: false, reason: 'invalid' }
  // ⚠️ L'ESPACE DU DOCUMENT DOIT ÊTRE CELUI DE LA SESSION : une ligne dont le
  // contenu contredit son cloisonnement serait un mensonge de plus qu'un bug.
  if (!garde(ancre) || ancre.workspaceId !== ws) return { ok: false, reason: 'invalid' }

  if (await insertItemIfAbsent(kind, ancre.id, ancre, ws)) return { ok: true, created: true }

  const relu = await getItemStrict<any>(kind, ancre.id, ws)
  if (relu.ok === true && relu.value) return { ok: true, created: false }
  return { ok: false, reason: 'write_failed' }
}

export function saveCanonicalEvent(e: CanonicalEvent, ws: string): Promise<AnchorWrite> {
  return ecrire(CANONICAL_EVENT_KIND, e, ws, isCanonicalEvent)
}

export function saveCanonicalStateSnapshot(
  s: CanonicalStateSnapshot, ws: string,
): Promise<AnchorWrite> {
  return ecrire(CANONICAL_STATE_SNAPSHOT_KIND, s, ws, isCanonicalStateSnapshot)
}

export function readCanonicalEvent(id: string, ws: string) {
  return getItemStrict<CanonicalEvent>(CANONICAL_EVENT_KIND, id, ws)
}

export function readCanonicalStateSnapshot(id: string, ws: string) {
  return getItemStrict<CanonicalStateSnapshot>(CANONICAL_STATE_SNAPSHOT_KIND, id, ws)
}

export interface AnchorReport {
  created: number
  existing: number
  failed: number
}

/**
 * Ancre le lot d'une promotion — NE JETTE JAMAIS.
 *
 * ⚠️ MÊME CONTRAT QUE `recordSourceAssertions`, ET POUR LA MÊME RAISON. Une
 * personne a adjugé un fait ; l'indisponibilité d'une couche d'ancrage ne rend
 * pas ce fait faux. Une ancre en échec n'interrompt pas les suivantes.
 */
export async function recordCanonicalAnchors(
  promotions: readonly AssertionBuildInput[], ws: string,
  durableAssertionIds: ReadonlySet<string>,
): Promise<AnchorReport> {
  const bilan: AnchorReport = { created: 0, existing: 0, failed: 0 }
  const compter = (r: AnchorWrite) => {
    if (r.ok === false) bilan.failed++
    else if (r.created) bilan.created++
    else bilan.existing++
  }

  try {
    for (const p of promotions) {
      const ancres = buildCanonicalAnchors({ ...p, workspaceId: ws, durableAssertionIds })
      if (ancres.event) {
        try { compter(await saveCanonicalEvent(ancres.event, ws)) } catch { bilan.failed++ }
      }
      for (const e of ancres.execEvents) {
        try {
          compter(await ecrire(CANONICAL_EVENT_KIND, e, ws, isCanonicalExecutiveEvent))
        } catch { bilan.failed++ }
      }
      for (const s of ancres.snapshots) {
        try { compter(await saveCanonicalStateSnapshot(s, ws)) } catch { bilan.failed++ }
      }
    }
  } catch {
    bilan.failed++
  }
  return bilan
}
