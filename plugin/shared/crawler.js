import MerchantCache from './cache/merchant-cache.js'
import HistoryCache from './cache/history-cache.js'
import BrowserManager from './browser.js'
import IconManager from './icon-manager.js'
import PageExtractor from './page-extractor.js'
import Detector from './detector.js'
import { getBeijingTime, getRoundInfo } from './time-utils.js'
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

      // 基于时间的智能判定：当前轮次商品 = 属于当前 slot 且尚未过期
      const currentProducts = allProducts.filter(p => {
        if (!p.slotIndices || !p.slotIndices.includes(currentSlotIndex)) return false
        return p.status !== 'ended'
      })

      // 调试：输出被排除的商品信息
      if (currentProducts.length === 0 && allProducts.length > 0) {
        const excluded = allProducts.filter(p => !currentProducts.includes(p))
        logger.warn(`[${LOG_TAG}] 当前轮次(slot=${currentSlotIndex})无有效商品，共${allProducts.length}个商品被排除: ${excluded.map(p => `${p.name}(slots=${p.slotIndices},status=${p.status})`).join(', ') || '无'}`)
      }

      // 按时段分组构建历史数据
      const historyGroups = buildHistoryGroupsFromSlots(allProducts, rawData.timeInfo)

      const parsed = {
        success: true,
        date: getBeijingTime().format('YYYY-MM-DD'),
        roundInfo,
        productCount: currentProducts.length,
        products: currentProducts.map(p => ({
          name: p.name,
          icon: p.icon || '',
          price: p.price,
          buyLimit: p.buyLimit || '-',
          isRecommended: p.isRecommended || false,
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
 * 按页面时段信息分组商品
 * 页面上有4个时段(show_1~show_4)，每个商品通过 slotIndices 数组关联到所属时段
 * 一个商品可以属于多个时段（如网兜球在所有时段都有）
 *
 * 已结束时段中：排除同时属于当前时段且仍有效的商品，避免重复显示
 */
function buildHistoryGroupsFromSlots(allProducts, timeInfo) {
  const slots = timeInfo?.allSlots || []
  if (slots.length === 0) return []

  const currentSlotIndex = timeInfo?.currentIndex || -1
  const groups = []

  for (const slot of slots) {
    const isCurrentSlot = slot.index === currentSlotIndex
    const isEnded = slot.index < currentSlotIndex
    const isUpcoming = slot.index > currentSlotIndex

    const slotProducts = allProducts.filter(p => {
      if (!p.slotIndices || !p.slotIndices.includes(slot.index)) return false
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
      })),
    })
  }

  return groups
}
