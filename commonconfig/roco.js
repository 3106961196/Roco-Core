/**
 * Roco 配置 — ConfigBase + default 模板落盘
 * 模板：core/Roco-Core/default/roco.yaml
 * 运行时：data/Roco-data/roco.yaml（首次 read 若不存在则 write 落盘）
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
      description: '远行商人与孵蛋查询',
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
          label: '远行商人数据源 URL',
          default: DEFAULT_URL,
          component: 'Input',
        },
        pushEnabled: {
          type: 'boolean',
          label: '启用自动推送',
          default: true,
          component: 'Switch',
        },
        pushGroupIds: {
          type: 'array',
          label: '推送 QQ 群号',
          description: '定时推送到这些群（字符串数组，如 ["123456","789012"]）',
          itemType: 'string',
          default: [],
          component: 'Tags',
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
        hatchEnabled: {
          type: 'boolean',
          label: '启用孵蛋查询',
          default: true,
          component: 'Switch',
        },
        hatchBaseUrl: {
          type: 'string',
          label: '孵蛋查询站点',
          default: 'https://luokewangguofudan.wiki',
          component: 'Input',
        },
      },
    }
  }

  /**
   * 底层 super.read 在缺文件时只从模板读进内存，不写磁盘。
   * 运行时文件不存在时 write 一次，保证 data/Roco-data/roco.yaml 真正生成。
   */
  async read(useCache = true) {
    const missing = !(await this.exists())
    const data = await super.read(useCache)
    if (missing) {
      await this.write(data, { backup: false, validate: false })
    }
    return data
  }
}
