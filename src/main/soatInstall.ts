import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { extractTarGz, extractZip } from './extract'
import { download, getJson } from './net'
import { RELEASE_DIR_RE } from './soatSystem.ts'
import { renameWithRetry } from './util'

const RELEASES_URL = 'https://api.github.com/repos/blindrun/soat-miner/releases?per_page=20'
/** The command-line builds; the GUI AppImage / Setup.exe are a different program. */
const ASSET_RE = process.platform === 'win32' ? /^soat-miner_v.+_Win64\.zip$/ : /^soat-miner_v.+_Lin64\.tar\.gz$/

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
  digest: string | null
}

interface GhRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  assets: GhAsset[]
}

export interface SoatRelease {
  version: string
  name: string
  url: string
  sha256: string
  size: number
}

/** The newest stable release with a build for this OS and a published checksum. */
export async function latestSoatRelease(): Promise<SoatRelease | null> {
  if (process.platform !== 'linux' && process.platform !== 'win32') return null
  const releases = await getJson<GhRelease[]>(RELEASES_URL)
  for (const release of releases
    .filter((r) => !r.draft && !r.prerelease)
    .sort((a, b) => b.published_at.localeCompare(a.published_at))) {
    const asset = release.assets.find((a) => ASSET_RE.test(a.name))
    if (!asset?.digest?.startsWith('sha256:')) continue
    return {
      version: release.tag_name.replace(/^v/, ''),
      name: asset.name,
      url: asset.browser_download_url,
      sha256: asset.digest.slice('sha256:'.length),
      size: asset.size
    }
  }
  return null
}

/**
 * Downloads and unpacks SOAT into `minerDir/soat-miner_v<version>_<os>/`, the same layout as the
 * release archive, so its LICENSE and README travel with the binaries.
 */
export async function installSoat(
  minerDir: string,
  onProgress: (received: number, total: number) => void
): Promise<string> {
  const release = await latestSoatRelease()
  if (!release) throw new Error('No SOAT miner release for this operating system was found')
  const archive = join(minerDir, '.downloads', release.name)
  const staging = join(minerDir, `.staging-${Date.now()}`)
  try {
    await download(release.url, archive, {
      sha256: release.sha256,
      onProgress: (received, total) => onProgress(received, total || release.size)
    })
    await mkdir(staging, { recursive: true })
    if (release.name.endsWith('.zip')) await extractZip(archive, staging)
    else await extractTarGz(archive, staging)
    const top = await readdir(staging)
    if (top.length !== 1 || !RELEASE_DIR_RE.test(top[0]) || !(await stat(join(staging, top[0]))).isDirectory()) {
      throw new Error('Unexpected SOAT miner archive layout')
    }
    const target = join(minerDir, top[0])
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    await renameWithRetry(join(staging, top[0]), target)
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    await rm(join(minerDir, '.downloads'), { recursive: true, force: true })
  }
  return release.version
}
