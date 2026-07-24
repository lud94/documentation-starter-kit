import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

export default function LoginPage() {
  const router = useRouter()
  const [setup, setSetup] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [mfaStep, setMfaStep] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { fetch('/api/auth/status').then((r) => r.json()).then((d) => setSetup(!!d.setup)).catch(() => setSetup(true)) }, [])

  const dest = () => { const f = router.query.from; return typeof f === 'string' && f.startsWith('/') ? f : '/actions' }

  const submit = async () => {
    setError(null)
    if (setup === false) {
      if (password.length < 8) return setError('8 caractères minimum.')
      if (password !== confirm) return setError('Les mots de passe ne correspondent pas.')
    }
    setBusy(true)
    try {
      const url = setup === false ? '/api/auth/setup' : '/api/auth/login'
      const payload: any = { password }
      if (mfaStep) payload.code = code
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await res.json()
      if (!res.ok) {
        if (d.error === 'mfa_required') { setMfaStep(true); setError(null); return }
        throw new Error(d.error === 'not_setup' ? 'Aucun mot de passe défini.' : d.error || 'Échec')
      }
      window.location.href = dest()
    } catch (e: any) {
      setError(e.message || 'Erreur')
    } finally { setBusy(false) }
  }

  const isSetup = setup === false

  return (
    <>
      <Head><title>Prospector · Connexion</title></Head>
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: '#f0f2f8' }}>
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-6">
            <div className="w-12 h-12 rounded-2xl gradient-brand flex items-center justify-center text-white font-bold text-lg mb-3">P</div>
            <h1 className="text-xl font-bold text-gray-900">Prospector</h1>
            <p className="text-sm text-gray-400">{isSetup ? 'Créez votre mot de passe d\'accès' : 'Connexion à la plateforme'}</p>
          </div>

          {mfaStep ? (
            <div className="card p-6">
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Code de vérification (MFA)</label>
              <input
                type="text" inputMode="numeric" maxLength={6} value={code} autoFocus autoComplete="one-time-code"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && submit()}
                className="w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white mb-3 tracking-[0.4em] text-center font-semibold"
                placeholder="000000"
              />
              <p className="text-[11px] text-gray-400 mb-3">Ouvrez votre app d'authentification (Google Authenticator / Authy).</p>
              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
              <button onClick={submit} disabled={busy || code.length !== 6} className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
                {busy ? '…' : 'Vérifier'}
              </button>
            </div>
          ) : (
          <div className="card p-6">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Mot de passe</label>
            <input
              type="password" value={password} autoFocus autoComplete={isSetup ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !isSetup && submit()}
              className="w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white mb-3"
              placeholder="••••••••"
            />
            {isSetup && (
              <>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Confirmer</label>
                <input
                  type="password" value={confirm} autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
                  className="w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white mb-3"
                  placeholder="••••••••"
                />
              </>
            )}
            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
            <button onClick={submit} disabled={busy || setup === null} className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
              {busy ? '…' : isSetup ? 'Créer et entrer' : 'Se connecter'}
            </button>
          </div>
          )}
          <p className="text-[11px] text-gray-400 text-center mt-4">Accès réservé · Smart.AI</p>
        </div>
      </div>
    </>
  )
}
