'use strict';

/**
 * TokenLens 主进程
 * 无边框置顶浮窗 + 托盘 + 全局快捷键；也可用 --panel 以 HTTP 面板模式启动。
 */

const {
  app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut,
  screen, nativeImage, shell, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { Service } = require('./service');
const { startPanelServer } = require('./panel-server');

const APP_NAME = 'TokenLens';
const WIDTH = 434;
const HEIGHT_FULL = 828;
const HEIGHT_COMPACT = 48;

const argv = process.argv.slice(1);
const isPanelMode = argv.includes('--panel');
const isDemoFlag = argv.includes('--demo');
const isDev = argv.includes('--dev');
const sourceArg = (argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || null;
const shotArg = argv.find((a) => a.startsWith('--shot='));
const shotPath = shotArg ? shotArg.slice('--shot='.length) : null;

// 截图/调试场景下关闭硬件加速，避免无 GPU 环境里 capturePage 失败
if (shotPath || isDev) {
  app.disableHardwareAcceleration();
}

let win = null;
let tray = null;
let service = null;
let panel = null;
let quitting = false;

/* ---------------- 配置 ---------------- */
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
  return cfg;
}

/* ---------------- 窗口 ---------------- */
function restoreBounds(cfg) {
  const def = { width: WIDTH, height: HEIGHT_FULL };
  const compact = cfg.compact === true;
  const work = screen.getPrimaryDisplay().workArea;
  if (!cfg.bounds) {
    // 默认贴右侧
    return {
      width: WIDTH,
      height: HEIGHT_FULL,
      x: Math.max(0, work.x + work.width - WIDTH - 24),
      y: work.y + Math.round((work.height - HEIGHT_FULL) / 2),
    };
  }
  const b = cfg.bounds;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
  if (!visible) return { ...def, x: work.x + work.width - WIDTH - 24, y: work.y + 60 };
  // 记住的尺寸过小（多半是紧凑模式留下的）时按紧凑模式还原，避免开出一个 48px 的空壳
  const savedHeight = b.height || HEIGHT_FULL;
  const asCompact = compact || savedHeight < 300;
  return {
    x: b.x,
    y: b.y,
    width: Math.max(WIDTH, Math.min(b.width || WIDTH, 900)),
    height: asCompact ? HEIGHT_COMPACT : Math.max(420, Math.min(savedHeight, 1300)),
  };
}

function createWindow() {
  const cfg = readConfig();
  const bounds = restoreBounds(cfg);
  // 与 restoreBounds 保持同一判断：记住的高度很小 → 以紧凑条启动
  const startCompact = cfg.compact === true || bounds.height <= HEIGHT_COMPACT;

  win = new BrowserWindow({
    ...bounds,
    minWidth: WIDTH,
    minHeight: HEIGHT_COMPACT,
    frame: false,
    transparent: !shotPath,
    backgroundColor: shotPath ? '#ffffff' : '#00000000',
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: cfg.skipTaskbar !== false,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    hasShadow: true,
    title: APP_NAME,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  if (cfg.alwaysOnTop !== false) win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // 以紧凑条形态启动：记住的紧凑状态，或 npm start -- --compact
  if (argv.includes('--compact') || startCompact) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.executeJavaScript('setCompact(true)').catch(() => {});
    });
  }

  // 截图自测：--shot=<path>
  if (shotPath) {
    const out = shotPath;
    win.webContents.on('console-message', (event, level, message) => {
      const text = (event && event.message) || message;
      const lv = event && event.level != null ? event.level : level;
      console.log(`[renderer:${lv}] ${text}`);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, img.toPNG());
          console.log('[TokenLens] screenshot saved:', out);
        } catch (e) {
          console.error('[TokenLens] screenshot failed', e);
        }
        setTimeout(() => { quitting = true; app.quit(); }, 300);
      }, Number(process.env.TOKENLENS_SHOT_DELAY || 2600));
    });
  }

  win.on('close', (e) => {
    const c = readConfig();
    if (!quitting && c.closeToTray !== false) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => { win = null; });

  let saveTimer = null;
  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const b = win.getBounds();
      writeConfig({ bounds: b });
    }, 400);
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);
}

/* ---------------- 托盘 ---------------- */
function trayImage() {
  const p = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? undefined : img;
}

function buildTrayMenu() {
  const cfg = readConfig();
  return Menu.buildFromTemplate([
    {
      label: win && win.isVisible() ? '隐藏浮窗' : '显示浮窗',
      click: () => toggleWindow(),
    },
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: cfg.alwaysOnTop !== false,
      click: (item) => {
        writeConfig({ alwaysOnTop: item.checked });
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(item.checked, 'floating');
      },
    },
    {
      label: '数据源',
      submenu: [
        { label: 'Harness', type: 'radio', checked: (service?.source || 'harness') === 'harness', click: () => switchSource('harness') },
        { label: 'WorkBuddy', type: 'radio', checked: service?.source === 'workbuddy', click: () => switchSource('workbuddy') },
        { label: '示例数据', type: 'radio', checked: service?.source === 'demo', click: () => switchSource('demo') },
      ],
    },
    { type: 'separator' },
    {
      label: '打开数据目录',
      click: () => shell.openPath(service.source === 'workbuddy' ? service.wbHome : service.home),
    },
    {
      label: '打开历史库目录',
      click: () => {
        const dir = path.join(app.getPath('userData'), '..');
        shell.openPath(dir);
      },
    },
    {
      label: '在浏览器中打开面板',
      click: async () => {
        const url = await ensurePanel();
        if (url) shell.openExternal(url);
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [] });
      },
    },
    {
      label: '任务栏显示',
      type: 'checkbox',
      checked: cfg.skipTaskbar === false,
      click: (item) => {
        writeConfig({ skipTaskbar: !item.checked });
        if (win) win.setSkipTaskbar(!item.checked);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { quitting = true; app.quit(); },
    },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  let s = null;
  try {
    s = service ? service.snapshot({ source: service.source }) : null;
  } catch (e) { /* 采集失败不影响托盘 */ }
  const today = s && s.summary && s.summary.today ? s.summary.today.total : 0;
  const label = service && service.source === 'workbuddy' ? 'WorkBuddy' : '今日';
  tray.setToolTip(`${APP_NAME} · ${label} ${Math.round(today).toLocaleString('zh-CN')} tokens`);
}

function createTray() {
  const img = trayImage();
  if (!img) return;
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  refreshTray();
  tray.on('click', () => toggleWindow());
}

function switchSource(source) {
  if (!service) return;
  service.setSource(source);
  writeConfig({ source });
  refreshTray();
  if (win && !win.isDestroyed()) win.webContents.send('tl:source-changed', source);
}

function toggleWindow() {
  if (!win) { createWindow(); return; }
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
  refreshTray();
}

/* ---------------- 面板模式 ---------------- */
async function ensurePanel() {
  if (panel) return panel.url;
  try {
    panel = await startPanelServer(service, { port: 4317 });
    return panel.url;
  } catch (e) {
    return null;
  }
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('tl:snapshot', (_e, opts = {}) => {
    const cfg = readConfig();
    const source = opts.source || cfg.source || 'harness';
    if (source !== service.source) service.setSource(source);
    try {
      return service.snapshot({ sessionId: opts.sessionId || cfg.sessionId, source });
    } catch (err) {
      return { ok: false, error: String(err && err.message), sessions: [], daily: [] };
    }
  });

  ipcMain.handle('tl:setSource', (_e, source) => {
    service.setSource(source);
    writeConfig({ source });
    refreshTray();
    return true;
  });

  ipcMain.handle('tl:setDemo', (_e, flag) => {
    service.setDemo(!!flag);
    writeConfig({ demo: !!flag });
    refreshTray();
    return true;
  });

  ipcMain.handle('tl:setAlwaysOnTop', (_e, flag) => {
    writeConfig({ alwaysOnTop: !!flag });
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!flag, 'floating');
    refreshTray();
    return true;
  });

  ipcMain.handle('tl:setCompact', (_e, flag) => {
    if (!win || win.isDestroyed()) return false;
    const b = win.getBounds();
    const height = flag ? HEIGHT_COMPACT : Math.max(HEIGHT_FULL, b.height);
    win.setBounds({ x: b.x, y: b.y, width: b.width, height }, true);
    writeConfig({ compact: !!flag, bounds: { ...b, height: flag ? b.height : height } });
    return true;
  });

  ipcMain.handle('tl:close', () => { quitting = true; app.quit(); });
  ipcMain.handle('tl:openPath', (_e, p) => (p ? shell.openPath(p) : null));
  ipcMain.handle('tl:getPrefs', () => {
    const cfg = readConfig();
    return {
      sessionId: cfg.sessionId || null,
      source: cfg.source || (isDemoFlag ? 'demo' : 'harness'),
      refreshMs: typeof cfg.refreshMs === 'number' ? cfg.refreshMs : 5000,
      alwaysOnTop: cfg.alwaysOnTop !== false,
      theme: cfg.theme || 'light',
    };
  });
  ipcMain.handle('tl:savePrefs', (_e, prefs) => writeConfig(prefs || {}));
}

/* ---------------- 启动 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.tokenlens.app');
    service = new Service({
      dataDir: app.getPath('userData'),
      demo: isDemoFlag,
      source: sourceArg || readConfig().source || (isDemoFlag ? 'demo' : 'harness'),
    });
    if (sourceArg) writeConfig({ source: sourceArg });

    registerIpc();

    if (isPanelMode) {
      const url = await ensurePanel();
      if (url) {
        console.log(`[TokenLens] 面板已启动：${url}`);
        shell.openExternal(url);
      } else {
        dialog.showErrorBox('面板启动失败', '端口 4317 可能被占用，请用 --port 指定其它端口。');
        app.quit();
      }
      return;
    }

    createWindow();
    createTray();

    globalShortcut.register('CommandOrControl+Alt+T', () => toggleWindow());

    // 托盘提示随数据刷新
    setInterval(refreshTray, 15000);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && readConfig().closeToTray === false) app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) win.show();
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (panel) panel.close();
  });
}
