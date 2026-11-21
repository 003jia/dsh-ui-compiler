import { createRoot } from 'react-dom/client'
import { BoardPreview } from './BoardPreview'

const inputHash = document.querySelector<HTMLMetaElement>('meta[name="uic-input-sha256"]')?.content ?? ''
createRoot(document.getElementById('root')!).render(<BoardPreview inputHash={inputHash} />)
