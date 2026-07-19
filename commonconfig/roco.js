/**
 * Roco 配置 — ConfigBase + default 模板
 * 模板：core/Roco-Core/default/roco.yaml
 * 运行时：data/Roco-data/roco.yaml（由框架 init / ConfigBase 保证就绪）
 */
import ConfigBase from '#infrastructure/commonconfig/commonconfig.js'

export const DATA_ROCO_CONFIG_REL = 'data/Roco-data/roco.yaml'
export const DEFAULT_ROCO_TEMPLATE_REL = 'core/Roco-Core/default/roco.yaml'

const DEFAULT_URL =
  'https://www.onebiji.com/hykb_tools/comm/lkwgmerchant/preview.php?id=1&immgj=0&imm=1'

export default class RocoConfig extends ConfigBase {
  constructor() {
    super({
      name: 'roco',
      displayName: '洛克王国配置',
      description: '远行商人：数据源、推送与渲染',
      filePath: DATA_ROCO_CONFIG_REL,
      defaultTemplatePath: DEFAULT_ROCO_TEMPLATE_REL,
      fileType: 'yaml',
      schema: RocoConfig.schemaDefinition(),
    })
    this.defaultConfig = this.buildDefaultFromSchema()
  }

  static schemaDefinition() {
    return {
      fields: {
        enabled: {
          type: 'boolean',
          label: '启用远行商人',
          default: true,
          component: 'Switch',
        },
        sourceUrl: {
          type: 'string',
          label: '数据源 URL',
          default: DEFAULT_URL,
          component: 'Input',
        },
        pushEnabled: {
          type: 'boolean',
          label: '启用自动推送',
          default: true,
          component: 'Switch',
        },
        maxSubscriptionsPerTarget: {
          type: 'number',
          label: '单目标订阅上限',
          default: 1,
          min: 1,
          component: 'InputNumber',
        },
        imageQuality: {
          type: 'number',
          label: 'JPEG 质量',
          default: 90,
          min: 1,
          max: 100,
          component: 'InputNumber',
        },
        imageFormat: {
          type: 'string',
          label: '图片格式',
          default: 'jpeg',
          enum: ['jpeg', 'png'],
          component: 'Select',
        },
      },
    }
  }
}
