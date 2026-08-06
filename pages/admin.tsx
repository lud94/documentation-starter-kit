import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import type { UsageSummary, Diagnostic, Workspace, WorkspacePermissions } from '../types/prospector'
import { DEFAULT_PERMISSIONS } from '../types/prospector'
import { getUsage, getDiagnostics, getChannels, connectChannel, disconnectChannel, getLogs, getAiLogs, AI_AGENTS, type Period } from '../lib/prospector/capabilities'
import type { Channel, ChannelConfig, LogEntry, AiLog } from '../lib/prospector/capabilities'
import { ConfirmDialog } from '../components/Dialog'

type Tab = 'usage' | 'connexions' | 'canaux' | 'protocole' | 'ailogs' | 'logs' | 'diagnostic' | 'workspaces'

const USAGE_PERIODS: { key: Period; label: string }[] = [
  { key: 'week', label: 'Semaine' }, { key: 'month', label: 'Mois' }, { key: 'quarter', label: 'Trimestre' }, { key: 'year', label: 'Année' },
]
const LOG_STYLE: Record<LogEntry['level'], string> = { info: 'bg-gray-300', warn: 'bg-amber-400', error: 'bg-red-500' }

const FULL_SQL = `create table if not exists prospector_settings (key text primary key, value text, updated_at timestamptz default now());
create table if not exists prospector_leads (id text primary key, data jsonb, workspace_id text, created_at timestamptz default now());
alter table prospector_leads add column if not exists workspace_id text;
create table if not exists prospector_workspaces (id text primary key, name text not null, leads int default 0, users int default 1, plan text default 'Starter', created_at timestamptz default now());
alter table prospector_workspaces add column if not exists client_email text;
alter table prospector_workspaces add column if not exists status text default 'active';
alter table prospector_workspaces add column if not exists permissions jsonb;
alter table prospector_workspaces add column if not exists client_password_hash text;
create table if not exists prospector_pappers_cache (siren text primary key, data jsonb, created_at timestamptz default now());
create table if not exists prospector_usage (key text primary key, count int default 0, updated_at timestamptz default now());
create table if not exists prospector_store (kind text not null, id text not null, workspace_id text not null, data jsonb, updated_at timestamptz default now(), primary key (kind, id, workspace_id));
alter table prospector_settings enable row level security;
alter table prospector_store enable row level security;
alter table prospector_leads enable row level security;
alter table prospector_workspaces enable row level security;
alter table prospector_pappers_cache enable row level security;
alter table prospector_usage enable row level security;`

interface ModelRouteRow { phase: string; provider: string; model: string; requires: string; why: string; fallback?: string; ready: boolean }

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

const DOT: Record<Diagnostic['status'], string> = { ok: 'bg-emerald-500', warn: 'bg-amber-400', error: 'bg-red-500' }

export default function AdminPage() {
  const router = useRouter()
  useEffect(() => { fetch('/api/auth/me').then((r) => r.json()).then((d) => { if (d.role === 'client') router.replace('/') }).catch(() => {}) }, [router])
  const [tab, setTab] = useState<Tab>('usage')
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [usagePeriod, setUsagePeriod] = useState<Period>('month')
  const [pappersCalls, setPappersCalls] = useState<number | null>(null)
  const [budget, setBudget] = useState<{ anthropic: number; spent: number; remaining: number | null; state?: string; blocked?: boolean; reason?: string | null; degraded?: boolean } | null>(null)
  const [budgetInput, setBudgetInput] = useState('')
  const [budgetSaving, setBudgetSaving] = useState(false)
  const loadUsageMeta = () => fetch('/api/config/usage').then((r) => r.json()).then((d) => { setPappersCalls(d.pappersCalls ?? null); setBudget(d.budget ?? null); if (d.budget?.anthropic) setBudgetInput(String(d.budget.anthropic)) }).catch(() => {})
  const saveBudget = async () => {
    setBudgetSaving(true)
    await fetch('/api/config/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ANTHROPIC_BUDGET: budgetInput.trim() }) })
    await loadUsageMeta(); getUsage(usagePeriod).then(setUsage); setBudgetSaving(false)
  }
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [diags, setDiags] = useState<Diagnostic[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [wsOpen, setWsOpen] = useState(false)
  const [wsName, setWsName] = useState('')
  const [wsPlan, setWsPlan] = useState('Starter')
  const [managing, setManaging] = useState<Workspace | null>(null)
  const [deleting, setDeleting] = useState<Workspace | null>(null)
  const confirmDelete = async () => {
    if (!deleting) return
    await fetch('/api/workspaces', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: deleting.id }) })
    setDeleting(null); loadWs()
  }
  const loadWs = () => fetch('/api/workspaces').then((r) => r.json()).then((d) => setWorkspaces(d.workspaces || [])).catch(() => {})
  const createWs = async () => {
    if (!wsName.trim()) return
    await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: wsName, plan: wsPlan }) })
    setWsName(''); setWsPlan('Starter'); setWsOpen(false)
    loadWs()
  }

  useEffect(() => {
    getDiagnostics().then(setDiags)
    getLogs().then(setLogs)
    loadWs()
    getChannels().then(setChannels)
  }, [])
  useEffect(() => { getUsage(usagePeriod).then(setUsage) }, [usagePeriod])
  useEffect(() => { loadUsageMeta() }, [])

  const TABS: { key: Tab; label: string }[] = [
    { key: 'usage', label: 'Usage & coûts' },
    { key: 'connexions', label: 'Connexions' },
    { key: 'canaux', label: 'Canaux mobiles' },
    { key: 'protocole', label: 'Protocole LLM' },
    { key: 'ailogs', label: 'Logs IA' },
    { key: 'logs', label: 'Activité' },
    { key: 'diagnostic', label: 'Diagnostic' },
    { key: 'workspaces', label: 'Workspaces clients' },
  ]

  return (
    <>
      <Head><title>Prospector · Admin</title></Head>

      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
        <p className="text-gray-400 text-sm mt-0.5">Supervision de la consommation IA, des connexions et des accès clients.</p>
      </div>

      <div className="flex bg-gray-100 rounded-xl p-1 w-fit mb-5">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${tab === t.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'usage' && usage && (
        <>
          <div className="flex justify-end mb-4">
            <div className="flex bg-gray-100 rounded-xl p-1">
              {USAGE_PERIODS.map((p) => (
                <button key={p.key} onClick={() => setUsagePeriod(p.key)} className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${usagePeriod === p.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>{p.label}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            {[
              { l: 'Appels IA', v: String(usage.calls) },
              { l: 'Tokens (in)', v: fmt(usage.tokensIn) },
              { l: 'Tokens (out)', v: fmt(usage.tokensOut) },
              { l: 'Coût estimé', v: `$${usage.cost.toFixed(2)}` },
            ].map((k) => (
              <div key={k.l} className="card p-5">
                <p className="text-xs font-semibold text-gray-400 mb-1">{k.l}</p>
                <p className="text-2xl font-bold gradient-text">{k.v}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mb-3">Consommation IA <strong>réelle</strong> (cumulée), mesurée sur les tokens renvoyés par l'API — 0 tant qu'aucun appel n'a eu lieu.</p>

          {/* Budget Anthropic manuel → restant = budget − dépensé réel */}
          <div className="card p-5 mb-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-gray-700">Crédit Anthropic <span className="font-normal text-gray-400">— saisis le montant chargé sur ta clé, on décompte le coût réel</span></h2>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400">$</span>
                <input value={budgetInput} onChange={(e) => setBudgetInput(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="ex: 20" className="w-24 px-2.5 py-1.5 text-sm rounded-lg bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400" />
                <button onClick={saveBudget} disabled={budgetSaving} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 disabled:opacity-40">{budgetSaving ? '…' : 'Enregistrer'}</button>
              </div>
            </div>
            {/* Un suivi indisponible n'est PAS un crédit épuisé : les deux bloquent
                les appels, mais l'un se corrige en rechargeant, l'autre en réparant
                la base ou la configuration d'environnement. */}
            {budget?.state === 'usage_unavailable' && (
              <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                <p className="text-xs font-semibold text-amber-800">Suivi de consommation indisponible — appels IA bloqués</p>
                <p className="text-[11px] text-amber-700 mt-0.5">{budget.reason || 'Le compteur d’usage durable est illisible ou non inscriptible. Les chiffres ci-dessous ne font pas autorité.'}</p>
              </div>
            )}
            {budget?.state === 'budget_exhausted' && (
              <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2">
                <p className="text-xs font-semibold text-red-800">Crédit épuisé — appels IA bloqués</p>
                <p className="text-[11px] text-red-700 mt-0.5">Recharge la clé Anthropic, puis mets à jour le montant chargé ci-dessus.</p>
              </div>
            )}
            {budget && budget.anthropic > 0 ? (
              <>
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div><p className="text-xs text-gray-400">Chargé</p><p className="text-lg font-bold text-gray-700">${budget.anthropic.toFixed(2)}</p></div>
                  <div><p className="text-xs text-gray-400">Dépensé{budget.degraded ? ' (non fiable)' : ' (réel)'}</p><p className="text-lg font-bold text-gray-700">${budget.spent.toFixed(2)}</p></div>
                  {/* `remaining` est null quand la consommation n'a pas pu être lue.
                      Afficher 0,00 $ ferait passer une panne de suivi pour un crédit épuisé. */}
                  <div><p className="text-xs text-gray-400">Restant estimé</p>{budget.remaining === null
                    ? <p className="text-lg font-bold text-gray-400">—</p>
                    : <p className={`text-lg font-bold ${budget.remaining < budget.anthropic * 0.15 ? 'text-red-600' : 'gradient-text'}`}>${budget.remaining.toFixed(2)}</p>}</div>
                </div>
                <div className="bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div className="h-2 rounded-full gradient-brand" style={{ width: `${Math.min(100, (budget.spent / budget.anthropic) * 100)}%` }} />
                </div>
                <p className="text-[11px] text-gray-400 mt-2">Estimation basée sur les tokens réels × tarifs indicatifs. Anthropic n'exposant pas de solde, mets à jour le montant chargé quand tu recharges.</p>
              </>
            ) : (
              <p className="text-xs text-gray-400">Saisis le montant chargé sur ta clé Anthropic pour suivre le crédit restant.</p>
            )}
          </div>
          {pappersCalls !== null && (
            <div className="card p-4 mb-4 flex items-center gap-2 text-sm">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              <span className="text-gray-600">Conso Pappers <span className="text-gray-400">— appels réels facturés, hors cache</span></span>
              <span className="ml-auto font-bold text-gray-800">{pappersCalls}</span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Par agent</h2>
              <div className="space-y-2.5">
                {usage.byAgent.length === 0 && <p className="text-xs text-gray-400">Aucun appel pour l'instant.</p>}
                {usage.byAgent.map((a) => (
                  <div key={a.agent} className="flex items-center gap-3 text-sm">
                    <span className="text-gray-600 flex-1 truncate">{a.agent}</span>
                    <span className="text-xs text-gray-400">{a.calls} appels · {fmt(a.tokens)}</span>
                    <span className="text-xs font-semibold text-gray-600 w-12 text-right">${a.cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Par modèle</h2>
              <div className="space-y-2.5">
                {usage.byModel.length === 0 && <p className="text-xs text-gray-400">Aucun appel pour l'instant.</p>}
                {usage.byModel.map((m) => (
                  <div key={m.model} className="flex items-center gap-3 text-sm">
                    <span className="text-gray-600 flex-1 truncate">{m.model}</span>
                    <span className="text-xs text-gray-400">{m.calls} appels · {fmt(m.tokens)}</span>
                    <span className="text-xs font-semibold text-gray-600 w-12 text-right">${m.cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Routage économique : quel modèle pour quelle tâche */}
          <div className="card p-5 mt-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-1">Routage des modèles <span className="font-normal text-gray-400">— le bon modèle au bon endroit</span></h2>
            <p className="text-xs text-gray-400 mb-3">Opus coûte ≈ 19× Haiku. Les tâches simples utilisent donc un modèle économique. Surcharge possible via les clés indiquées (Connexions).</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[
                { t: 'Jarvis (chat, classification)', m: 'Haiku 4.5', k: 'JARVIS_MODEL', c: 'le moins cher' },
                { t: 'Plan de mission', m: 'Sonnet 5', k: 'PLAN_MODEL', c: '5× moins qu\'Opus' },
                { t: 'Enrichissement web', m: 'Sonnet 5', k: 'ENRICH_MODEL', c: 'caché 7 j' },
                { t: 'Recherche de signaux', m: 'Sonnet 5', k: 'SIGNALS_MODEL', c: 'caché 7 j' },
              ].map((r) => (
                <div key={r.t} className="bg-gray-50 rounded-xl px-3 py-2">
                  <p className="text-xs font-medium text-gray-700">{r.t}</p>
                  <p className="text-[11px] text-gray-500">{r.m} · <span className="text-gray-400">{r.c}</span></p>
                  <code className="text-[10px] text-gray-400">{r.k}</code>
                </div>
              ))}
            </div>
          </div>

          {/* Journalier — combien je dépense par jour (14 derniers jours) */}
          <div className="card p-5 mt-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Journalier <span className="font-normal text-gray-400">— dépense IA par jour (14 j)</span></h2>
            {(!usage.byDay || usage.byDay.length === 0) ? (
              <p className="text-xs text-gray-400">Aucune dépense enregistrée. Les jours apparaîtront dès le premier appel IA.</p>
            ) : (
              <div className="space-y-2">
                {usage.byDay.map((d) => {
                  const max = Math.max(...usage.byDay!.map((x) => x.cost), 0.01)
                  return (
                    <div key={d.day} className="flex items-center gap-3 text-sm">
                      <span className="text-xs text-gray-500 w-24">{d.day}</span>
                      <div className="flex-1 bg-gray-50 rounded-full h-1.5"><div className="h-1.5 rounded-full gradient-brand" style={{ width: `${(d.cost / max) * 100}%` }} /></div>
                      <span className="text-xs text-gray-400 w-16 text-right">{d.calls} appels</span>
                      <span className="text-xs font-semibold text-gray-600 w-14 text-right">${d.cost.toFixed(2)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'connexions' && (
        <ConnexionsTab channels={channels} onChange={setChannels} />
      )}

      {tab === 'canaux' && <CanauxTab />}

      {tab === 'protocole' && <ProtocoleTab />}

      {tab === 'ailogs' && <AiLogsTab />}

      {tab === 'logs' && (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700">Journal d'activité</h2>
            <button onClick={() => getLogs().then(setLogs)} className="text-xs font-medium text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors">Rafraîchir</button>
          </div>
          <div className="space-y-1">
            {logs.map((l) => (
              <div key={l.id} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
                <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${LOG_STYLE[l.level]}`} />
                <span className="text-[10px] font-semibold text-gray-400 uppercase w-16 flex-shrink-0 mt-0.5">{l.source}</span>
                <span className="text-sm text-gray-700 flex-1">{l.message}</span>
                <span className="text-xs text-gray-400 flex-shrink-0">{l.when}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'diagnostic' && (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700">Connexions & configuration</h2>
            <button onClick={() => { setTab('diagnostic'); getDiagnostics().then(setDiags) }} title="Lancer les tests de connexion (onglet Diagnostic)" className="text-xs font-medium text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors">Tester tout</button>
          </div>
          <div className="space-y-1">
            {diags.map((d) => (
              <div key={d.name} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <span className={`w-2 h-2 rounded-full ${DOT[d.status]}`} />
                <span className="text-sm text-gray-700">{d.name}</span>
                <span className="text-xs text-gray-400 ml-auto">{d.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {managing && <WorkspaceManageModal ws={managing} onClose={() => setManaging(null)} onSaved={() => { setManaging(null); loadWs() }} />}

      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setDeleting(null)} />
          <div className="relative card w-full max-w-sm p-6">
            <h2 className="text-base font-bold text-gray-900 mb-2">Supprimer l'espace ?</h2>
            <p className="text-sm text-gray-500 mb-4"><strong>{deleting.name}</strong> ({deleting.id}) sera définitivement supprimé. Cette action est irréversible.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleting(null)} className="text-sm font-medium text-gray-500 px-3 py-2 rounded-xl hover:bg-gray-50">Annuler</button>
              <button onClick={confirmDelete} className="bg-red-500 text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-red-600 transition-colors">Supprimer</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'workspaces' && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">Espaces clients</h2>
            <button onClick={() => setWsOpen((v) => !v)} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity">+ Nouveau workspace</button>
          </div>
          {wsOpen && (
            <div className="px-5 py-4 border-b border-gray-100 bg-gray-50/60 flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[160px]">
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nom du client</label>
                <input value={wsName} onChange={(e) => setWsName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createWs()} className={fieldCls} placeholder="ex: Smart.AI" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Plan</label>
                <select value={wsPlan} onChange={(e) => setWsPlan(e.target.value)} className={fieldCls}><option>Starter</option><option>Growth</option><option>Scale</option></select>
              </div>
              <button onClick={createWs} disabled={!wsName.trim()} className="gradient-brand text-white text-xs font-semibold px-4 py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">Créer l'espace</button>
              {wsName.trim() && <span className="text-[11px] text-gray-400 pb-2">ID : <code>ws_{wsName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)}</code></span>}
            </div>
          )}
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 text-left">
                {['Client', 'Leads', 'Utilisateurs', 'Plan', ''].map((h) => (
                  <th key={h} className="px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-lg gradient-brand text-white text-xs font-bold flex items-center justify-center">{w.name[0]}</span>
                      <span className="text-sm font-medium text-gray-800">{w.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-sm text-gray-600">{w.leads}</td>
                  <td className="px-5 py-3 text-sm text-gray-600">{w.users}</td>
                  <td className="px-5 py-3"><span className="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{w.plan}</span></td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => setManaging(w)} className="text-xs text-gray-400 hover:text-indigo-600">Gérer</button>
                      <button onClick={() => setDeleting(w)} className="text-xs text-gray-400 hover:text-red-500">Supprimer</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

const fieldCls = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'
const CHANNEL_ICON: Record<Channel['key'], string> = {
  linkedin: 'in', email: '@', whatsapp: 'WA',
}

interface KeyStatus { key: string; label: string; set: boolean; source: 'app' | 'env' | null }

// ── Canaux mobiles : Jarvis sur Telegram (gratuit, pour les commerciaux nomades) ──
function CanauxTab() {
  const [ready, setReady] = useState(false)
  const [botName, setBotName] = useState('')
  const [links, setLinks] = useState<{ id: string; label?: string; at: number }[]>([])
  const [token, setToken] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toUnlink, setToUnlink] = useState<{ id: string; label?: string } | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const fieldCls = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white'

  const load = () => fetch('/api/channels/pair').then((r) => r.json()).then((d) => { setReady(!!d.telegramReady); setBotName(d.botName || ''); setLinks(d.channels || []) }).catch(() => {})
  useEffect(() => { load() }, [])

  const saveToken = async () => {
    if (!token.trim()) return
    setBusy(true)
    await fetch('/api/config/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ TELEGRAM_BOT_TOKEN: token.trim() }) })
    setToken(''); await load(); setBusy(false); setMsg('Jeton enregistré. Branche maintenant le webhook.')
  }
  const setupWebhook = async () => {
    setBusy(true)
    const d = await fetch('/api/channels/telegram-setup', { method: 'POST' }).then((r) => r.json())
    setBusy(false); setMsg(d.error ? `❌ ${d.error}` : `✅ Webhook branché${d.botName ? ` sur @${d.botName}` : ''}.`)
    load()
  }
  const genCode = async () => {
    setBusy(true)
    const d = await fetch('/api/channels/pair', { method: 'POST' }).then((r) => r.json())
    setBusy(false)
    if (d.error) setMsg(`❌ ${d.error}`); else { setCode(d.code); setMsg(null) }
  }
  const unlink = async (id: string) => { await fetch('/api/channels/pair', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }); load() }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Jarvis sur Telegram <span className="font-normal text-gray-400">— piloter Prospector depuis son téléphone</span></h2>
        <p className="text-xs text-gray-400 mb-4">Gratuit et illimité (tu ne paies que les tokens IA). Idéal pour les commerciaux en déplacement : questions, directives, mises à jour de statut.</p>

        <ol className="space-y-3 text-sm">
          <li className="flex gap-3">
            <span className="w-6 h-6 rounded-lg gradient-brand text-white text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>
            <div className="flex-1">
              <p className="font-medium text-gray-700">Créer le bot</p>
              <p className="text-xs text-gray-400 mb-2">Sur Telegram, écris à <b>@BotFather</b> → <code className="bg-gray-100 px-1 rounded">/newbot</code> → il te donne un jeton.</p>
              {ready ? <span className="text-xs font-semibold text-emerald-600">✓ Jeton configuré{botName && ` · @${botName}`}</span> : (
                <div className="flex gap-2">
                  <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Coller le jeton BotFather" className={fieldCls} />
                  <button onClick={saveToken} disabled={busy || !token.trim()} className="gradient-brand text-white text-xs font-semibold px-3 py-2 rounded-xl disabled:opacity-40 flex-shrink-0">Enregistrer</button>
                </div>
              )}
            </div>
          </li>
          <li className="flex gap-3">
            <span className="w-6 h-6 rounded-lg gradient-brand text-white text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>
            <div className="flex-1">
              <p className="font-medium text-gray-700">Brancher le webhook</p>
              <p className="text-xs text-gray-400 mb-2">Connecte le bot à cette instance (un clic, secret généré automatiquement).</p>
              <button onClick={setupWebhook} disabled={busy || !ready} className="text-xs font-semibold text-gray-600 border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 disabled:opacity-40">Brancher le webhook</button>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="w-6 h-6 rounded-lg gradient-brand text-white text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>
            <div className="flex-1">
              <p className="font-medium text-gray-700">Connecter un téléphone</p>
              <p className="text-xs text-gray-400 mb-2">Génère un code, puis envoie-le au bot depuis Telegram. Le chat sera lié à <b>cet espace</b>.</p>
              <button onClick={genCode} disabled={busy || !ready} className="gradient-brand text-white text-xs font-semibold px-3 py-2 rounded-xl disabled:opacity-40">Générer un code d'appairage</button>
              {code && (
                <div className="mt-3 bg-indigo-50 border border-indigo-100 rounded-xl p-3 text-center">
                  <p className="text-[11px] text-indigo-500 font-semibold mb-1">Envoie ce code au bot{botName && ` @${botName}`} (valable 15 min)</p>
                  <p className="text-3xl font-bold gradient-text tracking-[0.3em]">{code}</p>
                </div>
              )}
            </div>
          </li>
        </ol>
        {msg && <p className="text-xs mt-3 text-gray-600">{msg}</p>}
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Appareils connectés à cet espace</h2>
        {links.length === 0 ? <p className="text-xs text-gray-400">Aucun appareil connecté.</p> : (
          <div className="space-y-2">
            {links.map((l) => (
              <div key={l.id} className="flex items-center gap-3 bg-gray-50 rounded-xl px-3 py-2">
                <span className="text-sm">💬</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-700 truncate">{l.label || l.id}</p>
                  <p className="text-[11px] text-gray-400">Telegram · connecté le {new Date(l.at).toLocaleDateString('fr-FR')}</p>
                </div>
                <button onClick={() => setToUnlink(l)} title="Délier cet appareil" className="text-gray-300 hover:text-red-500 flex-shrink-0">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-gray-400 mt-3">Un chat non appairé ne peut rien faire : le bot refuse toute demande tant que le code n'a pas été validé.</p>
        {ready && (
          <button onClick={() => setResetOpen(true)} className="text-[11px] font-medium text-red-500 hover:underline mt-3">Réinitialiser le bot Telegram (changer de bot)</button>
        )}
      </div>

      {toUnlink && (
        <ConfirmDialog
          title="Délier cet appareil"
          message={`« ${toUnlink.label || toUnlink.id} » ne pourra plus piloter cet espace. Un nouveau code sera nécessaire pour le reconnecter.`}
          confirmLabel="Délier" danger
          onConfirm={async () => { await unlink(toUnlink.id); setToUnlink(null) }}
          onCancel={() => setToUnlink(null)}
        />
      )}
      {resetOpen && (
        <ConfirmDialog
          title="Réinitialiser le bot Telegram"
          message="Le jeton sera effacé et tous les appareils déliés. Tu pourras ensuite configurer un autre bot."
          confirmLabel="Réinitialiser" danger
          onConfirm={async () => {
            setResetOpen(false); setBusy(true)
            for (const l of links) await fetch('/api/channels/pair', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: l.id }) })
            await fetch('/api/config/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRET: '', TELEGRAM_BOT_NAME: '' }) })
            setCode(null); await load(); setBusy(false); setMsg('Bot réinitialisé.')
          }}
          onCancel={() => setResetOpen(false)}
        />
      )}
    </div>
  )
}

function ConnexionsTab({ channels, onChange }: { channels: Channel[]; onChange: (c: Channel[]) => void }) {
  const [drafts, setDrafts] = useState<Record<string, ChannelConfig>>({})
  const [linking, setLinking] = useState<string | null>(null)
  const [linkMsg, setLinkMsg] = useState<Record<string, string>>({})
  const [keys, setKeys] = useState<KeyStatus[]>([])
  const [sigMode, setSigMode] = useState<string>('')
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [savingKeys, setSavingKeys] = useState(false)
  const [keySaved, setKeySaved] = useState(false)

  const [persistence, setPersistence] = useState('')
  const [diag, setDiag] = useState<string>('')
  const [dbRows, setDbRows] = useState<{ table: string; ok: boolean; error: string | null }[] | null>(null)
  const [showSql, setShowSql] = useState(false)
  const checkDb = async () => {
    setDbRows(null)
    try { const d = await fetch('/api/config/db-check').then((r) => r.json()); setDbRows(d.results || []) }
    catch { setDbRows([]) }
  }
  const testPersistence = async () => {
    setDiag('Test en cours…')
    try {
      const d = await fetch('/api/config/persistence-test').then((r) => r.json())
      if (d.writeOk && d.readOk) setDiag('✓ Écriture + lecture Supabase OK — la persistance fonctionne.')
      else setDiag(`URL: ${d.urlPresent ? 'ok' : 'MANQUANTE'} · Clé: ${d.keyPresent ? 'ok' : 'MANQUANTE'} · ${d.error || 'échec inconnu'}`)
    } catch (e: any) { setDiag('Erreur réseau : ' + (e.message || '')) }
  }
  const loadStatus = () => fetch('/api/config/status').then((r) => r.json()).then((d) => { setKeys(d.keys || []); setSigMode(d.signalsMode || ''); setPersistence(d.persistence || '') }).catch(() => {})
  useEffect(() => { loadStatus() }, [])

  // ── MFA ──
  const [mfaOn, setMfaOn] = useState(false)
  const [mfaSecret, setMfaSecret] = useState('')
  const [mfaUri, setMfaUri] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMsg, setMfaMsg] = useState('')
  const loadMfa = () => fetch('/api/auth/status').then((r) => r.json()).then((d) => setMfaOn(!!d.mfa)).catch(() => {})
  useEffect(() => { loadMfa() }, [])

  const startMfa = async () => {
    setMfaMsg('')
    const d = await fetch('/api/auth/mfa/setup', { method: 'POST' }).then((r) => r.json())
    setMfaSecret(d.secret || ''); setMfaUri(d.uri || '')
  }
  const confirmMfa = async () => {
    const res = await fetch('/api/auth/mfa/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: mfaCode }) })
    const d = await res.json()
    if (res.ok) { setMfaSecret(''); setMfaUri(''); setMfaCode(''); setMfaMsg('✓ MFA activée'); loadMfa() }
    else setMfaMsg(d.error || 'Échec')
  }
  const disableMfa = async () => { await fetch('/api/auth/mfa/disable', { method: 'POST' }); setMfaMsg('MFA désactivée'); loadMfa() }

  const saveKeys = async () => {
    const patch: Record<string, string> = {}
    Object.entries(keyDrafts).forEach(([k, v]) => { if (v.trim()) patch[k] = v.trim() })
    if (Object.keys(patch).length === 0) return
    setSavingKeys(true)
    try {
      await fetch('/api/config/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      setKeyDrafts({}); setKeySaved(true); setTimeout(() => setKeySaved(false), 2000)
      await loadStatus()
    } finally { setSavingKeys(false) }
  }

  const setDraft = (key: string, patch: ChannelConfig) => setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }))
  const cfg = (c: Channel): ChannelConfig => ({ ...c.config, ...drafts[c.key] })

  const connect = async (c: Channel) => onChange(await connectChannel(c.key, cfg(c)))
  const disconnect = async (c: Channel) => onChange(await disconnectChannel(c.key))

  // Lance la connexion réelle via Unipile (hosted auth). Ouvre le lien si configuré.
  const linkUnipile = async (c: Channel) => {
    setLinking(c.key); setLinkMsg((m) => ({ ...m, [c.key]: '' }))
    try {
      const res = await fetch(`/api/unipile/connect?provider=${c.key}`)
      const d = await res.json()
      if (d.url) window.open(d.url, '_blank', 'noopener')
      else setLinkMsg((m) => ({ ...m, [c.key]: d.message || d.error || 'Unipile indisponible' }))
    } catch { setLinkMsg((m) => ({ ...m, [c.key]: 'Erreur réseau' })) }
    finally { setLinking(null) }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="card p-4 bg-indigo-50/40 border-indigo-100">
        <p className="text-xs text-indigo-700">Tous les canaux passent par <strong>Unipile</strong> (une seule intégration). LinkedIn et WhatsApp se connectent via authentification hébergée / QR code ; l'email via Gmail, Outlook ou IMAP.</p>
      </div>

      {/* Sécurité — MFA */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-700">Sécurité du compte</h2>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${mfaOn ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{mfaOn ? 'MFA activée' : 'MFA désactivée'}</span>
          </div>
          {mfaOn
            ? <button onClick={disableMfa} className="text-xs font-medium text-gray-400 hover:text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-colors">Désactiver la MFA</button>
            : <button onClick={startMfa} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity">Activer la MFA (TOTP)</button>}
        </div>
        <p className="text-xs text-gray-400">Mot de passe hashé (bcrypt) + double authentification par application (Google Authenticator / Authy). Recommandé avant de poser des clés de production.</p>

        {mfaSecret && !mfaOn && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <p className="text-xs text-gray-600 mb-2">1. Ajoutez ce compte dans votre app d'authentification (saisie manuelle de la clé, ou via l'URI <code className="text-[10px]">otpauth</code>) :</p>
            <div className="bg-gray-50 rounded-lg p-3 mb-3">
              <p className="text-[11px] text-gray-400">Clé secrète</p>
              <code className="text-sm font-mono font-semibold text-gray-800 tracking-wider break-all">{mfaSecret}</code>
              <p className="text-[10px] text-gray-400 mt-2 break-all">{mfaUri}</p>
            </div>
            <p className="text-xs text-gray-600 mb-2">2. Entrez le code d'appairage généré :</p>
            <div className="flex items-center gap-2">
              <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" className={`${fieldCls} w-32 text-center tracking-[0.3em] font-semibold`} />
              <button onClick={confirmMfa} disabled={mfaCode.length !== 6} className="gradient-brand text-white text-xs font-semibold px-3 py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">Confirmer</button>
            </div>
          </div>
        )}
        {mfaMsg && <p className="text-xs text-emerald-600 mt-3">{mfaMsg}</p>}
      </div>

      {/* Clés API — statut lecture seule (les valeurs se posent dans Vercel, jamais ici) */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-gray-700">Clés API & modèles</h2>
          <div className="flex items-center gap-2">
            {persistence && (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${persistence === 'supabase' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                {persistence === 'supabase' ? 'Persistance : Supabase' : 'Persistance : mémoire'}
              </span>
            )}
            <button onClick={testPersistence} className="text-[10px] font-semibold text-gray-500 border border-gray-200 px-2 py-0.5 rounded-full hover:bg-gray-50 transition-colors">Tester Supabase</button>
            <button onClick={checkDb} className="text-[10px] font-semibold text-gray-500 border border-gray-200 px-2 py-0.5 rounded-full hover:bg-gray-50 transition-colors">Vérifier les tables</button>
            {sigMode && (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sigMode === 'exa+claude' ? 'bg-emerald-50 text-emerald-600' : sigMode === 'claude-web' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-400'}`}>
                Signaux : {sigMode === 'exa+claude' ? 'Exa → Claude' : sigMode === 'claude-web' ? 'Claude web seul' : 'mode simulé'}
              </span>
            )}
          </div>
        </div>
        <div className="space-y-2.5">
          {keys.map((k) => (
            <div key={k.key} className="flex items-center gap-3 flex-wrap">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${k.set ? 'bg-emerald-500' : 'bg-gray-300'}`} />
              <div className="min-w-[180px] flex-shrink-0">
                <p className="text-sm text-gray-700 leading-tight">{k.label}</p>
                <code className="text-[10px] text-gray-400">{k.key}</code>
              </div>
              <input
                type="password"
                value={keyDrafts[k.key] ?? ''}
                onChange={(e) => setKeyDrafts((d) => ({ ...d, [k.key]: e.target.value }))}
                placeholder={k.set ? '•••••••• (configurée — laisser vide pour garder)' : 'Coller la clé…'}
                autoComplete="off"
                className={`${fieldCls} flex-1 min-w-[180px]`}
              />
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${k.source === 'app' ? 'bg-indigo-50 text-indigo-600' : k.source === 'env' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
                {k.source === 'app' ? 'saisie app' : k.source === 'env' ? 'Vercel env' : 'manquante'}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button onClick={saveKeys} disabled={savingKeys} className="gradient-brand text-white text-xs font-semibold px-4 py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">
            {savingKeys ? 'Enregistrement…' : 'Enregistrer les clés'}
          </button>
          {keySaved && <span className="text-xs text-emerald-600">✓ Clés enregistrées</span>}
        </div>
        {diag && <p className="text-[11px] text-gray-600 mt-3 font-mono bg-gray-50 rounded-lg p-2 break-words">{diag}</p>}
        {dbRows && (
          <div className="mt-3 bg-gray-50 rounded-lg p-3">
            <p className="text-[11px] font-semibold text-gray-600 mb-2">État des tables Supabase</p>
            <div className="space-y-1">
              {dbRows.map((r) => (
                <div key={r.table} className="flex items-center gap-2 text-[11px]">
                  <span className={`w-2 h-2 rounded-full ${r.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <code className="text-gray-600">{r.table}</code>
                  <span className={`ml-auto ${r.ok ? 'text-emerald-600' : 'text-red-600'}`}>{r.ok ? 'OK' : (r.error || 'manquante')}</span>
                </div>
              ))}
            </div>
            {dbRows.some((r) => !r.ok) && (
              <button onClick={() => setShowSql((v) => !v)} className="text-[11px] text-indigo-600 hover:underline mt-2">{showSql ? 'Masquer' : 'Afficher'} le SQL à exécuter</button>
            )}
            {showSql && (
              <pre className="text-[10px] text-gray-600 bg-white border border-gray-200 rounded-lg p-2 mt-2 overflow-x-auto whitespace-pre">{FULL_SQL}</pre>
            )}
          </div>
        )}
        <p className="text-[11px] text-amber-600 mt-3">⚠️ Les clés saisies ici sont stockées <strong>en mémoire serveur</strong> : pratique pour tester, mais elles peuvent être réinitialisées après une mise en veille / un redéploiement. Pour du <strong>durable</strong>, pose-les aussi dans Vercel → Environment Variables (ou on branchera Supabase). Ne partage jamais cet écran.</p>
      </div>

      <AnonymizationCard />

      {channels.map((c) => {
        const d = cfg(c)
        return (
          <div key={c.key} className="card p-5">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-9 h-9 rounded-xl gradient-brand text-white text-xs font-bold flex items-center justify-center flex-shrink-0">{CHANNEL_ICON[c.key]}</span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-800">{c.label}</p>
                <p className="text-xs text-gray-400">{c.detail}</p>
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.connected ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>{c.connected ? 'Connecté' : 'Non connecté'}</span>
            </div>

            {c.key === 'linkedin' && (
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Compte LinkedIn</label>
                <input value={d.account || ''} onChange={(e) => setDraft(c.key, { account: e.target.value })} className={fieldCls} placeholder="Nom du compte lié" />
              </div>
            )}

            {c.key === 'email' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Fournisseur</label>
                  <select value={d.provider || ''} onChange={(e) => setDraft(c.key, { provider: e.target.value })} className={fieldCls}>
                    <option value="">Choisir…</option><option>Gmail</option><option>Outlook</option><option>IMAP</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Adresse d'envoi</label>
                  <input value={d.fromEmail || ''} onChange={(e) => setDraft(c.key, { fromEmail: e.target.value })} className={fieldCls} placeholder="ludwig@smart-ai.com" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nom expéditeur</label>
                  <input value={d.fromName || ''} onChange={(e) => setDraft(c.key, { fromName: e.target.value })} className={fieldCls} placeholder="Ludwig Graham" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Signature</label>
                  <textarea value={d.signature || ''} onChange={(e) => setDraft(c.key, { signature: e.target.value })} className={`${fieldCls} h-20 resize-none`} placeholder="Ludwig Graham · Smart.AI" />
                </div>
              </div>
            )}

            {c.key === 'whatsapp' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Numéro WhatsApp</label>
                  <input value={d.phone || ''} onChange={(e) => setDraft(c.key, { phone: e.target.value })} className={fieldCls} placeholder="+33 6 12 34 56 78" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nom affiché</label>
                  <input value={d.displayName || ''} onChange={(e) => setDraft(c.key, { displayName: e.target.value })} className={fieldCls} placeholder="Ludwig · Smart.AI" />
                </div>
                <p className="md:col-span-2 text-[11px] text-gray-400">La connexion réelle se fait par scan d'un QR code depuis WhatsApp mobile (Unipile). Le numéro renseigné sert d'identifiant d'envoi.</p>
              </div>
            )}

            <div className="flex items-center gap-2 mt-4 flex-wrap">
              <button onClick={() => linkUnipile(c)} disabled={linking === c.key} className="gradient-brand text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">
                {linking === c.key ? 'Ouverture…' : `Connecter via Unipile`}
              </button>
              <button onClick={() => connect(c)} className="text-xs font-semibold text-gray-600 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">
                Enregistrer les paramètres
              </button>
              {c.connected && (
                <button onClick={() => disconnect(c)} className="text-xs font-medium text-gray-400 px-3 py-1.5 rounded-lg hover:text-red-500 hover:bg-red-50 transition-colors">Déconnecter</button>
              )}
              {linkMsg[c.key] && <span className="text-[11px] text-amber-600 w-full">{linkMsg[c.key]}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const PROVIDER_STYLE: Record<string, string> = {
  anthropic: 'bg-indigo-50 text-indigo-600', exa: 'bg-emerald-50 text-emerald-600',
  perplexity: 'bg-purple-50 text-purple-600', openai: 'bg-teal-50 text-teal-600', gemini: 'bg-amber-50 text-amber-600',
}

function ProtocoleTab() {
  const [routes, setRoutes] = useState<ModelRouteRow[]>([])
  useEffect(() => { fetch('/api/config/models').then((r) => r.json()).then((d) => setRoutes(d.routes || [])).catch(() => {}) }, [])

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="card p-4 bg-indigo-50/40 border-indigo-100">
        <p className="text-xs text-indigo-700">Chaque <strong>phase métier</strong> est routée vers le LLM le plus pertinent. Un point vert = la clé du provider est configurée (onglet Connexions). Modèles surchargeables par variable sans toucher au code.</p>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 text-left">
              {['Phase', 'Provider', 'Modèle', 'Pourquoi', 'Prêt'].map((h) => (
                <th key={h} className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.phase} className="border-b border-gray-50 align-top">
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-gray-800">{r.phase}</p>
                  {r.fallback && <p className="text-[11px] text-gray-400">repli : {r.fallback}</p>}
                </td>
                <td className="px-4 py-3"><span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${PROVIDER_STYLE[r.provider] || 'bg-gray-100 text-gray-500'}`}>{r.provider}</span></td>
                <td className="px-4 py-3"><code className="text-[11px] text-gray-600">{r.model}</code></td>
                <td className="px-4 py-3"><p className="text-xs text-gray-500 leading-relaxed max-w-md">{r.why}</p></td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${r.ready ? 'text-emerald-600' : 'text-gray-400'}`}>
                    <span className={`w-2 h-2 rounded-full ${r.ready ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    {r.ready ? 'prêt' : r.requires}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AnonymizationCard() {
  const [enabled, setEnabled] = useState(true)
  const [text, setText] = useState('Contactez Jean Dupont au 06 12 34 56 78 ou jean.dupont@acme.fr — SIREN 552100554.')
  const [preview, setPreview] = useState<{ masked: string; total: number; counts: Record<string, number> } | null>(null)

  useEffect(() => { fetch('/api/config/anonymize').then((r) => r.json()).then((d) => setEnabled(d.enabled !== false)).catch(() => {}) }, [])

  const toggle = async () => {
    const next = !enabled; setEnabled(next)
    await fetch('/api/config/anonymize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: next }) })
  }
  const run = async () => {
    const d = await fetch('/api/config/anonymize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then((r) => r.json())
    setPreview(d.preview)
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-gray-700">Anonymisation des données (DLP)</h2>
        <button onClick={toggle} className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
          {enabled ? 'Activée pour les documents' : 'Désactivée'}
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-3">Masque les PII (emails, téléphones, IBAN, SIREN/SIRET) avant l'envoi à un LLM, puis ré-injecte les vraies valeurs dans la réponse. À garder OFF pour la rédaction d'accroche (besoin du vrai nom), ON pour l'analyse de documents sensibles.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} className={`${fieldCls} h-20 resize-none mb-2`} />
      <button onClick={run} className="text-xs font-semibold text-gray-600 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">Prévisualiser le masquage</button>
      {preview && (
        <div className="mt-3 bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-700 font-mono break-words">{preview.masked}</p>
          <p className="text-[11px] text-gray-400 mt-2">{preview.total} PII masquées{Object.keys(preview.counts).length ? ' · ' + Object.entries(preview.counts).map(([k, v]) => `${v} ${k}`).join(', ') : ''}</p>
        </div>
      )}
    </div>
  )
}

function fmtCost(c: number) { return c < 0.01 ? '< $0.01' : `$${c.toFixed(2)}` }
function fmtTok(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n) }

function AiLogsTab() {
  const [logs, setLogs] = useState<AiLog[]>([])
  const [filter, setFilter] = useState<string>('Tous')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { getAiLogs().then(setLogs) }, [])

  const filtered = filter === 'Tous' ? logs : logs.filter((l) => l.agent === filter)

  return (
    <div>
      <p className="text-sm text-gray-400 mb-4">{filtered.length} appel(s) IA enregistré(s) · input/output et coût par appel.</p>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {['Tous', ...AI_AGENTS].map((a) => (
          <button key={a} onClick={() => setFilter(a)} className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${filter === a ? 'gradient-brand text-white' : 'text-gray-500 bg-gray-100 hover:bg-gray-200'}`}>{a}</button>
        ))}
      </div>
      <div className="space-y-2">
        {filtered.map((l) => {
          const isOpen = open === l.id
          return (
            <div key={l.id} className="card overflow-hidden">
              <button onClick={() => setOpen(isOpen ? null : l.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50/50 transition-colors">
                <span className="text-xs text-gray-400 w-24 flex-shrink-0">{l.when}</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 flex-shrink-0">{l.agent}</span>
                <span className="text-sm text-gray-700 truncate flex-1">{l.model}</span>
                <span className="text-xs text-gray-400 flex-shrink-0">{fmtTok(l.tokensIn + l.tokensOut)} tok</span>
                <span className="text-xs font-semibold text-gray-600 w-16 text-right flex-shrink-0">{fmtCost(l.cost)}</span>
                <svg className={`w-4 h-4 text-gray-300 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
                    <span>Provider : <span className="font-semibold text-gray-700">{l.provider}</span></span>
                    <span>Modèle : <span className="font-semibold text-gray-700">{l.model}</span></span>
                    <span>Tokens in : <span className="font-semibold text-gray-700">{l.tokensIn}</span></span>
                    <span>Tokens out : <span className="font-semibold text-gray-700">{l.tokensOut}</span></span>
                    <span>Coût : <span className="font-semibold text-gray-700">{fmtCost(l.cost)}</span></span>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold text-gray-400 uppercase mb-1">System prompt</p>
                    <pre className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 whitespace-pre-wrap max-h-40 overflow-y-auto">{l.systemPrompt}</pre>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold text-gray-400 uppercase mb-1">Input</p>
                    <pre className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 whitespace-pre-wrap">{l.input}</pre>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold text-gray-400 uppercase mb-1">Output</p>
                    <pre className="text-xs text-gray-700 bg-emerald-50/40 border border-emerald-100 rounded-lg p-3 whitespace-pre-wrap">{l.output}</pre>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const PERM_META: { key: keyof WorkspacePermissions; label: string; desc: string }[] = [
  { key: 'messaging', label: 'Messagerie', desc: 'Répondre / envoyer via LinkedIn, Mail, WhatsApp + rappels' },
  { key: 'leads', label: 'Gestion des leads', desc: 'Statut, tags, import, sourcing' },
  { key: 'sequences', label: 'Séquences', desc: 'Créer / éditer et enrôler des leads' },
  { key: 'validate', label: 'Valider les actions du jour', desc: 'Mode revue des messages IA' },
  { key: 'externalAI', label: 'IA externe (Claude/ChatGPT/Perplexity)', desc: 'Autoriser l\'envoi de contexte lead vers un service tiers depuis la fiche. À décocher si la politique du client l\'interdit.' },
]

function WorkspaceManageModal({ ws, onClose, onSaved }: { ws: Workspace; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(ws.name)
  const [plan, setPlan] = useState(ws.plan)
  const [email, setEmail] = useState(ws.clientEmail || '')
  const [status, setStatus] = useState<'active' | 'suspended'>(ws.status === 'suspended' ? 'suspended' : 'active')
  const [perms, setPerms] = useState<WorkspacePermissions>(ws.permissions || { ...DEFAULT_PERMISSIONS })
  const [clientPw, setClientPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [wsToken, setWsToken] = useState<string | null>(null)
  const [tokCopied, setTokCopied] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
  useEffect(() => { fetch(`/api/workspaces/token?id=${ws.id}`).then((r) => r.json()).then((d) => setWsToken(d.token || null)).catch(() => {}) }, [ws.id])

  const save = async () => {
    setBusy(true)
    const body: any = { id: ws.id, patch: { name, plan, clientEmail: email, status, permissions: perms } }
    if (clientPw.trim().length >= 8) body.clientPassword = clientPw.trim()
    await fetch('/api/workspaces', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    setBusy(false); onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative card w-full max-w-lg p-6 max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-bold text-gray-900">Espace client · {ws.name}</h2>
            <code className="text-[11px] text-gray-400">{ws.id}</code>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nom du client</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Plan</label>
            <select value={plan} onChange={(e) => setPlan(e.target.value)} className={fieldCls}><option>Starter</option><option>Growth</option><option>Scale</option></select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Email d'accès client</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className={fieldCls} placeholder="client@entreprise.com" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Statut</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as any)} className={fieldCls}><option value="active">Actif</option><option value="suspended">Suspendu</option></select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Mot de passe d'accès client {ws.hasClientAccess && <span className="text-emerald-600 font-normal">· défini</span>}</label>
            <input type="password" value={clientPw} onChange={(e) => setClientPw(e.target.value)} className={fieldCls} placeholder={ws.hasClientAccess ? '•••••••• (laisser vide pour garder)' : 'Min. 8 caractères'} />
            <p className="text-[11px] text-gray-400 mt-1">Le client se connecte sur la même page que toi, avec cet email + ce mot de passe. Il obtient une vue limitée à ses permissions ci-dessous.</p>
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Jeton extension Jarvis <span className="font-normal text-gray-400">— à remettre au client pour son extension (écrit dans SON espace)</span></label>
            <div className="flex items-center gap-2">
              <input readOnly value={wsToken || 'Génération…'} className={`${fieldCls} font-mono text-[11px]`} onFocus={(e) => e.target.select()} />
              <button onClick={() => { if (wsToken) { navigator.clipboard?.writeText(wsToken); setTokCopied(true); setTimeout(() => setTokCopied(false), 1500) } }} className="text-xs font-semibold text-gray-600 border border-gray-200 px-3 py-2 rounded-xl hover:bg-gray-50 flex-shrink-0">{tokCopied ? '✓ Copié' : 'Copier'}</button>
              <button onClick={async () => { if (!confirmRegen) { setConfirmRegen(true); return } setConfirmRegen(false); setWsToken(null); const d = await fetch('/api/workspaces/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ws.id }) }).then((r) => r.json()); setWsToken(d.token || null) }} className={`text-xs font-semibold px-3 py-2 rounded-xl flex-shrink-0 ${confirmRegen ? 'bg-red-500 text-white' : 'text-red-500 border border-red-200 hover:bg-red-50'}`}>{confirmRegen ? 'Confirmer' : 'Régénérer'}</button>
            </div>
            <p className="text-[11px] text-gray-400 mt-1">Le client colle ce jeton + l'URL Prospector dans les réglages de l'extension. « Régénérer » <strong>révoque l'ancien jeton de CE client uniquement</strong> (les autres ne sont pas touchés) — il devra remettre le nouveau.</p>
          </div>
        </div>

        <p className="text-xs font-semibold text-gray-500 mb-2">Permissions du client <span className="font-normal text-gray-400">— ce qu'il peut faire dans son espace</span></p>
        <div className="space-y-2 mb-4">
          {PERM_META.map((p) => (
            <label key={p.key} className="flex items-start gap-3 p-2.5 rounded-xl border border-gray-100 cursor-pointer hover:bg-gray-50/50">
              <input type="checkbox" checked={perms[p.key] !== false} onChange={(e) => setPerms((v) => ({ ...v, [p.key]: e.target.checked }))} className="accent-indigo-500 mt-0.5" />
              <span>
                <span className="block text-sm font-medium text-gray-700">{p.label}</span>
                <span className="block text-xs text-gray-400">{p.desc}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 mb-4">🔒 Toujours réservé à l'admin : Connexions & clés, Usage & coûts, Logs IA, Protocole LLM, Cerveau IA, création de workspaces.</p>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm font-medium text-gray-500 px-3 py-2 rounded-xl hover:bg-gray-50">Annuler</button>
          <button onClick={save} disabled={busy} className="gradient-brand text-white text-sm font-semibold px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">{busy ? '…' : 'Enregistrer'}</button>
        </div>
      </div>
    </div>
  )
}
