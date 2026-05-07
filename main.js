const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const Store = require('electron-store');
const cronParser = require('cron-parser');

// 强制获取正确的解析函数111
const parseCron = (expr) => {
  try {
    const trimmed = expr.trim();
    // 如果包含 ?，统一替换为 * 以兼容 node-cron
    const sanitized = trimmed.replace(/\?/g, '*');
    
    const Parser = cronParser.CronExpressionParser || cronParser.default;
    if (Parser && typeof Parser.parse === 'function') {
      return Parser.parse(sanitized);
    }
    if (typeof cronParser.parseExpression === 'function') {
      return cronParser.parseExpression(sanitized);
    }
  } catch (e) {
    throw e;
  }
  throw new Error('cron-parser: parse function not found');
};

const store = new Store();
let mainWindow;
let tray;
let cleanJob;

// 默认设置
const DEFAULT_SETTINGS = {
  autoClean: false,
  intervalDays: 7, 
  cronExpression: '5 * * * * ?', // 默认每天凌晨
  language: 'zh',
  cachePath: path.join(app.getPath('home'), 'Library/Caches'),
  showInDock: true,
  theme: 'system',
  lastCleanTime: '-',
  totalCleanedSize: 0,
  enableNotification: true // 默认开启通知
};

function sendThemeStatus() {
  if (!mainWindow) return;
  const themeSetting = store.get('theme', DEFAULT_SETTINGS.theme);
  const isDark = nativeTheme.shouldUseDarkColors;
  mainWindow.webContents.send('theme-changed', {
    themeSetting,
    isDark
  });
}

function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 650,
    height: 980,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'icon.icns'),
    show: false,
    titleBarStyle: 'hidden', // 隐藏标题栏
    trafficLightPosition: { x: 15, y: 15 }, // 调整红绿灯位置
    vibrancy: 'sidebar', // macOS 毛玻璃效果
    visualEffectState: 'active'
  });

  mainWindow.loadFile('index.html');
  
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 发送初始主题状态
    sendThemeStatus();
  });

  // 监听系统主题变化
  nativeTheme.on('updated', () => {
    sendThemeStatus();
  });

  // 修复：点击关闭按钮时隐藏窗口，而不是销毁窗口
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 核心清理逻辑
async function cleanCache(isManual = false) {
  const cachePath = store.get('cachePath', DEFAULT_SETTINGS.cachePath);
  const intervalDays = store.get('intervalDays', DEFAULT_SETTINGS.intervalDays);
  const now = Date.now();
  const msInDay = 24 * 60 * 60 * 1000;
  
  let cleanedCount = 0;
  let cleanedSize = 0;

  try {
    if (!fs.existsSync(cachePath)) return;
    const files = await fs.promises.readdir(cachePath);

    for (const file of files) {
      const filePath = path.join(cachePath, file);
      try {
        const stats = await fs.promises.stat(filePath);
        const diffDays = (now - stats.atimeMs) / msInDay;

        if (diffDays > intervalDays) {
          cleanedSize += stats.size;
          await shell.trashItem(filePath);
          cleanedCount++;
        }
      } catch (err) {}
    }

    // 更新统计数据
    if (cleanedCount > 0) {
      const totalSize = store.get('totalCleanedSize', 0) + cleanedSize;
      const cleanTime = formatDateTime(new Date());
      store.set('totalCleanedSize', totalSize);
      store.set('lastCleanTime', cleanTime);

      // 发送通知 (增加开关判断)
      const isNotifyEnabled = store.get('enableNotification', DEFAULT_SETTINGS.enableNotification);
      if (isNotifyEnabled && Notification.isSupported()) {
        new Notification({
          title: 'CleanCache 清理完成',
          body: `本次清理了 ${cleanedCount} 个项目，节省了 ${(cleanedSize / 1024 / 1024).toFixed(2)} MB 空间。`,
          silent: false
        }).show();
      }

      // 同步给 UI
      if (mainWindow) {
        mainWindow.webContents.send('stats-updated', {
          lastCleanTime: cleanTime,
          totalCleanedSize: formatSize(totalSize)
        });
      }
    }
  } catch (err) {
    console.error('Failed to read cache directory:', err);
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 设置定时任务
function setupCron() {
  console.log("Setting up cron job...");
  if (cleanJob) {
    console.log("Stopping existing job...");
    cleanJob.stop();
    cleanJob = null;
  }
  
  const isEnabled = store.get('autoClean', DEFAULT_SETTINGS.autoClean);
  const cronExpr = store.get('cronExpression', DEFAULT_SETTINGS.cronExpression);
  
  console.log(`AutoClean: ${isEnabled}, Expression: "${cronExpr}"`);

  if (isEnabled ) {
    try {
      // 预校验并获取清理后的表达式
      const sanitizedExpr = cronExpr.trim().replace(/\?/g, '*');
      parseCron(sanitizedExpr);

      cleanJob = cron.schedule(sanitizedExpr, () => {
        console.log('Running scheduled cache cleanup...');
        cleanCache();
      });
      console.log(`✅ Cron job successfully scheduled: ${sanitizedExpr}`);
    } catch (e) {
      console.error('❌ Failed to schedule cron job:', e.message);
    }
  } else {
    console.log("Cron job is disabled or expression is empty.");
  }
}

app.whenReady().then(() => {
  createWindow();
  setupTray();
  setupCron();
  updateDockVisibility(); // 初始化程序坞显示状态

  // 修复：处理 macOS 程序坞图标点击事件
  app.on('activate', function () {
    if (mainWindow === null) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

function setupTray() {
  // macOS Tray 建议使用 PNG 格式，且文件名以 Template 结尾可以自动适配系统深浅模式
  const iconPath = fs.existsSync(path.join(__dirname, 'iconTemplate@2x.png')) 
    ? path.join(__dirname, 'iconTemplate@2x.png') 
    : path.join(__dirname, 'icon.icns');

  try {
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open CleanCache', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => {
          app.isQuiting = true;
          app.quit();
        } 
      }
    ]);
    tray.setToolTip('CleanCache Assistant');
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
      mainWindow.show();
    });
  } catch (e) {
    console.error('Failed to create Tray:', e.message);
  }
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', function () {
  app.isQuiting = true;
});
// 格式化日期函数
const formatDateTime = (date) => {
  const d = new Date(date);
  const pad = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// IPC 监听
function updateDockVisibility() {
  const showInDock = store.get('showInDock', DEFAULT_SETTINGS.showInDock);
  if (process.platform === 'darwin') {
    if (showInDock) {
      app.dock.show();
    } else {
      app.dock.hide();
    }
  }
}

ipcMain.on('get-settings', (event) => {
  const cronExpr = store.get('cronExpression', DEFAULT_SETTINGS.cronExpression);
  const themeSetting = store.get('theme', DEFAULT_SETTINGS.theme);
  let nextRuns = [];
  try {
    const interval = parseCron(cronExpr.trim());
    for (let i = 0; i < 5; i++) {
      nextRuns.push(formatDateTime(interval.next().toDate()));
    }
  } catch (e) {
    console.error('Cron initial parse error:', e.message);
  }

  event.reply('settings-data', {
    autoClean: store.get('autoClean', DEFAULT_SETTINGS.autoClean),
    showInDock: store.get('showInDock', DEFAULT_SETTINGS.showInDock),
    intervalDays: store.get('intervalDays', DEFAULT_SETTINGS.intervalDays),
    cronExpression: cronExpr,
    language: store.get('language', DEFAULT_SETTINGS.language),
    cachePath: store.get('cachePath', DEFAULT_SETTINGS.cachePath),
    theme: themeSetting,
    isDark: nativeTheme.shouldUseDarkColors,
    nextRuns: nextRuns,
    lastCleanTime: store.get('lastCleanTime', '-'),
    totalCleanedSize: formatSize(store.get('totalCleanedSize', 0)),
    enableNotification: store.get('enableNotification', DEFAULT_SETTINGS.enableNotification)
  });
});

ipcMain.on('preview-cron', (event, cronExpr) => {
  let nextRuns = [];
  try {
    if (!cronExpr || cronExpr.trim().split(/\s+/).length < 5) {
      return event.reply('cron-preview-data', { success: false });
    }
    const interval = parseCron(cronExpr.trim());
    for (let i = 0; i < 5; i++) {
      nextRuns.push(formatDateTime(interval.next().toDate()));
    }
    event.reply('cron-preview-data', { success: true, nextRuns });
  } catch (e) {
    event.reply('cron-preview-data', { success: false });
  }
});

ipcMain.on('update-settings', (event, data) => {
  console.log("data.intervalDays",data.intervalDays)
  store.set('autoClean', data.autoClean);
  store.set('intervalDays', data.intervalDays);
  store.set('cronExpression', data.cronExpression);
  store.set('language', data.language);
  if (data.showInDock !== undefined) {
    store.set('showInDock', data.showInDock);
    updateDockVisibility();
  }
  if (data.theme !== undefined) {
    store.set('theme', data.theme);
    nativeTheme.themeSource = data.theme; // 告诉 Electron 使用哪种主题源
    sendThemeStatus();
  }
  if (data.enableNotification !== undefined) {
    store.set('enableNotification', data.enableNotification);
  }
  setupCron();
  event.reply('settings-updated', { success: true });
});

ipcMain.on('select-path', async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    store.set('cachePath', result.filePaths[0]);
    event.reply('path-selected', result.filePaths[0]);
  }
});

ipcMain.on('manual-clean', async (event) => {
  await cleanCache();
  event.reply('clean-finished', { success: true });
});
