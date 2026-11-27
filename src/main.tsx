import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './index.css'
import './styles/ergo.css'
import './styles/document.css'
import './styles/detail.css'
import './styles/settings.css'
import './styles/dialogs.css'
import './styles/onboarding.css'
import './styles/accents.css'
import './styles/views.css'
import './styles/filelinks.css'
import './styles/timeline-diff.css'
import './styles/preview.css'
import App from './App.tsx'
import { BetaProvider } from './context/BetaContext'
import { TooltipHost } from './components/ui/TooltipHost'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BetaProvider>
      <App />
      <TooltipHost />
    </BetaProvider>
  </StrictMode>,
)
