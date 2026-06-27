/**
 * 日志适配层 - 遵循框架日志等级设定
 * 
 * 框架日志等级（优先级从低到高）：
 * - trace(0): 最详细的调试信息
 * - debug(1): 调试信息，开发时排查问题
 * - info/mark/success/tip(2): 一般信息，用户可见的重要操作
 * - warn(3): 警告信息，可能的问题但不影响运行
 * - error(4): 错误信息，需要关注的问题
 * - fatal(5): 致命错误，可能导致系统崩溃
 */

// 日志等级优先级映射
const LEVEL_PRIORITIES = {
  trace: 0,
  debug: 1,
  info: 2,
  mark: 2,
  success: 2,
  tip: 2,
  warn: 3,
  error: 4,
  fatal: 5
}

/**
 * 获取当前配置的日志等级
 */
function getConfigLogLevel() {
  try {
    // 尝试从框架配置读取
    const cfg = globalThis.cfg || {}
    return cfg.agt?.logging?.level || 'info'
  } catch {
    return 'info'
  }
}

/**
 * 检查是否应该输出该等级的日志
 */
function shouldLog(level) {
  const configLevel = getConfigLogLevel()
  const currentPriority = LEVEL_PRIORITIES[level] ?? 2
  const configPriority = LEVEL_PRIORITIES[configLevel] ?? 2
  return currentPriority >= configPriority
}

/**
 * 日志适配层
 */
class LoggerAdapter {
  _log(level, msg) {
    if (!shouldLog(level)) return

    const logger = globalThis.logger

    try {
      if (logger && typeof logger[level] === 'function') {
        logger[level](msg)
      } else if (logger && typeof logger.info === 'function') {
        logger.info(msg)
      } else {
        console.log(`[${level.toUpperCase()}] ${msg}`)
      }
    } catch {
      console.log(`[${level.toUpperCase()}] ${msg}`)
    }
  }

  trace(msg) { this._log('trace', msg) }
  debug(msg) { this._log('debug', msg) }
  info(msg) { this._log('info', msg) }
  mark(msg) { this._log('mark', msg) }
  success(msg) { this._log('success', msg) }
  tip(msg) { this._log('tip', msg) }
  warn(msg) { this._log('warn', msg) }
  error(msg) { this._log('error', msg) }
  fatal(msg) { this._log('fatal', msg) }
}

/**
 * 创建日志实例
 */
export function createLogger() {
  return new LoggerAdapter()
}

export default createLogger
