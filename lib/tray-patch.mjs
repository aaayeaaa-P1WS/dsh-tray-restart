/**
 * 给桌面端托盘右键菜单加一条「重启」。
 *
 * 背景：托盘菜单在 Electron 主进程里写死（resources/app.asar 的 lib/main.js，
 * `DesktopTray.relabel()` 一次性 setContextMenu），而 DSH 插件跑在 Host 子进程里，
 * 拿不到 Electron 的 Menu/Tray，也没有任何 IPC 能往主进程加菜单项。
 * 所以只能改 app.asar 里那一段 bundle。
 *
 * 安全性：
 *   - 只做**等长替换**：整段 `//#region lib/types/tray.js … //#endregion` 换成同字节数的新内容，
 *     文件长度不变，asar 头里的 offset/size 全部仍然有效，不需要重建归档；
 *   - Electron 的 asar 完整性校验（fuse EnableEmbeddedAsarIntegrityValidation）在本机是关的，
 *     实测可写；
 *   - 打之前把原始 lib/main.js 备份到 ~/.dsh/tray-restart/main.js.orig，可一键还原；
 *   - 认不出锚点（版本变了）就报错不动手。
 */
import fs from 'node:fs';
import path from 'node:path';

const MARKER = 'dsh-tray-restart';

const REGION_START = '//#region lib/types/tray.js\n';
const REGION_END = '//#region lib/types/background-notice.js';

/** 新版 tray region：只多了「重启」一项，其余保持原样。 */
const TEMPLATE = `//#region lib/types/tray.js
/** Windows system tray: reopen the window, restart the application, or quit. */
var DesktopTray = class {
\toptions;
\ttray;
\t/** @param options - Icon path, locale reader, and the open, restart and quit actions. */
\tconstructor(options) {
\t\tthis.options = options;
\t\tconst tray = new Tray(nativeImage.createFromPath(options.iconPath));
\t\tthis.tray = tray;
\t\ttray.on("click", () => {
\t\t\toptions.open();
\t\t});
\t\tthis.relabel();
\t}
\t/** Rebuild the tooltip and context menu in the current locale. */
\trelabel() {
\t\tconst tray = this.tray;
\t\tif (tray === void 0) return;
\t\tconst { messages } = this.options.locale();
\t\ttray.setToolTip(messages.aboutProduct);
\t\ttray.setContextMenu(Menu.buildFromTemplate([
\t\t\t{ label: messages.openApplication, click: () => { this.options.open(); } },
\t\t\t{ label: "重启 " + messages.aboutProduct, click: () => { app.relaunch(); quitWithoutConfirmation(); } },
\t\t\t{ type: "separator" },
\t\t\t{ label: messages.quitApplication, click: () => { this.options.quit(); } }
\t\t]));
\t}
\t/** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
\tdispose() {
\t\tconst tray = this.tray;
\t\tthis.tray = void 0;
\t\ttray?.destroy();
\t}
};
//#endregion ${MARKER}
`;

/**
 * Electron 的 node 会把任何以 `.asar` 结尾的路径当成「归档」来 stat/open ——
 * stat 返回 0 字节、open 直接失败。Host 子进程就是 Electron 的 node，所以这里
 * 必须临时把 `process.noAsar` 打开，按真实文件读写。
 */
function asRealFile(fn) {
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = prev;
  }
}

/**
 * 找桌面端安装目录里的 app.asar。
 * @param override - 显式指定的路径（配置项，方便以后装到别的目录）
 */
export function locateAsar(override) {
  if (override) return override;
  if (process.env.DSH_DESKTOP_APP_ASAR) return process.env.DSH_DESKTOP_APP_ASAR;
  const exe = process.execPath;
  const candidates = [];
  if (exe && /deepseek harness\.exe$/i.test(exe)) candidates.push(path.join(path.dirname(exe), 'resources', 'app.asar'));
  // Host 子进程的 argv 里带着 "...\resources\app.asar\dsh\..."，直接从它切出 asar 路径最可靠
  // （Host 的环境变量可能被裁过，LOCALAPPDATA 不一定在）。
  const argvText = [...process.argv, ...process.execArgv].join('\n');
  const fromArgv = argvText.match(/([A-Za-z]:[\\/][^\n]*?\.asar)(?=[\\/]|$)/i);
  if (fromArgv) candidates.push(fromArgv[1]);
  const local = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  if (local) candidates.push(path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'));
  for (const candidate of candidates) {
    try {
      // 读头 8 字节确认是真文件（statSync().size 在 asar 拦截下会是 0）。
      const ok = asRealFile(() => {
        const probe = fs.openSync(candidate, 'r');
        try {
          const head = Buffer.alloc(8);
          const n = fs.readSync(probe, head, 0, 8, 0);
          return n === 8 && head.readUInt32LE(4) > 0;
        } finally {
          fs.closeSync(probe);
        }
      });
      if (ok) return candidate;
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

/** 解析 asar 头，返回 { headerSize, dataOffset, entries(扁平 map), json }。 */
export function readAsarHeader(asarPath) {
  const fd = asRealFile(() => fs.openSync(asarPath, 'r'));
  try {
    const prefix = Buffer.alloc(8);
    asRealFile(() => fs.readSync(fd, prefix, 0, 8, 0));
    const headerSize = prefix.readUInt32LE(4);
    const headerBlock = Buffer.alloc(headerSize);
    asRealFile(() => fs.readSync(fd, headerBlock, 0, headerSize, 8));
    const start = headerBlock.indexOf('{"files"');
    if (start < 0) throw new Error('asar 头里找不到 JSON');
    let end = headerBlock.length;
    while (end > start && headerBlock[end - 1] === 0) end--;
    const json = JSON.parse(headerBlock.slice(start, end).toString('utf8'));
    const entries = new Map();
    const walk = (node, prefixPath) => {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const full = `${prefixPath}/${name}`;
        if (entry.files) walk(entry, full);
        else entries.set(full, entry);
      }
    };
    walk(json, '');
    const dataOffset = 8 + headerSize;
    return { fd, headerSize, dataOffset, entries, json };
  } catch (error) {
    asRealFile(() => fs.closeSync(fd));
    throw error;
  }
}

/** 把 main.js 的原始内容读出来（不含任何修改）。 */
export function readMainJs(asarPath) {
  const { fd, dataOffset, entries } = readAsarHeader(asarPath);
  try {
    const entry = entries.get('/lib/main.js');
    if (!entry) throw new Error('asar 里没有 /lib/main.js');
    const buf = Buffer.alloc(entry.size);
    asRealFile(() => fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset)));
    return { content: buf.toString('utf8'), offset: Number(entry.offset), size: entry.size };
  } finally {
    asRealFile(() => fs.closeSync(fd));
  }
}

/**
 * 生成打过补丁的 main.js 文本。等长：返回的字符串长度必须和输入完全一致。
 * @returns {{ content: string, changed: boolean, reason?: string }}
 */
export function buildPatchedMain(original) {
  if (original.includes(MARKER)) return { content: original, changed: false, reason: 'already-patched' };
  const start = original.indexOf(REGION_START);
  if (start < 0) throw new Error('main.js 里找不到 `//#region lib/types/tray.js`');
  const end = original.indexOf(REGION_END, start);
  if (end < 0) throw new Error('main.js 里找不到背景提示 region（托盘 region 的结束标记）');
  const oldRegion = original.slice(start, end);
  const oldBytes = Buffer.byteLength(oldRegion, 'utf8');
  const templateBytes = Buffer.byteLength(TEMPLATE, 'utf8');
  if (oldBytes < templateBytes) {
    throw new Error(`托盘 region 只有 ${oldBytes} 字节，装不下补丁（需要 ${templateBytes}），可能版本变化太大`);
  }
  const padding = ' '.repeat(oldBytes - templateBytes);
  const newRegion = `${TEMPLATE.slice(0, -1)}${padding}\n`;
  if (Buffer.byteLength(newRegion, 'utf8') !== oldBytes) throw new Error('等长替换失败：region 字节数不一致');
  const next = original.slice(0, start) + newRegion + original.slice(end);
  if (Buffer.byteLength(next, 'utf8') !== Buffer.byteLength(original, 'utf8')) {
    throw new Error('等长替换失败：文件字节数变了');
  }
  return { content: next, changed: true };
}

/** 把新内容按原 offset 写回 asar（等长，所以不会动到其它文件）。 */
export function writeMainJs(asarPath, offset, buffer) {
  // 注意：asar 头里的 offset 是相对「数据区起点」的，真正落盘位置要加 dataOffset。
  // 2026-11-11 踩过的坑：漏加 dataOffset 会把 838KB 的 main.js 写进别的文件的数据区（本次已用安装包里的原始 asar 修回）。
  const head = readAsarHeader(asarPath);
  const { dataOffset } = head;
  fs.closeSync(head.fd);
  const absolute = dataOffset + offset;
  const fd = asRealFile(() => fs.openSync(asarPath, 'r+'));
  try {
    asRealFile(() => fs.writeSync(fd, buffer, 0, buffer.length, absolute));
    asRealFile(() => fs.fsyncSync(fd));
    const back = Buffer.alloc(buffer.length);
    asRealFile(() => fs.readSync(fd, back, 0, buffer.length, absolute));
    if (!back.equals(buffer)) throw new Error(`写入回读不一致（位置 ${absolute}）`);
  } finally {
    asRealFile(() => fs.closeSync(fd));
  }
  return { absolute, bytes: buffer.length };
}

/**
 * 检查 / 打补丁。
 * @param options
 *  - asarPath 覆盖自动定位
 *  - apply false = 只检查不写
 *  - backupDir 备份目录
 */
export function ensureTrayPatch(options = {}) {
  const asarPath = options.asarPath || locateAsar();
  if (!asarPath) return { status: 'no-app', ok: false, note: '找不到桌面端 resources/app.asar' };
  let stat;
  try {
    stat = asRealFile(() => fs.statSync(asarPath));
  } catch (error) {
    return { status: 'no-app', ok: false, asarPath, note: `读不到 app.asar：${error.message}` };
  }
  const { content, offset, size } = readMainJs(asarPath);
  const patched = content.includes(MARKER);
  const base = { asarPath, asarSize: stat.size, asarMtime: stat.mtimeMs, mainSize: size };
  if (patched) return { ...base, status: 'patched', ok: true };
  if (options.apply === false) return { ...base, status: 'not-patched', ok: false };

  const built = buildPatchedMain(content);
  const buffer = Buffer.from(built.content, 'utf8');
  if (buffer.length !== size) throw new Error(`补丁后字节数 ${buffer.length} ≠ 原文件 ${size}，拒绝写入`);
  const backupDir = options.backupDir;
  let backup = null;
  if (backupDir) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      backup = path.join(backupDir, 'main.js.orig');
      fs.writeFileSync(backup, content, 'utf8');
    } catch (error) {
      backup = `备份失败：${error.message}`;
    }
  }
  writeMainJs(asarPath, offset, buffer);
  const after = readMainJs(asarPath).content;
  if (!after.includes(MARKER)) throw new Error('写入后回读没有找到补丁标记');
  return { ...base, status: 'applied', ok: true, backup, changed: built.changed };
}

/** 还原：把备份写回 asar 里 lib/main.js 的位置（等长才安全）。 */
export function restoreTrayPatch(options = {}) {
  const asarPath = options.asarPath || locateAsar();
  const backup = options.backup;
  if (!asarPath) throw new Error('找不到 app.asar');
  if (!backup) throw new Error('没有备份文件，无法还原');
  const original = fs.readFileSync(backup, 'utf8');
  const { content, offset } = readMainJs(asarPath);
  if (original.length !== content.length) throw new Error(`备份长度 ${original.length} 与当前 main.js ${content.length} 不一致（app 更新过），不能直接还原`);
  writeMainJs(asarPath, offset, Buffer.from(original, 'utf8'));
  return { status: 'restored', asarPath };
}
