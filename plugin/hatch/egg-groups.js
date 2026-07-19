/**
 * 灵蛋所蛋组数据：从站点 worker 脚本提取 pets（含 eggGroups），落盘缓存
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import paths from '#utils/paths.js'
import { getHatchBaseUrl } from '../merchant/config.js'

const DEFAULT_BASE = 'https://luokewangguofudan.wiki'
const FETCH_MS = 20_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const USER_AGENT =
  'Mozilla/5.0 (compatible; XRK-AGT-Roco/1.0; +https://github.com/) AppleWebKit/537.36'

/** @type {{ loadedAt: number, generatedAt?: string, pets: object[] } | null} */
let memoryCache = null

function cacheFile() {
  return path.join(paths.data, 'Roco-data', 'hatch', 'egg-group-pets.json')
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(FETCH_MS),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

function resolveBase(baseUrl) {
  return String(baseUrl || 'https://luokewangguofudan.wiki').replace(/\/+$/, '')
}

/** 从 egg-groups 页解析当前 worker-entry 脚本 URL */
export async function resolveWorkerScriptUrl(baseUrl) {
  const base = resolveBase(baseUrl)
  const html = await fetchText(`${base}/egg-groups`)
  const m = html.match(/\/assets\/worker-entry-[A-Za-z0-9_-]+\.js/)
  if (!m) throw new Error('无法定位蛋组数据脚本')
  return new URL(m[0], base).href
}

/**
 * 从 worker 源码提取 { generatedAt, count, shinyCount, pets }
 * 数据为 JS 对象字面量（反引号字符串、!0/!1、105e3）
 */
export function extractPetsBundle(workerSource) {
  const marker = '{generatedAt:`'
  const objStart = workerSource.indexOf(marker)
  if (objStart < 0) throw new Error('脚本中未找到蛋组数据')

  let depth = 0
  let end = -1
  for (let i = objStart; i < workerSource.length; i++) {
    const ch = workerSource[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error('蛋组数据括号不匹配')

  const literal = workerSource.slice(objStart, end)
  const data = new Function(`return (${literal})`)()
  if (!data?.pets?.length) throw new Error('蛋组数据为空')
  return data
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(cacheFile(), 'utf8')
    const json = JSON.parse(raw)
    if (!json?.pets?.length || !json.loadedAt) return null
    if (Date.now() - json.loadedAt > CACHE_TTL_MS) return null
    return json
  } catch {
    return null
  }
}

async function saveToDisk(bundle) {
  const file = cacheFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(bundle), 'utf8')
}

async function fetchFresh(baseUrl) {
  const scriptUrl = await resolveWorkerScriptUrl(baseUrl)
  const source = await fetchText(scriptUrl)
  const data = extractPetsBundle(source)
  const bundle = {
    loadedAt: Date.now(),
    generatedAt: data.generatedAt,
    count: data.count,
    shinyCount: data.shinyCount,
    scriptUrl,
    pets: data.pets,
  }
  memoryCache = bundle
  await saveToDisk(bundle).catch(() => {})
  return bundle
}

/** 获取宠物列表（内存 → 磁盘 → 远程） */
export async function getEggGroupPets(opts = {}) {
  let baseUrl = opts.baseUrl
  if (!baseUrl) {
    try {
      baseUrl = getHatchBaseUrl()
    } catch {
      baseUrl = DEFAULT_BASE
    }
  }
  const force = opts.force === true

  if (!force && memoryCache?.pets?.length && Date.now() - memoryCache.loadedAt < CACHE_TTL_MS) {
    return memoryCache
  }

  if (!force) {
    const disk = await loadFromDisk()
    if (disk) {
      memoryCache = disk
      return disk
    }
  }

  return fetchFresh(baseUrl)
}

/**
 * 按名称找精灵（精确 > 子串唯一）
 * @returns {{ pet: object, ambiguous?: object[] } | null}
 */
export function findPetByName(pets, name) {
  const q = String(name || '').trim()
  if (!q) return null

  const exact = pets.filter((p) => p.name === q || p.displayKey === q)
  if (exact.length === 1) return { pet: exact[0] }
  if (exact.length > 1) return { pet: exact[0], ambiguous: exact }

  const lower = q.toLowerCase()
  const byPinyin = pets.filter((p) => p.pinyin === lower || String(p.pinyin || '').startsWith(lower))
  if (byPinyin.length === 1) return { pet: byPinyin[0] }

  const partial = pets.filter((p) => p.name.includes(q) || String(p.displayKey || '').includes(q))
  if (partial.length === 1) return { pet: partial[0] }
  if (partial.length > 1) return { pet: null, ambiguous: partial.slice(0, 12) }
  return null
}

export function eggGroupsOverlap(a, b) {
  const ga = a?.eggGroups || []
  const gb = b?.eggGroups || []
  return ga.some((g) => gb.includes(g))
}

/** 同蛋组可繁殖伙伴（含自身，与站点「122 只」口径一致） */
export function listEggGroupPartners(pets, pet) {
  const groups = pet.eggGroups || []
  return pets
    .filter((p) => (p.eggGroups || []).some((g) => groups.includes(g)))
    .sort((a, b) => a.id - b.id)
}
