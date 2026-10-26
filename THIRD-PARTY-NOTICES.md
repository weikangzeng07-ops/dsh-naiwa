# 第三方声明 / Third-Party Notices

本插件包含三部分授权状况不同的内容，必须分别对待。

---

## 1. vendored 记账内核 — MIT（可自由使用）

`lib/accounting.mjs` 是 **dsh-whale-widget v0.4.2** 的 `lib/accounting.mjs` 的逐字副本，仅在最前面加了一段来源说明注释。

- 上游项目：https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget
- 许可证：MIT
- 版权：Copyright (c) 2026 MeteorNOX

### MIT 全文

```
MIT License

Copyright (c) 2026 MeteorNOX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**本插件对该模块的使用方式**：只调用其中的纯函数（`daySummary` / `balanceSummary` /
`accountingDays` / `bookBreakdown` / `beijingDay` / `dayOffset` / `preciseMoney` /
`sumMoney`）。两个会修改传入对象的导出（`observeBalance` / `reconcileBalance`）
**从未被调用** —— dsh-naiwa 对账本只有读操作。

上游 `assets/**` 与 `icon.png` **不是** MIT，本插件没有复制其中任何文件。

---

## 2. 奶蛙角色素材 — ⚠️ 未授权（分发前必须解决）

以下文件来自 [jiasjdia/naiwa](https://github.com/jiasjdia/naiwa)：

| 文件 | 数量 | 字节 |
| --- | --- | --- |
| `assets/frames/f0001.webp` … `f0432.webp` | 432 | 6,968,110 |
| `assets/eyes/backing.png` | 1 | 1,054,144 |
| `assets/eyes/pupil.png` | 1 | 490,841 |
| `assets/eyes/geometry.json` | 1 | 133 |
| `assets/audio/laugh.mp3`（用户提供） | 1 | 82,381 |
| `assets/audio/laugh-synced.wav`（用户 MP3 + 上游录音缺失头尾重建） | 1 | 2,768,608 |
| `assets/manifest.json` | 1 | 12,537 |
| ~~`assets/audio/laugh.wav`~~ | — | 不直接分发；其 2.632s 尾段拼入 `laugh-synced.wav`，见 `assets/audio/README.md` |

### 授权现状

用 `git ls-files` 核实：**naiwa 仓库根目录没有 `LICENSE`、`COPYING` 或 `NOTICE`**。
仓库里唯一的 MIT 文件是 `licenses/reference-naiwa-MIT.txt`（Copyright (c) 2026
timerring），它覆盖的是**另一个**参考项目 `timerring/codex-pet-naiwa`，明确不覆盖
本仓库。`THIRD_PARTY_NOTICES.md` 中写着「角色动画和音频来自本项目现有素材」，
并未给出任何再分发许可条款。

按 GitHub 默认规则，这些素材本身是 **保留所有权利（all rights reserved）**。

### 本仓库的实际授权状态

**项目所有者已声明取得素材许可**（2026-10-24，用户在会话中明确表示
「我已经获得了素材许可」，并指示直接使用仓库内素材）。因此在本仓库 / 本项目
范围内，上述 naiwa 素材按**已获许可**使用。

这条授权来自项目所有者与上游作者之间的约定，**不随本仓库的 MIT 代码许可一起
传递给第三方**。如果你把这份插件再分发给别人，需要自行确认素材授权是否覆盖
你的分发场景。

引擎本身不关心像素来源 —— 替换素材只需保持文件名与尺寸约定
（`frames/f0001..f0432.webp` 为 320×305 RGBA，`eyes/` 两张 PNG，
`audio/laugh-synced.wav` 为 14.4196s / 48kHz / stereo / 16-bit PCM）。
`audio/laugh.mp3` 是用户提供的源录音，不直接播放。

### 上游眼部素材说明

`assets/eyes/README.md`（上游）说明这两张 PNG 是用 imagegen 工具、以项目自身
`大笑/frame_00001.png` 为视觉参考生成的。版权归属同上。

---

## 3. 物理常量来源 — Munk2D / Chipmunk2D，MIT

本插件的物理常量（重力系数、弹性系数、摩擦、damping 语义、sleep 阈值、
collision slop 等）取自 naiwa 通过 pymunk 7.3.1 使用的 Munk2D 引擎行为。
Munk2D 的 MIT 许可原文见同目录 `licenses-munk2d.txt`。

- 上游：https://github.com/jiasjdia/naiwa/blob/main/licenses/Munk2D-LICENSE.txt
- 版本：Munk2D 2.0.1，commit `ade7ed72849e60289eefb7a41e79ae6322fefaf3`

本插件**没有**包含 Munk2D 代码；只参考了其公开的常量与积分语义，并在
`src/10-physics.js` 中独立实现了一个顺序冲量求解器。

---

## 4. 本插件原创内容 — MIT

以下内容为本次开发原创，采用 MIT（全文见 `LICENSE`）：

- `lib/index.js`、`lib/ledger.mjs`、`lib/accounting-adapter.mjs`
- `src/**/*.js` 与生成的 `lib/client.js`
- `tools/build.mjs`、`tools/gen-click-sound.mjs`
- `icon.svg`（原创绘制）
- `assets/audio/click.wav`（由 `tools/gen-click-sound.mjs` 合成，不含任何第三方音频）
- `assets/audio/README.md`（音轨来源、裁剪点与同步契约说明）
