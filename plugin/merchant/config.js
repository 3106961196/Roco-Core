/**
 * Roco 业务配置 — CommonConfigRegistry（init 已先于 Core 加载）
 */
import CommonConfigRegistry from '#infrastructure/commonconfig/loader.js'

function inst() {
  return CommonConfigRegistry.get('roco')
}

/** 预热缓存（插件 init 调用一次即可） */
export async function ensureRocoConfig() {
  return inst().read()
}

function cfg() {
  return inst()._cache
}

export function isMerchantEnabled() {
  return cfg().enabled
}

export function getMerchantUrl() {
  return cfg().sourceUrl
}

export function isPushEnabled() {
  return cfg().pushEnabled
}

/** 配置中的推送 QQ 群号（去空、转字符串） */
export function getPushGroupIds() {
  return (cfg().pushGroupIds || []).map(String).map((s) => s.trim()).filter(Boolean)
}

export function getUIConfig() {
  const c = cfg()
  return { imageQuality: c.imageQuality, format: c.imageFormat }
}
