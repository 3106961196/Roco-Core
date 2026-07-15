const LOG_TAG = '洛克王国-远行商人'

/**
 * 页面数据提取器 - 从DOM中提取商品和时段信息
 *
 * 职责：
 * - 解析商品列表DOM元素
 * - 提取商品名称、价格、限购、图标、推荐状态、轮次归属
 * - 提取时段列表和当前轮次
 */
class PageExtractor {
  /**
   * 从页面提取所有商品和时段数据
   * @param {Page} page - Playwright页面实例
   * @returns {Promise<{products: Array, timeInfo: object, debug: object}>}
   */
  async extract(page) {
    try {
      const data = await page.evaluate(() => {
        const result = { products: [], timeInfo: {}, debug: {} }

        // ===== 提取商品 =====
        const allLis = document.querySelectorAll('.shop-list li.all_show')
        result.debug.totalLis = allLis.length

        allLis.forEach((li) => {
          try {
            if (li.classList.contains('show_none_tip')) return

            // 提取商品名（多种选择器兜底）
            const nameEl = li.querySelector('.sp-text p em.shop_name')
              || li.querySelector('.sp-text p em')
              || li.querySelector('.sp-text em')
              || li.querySelector('em.shop_name')

            const priceEl = li.querySelector('.sp-text div em') || li.querySelector('.sp-text em.shop_price')
            const limitEl = li.querySelector('.gitem em')
            const timeEl = li.querySelector('.datetime_show em')

            // 提取图标URL（img → 背景图 → onclick兜底）
            let iconUrl = ''
            const imgEl = li.querySelector('.gitem img') || li.querySelector('img')
            iconUrl = imgEl?.src || imgEl?.getAttribute('data-src') || ''
            if (!iconUrl) {
              const bgImg = li.querySelector('[style*="background-image"]')
              if (bgImg) {
                const m = bgImg.style.backgroundImage?.match(/url\(["']?(.+?)["']?\)/)
                if (m) iconUrl = m[1]
              }
            }
            if (!iconUrl && li.getAttribute('onclick')) {
              const m = li.getAttribute('onclick').match(/showShopinfo\(['"]([^'"]+)['"]/)
              if (m) iconUrl = m[1]
            }

            const name = nameEl?.textContent?.trim() || ''
            const priceText = priceEl?.textContent?.trim() || ''
            const limitText = limitEl?.textContent?.trim() || ''
            const timeText = timeEl?.textContent?.trim() || ''

            const dataTime = li.getAttribute('data-time')
            const expireTimestamp = dataTime ? parseInt(dataTime) * 1000 : 0
            const isVisible = li.style.display !== 'none'
            const isRecommended = li.classList.contains('on')

            // 状态判定
            let status = 'unknown'
            if (timeText === '已结束') status = 'ended'
            else if (timeText.match(/^\d{2}:\d{2}:\d{2}$/)) status = 'active'
            if (expireTimestamp > 0 && Date.now() >= expireTimestamp) status = 'ended'

            // 价格解析
            let price = priceText.replace('价格：', '').replace(' ', '').trim()
            if (price && !price.match(/^\d/)) price = '未知'

            // 限购解析
            let buyLimit = '-'
            const limitMatch = limitText.match(/(\d+)/)
            if (limitMatch) buyLimit = limitMatch[1]

            if (name && name.length >= 2 && name.length <= 50) {
              // 收集所属轮次
              const slotIndices = []
              for (const cls of li.classList) {
                const m = cls.match(/^show_(\d+)$/)
                if (m) slotIndices.push(parseInt(m[1]))
              }

              result.products.push({
                name, price: price || '未知', icon: iconUrl, buyLimit,
                status, isVisible, isRecommended, timeText, expireTimestamp, slotIndices,
              })
            }
          } catch (e) { /* 单个商品解析失败不影响整体 */ }
        })

        // ===== 提取时段 =====
        const timeListItems = document.querySelectorAll('.time-list li')
        const timeSlots = []
        let currentIndex = -1

        timeListItems.forEach((item, idx) => {
          const ems = item.querySelectorAll('em')
          if (ems.length >= 2) {
            const startTime = ems[0].textContent.trim()
            const endTime = ems[1].textContent.trim()
            timeSlots.push({
              index: idx + 1,
              timeLabel: `${startTime}-${endTime}`,
              startTime, endTime,
              isActive: item.classList.contains('on'),
            })
            if (item.classList.contains('on')) currentIndex = idx + 1
          }
        })

        result.timeInfo = {
          currentSlot: timeSlots.find(s => s.isActive)?.timeLabel || '--',
          currentIndex,
          allSlots: timeSlots,
        }

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
}

export default PageExtractor
