import type { AppProps } from 'next/app'
import Shell from '../components/Shell'
import '../styles/globals.css'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <Shell>
      <Component {...pageProps} />
    </Shell>
  )
}
