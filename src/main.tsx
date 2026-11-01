import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './index.css'
import './styles/ergo.css'
import './styles/document.css'
import './styles/detail.css'
import './styles/settings.css'
import './styles/dialogs.css'
import './styles/accents.css'
import App from './App.tsx'
import { BetaProvider } from './context/BetaContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BetaProvider>
      <App />
    </BetaProvider>
  </StrictMode>,
)
