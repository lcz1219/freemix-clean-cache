const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const Store = require('electron-store');
const cronParser = require('cron-parser');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// 强制获取正确的解析函数
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
  cronExpression: '5 * * * * ?',
  language: 'zh',
  cachePath: path.join(app.getPath('home'), 'Library/Caches'),
  showInDock: true,
  theme: 'system',
  lastCleanTime: '-',
  totalCleanedSize: 0,
  enableNotification: true,
  cleanMode: 'file',
  autoLaunch: false
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
function getFormattedNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function getDirectorySize(dirPath) {
  console.log(`Scanning size for: ${dirPath}`);
  try {
    // 使用 du -sk 统计，不加 -A 以获取磁盘实际占用空间（更接近 Finder）
    const { stdout } = await execPromise(`du -sk "${dirPath}" 2>/dev/null || true`);
    const match = stdout.trim().match(/^(\d+)/);
    const sizeInKb = match ? parseInt(match[1]) : 0;

    // Finder 通常使用 1000 作为单位换算（macOS 默认），而我们使用的是 1024
    // 为了对齐 Finder 的视觉效果，我们可以稍微调整系数或直接返回字节
    const totalSize = sizeInKb * 1024;
    console.log(`Scan finished. Result: ${totalSize} bytes`);
    return totalSize;
  } catch (e) {
    console.error('Fatal error in du command:', e.message);
    return 0;
  }
}

function updateAutoLaunch(enabled) {
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: app.getPath('exe')
    });
  } else {
    console.log("AutoLaunch setting ignored in dev mode.");
  }
}

async function checkFullDiskAccess() {
  // 在 macOS 上，Library/Safari 是受 TCC 保护的目录
  // 如果没有“完全磁盘访问权限”，即使是当前用户也无法读取其中的文件
  const testPath = path.join(app.getPath('home'), 'Library/Safari/Bookmarks.plist');
  try {
    await fs.promises.access(testPath, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

// 核心清理逻辑
async function FreemixCleanCache(isManual = false) {
  const cachePath = store.get('cachePath', DEFAULT_SETTINGS.cachePath);
  const intervalDays = store.get('intervalDays', DEFAULT_SETTINGS.intervalDays);
  const cleanMode = store.get('cleanMode', DEFAULT_SETTINGS.cleanMode);
  const now = Date.now();
  const msInDay = 24 * 60 * 60 * 1000;

  let cleanedCount = 0;
  let cleanedSize = 0;

  try {
    console.log("!fs.existsSync(cachePath)", !fs.existsSync(cachePath));

    if (!fs.existsSync(cachePath)) return;

    if (cleanMode === 'folder') {
      try {
        const folderName = path.basename(cachePath);
        const parentDir = path.dirname(cachePath);
        const timestamp = getFormattedNow();
        // 1. 在父级目录创建一个带标记的新文件夹，作为“垃圾箱容器”
        const trashContainer = path.join(parentDir, `${folderName}_FreemixCleaned_${timestamp}`);
        await fs.promises.mkdir(trashContainer, { recursive: true });

        // 2. 遍历原目录内容，将所有可移动的子项“剪切”到新文件夹中
        const items = await fs.promises.readdir(cachePath);
        for (const item of items) {
          const oldItemPath = path.join(cachePath, item);
          const newItemPath = path.join(trashContainer, item);
          try {
            // 尝试直接移动（重命名操作在同一磁盘分区内非常快且作为原子操作）
            await fs.promises.rename(oldItemPath, newItemPath);
          } catch (e) {
            // 某些项目（如正在使用的 Socket 或隐藏的权限文件）可能无法移动，忽略它们
            console.warn(`Skipping item: ${item} - might be in use or protected.`);
          }
        }

        // 3. 将这个装满内容的“新文件夹”整体移入废纸篓
        await shell.trashItem(trashContainer);

        cleanedCount = 1;
        console.log(`Successfully moved folder contents into container and trashed: ${trashContainer}`);
      } catch (folderErr) {
        console.error('Final folder strategy failed:', folderErr.message);
        throw folderErr;
      }
    } else {
      // 文件模式：原来的逻辑
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
          title: 'FreemixCleanCache 清理完成',
          body: `本次清理了 ${cleanedCount} 个项目，节省了 ${(cleanedSize / 1000 / 1000).toFixed(2)} MB 空间。`,
          silent: false
        }).show();
      }

      // 同步给 UI
      if (mainWindow) {
        const currentSize = await getDirectorySize(cachePath);
        mainWindow.webContents.send('stats-updated', {
          lastCleanTime: cleanTime,
          totalCleanedSize: formatSize(totalSize),
          currentDirSize: formatSize(currentSize)
        });
      }
    }
  } catch (err) {
    console.error('Failed to read cache directory:', err);
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1000;
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
        FreemixCleanCache();
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
      { label: 'Open FreemixCleanCache', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => {
          app.isQuiting = true;
          app.quit();
        }
      }
    ]);
    tray.setToolTip('FreemixCleanCache Assistant');
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

ipcMain.on('get-settings', async (event) => {
  const cronExpr = store.get('cronExpression', DEFAULT_SETTINGS.cronExpression);
  const themeSetting = store.get('theme', DEFAULT_SETTINGS.theme);
  const cachePath = store.get('cachePath', DEFAULT_SETTINGS.cachePath);
  let nextRuns = [];
  try {
    const interval = parseCron(cronExpr);
    for (let i = 0; i < 5; i++) {
      nextRuns.push(formatDateTime(interval.next().toDate()));
    }
  } catch (e) {}

  const currentSize = await getDirectorySize(cachePath);
  const hasFullAccess = await checkFullDiskAccess();

  // 强制权限检测逻辑：如果未获得完全磁盘访问权限
  if (!hasFullAccess && cachePath.includes('Library/Caches')) {
    setTimeout(() => {
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '权限申请',
          message: '需要开启“完全磁盘访问权限”',
          detail: '检测到 FreemixCleanCache 尚未获得完整权限，这将导致无法彻底清理 Safari、HomeKit 等深层缓存。请在弹出的设置中将 FreemixCleanCache 的开关设为【开启】状态。',
          buttons: ['去开启', '暂不开启'],
          defaultId: 0
        }).then(res => {
          if (res.response === 0) {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
          }
        });
      }
    }, 800);
  }

  event.reply('settings-data', {
    autoClean: store.get('autoClean', DEFAULT_SETTINGS.autoClean),
    showInDock: store.get('showInDock', DEFAULT_SETTINGS.showInDock),
    intervalDays: store.get('intervalDays', DEFAULT_SETTINGS.intervalDays),
    cronExpression: cronExpr,
    language: store.get('language', DEFAULT_SETTINGS.language),
    cachePath: cachePath,
    theme: themeSetting,
    isDark: nativeTheme.shouldUseDarkColors,
    nextRuns: nextRuns,
    lastCleanTime: store.get('lastCleanTime', '-'),
    totalCleanedSize: formatSize(store.get('totalCleanedSize', 0)),
    enableNotification: store.get('enableNotification', DEFAULT_SETTINGS.enableNotification),
    cleanMode: store.get('cleanMode', DEFAULT_SETTINGS.cleanMode),
    autoLaunch: store.get('autoLaunch', DEFAULT_SETTINGS.autoLaunch),
    currentDirSize: formatSize(currentSize)
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
  if (data.autoLaunch !== undefined) {
    store.set('autoLaunch', data.autoLaunch);
    updateAutoLaunch(data.autoLaunch);
  }
  if (data.cleanMode !== undefined) {
    store.set('cleanMode', data.cleanMode);
  }
  setupCron();
  event.reply('settings-updated', { success: true });
});

ipcMain.on('open-privacy-settings', () => {
  // 跳转到 macOS 完全磁盘访问权限设置页面
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
});

ipcMain.on('get-current-usage', async (event) => {
  const cachePath = store.get('cachePath', DEFAULT_SETTINGS.cachePath);
  const currentSize = await getDirectorySize(cachePath);
  event.reply('current-usage-data', {
    currentDirSize: formatSize(currentSize)
  });
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
  await FreemixCleanCache();
  event.reply('clean-finished', { success: true });
});
