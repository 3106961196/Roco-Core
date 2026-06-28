import { getBeijingTime } from './time-utils.js'
import { getProductStore } from './db/product-store.js'
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
const EXPECTED_TIME_LABELS = [
  '08:00-12:00',
  '12:00-16:00',
  '16:00-20:00',
  '20:00-24:00',
]

/**
 * 判断昨日缓存是否已完整（4 个时段都有非空商品）
 * 注意：buildHistoryGroupsFromSlots 现在始终保留 4 个 slot（即使空），
 * 所以这里必须检查每个 slot 都有非空 products，避免被空组骗过
 */
export function isYesterdayHistoryComplete(yesterdayData) {
  if (!yesterdayData) return false
  const groups = yesterdayData.historyGroups || []
  const byLabel = new Map(groups.map(g => [g.timeLabel, g]))

  for (const expected of EXPECTED_TIME_LABELS) {
    const g = byLabel.get(expected)
    if (!g || !g.products || g.products.length === 0) {
      return false
    }
  }
  return true
}

/**
 * 判定一个商品是否属于「昨日」（基于 expireTimestamp 或 slotIndices 兜底）
 * - 有 expireTimestamp：必须在昨日时间范围 [yesterdayStart, yesterdayEnd] 内
 * - 无 expireTimestamp：用 slotIndices 兜底（与今日 buildHistoryGroupsFromSlots 一致）
 */
function isYesterdayProduct(product, yesterdayStart, yesterdayEnd) {
  if (product.expireTimestamp && product.expireTimestamp > 0) {
    return product.expireTimestamp >= yesterdayStart && product.expireTimestamp <= yesterdayEnd
  }
  // 兜底：没有 expireTimestamp 但 slotIndices 标记了昨日的某个 slot
  // 只要有 slotIndices 就认为是昨日商品（页面 DOM 上此时仍残留昨日的 show_N class）
  if (product.slotIndices && product.slotIndices.length > 0) {
    return true
  }
  return false
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

  // MongoDB 兜底：当前爬取可能不完整（机器人昨日只跑过部分轮次导致页面残留不全），
  // 从 MongoDB 补齐缺失 slot 的商品，确保昨日 4 个时段都齐全
  // 注意：兜底放在 newGroups.length 检查之前，因为 crawl() 抓不到不代表 MongoDB 也没有
  const yesterdayDateStr = yesterday.format('YYYY-MM-DD')
  const filledLabels = new Set(newGroups.map(g => g.timeLabel))
  for (const expected of EXPECTED_TIME_LABELS) {
    if (filledLabels.has(expected)) continue
    if (existingLabels.has(expected)) continue
    try {
      const slotIdx = EXPECTED_TIME_LABELS.indexOf(expected) + 1
      const docs = await getProductStore().getByDateAndRound(yesterdayDateStr, slotIdx)
      if (docs && docs.length > 0) {
        newGroups.push({
          timeLabel: expected,
          statusLabel: '已结束',
          products: docs.map(d => ({
            name: d.name,
            price: d.price,
            buyLimit: d.buyLimit || '-',
          })),
        })
        logger.mark(`[${LOG_TAG}] MongoDB 兜底补齐 ${expected}：${docs.length} 个商品`)
      }
    } catch (e) {
      logger.debug(`[${LOG_TAG}] MongoDB 兜底 ${expected} 失败: ${e.message}`)
    }
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
