import MerchantCache from './cache/merchant-cache.js'
import HistoryCache from './cache/history-cache.js'
import BrowserManager from './browser.js'
import IconManager from './icon-manager.js'
import { getBeijingTime, shouldDetectNow, getRoundInfo } from './time-utils.js'
import { getMerchantConfig, getDetectionConfig } from './config.js'
import { getProductStore } from './db/product-store.js'
import { createLogger } from './logger.js'

const LOG_TAG = '洛克王国-远行商人'
const logger = createLogger(LOG_TAG)

class MerchantCrawler {
  constructor() {
    const detectionConfig = getDetectionConfig()
    const merchantConfig = getMerchantConfig()

    this.cache = new MerchantCache()
    this.historyCache = new HistoryCache()
    this.browserManager = new BrowserManager()
    this.iconManager = new IconManager()
    this.productStore = getProductStore()

    this.merchantUrl = merchantConfig.dataSources[0]?.url || ''
    this.detectionInterval = (detectionConfig.intervalSeconds || 60) * 1000
    this.maxRetries = detectionConfig.maxRetries || 30

    this.isDetecting = false
    this.detectionTimer = null
    this.onDetectionSuccess = null
  }

  async init() {
    this.iconManager.copyBaseAssets()
    await this.productStore.init()
  }

  get browser() {
    return this.browserManager.browser
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
        // 等待商品名称渲染
        await page.waitForSelector('.shop-list li.all_show .sp-text p em', { timeout: 5000 })
      } catch (e) {
        logger.warn(`[${LOG_TAG}] 等待商品列表超时，尝试继续提取`)
      }

      // 额外等待确保JS执行完毕
      await new Promise(r => setTimeout(r, 1000))

      const rawData = await this.extractDataFromPage(page)

      const allProducts = rawData.products || []
      const roundInfo = getRoundInfo()
      const currentSlot = rawData.timeInfo?.currentSlot || '--'
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

      // 判断是否抓到当前轮次特有商品（slotIndices.length === 1 表示只属于一轮）
      // 如果所有商品都是跨多时段的，说明页面数据可能未完全加载当前轮次
      const hasSingleSlotProduct = allProducts.some(p => p.slotIndices?.length === 1)

      // 按时段分组构建历史数据
      // 注意：必须保留全部 4 个 slot（包括空 slot），否则昨日 cache 只有部分时段，
      // 渲染时「昨日已过时」会少显示组。
      const historyGroups = buildHistoryGroupsFromSlots(allProducts, rawData.timeInfo)

      const parsed = {
        success: true,
        date: getBeijingTime().format('YYYY-MM-DD'),
        roundInfo,
        productCount: currentProducts.length,
        products: currentProducts.map(p => ({
          name: p.name,
          icon: p.icon || '',   // 保留icon URL用于图标下载，不写入缓存
          price: p.price,
          buyLimit: p.buyLimit || '-',
        })),
        historyGroups,
        hasSingleSlotProduct,
        fetchedAt: getBeijingTime().format('YYYY-MM-DD HH:mm:ss'),
      }

      if (parsed.products.length > 0) {
        // 先检查缺失图标，再批量下载
        const missingIcons = parsed.products.filter(p => p.name && !this.iconManager.hasIcon(p.name))
        if (missingIcons.length > 0) {
          logger.debug(`[${LOG_TAG}] 图标缺失: ${missingIcons.length} 个，开始下载`)
        }
        await this.iconManager.batchDownloadIcons(parsed.products, 3)
        // 下载后再次检查，记录结果
        const stillMissing = parsed.products.filter(p => p.name && !this.iconManager.hasIcon(p.name))
        if (stillMissing.length > 0) {
          logger.warn(`[${LOG_TAG}] 图标下载失败: ${stillMissing.map(p => p.name).join('、')}`)
        }
      }

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

  async extractDataFromPage(page) {
    try {
      const data = await page.evaluate(() => {
        const result = {
          products: [],
          timeInfo: {},
          debug: {},
        }

        const allLis = document.querySelectorAll('.shop-list li.all_show')
        result.debug.totalLis = allLis.length

        allLis.forEach((li) => {
          try {
            if (li.classList.contains('show_none_tip')) return

            // 多种选择器尝试获取商品名
            let nameEl = li.querySelector('.sp-text p em.shop_name')
              || li.querySelector('.sp-text p em')
              || li.querySelector('.sp-text em')
              || li.querySelector('em.shop_name')

            const priceEl = li.querySelector('.sp-text div em') || li.querySelector('.sp-text em.shop_price')
            const limitEl = li.querySelector('.gitem em')
            const timeEl = li.querySelector('.datetime_show em')

            // 多种方式获取图标URL
            const imgEl = li.querySelector('.gitem img') || li.querySelector('img')
            let iconUrl = imgEl?.src || imgEl?.getAttribute('data-src') || ''
            if (!iconUrl) {
              const bgImg = li.querySelector('[style*="background-image"]')
              if (bgImg) {
                const bgMatch = bgImg.style.backgroundImage?.match(/url\(["']?(.+?)["']?\)/)
                if (bgMatch) iconUrl = bgMatch[1]
              }
            }
            // 从onclick属性提取图标URL作为后备
            if (!iconUrl && li.getAttribute('onclick')) {
              const onclickMatch = li.getAttribute('onclick').match(/showShopinfo\(['"]([^'"]+)['"]/)
              if (onclickMatch) iconUrl = onclickMatch[1]
            }

            const name = nameEl?.textContent?.trim() || ''
            const priceText = priceEl?.textContent?.trim() || ''
            const limitText = limitEl?.textContent?.trim() || ''
            const timeText = timeEl?.textContent?.trim() || ''

            // data-time: 商品到期 Unix 时间戳（秒），由服务端渲染到 li 属性上
            const dataTime = li.getAttribute('data-time')
            const expireTimestamp = dataTime ? parseInt(dataTime) * 1000 : 0

            const isVisible = li.style.display !== 'none'

            let status = 'unknown'
            if (timeText === '已结束') status = 'ended'
            else if (timeText.match(/^\d{2}:\d{2}:\d{2}$/)) status = 'active'
            // 基于 data-time 的精确判定：已过期则为 ended
            if (expireTimestamp > 0 && Date.now() >= expireTimestamp) status = 'ended'

            let price = priceText.replace('价格：', '').replace(' ', '').trim()
            if (price && !price.match(/^\d/)) price = '未知'

            let buyLimit = '-'
            const limitMatch = limitText.match(/(\d+)/)
            if (limitMatch) buyLimit = limitMatch[1]

            if (name && name.length >= 2 && name.length <= 50) {
              const product = {
                name,
                price: price || '未知',
                icon: iconUrl,
                buyLimit,
                status,
                isVisible,
                timeText,
                expireTimestamp,
                slotIndices: [],
              }

              // 收集所有 show_N class，一个商品可能属于多个时段
              for (const cls of li.classList) {
                const match = cls.match(/^show_(\d+)$/)
                if (match) {
                  product.slotIndices.push(parseInt(match[1]))
                }
              }

              result.products.push(product)
            }
          } catch (e) {
            // 单个商品解析失败不影响整体
          }
        })

        const timeListItems = document.querySelectorAll('.time-list li')
        const timeSlots = []
        let currentIndex = -1

        timeListItems.forEach((item, idx) => {
          const ems = item.querySelectorAll('em')
          if (ems.length >= 2) {
            const startTime = ems[0].textContent.trim()
            const endTime = ems[1].textContent.trim()
            timeSlots.push({
              index: idx + 1,  // 1-based，与 show_N class 对齐
              timeLabel: `${startTime}-${endTime}`,
              startTime,
              endTime,
              isActive: item.classList.contains('on'),
            })

            if (item.classList.contains('on')) {
              currentIndex = idx + 1  // 同样1-based
            }
          }
        })

        result.timeInfo = {
          currentSlot: timeSlots.find(s => s.isActive)?.timeLabel || '--',
          currentIndex,
          allSlots: timeSlots,
        }

        // 提取服务端时间基准（页面用 serverNow 变量驱动倒计时）
        if (typeof window.serverNow === 'number') {
          result.timeInfo.serverNow = window.serverNow
        }

        return result
      })

      logger.mark(`[${LOG_TAG}] 提取到 ${data.products.length} 个商品 (DOM元素: ${data.debug?.totalLis || 0})，当前时段: ${data.timeInfo?.currentIndex || '?'}，服务端时间: ${data.timeInfo?.serverNow || 'N/A'}`)
      if (data.products.length === 0 && data.debug?.totalLis > 0) {
        logger.warn(`[${LOG_TAG}] DOM有${data.debug.totalLis}个商品元素但提取0个，可能选择器不匹配`)
      }
      return data
    } catch (error) {
      logger.error(`[${LOG_TAG}] 数据提取错误: ${error.message}`)
      return { products: [], timeInfo: {} }
    }
  }

  parsePrice(priceStr) {
    if (!priceStr || priceStr === '未知') return 0

    let price = String(priceStr).trim()

    if (price.includes('w') || price.includes('W')) {
      return parseFloat(price.replace(/[wW]/, '')) * 10000
    }

    if (price.includes('万')) {
      return parseFloat(price.replace(/万/, '')) * 10000
    }

    const num = parseFloat(price)
    if (isNaN(num)) {
      logger.warn(`[${LOG_TAG}] 价格解析失败: "${priceStr}"，默认为0`)
      return 0
    }
    return num
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

      // 保留上一轮归档的「已结束」组：本次新抓的 historyGroups 不会包含前几轮商品
      // （页面 DOM 上 show_N class 已被切换），需要从旧 cache 合并
      try {
        const existing = this.cache.getToday()
        if (existing && Array.isArray(existing.historyGroups) && existing.historyGroups.length > 0) {
          const endedFromCache = existing.historyGroups.filter(g => g.statusLabel === '已结束')
          if (endedFromCache.length > 0) {
            const existingLabels = new Set((data.historyGroups || []).map(g => g.timeLabel))
            const toMerge = endedFromCache.filter(g => g.timeLabel && !existingLabels.has(g.timeLabel))
            if (toMerge.length > 0) {
              data.historyGroups = [...toMerge, ...(data.historyGroups || [])]
              logger.debug(`[${LOG_TAG}] 合并旧 cache 中 ${toMerge.length} 个已结束组`)
            }
          }
        }
      } catch (e) {
        // 合并失败不影响主流程
      }

      // 没有单轮次商品（全是跨时段商品），说明当前轮次数据未加载，判定失败
      // 调度器会在一分钟后自然重试
      if (data.success && data.productCount > 0 && !data.hasSingleSlotProduct) {
        logger.warn(`[${LOG_TAG}] 未抓到当前轮次特有商品，仅抓到跨时段商品，判定抓取失败，等待下次调度`)
        throw new Error('当前轮次商品未加载完成')
      }

      if (data.success && data.productCount > 0) {
        // 写入缓存时剥离icon字段（图标已本地缓存，通过商品名查找）
        // 保留 expireTimestamp 用于判断商品是否过期
        const cacheData = {
          ...data,
          products: data.products.map(p => ({ 
            name: p.name, 
            price: p.price, 
            buyLimit: p.buyLimit,
            expireTimestamp: p.expireTimestamp,
          })),
          historyGroups: data.historyGroups.map(g => ({
            timeLabel: g.timeLabel,
            statusLabel: g.statusLabel,
            products: g.products.map(p => ({ 
              name: p.name, 
              price: p.price, 
              buyLimit: p.buyLimit,
              expireTimestamp: p.expireTimestamp,
            })),
          })),
        }
        await this.cache.setToday(cacheData)
        this.historyCache.batchAppendToHistory(data.products.map(p => ({
          name: p.name,
          price: p.price,
          buyLimit: p.buyLimit,
        })))

        // 写入 MongoDB，每个商品只存一次，round 表示所属轮次
        // round: 1-4 表示第1-4轮，5 表示闭店时段商品，0 表示多轮次商品
        const currentRoundInfo = getRoundInfo()
        const isClosed = currentRoundInfo.status === 'closed'
        
        const productsForDB = data.products.map(p => {
          // 闭店时段抓取的商品标记为 5
          if (isClosed) {
            return {
              name: p.name,
              price: p.price,
              buyLimit: p.buyLimit,
              round: 5
            }
          }
          
          // 根据 slotIndices 判断轮次
          const slotIndices = p.slotIndices || []
          let round = 0
          if (slotIndices.length === 1) {
            round = slotIndices[0]  // 单轮次商品：1-4
          } else if (slotIndices.length > 1) {
            round = 0  // 多轮次商品
          }
          
          return {
            name: p.name,
            price: p.price,
            buyLimit: p.buyLimit,
            round: round
          }
        })
        
        await this.productStore.saveProducts(productsForDB, {
          date: data.date,
        })
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

  async startDetection() {
    if (this.isDetecting) return

    this.isDetecting = true
    let retryCount = 0

    const detect = async () => {
      if (!shouldDetectNow()) {
        this.stopDetection()
        return
      }

      retryCount++

      try {
        const data = await this.getData(true)

        if (data.success && data.productCount > 0) {
          logger.mark(`[${LOG_TAG}] 检测成功 ${data.productCount} 个商品`)
          this.stopDetection()
          // 通知外部检测成功
          if (typeof this.onDetectionSuccess === 'function') {
            this.onDetectionSuccess(data).catch(err => {
              logger.error(`[${LOG_TAG}] 检测成功回调异常: ${err.message}`)
            })
          }
          return
        }

        if (retryCount >= this.maxRetries) {
          this.stopDetection()
          return
        }

        this.detectionTimer = setTimeout(detect, this.detectionInterval)
      } catch (error) {
        logger.error(`[${LOG_TAG}] 检测异常: ${error.message}`)

        if (retryCount < this.maxRetries) {
          this.detectionTimer = setTimeout(detect, this.detectionInterval)
        } else {
          this.stopDetection()
        }
      }
    }

    detect()
  }

  stopDetection() {
    this.isDetecting = false

    if (this.detectionTimer) {
      clearTimeout(this.detectionTimer)
      this.detectionTimer = null
    }
  }

  async destroy() {
    this.stopDetection()
    await this.browserManager.close()
  }
}

export default MerchantCrawler

/**
 * 按页面时段信息分组商品
 * 根据商品的 expireTimestamp 判断它在哪一轮过期，避免多轮次商品重复显示
 */
function buildHistoryGroupsFromSlots(allProducts, timeInfo) {
  const slots = timeInfo?.allSlots || []
  if (slots.length === 0) return []

  const currentSlotIndex = timeInfo?.currentIndex || -1
  const groups = []

  // 把时间字符串 "HH:MM" 转成分钟数，方便比较
  const timeToMinutes = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number)
    return h * 60 + m
  }

  for (const slot of slots) {
    const isCurrentSlot = slot.index === currentSlotIndex
    const isEnded = slot.index < currentSlotIndex
    const isUpcoming = slot.index > currentSlotIndex

    const slotStartMin = timeToMinutes(slot.startTime)
    const slotEndMin = timeToMinutes(slot.endTime)

    // 根据过期时间判断商品属于哪个轮次
    const slotProducts = allProducts.filter(p => {
      if (!p.expireTimestamp) {
        // 没有过期时间，回退到 slotIndices
        return p.slotIndices?.includes(slot.index)
      }
      
      // 把 expireTimestamp 转成北京时间的时分
      const expireDate = getBeijingTime(p.expireTimestamp)
      const expireMin = expireDate.hour() * 60 + expireDate.minute()
      
      // 商品的过期时间落在该轮次的时间范围内 [slotStartMin, slotEndMin]
      return expireMin >= slotStartMin && expireMin <= slotEndMin
    })

    // 保留所有 slot（即使空），让 historyGroups 永远是完整 4 个组。
    // 渲染侧 renderer.prepareRenderData 内部会按 products.length > 0 过滤空组。

    groups.push({
      timeLabel: slot.timeLabel,
      statusLabel: isEnded ? '已结束' : isUpcoming ? '未开始' : '当前',
      products: slotProducts.map(p => ({
        name: p.name,
        icon: p.icon || '',
        price: p.price,
        buyLimit: p.buyLimit,
        status: p.status,
      })),
    })
  }

  return groups
}
