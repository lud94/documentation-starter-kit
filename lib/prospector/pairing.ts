// Appairage d'un canal de messagerie (Telegram, WhatsApp…) à un ESPACE Prospector.
// Un identifiant de chat ne prouve RIEN par lui-même : l'utilisateur doit d'abord
// générer un code à usage unique dans l'app, puis l'envoyer au bot. Sans ce lien,
// le bot refuse toute demande.
import {
  listItems, getItem, upsertItem, deleteItem, claimItem, insertItemIfAbsent, deleteExpired,
} from '../supabase/store'
import { tenantFromVerifiedWorkspace } from './tenant'

const NS = '_channels'          // espace technique (hors données client)
const KIND_CODE = 'paircode'    // codes en attente
const KIND_LINK = 'pairlink'    // liens établis : chatKey → workspace
const KIND_SLOT = 'pairslot'    // jetons de tentative par chat et par fenêtre
const KIND_ACTIVE = 'pairactive' // titulaire : UN code actif par espace, cle = l'espace
const TTL_MS = 15 * 60 * 1000   // code valable 15 minutes

/** Échecs tolérés par chat, puis refus uniforme jusqu'à la fin de la fenêtre. */
export const MAX_FAILURES = 5
export const FAILURE_WINDOW_MS = 15 * 60 * 1000
/** Longueur du code. Voir `pairingCode()` pour l'arbitrage. */
export const CODE_DIGITS = 8

export interface PairLink { id: string; ws: string; label?: string; at: number }

/**
 * Code d'appairage — secret à usage unique, à durée de vie courte.
 *
 * ── ENTROPIE (lots SEC-0c puis SEC-0d) ──────────────────────────────────────
 * SEC-0c a remplacé `Math.random()` : le xorshift128+ de V8 laisse reconstituer
 * son état à partir de quelques sorties, et n'importe quel client peut en
 * produire autant qu'il veut en générant des codes dans SON espace. La
 * PRÉDICTION est fermée par `crypto.getRandomValues`.
 *
 * Restait l'ÉPUISEMENT. À six chiffres, un attaquant disposant de 10 000 chats
 * et de cinq essais chacun couvre 5 × 10⁴ codes sur 10⁶ — environ 5 % de
 * chances par fenêtre, ce qui n'est pas un risque acceptable pour une prise de
 * contrôle d'espace. À huit chiffres, la même attaque tombe sous 0,05 %, et
 * chaque chiffre ajouté divise encore par dix. Le coût pour l'utilisateur est
 * de deux caractères saisis une seule fois, à l'appairage.
 *
 * Tirage uniforme par REJET : `% 90000000` sur un entier 32 bits favoriserait
 * légèrement les premiers codes. Le biais serait minuscule, mais il n'y a
 * aucune raison de l'accepter dans un secret.
 */
export function pairingCode(): string {
  const span = 9 * 10 ** (CODE_DIGITS - 1)
  const floor = 10 ** (CODE_DIGITS - 1)
  const buf = new Uint32Array(1)
  const LIMIT = Math.floor(0x1_0000_0000 / span) * span
  let v: number
  do { crypto.getRandomValues(buf); v = buf[0] } while (v >= LIMIT)
  return String(floor + (v % span))
}

/**
 * Génère un code d'appairage et en fait le SEUL code actif de l'espace.
 *
 * ── DÉFAUT A CORRIGÉ : plus jamais d'UPSERT (lot SEC-0f) ────────────────────
 * La version précédente posait le code par `upsertItem`. Sur une collision —
 * improbable à 10⁸, mais pas impossible — elle ÉCRASAIT silencieusement le code
 * d'un autre espace : la victime perdait son appairage en cours, et le nouvel
 * occupant héritait de la clé. Un secret à usage unique ne se pose jamais par
 * écrasement. `insertItemIfAbsent` échoue sur collision, et on retire.
 *
 * ── DÉFAUT B CORRIGÉ : un seul code actif par espace ────────────────────────
 * Rien ne bornait le nombre de codes valides simultanément : 100 000 appels
 * créaient 100 000 lignes vivantes dans un namespace PARTAGÉ par tous les
 * clients, et autant de cibles pour une attaque par épuisement.
 *
 * Le TITULAIRE (`pairactive`) est une ligne dont l'identifiant EST l'espace.
 * La clé primaire `(kind, id, workspace_id)` interdit donc, par construction,
 * qu'un espace en possède deux. Le code lui-même n'est qu'un POINTEUR vers
 * l'espace, et le rachat exige que le pointeur corresponde au titulaire.
 *
 * ── CE QUI EST GARANTI, ET CE QUI NE L'EST PAS ──────────────────────────────
 * GARANTI, par la clé primaire : à tout instant, AU PLUS UN code est
 * RACHETABLE pour un espace donné. Deux créations concurrentes ne peuvent pas
 * produire deux codes utilisables — le perdant du titre voit son pointeur
 * devenir inerte, et il le retire lui-même.
 *
 * NON GARANTI : l'unicité de la LIGNE `paircode` à chaque instant. Un pointeur
 * orphelin peut exister brièvement, et un créateur concurrent peut échouer
 * (`null`) plutôt que d'obtenir un code. C'est un refus, pas une faille.
 *
 * Fenêtre transitoire assumée : entre la reprise du titre et sa réémission, un
 * rachat légitime est refusé. Faux négatif de quelques millisecondes, fermé
 * dans le bon sens.
 */
export async function createPairingCode(ws: string): Promise<{ code: string; expiresInMin: number } | null> {
  const owner = (ws || '').trim()
  if (!owner) return null

  // 1. POINTEUR EXCLUSIF. Sur collision, on retire — jamais d'écrasement.
  let code = ''
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = pairingCode()
    if (await insertItemIfAbsent(KIND_CODE, candidate, { id: candidate, ws: owner, at: Date.now() }, NS)) {
      code = candidate
    }
  }
  if (!code) return null   // cinq collisions d'affilée : on refuse plutôt que d'écraser

  // 2. TITRE. `claimItem` rend l'ancien titulaire à UN SEUL appelant : celui-là
  //    est responsable d'invalider le code qu'il portait.
  const prev = await claimItem<{ id: string; code: string }>(KIND_ACTIVE, owner, NS)
  if (prev?.code) await claimItem(KIND_CODE, prev.code, NS)

  const held = await insertItemIfAbsent(
    KIND_ACTIVE, owner, { id: owner, code, at: Date.now() }, NS)
  if (!held) {
    // Un créateur concurrent tient le titre. Mon code n'est de toute façon plus
    // rachetable — le rachat compare au titulaire — mais je retire ma ligne
    // plutôt que de laisser un orphelin derrière moi.
    await claimItem(KIND_CODE, code, NS)
    return null
  }

  await sweepStale(owner)
  return { code, expiresInMin: 15 }
}

/**
 * ── DÉFAUT C CORRIGÉ : croissance du namespace partagé ──────────────────────
 *
 * Le balayage précédent ne nettoyait que la fenêtre `w-1`. Un chat actif aux
 * fenêtres 100, 102, 104 laissait derrière lui celles de 100 et 102 — pour
 * toujours. L'affirmation « au plus MAX_FAILURES lignes au repos par chat »
 * était donc FAUSSE, et je l'avais écrite.
 *
 * Les fenêtres sautées sont en nombre non borné et l'identifiant ne permet pas
 * de les énumérer : aucun balayage par clé ne peut être à la fois borné et
 * complet. La purge se fait donc par ÂGE, sur `updated_at`, qui existe déjà.
 *
 * Déclenchée à la création d'un code — une action d'administration, rare — et
 * jamais sur un chemin de lecture ni sur le chemin d'une tentative.
 */
async function sweepStale(triggeredBy: string): Promise<void> {
  const now = Date.now()
  // Deux fenêtres de marge : jamais un jeton encore utile.
  await deleteExpired(KIND_SLOT, NS, new Date(now - 2 * FAILURE_WINDOW_MS).toISOString())
  // Les pointeurs expirés ne sont plus rachetables ; ils n'ont plus à exister.
  await deleteExpired(KIND_CODE, NS, new Date(now - TTL_MS).toISOString())
  void triggeredBy
}

/**
 * ── QUOTA DE TENTATIVES — RÉSERVATION DE JETON (lot SEC-0e) ─────────────────
 *
 * DÉFAUT CORRIGÉ. La version SEC-0d comptait par lecture-modification-écriture :
 *
 *     rateLimited(chat)  → getItem(compteur)
 *     noteFailure(chat)  → getItem(compteur) → n + 1 → upsertItem
 *
 * Deux requêtes concurrentes lisaient `n = 4`, écrivaient toutes deux `5`, et
 * une tentative disparaissait. Le contrat « 5 par fenêtre » n'était donc pas
 * garanti : il se contournait par le parallélisme, exactement l'attaque contre
 * laquelle il existe. Un verrou en mémoire n'y aurait rien changé — les
 * instances serverless sont réellement distinctes.
 *
 * MÉCANISME. La fenêtre est un seau déterministe, `floor(now / WINDOW)`, et
 * chaque couple (chat, fenêtre) possède exactement MAX_FAILURES jetons nommés.
 * Une tentative doit RÉSERVER un jeton libre par `insertItemIfAbsent` : c'est
 * la clé primaire `(kind, id, workspace_id)` de `prospector_store` qui tranche,
 * dans PostgreSQL, sans lecture préalable. Deux requêtes visant le même jeton
 * ne peuvent pas gagner toutes les deux — la seconde reçoit `23505`.
 *
 * L'invariant qui en découle est exact et partagé :
 *
 *   pour un chat donné et une fenêtre donnée, AU PLUS MAX_FAILURES tentatives
 *   franchissent le quota, quel que soit le nombre d'instances applicatives.
 *
 * ── CE QUE LE CONTRAT NE DIT PAS ────────────────────────────────────────────
 * La fenêtre est FIXE, pas glissante. À cheval sur une frontière de seau, un
 * attaquant obtient donc 2 × MAX_FAILURES tentatives en peu de temps. C'est la
 * rafale de bordure classique des fenêtres fixes ; elle est bornée, connue, et
 * ne remet pas en cause l'invariant « par fenêtre ». Une fenêtre glissante
 * exigerait un compteur horodaté, donc une agrégation — et une agrégation
 * ramènerait la lecture-modification-écriture qu'on vient de supprimer.
 *
 * Un jeton est consommé par TENTATIVE, succès compris. Un appairage réussi
 * termine de toute façon la séquence : le chat est lié.
 */
function windowIndex(now: number): number {
  return Math.floor(now / FAILURE_WINDOW_MS)
}

/**
 * Réserve un jeton de tentative. `false` ⇒ quota épuisé pour cette fenêtre.
 *
 * Les jetons sont essayés dans l'ordre : sous contention, les perdants
 * progressent vers le suivant, et au plus MAX_FAILURES appelants en obtiennent
 * un. Le coût maximal est de MAX_FAILURES insertions — borné, et sur un chemin
 * qui n'est emprunté que par des tentatives d'appairage.
 */
async function claimAttemptSlot(chatKey: string): Promise<boolean> {
  const w = windowIndex(Date.now())
  for (let i = 0; i < MAX_FAILURES; i++) {
    const got = await insertItemIfAbsent(
      KIND_SLOT, `${chatKey}:${w}:${i}`, { id: `${chatKey}:${w}:${i}`, at: Date.now() }, NS)
    if (got) {
      // Le premier arrivant de la fenêtre balaie celle d'avant : nettoyage
      // paresseux, borné à MAX_FAILURES suppressions, sans tâche planifiée.
      // Sans lui, chaque chat laisserait une traînée de lignes à chaque fenêtre.
      if (i === 0) await sweepWindow(chatKey, w - 1)
      return true
    }
  }
  return false
}

async function sweepWindow(chatKey: string, w: number): Promise<void> {
  for (let i = 0; i < MAX_FAILURES; i++) {
    await deleteItem(KIND_SLOT, `${chatKey}:${w}:${i}`, NS)
  }
}

/**
 * Consomme un code et crée le lien durable chatKey → espace.
 *
 * ── USAGE UNIQUE RÉEL (lot SEC-0d) ──────────────────────────────────────────
 * La version précédente faisait `listItems` → `find` → `deleteItem` : un
 * check-then-act. Deux requêtes concurrentes présentant le MÊME code lisaient
 * toutes deux la ligne avant que l'une ne la supprime, et toutes deux
 * appairaient leur chat. Sur du serverless multi-instance, ce n'est pas
 * théorique. `claimItem` remplace les trois étapes par un seul
 * `DELETE … RETURNING` : le gagnant est celui qui REÇOIT la ligne.
 *
 * ── AUCUN ORACLE ─────────────────────────────────────────────────────────────
 * Tous les refus — format invalide, code inconnu, code expiré, quota épuisé,
 * espace suspendu ou supprimé — rendent `null`. L'appelant émet un message
 * unique. Rien ne distingue « ce code n'existe pas » de « ce code existe mais
 * appartient à un espace suspendu ».
 *
 * Un code EXPIRÉ est tout de même consommé : il a été présenté, il ne doit pas
 * pouvoir l'être à nouveau.
 */
export async function redeemPairingCode(code: string, chatKey: string, label?: string): Promise<string | null> {
  const c = (code || '').trim()
  const key = (chatKey || '').trim()
  if (!key) return null

  // Le jeton de tentative est réservé AVANT toute lecture de code. Un chat
  // saturé n'apprend donc plus rien du tout — le code n'est même pas touché,
  // et le vrai code d'un tiers reste intact et utilisable par son destinataire.
  if (!(await claimAttemptSlot(key))) return null

  if (!new RegExp(`^\\d{${CODE_DIGITS}}$`).test(c)) return null

  // Réclamation atomique : au plus UNE requête obtient ce code.
  const hit = await claimItem<{ id: string; ws: string; at: number }>(KIND_CODE, c, NS)
  if (!hit) return null
  if (Date.now() - (hit.at || 0) > TTL_MS) return null

  // Le pointeur ne suffit pas : il doit être CELUI que l'espace tient
  // actuellement. C'est cette comparaison qui rend stricte la garantie « au plus
  // un code rachetable par espace » — un pointeur orphelin, laissé par une
  // création concurrente perdante, est inerte. Le titre est consommé avec le
  // code : l'espace n'a plus de code actif tant qu'il n'en génère pas un autre.
  const active = await getItem<{ id: string; code: string }>(KIND_ACTIVE, hit.ws, NS)
  if (!active || active.code !== c) return null
  await claimItem(KIND_ACTIVE, hit.ws, NS)

  // L'espace doit être ENCORE utilisable — même exigence que les trois racines
  // de confiance depuis SEC-0c. Appairer un chat à un espace suspendu ou
  // supprimé fabriquerait une racine de confiance périmée dès sa naissance.
  const tenant = await tenantFromVerifiedWorkspace(hit.ws)
  if (!tenant) return null

  await upsertItem(KIND_LINK, key, { id: key, ws: tenant.id, label, at: Date.now() }, NS)
  return tenant.id
}

export async function resolveChannelWs(chatKey: string): Promise<string | null> {
  const links = await listItems<PairLink>(KIND_LINK, NS)
  return links.find((x) => x.id === chatKey)?.ws || null
}

/**
 * Délie un canal — UNIQUEMENT si l'espace appelant en est propriétaire.
 *
 * ⚠️ DÉFAUT CORRIGÉ (lot SEC-0b). La signature précédente ne prenait que
 * `chatKey` et supprimait sans rien vérifier. Les liens vivent dans un espace
 * TECHNIQUE PARTAGÉ (`_channels`) : le cloisonnement par `workspace_id` du
 * magasin ne s'applique donc pas ici, et c'est le champ `ws` de la ligne qui
 * porte seul la propriété. Un client authentifié qui devinait un `chatKey` —
 * un identifiant de conversation Telegram est numérique, donc énumérable —
 * pouvait délier le canal mobile d'un AUTRE espace. Destructif et silencieux.
 *
 * Rend `false` quand le lien n'existe pas ET quand il appartient à autrui : les
 * deux cas sont volontairement indiscernables, sinon la réponse dirait à
 * l'appelant qu'un canal existe ailleurs.
 */
export async function unlinkChannel(chatKey: string, ws: string): Promise<boolean> {
  const owner = (ws || '').trim()
  if (!owner || !chatKey) return false
  const links = await listItems<PairLink>(KIND_LINK, NS)
  const link = links.find((x) => x.id === chatKey)
  if (!link || link.ws !== owner) return false
  await deleteItem(KIND_LINK, chatKey, NS)
  return true
}

// Liste des canaux appairés à un espace (pour l'Admin).
export async function listChannelsFor(ws: string): Promise<PairLink[]> {
  const links = await listItems<PairLink>(KIND_LINK, NS)
  return links.filter((x) => x.ws === ws)
}
