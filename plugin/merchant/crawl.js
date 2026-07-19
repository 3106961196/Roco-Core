/**
 * 远行商人抓取 — 对齐 lkwg.js：
 * buildBrowserRuntime + PlaywrightAgentSession + DOM extractShelf
 */
import { sleep } from '#utils/common.js'
import RuntimeUtil from '#utils/runtime-util.js'
import {
  buildBrowserRuntime,
  PlaywrightAgentSession,
} from '#infrastructure/crawl/index.js'
import { sqliteKvGet, sqliteKvSet } from '#infrastructure/sqlite.js'
import { getMerchantUrl } from './config.js'

const LOG_TAG = '远行商人'
const SOURCE_NAME = '好游快爆'
const GOTO = { waitUntil: 'load', timeoutMs: 60_000 }
const SETTLE_MS = 1500
const CACHE_SQLITE_NS = 'roco-merchant'

export const MERCHANT_SLOTS = [
  { key: '08-12', label: '08:00-12:00', previewHour: 9, endHour: 12, showN: 1 },
  { key: '12-16', label: '12:00-16:00', previewHour: 13, endHour: 16, showN: 2 },
  { key: '16-20', label: '16:00-20:00', previewHour: 17, endHour: 20, showN: 3 },
  { key: '20-24', label: '20:00-24:00', previewHour: 21, endHour: 24, showN: 4 },
]

/** 0–8：站点仍展示昨晚 20–24，业务强制空货 */
export const OVERNIGHT_SLOT = {
  key: '00-08',
  label: '00:00-08:00',
  previewHour: 4,
  endHour: 8,
  showN: 0,
  overnight: true,
}

const POPUP_HIDE_SELECTORS = [
  '#shop_rules', '#shop_info', '#shop_tip', '#iwgc_dialog_bg',
  '.fixed-top', '.t-pop', '.p-pop', '.dialog-base',
  '#kbtool_come_back_next_dlg', '#dialog_version',
  '#dialog_other_place_login', '[id^="tyfx_dialog_"]',
]

const cacheKvKey = (dayK) => `dayExclusive:${dayK}`

/** 启动参数走 crawl `buildBrowserRuntime` */
export function sessionLaunchOpts(overrides = {}) {
  const rt = buildBrowserRuntime(overrides)
  return {
    browserType: rt.browserType,
    headless: rt.headless,
    wsEndpoint: rt.wsEndpoint,
    executablePath: rt.executablePath,
    launchTimeoutMs: rt.launchTimeoutMs,
    launchArgs: rt.launchArgs,
    deviceScaleFactor: rt.deviceScaleFactor,
    viewport: rt.viewport,
  }
}

export function getCurrentSlot(now = new Date()) {
  const h = now.getHours()
  if (h < 8) return OVERNIGHT_SLOT
  return MERCHANT_SLOTS.find((s) => h < s.endHour) || MERCHANT_SLOTS.at(-1)
}

export function isOvernightSlot(slot) {
  return !!(slot && (slot.overnight || slot.key === '00-08'))
}

export function dayKey(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function yesterdayDate(now = new Date()) {
  const d = new Date(now)
  d.setDate(d.getDate() - 1)
  d.setHours(12, 0, 0, 0)
  return d
}

/** 0–12 用昨日专属缓存；之后用今日已结束档 */
export function useYesterdayExclusiveCache(now = new Date()) {
  return now.getHours() < 12
}

async function dismissMerchantOverlays(page) {
  await page.evaluate((selectors) => {
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.setProperty('display', 'none', 'important')
        el.style.setProperty('visibility', 'hidden', 'important')
      })
    }
    try {
      const ver = typeof version !== 'undefined' ? String(version) : 'v1'
      localStorage.setItem('lkwgmerchant_shop_rules_version', ver)
    } catch { /* ignore */ }
    if (typeof hide_dialog === 'function') {
      hide_dialog('shop_rules')
      hide_dialog('shop_info')
      hide_dialog('shop_tip')
      hide_dialog()
    }
    if (window.kb_dialog?.close) window.kb_dialog.close()
    window.show_dialog_new = () => {}
    if (window.kb_dialog) window.kb_dialog.open = () => {}
  }, POPUP_HIDE_SELECTORS)
}

/**
 * 从 DOM 提取货架（对齐 lkwg extractShelfFromDom）
 * @param {import('playwright').Page} page
 * @param {number} showN
 */
export async function extractShelfFromDom(page, showN) {
  return page.evaluate((slotN) => {
    const isVisible = (el) => {
      if (!el) return false
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    const tip = document.querySelector('.shop-box .shop-list > li.show_none_tip')
    const tipVisible = isVisible(tip)
    const slotFlags = (cls) =>
      [1, 2, 3, 4].filter((n) => new RegExp(`(?:^|\\s)show_${n}(?:\\s|$)`).test(cls))

    const reSlot = new RegExp(`(?:^|\\s)show_${slotN}(?:\\s|$)`)
    const lis = [...document.querySelectorAll('.shop-box .shop-list > li')].filter(
      (li) => !li.classList.contains('show_none_tip') && reSlot.test(li.className),
    )

    const items = []
    const seen = new Set()
    for (const li of lis) {
      if (!isVisible(li)) continue
      const t = (li.innerText || '').replace(/\s+/g, ' ').trim()
      const m = t.match(/限购\s*(\d+)\s*(.+?)\s*价格\s*[：:]\s*(\d+[wW万]?)/)
      if (!m) continue
      const limit = Number(m[1])
      const name = String(m[2] || '').trim()
      const price = String(m[3] || '').trim()
      if (!name || !price || !Number.isFinite(limit)) continue
      const key = `${limit}|${name}|${price}`
      if (seen.has(key)) continue
      seen.add(key)
      const slots = slotFlags(li.className)
      const allDay = slots.length === 4
      const img = li.querySelector('.gitem img, .sp-img img, img')
      const icon = String(img?.currentSrc || img?.src || img?.getAttribute('src') || '').trim()
      items.push({
        limit,
        name,
        price,
        ended: /已结束/.test(t),
        allDay,
        slots,
        icon,
        isRecommended: li.classList.contains('on'),
      })
    }

    const allDayItems = items.filter((it) => it.allDay)
    const exclusiveItems = items.filter((it) => !it.allDay)
    const liveExclusiveItems = exclusiveItems.filter((it) => !it.ended)
    const active = document.querySelector('.time-box li.on, .time-list li.on')
    const activeCheck = String(active?.className || '').match(/check_(\d)/)

    return {
      showN: slotN,
      tipVisible,
      activeCheckN: activeCheck ? Number(activeCheck[1]) : null,
      items,
      itemCount: items.length,
      allDayCount: allDayItems.length,
      exclusiveCount: exclusiveItems.length,
      liveExclusiveCount: liveExclusiveItems.length,
      exclusiveItems,
      liveExclusiveItems,
      allDayItems,
      onlyAllDay: items.length > 0 && exclusiveItems.length === 0,
    }
  }, showN)
}

export function isPushReadyShelf(shelf) {
  if (!shelf || shelf.tipVisible) return false
  if (shelf.onlyAllDay) return false
  const live = shelf.liveExclusiveCount ?? 0
  if (live < 1) return false
  if (!shelf.items?.length) return false
  return shelf.items.every((it) => it.name && it.price && Number.isFinite(it.limit))
}

function itemsFingerprint(items) {
  return items
    .map((it) => `${it.limit}|${it.name}|${it.price}|${it.allDay ? 'A' : 'E'}|${it.ended ? '1' : '0'}`)
    .sort()
    .join(';')
}

/** @param {import('#infrastructure/crawl/playwright-session.js').PlaywrightAgentSession} session */
export async function loadSlotSnapshot(session, slot) {
  const base = getMerchantUrl()
  await session.goto(`${base}&hour=${slot.previewHour}`, GOTO)
  await sleep(SETTLE_MS)
  await dismissMerchantOverlays(session.page)
  const shelf = await extractShelfFromDom(session.page, slot.showN)
  const ready = isPushReadyShelf(shelf)
  return {
    ...shelf,
    ready,
    fingerprint: ready ? itemsFingerprint(shelf.items) : '',
  }
}

async function iconToDataUrl(url) {
  const u = String(url || '').trim()
  if (!u) return ''
  const abs = u.startsWith('data:') ? u : u.startsWith('//') ? `https:${u}` : u
  if (abs.startsWith('data:')) return abs
  try {
    const res = await fetch(abs, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return abs
    const buf = Buffer.from(await res.arrayBuffer())
    const ct = String(res.headers.get('content-type') || 'image/png').split(';')[0].trim() || 'image/png'
    return `data:${ct};base64,${buf.toBase64()}`
  } catch {
    return abs
  }
}

async function materializeItemIcons(items) {
  const out = []
  for (const it of items || []) {
    out.push({ ...it, icon: await iconToDataUrl(it.icon) })
  }
  return out
}

function exclusiveItemsOnly(snap) {
  return (snap?.exclusiveItems || [])
    .filter((it) => it?.name && !it.allDay)
    .map((it) => ({
      name: it.name,
      icon: it.icon || '',
      limit: it.limit,
      price: it.price || '',
      isRecommended: !!it.isRecommended,
    }))
}

function saveExclusiveCache(dayK, slots) {
  const payload = { dayKey: dayK, cachedAt: new Date().toISOString(), slots }
  if (!globalThis.sqlite?.isOpen) {
    RuntimeUtil.makeLog('warn', 'SQLite 未就绪，跳过专属缓存写入', LOG_TAG)
    return payload
  }
  try {
    sqliteKvSet(CACHE_SQLITE_NS, cacheKvKey(dayK), JSON.stringify(payload))
  } catch (e) {
    RuntimeUtil.makeLog('warn', `SQLite 缓存写入失败: ${e?.message || e}`, LOG_TAG)
  }
  return payload
}

function loadExclusiveCache(dayK) {
  if (!globalThis.sqlite?.isOpen) return null
  try {
    const raw = sqliteKvGet(CACHE_SQLITE_NS, cacheKvKey(dayK))
    if (!raw) return null
    return JSON.parse(raw)
  } catch (e) {
    RuntimeUtil.makeLog('warn', `SQLite 缓存读取失败: ${e?.message || e}`, LOG_TAG)
    return null
  }
}

export function loadExclusiveCacheRows(dayLike) {
  const dayK = dayKey(dayLike instanceof Date ? dayLike : new Date(dayLike))
  const cached = loadExclusiveCache(dayK)
  if (!cached?.slots?.length) return []
  return cached.slots
    .map((s) => ({
      key: s.key,
      label: s.label || MERCHANT_SLOTS.find((x) => x.key === s.key)?.label || s.key,
      items: (s.items || []).filter((it) => it?.name),
    }))
    .filter((r) => r.items.length)
}

/** 23:58：四档专属货 → SQLite */
export async function cacheTodayExclusiveSlots(now = new Date()) {
  const dayK = dayKey(now)
  const slots = []
  await PlaywrightAgentSession.using(sessionLaunchOpts(), async (session) => {
    for (const s of MERCHANT_SLOTS) {
      const items = exclusiveItemsOnly(await loadSlotSnapshot(session, s))
      slots.push({
        key: s.key,
        label: s.label,
        items: items.length ? await materializeItemIcons(items) : [],
      })
    }
  })
  saveExclusiveCache(dayK, slots)
  const total = slots.reduce((n, s) => n + s.items.length, 0)
  RuntimeUtil.makeLog('mark', `已缓存 ${dayK} 四档专属货共 ${total} 件`, LOG_TAG)
  return slots
}

function pastSlots(now = new Date()) {
  const h = now.getHours()
  if (h < 8) return []
  return MERCHANT_SLOTS.filter((s) => h >= s.endHour)
}

async function collectExpiredRows(session, now = new Date()) {
  const rows = []
  for (const s of pastSlots(now)) {
    const items = exclusiveItemsOnly(await loadSlotSnapshot(session, s))
    if (!items.length) continue
    rows.push({ key: s.key, label: s.label, items: await materializeItemIcons(items) })
  }
  return rows
}

export async function resolveExpiredRows(session, now = new Date()) {
  if (useYesterdayExclusiveCache(now)) {
    const rows = loadExclusiveCacheRows(yesterdayDate(now))
    return rows
  }
  return collectExpiredRows(session, now)
}

/**
 * 查询当前货架 + 过往专属（供渲染）
 * @returns {Promise<{ slot, shelf, expiredRows, overnight: boolean }>}
 */
export async function fetchMerchantViewData(now = new Date()) {
  const slot = getCurrentSlot(now)
  if (isOvernightSlot(slot)) {
    return {
      slot,
      overnight: true,
      shelf: { items: [], ready: false, tipVisible: true },
      expiredRows: loadExclusiveCacheRows(yesterdayDate(now)),
      source: SOURCE_NAME,
    }
  }

  return PlaywrightAgentSession.using(sessionLaunchOpts(), async (session) => {
    const shelf = await loadSlotSnapshot(session, slot)
    const expiredRows = await resolveExpiredRows(session, now)
    return {
      slot,
      overnight: false,
      shelf: {
        ...shelf,
        items: await materializeItemIcons(shelf.items || []),
      },
      expiredRows,
      source: SOURCE_NAME,
    }
  })
}

/** 推送前轮询，直到货架稳定（对齐 lkwg waitForCompleteStableShelf，简化版） */
export async function waitForReadyShelf(slot, {
  pollMs = 120_000,
  confirmMs = 45_000,
  stableStreak = 2,
} = {}) {
  const deadline = (() => {
    const d = new Date()
    d.setSeconds(0, 0)
    if (slot.endHour === 24) d.setHours(23, 59, 0, 0)
    else d.setHours(slot.endHour, 0, 0, 0)
    return d.getTime() - 60_000
  })()

  let streak = 0
  let lastFp = ''
  let nextWait = pollMs

  while (Date.now() < deadline) {
    try {
      const snap = await PlaywrightAgentSession.using(sessionLaunchOpts(), async (session) => {
        const s = await loadSlotSnapshot(session, slot)
        if (!s.ready || !s.fingerprint) return { ready: false, snap: s }
        return { ready: true, snap: s }
      })

      if (snap.ready && snap.snap.fingerprint) {
        if (snap.snap.fingerprint === lastFp) streak += 1
        else {
          lastFp = snap.snap.fingerprint
          streak = 1
        }
        RuntimeUtil.makeLog(
          'mark',
          `${slot.label} 可推送，稳定 ${streak}/${stableStreak}`,
          LOG_TAG,
        )
        if (streak >= stableStreak) {
          const view = await fetchMerchantViewData()
          return view
        }
        nextWait = confirmMs
      } else {
        streak = 0
        lastFp = ''
        nextWait = pollMs
        RuntimeUtil.makeLog('mark', `${slot.label} 未就绪，稍后重试`, LOG_TAG)
      }
    } catch (err) {
      streak = 0
      lastFp = ''
      nextWait = 60_000
      RuntimeUtil.makeLog('warn', `${slot.label} 刷新失败: ${err?.message || err}`, LOG_TAG)
    }

    const remain = deadline - Date.now()
    if (remain <= 0) break
    await sleep(Math.min(nextWait, remain))
  }
  return null
}
