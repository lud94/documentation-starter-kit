import { useEffect, useState } from 'react'
import type { Lead } from '../types/prospector'

// « Explorer avec MON IA » — ouvre la question dans l'abonnement de l'utilisateur
// (Claude Pro / ChatGPT Plus / Perplexity), au lieu de consommer les tokens API.
// Le CONTEXTE vient de Prospector (prompt pré-rempli) ; le calcul vient de son abo.
// La réponse peut être recollée ici pour rester dans la fiche.

const TARGETS: { key: string; label: string; url: (q: string) => string; hint: string }[] = [
  { key: 'claude', label: 'Claude', url: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}`, hint: 'claude.ai' },
  { key: 'chatgpt', label: 'ChatGPT', url: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`, hint: 'chatgpt.com' },
  { key: 'perplexity', label: 'Perplexity', url: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`, hint: 'perplexity.ai' },
  { key: 'google', label: 'Google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`, hint: 'recherche simple' },
]

// Angles de recherche prêts à l'emploi, contextualisés par le lead.
// maskPii : si l'anonymisation est active, le NOM de la personne ne quitte pas
// Prospector — on envoie son rôle à la place. La société (donnée publique) reste,
// sinon la recherche perdrait tout intérêt.
function prompts(lead: Lead, maskPii = false): { key: string; label: string; text: string }[] {
  const realPerson = `${lead.firstName} ${lead.lastName}`.trim()
  const person = maskPii ? '' : realPerson
  const co = lead.company
  const ctx = [lead.naf && `NAF ${lead.naf}`, lead.city, lead.effectif && `${lead.effectif} salariés`, lead.siren && `SIREN ${lead.siren}`].filter(Boolean).join(', ')
  return [
    { key: 'company', label: "L'entreprise", text: `Fais-moi une synthèse commerciale de l'entreprise française ${co}${ctx ? ` (${ctx})` : ''} : activité réelle, offres, clients types, positionnement, actualité des 12 derniers mois. Cite tes sources et dis ce que tu ne trouves pas.` },
    { key: 'competitors', label: 'Concurrents', text: `Quels sont les principaux concurrents français de ${co}${lead.naf ? ` (secteur ${lead.naf})` : ''} ? Pour chacun : positionnement et taille approximative. Cite tes sources.` },
    { key: 'news', label: 'Actualité', text: `Quelle est l'actualité récente (18 derniers mois) de ${co} : levée de fonds, rachat, nomination, ouverture, lancement produit ? Donne la date et la source de chaque élément.` },
    ...(realPerson ? [{
      key: 'person', label: 'La personne',
      text: person
        ? `Que sait-on publiquement et professionnellement de ${person}, ${lead.title || 'dirigeant'} chez ${co} ? Parcours, prises de parole, interviews, actualité. Uniquement des informations professionnelles sourcées ; ignore les homonymes qui ne sont pas liés à ${co}.`
        : `Qui occupe le poste de ${lead.title || 'dirigeant'} chez ${co} ? Que sait-on publiquement de son parcours, ses prises de parole et son actualité professionnelle ? Informations sourcées uniquement.`,
    }] : []),
    { key: 'angle', label: "Angle d'approche", text: `Je prospecte ${co}${person ? ` (contact : ${person}, ${lead.title})` : realPerson ? ` (mon contact y est ${lead.title || 'dirigeant'})` : ''}. Sur la base d'informations publiques récentes, propose-moi 3 angles d'accroche crédibles et factuels pour un premier message LinkedIn, en citant le fait sur lequel chacun s'appuie. Pas de flatterie ni de jargon commercial.` },
  ]
}

export default function AskExternalAI({ lead, onSaveNotes }: { lead: Lead; onSaveNotes: (text: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [angle, setAngle] = useState('company')
  const [target, setTarget] = useState('claude')
  const [copied, setCopied] = useState(false)
  const [paste, setPaste] = useState('')
  const [saving, setSaving] = useState(false)
  // Politique : autorisation par espace + anonymisation des noms si activée.
  const [policy, setPolicy] = useState<{ allowed: boolean; maskPii: boolean } | null>(null)
  useEffect(() => { fetch('/api/config/external-ai').then((r) => r.json()).then(setPolicy).catch(() => setPolicy({ allowed: true, maskPii: false })) }, [])

  const list = prompts(lead, !!policy?.maskPii)
  const text = list.find((p) => p.key === angle)?.text || ''
  const tgt = TARGETS.find((t) => t.key === target)!

  const go = () => window.open(tgt.url(text), '_blank', 'noopener')
  const copy = () => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  const save = async () => { if (!paste.trim()) return; setSaving(true); await onSaveNotes(paste.trim()); setPaste(''); setSaving(false) }

  // Espace dont la politique interdit l'envoi de contexte à une IA externe.
  if (policy && !policy.allowed) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
          IA externe désactivée
        </div>
        <p className="text-xs text-gray-400">L'envoi de contexte vers une IA externe est désactivé pour cet espace. Utilise Jarvis (recherche intégrée).</p>
      </div>
    )
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wide">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" /></svg>
          Explorer avec mon IA
        </div>
        <button onClick={() => setOpen((v) => !v)} className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-lg hover:bg-indigo-100 mb-2">{open ? 'Fermer' : 'Ouvrir'}</button>
      </div>

      {!open ? (
        <p className="text-xs text-gray-400">Ouvre une question pré-remplie dans <b>ton</b> abonnement (Claude, ChatGPT, Perplexity). Aucun token Prospector consommé.</p>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-[11px] font-semibold text-gray-500 mb-1.5">Angle</p>
            <div className="flex flex-wrap gap-1.5">
              {list.map((p) => (
                <button key={p.key} onClick={() => setAngle(p.key)} className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${angle === p.key ? 'gradient-brand text-white border-transparent' : 'text-gray-500 bg-gray-50 border-gray-200 hover:border-indigo-300'}`}>{p.label}</button>
              ))}
            </div>
          </div>

          <div className="bg-gray-50 rounded-xl p-2.5 border border-gray-100">
            <p className="text-[11px] text-gray-600 leading-relaxed">{text}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-400">
              {TARGETS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <button onClick={go} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90">Ouvrir dans {tgt.label} →</button>
            <button onClick={copy} className="text-xs font-medium text-gray-600 border border-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-gray-50">{copied ? '✓ Copié' : 'Copier le prompt'}</button>
          </div>

          {/* Avertissement : ces données quittent Prospector. */}
          <div className="flex items-start gap-2 bg-amber-50/60 border border-amber-100 rounded-xl p-2.5">
            <span className="text-amber-500 text-xs mt-px">⚠</span>
            <p className="text-[11px] text-amber-800 leading-relaxed">
              Ce prompt quitte Prospector vers un service tiers, sur <b>ton compte personnel</b> — il peut y être conservé et servir à leur entraînement selon tes réglages.
              {policy?.maskPii
                ? <> Anonymisation active : <b>le nom de la personne est retiré</b> (seule l'entreprise, donnée publique, est transmise).</>
                : <> Les données du lead (nom, société, SIREN) sont incluses. Active l'anonymisation dans Admin → Connexions pour masquer les noms.</>}
            </p>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-gray-500 mb-1.5">Coller la réponse <span className="font-normal text-gray-400">— pour la garder dans la fiche</span></p>
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Colle ici ce que t'a répondu ton IA…" className="w-full h-24 px-3 py-2 text-xs rounded-xl bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 resize-none" />
            <button onClick={save} disabled={saving || !paste.trim()} className="mt-1.5 text-xs font-semibold gradient-brand text-white px-3 py-1.5 rounded-lg disabled:opacity-40">{saving ? '…' : 'Enregistrer dans la fiche'}</button>
          </div>
        </div>
      )}

      {lead.researchNotes && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <p className="text-[11px] font-semibold text-gray-400 mb-1">Notes de recherche</p>
          <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">{lead.researchNotes}</p>
        </div>
      )}
    </div>
  )
}
