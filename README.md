# dsh-tray-restart

给 **DeepSeek Harness 桌面端**的托盘右键菜单加一条 **「重启 DeepSeek Harness」**。

DSH 桌面端的托盘图标右键原本只有「打开 / 退出」两项，改了插件想重载、或者开久了想重开，只能退出再双击一次图标。装上这个插件，菜单里就多一条「重启 DeepSeek Harness」：

```
打开 DeepSeek Harness
重启 DeepSeek Harness   ← 新增
─────────────
退出 DeepSeek Harness
```

点击后走的是 Electron 主进程自己的重启写法（`app.relaunch()` + 静默退出），关掉再起来，和手动重开完全一样，但不用管图标和窗口。

## 安装

**插件市场**（推荐）：在 DSH 的「插件市场」里搜 `tray-restart`，点安装，然后**重启一次 DSH**。

**命令行**：

```bash
dsh plugin install dsh-tray-restart
```

**本地 link**（开发用）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-tray-restart": "link:C:/path/to/dsh-tray-restart" }
```

装完重启 DSH，右键托盘图标就能看到「重启 DeepSeek Harness」。

> 菜单是 DSH 启动时建好的一次性对象，所以**装完必须重启一次** DSH 才会出现，之后每次启动都自动补丁。

## 工作原理

托盘菜单写死在桌面端 Electron 主进程的 `resources/app.asar` → `lib/main.js` 里：

```js
tray.setContextMenu(Menu.buildFromTemplate([
  { label: messages.openApplication, ... },
  { type: "separator" },
  { label: messages.quitApplication, ... },
]));
```

插件跑在 Host 子进程里，拿不到 Electron 的 `Menu`/`Tray`，主进程的 IPC 协议也没有「加菜单项」这种消息——所以只能在**归档层面**动手：

1. 读出 asar 头，定位 `/lib/main.js` 的字节区间；
2. 把其中 `//#region lib/types/tray.js` 整段**等长替换**，在「打开」和「退出」之间插一条
   `{ label: "重启 " + messages.aboutProduct, click: () => { app.relaunch(); quitWithoutConfirmation(); } }`；
3. 用空格补齐到与原段**完全相同的字节数**，整个 `main.js` 长度不变，asar 头里的 offset/size 全部继续有效；
4. 写完 `fsync` 并回读比对，不一致就报错并保留备份。

标签用 `"重启 " + messages.aboutProduct` 拼出来（显示为「重启 DeepSeek Harness」），和另外两条同格式，跟随产品名和界面语言，不写死中文。

## 安全性

- **等长替换**：写入前后都校验字节数，绝不改变归档结构；写后回读比对。
- **先备份**：第一次打补丁前把原始 `main.js` 存到 `~/.dsh/tray-restart/main.js.orig`。
- **认锚点，不乱动**：`main.js` 里找不到 `quitWithoutConfirmation()`、或者这段代码的形状变了（应用升级），就不动手，只写日志。
- **升级自动补回**：桌面端自动更新会覆盖 `app.asar`，插件每次启动会检查一次，发现没有补丁就自动补上。
- **可一键还原**：调用工具 `tray_restart_status`（`restore: true`）或用备份把原始 `main.js` 写回去。

## 工具

插件注册了一个工具 `tray_restart_status`：

| 参数 | 作用 |
| --- | --- |
| （无） | 查看当前补丁状态、asar 路径、main.js 大小、备份位置 |
| `apply: true` | 立刻检查并打补丁（幂等） |
| `restore: true` | 用备份还原原始菜单 |

日志：`~/.dsh/tray-restart/log.ndjson`。

## 限制

- **仅 Windows 桌面端**：托盘菜单在 Windows 的 Electron 主进程里，Web 版 / macOS / Linux 没有这段代码，插件会自动跳过（不影响启动）。
- **依赖 DSH 桌面端版本**：补丁按 `0.2.2-rc.1` 的 `lib/main.js` 锚定，`package.json` 里 `dsh.engines.dsh` 声明为 `>=0.2.2-rc.1`。之后版本如果改了这段形状，插件会报 `anchor-mismatch` 并保持原样，等适配后再发版。
- 应用更新后补丁会被覆盖，但下次启动会自动补回（也可以在更新后立刻调一次 `tray_restart_status`，传 `apply: true`）。

## 开发

```bash
git clone https://github.com/aaayeaaa-P1WS/dsh-tray-restart.git
```

主要文件：

- `index.js` — 插件入口：启动时检查/补丁、注册 `tray_restart_status` 工具
- `lib/tray-patch.mjs` — asar 读写、锚点识别、等长替换、备份/还原
- `cordis.patch.yml` — Cordis bundle 补丁（把插件插进 profile）

打补丁只做文本级等长替换，不依赖任何运行时依赖；`node --check` 可通过。

## English

Adds a **Restart** item to the DeepSeek Harness **desktop** tray menu (Windows), next to *Open* and *Quit*.

The tray menu is built once, at startup, inside the Electron main process (`resources/app.asar` → `lib/main.js`). Plugins run in the Host child process and cannot reach Electron's `Menu`/`Tray`, so this plugin patches the asar byte-for-byte: it replaces the whole `//#region lib/types/tray.js` block with an equal-length copy that inserts `{ label: "Restart " + messages.aboutProduct, click: () => { app.relaunch(); quitWithoutConfirmation(); } }`. Same length ⇒ the asar header stays valid; the original `main.js` is backed up first, the write is verified by read-back, and the patch is re-applied automatically after a desktop update.

Restart DSH once after installing for the menu to appear. Windows desktop only; DSH desktop `>= 0.2.2-rc.1`.

## License

MIT
