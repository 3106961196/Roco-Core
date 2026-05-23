import RendererLoader from '../../../../src/infrastructure/renderer/loader.js'

const LOG_TAG = '[RocoCore-Browser]'

/**
 * 浏览器管理器 - 复用框架渲染器的浏览器实例
 * 不再自建 Playwright 浏览器进程，而是通过 RendererLoader 获取框架已启动的浏览器
 */
class BrowserManager {
  constructor() {
    this._renderer = null
  }

  /**
   * 获取框架渲染器实例（懒加载）
   */
  async _getRenderer() {
    if (!this._renderer) {
      await RendererLoader.ensureLoaded()
      this._renderer = RendererLoader.getRenderer()
    }
    return this._renderer
  }

  /**
   * 获取浏览器实例
   * 优先使用框架渲染器的浏览器，若未初始化则触发初始化
   */
  async init() {
    const renderer = await this._getRenderer()

    if (renderer?.browser) {
      // 验证浏览器是否存活
      try {
        const testPage = await renderer.browser.newPage()
        await testPage.close()
        return renderer.browser
      } catch (e) {
        logger.warn(`${LOG_TAG} 渲染器浏览器不可用，尝试重新初始化: ${e.message}`)
      }
    }

    // 触发渲染器浏览器初始化
    if (renderer?.browserInit) {
      await renderer.browserInit()
      if (renderer.browser) {
        logger.debug(`${LOG_TAG} 已通过框架渲染器启动浏览器`)
        return renderer.browser
      }
    }

    throw new Error('无法获取框架渲染器浏览器实例，请检查渲染器配置')
  }

  /**
   * 获取当前浏览器实例
   */
  get browser() {
    return this._renderer?.browser || null
  }

  isRunning() {
    return this.browser !== null
  }

  /**
   * 关闭浏览器 - 不再主动关闭，由框架管理生命周期
   */
  async close() {
    // 框架渲染器的浏览器由框架管理，插件不应主动关闭
  }
}

export default BrowserManager
