import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

const inp = 'w-full px-3 py-2 rounded-xl text-sm text-gray-800 bg-gray-50 border border-gray-200 focus:outline-none focus:border-indigo-400 focus:bg-white mb-3'

export default function LoginPage() {
  const router = useRouter()
  const [setup, setSetup] = useState<boolean | null>(null)
  // Le portail proposait « Créez votre compte » dès que `setup=false`. Le setup
  // public étant fermé hors développement local (SEC-AUTH-0), il faut savoir si
  // l'opération est seulement POSSIBLE — sinon l'interface invite à une action
  // que le serveur refusera.
  const [setupAllowed, setSetupAllowed] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [mfaStep, setMfaStep] = useState(false)
  const [forgot, setForgot] = useState(false)
  const [resetToken, setResetToken] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // En cas d'échec : on suppose l'application initialisée et le setup fermé —
  // le repli le plus fermé, jamais l'invitation à créer un compte.
  useEffect(() => {
    fetch('/api/auth/status').then((r) => r.json())
      .then((d) => { setSetup(!!d.setup); setSetupAllowed(!!d.setupAllowed) })
      .catch(() => { setSetup(true); setSetupAllowed(false) })
  }, [])
  useEffect(() => { if (router.isReady) { const t = router.query.reset; if (typeof t === 'string' && t) setResetToken(t) } }, [router.isReady, router.query.reset])

  const dest = () => { const f = router.query.from; return typeof f === 'string' && f.startsWith('/') ? f : '/actions' }

  const submit = async () => {
    setError(null)
    if (!mfaStep && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Renseigne un email valide.')
    if (setup === false) {
      if (password.length < 8) return setError('8 caractères minimum.')
      if (password !== confirm) return setError('Les mots de passe ne correspondent pas.')
    }
    setBusy(true)
    try {
      const url = setup === false ? '/api/auth/setup' : '/api/auth/login'
      const payload: any = { email: email.trim(), password }
      if (mfaStep) payload.code = code
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await res.json()
      if (!res.ok) {
        if (d.error === 'mfa_required') { setMfaStep(true); setError(null); return }
        throw new Error(d.error === 'not_setup' ? 'Aucun mot de passe défini.' : d.error || 'Échec')
      }
      window.location.href = dest()
    } catch (e: any) { setError(e.message || 'Erreur') } finally { setBusy(false) }
  }

  const requestReset = async () => {
    setError(null); setInfo(null)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Renseigne ton email.')
    setBusy(true)
    try {
      // La réponse est volontairement uniforme et ne contient ni lien ni jeton :
      // il n'y a plus rien à en extraire, et l'interface n'essaie plus.
      await fetch('/api/auth/reset-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.trim() }) })
      setInfo('Si cet email existe, un lien de réinitialisation a été envoyé.')
    } finally { setBusy(false) }
  }

  const doReset = async () => {
    setError(null)
    if (password.length < 8) return setError('8 caractères minimum.')
    if (password !== confirm) return setError('Les mots de passe ne correspondent pas.')
    setBusy(true)
    try {
      const res = await fetch('/api/auth/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: resetToken, password }) })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Échec')
      window.location.href = '/login'
    } catch (e: any) { setError(e.message || 'Erreur') } finally { setBusy(false) }
  }

  const isSetup = setup === false && setupAllowed
  // Application non initialisée ET setup fermé : on le dit, sans proposer de
  // formulaire ni de champ de bootstrap dans le navigateur.
  const blocked = setup === false && !setupAllowed
  const subtitle = resetToken ? 'Nouveau mot de passe' : forgot ? 'Réinitialiser le mot de passe' : isSetup ? 'Créez votre compte' : 'Connexion à la plateforme'

  return (
    <>
      <Head><title>Prospector · Connexion</title></Head>
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: '#f0f2f8' }}>
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-6">
            <div className="w-12 h-12 rounded-2xl gradient-brand flex items-center justify-center text-white font-bold text-lg mb-3">P</div>
            <h1 className="text-xl font-bold text-gray-900">Prospector</h1>
            <p className="text-sm text-gray-400">{subtitle}</p>
          </div>

          {/* 0) Non initialisée, et le setup public n'existe pas ici */}
          {blocked ? (
            <div className="card p-6">
              <p className="text-sm text-gray-600">Application non initialisée. Contactez l'administrateur.</p>
            </div>
          ) : resetToken ? (
            <div className="card p-6">
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Nouveau mot de passe</label>
              <input type="password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} className={inp} placeholder="••••••••" />
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Confirmer</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doReset()} className={inp} placeholder="••••••••" />
              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
              <button onClick={doReset} disabled={busy} className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">{busy ? '…' : 'Réinitialiser'}</button>
            </div>
          ) : forgot ? (
            /* 2) Demande de réinitialisation */
            <div className="card p-6">
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Votre email</label>
              <input type="email" value={email} autoFocus onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && requestReset()} className={inp} placeholder="vous@smart-ai.com" />
              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
              {info && <p className="text-xs text-emerald-600 mb-3">{info}</p>}
              <button onClick={requestReset} disabled={busy} className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 mb-2">{busy ? '…' : 'Envoyer le lien'}</button>
              <button onClick={() => { setForgot(false); setInfo(null); setError(null) }} className="w-full text-xs text-gray-400 hover:text-gray-600">← Retour à la connexion</button>
            </div>
          ) : mfaStep ? (
            /* 3) MFA */
            <div className="card p-6">
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Code de vérification (MFA)</label>
              <input type="text" inputMode="numeric" maxLength={6} value={code} autoFocus autoComplete="one-time-code"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && submit()}
                className={`${inp} tracking-[0.4em] text-center font-semibold`} placeholder="000000" />
              <p className="text-[11px] text-gray-400 mb-3">Ouvrez votre app d'authentification (Google Authenticator / Authy).</p>
              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
              <button onClick={submit} disabled={busy || code.length !== 6} className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">{busy ? '…' : 'Vérifier'}</button>
            </div>
          ) : (
            /* 4) Connexion / création */
            <div className="card p-6">
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Email</label>
              <input type="email" value={email} autoFocus autoComplete="email" onChange={(e) => setEmail(e.target.value)} className={inp} placeholder="vous@smart-ai.com" />
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Mot de passe</label>
              <input type="password" value={password} autoComplete={isSetup ? 'new-password' : 'current-password'}
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !isSetup && submit()} className={inp} placeholder="••••••••" />
              {isSetup && (
                <>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">Confirmer</label>
                  <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} className={inp} placeholder="••••••••" />
                </>
              )}
              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
              <button onClick={submit} disabled={busy || setup === null} className="w-full gradient-brand text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50">
                {busy ? '…' : isSetup ? 'Créer et entrer' : 'Se connecter'}
              </button>
              {!isSetup && (
                <button onClick={() => { setForgot(true); setError(null) }} className="w-full text-xs text-indigo-600 hover:underline mt-3">Mot de passe oublié ?</button>
              )}
            </div>
          )}
          <p className="text-[11px] text-gray-400 text-center mt-4">Accès réservé · Smart.AI</p>
        </div>
      </div>
    </>
  )
}
