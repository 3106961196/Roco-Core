/**
 * 灵蛋所孵蛋查询 — HTTP GET /egg-size/{size×100}-{weight×100}，解析 SSR 表格
 * 源站：https://luokewangguofudan.wiki/（无需登录）
 */
const DEFAULT_BASE = 'https://luokewangguofudan.wiki'
const FETCH_MS = 15_000
const USER_AGENT =
  'Mozilla/5.0 (compatible; XRK-AGT-Roco/1.0; +https://github.com/) AppleWebKit/537.36'

/** 尺寸/重量 → 路径段（×100 后取整） */
export function toEggSizeSlug(size, weight) {
  const s = Math.round(Number(size) * 100)
  const w = Math.round(Number(weight) * 100)
  if (!Number.isFinite(s) || !Number.isFinite(w) || s < 1 || w < 1) {
    throw new Error('尺寸或重量无效')
  }
  return `${s}-${w}`
}

export function buildHatchUrl(size, weight, baseUrl = DEFAULT_BASE) {
  const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '')
  return `${base}/egg-size/${toEggSizeSlug(size, weight)}`
}

/**
 * 解析蛋体查询页结果表（span / a 两种名称节点）
 * @returns {{ name: string, attrs: string, sizeRange: string, weightRange: string, percent: string, score: number }[]}
 */
export function parseHatchHtml(html) {
  if (!html || typeof html !== 'string') return []

  const rowRe =
    /<(?:span|a)\b[^>]*class="[^"]*min-w-0 truncate[^"]*"[^>]*>([^<]+)<\/(?:span|a)>[\s\S]*?<td class="py-4 pr-4 text-muted-foreground">([^<]*)<\/td>[\s\S]*?<td class="py-4 pr-4 text-muted-foreground">([\d.]+-[\d.]+)<!-- --> 米<\/td>[\s\S]*?<td class="py-4 pr-4 text-muted-foreground">([\d.]+-[\d.]+)<!-- --> 千克<\/td>[\s\S]*?>([\d.]+%)<\/td>/g

  const seen = new Set()
  const rows = []
  let m
  while ((m = rowRe.exec(html))) {
    const name = m[1].trim()
    const key = `${name}|${m[5]}`
    if (!name || seen.has(key)) continue
    seen.add(key)
    const percent = m[5]
    rows.push({
      name,
      attrs: m[2].trim(),
      sizeRange: m[3],
      weightRange: m[4],
      percent,
      score: Number.parseFloat(percent) || 0,
    })
  }
  return rows
}

/**
 * @param {number|string} size 米
 * @param {number|string} weight 千克
 * @param {{ baseUrl?: string }} [opts]
 */
export async function queryHatch(size, weight, opts = {}) {
  const sizeNum = Number(size)
  const weightNum = Number(weight)
  if (!Number.isFinite(sizeNum) || !Number.isFinite(weightNum)) {
    throw new Error('请输入有效的尺寸（米）和重量（千克）')
  }
  if (sizeNum <= 0 || weightNum <= 0) {
    throw new Error('尺寸和重量须为正数')
  }

  const url = buildHatchUrl(sizeNum, weightNum, opts.baseUrl)
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(FETCH_MS),
    redirect: 'follow',
  })

  if (!res.ok) {
    throw new Error(`查询失败 HTTP ${res.status}`)
  }

  const html = await res.text()
  const pets = parseHatchHtml(html)
  return {
    size: sizeNum,
    weight: weightNum,
    url,
    pets,
  }
}

/** 文本回复 */
export function formatHatchText(result) {
  const { size, weight, pets, url } = result
  const head = `孵蛋查询 ${size} m · ${weight} kg`
  if (!pets.length) {
    return `${head}\n未匹配到候选精灵\n${url}`
  }
  const lines = pets.map((p, i) => {
    const attrs = p.attrs ? `（${p.attrs}）` : ''
    return `${i + 1}. ${p.name} ${p.percent}${attrs}\n   ${p.sizeRange} m · ${p.weightRange} kg`
  })
  return `${head}\n共 ${pets.length} 只候选：\n${lines.join('\n')}\n来源：灵蛋所`
}
