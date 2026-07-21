import type { AppProps } from 'next/app'
import { useRouter } from 'next/router'
import Shell from '../components/Shell'
import ClientShell from '../components/ClientShell'
import '../styles/globals.css'

export default function App({ Component, pageProps }: AppProps) {
  const { pathname } = useRouter()
  const Chrome = pathname.startsWith('/client') ? ClientShell : Shell
  return (
    <Chrome>
      <Component {...pageProps} />
    </Chrome>
  )
}
