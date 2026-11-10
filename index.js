/**
 * 托盘右键菜单「重启」（Host 侧）。
 *
 * 需求（2026-11-11 用户）：托盘图标右键原来只有「打开应用 / 退出应用」，要再加一条「重启」。
 *
 * 为什么只能改 asar：
 *   托盘菜单写死在 Electron 主进程的 lib/main.js 里（`DesktopTray.relabel()` 一次性
 *   `tray.setContextMenu(...)`），而 Host（本插件跑的地方）是主进程的子进程，
 *   拿不到 Electron 的 Menu/Tray；主进程的 IPC 协议又是封闭枚举（starting/ready/
 *   platform-session/shutdown-complete/fatal 等），没有「加菜单项」这种消息。
 *
 * 做法：
 *   把 app.asar 里 `/lib/main.js` 的整个 `//#region lib/types/tray.js` 段做**等长替换**，
 *   在「打开应用」和「退出应用」之间插一条
 *   `{ label: "重启 " + messages.aboutProduct,
 *      click: () => { app.relaunch(); quitWithoutConfirmation(); } }`，
 *   显示成「重启 DeepSeek Harness」，与另外两条同格式（跟随产品名，不写死语言）。
 *   `app.relaunch() + quitWithoutConfirmation()` 是 Electron 主进程自己的重启写法
 *   （主进程里本来就有同款代码）。等长替换不改变归档长度，asar 头的 offset/size
 *   全部继续有效。
 *
 * 平台：只有 Windows 桌面端有托盘 icon，其他平台直接跳过。
 *
 * 安全：
 *   - 只等长替换，写之前校验字节数与文件长度，写之后回读校验；
 *   - 打之前把原始 main.js 备份到 ~/.dsh/tray-restart/main.js.orig；
 *   - 锚点认不出来（应用升级改了这段代码）就报错不动手，绝不会写坏别的区域；
 *   - 桌面端每次更新会覆盖 app.asar，所以宿主启动时自动检查一遍，没打就补上；
 *   - 宿主启动是 all-or-nothing：本文件任何异常都必须自己吞掉。
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ensureTrayPatch, locateAsar, readMainJs, restoreTrayPatch } from './lib/tray-patch.mjs';

export const name = 'tray-restart';

/** tools 服务要靠显式注入，ctx.get('tools') 拿不到（2026-11-01 踩过）。 */
export const inject = ['tools'];

const DEFAULTS = {
  enabled: true,
  /** 宿主启动后等这么久再检查/打补丁，避开主进程启动时读 asar 的高峰。 */
  delaySeconds: 8,
  /** 自动补丁：桌面端更新覆盖 asar 后，下次启动自动重打。 */
  autoPatch: true,
};

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function errText(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const cfg = {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    delaySeconds: num(config.delaySeconds, DEFAULTS.delaySeconds, 0, 600),
    autoPatch: bool(config.autoPatch, DEFAULTS.autoPatch),
  };

  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh');
  const dataDir = join(home, 'tray-restart');
  const logPath = join(dataDir, 'log.ndjson');
  const backupDir = dataDir;
  const instanceId = randomUUID();

  let disposed = false;
  let last = null;

  async function logLine(level, event, message) {
    try {
      await mkdir(dataDir, { recursive: true });
      const entry = {
        at: new Date().toISOString(),
        level,
        event,
        message: message === undefined ? '' : clip(typeof message === 'string' ? message : errText(message), 2000),
        instanceId,
      };
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      /* 日志写不进去不影响主流程 */
    }
  }

  /** 只读探测：现在 asar 是不是已经打过补丁。 */
  async function inspect() {
    if (process.platform !== 'win32') {
      return { ok: false, patched: false, note: '仅支持 Windows 桌面端（托盘在 Electron 主进程里）' };
    }
    const asarPath = locateAsar();
    const debug = {
      execPath: process.execPath,
      argv1: process.argv[1] || '',
      localAppData: process.env.LOCALAPPDATA || '',
      userProfile: process.env.USERPROFILE || '',
      dshHome: process.env.DSH_HOME || '',
    };
    if (!asarPath) return { ok: false, patched: false, debug, note: '找不到桌面端 resources/app.asar（可能是纯 Web 版）' };
    try {
      const { content, size } = readMainJs(asarPath);
      return {
        ok: true,
        patched: content.includes('dsh-tray-restart'),
        asarPath,
        mainSize: size,
        restartKeyInScope: /function quitWithoutConfirmation\(/.test(content),
      };
    } catch (error) {
      return { ok: false, patched: false, asarPath, note: errText(error) };
    }
  }

  async function patch(options = {}) {
    try {
      const result = ensureTrayPatch({ backupDir, apply: options.dryRun === true ? false : true });
      last = { ...result, at: new Date().toISOString() };
      if (result.status === 'applied') await logLine('info', 'patched', `已在托盘菜单加入「重启」（${result.asarPath}）`);
      else if (result.status === 'patched') await logLine('info', 'already-patched', '托盘菜单里已经有「重启」');
      else if (result.status === 'no-app') await logLine('info', 'no-app', result.note || '找不到 app.asar');
      return result;
    } catch (error) {
      last = { status: 'error', ok: false, note: errText(error), at: new Date().toISOString() };
      await logLine('error', 'patch-failed', error);
      return last;
    }
  }

  async function restore() {
    const backup = join(backupDir, 'main.js.orig');
    const result = restoreTrayPatch({ backup });
    await logLine('info', 'restored', `已还原原始 main.js（${result.asarPath}）`);
    return result;
  }

  // ------------------------------------------------------------ 启动时检查

  ctx.effect(() => {
    if (!cfg.enabled || disposed) return () => {};
    let timer = null;
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      void (async () => {
        try {
          const state = await inspect();
          if (!state.ok) {
            await logLine('info', 'skip', state.note || '无法读取 app.asar');
            return;
          }
          if (state.patched) {
            await logLine('info', 'already-patched', '托盘菜单里已经有「重启」');
            last = state;
            return;
          }
          if (!cfg.autoPatch) {
            await logLine('info', 'not-patched', 'asar 里没有「重启」补丁（autoPatch=false，未自动打）');
            last = state;
            return;
          }
          if (state.restartKeyInScope !== true) {
            await logLine('warn', 'anchor-mismatch', 'main.js 里找不到 quitWithoutConfirmation()，版本可能变了，跳过补丁');
            last = state;
            return;
          }
          await patch();
        } catch (error) {
          await logLine('error', 'boot-check-failed', error);
        }
      })();
    }, Math.max(0, cfg.delaySeconds) * 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  });

  // ------------------------------------------------------------ 工具

  try {
    const tools = ctx.tools;
    if (!tools || typeof tools.register !== 'function') throw new Error('tools 服务不可用（inject 没生效？）');
    ctx.effect(() =>
      tools.register({
        name: 'tray_restart_status',
        description:
          '查看桌面端托盘右键菜单的「重启」补丁状态（改的是 app.asar 里的 lib/main.js），传 apply=true 立刻重新打补丁、restore=true 还原成原生菜单。补丁只在下次启动 DSH 时生效（菜单是启动时建的）。',
        parameters: {
          type: 'object',
          properties: {
            apply: { type: 'boolean', description: 'true = 现在立刻检查并打补丁（幂等）' },
            restore: { type: 'boolean', description: 'true = 用备份还原原始 main.js（等长才安全）' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              summary: { type: 'string' },
              patched: { type: 'boolean' },
              asarPath: { type: 'string' },
              mainSize: { type: 'number' },
              backup: { type: 'string' },
              note: { type: 'string' },
            },
            additionalProperties: true,
          },
          render(_args, value) {
            const text = value && value.summary ? String(value.summary) : '托盘重启补丁：未知状态';
            return [{ type: 'text', text }];
          },
        },
        isConcurrencySafe: () => false,
        timeoutMs: 120000,
        async execute(args) {
          const input = args && typeof args === 'object' ? args : {};
          let result = null;
          if (input.restore === true) result = await restore();
          else if (input.apply === true) result = await patch();
          const state = await inspect();
          const backup = join(backupDir, 'main.js.orig');
          const lines = [];
          if (!state.ok) lines.push(`❌ ${state.note || '无法读取 app.asar'}`);
          else if (state.patched) lines.push('✅ 托盘右键菜单已包含「重启」（下次启动 DSH 后出现在菜单里）');
          else lines.push('⚠️ 托盘的 app.asar 里还没有「重启」补丁');
          if (state.debug) lines.push(`调试：${JSON.stringify(state.debug)}`);
          if (state.asarPath) lines.push(`asar：${state.asarPath}`);
          if (result) lines.push(`本次操作：${result.status || 'unknown'}${result.note ? `（${result.note}）` : ''}`);
          if (result && result.backup) lines.push(`备份：${result.backup}`);
          lines.push(`备份目录：${backup}`);
          lines.push('提示：补丁写在桌面端 app.asar 里，桌面端自动更新会覆盖它；插件每次启动会检查并自动补回。');
          return {
            ok: state.ok !== false && (state.patched === true || (result && result.status === 'applied')),
            summary: lines.join('\n'),
            patched: state.patched === true,
            asarPath: state.asarPath || '',
            mainSize: state.mainSize || 0,
            note: state.note || '',
          };
        },
      }),
    );
  } catch (error) {
    void logLine('error', 'tool-register-failed', error);
  }
}
