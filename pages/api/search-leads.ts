import type { NextApiRequest, NextApiResponse } from 'next'

const N8N_SEARCH_WEBHOOK = 'https://naiom.app.n8n.cloud/webhook/aecd6009-7ae7-4c4e-8fe8-21cfc1bb7914'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { industry, location, jobTitle, employeeRange, revenue } = req.body

  if (!industry || !location) {
    return res.status(400).json({ error: 'industry and location are required' })
  }

  try {
    const response = await fetch(N8N_SEARCH_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ industry, location, jobTitle, employeeRange, revenue }),
    })

    if (!response.ok) {
      throw new Error(`n8n responded with ${response.status}`)
    }

    const data = await response.json()
    return res.status(200).json(data)
  } catch (err: any) {
    console.error('search-leads error:', err)
    return res.status(502).json({ error: err.message || 'Failed to fetch leads' })
  }
}
