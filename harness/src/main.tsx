import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BoardPreview, locale } from './BoardPreview'
import { previewLabels, previewServers } from './fixtures'
import { McpCenterView, type McpCenterViewProps } from './pages/mcp-center/McpCenterView.generated'
import manifest from './pages/mcp-center/.uic-manifest.json'

const requested = new URLSearchParams(location.search).get('state')
const state: NonNullable<McpCenterViewProps['state']> =
  requested === 'loading' || requested === 'empty' || requested === 'error' ? requested : 'default'

function Preview() {
  const [query, setQuery] = useState('')
  return (
    <BoardPreview inputHash={manifest.inputHash} state={state}>
      <McpCenterView state={state} labels={previewLabels[locale]} servers={previewServers(locale, query)}
        onSearch={event => setQuery(event.currentTarget.value)} />
    </BoardPreview>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
