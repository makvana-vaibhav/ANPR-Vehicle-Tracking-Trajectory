import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from '@/App'
import { AuthProvider } from '@/hooks/useAuth'
import { initTheme } from '@/lib/theme'
import '@/styles/index.css'

initTheme()

const container = document.getElementById('root')

if (!container) {
  throw new Error('Contrail: #root element missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
