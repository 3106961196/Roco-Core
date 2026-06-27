import { getBeijingTime } from './time-utils.js'
import { createLogger } from './logger.js'

const LOG_TAG = '洛克王国-远行商人'
const logger = createLogger()

/**
 * 补抓服务 - 0:00-8:00 闭市时段补齐昨日缺失的轮次数据
 *
 * 触发场景：机器人重启 / 某天第 4 轮挂掉 / 浏览器崩溃等导致昨日 historyGroups 不完整
 * 时机：0:00 闭市后定时跑一次（用 _lastBackfillDate 去重，每天只一次）
 * 策略：
 *   1. 读取昨日缓存，统计 historyGroups 中已有的时段标签
 *   2. 调用 crawler.crawl() 抓取当日页面（0:00 时页面里昨日的 4 轮商品还在 DOM 中）
 *   3. 从抓取结果中筛出 status='ended' 且 expireTimestamp 属于昨日范围的商品
 *   4. 按 timeText 归属到对应时段分组，合并到昨日缓存
 *   5. 不触发 onDetectionSuccess（补抓不应推送）
 */

const REFRESH_TIMES = ['08:00', '12:00', '16:00', '20:00']

/**
 * 判断昨日缓存是否已完整（4 个时段都有）
 */
export function isYesterdayHistoryComplete(yesterdayData) {
  if (!yesterdayData) return false
  const groups = yesterdayData.historyGroups || []
  if (groups.length < 4) return false
  return groups.some(g => g.timeLabel === '20:00-24:00' || g.timeLabel === '20:00-23:59')
}

/**
 * 判定一个商品是否属于「昨日」（基于 expireTimestamp）
 */
function isYesterdayProduct(product, yesterdayStart, yesterdayEnd) {
  if (!product.expireTimestamp || product.expireTimestamp <= 0) return false
  return product.expireTimestamp >= yesterdayStart && product.expireTimestamp <= yesterdayEnd
}

/**
 * 判定一个商品归属到昨日的哪个时段
 * 优先用 slotIndices；fallback 到 timeText
 */
function resolveYesterdaySlot(product, yesterdayData) {
  if (product.slotIndices && product.slotIndices.length > 0) {
    return product.slotIndices[0]
  }
  // fallback: timeText 是 "HH:MM:SS" 格式的剩余时间，无法反推起始时段
  return null
}

/**
 * 补抓昨日缺失的轮次数据
 *
 * @param {object} deps
 * @param {object} deps.crawler - MerchantCrawler 实例（提供 crawl() 和 cache）
 * @returns {Promise<{skipped: boolean, reason?: string, added: number, total: number}>}
 */
export async function backfillYesterday({ crawler }) {
  const today = getBeijingTime()
  const yesterday = today.clone().subtract(1, 'day')

  const yesterdayData = crawler.cache.getYesterday()
  if (isYesterdayHistoryComplete(yesterdayData)) {
    return { skipped: true, reason: '昨日缓存已完整', added: 0, total: yesterdayData?.historyGroups?.length || 0 }
  }

  let crawlData
  try {
    crawlData = await crawler.crawl()
  } catch (error) {
    logger.warn(`[${LOG_TAG}] 补抓失败（爬取异常）: ${error.message}`)
    return { skipped: true, reason: `爬取失败: ${error.message}`, added: 0, total: 0 }
  }

  const allProducts = crawlData?.products || []
  if (allProducts.length === 0) {
    return { skipped: true, reason: '页面无商品数据', added: 0, total: 0 }
  }

  // 昨日时间范围：[yesterday 00:00:00, yesterday 23:59:59]
  const yesterdayStart = yesterday.clone().startOf('day').valueOf()
  const yesterdayEnd = yesterday.clone().endOf('day').valueOf()

  // 收集昨日已存在的时段标签，避免重复写入
  const existingLabels = new Set(
    (yesterdayData?.historyGroups || []).map(g => g.timeLabel)
  )

  // 按 slotIndex 聚合昨日商品
  const bySlot = new Map()
  for (const p of allProducts) {
    if (!isYesterdayProduct(p, yesterdayStart, yesterdayEnd)) continue

    const slotIdx = resolveYesterdaySlot(p, yesterdayData)
    if (slotIdx === null) continue

    if (!bySlot.has(slotIdx)) bySlot.set(slotIdx, [])
    bySlot.get(slotIdx).push(p)
  }

  // 构造新分组
  const newGroups = []
  const sortedSlotIndices = [...bySlot.keys()].sort((a, b) => a - b)
  for (const slotIdx of sortedSlotIndices) {
    if (slotIdx < 1 || slotIdx > REFRESH_TIMES.length) continue
    const startTime = REFRESH_TIMES[slotIdx - 1]
    const endTime = slotIdx < REFRESH_TIMES.length
      ? REFRESH_TIMES[slotIdx]
      : '24:00'
    const timeLabel = `${startTime}-${endTime}`

    if (existingLabels.has(timeLabel)) continue

    const products = bySlot.get(slotIdx)
    newGroups.push({
      timeLabel,
      statusLabel: '已结束',
      products: products.map(p => ({
        name: p.name,
        price: p.price,
        buyLimit: p.buyLimit || '-',
      })),
    })
  }

  if (newGroups.length === 0) {
    return { skipped: true, reason: '无可补齐的昨日时段', added: 0, total: yesterdayData?.historyGroups?.length || 0 }
  }

  // 合并到昨日缓存并写回
  const mergedGroups = [
    ...(yesterdayData?.historyGroups || []),
    ...newGroups,
  ].sort((a, b) => a.timeLabel.localeCompare(b.timeLabel))

  const merged = {
    ...(yesterdayData || {}),
    historyGroups: mergedGroups,
    _backfilledAt: Date.now(),
  }

  try {
    await crawler.cache.setYesterday(merged)
    logger.mark(`[${LOG_TAG}] 补抓昨日 ${newGroups.length} 个时段，共 ${newGroups.reduce((s, g) => s + g.products.length, 0)} 个商品`)
    return { skipped: false, added: newGroups.length, total: mergedGroups.length }
  } catch (error) {
    logger.error(`[${LOG_TAG}] 写入补抓缓存失败: ${error.message}`)
    return { skipped: true, reason: `写入失败: ${error.message}`, added: 0, total: 0 }
  }
}
