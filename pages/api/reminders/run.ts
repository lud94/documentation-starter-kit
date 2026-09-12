import type {
  NextApiRequest,
  NextApiResponse,
} from 'next'

import {
  runReminderSweep,
} from '../../../lib/prospector/reminderRunner'

import {
  reminderDeliver,
} from '../../../lib/prospector/reminderDelivery'
import { logSafeError } from '../../../lib/observability/safeError'

// JARVIS-REMINDER-01D — endpoint interne du scheduler.
//
// Aucun utilisateur navigateur ne doit pouvoir déclencher le sweep.
// Supabase Cron appellera cet endpoint avec :
// Authorization: Bearer <CRON_SECRET>
//
// Fail-closed :
// - secret absent => 503 ;
// - mauvais secret => 401 ;
// - mauvaise méthode => 405.

export const config = {
  maxDuration: 60,
}

function bearerToken(
  req: NextApiRequest,
): string | null {
  const raw = req.headers.authorization

  if (
    typeof raw !== 'string' ||
    !raw.startsWith('Bearer ')
  ) {
    return null
  }

  const token = raw.slice(7).trim()

  return token || null
}

function timingSafeEqual(
  a: string,
  b: string,
): boolean {
  if (a.length !== b.length) {
    return false
  }

  let diff = 0

  for (let i = 0; i < a.length; i++) {
    diff |=
      a.charCodeAt(i) ^
      b.charCodeAt(i)
  }

  return diff === 0
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'POST only',
    })
  }

  const expected =
    process.env.CRON_SECRET?.trim()

  // Une configuration incomplète ne doit jamais
  // désactiver l'authentification.
  if (!expected) {
    return res.status(503).json({
      error: 'scheduler_unavailable',
    })
  }

  const presented = bearerToken(req)

  if (
    !presented ||
    !timingSafeEqual(
      presented,
      expected,
    )
  ) {
    return res.status(401).json({
      error: 'unauthorized',
    })
  }

  try {
    const result =
      await runReminderSweep(
        reminderDeliver,
      )

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error: any) {
    // SEC-LOG-01 — un balayage de rappels touche des contenus utilisateur ;
    // son message d'erreur ne doit rien en dire.
    logSafeError('reminder.sweep_error', error, { operation: 'sweep' })

    return res.status(500).json({
      error: 'reminder_sweep_failed',
    })
  }
}