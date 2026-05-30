<div align="center">

# Roco-Core

**XRK-AGT 框架的洛克王国世界游戏辅助模块**

[![XRK-AGT](https://img.shields.io/badge/XRK--AGT-runtime-blue.svg)](https://github.com/sunflowermm/XRK-AGT)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

</div>

***

## 拉取代码

```bash
# 在 XRK-AGT 的 core 目录下执行以下命令拉取代码
git clone https://github.com/3106961196/Roco-Core.git
```

***

## 功能特性

### 远行商人查询

| 指令 | 说明 | 权限 |
|------|------|------|
| `#远行商人` | 查询当前轮次商品信息 | 所有人 |
| `#远行商` | 查询当前轮次商品信息（简写） | 所有人 |
| `#远行商人订阅状态` | 查看系统状态与订阅状态 | 所有人 |
| `#刷新商人` | 清除缓存并强制刷新 | 管理员 |
| `#强制刷新商人` | 清除缓存并强制刷新（同义） | 管理员 |
| `#远行商人订阅` | 订阅自动推送 | 管理员 |
| `#远行商人取消订阅` | 取消订阅 | 管理员 |
| `#取消远行商人订阅` | 取消订阅（同义） | 管理员 |
| `#远行商人订阅列表` | 查看所有订阅 | 管理员 |
| `#远行商人推送测试` | 测试推送功能 | 管理员 |

### 智能检测系统

- 每轮刷新后延迟 1 分钟开始检测，避免官方刷新延迟
- 每分钟检测一次，成功即停，最多重试 30 次
- 智能缓存（30 分钟有效期），缓存命中秒级响应
- 闭市时段（0:00-8:00）自动跳过检测与推送

### 自动推送

- 订阅后每轮商人刷新自动推送商品信息
- 支持群聊和私聊订阅
- 推送冷却机制，防止重复推送

### 渲染优化

- 渲染完成后自动清理临时 HTML 文件，避免框架定时清理冲突
- 图标三级加载策略：本地缓存 → 缺失记录 → wiki CDN 兜底
- 历史商品智能显示：0-12 点显示昨日商品，12 点后显示今日已过时商品

***

## 前置要求

- Node.js >= 24.13.0
- XRK-AGT 框架已正确配置
- Playwright 浏览器已安装（Chromium）

***

## 配置文件

编辑 `config/roco.yaml` 自定义设置：

```yaml
roco:
  merchant:
    detection:
      intervalSeconds: 60    # 检测间隔（秒）
      maxRetries: 30          # 最大重试次数
      delayMinutes: 1         # 刷新后延迟检测分钟数
    push:
      enabled: true           # 启用自动推送
      cooldownSeconds: 300    # 推送冷却时间（秒）
    cache:
      ttl: 1800               # 缓存时间（秒）
    ui:
      width: 820              # 渲染宽度
      imageQuality: 90        # 图片质量
```

***

## 项目结构

```
Roco-Core/
├── config/
│   └── roco.yaml                  # 配置文件
├── plugin/
│   ├── roco-merchant.js           # 远行商人主插件
│   └── shared/                    # 共享模块
│       ├── browser.js             # 浏览器管理
│       ├── cache.js               # 缓存管理
│       ├── config.js              # 配置管理
│       ├── crawler.js             # 数据爬取
│       ├── icon-manager.js        # 图标管理
│       ├── paths.js               # 路径管理
│       ├── push-service.js        # 推送服务
│       ├── subscription-manager.js # 订阅管理
│       └── time-utils.js          # 时间工具
├── resources/
│   └── 远行商人/                   # 远行商人资源
│       ├── merchant.html          # 页面模板
│       └── resources/             # 字体与图片
│           ├── fonts/             # 字体文件
│           └── images/            # 背景图、图标
└── data/
    └── cache/                     # 运行时缓存（自动生成）
        ├── merchant/              # 商人数据缓存
        └── icons/                 # 商品图标缓存
```

***

## 常见问题

**Q: 插件无法加载？**
检查 Node.js 版本 >= 24.13，查看控制台日志是否有语法错误。

**Q: 爬取失败？**
检查网络连接和 Playwright 浏览器是否正确安装，或使用 `#刷新商人` 重试。

**Q: 图片无法显示？**
检查 `resources/远行商人/resources/` 下资源文件是否完整。

**Q: 渲染图片失败？**
可能是框架定时清理冲突，已修复。确保使用最新代码并重启服务。

**Q: 图标显示为默认图片？**
首次使用时图标会异步下载，稍等片刻或再次查询即可加载本地缓存。

***

## 更新日志

### 2026-05-30

- 修复渲染图片失败问题（临时 HTML 文件清理优化）
- 优化历史商品显示逻辑（0-12 点统一显示昨日商品）
- 补充 CSS 标准属性 `line-clamp`，提升浏览器兼容性

***

## 许可证

MIT License
