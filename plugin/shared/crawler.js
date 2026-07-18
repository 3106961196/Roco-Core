import MerchantCache from './cache/merchant-cache.js'
import HistoryCache from './cache/history-cache.js'
import BrowserManager from './browser.js'
import IconManager from './icon-manager.js'
import PageExtractor from './page-extractor.js'
import Detector from './detector.js'
import moment from 'moment-timezone'
import { getBeijingTime, getRoundInfo, getRoundByExpireTime } from './time-utils.js'
import { getMerchantConfig } from './config.js'

const LOG_TAG = '洛克王国-远行商人'

class MerchantCrawler {
  constructor() {
    const merchantConfig = getMerchantConfig()

    this.cache = new MerchantCache()
    this.historyCache = new HistoryCache()
    this.browserManager = new BrowserManager()
    this.iconManager = new IconManager()
    this.pageExtractor = new PageExtractor()

    this.merchantUrl = merchantConfig.dataSources[0]?.url || ''

    // 检测器 - 负责定时检测逻辑
    this.detector = new Detector({
      fetchData: (force) => this.getData(force),
    })
  }

  async init() {
    this.iconManager.copyBaseAssets()
  }

  get browser() {
    return this.browserManager.browser
  }

  get isDetecting() {
    return this.detector.isDetecting
  }

  set onDetectionSuccess(callback) {
    this.detector.onDetectionSuccess = callback
  }

  async crawl() {
    await this.browserManager.init()

    if (!this.browserManager.isRunning()) {
      throw new Error('浏览器未初始化')
    }

    let page = null
    try {
      page = await this.browserManager.browser.newPage()
      await page.setViewport({ width: 1280, height: 800 })
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      })

      const response = await page.goto(this.merchantUrl, {
        waitUntil: 'networkidle0',
        timeout: 30000,
      })

      if (!response || response.status() !== 200) {
        throw new Error(`页面请求失败: ${response?.status()}`)
      }

      // 等待商品列表渲染完成
      try {
        await page.waitForSelector('.shop-list li.all_show', { timeout: 15000 })
        await page.waitForSelector('.shop-list li.all_show .sp-text p em', { timeout: 5000 })
      } catch (e) {
        logger.warn(`[${LOG_TAG}] 等待商品列表超时，尝试继续提取`)
      }

      // 额外等待确保JS执行完毕
      await new Promise(r => setTimeout(r, 1000))

      // 使用 PageExtractor 提取数据
      const rawData = await this.pageExtractor.extract(page)

      const allProducts = rawData.products || []
      const roundInfo = getRoundInfo()
      const currentSlotIndex = rawData.timeInfo?.currentIndex || -1

      // 基于 expireTimestamp 判定商品归属轮次：在哪一轮过期就属于哪一轮
      // 当前轮次商品 = 属于当前轮次 且 尚未过期（不限制过期日期，跨天商品也能买）
      const currentProducts = allProducts.filter(p => {
        if (!p.expireTimestamp) return false
        const expireRound = getRoundByExpireTime(p.expireTimestamp)
        if (expireRound !== roundInfo.current) return false
        return p.status !== 'ended'
      })

      // 统计当前轮次中"本轮到期"的商品数（用于检测判定）
      const currentRoundExpiringProducts = currentProducts.filter(p => {
        const expireRound = getRoundByExpireTime(p.expireTimestamp)
        return expireRound === roundInfo.current
      })

      // 调试：输出被排除的商品信息
      if (currentProducts.length === 0 && allProducts.length > 0) {
        const excluded = allProducts.filter(p => !currentProducts.includes(p))
        logger.warn(`[${LOG_TAG}] 当前轮次${roundInfo.current}无有效商品，共${allProducts.length}个商品被排除:`)
        excluded.forEach(p => {
          const expireRound = getRoundByExpireTime(p.expireTimestamp)
          const expireDate = moment(p.expireTimestamp).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm')
          const expireHour = moment(p.expireTimestamp).tz('Asia/Shanghai').hour()
          const tomorrow = getBeijingTime().add(1, 'day').format('YYYY-MM-DD')
          const isTomorrowMidnight = expireDate.startsWith(tomorrow) && expireHour === 0
          logger.warn(`  - ${p.name}: expireRound=${expireRound}, expireDate=${expireDate}, status=${p.status}, isToday=${moment(p.expireTimestamp).tz('Asia/Shanghai').format('YYYY-MM-DD') === todayDate}, isTomorrowMidnight=${isTomorrowMidnight}`)
        })
      }

      // 调试：输出商品分布
      logger.debug(`[${LOG_TAG}] 当前轮次${roundInfo.current}商品(${currentProducts.length}个): ${currentProducts.map(p => `${p.name}(expire=${p.expireTimestamp})`).join(', ') || '无'}`)

      // 按 expireTimestamp 分组构建历史数据（商品只在它过期的那一轮显示）
      const historyGroups = buildHistoryGroupsByExpireTime(allProducts, rawData.timeInfo)

      const parsed = {
        success: true,
        date: getBeijingTime().format('YYYY-MM-DD'),
        roundInfo,
        productCount: currentProducts.length,
        currentRoundExpiringCount: currentRoundExpiringProducts.length,
        products: currentProducts.map(p => ({
          name: p.name,
          icon: p.icon || '',
          price: p.price,
          buyLimit: p.buyLimit || '-',
          isRecommended: p.isRecommended || false,
          expireTimestamp: p.expireTimestamp || 0,
        })),
        historyGroups,
        fetchedAt: getBeijingTime().format('YYYY-MM-DD HH:mm:ss'),
      }

      // 图标下载由 renderer.ensureIcons 负责，此处不再处理

      return parsed

    } catch (error) {
      logger.error(`[${LOG_TAG}] 爬取失败: ${error.message}`)
      throw error
    } finally {
      if (page) {
        try { await page.close() } catch (e) { /* ignore */ }
      }
    }
  }

  async getData(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = this.cache.getToday()
      if (cached && this.cache.isValid(cached)) {
        return cached
      }
    }

    try {
      const data = await this.crawl()

      if (data.success && data.productCount > 0) {
        // 写入缓存时剥离icon字段（图标已本地缓存，通过商品名查找）
        const cacheData = {
          ...data,
          products: data.products.map(p => ({ name: p.name, price: p.price, buyLimit: p.buyLimit, isRecommended: p.isRecommended })),
          historyGroups: data.historyGroups.map(g => ({
            timeLabel: g.timeLabel,
            statusLabel: g.statusLabel,
            products: g.products.map(p => ({ name: p.name, price: p.price, buyLimit: p.buyLimit, isRecommended: p.isRecommended })),
          })),
        }
        await this.cache.setToday(cacheData)
        this.historyCache.batchAppendToHistory(data.products.map(p => ({
          name: p.name,
          price: p.price,
          buyLimit: p.buyLimit,
          isRecommended: p.isRecommended || false,
        })))
      } else {
        await this.cache.setToday(data)
      }

      return data
    } catch (error) {
      logger.error(`[${LOG_TAG}] 获取数据失败: ${error.message}`)
      const fallback = this.cache.getToday()
      if (fallback) return fallback
      return {
        success: false,
        date: getBeijingTime().format('YYYY-MM-DD'),
        roundInfo: getRoundInfo(),
        productCount: 0,
        products: [],
        historyGroups: [],
        fetchedAt: getBeijingTime().format('YYYY-MM-DD HH:mm:ss'),
        error: error.message,
      }
    }
  }

  startDetection() {
    this.detector.start()
  }

  stopDetection() {
    this.detector.stop()
  }

  async destroy() {
    this.detector.destroy()
    await this.browserManager.close()
  }
}

export default MerchantCrawler

/**
 * 按 expireTimestamp 分组商品
 * 商品在哪一轮过期就只显示在哪一轮，避免多轮次商品在每个时段重复显示
 * 只包含今天到期的商品，跨天商品不显示在历史区域
 */
function buildHistoryGroupsByExpireTime(allProducts, timeInfo) {
  const slots = timeInfo?.allSlots || []
  if (slots.length === 0) return []

  const currentSlotIndex = timeInfo?.currentIndex || -1
  const todayDate = getBeijingTime().format('YYYY-MM-DD')
  const groups = []

  for (const slot of slots) {
    const isCurrentSlot = slot.index === currentSlotIndex
    const isEnded = slot.index < currentSlotIndex
    const isUpcoming = slot.index > currentSlotIndex

    // 商品归属判定：expireTimestamp 对应的轮次 = slot.index
    const slotProducts = allProducts.filter(p => {
      if (!p.expireTimestamp) return false
      const expireRound = getRoundByExpireTime(p.expireTimestamp)
      if (expireRound !== slot.index) return false
      // 跨天商品过滤（与 currentProducts 逻辑一致）
      const expireDate = moment(p.expireTimestamp).tz('Asia/Shanghai').format('YYYY-MM-DD')
      const expireHour = moment(p.expireTimestamp).tz('Asia/Shanghai').hour()
      if (slot.index === 4) {
        const tomorrow = getBeijingTime().add(1, 'day').format('YYYY-MM-DD')
        if (expireDate !== todayDate && !(expireDate === tomorrow && expireHour === 0)) return false
      } else {
        if (expireDate !== todayDate) return false
      }
      return true
    })

    if (slotProducts.length === 0 && !isCurrentSlot) continue

    groups.push({
      timeLabel: slot.timeLabel,
      statusLabel: isEnded ? '已结束' : isUpcoming ? '未开始' : '当前',
      products: slotProducts.map(p => ({
        name: p.name,
        icon: p.icon || '',
        price: p.price,
        buyLimit: p.buyLimit,
        status: p.status,
        isRecommended: p.isRecommended || false,
        expireTimestamp: p.expireTimestamp || 0,
      })),
    })
  }

  return groups
}
