# dsh-naiwa — 奶蛙桌宠 (DSH Web 插件)

把 [naiwa](https://github.com/jiasjdia/naiwa) 奶小蛙桌面宠物移植到 DeepSeek Harness 的浏览器界面，并只读复用 `dsh-whale-widget` 的记账账本显示真实花费。

独立插件：有自己的 ID、路由、配置文件和 CSS 命名空间，可与原小鲸鱼插件分别安装、启用、禁用、卸载。

---

## 安装 / 卸载

```powershell
# 本地目录安装（开发）
dsh plugin --profile web add link:D:\dsh_harness_plugins\dsh-naiwa\dsh-naiwa-pet

# 或通过 Plugin Manager 的 install_bundle
```

卸载：

```powershell
dsh plugin --profile web remove dsh-naiwa
```

卸载**不会**影响 `dsh-whale-widget`，也不会动 `.dshw-usage.json` 账本 —— 本插件对账本只有读操作。

---

## 目录结构

```
dsh-naiwa-pet/
├── package.json            # 插件清单（dsh.bundle / dsh.client）
├── cordis.patch.yml        # 挂载声明
├── icon.svg                # 插件图标
├── locale/{zh,en}.json     # 显示元数据
├── lib/
│   ├── index.js            # 宿主端：路由、配置、账本快照
│   ├── ledger.mjs          # 只读账本读取
│   ├── accounting-adapter.mjs  # 账本 → 视图模型
│   ├── accounting.mjs      # vendored MIT 记账内核（见 THIRD-PARTY-NOTICES）
│   └── client.js           # 浏览器端产物（由 src/ 生成）
├── src/                    # 浏览器端源码
│   ├── 00-constants.js     # 与 Python 源码 1:1 的常量
│   ├── 05-client-config.js # 客户端配置规范化
│   ├── 10-physics.js       # 胶囊体物理求解器
│   ├── 20-jelly.js         # 局部 Q 弹 + 整体挤压
│   ├── 30-pet.js           # 角色实体：渲染/动画/眼睛/交互
│   ├── 40-assets.js        # 帧、眼睛、音频
│   ├── 50-group.js         # 物理循环、分裂、合体、归一、气泡、菜单
│   └── 90-client.js        # 插槽注册与引擎启动
├── assets/
│   ├── frames/f0001..f0432.webp   # 432 帧原版动画
│   ├── eyes/{backing,pupil}.png + geometry.json
│   ├── audio/laugh.mp3           # 用户提供的源录音（不直接播放）
│   ├── audio/laugh-synced.wav    # 14.4196s 对齐轨（实际播放）
│   ├── audio/click.wav           # 合成点击音
│   ├── audio/README.md           # 音轨来源、裁剪点、同步契约
│   └── manifest.json
└── tools/
    ├── build.mjs           # src/ → lib/client.js
    └── gen-click-sound.mjs # 生成点击音效
```

---

## 构建

```powershell
cd D:\dsh_harness_plugins\dsh-naiwa\dsh-naiwa-pet
node tools/build.mjs          # 重新生成 lib/client.js
node --check lib/client.js    # 语法检查
node tools/build.mjs --check  # 检查产物是否与 src/ 同步
```

`lib/client.js` 是**生成文件**，不要直接编辑；改 `src/` 后重新构建。

---

## 配置

配置文件：`%USERPROFILE%\.dsh\.dsh-naiwa-config.json`（首次运行自动创建，缺失或损坏时回落到默认值）。

```jsonc
{
  "enabled": true,
  "pet": {
    "visible": true,
    "scale": 0.6,              // 会吸附到 0.8 / 0.7 / 0.6 / 0.5 四档
    "maxPets": 40,
    "startPosition": "bottom-right",  // bottom-right | bottom-left | bottom-center | random
    "eyeFollow": true,
    "sound": true,
    "volume": 0.7,
    "randomActionMinSec": 180,
    "randomActionMaxSec": 240,
    "pauseWhenHidden": true
  },
  "bubble": {
    "enabled": true,
    "durationMs": 5000,
    "maxWidthPx": 260,
    "lines": {
      "idle":  ["奶蛙在看着你…"],
      "click": ["呱！"],
      "laugh": ["哈哈哈哈！"],
      "split": ["分身出现了！"],
      "merge": ["合体成功！"],
      "reunify": ["归位！"]
    }
  },
  "accounting": {
    "enabled": true,
    "pollSec": 20,
    "announce": true,
    "showTodayOnClick": true
  }
}
```

气泡文案支持 `{amount}` / `{today}` / `{total7}` 占位符，仅在拿到真实账本数据时替换。

---

## 操作

| 操作 | 效果 |
| --- | --- |
| 移动鼠标 | 待机时瞳孔跟随（限制 ±2.0 / ±1.5 参考像素） |
| **单击身体** | 唤出鲸鱼风**账单气泡**（今日已用 / 全部余额），5 秒后自动收起，不触发大笑 |
| **双击身体** | 触发完整有声大笑（两次点击间隔 ≤ 300ms） |
| 长按 1.5 秒后松手 | 蓄满回弹（约双倍幅度） |
| 按住拖动 | 拎起拉长，松手落地挤压回弹（画布带 30% 余量，拉伸不会裁掉身体） |
| **每轮对话结束** | 气泡自动弹出，标题显示 `本轮消耗 ¥0.xx`，5 秒后收起 |
| **单击气泡右侧 ☰** | 气泡菜单：捧腹大笑 / 全部大笑 / 停止大笑 / 停止全部大笑 / 复制分身 / 归一分身 / 编辑气泡 / 大小 / 隐藏气泡 / 隐藏奶蛙 |
| 大笑时 2 秒内点 8 次 | 喷出更小分身（重力、反弹、堆积） |
| 拖动同档身体重叠后松手 | 合体升一档（0.5+0.5→0.6，0.6+0.6→0.7，0.7+0.7→0.8） |
| 右键 | 已禁用（所有功能已收进气泡菜单） |
| Ctrl+Alt+1 | 全体大笑 |
| Ctrl+Alt+Q | 隐藏奶蛙 |

---

## 记账

账本部分仍**只读**复用 `dsh-whale-widget` 的历史记录，从不写入：

```
$DSH_HOME\.dshw-usage.json          (由 dsh-whale-widget 写入)
  → lib/ledger.mjs                  (readFileSync + mtime/size 变化检测)
  → lib/accounting.mjs              (vendored MIT 内核，纯函数)
  → lib/accounting-adapter.mjs      (视图模型)
  → GET /dsh-naiwa/api/ledger.json
  → 鲸鱼账单气泡 / 设置页「账本快照」
```

小鲸鱼插件没有运行时，账本会停在最后一次写入的数值。因此奶蛙在返回账本快照前，
还会通过 DSH 的 `deepseekAccount` 账号服务读取**当前账号余额**（充值钱包 + 赠金钱包），
并用当天的余额观测累计「今日已用」：

```
DSH 账号服务 getBalance()
  → 实时余额（覆盖旧账本的 lastBalance/currentBalance）
  → $DSH_HOME\.dsh-naiwa-account.json（当天开盘余额，跨重启保留）
  → 今日已用 = max(账本今日金额, 当天余额下降量)
```

这样可以避免小鲸鱼插件停用后余额永远停在旧值；「今日已用」从当天第一次余额观测开始累计，
Host 会在北京时间零点主动刷新一次余额作为新一天的基准。若 Host 当天启动较晚，启动前的
当日消费无法从旧账本补回；需要精确回填时应接入平台账单接口。

### 账单气泡（唯一记账界面）

旧的浮动「记账面板」和旧的左右键菜单都已删除，所有入口收进奶蛙头顶的鲸鱼气泡：

1. **单击奶蛙**：气泡出现，显示标题「奶蛙记账」、`今日已用` 和 `全部余额`；数据来自只读账本 + DSH 账号实时余额。
   气泡默认在奶蛙上方；拖到顶部放不下时翻到下方并翻转尾巴，文字保持正向。
2. **每轮对话结束**：气泡自动弹出，标题临时变成 `本轮消耗 ¥0.xx`，同时显示最新今日已用/余额；
   5 秒后自动收起，不再使用旧的提示框。
3. **☰ 菜单**（气泡右侧内嵌）：`捧腹大笑 / 全部大笑 / 停止大笑 / 停止全部大笑 / 复制分身 / 归一分身 /
   编辑气泡 / 大小 / 隐藏气泡 / 隐藏奶蛙`。菜单贴着气泡边缘出现，左边放不下时翻到右边。

气泡只在「每轮报账」和「单击唤出」时出现，默认 5 秒后自动收起；打开菜单或编辑气泡时会暂停倒计时。

**编辑气泡** 可改标题、`今日已用` / `全部余额` 两个标签、显示开关和上下顺序；输入实时预览，
保存后立即生效。外观偏好保存在浏览器 `localStorage` 的 `dsh-naiwa.accountBubble.v1`。

### 设置界面

**设置 → 奶蛙桌宠**（`settings.section`，`id: dsh-naiwa`）覆盖全部配置：启用/显示、
大小档位、初始位置、分身上限、眼神跟随、后台暂停、音效与音量、气泡开关/时长/宽度、
每种事件的气泡文案、记账开关/轮询/冒泡。保存写回 `~/.dsh/.dsh-naiwa-config.json`。
账单气泡的标题/标签/顺序则从气泡自己的 **☰ → 编辑气泡** 修改（浏览器本地保存）。

---

## 已知差异（相对原 Python 项目）

| 项目 | 原项目 | 本移植 | 原因 |
| --- | --- | --- | --- |
| 物理引擎 | pymunk 7.3.1 (Chipmunk2D) | 自写顺序冲量求解器 | 避免引入大依赖；常量 1:1 |
| 求解迭代 | 30 | 10 | 浏览器 CPU 预算；堆积形状略有差异 |
| 气泡 | 无 | 有 | 新增需求 |
| 点击音效 | 无 | 有（新生成） | 新增需求 |
| **点击行为** | 单击只做局部 Q 弹，10 次才大笑 | **单击**唤出 5 秒鲸鱼气泡；**双击**才大笑 | 用户明确要求单击出气泡、双击大笑 |
| 全局快捷键 | RegisterHotKey | 页面内 Ctrl+Alt+* | 浏览器无全局热键 |
| 鼠标穿透 | Windows 抠色 | `pointer-events` + alpha 命中 | 浏览器无逐像素穿透 |
| 眼睛跟随 | 全局光标 | 页面内光标 | 浏览器看不到页面外光标 |
| 隐藏暂停 | 从不暂停 | `visibilitychange` 暂停 | 浏览器标签页语义 |
| 音频解锁 | pygame 直接播放 | 首次交互后播放 HTMLAudioElement | 浏览器自动播放策略 |
| 大笑音轨 | 仓库 media/laugh.wav | assets/audio/laugh-synced.wav（用户 MP3 + 同一录音缺失的头尾） | 用户提供的 MP3 是 10.21s 片段，见下节 |
| 大笑音画同步 | 音轨 14.4196s = 432 帧 @30fps，天然同步 | 14.4196s 对齐轨 + playbackRate 1.0；**动画以音频 currentTime 为主时钟** | 修复片段裁剪 + 浏览器起播延迟 |
| 音频起点补偿 | outputLatencyMs=170（pygame/SDL） | AUDIO_LATENCY_MS=50（Chromium 实测 baseLatency 10 + outputLatency 40） | 170ms 在浏览器里会让画面晚 120ms |
| 克隆循环 | 从第 54 帧对应的音频位置循环 | seek 到 1.7667s，`ended` 后回到 1.7667s | 只循环动画尾段，不再重播前导静音 |

---

## 音画同步（2026-10 修复）

之前“音频快于动作”并不是因为音轨长度随便不匹配，而是因为用户提供的
`laugh.mp3` 本身就是原版 14.4196s 录音的一个片段：

- 波形互相关与参考轨在 **lag = 75,709 samples = 1.57727s** 处达到 **0.98**；
- 也就是说 MP3 把开头 **1.577s 的酝酿静音**剪掉了，并从 11.787s 的自然停顿处
  截断，少了最后 **2.632s** 的第二段笑声和收尾。

因此：

1. 直接把 MP3 从 0 播放 → 笑声比画面早 **1.58s**（原始 bug）。
2. 把 MP3 拉伸到 14.4s（旧方案 `playbackRate≈0.709`）→ 首尾长度对上了，但
   每一声笑在时间轴上仍错位，问题依旧。
3. 现在的 `assets/audio/laugh-synced.wav` 是同一演奏的原速重建：
   `1.577s 静音 + 用户 MP3 + 原录音缺失的 2.632s 尾段 = 14.4196s`，
   `playbackRate = 1.0`，不改变音调，也不改变任何一声笑的位置。
4. 播放时以 `<audio>.currentTime` 作为动画主时钟：解码/起播慢时画面会等音频，
   不会抢跑；`AUDIO_LATENCY_MS = 50` 补偿浏览器输出延迟（实测
   `baseLatency=10ms + outputLatency=40ms`；参考实现的 170ms 是 pygame/SDL 的
   缓冲，照搬会让画面晚约 120ms）。
5. 克隆体从动画第 53 帧开始，音频相应 seek 到 1.7667s，并在 `ended` 后回到
   1.7667s 循环，不再重播 1.577s 前导静音。

细节、裁剪点和重建方法见 [`assets/audio/README.md`](assets/audio/README.md)。

### 自检

打开 `http://127.0.0.1:3080/?naiwa-debug=1`，点击奶蛙后 Console 每秒输出：

```
[dsh-naiwa] sync frame=58 elapsed=1.933 audio=1.983 rate=1 paused=false
```

`frame / 30` 应比 `audio` 小约 0.05s（输出延迟）。另外启动时会输出：

```
[dsh-naiwa] audio laugh: 14.420s track vs 14.400s animation (+20 ms) -> playbackRate 1.0000, audio-clocked
```

如果换掉音轨后长度差超过 250ms，会打印 warning；此时不要再拉伸，应按
`assets/audio/README.md` 的方法重建 14.4196s 音轨。

---

## 故障排查

浏览器 Console 过滤 `[dsh-naiwa]`：

- `engine started pets=1 scale=0.6 win=<含拖动余量的画布> at=... bounds=...` — 引擎已启动
- `config unavailable, using defaults` — 宿主端路由不可达，检查宿主是否已重启
- `audio laugh: 14.420s track vs 14.400s animation (+20 ms) -> playbackRate 1.0000, audio-clocked` — 音轨长度正确，未拉伸
- `audio laugh: ... differ by more than 250 ms` — 音轨被换成了长度不匹配的版本；不要靠 playbackRate 拉伸，按 `assets/audio/README.md` 重建
- `asset unavailable: ...` — 某个素材 404，检查 `/dsh-naiwa/assets/*`
- `missing asset: ...` — 同上，去重后的报告

奶蛙不显示时按顺序检查：

1. `dsh-naiwa` 在插件管理器中为启用状态
2. `curl http://127.0.0.1:3080/dsh-naiwa/api/config.json` 返回 200
3. Console 有 `engine started`
4. Network 中 `f0001.webp?v=2` 返回 200
5. 页面上存在 `canvas.naiwa-pet` 且尺寸非零

---

## 许可证

插件代码 MIT。素材与 vendored 代码的授权情况见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
本仓库所有者已确认有权公开随包发布的 naiwa 素材；如果你要再分发，请先阅读该说明并自行确认授权范围。
