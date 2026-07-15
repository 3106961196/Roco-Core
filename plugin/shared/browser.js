import RendererLoader from '#infrastructure/renderer/loader.js'
import { getBrowserConfig } from './config.js'

const LOG_TAG = '[RocoCore-Browser]'

/**
 * 浏览器管理器 - 复用框架渲染器的浏览器实例
 * 不再自建 Playwright 浏览器进程，而是通过 RendererLoader 获取框架已启动的浏览器
 */
class BrowserManager {
  constructor() {
    this._renderer = null
    this._warnedExePath = false
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

    if (!renderer) {
      throw new Error('框架渲染器未加载，请检查 src/renderers/ 下是否配置了 puppeteer 或 playwright')
    }

    if (renderer?.browser?.isConnected?.()) {
      return renderer.browser
    }

    if (renderer?.browserInit) {
      await renderer.browserInit()
      if (renderer.browser) {
        logger.debug(`${LOG_TAG} 已通过框架渲染器启动浏览器`)
        return renderer.browser
      }
    }

    // 提示：merchant.browser.executablePath 仅作为配置项占位提示，
    // 真实生效位置是 src/renderers/puppeteer|playwright/config.yaml 的 chromiumPath
    const exePath = getBrowserConfig()?.executablePath
    if (exePath && !this._warnedExePath) {
      logger.warn(`${LOG_TAG} merchant.browser.executablePath 已配置但本插件不直接使用，请把 ${exePath} 写入框架渲染器配置(puppeteer/playwright.config.yaml)的 chromiumPath 字段`)
      this._warnedExePath = true
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
