import type { McpCenterViewProps } from './pages/mcp-center/McpCenterView.generated'
import { en, zh } from './pages/mcp-center/mcp-center.locales.generated'

export type PreviewLocale = 'zh' | 'en'

const servers = {
  zh: [
    { id: 'doc-index', name: '文档索引', transportLabel: '标准输入输出', statusLabel: '已开启' },
    { id: 'task-catalog', name: '任务目录', transportLabel: '流式 HTTP', statusLabel: '已关闭' },
    { id: 'local-materials', name: '本地资料', transportLabel: '标准输入输出', statusLabel: '加载中' },
    { id: 'team-notes', name: '团队笔记', transportLabel: '流式 HTTP', statusLabel: '连接失败', errorMessage: '连接超时，请重试' },
  ],
  en: [
    { id: 'doc-index', name: 'Document index', transportLabel: 'stdio', statusLabel: 'Enabled' },
    { id: 'task-catalog', name: 'Task catalog', transportLabel: 'Streamable HTTP', statusLabel: 'Disabled' },
    { id: 'local-materials', name: 'Local materials', transportLabel: 'stdio', statusLabel: 'Loading' },
    { id: 'team-notes', name: 'Team notes', transportLabel: 'Streamable HTTP', statusLabel: 'Connection failed', errorMessage: 'Connection timed out. Try again.' },
  ],
} satisfies Record<PreviewLocale, Array<NonNullable<McpCenterViewProps['servers']>[number] & { errorMessage?: string }>>

const translations = new Map([
  ['MCP 中心', 'MCP Center'],
  ['搜索名称或服务标识…', 'Search by name or service ID…'],
  ['搜索 MCP 服务…', 'Search MCP servers…'],
  ['全部 4', 'All 4'],
  ['已开启 1', 'Enabled 1'],
  ['已关闭 1', 'Disabled 1'],
  ['加载中 1', 'Loading 1'],
  ['失败 1', 'Failed 1'],
  ['刷新状态', 'Refresh status'],
  ['连接配置预览', 'Connection configuration'],
  ['只读预览，凭据与敏感参数已隐藏。', 'Read-only preview. Credentials and sensitive values are hidden.'],
  ['刷新预览', 'Refresh preview'],
  ['已注册工具', 'Registered tools'],
  ['列出示例文档', 'List sample documents'],
  ['关闭', 'Turn off'],
  ['开启', 'Turn on'],
  ['重连', 'Reconnect'],
  ['正在加载 MCP 服务…', 'Loading MCP servers…'],
  ['还没有配置任何 MCP 服务', 'No MCP servers have been configured'],
  ['MCP 服务列表加载失败，请重试', 'Could not load MCP servers. Try again.'],
  ['开关即时生效。展开条目可预览连接配置和已注册工具。', 'Toggles take effect immediately. Expand a server to view connection settings and registered tools.'],
])

// The compiler leaves English entries marked TODO. Apply the preview
// translations independently so recompilation can replace the generated files.
const english: typeof zh = { ...en }
for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
  const value: string = zh[key]
  english[key] = translations.get(value) ?? (/\p{Script=Han}/u.test(value) ? en[key] : value)
}

export const previewLabels = { zh, en: english }

export function previewServers(locale: PreviewLocale, query: string) {
  const search = query.trim().toLocaleLowerCase()
  const rows = servers[locale].map((server, previewRowIndex) => ({ ...server, previewRowIndex }))
  if (!search) return rows
  return rows.filter(server => [server.id, server.name]
    .some(text => text.toLocaleLowerCase().includes(search)))
}
