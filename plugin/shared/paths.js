import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import frameworkPaths from '../../../../src/utils/paths.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Core 根目录: core/Roco-Core/
const BASE_DIR = path.resolve(__dirname, '../..')

// 数据目录统一放在框架 data/Roco-data/ 下
const DATA_DIR = path.join(frameworkPaths.data, 'Roco-data')
const CACHE_DIR = path.join(DATA_DIR, 'cache')
const ICON_CACHE_DIR = path.join(CACHE_DIR, 'icons')
const MERCHANT_CACHE_DIR = path.join(CACHE_DIR, 'merchant')
const SUBSCRIPTION_DIR = path.join(DATA_DIR, 'subscription')

export const PATHS = {
  BASE_DIR,
  DATA_DIR,
  CACHE_DIR,
  ICON_CACHE_DIR,
  MERCHANT_CACHE_DIR,
  SUBSCRIPTION_DIR,
}

export function ensureDirs() {
  const dirs = [
    PATHS.DATA_DIR,
    PATHS.CACHE_DIR,
    PATHS.ICON_CACHE_DIR,
    PATHS.MERCHANT_CACHE_DIR,
    PATHS.SUBSCRIPTION_DIR,
  ]

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}
