# 3DGS-Fly

用 **DJI RC-N1 遥控器**，在电脑上「飞」你的 3D 高斯泼溅（3DGS）场景。

3DGS-Fly 是一个基于 [PlayCanvas SuperSplat](https://github.com/playcanvas/supersplat) 裁剪改造的 **3DGS 沉浸式查看器**：插上大疆 RC-N1 遥控器，就能像飞真机一样，用油门、航向、俯仰、横滚和拨轮云台巡游实景三维模型。绿色便携单文件 EXE，双击即用。

> **当前支持范围**：本版本**仅适配 DJI RC-N1 遥控器**，运行于 Windows（便携 EXE）。普通游戏手柄（Xbox / PlayStation）以及 macOS / Linux 不在当前支持范围内。

---

## 特性

- 🎮 **RC-N1 即插即用**：USB 直连，自动识别，无需装驱动；五通道全复刻（油门 / 航向 / 前后俯仰 / 左右横滚 / 拨轮云台）
- 🕹️ **真实手感**：美国手 / 日本手一键切换，6 档速度倍率（0.5x～16x），平移 / 转向 / 俯仰灵敏度独立可调，高度锁定
- 🖥️ **键鼠也能飞**：没带遥控器也能用键盘 + 鼠标完整操作
- 📸 **出片能力**：一键截屏（PNG）、一键录制视频（WebM），巡飞时随手抓画面
- 🗂️ **多格式**：支持 `.ply` / `.splat` / `.spz` / `.sog` / `.ksplat` 等主流 3DGS 格式，拖入窗口即加载

---

## 快速开始

### 直接使用（Windows 用户）

1. 下载 `release/3DGS-Fly-v1.0.0.exe`（便携单文件，无需安装）
2. 双击运行，用 USB 数据线连接 DJI RC-N1 遥控器
3. 点击「打开 / 更换 3D 场景」或直接拖入模型文件，即可飞行

> 首次打开未加载模型时，界面会显示遥控器引导图，单击引导图也能直接打开文件选择器。

### 从源码构建

环境要求：Node.js ≥ 20，npm。

```bash
# 1. 安装前端依赖
cd supersplat
npm install

# 2. 构建前端（产物输出到 supersplat/dist/）
npm run build

# 3. 安装桌面封装依赖
cd ../3DGS-Gamepad
npm install

# 4. 拷贝前端产物并打包 EXE
npm run build:exe
```

产物输出到 `3DGS-Gamepad/release/3DGS-Fly-v1.0.0.exe`。

---

## 遥控器通道映射（默认美国手 / Mode 2）

| 通道 | 方向 | 功能 |
|---|---|---|
| 左杆 上/下 | 油门 | 上升 / 下降 |
| 左杆 左/右 | 航向 | 左转 / 右转 |
| 右杆 上/下 | 俯仰 | 前进 / 后退 |
| 右杆 左/右 | 横滚 | 左移 / 右移 |
| 右上拨轮 | 云台 | 抬头 / 低头 |

菜单内可切换「日本手」（左杆俯仰+横滚、右杆油门+航向）。

---

## 键盘快捷键

| 按键 | 功能 |
|---|---|
| `ESC` | 呼出 / 收起菜单 |
| `H` | 返回起点 |
| `F` | 设置起点 |
| `R` | 云台回中 |
| `F8` | 高度锁定 |
| `F9` | 截屏 |
| `F10` | 开始 / 停止录制 |
| `F11` | 全屏 |
| `↑` / `↓` | 速度档 增减 |
| `←` / `→` | 视场角 减小 / 增大 |

---

## 目录结构

```
.
├── supersplat/          前端源码（fork 自 PlayCanvas SuperSplat，TypeScript + Rollup）
│   └── src/
│       ├── rc-n1-controller.ts       RC-N1 遥控器控制核心
│       ├── gamepad-controller.ts     键盘快捷键 + 相机动作
│       ├── gamepad-capture.ts        截屏 / 视频录制
│       └── ui/gamepad-menu.ts        底部飞行控制菜单
├── 3DGS-Gamepad/        Electron 桌面封装
│   ├── main.js          主进程：内置静态服务器（端口 3835）+ RC-N1 桥接 + IPC
│   ├── preload.js       contextBridge 桥接（saveFile / rcApi）
│   ├── rc-n1-bridge.ps1 RC-N1 串口读取桥接脚本（DJI D-UML 协议）
│   └── copy-dist.js     拷贝前端产物 + 图标
├── RC-N1-protocol.md    DJI RC-N1 D-UML 协议说明
└── README.md
```

---

## 技术栈

| 层 | 技术 |
|---|---|
| 渲染引擎 | PlayCanvas Engine |
| 3DGS 渲染 | SuperSplat（PlayCanvas 官方 3DGS 编辑器，MIT） |
| 前端构建 | TypeScript + Rollup |
| 桌面封装 | Electron |
| RC-N1 读取 | PowerShell 桥接脚本（串口 + DJI D-UML 协议） |

RC-N1 读取不依赖任何原生 npm 模块：主进程 spawn 一个 PowerShell 脚本读取串口，输出 JSON 流，渲染层订阅即可。协议细节见 [RC-N1-protocol.md](RC-N1-protocol.md)。

### 资源说明

- 视频录制走浏览器 MediaRecorder（WebM），**无需 ffmpeg**。
- EXE 图标使用 supersplat 官方 logo（由 `copy-dist.js` 自动处理）。

---

## 许可证

- 本项目的**新增代码**（`rc-n1-controller.ts`、`gamepad-menu.ts`、`rc-n1-bridge.ps1`、Electron 封装等）以 **MIT** 许可证发布，版权 © 2026 [RobLinkA](https://github.com/RobLinkA)，见 [LICENSE](LICENSE)。
- 底层基于 **SuperSplat**（Copyright © PlayCanvas Ltd.，MIT 许可证），其许可证见 [supersplat/LICENSE](supersplat/LICENSE)。

---

## 致谢

- [PlayCanvas SuperSplat](https://github.com/playcanvas/supersplat) —— 3DGS 编辑器底座
- [deviverr/DJI-RC-Emulator](https://github.com/deviverr/DJI-RC-Emulator) 与 [IvanYaky/DJI_RC-N1_SIMULATOR_FLY_DCL](https://github.com/IvanYaky/DJI_RC-N1_SIMULATOR_FLY_DCL) —— DJI RC-N1 D-UML 协议参考
