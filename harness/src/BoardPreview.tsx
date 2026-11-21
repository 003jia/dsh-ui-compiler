import { useEffect, useState, type ReactNode } from 'react'
import themeCss from 'virtual:dsh-harness-theme'
import { CanvasFramePreview } from './CanvasFramePreview'
import './preview.css'

const options = new URLSearchParams(window.location.search)
export const locale = options.get('locale') === 'en' ? 'en' : 'zh'
const requestedTheme = options.get('theme')
const embedded = Boolean(document.getElementById('uic-saved-frames'))
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
function previewTheme() {
  if (requestedTheme === 'dark' || requestedTheme === 'light') return requestedTheme
  return embedded && systemDark.matches ? 'dark' : 'light'
}

document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
document.documentElement.dataset.platform = 'darwin'
const styles = document.createElement('style')
styles.dataset.dshTheme = ''
styles.textContent = themeCss
document.head.append(styles)

type SavedFrame = { id: string; name?: string }
const frames: SavedFrame[] = JSON.parse(document.getElementById('uic-saved-frames')?.textContent || '[]')
const compiledPage = locale === 'en' ? 'MCP Center' : 'MCP 中心'

export function BoardPreview({ children, inputHash, state = 'default' }: { children?: ReactNode; inputHash: string; state?: string }) {
  const [theme, setTheme] = useState(previewTheme)
  const [frameId, setFrameId] = useState(frames.at(-1)?.id ?? '')
  const selected = frames.find(frame => frame.id === frameId)
  const title = selected?.name || (children ? compiledPage : '页面预览')
  useEffect(() => { document.title = title }, [title])
  useEffect(() => {
    const syncTheme = () => setTheme(previewTheme())
    systemDark.addEventListener('change', syncTheme)
    syncTheme()
    return () => systemDark.removeEventListener('change', syncTheme)
  }, [])
  useEffect(() => {
    document.documentElement.style.colorScheme = theme
    document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
  }, [theme])
  return (
    <main
      data-uic-ready=""
      data-uic-embedded={embedded || undefined}
      data-uic-theme={theme}
      data-uic-state={state}
      data-uic-input-sha256={inputHash}
    >
      {(frames.length > 1 || (children && frames.length > 0)) && (
        <label className="preview-board-picker">
          {locale === 'en' ? 'Board' : '画板'}
          <select value={frameId} onChange={event => setFrameId(event.currentTarget.value)}>
            {children && <option value="">{compiledPage}</option>}
            {frames.map(frame => <option key={frame.id} value={frame.id}>{frame.name || frame.id}</option>)}
          </select>
        </label>
      )}
      {selected && <div className="preview-board-stage"><CanvasFramePreview frame={selected} /></div>}
      {children && <div className="preview-mcp-stage" hidden={Boolean(selected)}>{children}</div>}
      {!selected && !children && <p className="preview-no-boards" role="status">{locale === 'en' ? 'Save a frame on the canvas to preview it here.' : '在画布添加画板并保存后，就能在这里预览。'}</p>}
    </main>
  )
}
