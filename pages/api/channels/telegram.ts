import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore, getKey } from '../../../lib/prospector/keystore'
import { planJarvis, executeJarvis, isWrite } from '../../../lib/prospector/jarvisAgent'
import { redeemPairingCode, resolveChannelWs, unlinkChannel } from '../../../lib/prospector/pairing'
import { tenantFromVerifiedWorkspace } from '../../../lib/prospector/tenant'
import { listItems, upsertItem, deleteItem } from '../../../lib/supabase/store'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

// Canal Telegram — adaptateur mince : il transporte du texte, le cerveau Jarvis
// (partagé avec l'extension) fait tout le reste. Gratuit, pas de fenêtre 24 h.
// Sécurité : secret de webhook + appairage obligatoire par code à usage unique.
const API = (token: string, m: string) => `https://api.telegram.org/bot${token}/${m}`
const PENDING_NS = '_channels'
const PENDING_KIND = 'tgpending' // action en attente de confirmation, par chat

async function send(token: string, chatId: number | string, text: string, buttons?: boolean) {
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }
  if (buttons) body.reply_markup = { inline_keyboard: [[{ text: '✅ Confirmer', callback_data: 'ok' }, { text: '✖️ Annuler', callback_data: 'no' }]] }
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
  if (u?.callback_query) {
    const cq = u.callback_query
    const chatId = cq.message?.chat?.id
    if (!chatId) return
    const chatKey = `tg:${chatId}`
    try { await fetch(API(token, 'answerCallbackQuery'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: cq.id }) }) } catch {}
    const ws = await resolveChannelWs(chatKey)
    if (!ws) return
    const pendings = await listItems<any>(PENDING_KIND, PENDING_NS)
    const p = pendings.find((x) => x.id === chatKey)
    await deleteItem(PENDING_KIND, chatKey, PENDING_NS)
    if (cq.data === 'ok' && p?.action) {
      const tenant = tenantFromVerifiedWorkspace(ws)
      if (!tenant) return
      const out = await executeJarvis(tenant, p.action, ws, p.url || '')
      await send(token, chatId, out)
    } else {
      await send(token, chatId, 'Annulé.')
    }
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
      : `Bienvenue 👋\nPour connecter ce chat à ton espace Prospector, ouvre <b>Admin → Canaux mobiles</b>, génère un code à 6 chiffres et envoie-le-moi ici.`)
    return
  }
  if (/^\/aide|^\/help/.test(text)) { await send(token, chatId, HELP); return }
  if (/^\/delier/.test(text)) { await unlinkChannel(chatKey); await send(token, chatId, 'Ce chat est délié de Prospector. Envoie un nouveau code pour reconnecter.'); return }

  // ── Appairage : un code à 6 chiffres ──
  if (/^\d{6}$/.test(text)) {
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
  const tenant = tenantFromVerifiedWorkspace(ws)
  if (!tenant) { await send(token, chatId, 'Espace client indéterminé : demande refusée.'); return }

  // ── Cerveau Jarvis ──
  const plan = await planJarvis(tenant, text, { channel: 'telegram' })
  if (plan.action && isWrite(plan.action)) {
    // Écriture → confirmation par bouton (comme dans l'app).
    await upsertItem(PENDING_KIND, chatKey, { id: chatKey, action: plan.action, at: Date.now() }, PENDING_NS)
    await send(token, chatId, `${plan.reply}\n\n<i>Confirmer cette action ?</i>`, true)
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
  await hydrateKeystore()
  const token = getKey('TELEGRAM_BOT_TOKEN')
  if (!token) return res.status(200).json({ ok: true }) // canal non configuré : on ignore

  // Anti-spoofing : Telegram renvoie le secret défini au setWebhook.
  const secret = getKey('TELEGRAM_WEBHOOK_SECRET')
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).json({ error: 'bad secret' })

  const u = typeof req.body === 'string' ? safeParse(req.body) : req.body
  // ⚠️ Serverless : on TRAITE D'ABORD, on répond ENSUITE. Répondre avant gèlerait
  // la fonction et le message de réponse ne partirait jamais.
  try {
    await handleUpdate(u, token)
  } catch (e: any) {
    // On tente d'informer l'utilisateur plutôt que de rester muet.
    const chatId = u?.message?.chat?.id || u?.callback_query?.message?.chat?.id
    if (chatId) await send(token, chatId, `⚠️ Erreur : ${String(e?.message || e).slice(0, 200)}`)
  }
  res.status(200).json({ ok: true })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
