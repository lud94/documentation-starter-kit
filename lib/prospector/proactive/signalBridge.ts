// SIGNAL-EVIDENCE-BRIDGE-001 — DU SIGNAL EXTERNE AU FAIT DU DECISION KERNEL.
//
// ── LA FRONTIÈRE DE VÉRITÉ ──────────────────────────────────────────────────
//
//   SignalHit (acquisition, non vérifié)
//        ↓  résolution d'entité AUTORITAIRE (data.gouv, SIREN vérifié)
//   SourceEvidence[]  (une par URL — une PREUVE, pas un fait)
//        ↓  canonicalisation : N preuves du MÊME événement → 1 revendication
//   CanonicalClaim
//        ↓  gardes catégorielles : source, corroboration, contradiction, temps
//   KnownEvidenceEvent  ← entrée du Kernel
//
// ── CE MODULE NE DÉCIDE RIEN DU MÉTIER ──────────────────────────────────────
// Il ne sait pas quel Rule Pack lira ses evidences, ni quelle Situation en
// sortira, ni si un compte intéresse Fabel. Il n'importe AUCUN pack, et ne lit
// AUCUN seuil de pack. Une même evidence peut légitimement être consommée par
// plusieurs packs ; en dépendre ici les couplerait pour toujours.
//
// ── CE QU'IL REFUSE DE FAIRE ────────────────────────────────────────────────
// Aucune analyse de prose. Aucun appel LLM. Aucune horloge système. Aucun
// identifiant aléatoire. Aucune date inventée. Aucune confiance calculée.
// L'intention de recherche n'est pas une preuve, `icebreaker` n'est jamais une
// preuve, et le champ hérité `SignalHit.date` n'est JAMAIS un `occurredAt`.
import { createHash } from 'node:crypto'

import type { EvidenceType, KnownEvidenceEvent } from './catalog'
import { EXTERNAL_SIGNAL_PROVIDER, canonicalClaimKey, isStrictInstant, jourReel } from './types'
import { isAcquisitionFactV2 } from './acquisitionV2'
import type {
  EvidenceCorroboration,
  EvidenceProvenance,
  GroundingKind,
  SourceGrade,
  SourceLineageKind,
} from './types'
import type { ExecutivePayloadV2, HiringPayloadV2, SignalHit } from '../../../types/prospector'

/**
 * CONSTANTE DE COMPATIBILITÉ V0 — NON PROBABILISTE ET NON CALIBRÉE.
 *
 * ⚠️ Ce n'est PAS une probabilité, PAS une estimation calibrée, PAS une qualité
 * de source, PAS une probabilité de résultat commercial. C'est UNE valeur
 * temporaire, identique pour toute revendication ayant déjà franchi la TOTALITÉ
 * des gardes catégorielles ci-dessous.
 *
 * Elle est volontairement NON DISCRIMINANTE : la sélection se fait par les
 * gardes — source, corroboration, contradiction, temporalité — et jamais par ce
 * nombre. Aucun bonus au nombre de sources, aucune conversion grade → flottant,
 * aucune pénalité temporelle, aucune valeur issue d'un modèle de langage.
 *
 * Le jour où une politique calibrée existera, elle remplacera cette constante ;
 * d'ici là, la faire varier donnerait l'illusion d'une mesure.
 */
export const ACCEPTED_EXTERNAL_CLAIM_CONFIDENCE_V0 = 0.75

/**
 * Provenance d'ingestion. Jamais first-party : ce sont des sources tierces.
 * Ré-export de la déclaration canonique — `validators.ts` la lit aussi, et les
 * deux doivent désigner la MÊME chaîne.
 */
export { EXTERNAL_SIGNAL_PROVIDER }

/**
 * Compte CANONIQUE et VÉRIFIÉ — la forme exacte, pas un préfixe.
 *
 * ⚠️ `startsWith('acc_siren_')` ne suffisait pas : `acc_siren_` seul,
 * `acc_siren_abc` ou `acc_siren_12` l'auraient franchi. Le SIREN vaut neuf
 * chiffres, et rien d'autre.
 */
const COMPTE_VERIFIE = /^acc_siren_\d{9}$/

/**
 * ⚠️ DÉFINITION DÉPLACÉE DANS `types.ts`, RÉ-EXPORTÉE ICI À L'IDENTIQUE.
 * `acquisitionV2.ts` doit la lire, et ce Bridge doit lire `acquisitionV2` :
 * la garder ici créerait un cycle. `types.ts` est le seul point acyclique où
 * les deux se rencontrent — même arbitrage que `EXTERNAL_SIGNAL_PROVIDER`.
 * Toute la surface historique (`import { jourReel } from './signalBridge'`)
 * reste valide.
 */
export { jourReel } from './types'

// ── QUALITÉ DE SOURCE ───────────────────────────────────────────────────────

/**
 * Qualité de la PREUVE, jamais de la revendication.
 *
 * ⚠️ `A/B/C` ne devient JAMAIS `0.9/0.7/0.5`. Le grade est une ENTRÉE de la
 * politique de promotion, pas un barème déguisé.
 *
 *   A — source primaire capturée : registre officiel, ou site déclaré de
 *       l'entreprise elle-même (déclaration au registre, donc vérifiable).
 *   B — éditeur secondaire crédible et IDENTIFIÉ.
 *   C — agrégateur ou source faible identifiée comme telle.
 *   UNKNOWN — non classable avec sûreté. Jamais promue.
 *
 * ⚠️ LE VOCABULAIRE VIT DANS `types.ts`, ET CE N'EST PAS UN DÉTAIL DE RANGEMENT.
 * Ces valeurs sont désormais PERSISTÉES : `validators.ts` doit les revalider à
 * la relecture, et il ne peut pas importer ce module sans créer un cycle. Ce
 * ré-export conserve la surface historique — tout le dépôt lit `SourceGrade`
 * ici — sans qu'il existe deux listes de grades.
 */
export type { SourceGrade }

/**
 * LIGNÉE — cette preuve est-elle originale, ou reprend-elle une autre source ?
 *
 * ⚠️ `UNKNOWN` NE VAUT JAMAIS INDÉPENDANCE. Cinq reprises d'un communiqué ne
 * font pas cinq confirmations ; ne pas savoir si une reprise en est une ne
 * permet pas de la compter comme originale. L'indépendance s'établit, elle ne
 * se présume pas.
 */
export type SourceLineage =
  | { kind: 'ORIGINAL' }
  | { kind: 'CITES'; sourceUrl: string }
  | { kind: 'UNKNOWN' }

/**
 * PREUVE DE NON-DIVERGENCE, VÉRIFIÉE PAR LE COMPILATEUR.
 *
 * ⚠️ `SourceLineage` et `Grounding` portent une charge utile en plus du `kind`
 * (`sourceUrl`, `anchor`) : ils ne peuvent donc pas ÊTRE les types scalaires de
 * `types.ts`. Mais leurs `kind` doivent en être exactement l'image — sans quoi
 * le Bridge émettrait un jour une valeur que `validators.ts` refuserait à la
 * relecture, ou pire, accepterait une valeur que le Bridge n'émet plus.
 *
 * Ces alias n'existent qu'à la compilation ; ajouter un `kind` d'un seul côté
 * casse `npm run typecheck`, et c'est tout leur objet.
 */
type MemeVocabulaire<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

// ⚠️ L'AFFECTATION EST CE QUI FAIT ÉCHOUER LA COMPILATION. Un simple alias de
// type valant `never` ne produirait aucune erreur : la preuve n'existe que
// parce que `true` doit être assignable au résultat.
const _vocabulairesAlignes: [
  MemeVocabulaire<SourceLineage['kind'], SourceLineageKind>,
  MemeVocabulaire<Grounding['kind'], GroundingKind>,
] = [true, true]
void _vocabulairesAlignes

/** Registres publics faisant autorité. Liste FERMÉE et vérifiable. */
const REGISTRY_HOSTS: readonly string[] = [
  'entreprise.data.gouv.fr',
  'recherche-entreprises.api.gouv.fr',
  'annuaire-entreprises.data.gouv.fr',
  'bodacc-datadila.opendatasoft.com',
  'www.legifrance.gouv.fr',
]

/** Éditeurs secondaires identifiés. Miroir de `PRESS` dans `signals.ts`. */
const PRESS_HOSTS: readonly string[] = [
  'maddyness.com', 'frenchweb.fr', 'usine-digitale.fr', 'eu-startups.com',
  'journaldunet.com', 'lejournaldesentreprises.com', 'sifted.eu', 'tech.eu',
]

/** Agrégateurs : réels, mais faibles pour établir un fait daté. */
const AGGREGATOR_HOSTS: readonly string[] = [
  'welcometothejungle.com', 'hellowork.com', 'apec.fr', 'cadremploi.fr', 'indeed.fr',
]

/** Hôte d'une URL, sans `www.`. `null` si l'URL est inexploitable. */
export function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function correspond(host: string, liste: readonly string[]): boolean {
  return liste.some((h) => {
    const ref = h.replace(/^www\./, '')
    return host === ref || host.endsWith(`.${ref}`)
  })
}

/**
 * Grade DÉTERMINISTE d'une source.
 *
 * ⚠️ AUCUNE INFÉRENCE, AUCUN LLM. Le grade se lit sur l'hôte de l'URL et sur le
 * site que l'entreprise a elle-même déclaré au registre (`Lead.website`, issu de
 * data.gouv). Un article affirmant qu'un communiqué officiel existe ne fabrique
 * PAS une source A : seule la capture du communiqué lui-même le ferait.
 *
 * Non classable ⇒ `UNKNOWN`, jamais un grade optimiste par défaut.
 */
export function gradeForSource(url: unknown, companyWebsite?: string | null): SourceGrade {
  const host = hostOf(url)
  if (!host) return 'UNKNOWN'

  if (correspond(host, REGISTRY_HOSTS)) return 'A'

  const officiel = hostOf(companyWebsite)
  if (officiel && host === officiel) return 'A'

  if (correspond(host, PRESS_HOSTS)) return 'B'
  if (correspond(host, AGGREGATOR_HOSTS)) return 'C'

  return 'UNKNOWN'
}

// ── ANCRAGE MATÉRIEL — LA SORTIE D'UN LLM N'EST PAS UNE VÉRITÉ ─────────────

/**
 * De quoi l'application dispose-t-elle pour VÉRIFIER elle-même la revendication ?
 *
 * ⚠️ LA GARDE LA PLUS IMPORTANTE DE CE MODULE. Un hôte de confiance prouve
 * seulement OÙ une page est hébergée — jamais que cette page soutient ce que le
 * modèle en a extrait. Sans cela, il suffisait qu'un modèle produise
 * `COMPLETED` + une date sur une URL du site de l'entreprise pour qu'un fait
 * daté entre dans le Kernel avec `assertionType: 'fact'`. Un prompt disant
 * « n'invente rien » n'est pas une preuve.
 *
 *   `VERIFIED_ANCHOR` — un extrait VERBATIM a été retrouvé dans le texte source
 *                       réellement capturé par l'application. Vérifié par le
 *                       code, jamais affirmé par le modèle.
 *   `UNVERIFIABLE`    — l'application ne détient aucune matière source. La
 *                       revendication reste CANDIDATE au regard de la MACHINE.
 *
 * ⚠️ CE N'EST PLUS UNE CONDITION DE PROMOTION (arbitrage R1c). Une revendication
 * `UNVERIFIABLE` PEUT être promue si une personne l'a explicitement adjugée :
 * la vérification sémantique de la V0 est humaine. L'ancrage machine reste une
 * métadonnée utile, et son portage jusqu'à cette frontière est différé sous
 * MACHINE-GROUNDING-001.
 */
export type Grounding =
  | { kind: 'VERIFIED_ANCHOR'; anchor: string }
  | { kind: 'UNVERIFIABLE' }

/** Comparaison tolérante à la mise en forme, jamais au contenu. */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .trim()
}

/**
 * L'extrait cité existe-t-il RÉELLEMENT dans le texte source capturé ?
 *
 * ⚠️ AUCUNE CONFIANCE ACCORDÉE À LA CITATION ELLE-MÊME. Un modèle peut produire
 * une citation plausible qui n'apparaît nulle part ; c'est le mode de défaillance
 * le plus courant. On la cherche donc dans la matière capturée. Un ancrage trop
 * court ne prouve rien : le seuil écarte les fragments passe-partout.
 */
export const ANCRAGE_LONGUEUR_MIN = 24

export function verifyAnchor(anchor: unknown, capturedText: unknown): boolean {
  if (typeof anchor !== 'string' || typeof capturedText !== 'string') return false
  const a = normaliser(anchor)
  if (a.length < ANCRAGE_LONGUEUR_MIN) return false
  return normaliser(capturedText).includes(a)
}

/**
 * Ancrage d'une revendication, établi PAR L'APPLICATION.
 *
 * `capturedText` est la matière que l'application détient réellement.
 *
 * ⚠️ ÉTAT EXACT DU CÂBLAGE, À NE PAS SURVENDRE. La voie `exa+claude` DÉTIENT
 * cette matière PENDANT l'acquisition (`ExaDoc.text`) : elle est donc ancrable
 * EN PRINCIPE. Mais le contrat `SignalHit` ne TRANSPORTE ni extrait vérifié ni
 * texte capturé jusqu'à la frontière de promotion. L'ancrage automatique Exa
 * n'est donc PAS câblé de bout en bout aujourd'hui, et cette fonction attend que
 * son appelant lui fournisse la matière.
 *
 * La voie `claude-web` reste inancrable : `CallResult` n'expose que le JSON
 * final, sans trace d'outil ni contenu de page.
 *
 * Aucune des deux n'est bloquante en V0 : une revendication web exige de toute
 * façon une confirmation humaine avant de devenir un fait.
 */
export function groundingFor(anchor: unknown, capturedText?: string | null): Grounding {
  if (typeof capturedText !== 'string' || capturedText.trim() === '') {
    return { kind: 'UNVERIFIABLE' }
  }
  return verifyAnchor(anchor, capturedText)
    ? { kind: 'VERIFIED_ANCHOR', anchor: anchor as string }
    : { kind: 'UNVERIFIABLE' }
}

// ── AUTORITÉ D'AFFIRMATION — LIÉE À LA REVENDICATION, JAMAIS GLOBALE ───────

/**
 * Adjudication HUMAINE d'UNE revendication précise.
 *
 * ⚠️ LA CORRECTION CENTRALE DE R1c. Une version antérieure portait l'autorité
 * sur l'INVOCATION entière, puis la propageait à chaque groupe canonique : une
 * seule confirmation humaine autorisait alors plusieurs faits indépendants. Un
 * opérateur validant une levée signait sans le savoir un poste ouvert.
 *
 * L'autorité est donc désormais liée à `canonicalKey` ET aux URL réellement
 * examinées. Une confirmation portant sur
 * `recent_funding|compte|2026-08-12` n'autorise RIEN d'autre — pas même
 * `sales_hiring|compte|STATE` dans le même appel.
 *
 * ⚠️ `STRUCTURED_AUTHORITY` A ÉTÉ RETIRÉE. Aucun producteur de données
 * structurées faisant autorité n'existe aujourd'hui ; laisser la voie ouverte
 * revenait à accepter `{ kind: 'STRUCTURED_AUTHORITY', provider: "n'importe
 * quoi" }` comme fondement d'un fait du Kernel. Suivi séparément si un
 * producteur déterministe apparaît un jour.
 */
export interface HumanFactConfirmation {
  kind: 'HUMAN_CONFIRMED'
  /** La revendication EXACTE adjugée. Aucune autre n'est couverte. */
  canonicalKey: string
  /** Identifiant opaque de l'acteur. En production : l'identité authentifiée. */
  confirmedBy: string
  /** Horodatage strict. En production : le contexte serveur, jamais le client. */
  confirmedAt: string
  /** Les sources RÉELLEMENT examinées par la personne. */
  sourceUrls: readonly string[]
}

/** Une confirmation est-elle réellement constituée ? Fail closed sur toute lacune. */
export function isHumanFactConfirmation(v: unknown): v is HumanFactConfirmation {
  if (!v || typeof v !== 'object') return false
  const c = v as any
  if (c.kind !== 'HUMAN_CONFIRMED') return false
  if (typeof c.canonicalKey !== 'string' || c.canonicalKey.trim() === '') return false
  if (typeof c.confirmedBy !== 'string' || c.confirmedBy.trim() === '') return false
  if (!isStrictInstant(c.confirmedAt)) return false
  if (!Array.isArray(c.sourceUrls) || c.sourceUrls.length === 0) return false
  return c.sourceUrls.every((u: unknown) => typeof u === 'string' && u.trim() !== '')
}

/** Comparaison d'URL stable : triées, dédoublonnées, sans espaces. */
function ensembleUrls(urls: readonly string[]): Set<string> {
  return new Set(urls.map((u) => u.trim()).filter(Boolean))
}

// ── PREUVE DE SOURCE ────────────────────────────────────────────────────────

/**
 * UNE preuve, issue d'UNE source. Ce n'est pas encore un fait.
 *
 * ⚠️ AUCUNE CONFIANCE NUMÉRIQUE ICI, et c'est délibéré. Un flottant par preuve
 * appellerait une moyenne, et la moyenne est exactement le mécanisme qui
 * transforme cinq copies d'un communiqué en corroboration.
 */
export interface SourceEvidence {
  url: string
  /** Éditeur, quand il est identifiable. L'hôte fait foi, pas le nom déclaré. */
  publisher: string | null
  grade: SourceGrade
  lineage: SourceLineage
  /** Sémantique STRUCTURÉE issue du contrat d'acquisition. Jamais de la prose. */
  hit: SignalHit
  sourcePublishedAt: string | null
  /** Ce que l'application a pu VÉRIFIER elle-même. Jamais ce que le modèle dit. */
  grounding: Grounding
  /**
   * Instant SERVEUR où la matière a été récupérée — absent si inconnu.
   *
   * ⚠️ NE SE DÉDUIT PAS DE L'INSTANT D'ADJUDICATION. L'appelant le fournit
   * lorsqu'il le connaît réellement : pour la voie Quick Search, c'est
   * `SignalCandidate.issuedAt`, l'instant où le serveur a émis le candidat.
   * Inconnu ⇒ absent, jamais `observedAt` recopié.
   */
  retrievedAt?: string
  /**
   * POURQUOI le grade A « site de l'entreprise » a été décerné
   * (ENTITY_OFFICIAL_DOMAIN_GROUNDING_001) :
   *   REGISTRY_DECLARED                — site fourni par le registre officiel ;
   *   HUMAN_ADJUDICATED_LEGAL_NOTICE  — domaine première-partie ADJUGÉ par un
   *     humain sur matière légale capturée par le serveur (ce n'est PAS une
   *     preuve de propriété du domaine).
   * PRÉSENT UNIQUEMENT quand le grade A vient du chemin site-officiel — jamais
   * sur les hôtes de registre A, ni sur B/C/UNKNOWN. Les deux autorités ne
   * doivent JAMAIS devenir indistinguables dans la provenance persistée.
   */
  domainAuthority?: 'REGISTRY_DECLARED' | 'HUMAN_ADJUDICATED_LEGAL_NOTICE'
}

export function sourceEvidenceFromHit(
  hit: SignalHit,
  companyWebsite?: string | null,
  lineage: SourceLineage = { kind: 'UNKNOWN' },
  grounding: Grounding = { kind: 'UNVERIFIABLE' },
  retrievedAt?: string,
  domainAuthority?: 'REGISTRY_DECLARED' | 'HUMAN_ADJUDICATED_LEGAL_NOTICE',
): SourceEvidence | null {
  const host = hostOf(hit?.sourceUrl)
  if (!host) return null

  // ⚠️ L'autorité de domaine ne s'attache QUE si le grade A provient réellement
  // de la correspondance hôte-source ↔ site officiel fourni — jamais recopiée
  // aveuglément sur un hôte de registre, une presse B, un agrégateur C.
  const officiel = hostOf(companyWebsite)
  const autoriteApplicable = domainAuthority !== undefined && officiel !== null && host === officiel

  return {
    url: hit.sourceUrl as string,
    publisher: host,
    grade: gradeForSource(hit.sourceUrl, companyWebsite),
    lineage,
    hit,
    sourcePublishedAt: hit.sourcePublishedAt ?? null,
    grounding,
    ...(autoriteApplicable ? { domainAuthority } : {}),
    // ⚠️ Non renseigné ⇒ ABSENT du champ. Aucune horloge n'est lue ici : ce
    // module est pur, et fabriquer un instant de récupération inventerait une
    // date de consultation que personne n'a observée.
    ...(typeof retrievedAt === 'string' && retrievedAt.trim() !== ''
      ? { retrievedAt: retrievedAt.trim() }
      : {}),
  }
}

// ── CORRESPONDANCES SÉMANTIQUES ─────────────────────────────────────────────

/** Motifs de refus. Un refus est un RÉSULTAT, jamais une panne. */
export type BridgeRefusal =
  | 'NO_VERIFIED_ACCOUNT'
  | 'NO_SOURCE_URL'
  | 'NO_HONEST_EVIDENCE_TYPE'
  | 'INTENT_NOT_REALIZED'
  | 'NO_EXACT_EVENT_DATE'
  | 'SOURCE_POLICY_FAILED'
  | 'MATERIAL_CONTRADICTION'
  | 'UNGROUNDED_CLAIM'
  | 'NO_FACT_AUTHORITY'
  | 'CONFIRMATION_SOURCE_MISMATCH'

export interface MappedClaim {
  type: EvidenceType
  /** `dated_event` exige `occurredAt` ; `undated_state` l'interdit. */
  temporality: 'dated_event' | 'undated_state'
  occurredAt?: string
}

/**
 * Correspondance EXACTE, à partir des seuls champs clos du contrat.
 *
 * ⚠️ TROIS CORRESPONDANCES SEULEMENT, ET C'EST VOLONTAIRE. Chacune prouve ses
 * préconditions sans lire une phrase. Tout le reste rend `NO_MAP` :
 * rachat/M&A, recrutement tech, lancement produit, nomination de direction non
 * commerciale, intentions futures, prose de croissance vague.
 *
 * ── POURQUOI `site_expansion` ET `geo_expansion` NE SONT PAS ICI ────────────
 * `SignalHit.signalType` ne connaît que `recrutement | levée | actu | autre`.
 * Une ouverture de bureau, une implantation à l'étranger et un lancement
 * produit y valent toutes `actu` : rien dans le contrat d'acquisition ne permet
 * de les distinguer sans lire `detail`. Les mapper exigerait donc précisément
 * l'analyse de prose que ce lot interdit. Il manque un champ `eventKind` clos
 * en amont — c'est un manque de CONTRAT, pas une limite du Bridge.
 */
export function mapClaim(hit: SignalHit): MappedClaim | BridgeRefusal {
  if (!hit || typeof hit !== 'object') return 'NO_HONEST_EVIDENCE_TYPE'

  // ── CONTRAT V2 D'ABORD (SIGNAL_ACQUISITION_CONTRACT_002) ─────────────────
  // ⚠️ UN BLOC V2 PRÉSENT MAIS MALFORMÉ EST UN REFUS, JAMAIS UN REPLI V1. Un
  // hit qui prétendait porter un fait structuré et ne le porte pas ne redevient
  // pas silencieusement un hit V1 : le dépouiller ferait adjuger une
  // revendication différente de celle que l'acquisition a émise.
  if (hit.v2 !== undefined) return mapClaimV2(hit.v2)

  // ── ÉTAT OBSERVÉ : poste Sales actuellement ouvert ────────────────────────
  if (hit.claimNature === 'STATE') {
    if (hit.roleStatus === 'OPEN' && hit.roleFunction === 'SALES') {
      // Un état n'a pas de date de survenue connue, et n'a pas à en recevoir une.
      return { type: 'sales_hiring' as EvidenceType, temporality: 'undated_state' }
    }
    return 'NO_HONEST_EVIDENCE_TYPE'
  }

  if (hit.claimNature !== 'EVENT') return 'NO_HONEST_EVIDENCE_TYPE'

  // Une intention annoncée n'est pas un fait réalisé. Trou EVIDENCE-INTENT-001,
  // délibérément non comblé ici.
  if (hit.eventStatus === 'ANNOUNCED_FUTURE') return 'INTENT_NOT_REALIZED'
  if (hit.eventStatus !== 'COMPLETED') return 'NO_HONEST_EVIDENCE_TYPE'

  const type = typeEvenement(hit)
  if (!type) return 'NO_HONEST_EVIDENCE_TYPE'

  // ⚠️ UN ÉVÉNEMENT DATÉ EXIGE UNE DATE MÉTIER AU JOUR EXACT. `sourcePublishedAt`
  // ne s'y substitue JAMAIS : la date de publication d'un article n'est pas la
  // date du fait qu'il rapporte. Le champ hérité `hit.date` non plus.
  // Précision annoncée ET valeur réellement valide : les deux, revalidées ici.
  if (hit.eventDatePrecision !== 'DAY' || !jourReel(hit.eventDate)) {
    return 'NO_EXACT_EVENT_DATE'
  }

  return { type, temporality: 'dated_event', occurredAt: hit.eventDate }
}

/**
 * ── POURQUOI `new_sales_leader` N'EST PAS ICI ───────────────────────────────
 * Une version antérieure le déduisait de `roleStatus === 'FILLED'` +
 * `roleFunction === 'SALES'`. C'était FAUX : le contrat d'acquisition connaît
 * une FONCTION, jamais une SÉNIORITÉ. « Account Executive recruté » satisfait
 * exactement les deux mêmes champs qu'« un VP Sales nommé », et deviendrait donc
 * un « nouveau responsable Sales » — un fait sur l'organisation de l'entreprise
 * que personne n'a observé.
 *
 * Aucune séniorité n'est déduite de `detail`, `role`, d'un intitulé ni de
 * l'intention de recherche. Le mapping revient quand un champ clos le prouvera.
 */
function typeEvenement(hit: SignalHit): EvidenceType | null {
  if (hit.signalType === 'levée') return 'recent_funding' as EvidenceType
  return null
}

/**
 * Correspondance FERMÉE du contrat V2 — champs clos uniquement, aucune prose.
 *
 * ⚠️ LA PROSE D'AUDIT DU BLOC V2 N'EST JAMAIS LUE ICI (verrou structurel dans
 * les tests). Toute décision factuelle vient des champs discriminés du
 * payload, validés par `isAcquisitionFactV2`.
 *
 * ⚠️ DIRECTION `UNKNOWN` ⇒ REFUS AVANT L'EVIDENCE. Le contrat Evidence ne
 * connaît pas d'événement de direction indéterminée : « quelque chose est
 * arrivé à cette personne » n'est pas un type honnête. L'assertion de source
 * reste possible en amont si un jour un chemin l'exige ; ici, on s'abstient.
 */
function mapClaimV2(v2: unknown): MappedClaim | BridgeRefusal {
  if (!isAcquisitionFactV2(v2)) return 'NO_HONEST_EVIDENCE_TYPE'

  if (v2.family === 'HIRING_SNAPSHOT') {
    const p = v2.payload as HiringPayloadV2
    if (p.roleStatus === 'OPEN' && p.roleFunction === 'SALES') {
      return { type: 'sales_hiring' as EvidenceType, temporality: 'undated_state' }
    }
    return 'NO_HONEST_EVIDENCE_TYPE'
  }

  // FUNDING et EXECUTIVE_CHANGE sont des ÉVÉNEMENTS (imposé par le validateur).
  if (v2.eventStatus === 'ANNOUNCED_FUTURE') return 'INTENT_NOT_REALIZED'
  if (v2.eventStatus !== 'COMPLETED') return 'NO_HONEST_EVIDENCE_TYPE'
  if (v2.occurredAtPrecision !== 'DAY' || !jourReel(v2.occurredAt)) {
    return 'NO_EXACT_EVENT_DATE'
  }

  if (v2.family === 'FUNDING') {
    return { type: 'recent_funding' as EvidenceType, temporality: 'dated_event', occurredAt: v2.occurredAt }
  }

  const p = v2.payload as ExecutivePayloadV2
  if (p.direction === 'APPOINTMENT') {
    return { type: 'executive_appointment' as EvidenceType, temporality: 'dated_event', occurredAt: v2.occurredAt }
  }
  if (p.direction === 'DEPARTURE') {
    return { type: 'executive_departure' as EvidenceType, temporality: 'dated_event', occurredAt: v2.occurredAt }
  }
  return 'NO_HONEST_EVIDENCE_TYPE'
}

// ── CANONICALISATION ────────────────────────────────────────────────────────

/**
 * Identité CANONIQUE d'une revendication.
 *
 * ⚠️ ELLE DÉSIGNE UN ÉVÉNEMENT DU MONDE, PAS UNE SOURCE. Deux articles décrivant
 * la même levée du 12 août rendent la même clé — donc UN seul fait pour le
 * Kernel.
 *
 * ⚠️ CORRECTION D'UNE AFFIRMATION FAUSSE. Cette note prétendait que « deux levées
 * à des dates différentes rendent deux clés, donc aucune n'écrase l'autre ».
 * C'est exact de CETTE FONCTION, et faux du chemin complet : le regroupement par
 * SUJET, en amont, voit deux dates divergentes sur le sujet `FUNDING` et bloque
 * l'ensemble comme une contradiction. Deux tours réellement distincts d'un même
 * compte sont donc aujourd'hui perdus tous les deux.
 *
 * C'est un fail-closed assumé, pas une préservation : rien dans le contrat
 * d'acquisition ne distingue « deux sources en désaccord sur un tour » de « deux
 * tours réels ». Suivi sous EVENT-IDENTITY-001. Aucun identifiant d'événement
 * n'est inventé ici, et le tour ne se déduit pas de la prose.
 *
 * ⚠️ N'UTILISE PAS `stableEvidenceId` de `dataBridge` : cette fonction-là vaut
 * `(type, compte, personne)` et convient à un ÉTAT — un seul `hot_lead` par
 * compte. Employée pour un événement, elle ferait s'écraser deux levées
 * successives du même compte.
 *
 * Aucune horloge, aucun aléa : deux exécutions rendent la même identité.
 */
export function canonicalKey(accountId: string, claim: MappedClaim): string {
  // ⚠️ DÉLÉGATION, PAS RÉIMPLÉMENTATION. La règle vit dans `types.ts` parce que
  // les validateurs doivent la recalculer à la relecture ; deux algorithmes
  // pour une même identité divergeraient tôt ou tard.
  return canonicalClaimKey({ ...claim, accountId })
}

export function externalEvidenceId(cle: string): string {
  return `ev_ext_${createHash('sha256').update(cle, 'utf8').digest('hex').slice(0, 16)}`
}

// ── CORROBORATION ───────────────────────────────────────────────────────────

/**
 * Éditeurs INDÉPENDANTS PROUVÉS.
 *
 * ⚠️ ON COMPTE DES ÉDITEURS, JAMAIS DES URL. Et seule une lignée `ORIGINAL`
 * compte : `CITES` désigne une reprise, `UNKNOWN` une lignée non établie. Ne pas
 * savoir si un article reprend un communiqué ne permet pas d'affirmer qu'il ne
 * le reprend pas.
 */
export function independentPublishers(sources: readonly SourceEvidence[]): string[] {
  const vus = new Set<string>()
  for (const s of sources) {
    if (s.lineage.kind !== 'ORIGINAL') continue
    if (!s.publisher) continue
    vus.add(s.publisher)
  }
  return [...vus].sort()
}

function estAncree(s: SourceEvidence): boolean {
  return s.grounding?.kind === 'VERIFIED_ANCHOR'
}

/**
 * Sources QUALIFIANTES — celles qui portent RÉELLEMENT la politique.
 *
 * ⚠️ CORRECTION D'UN DÉFAUT D'ANCRAGE EMPRUNTÉ. Une version antérieure vérifiait
 * séparément « la politique de source passe » et « au moins une source est
 * ancrée ». Les deux pouvaient donc être satisfaites par des sources
 * DIFFÉRENTES : une source A autoritaire mais NON ancrée ouvrait la porte, et
 * une source C ancrée fournissait l'ancrage. La revendication était promue sans
 * qu'aucune source ne satisfasse les deux conditions à la fois.
 *
 * L'autorité et la vérification doivent tenir dans les MÊMES sources :
 *
 *   A + 1                → la source A qualifiante doit elle-même être ancrée
 *   B + ≥ 2 indépendants → les ≥ 2 sources B qualifiantes doivent l'être
 *
 * Rend les sources qui qualifient, ou `[]` — jamais un booléen : la liste rend
 * la règle auditable.
 */
export function qualifyingSources(
  sources: readonly SourceEvidence[],
  exigerAncrage = true,
): SourceEvidence[] {
  const ancree = (s: SourceEvidence) => !exigerAncrage || estAncree(s)

  const a = sources.filter((s) => s.grade === 'A' && ancree(s))
  if (a.length > 0) return a

  // Chaque source B qualifiante doit être originale — et ancrée quand l'ancrage
  // est exigé. Deux éditeurs distincts au minimum ; une seule d'entre elles
  // ancrée ne suffit pas.
  const b = sources.filter((s) => s.grade === 'B' && ancree(s) && s.lineage.kind === 'ORIGINAL')
  const editeurs = new Set(b.map((s) => s.publisher).filter(Boolean) as string[])
  return editeurs.size >= 2 ? b : []
}

/**
 * La politique de GRADE et d'INDÉPENDANCE, sans l'exigence d'ancrage.
 *
 * ⚠️ Elle ne suffit JAMAIS à promouvoir. Elle existe pour que le refus soit
 * DIAGNOSTIQUE : « aucune source qualifiante » et « des sources qualifiantes non
 * ancrées » sont deux problèmes différents, et les confondre enverrait corriger
 * le mauvais.
 */
export function sourcePolicyPasses(sources: readonly SourceEvidence[]): boolean {
  return qualifyingSources(sources, false).length > 0
}

// ── CONTRADICTION ───────────────────────────────────────────────────────────

/**
 * Deux sources s'opposent-elles MATÉRIELLEMENT sur ce que le fait est ?
 *
 * ⚠️ AUCUNE MOYENNE, AUCUN ARBITRAGE IMPLICITE. Un désaccord sur le statut d'un
 * événement ou d'un poste porte sur la nature même du fait : le trancher au
 * jugé fabriquerait la réalité la plus commode. On bloque, et les preuves
 * concurrentes sont conservées par l'appelant.
 */
export function materialContradiction(sources: readonly SourceEvidence[]): boolean {
  const valeurs = <T>(f: (h: SignalHit) => T) =>
    new Set(sources.map((s) => f(s.hit)).filter((v) => v !== 'UNKNOWN' && v != null))

  if (valeurs((h) => h.eventStatus).size > 1) return true
  if (valeurs((h) => h.roleStatus).size > 1) return true
  if (valeurs((h) => h.claimNature).size > 1) return true
  // Deux dates de survenue distinctes pour une même revendication : ce sont deux
  // faits différents, ou l'un des deux est faux. Dans les deux cas, on ne choisit pas.
  if (valeurs((h) => (h.eventDatePrecision === 'DAY' ? h.eventDate : null)).size > 1) return true

  return false
}

// ── PROMOTION ───────────────────────────────────────────────────────────────

export interface PromotionInput {
  /** Identifiant de compte CANONIQUE, obtenu via `accountIdForLead`. */
  accountId: string
  sources: readonly SourceEvidence[]
  /** Injecté par l'appelant. Aucune horloge système dans ce module. */
  observedAt: string
  /**
   * AUTORITÉ EXPLICITE d'affirmer ce fait. Absente ⇒ aucune promotion.
   *
   * ⚠️ Volontairement OPTIONNELLE dans le type et OBLIGATOIRE à l'exécution :
   * l'omettre doit produire un refus lisible, pas une erreur de compilation qui
   * pousserait un appelant à inventer une valeur pour « faire passer ».
   */
  /**
   * Adjudications humaines disponibles. Zéro, une ou plusieurs.
   *
   * ⚠️ CHAQUE revendication canonique cherche LA SIENNE. Une confirmation qui ne
   * la désigne pas ne l'autorise pas, fût-elle présente dans le même appel.
   */
  confirmations?: readonly HumanFactConfirmation[]
}

export type PromotionResult =
  | {
      ok: true
      evidence: KnownEvidenceEvent
      canonicalKey: string
      corroboration: string[]
      /**
       * Les sources QUALIFIANTES — celles qui ont réellement porté la décision.
       *
       * ⚠️ EXPOSÉES, PAS RECALCULÉES PAR L'APPELANT. `qualifyingSources` est la
       * politique de source ; la rejouer dehors ferait exister deux définitions
       * de « qualifiante », et la divergence passerait pour une cohérence.
       *
       * ⚠️ ET C'EST LA SEULE VOIE VERS LA PROVENANCE DE CHACUNE. `evidence.source`
       * ne décrit QUE la source principale (`urls[0]`) : un registre construit
       * depuis elle perdrait le grade, la lignée et l'ancrage de toutes les
       * autres — exactement ce que ce registre existe pour conserver.
       */
      qualifyingSources: readonly SourceEvidence[]
    }
  | { ok: false; reason: BridgeRefusal }

/**
 * Promeut UN groupe de preuves portant sur LE MÊME fait en un fait du Kernel.
 *
 * ⚠️ L'APPELANT GARANTIT QUE LE GROUPE EST HOMOGÈNE. La canonicalisation
 * (`groupSourcesByClaim`) s'en charge ; cette fonction vérifie ensuite que les
 * sources ne se contredisent pas.
 *
 * ⚠️ `accountId` DOIT venir d'une résolution autoritaire. Un identifiant
 * `acc_name_*` — le repli par nom d'`accountIdForLead` — est REFUSÉ ici : la
 * vérité externe ne s'attache qu'à une entité vérifiée, sans quoi une evidence
 * se collerait à un homonyme.
 */
export function promoteToEvidence(input: PromotionInput): PromotionResult {
  if (!input?.accountId || !COMPTE_VERIFIE.test(input.accountId)) {
    return { ok: false, reason: 'NO_VERIFIED_ACCOUNT' }
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    return { ok: false, reason: 'NO_SOURCE_URL' }
  }

  const claim = mapClaim(input.sources[0].hit)
  if (typeof claim === 'string') return { ok: false, reason: claim }

  if (materialContradiction(input.sources)) {
    return { ok: false, reason: 'MATERIAL_CONTRADICTION' }
  }

  const cle = canonicalKey(input.accountId, claim)

  // ── POLITIQUE DE SOURCE : grade et indépendance ──────────────────────────
  // ⚠️ L'ANCRAGE MACHINE N'EST PLUS EXIGÉ ICI (arbitrage R1c). Il n'est
  // transporté de bout en bout par aucune voie d'acquisition : le maintenir
  // obligatoire bloquerait le chemin produit réel même une fois le contexte
  // métier implémenté. La vérification sémantique de la V0 est HUMAINE, et elle
  // est exigée plus bas — sans elle, aucun fait. Le portage de l'ancrage
  // machine jusqu'à cette frontière est suivi sous MACHINE-GROUNDING-001.
  const qualifiantes = qualifyingSources(input.sources, false)
  if (qualifiantes.length === 0) {
    return { ok: false, reason: 'SOURCE_POLICY_FAILED' }
  }

  // ── (retiré) ─────────────────────────────────────────────────────────────
  // ⚠️ C'EST LE COUPLAGE QUI FERME L'ANCRAGE EMPRUNTÉ. Vérifier séparément
  // « la politique passe » et « une source est ancrée » permettait qu'une source
  // A autoritaire NON ancrée ouvre la porte pendant qu'une source C ancrée
  // fournissait l'ancrage — deux sources différentes, aucune satisfaisant les
  // deux conditions.


  // ── AUTORITÉ LIÉE À CETTE REVENDICATION, ET À ELLE SEULE ─────────────────
  // ⚠️ Un ancrage machine n'est PAS une autorité : il atteste qu'un fragment de
  // texte existe, jamais que l'interprétation structurée qu'un modèle en a tirée
  // soit juste. Seule une personne adjuge — et son adjudication ne couvre que la
  // revendication qu'elle DÉSIGNE.
  const confirmation = (input.confirmations ?? []).find(
    (c) => isHumanFactConfirmation(c) && c.canonicalKey === cle,
  )
  if (!confirmation) return { ok: false, reason: 'NO_FACT_AUTHORITY' }

  // ── LA CONFIRMATION DOIT COUVRIR LES SOURCES QUALIFIANTES ────────────────
  // Une adjudication portant sur d'autres URL n'a pas examiné les preuves qui
  // fondent la promotion. Et une URL étrangère au groupe signale une
  // confirmation rattachée au mauvais objet : dans les deux cas, on refuse.
  const confirmees = ensembleUrls(confirmation.sourceUrls)
  const duGroupe = ensembleUrls(input.sources.map((s) => s.url))
  for (const q of qualifiantes) {
    if (!confirmees.has(q.url.trim())) return { ok: false, reason: 'CONFIRMATION_SOURCE_MISMATCH' }
  }
  for (const u of confirmees) {
    if (!duGroupe.has(u)) return { ok: false, reason: 'CONFIRMATION_SOURCE_MISMATCH' }
  }

  // ⚠️ LA SOURCE PERSISTÉE DOIT ÊTRE UNE PREUVE REVUE ET QUALIFIANTE.
  // Une version antérieure prenait la première URL du GROUPE, triée : la source
  // principale d'une evidence pouvait donc être un agrégateur faible jamais
  // examiné, alors qu'une autre source justifiait la promotion. Relue plus tard,
  // l'evidence aurait désigné une preuve qui ne la fonde pas.
  const urls = [...new Set(qualifiantes.map((s) => s.url.trim()))].sort()

  // ── INSTANTANÉ DE QUALIFICATION — CE QUI A FONDÉ LA DÉCISION, CONSERVÉ ───
  // ⚠️ CE BLOC EXISTE PARCE QUE TOUT CECI ÉTAIT CALCULÉ, UTILISÉ, PUIS JETÉ.
  // Le grade, l'éditeur, la lignée et l'ancrage décidaient de la promotion et
  // ne survivaient pas à la persistance : relue plus tard, l'evidence ne
  // pouvait plus dire POURQUOI ses sources étaient qualifiantes. Un audit
  // devait re-télécharger les pages — c'est-à-dire refaire l'histoire, avec la
  // politique d'aujourd'hui et non celle du jour de la promotion.
  //
  // ⚠️ LA PROVENANCE DÉCRIT LA SOURCE QUE `source.url` DÉSIGNE, ET ELLE SEULE.
  // Prendre la première QUALIFIANTE au hasard décrirait une preuve différente
  // de celle que l'evidence cite : le lecteur croirait lire le grade de la
  // source affichée alors qu'il lirait celui d'une autre.
  const principale = qualifiantes.find((s) => s.url.trim() === urls[0]) as SourceEvidence
  const provenance: EvidenceProvenance = {
    ...(principale.publisher ? { publisher: principale.publisher } : {}),
    grade: principale.grade,
    lineage: principale.lineage.kind,
    grounding: principale.grounding.kind,
    // ⚠️ ABSENTE SI INCONNUE — JAMAIS `observedAt`. La date de publication d'un
    // article n'est pas l'instant où nous l'avons adjugé, et la lui substituer
    // ferait passer une source non datée pour une source publiée le jour de la
    // confirmation. Même faux zéro que `occurredAt = now` sur un état non daté.
    ...(principale.sourcePublishedAt ? { sourcePublishedAt: principale.sourcePublishedAt } : {}),
    ...(principale.retrievedAt ? { retrievedAt: principale.retrievedAt } : {}),
    // Pourquoi le grade A site-officiel — absent partout ailleurs. L'audit doit
    // toujours distinguer registre déclaré et adjudication humaine.
    ...(principale.domainAuthority ? { domainAuthority: principale.domainAuthority } : {}),
  }

  // ⚠️ COMPTÉE SUR LES QUALIFIANTES, comme `corroboration` du résultat. Une
  // source écartée n'a fondé aucune décision : la faire figurer ici donnerait à
  // une preuve rejetée l'apparence d'un appui.
  const editeurs = independentPublishers(qualifiantes)
  const corroboration: EvidenceCorroboration = {
    publishers: editeurs,
    sourceUrls: urls,
    // ⚠️ `0` EST UN FAIT, PAS UN MANQUE : c'est le cas nominal de la V0, où la
    // lignée n'est pas transportée depuis l'acquisition et vaut donc `UNKNOWN`.
    independentPublisherCount: editeurs.length,
  }

  const base = {
    id: externalEvidenceId(cle),
    accountId: input.accountId,
    // ⚠️ AUCUN `personId`. Une levée ou un poste ouvert sont des faits de
    // COMPTE ; les attacher à une personne inventerait une relation.
    scope: 'account' as const,
    type: claim.type,
    source: {
      provider: EXTERNAL_SIGNAL_PROVIDER,
      url: urls[0],
      reference: urls.length > 1 ? urls.join(' ') : undefined,
      provenance,
    },
    corroboration,
    // Le fait est RAPPORTÉ par une source identifiée, il n'est pas déduit.
    assertionType: 'fact' as const,
    confidence: ACCEPTED_EXTERNAL_CLAIM_CONFIDENCE_V0,
    observedAt: input.observedAt,
    // ⚠️ POURQUOI CE FAIT A ÉTÉ ACCEPTÉ — ET CE MOTIF DOIT SURVIVRE À LA
    // PERSISTANCE. Le cacher dans `source.reference` en ferait une chaîne libre
    // que rien ne valide ; relue plus tard, une evidence externe doit pouvoir
    // dire QUI l'a adjugée, QUAND, sur QUELLE revendication et au vu de QUELLES
    // sources. Sans cela, un fait accepté devient indiscernable d'un fait
    // fabriqué dès la première relecture.
    acceptance: {
      kind: 'human_confirmed' as const,
      actorId: confirmation.confirmedBy,
      confirmedAt: confirmation.confirmedAt,
      canonicalKey: cle,
      sourceUrls: [...confirmees].sort(),
    },
    // ── FAIT STRUCTURÉ V2 — PROJECTION COURANTE DE LA SOURCE PRINCIPALE ────
    // ⚠️ CELLE QUE `source.url` DÉSIGNE, comme la provenance : l'evidence doit
    // décrire la preuve qu'elle cite. Les instantanés de TOUTES les sources —
    // y compris celles qui affirment un autre montant — vivent dans le registre
    // `SourceAssertion`, chacune sous sa propre version sémantique. Ce champ
    // n'entre dans AUCUNE identité et peut être réécrit par une adjudication
    // ultérieure (même limite tracée que EVIDENCE_PROVENANCE_OVERWRITE_001).
    ...(principale.hit?.v2 ? { structuredFact: principale.hit.v2 } : {}),
  }

  const evidence = (
    claim.temporality === 'dated_event'
      ? { ...base, temporality: 'dated_event' as const, occurredAt: claim.occurredAt as string }
      : { ...base, temporality: 'undated_state' as const }
  ) as KnownEvidenceEvent

  // ⚠️ CORROBORATION COMPTÉE SUR LES PREUVES QUALIFIANTES, ET SUR ELLES SEULES.
  // Une source faible ou non classée présente dans le même groupe n'a fondé
  // aucune décision : la faire figurer comme corroboration donnerait à une
  // preuve écartée l'apparence d'un appui.
  return {
    ok: true,
    evidence,
    canonicalKey: cle,
    corroboration: independentPublishers(qualifiantes),
    qualifyingSources: qualifiantes,
  }
}

/**
 * Regroupe des preuves par identité canonique.
 *
 * ⚠️ C'EST ICI QUE « HUIT ARTICLES » DEVIENNENT « UN FAIT ». Les preuves dont la
 * revendication ne se mappe pas sont écartées avec leur motif : elles ne
 * disparaissent pas en silence.
 */
/**
 * SUJET CANDIDAT d'une preuve — indépendant de ce qui peut être CONTESTÉ.
 *
 * ⚠️ C'EST LA CORRECTION DU DÉFAUT D'ORDONNANCEMENT. Une première version
 * détectait les contradictions APRÈS le mapping et le regroupement. Deux
 * conséquences, toutes deux dangereuses :
 *
 *   • une source `ANNOUNCED_FUTURE` était rejetée par `mapClaim` AVANT d'entrer
 *     dans le groupe ; la source `COMPLETED` survivante était alors promue sans
 *     jamais avoir vu la contradiction ;
 *   • la DATE entrant dans l'identité canonique, deux sources annonçant deux
 *     jours différents pour le même événement formaient DEUX groupes — donc deux
 *     faits — au lieu d'un désaccord.
 *
 * Le sujet ne retient donc que ce qui n'est pas en litige : la nature du fait
 * visé. Statut, date et statut de poste en sont volontairement absents — ce
 * sont précisément les dimensions sur lesquelles les sources s'opposent.
 */
export function claimSubject(hit: SignalHit): string {
  if (hit?.signalType === 'levée') return 'FUNDING'
  if (hit?.roleFunction === 'SALES') return 'SALES_ROLE'
  return `OTHER:${hit?.signalType ?? 'autre'}`
}

export function groupSourcesBySubject(
  sources: readonly SourceEvidence[],
): Map<string, SourceEvidence[]> {
  const clusters = new Map<string, SourceEvidence[]>()
  for (const s of sources) {
    const cle = claimSubject(s.hit)
    const existant = clusters.get(cle)
    if (existant) existant.push(s)
    else clusters.set(cle, [s])
  }
  return clusters
}

export function groupSourcesByClaim(
  accountId: string,
  sources: readonly SourceEvidence[],
): { groups: Map<string, SourceEvidence[]>; rejected: { source: SourceEvidence; reason: BridgeRefusal }[] } {
  const groups = new Map<string, SourceEvidence[]>()
  const rejected: { source: SourceEvidence; reason: BridgeRefusal }[] = []

  for (const s of sources) {
    const claim = mapClaim(s.hit)
    if (typeof claim === 'string') {
      rejected.push({ source: s, reason: claim })
      continue
    }
    const cle = canonicalKey(accountId, claim)
    const existant = groups.get(cle)
    if (existant) existant.push(s)
    else groups.set(cle, [s])
  }

  return { groups, rejected }
}

/** UNE promotion réussie, avec les preuves qui l'ont portée. */
export interface BridgePromotion {
  evidence: KnownEvidenceEvent
  canonicalKey: string
  qualifyingSources: readonly SourceEvidence[]
}

export interface BridgeOutcome {
  evidence: KnownEvidenceEvent[]
  refusals: { canonicalKey: string | null; reason: BridgeRefusal }[]
  /**
   * Détail par promotion — ADDITIF, `evidence` reste inchangé.
   *
   * ⚠️ AJOUTÉ, ET NON SUBSTITUÉ. Tous les appelants existants lisent
   * `evidence` ; en changer la forme pour y loger les sources aurait touché la
   * route, les tests et le Golden pour une couche d'audit qui ne doit rien
   * perturber.
   */
  promotions: BridgePromotion[]
}

/**
 * Chaîne complète, PURE : preuves → faits du Kernel.
 *
 * Déterministe : même entrée, même sortie, identifiants compris. L'ordre de
 * sortie est trié par identifiant pour ne pas laisser transparaître l'ordre
 * d'arrivée des sources.
 */
export function bridgeSignals(input: PromotionInput): BridgeOutcome {
  const evidence: KnownEvidenceEvent[] = []
  const refusals: { canonicalKey: string | null; reason: BridgeRefusal }[] = []
  const promotions: BridgePromotion[] = []

  if (!input?.accountId || !COMPTE_VERIFIE.test(input.accountId)) {
    return { evidence: [], promotions: [], refusals: [{ canonicalKey: null, reason: 'NO_VERIFIED_ACCOUNT' }] }
  }

  // ── ÉTAPE 1 : CONTRADICTION, AVANT TOUT MAPPING ──────────────────────────
  // Un cluster contredit est écarté EN ENTIER. On ne retire pas « la source
  // gênante » : choisir laquelle des deux dit vrai serait exactement l'arbitrage
  // que la doctrine interdit.
  const retenues: SourceEvidence[] = []
  for (const [, cluster] of groupSourcesBySubject(input.sources ?? [])) {
    if (materialContradiction(cluster)) {
      refusals.push({ canonicalKey: null, reason: 'MATERIAL_CONTRADICTION' })
      continue
    }
    retenues.push(...cluster)
  }

  // ── ÉTAPE 2 : mapping, regroupement canonique, promotion ─────────────────
  const { groups, rejected } = groupSourcesByClaim(input.accountId, retenues)
  for (const r of rejected) refusals.push({ canonicalKey: null, reason: r.reason })

  for (const [cle, sources] of groups) {
    // ⚠️ `r.ok === false`, jamais `!r.ok` : `strict` est désactivé dans ce dépôt
    // et une union discriminée n'y est PAS rétrécie par un test de véracité.
    const r = promoteToEvidence({ ...input, sources })
    if (r.ok === false) refusals.push({ canonicalKey: cle, reason: r.reason })
    else {
      evidence.push(r.evidence)
      promotions.push({
        evidence: r.evidence, canonicalKey: r.canonicalKey, qualifyingSources: r.qualifyingSources,
      })
    }
  }

  evidence.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  promotions.sort((a, b) => (a.evidence.id < b.evidence.id ? -1 : a.evidence.id > b.evidence.id ? 1 : 0))
  return { evidence, promotions, refusals }
}
