import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/fraunces/400.css'
import '@fontsource/figtree/400.css'
import '@fontsource/figtree/500.css'
import '@fontsource/figtree/600.css'
import './styles.css'
import { App } from './App'
import { Capture } from './Capture'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.hash === '#capture' ? <Capture /> : <App />}
  </StrictMode>
)
