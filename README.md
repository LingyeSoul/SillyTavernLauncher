# SillyTavernLauncher

[![License](https://img.shields.io/github/license/LingyeSoul/SillyTavernLauncher)](LICENSE) [![GitHub release](https://img.shields.io/github/v/release/LingyeSoul/SillyTavernLauncher)](https://github.com/LingyeSoul/SillyTavernLauncher/releases)

> 🧠 **智能启动管理器** | [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的现代化 GUI 解决方案

# 📜 免责声明与合规说明
SillyTavernLauncher 仅为 SillyTavern 应用的启动管理工具（GUI 启动器），不涉及任何内容生成、提示词修改或内容审核功能，不参与主程序任何核心功能的运行，本项目本身不参与任何信息内容的生成、存储、传播环节。通过本启动器使用 SillyTavern 时，用户须严格遵守《中华人民共和国网络安全法》《生成式人工智能服务管理暂行办法》等国家相关法律法规，同时遵守 SillyTavern 主程序的用户协议，确保生成和传播的内容合法合规，严禁利用本工具规避合规要求，严禁用于生成或传播淫秽色情、暴力恐怖、赌博诈骗、造谣传谣等违法不良信息。作为工具提供方，我们不对用户通过本启动器使用 SillyTavern 所产生的任何内容承担法律责任，内容安全、信息合规等相关责任完全由用户自行承担。关于日志功能：本启动器的日志记录功能仅用于技术故障排查、运行状态监控、功能优化，日志收集的范围严格限定为 SillyTavern 软件运行层面的技术数据（如进程 ID、接口调用记录、错误代码、系统环境参数等），不主动收集任何用户的隐私信息、内容交互数据（如聊天内容）、身份信息（如账号、手机号）；日志数据默认存储在用户本地设备指定目录（启动器路径/logs/），仅保存在用户本地，本启动器不会主动上传、同步、分享日志数据至任何第三方服务器，用户可随时删除；用户使用日志功能时，应严格遵守相关法律法规，不得利用日志功能收集、存储、传播他人的隐私信息、敏感个人信息或用于非法用途。请用户在使用过程中自觉履行网络安全义务，遵守公序良俗，共同维护清朗网络环境。

## ✨ v2.0.0 新特性

- 🎨 **GPUIX 原生界面** - 基于 GPU 渲染的原生 UI 框架重构，启动更快、渲染更流畅
- ⚡ **TypeScript 全栈重写** - 从 Python/Flet 迁移到 TypeScript + React，类型安全、工程化测试
- 🧪 **完整测试体系** - Vitest 单元测试 + 真实窗口 E2E 测试
- 🔄 **局域网数据同步** - 支持多设备间数据同步，无缝切换使用环境
- ⚙️ **SillyTavern 配置管理** - 可视化管理监听端口、代理设置、白名单等
- 🧩 **扩展管理** - SillyTavern 扩展的安装与卸载

## 核心优势 💎

✅ 一键安装部署
✅ 智能环境检测
✅ 实时终端监控
✅ 国内镜像加速
✅ 局域网数据同步
✅ 扩展管理

## 界面预览 🖼️

<div align="center">
  <img src="doc/main.png" alt="主界面" width="800"/>
</div>

## 技术栈 🧰

- 🟨 **TypeScript** - 核心编程语言
- ⚛️ **React 19** - UI 组件模型
- 🎨 **GPUIX 0.9**（`@gpuix/react` / `@gpuix/native`）- GPU 渲染原生 GUI 框架
- 🥟 **Bun** - 运行时与包管理
- 🐻 **zustand** - 状态管理
- 🧪 **Vitest** - 单元测试与 E2E 测试
- 📦 **Git** - 版本控制
- 🌐 **Node.js 18+** - SillyTavern 服务运行

## 快速开始 🚀

### 方式一：使用懒人包（推荐）

在[下载地址](https://sillytavern.lingyesoul.top/start#%E4%B8%8B%E8%BD%BD%E6%B8%A0%E9%81%93)直接下载最新版本的懒人包，解压即可使用，无需配置环境。

### 方式二：使用系统环境模式

在 Release 页面下载，解压后双击 `SillyTavernLauncher.exe` 即可运行，需要系统内安装了 Git 和 Node.js 环境。

### 方式三：从源码运行

```bash
# 克隆仓库
git clone https://github.com/LingyeSoul/SillyTavernLauncher.git
cd SillyTavernLauncher/src

# 安装依赖（需要 Bun）
bun install

# 开发模式运行
bun run dev
```

> 从源码运行需要系统内安装 [Bun](https://bun.sh) 与 Git；启动 SillyTavern 需要 Node.js 18+。

## 功能特性 🌟

### 🔧 环境管理
- 自动检测系统环境（Git、Node.js）
- 支持内置环境模式（env 目录便携版）
- 智能环境缺失提示和下载引导

### 🎮 服务控制
- 一键安装 / 启动 / 停止 / 更新 SillyTavern
- 实时终端日志输出
- 自动端口检测和冲突处理

### 📦 局域网数据同步
- 支持服务器/客户端模式
- 自动设备发现和连接
- 实时同步进度显示
- 支持选择性同步（角色、聊天记录、世界观等）

### 🧩 扩展管理
- SillyTavern 扩展一键安装与卸载
- 镜像源加速下载

### 🔄 更新管理
- GitHub API 检测启动器与 SillyTavern 更新
- 镜像源切换（国内加速）
- 智能版本比较和更新日志展示

### 🎨 界面特性
- GPUIX 原生 GPU 渲染界面
- 暗色/亮色主题支持
- 欢迎向导（首次启动）
- 实时状态反馈

## 开发 🛠️

```bash
cd src

# 类型检查
bun run typecheck

# 单元测试
bunx vitest run --project unit

# E2E 测试（起真实 GPU 窗口，需本机图形环境）
bunx vitest run --project e2e
```

项目结构、代码约定与 GPUIX 平台约束详见 [AGENTS.md](AGENTS.md)。
