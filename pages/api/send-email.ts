import type { NextApiRequest, NextApiResponse } from 'next'

const N8N_EMAIL_WEBHOOK = 'https://naiom.app.n8n.cloud/webhook/e653fbe9-d936-41f8-8de4-d4f7177c0b48'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { person, company } = req.body

  if (!person?.email || !company?.name) {
    return res.status(400).json({ error: 'person.email and company.name are required' })
  }

  try {
    const response = await fetch(N8N_EMAIL_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        person,
        company,
        meta: {
          source: 'naiom-platform',
          trigger: 'email_send',
          timestamp: new Date().toISOString(),
        },
      }),
    })

    if (!response.ok) {
      throw new Error(`n8n responded with ${response.status}`)
    }

    const data = await response.json()
    return res.status(200).json(data)
  } catch (err: any) {
    console.error('send-email error:', err)
    return res.status(502).json({ error: err.message || 'Failed to send email' })
  }
}
