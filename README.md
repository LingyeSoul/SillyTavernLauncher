# SillyTavern Launcher

[![License](https://img.shields.io/github/license/LingyeSoul/SillyTavernLauncher)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/LingyeSoul/SillyTavernLauncher)](https://github.com/LingyeSoul/SillyTavernLauncher/releases)

一个现代化的GUI启动器，用于管理[SillyTavern](https://github.com/SillyTavern/SillyTavern)的安装、配置和运行。


## 功能特性

- **一键安装**：从GitHub克隆仓库并自动安装依赖项
- **环境管理**：
  - 支持使用系统已安装的Git/Node.js
  - 提供懒人包模式（可直接将git和nodejs解压到env目录）
- **服务控制**：启动/停止SillyTavern服务并实时查看终端输出
- **智能更新**：支持从GitHub更新核心程序和依赖项
- **扩展支持**：通过内置Git工具安装扩展插件
- **镜像加速**：提供国内GitHub镜像源切换功能提升下载速度
- **网络配置**：支持局域网访问设置和端口自定义

## 技术栈

- **Python 3.9+** - 核心编程语言
- **Flet框架** - GUI开发
- **Git** - 版本控制与仓库管理
- **Node.js 18+** - 运行SillyTavern服务端

## 打包要求

```bash
# 安装Flet依赖
pip install flet ruamel.yaml packaging pyinstaller

# 运行build.bat打包
```

## 快速开始

1. 下载release中的压缩包解压
2. 安装Git和Node.js
3. 双击运行sillytavernlauncher.exe
