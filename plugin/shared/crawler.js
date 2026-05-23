import CacheManager from './cache.js'
import BrowserManager from './browser.js'
import IconManager from './icon-manager.js'
import { getBeijingTime, shouldDetectNow, getRoundInfo } from './time-utils.js'
import { getMerchantConfig, getDetectionConfig } from './config.js'

const LOG_TAG = '洛克王国-远行商人'

class MerchantCrawler {
  constructor() {
    const detectionConfig = getDetectionConfig()
    const merchantConfig = getMerchantConfig()

    this.cache = new CacheManager()
    this.browserManager = new BrowserManager()
    this.iconManager = new IconManager()

    this.merchantUrl = merchantConfig.dataSources[0]?.url || ''
    this.detectionInterval = (detectionConfig.intervalSeconds || 60) * 1000
    this.maxRetries = detectionConfig.maxRetries || 30

    this.isDetecting = false
    this.detectionTimer = null
    this.onDetectionSuccess = null
  }

  async init() {
    this.iconManager.copyBaseAssets()
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

      // 当前可见商品
      const visibleProducts = allProducts.filter(p => p.isVisible)

      // 按时段分组构建历史数据
      const historyGroups = buildHistoryGroupsFromSlots(allProducts, rawData.timeInfo)

      const parsed = {
        success: true,
        date: getBeijingTime().format('YYYY-MM-DD'),
        roundInfo,
        productCount: visibleProducts.length,
        products: visibleProducts.map(p => ({
          name: p.name,
          icon: p.icon || '',   // 保留icon URL用于图标下载，不写入缓存
          price: p.price,
          buyLimit: p.buyLimit || '-',
        })),
        historyGroups,
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

            const isVisible = li.style.display !== 'none'

            let status = 'unknown'
            if (timeText === '已结束') status = 'ended'
            else if (timeText.match(/^\d{2}:\d{2}:\d{2}$/)) status = 'active'

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

        return result
      })

      logger.mark(`[${LOG_TAG}] 提取到 ${data.products.length} 个商品 (DOM元素: ${data.debug?.totalLis || 0})`)
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

      if (data.success && data.productCount > 0) {
        // 写入缓存时剥离icon字段（图标已本地缓存，通过商品名查找）
        const cacheData = {
          ...data,
          products: data.products.map(p => ({ name: p.name, price: p.price, buyLimit: p.buyLimit })),
          historyGroups: data.historyGroups.map(g => ({
            timeLabel: g.timeLabel,
            statusLabel: g.statusLabel,
            products: g.products.map(p => ({ name: p.name, price: p.price, buyLimit: p.buyLimit })),
          })),
        }
        await this.cache.setToday(cacheData)
        this.cache.batchAppendToHistory(data.products.map(p => ({
          name: p.name,
          price: p.price,
          buyLimit: p.buyLimit,
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
 * 页面上有4个时段(show_1~show_4)，每个商品通过 slotIndices 数组关联到所属时段
 * 一个商品可以属于多个时段（如网兜球在所有时段都有）
 */
function buildHistoryGroupsFromSlots(allProducts, timeInfo) {
  const slots = timeInfo?.allSlots || []
  if (slots.length === 0) return []

  const currentSlotIndex = timeInfo?.currentIndex || -1
  const groups = []

  for (const slot of slots) {
    const slotProducts = allProducts.filter(p => {
      // 商品通过 slotIndices 数组关联到时段
      return p.slotIndices && p.slotIndices.includes(slot.index)
    })

    const isCurrentSlot = slot.index === currentSlotIndex
    const isEnded = slot.index < currentSlotIndex
    const isUpcoming = slot.index > currentSlotIndex

    if (slotProducts.length === 0 && !isCurrentSlot) continue

    groups.push({
      timeLabel: slot.timeLabel,
      statusLabel: isEnded ? '已结束' : isUpcoming ? '未开始' : '当前',
      products: slotProducts.map(p => ({
        name: p.name,
        icon: p.icon || '',
        price: p.price,
        buyLimit: p.buyLimit,
      })),
    })
  }

  return groups
}
