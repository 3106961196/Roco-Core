import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js'
import PluginsLoader from '#infrastructure/plugins/loader.js'
import { EventNormalizer } from '#utils/event-normalizer.js'
import { actionAck } from '#utils/chat-user-visible-ack.js'
import RuntimeUtil from '#utils/runtime-util.js'

const DEFAULT_COMMAND = '#远行商人'
const LOG_TAG = 'merchant-workflow'

/**
 * 复用当前会话 e，代发插件指令（user_id 用触发者，避免 ignoreSelf 丢弃 bot 自身消息）
 */
function createCommandEventFromSession(e, command) {
  const selfId = String(e?.self_id ?? e?.bot?.self_id ?? e?.bot?.uin ?? '').trim()
  const userId = String(e?.user_id ?? e?.sender?.user_id ?? '').trim()
  if (!selfId) throw new Error('无法解析机器人 QQ(self_id)')
  if (!userId) throw new Error('无法解析当前发言者 QQ(user_id)')

  const text = String(command ?? '').trim()
  if (!text) throw new Error('指令不能为空')

  const isGroup = !!(e?.isGroup || e?.group_id)
  const time = Math.floor(Date.now() / 1000)
  const sender = e?.sender && typeof e.sender === 'object'
    ? { ...e.sender, user_id: userId }
    : { user_id: userId, nickname: '用户', card: '用户', role: 'member' }

  const tasker = e?.tasker || 'onebot'
  const event = {
    tasker,
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    self_id: selfId,
    user_id: userId,
    time,
    message_id: `ai_cmd_${Date.now()}`,
    message: [{ type: 'text', text }],
    raw_message: text,
    isOneBot: true,
    isMaster: e?.isMaster === true,
    isGroup,
    isPrivate: !isGroup,
    sender,
    bot: e?.bot,
    group: e?.group,
    friend: e?.friend,
    reply: typeof e?.reply === 'function' ? e.reply : null,
  }

  if (isGroup) event.group_id = e.group_id

  EventNormalizer.normalize(event)
  EventNormalizer.normalizeOneBot(event, `${tasker}.message`)
  return event
}

/**
 * 远行商人触发工作流 — 供 AI 助手 mergeStreams 合并
 */
export default class MerchantStream extends AiWorkflow {
  constructor() {
    super({
      name: 'merchant',
      description: '远行商人:在当前会话代发 #远行商人 等插件指令',
      version: '1.0.2',
      author: 'XRK',
      priority: 50,
      capabilities: ['tools'],
      frameworkToolSurface: true,
      config: {
        enabled: true,
        temperature: 0.3,
        maxTokens: 1000,
      },
      embedding: { enabled: false },
    })
  }

  async init() {
    await super.init()
    this.registerAllFunctions()
  }

  registerAllFunctions() {
    this.registerMCPTool('trigger', {
      description: `在当前会话代发插件指令(等同用户自己发 ${DEFAULT_COMMAND})。默认 ${DEFAULT_COMMAND};需要参数时用 args 或整条 command。`,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: `指令正文,默认 ${DEFAULT_COMMAND}` },
          args: { type: 'string', description: '附加参数,拼在默认指令后' },
        },
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e
        if (!e) return this.errorResponse('NO_CONTEXT', '无会话上下文,无法触发')

        const base = String(args.command ?? DEFAULT_COMMAND).trim() || DEFAULT_COMMAND
        const extra = String(args.args ?? '').trim()
        const text = extra ? `${base} ${extra}` : base

        try {
          const fake = createCommandEventFromSession(e, text)
          await PluginsLoader.deal(fake)
          return this.successResponse({
            message: `已在当前会话代发:${text}`,
            userId: fake.user_id,
            ack: actionAck(`已在当前会话代发:${text}(发言者 QQ ${fake.user_id})`),
          })
        } catch (error) {
          RuntimeUtil.makeLog('error', `代发失败: ${error?.message || error}`, LOG_TAG)
          return this.errorResponse('TRIGGER_FAILED', error?.message || String(error))
        }
      },
      enabled: true,
    })
  }

  buildSystemPrompt() {
    return [
      '本工作流负责在当前会话代发远行商人指令:',
      '用户要看远行商人、商店、购买时,调用 **merchant.trigger**。',
      `默认代发 ${DEFAULT_COMMAND};带参数可填 args,或 command 写完整指令。`,
      '插件回执会发到当前群/私聊;触发后勿用文字假装已展示商品。',
    ].join('\n')
  }
}
