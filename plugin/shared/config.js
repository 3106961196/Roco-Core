import YAML from 'yaml'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createLogger } from './logger.js'

const LOG_TAG = '洛克王国-远行商人'
const logger = createLogger()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CONFIG_PATH = path.resolve(__dirname, '../../config/roco.yaml')

const DEFAULT_CONFIG = {
  merchant: {
    dataSources: [{
      type: 'web',
      url: 'https://www.onebiji.com/hykb_tools/comm/lkwgmerchant/preview.php?id=1&immgj=0&imm=1',
      refreshTimes: ['08:00', '12:00', '16:00', '20:00'],
    }],
    detection: {
      intervalSeconds: 60,
      maxRetries: 30,
      delayMinutes: 1,
    },
    push: {
      enabled: true,
      cooldownSeconds: 300,
      maxRetries: 3,
      retryDelaySeconds: 10,
    },
    subscription: {
      maxSubscriptionsPerTarget: 1,
      autoCleanupDays: 30,
    },
    cache: {
      enabled: true,
      ttl: 1800,
      maxHistoryRecords: 100,
    },
    ui: {
      width: 820,
      imageQuality: 90,
      format: 'jpeg',
    },
    browser: {
      headless: true,
      executablePath: '',
    },
  },
  global: {
    debug: false,
    logLevel: 'info',
  },
}

function deepMerge(target, source) {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = YAML.parse(raw)
    if (!parsed || !parsed.roco) {
      return DEFAULT_CONFIG
    }
    return deepMerge(DEFAULT_CONFIG, parsed.roco)
  } catch (error) {
    logger.warn(`[${LOG_TAG}] 读取配置失败，使用默认配置: ${error.message}`)
    return DEFAULT_CONFIG
  }
}

const config = loadConfig()

export function getConfig() {
  return config
}

export function getMerchantConfig() {
  return config.merchant
}

export function getBrowserConfig() {
  return {
    headless: config.merchant.browser?.headless ?? true,
    executablePath: config.merchant.browser?.executablePath || '',
  }
}

export function getCacheConfig() {
  return config.merchant.cache
}

export function getUIConfig() {
  return config.merchant.ui
}

export function getDetectionConfig() {
  return config.merchant.detection
}

export function getPushConfig() {
  return config.merchant.push || { enabled: false }
}

export function getSubscriptionConfig() {
  return config.merchant.subscription || { maxSubscriptionsPerTarget: 1, autoCleanupDays: 30 }
}

export function isDebug() {
  return config.global.debug
}

export default config
