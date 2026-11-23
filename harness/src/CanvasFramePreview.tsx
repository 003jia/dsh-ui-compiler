import type { CSSProperties, ReactNode } from 'react'

type Layer = Record<string, unknown>
type Layout = 'horizontal' | 'vertical' | 'none'
export type CanvasAction = (layer: { id: string; name: string }) => void

function isLayer(value: unknown): value is Layer {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pixels(value: unknown) {
  if (Array.isArray(value) && value.length >= 1 && value.length <= 4 && value.every(v => number(v) !== undefined)) {
    return value.map(n => n + 'px').join(' ')
  }
  return number(value)
}

function dimension(value: unknown) {
  if (value === 'fill_container') return '100%'
  if (value === 'fit_content') return 'fit-content'
  return number(value)
}

function color(fill: unknown) {
  if (!Array.isArray(fill)) return undefined
  for (let index = fill.length - 1; index >= 0; index--) {
    const paint = fill[index]
    if (isLayer(paint) && paint.type === 'solid' && paint.visible !== false &&
      typeof paint.color === 'string' && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(paint.color)) {
      return paint.color
    }
  }
}

const alignment = {
  start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch',
  space_between: 'space-between', space_around: 'space-around', space_evenly: 'space-evenly',
} as const

function flexAlignment(value: unknown) {
  return typeof value === 'string' && Object.hasOwn(alignment, value)
    ? alignment[value as keyof typeof alignment]
    : 'flex-start'
}

function renderLayer(node: Layer, key: string | number, iconPaths: Readonly<Record<string, string>>, onAction?: CanvasAction, parentLayout?: Layout, insideButton = false): ReactNode {
  const { type, name, content } = node
  if (node.visible === false || node.enabled === false || node.hidden === true) return null

  const grow = (parentLayout === 'vertical' && node.height === 'fill_container') ||
    (parentLayout === 'horizontal' && node.width === 'fill_container')
  const base: CSSProperties = {
    boxSizing: 'border-box', opacity: number(node.opacity),
    position: parentLayout === 'none' ? 'absolute' : 'relative',
    left: parentLayout === 'none' ? number(node.x) ?? 0 : undefined,
    top: parentLayout === 'none' ? number(node.y) ?? 0 : undefined,
    width: dimension(node.width), height: dimension(node.height),
    flex: grow ? '1 1 0' : '0 0 auto', minWidth: 0, minHeight: 0,
  }

  if (type === 'text') {
    const align = node.textAlign
    const style: CSSProperties = {
      ...base, display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      color: color(node.fill) ?? 'black',
      fontFamily: typeof node.fontFamily === 'string' ? node.fontFamily : undefined,
      fontSize: number(node.fontSize), fontWeight: number(node.fontWeight),
      lineHeight: number(node.lineHeight) ?? 'normal',
      textAlign: align === 'center' || align === 'right' || align === 'justify' ? align : 'left',
    }
    const heading = !insideButton && typeof name === 'string' && /^(?:标题|title|heading)$/i.test(name)
    return <span key={key} role={heading ? 'heading' : undefined} aria-level={heading ? 2 : undefined}
      style={style}>{typeof content === 'string' ? content : ''}</span>
  }

  const style: CSSProperties = {
    ...base, display: 'block', backgroundColor: color(node.fill),
    borderRadius: type === 'ellipse' ? '50%' : pixels(node.cornerRadius),
    overflow: node.clipContent === true ? 'hidden' : undefined,
  }
  if (isLayer(node.stroke)) {
    const ink = color(node.stroke.fill)
    const width = number(node.stroke.thickness)
    if (ink && width !== undefined && width > 0) style.boxShadow = `inset 0 0 0 ${width}px ${ink}`
  }
  if (type === 'rectangle' || type === 'ellipse') {
    return <span key={key} aria-hidden="true" style={style} />
  }
  if (type === 'icon_font') {
    const icon = node.iconFontName
    if (typeof icon !== 'string' || !Object.hasOwn(iconPaths, icon)) return null
    return <svg key={key} aria-hidden="true" style={{ ...base, display: 'block', color: color(node.fill) }}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d={iconPaths[icon]} />
    </svg>
  }
  if (type === 'text_input') {
    return <input key={key} style={style} data-layer-id={String(node.id ?? key)}
      placeholder={typeof node.placeholder === 'string' ? node.placeholder : undefined}
      aria-label={typeof name === 'string' ? name : undefined} />
  }
  if (type === 'path' && typeof node.d === 'string') {
    return <svg key={key} style={{ ...base, display: 'block' }} aria-hidden="true"
      viewBox={`0 0 ${number(node.width) || 24} ${number(node.height) || 24}`}>
      <path d={node.d} fill={color(node.fill) ?? 'currentColor'} />
    </svg>
  }
  if (type !== 'frame' && type !== 'group') return null

  const layout = node.layout === 'horizontal' || node.layout === 'vertical' ? node.layout : 'none'
  if (layout !== 'none') {
    Object.assign(style, {
      display: 'flex', flexDirection: layout === 'vertical' ? 'column' : 'row',
      alignItems: flexAlignment(node.alignItems), justifyContent: flexAlignment(node.justifyContent),
      padding: pixels(node.padding), gap: number(node.gap),
    } satisfies CSSProperties)
  }

  const button = !insideButton && typeof name === 'string' &&
    /(?:按钮$|button$|^(?:button|按钮)[/：:])/i.test(name.trim())
  const children = Array.isArray(node.children) && node.children.map((child, index) => isLayer(child)
    ? renderLayer(child, typeof child.id === 'string' ? child.id : index, iconPaths, onAction, layout, insideButton || button)
    : null)
  if (button) {
    const id = String(node.id ?? key)
    return <button type="button" key={key} data-layer-id={id}
      onClick={onAction ? () => onAction({ id, name: String(name ?? id) }) : undefined}
      style={{ ...style, appearance: 'none', border: 0, margin: 0,
      padding: style.padding ?? 0, backgroundColor: style.backgroundColor ?? 'transparent',
      color: 'inherit', font: 'inherit' }}>{children}</button>
  }
  return <span key={key} style={style}>{children}</span>
}

/** Renders the saved OpenPencil frame at its design size, independent of its position on the canvas. */
export function CanvasFramePreview({ frame, onAction, iconPaths = {} }: {
  frame: unknown; onAction?: CanvasAction; iconPaths?: Readonly<Record<string, string>>
}) {
  if (!isLayer(frame) || frame.type !== 'frame') {
    return <p role="status">无法显示这张画板。</p>
  }
  return renderLayer(frame, 'frame', iconPaths, onAction)
}
