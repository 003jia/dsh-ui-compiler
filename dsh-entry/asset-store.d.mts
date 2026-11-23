/** Types for the project asset store used by the compiler overlay. */
export interface ProjectConfig {
  designDir: string
  assetDir: string
  configured?: boolean
}
export interface SavedAsset {
  id: string
  path: string
  name: string
  mimeType: string
  bytes: number
  sha256: string
}
export interface FoundAsset {
  id: string
  path: string
  name: string
  mimeType: string
  bytes: Uint8Array
}
export const DEFAULT_DESIGN_DIR: string
export const DEFAULT_ASSET_DIR: string
export const CONFIG_FILE: string
export function normalizeDirectory(value: string | undefined, fallback: string): string
export function readProjectConfig(workspaceRoot: string): Promise<ProjectConfig>
export function writeProjectConfig(workspaceRoot: string, input: Partial<ProjectConfig>): Promise<ProjectConfig>
export function saveAsset(
  workspaceRoot: string,
  assetDir: string,
  input: { name: string; mimeType: string; bytes: Uint8Array },
): Promise<SavedAsset>
export function findAsset(workspaceRoot: string, assetDir: string, id: string): Promise<FoundAsset | undefined>
export function textExcerpt(bytes: Uint8Array): string
export function assetDataUrl(mimeType: string, bytes: Uint8Array): string | undefined
export function visionMime(mimeType: string): boolean
export function mimeForName(name: string): string
