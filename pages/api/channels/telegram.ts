import type { NextApiRequest, NextApiResponse } from 'next'
import {
  readTelegramBotToken,
  readTelegramWebhookSecret,
} from '../../../lib/secrets/platformVault'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { planJarvis, executeJarvis, isWrite } from '../../../lib/prospector/jarvisAgent'
import { redeemPairingCode, resolveChannelWs, unlinkChannel } from '../../../lib/prospector/pairing'
import { tenantFromVerifiedWorkspace } from '../../../lib/prospector/tenant'
import { createPendingAction, consumePendingAction } from '../../../lib/prospector/channelPending'
import { describeError } from '../../../lib/observability/safeError'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// Canal Telegram — adaptateur mince : il transporte du texte, le cerveau Jarvis
// (partagé avec l'extension) fait tout le reste. Gratuit, pas de fenêtre 24 h.
// Sécurité : secret de webhook + appairage obligatoire par code à usage unique.
const API = (token: string, m: string) => `https://api.telegram.org/bot${token}/${m}`

// Message générique renvoyé sur incident. Un détail interne — nom de table,
// point de terminaison fournisseur, trace applicative — n'a rien à faire dans
// une conversation Telegram : il renseigne un attaquant et n'aide pas
// l'utilisateur. Le détail part dans les journaux serveur.
const GENERIC_ERROR = "⚠️ Une erreur interne a empêché l'action. Réessaie dans un instant."

async function send(token: string, chatId: number | string, text: string, confirmId?: string) {
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }
  // `callback_data` ne contient JAMAIS l'action, l'espace ou un paramètre : un
  // identifiant opaque, et rien d'autre. Le serveur retrouve le reste seul.
  if (confirmId) {
    body.reply_markup = { inline_keyboard: [[
      { text: '✅ Confirmer', callback_data: `confirm:${confirmId}` },
      { text: '✖️ Annuler', callback_data: `cancel:${confirmId}` },
    ]] }
  }
  try { await fetch(API(token, 'sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } catch { /* best-effort */ }
}

const HELP = `<b>Jarvis · Prospector</b>
Envoie-moi une directive en langage naturel :
• « où en est Redsen ? »
• « mes chiffres »
• « ajoute Redsen avec les contacts »
• « mets Séverine Gabay en chaud »
• « ajoute Redsen à la liste ESN »
• « note : rappeler Redsen en janvier »

Commandes : /start · /aide · /delier`

// Traite une mise à jour Telegram de bout en bout (avant de répondre au webhook).
async function handleUpdate(u: any, token: string): Promise<void> {
  // ── Clic sur un bouton (confirmation d'écriture) ──
  //
  // ⚠️ LE BOUTON NE PORTE QU'UN IDENTIFIANT DE CONFIRMATION (lot SEC-TG).
  // Il portait « ok » / « no », et l'action était retrouvée par le chat : un
  // bouton d'un message antérieur confirmait donc l'action en attente du
  // moment, quelle qu'elle soit. La consommation est désormais liée à un nonce
  // précis ET au chat qui l'a reçu, en une seule instruction atomique.
  if (u?.callback_query) {
    const cq = u.callback_query
    const chatId = cq.message?.chat?.id
    if (!chatId) return
    const chatKey = `tg:${chatId}`
    try { await fetch(API(token, 'answerCallbackQuery'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: cq.id }) }) } catch {}

    const raw = String(cq.data || '')
    const m = raw.match(/^(confirm|cancel):([0-9a-f]{32})$/)
    // Forme inconnue — ancien bouton « ok »/« no », ou donnée trafiquée.
    if (!m) { await send(token, chatId, 'Ce bouton n\'est plus valide. Refais ta demande.'); return }
    const [, verb, cid] = m

    // Consommation ATOMIQUE, liée au chat. Confirmation et annulation
    // consomment de la même façon : une course entre les deux ne peut donc
    // avoir qu'UNE issue, et l'action ne peut pas être exécutée deux fois.
    const pending = await consumePendingAction(cid, chatKey)
    if (!pending) { await send(token, chatId, 'Cette demande a expiré ou a déjà été traitée.'); return }
    if (verb === 'cancel') { await send(token, chatId, 'Annulé.'); return }

    // ⚠️ REVALIDATION DU LIEN AU MOMENT DE L'EXÉCUTION. L'attente porte
    // l'espace qui l'a CRÉÉE ; entre-temps le chat a pu être délié, ré-appairé
    // ailleurs, ou l'espace suspendu. Une confirmation ne survit à aucun de ces
    // changements de propriétaire.
    const ws = await resolveChannelWs(chatKey)
    if (!ws || ws !== pending.ws) { await send(token, chatId, 'Cette demande n\'est plus valide pour ce canal.'); return }
    const tenant = await tenantFromVerifiedWorkspace(ws)
    if (!tenant) { await send(token, chatId, 'Espace client indéterminé : demande refusée.'); return }

    await send(token, chatId, await executeJarvis(tenant, pending.action, tenant.id, pending.url || ''))
    return
  }

  const msg = u?.message
  const chatId = msg?.chat?.id
  if (!chatId) return
  const chatKey = `tg:${chatId}`
  const text = String(msg.text || '').trim()
  const who = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || ''

  if (!text) { await send(token, chatId, "Envoie-moi du texte 🙂 (les messages vocaux arriveront bientôt)."); return }

  // ── Commandes ──
  if (/^\/start/.test(text)) {
    const ws = await resolveChannelWs(chatKey)
    await send(token, chatId, ws
      ? `Déjà connecté à ton espace Prospector ✅\n\n${HELP}`
      : `Bienvenue 👋\nPour connecter ce chat à ton espace Prospector, ouvre <b>Admin → Canaux mobiles</b>, génère un code d'appairage et envoie-le-moi ici.`)
    return
  }
  if (/^\/aide|^\/help/.test(text)) { await send(token, chatId, HELP); return }
  // Déliaison par le chat LUI-MÊME : `chatKey` vient de la charge utile
  // Telegram, authentifiée par le secret du webhook, jamais d'un paramètre
  // fourni par un utilisateur. L'espace propriétaire est donc résolu depuis le
  // lien existant — c'est ce que `unlinkChannel` exige depuis SEC-0b, et cela
  // ne change rien au comportement : un chat ne peut délier que lui-même.
  if (/^\/delier/.test(text)) {
    const owner = await resolveChannelWs(chatKey)
    if (owner) await unlinkChannel(chatKey, owner)
    await send(token, chatId, 'Ce chat est délié de Prospector. Envoie un nouveau code pour reconnecter.'); return
  }

  // ── Appairage : une suite de chiffres est TOUJOURS traitée comme une
  // tentative de code, quelle que soit sa longueur. La longueur exacte est
  // décidée par `redeemPairingCode` — un seul endroit — et une tentative au
  // mauvais format compte comme un échec, sans quoi le quota se contournerait
  // en variant la longueur.
  //
  // ⚠️ MESSAGE UNIQUE, DÉLIBÉRÉ. Code inconnu, expiré, déjà consommé, espace
  // suspendu ou quota épuisé rendent tous la MÊME réponse : rien ne doit
  // apprendre à un attaquant qu'un code existe, ni qu'il a été bloqué.
  if (/^\d{4,12}$/.test(text)) {
    const ws = await redeemPairingCode(text, chatKey, who)
    await send(token, chatId, ws
      ? `✅ Connecté à ton espace Prospector.\n\n${HELP}`
      : '❌ Code invalide ou expiré. Génère-en un nouveau dans Admin → Canaux mobiles.')
    return
  }

  // ── Toute autre demande : appairage obligatoire ──
  const ws = await resolveChannelWs(chatKey)
  if (!ws) { await send(token, chatId, "Ce chat n'est pas encore connecté. Génère un code dans <b>Admin → Canaux mobiles</b> et envoie-le ici."); return }

  // MT-0 — l'espace vient de l'appairage du canal, déjà vérifié ci-dessus.
  const tenant = await tenantFromVerifiedWorkspace(ws)
  if (!tenant) { await send(token, chatId, 'Espace client indéterminé : demande refusée.'); return }

  // ── Cerveau Jarvis ──
  const plan = await planJarvis(tenant, text, { channel: 'telegram' })
  if (plan.action && isWrite(plan.action)) {
    // Écriture → confirmation par bouton. L'action reste CÔTÉ SERVEUR : le
    // bouton ne transporte que l'identifiant de confirmation.
    const cid = await createPendingAction(chatKey, tenant.id, plan.action)
    if (!cid) { await send(token, chatId, GENERIC_ERROR); return }
    await send(token, chatId, `${plan.reply}\n\n<i>Confirmer cette action ?</i>`, cid)
    return
  }
  if (plan.action) {
    const out = await executeJarvis(tenant, plan.action, ws)
    await send(token, chatId, plan.reply ? `${plan.reply}\n\n${out}` : out)
    return
  }
  await send(token, chatId, plan.reply || '…')
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const [tokenRead, secretRead] = await Promise.all([
  readTelegramBotToken(),
  readTelegramWebhookSecret(),
])

  // ── PORTE D'ENTRÉE EXTERNE : FERMÉE PAR DÉFAUT (lot SEC-TG) ───────────────
  //
  // ⚠️ FAIL-OPEN CORRIGÉ. La vérification était `if (secret && header !==
  // secret)`. Un `TELEGRAM_WEBHOOK_SECRET` ABSENT faisait donc SAUTER le
  // contrôle : n'importe qui connaissant l'URL pouvait poster une mise à jour
  // Telegram forgée, se faire passer pour un chat appairé, et déclencher des
  // actions dans l'espace de ce chat. Une configuration incomplète ne doit
  // jamais valoir une autorisation.
  //
  // Les deux réglages sont désormais EXIGÉS, et le refus précède l'analyse du
  // corps, la résolution du canal et toute mutation.
const vaultUnavailable =
  (!tokenRead.ok &&
    'reason' in tokenRead &&
    (tokenRead.reason === 'storage_error' || tokenRead.reason === 'unreadable')) ||
  (!secretRead.ok &&
    'reason' in secretRead &&
    (secretRead.reason === 'storage_error' || secretRead.reason === 'unreadable'))

if (vaultUnavailable) {
  return res.status(503).json({ error: 'temporarily_unavailable' })
}

if (!tokenRead.ok || !secretRead.ok) {
  return res.status(200).json({ ok: true })
}

const token = tokenRead.value
const secret = secretRead.value

  // Comparaison de longueur constante : un `!==` sur des chaînes peut, en
  // théorie, se mesurer. Le coût est nul, l'argument n'a pas à être discuté.
  const presented = req.headers['x-telegram-bot-api-secret-token']
  if (typeof presented !== 'string' || !timingSafeEqual(presented, secret)) {
    // Jamais le secret ni l'en-tête reçu dans un journal.
    return res.status(401).json({ error: 'unauthorized' })
  }

  await hydrateKeystore()

  const u = typeof req.body === 'string' ? safeParse(req.body) : req.body
  // ⚠️ Serverless : on TRAITE D'ABORD, on répond ENSUITE. Répondre avant gèlerait
  // la fonction et le message de réponse ne partirait jamais.
  try {
    await handleUpdate(u, token)
  } catch (e: any) {
    // Le DÉTAIL reste côté serveur ; l'utilisateur reçoit un message générique.
    // Il révélait auparavant noms de tables, points de terminaison et traces
    // applicatives à quiconque savait provoquer une erreur.
    // SEC-LOG-01 — le contenu du message Telegram et le corps fournisseur
    // restent hors des journaux ; seule la nature de l'événement est conservée.
    console.error('sectg.channel_error', JSON.stringify({
      kind: u?.callback_query ? 'callback' : 'message',
      ...describeError(e, { provider: 'telegram', operation: 'webhook' }),
    }))
    const chatId = u?.message?.chat?.id || u?.callback_query?.message?.chat?.id
    if (chatId) await send(token, chatId, GENERIC_ERROR)
  }
  res.status(200).json({ ok: true })
}

/** Comparaison à temps constant sur des chaînes de longueur quelconque. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
