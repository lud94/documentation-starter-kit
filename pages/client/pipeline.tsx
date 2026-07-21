import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { Lead, Stage } from '../../types/prospector'
import { STAGE_META } from '../../types/prospector'
import { getLeads } from '../../lib/prospector/capabilities'

const STAGE_ORDER: Stage[] = ['to_invite', 'invited', 'connected', 'in_sequence', 'responded', 'meeting', 'closed']

export default function ClientPipeline() {
  const [leads, setLeads] = useState<Lead[]>([])
  useEffect(() => { getLeads().then(setLeads) }, [])
  const byStage = (s: Stage) => leads.filter((l) => l.stage === s)

  return (
    <>
      <Head><title>Espace client · Pipeline</title></Head>

      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Pipeline</h1>
        <p className="text-gray-400 text-sm mt-0.5">Où en sont vos prospects, étape par étape.</p>
      </div>

      <div className="overflow-x-auto pb-4 -mx-6 px-6">
        <div className="flex gap-3 min-w-max">
          {STAGE_ORDER.map((stage) => {
            const meta = STAGE_META[stage]
            const items = byStage(stage)
            return (
              <div key={stage} className="w-56 flex-shrink-0">
                <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-xl" style={{ backgroundColor: `${meta.color}14` }}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: meta.color }} />
                  <span className="text-xs font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                  <span className="text-xs font-bold ml-auto" style={{ color: meta.color }}>{items.length}</span>
                </div>
                <div className="bg-gray-50/70 rounded-2xl p-2 space-y-2 min-h-[100px]">
                  {items.map((lead) => (
                    <div key={lead.id} className="bg-white rounded-xl border border-gray-100 p-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg gradient-brand flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {`${lead.firstName[0]}${lead.lastName[0]}`.toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-800 truncate">{lead.firstName} {lead.lastName}</p>
                          <p className="text-xs text-gray-400 truncate">{lead.company}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                  {items.length === 0 && <p className="text-xs text-gray-300 text-center py-6">Vide</p>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
