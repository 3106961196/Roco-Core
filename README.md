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
| `#远行商人订阅` / `#远行商人预约` | 订阅自动推送 | 群内可用 |
| `#远行商人取消订阅` | 取消订阅 | 管理员 |
| `#远行商人订阅列表` | 查看所有订阅 | 管理员 |
| `#远行商人推送测试` | 测试推送功能 | 管理员 |

### 孵蛋查询

数据源：[灵蛋所](https://luokewangguofudan.wiki/)（HTTP，无需登录）。

| 指令 | 说明 |
|------|------|
| `#孵蛋 尺寸 重量` | 按米 / 千克查询可能孵化的精灵 Top 候选 |
| `#生蛋 精灵名` | 列出同蛋组可配对精灵 |
| `#生蛋 精灵A 精灵B` | 检查两只能否配对 |
| `#孵蛋` / `#生蛋` / `#孵蛋帮助` | 用法说明 |

例：`#孵蛋 0.28 2.36` · `#生蛋 喵喵` · `#生蛋 喵喵 火花`

配置项：`hatchEnabled`、`hatchBaseUrl`（见 `default/roco.yaml`）。
蛋组数据从站点脚本提取后缓存到 `data/Roco-data/hatch/egg-group-pets.json`（24h）。

### 自动推送

- 配置 `pushGroupIds` + 指令预约；cron 见 `roco-merchant.js`
- 支持群聊和私聊预约

***

## 前置要求

- Node.js >= 24.13.0
- XRK-AGT 框架已正确配置
- Playwright 浏览器已安装（Chromium）

***



## 项目结构

```
Roco-Core/
├── commonconfig/roco.js           # 配置 schema
├── default/roco.yaml              # 默认模板 → data/Roco-data/roco.yaml
├── plugin/
│   ├── roco-merchant.js           # 远行商人
│   ├── roco-hatch.js              # 孵蛋查询
│   ├── merchant/                  # 商人抓取/渲染/配置
│   └── hatch/
│       ├── query.js               # 尺寸重量孵蛋
│       ├── egg-groups.js          # 蛋组数据缓存
│       └── egg-group-query.js     # 蛋组/配对查询
├── workflow/merchant.js
└── resources/远行商人/             # 商人渲染模板（勿改结构）
```

***

## 许可证

MIT License
