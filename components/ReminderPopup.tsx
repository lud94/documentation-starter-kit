import { useRouter } from 'next/router'
import type { Notification } from '../lib/prospector/capabilities'

type ReminderPopupProps = {
  notification: Notification
  onDismiss: () => void
}

function reminderLabel(text: string) {
  return text.replace(/^⏰\s*Rappel\s*:\s*/i, '').trim()
}

function reminderWhen(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Échéance atteinte'
  return date.toLocaleString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function ReminderPopup({ notification, onDismiss }: ReminderPopupProps) {
  const router = useRouter()

  const openReminder = async () => {
    onDismiss()
    await router.push(notification.href || '/planning')
  }

  return (
    <div
      role='dialog'
      aria-live='assertive'
      aria-label='Rappel'
      className='fixed top-20 right-6 z-[70] w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl'
    >
      <div className='flex items-center gap-3 border-b border-gray-100 px-4 py-3'>
        <div className='flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-xl'>⏰</div>
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-bold text-gray-900'>Rappel</p>
          <p className='text-[11px] text-gray-400'>Échéance atteinte</p>
        </div>
        <button
          type='button'
          onClick={onDismiss}
          aria-label='Fermer le rappel'
          className='rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700'
        >
          ✕
        </button>
      </div>

      <div className='px-4 py-4'>
        <p className='text-sm font-semibold leading-6 text-gray-800'>
          {reminderLabel(notification.text)}
        </p>
        <p className='mt-2 text-xs capitalize text-gray-400'>
          {reminderWhen(notification.when)}
        </p>
      </div>

      <div className='flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-4 py-3'>
        <button
          type='button'
          onClick={onDismiss}
          className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100'
        >
          Fermer
        </button>
        <button
          type='button'
          onClick={openReminder}
          className='rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90'
        >
          Voir le lead
        </button>
      </div>
    </div>
  )
}
