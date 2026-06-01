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
| `#远行商人状态` | 查看系统状态与订阅状态 | 管理员 |
| `#强制刷新远行人` | 清除缓存并强制刷新 | 管理员 |
| `#远行商人订阅` | 订阅自动推送 | 管理员 |
| `#远行商人取消订阅` | 取消订阅 | 管理员 |
| `#远行商人订阅列表` | 查看所有订阅 | 管理员 |
| `#远行商人推送测试` | 测试推送功能 | 管理员 |

### 智能检测系统

- 每轮开始后有 `delayMinutes`（默认1分钟）等待期，等待期内不检测，避免官方刷新延迟
- 等待期结束后每分钟检测一次，成功即停，最多重试 30 次
- 智能缓存（30 分钟有效期），缓存命中秒级响应
- 闭市时段（0:00-8:00）自动跳过检测与推送

### 自动推送

- 订阅后每轮商人刷新自动推送商品信息
- 支持群聊和私聊订阅
- 推送冷却机制，防止重复推送

### 渲染优化

- 渲染完成后自动清理临时 HTML 文件，避免框架定时清理冲突
- 图标按需下载：本地缓存优先，缺失时从页面 URL 下载（B站 wiki 域名白名单）
- 历史商品智能显示：
  - 闭市时段（0:00-8:00）：仅显示昨日已过期商品
  - 第 1 轮：本轮商品 + 昨日已过期 + 今日已过时商品
  - 第 2~4 轮：本轮商品 + 今日已过时商品
  - 当前轮次已有的商品不会重复出现在历史区域

***

## 前置要求

- Node.js >= 24.13.0
- XRK-AGT 框架已正确配置
- Playwright 浏览器已安装（Chromium）

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



## 许可证

MIT License
