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
  autoLaunch: false,
  excludeList: ['com.apple.Safari', 'CloudDocs'], // 默认白名单示例
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
    // 使用 find 遍历所有文件并用 stat 获取逻辑大小 (字节)，最后用 awk 累加
    // 这种方法最慢但最准，完全对齐 Finder 简介中的“字节”
    const cmd = `find "${dirPath}" -type f -exec stat -f %z {} + 2>/dev/null | awk '{s+=$1} END {print s}'`;
    const { stdout } = await execPromise(cmd);
    
    const totalSize = parseInt(stdout.trim()) || 0;
    console.log(`Scan finished. Result: ${totalSize} bytes`);
    return totalSize;
  } catch (e) {
    console.error('Fatal error in size calculation:', e.message);
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

function getDirSize(dirPath) {
  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) return stats.size;
    
    let totalSize = 0;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      totalSize += getDirSize(path.join(dirPath, file));
    }
    return totalSize;
  } catch (e) {
    return 0;
  }
}

function cleanFolderContents(folderPath, intervalDays, excludeList) {
  let deletedSize = 0;
  const now = Date.now();
  const msInDay = 24 * 60 * 60 * 1000;

  try {
    const items = fs.readdirSync(folderPath);
    for (const item of items) {
      const fullPath = path.join(folderPath, item);
      if (excludeList.some(ex => item.includes(ex))) continue;

      try {
        const stats = fs.statSync(fullPath);
        const ageDays = (now - stats.mtime.getTime()) / msInDay;

        if (ageDays >= intervalDays) {
          const size = getDirSize(fullPath);
          if (stats.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          deletedSize += size;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return deletedSize;
}

// 核心清理逻辑
async function cleanCache() {
  console.log('--- Starting Cache Cleanup ---');
  const cachePath = store.get('cachePath', DEFAULT_SETTINGS.cachePath);
  const intervalDays = store.get('intervalDays', DEFAULT_SETTINGS.intervalDays);
  const cleanMode = store.get('cleanMode', DEFAULT_SETTINGS.cleanMode);
  const excludeList = store.get('excludeList', DEFAULT_SETTINGS.excludeList);
  const now = Date.now();
  const msInDay = 24 * 60 * 60 * 1000;
  
  let totalDeletedSize = 0;

  if (!fs.existsSync(cachePath)) {
    console.log('Cache path does not exist:', cachePath);
    return 0;
  }

  // 第一阶段：扫描并计算符合条件的总大小
  let itemsToClean = [];
  try {
    const files = fs.readdirSync(cachePath);
    for (const file of files) {
      const fullPath = path.join(cachePath, file);
      if (excludeList.some(item => file.includes(item))) continue;

      try {
        const stats = fs.statSync(fullPath);
        const fileAgeDays = (now - stats.mtime.getTime()) / msInDay;
        if (fileAgeDays >= intervalDays) {
          itemsToClean.push({ name: file, path: fullPath, stats });
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('Failed to read cache directory:', err);
    return 0;
  }

  if (itemsToClean.length === 0) {
    console.log('Cleanup finished. No files meet the criteria.');
    // 即使没有清理，也可以选择更新下时间，或者直接 return
    return 0;
  }

  // 第二阶段：执行清理
  for (const item of itemsToClean) {
    try {
      const size = getDirSize(item.path);
      if (item.stats.isDirectory()) {
        if (cleanMode === 'folder') {
          fs.rmSync(item.path, { recursive: true, force: true });
          totalDeletedSize += size;
        } else {
          totalDeletedSize += cleanFolderContents(item.path, intervalDays, excludeList);
        }
      } else {
        fs.unlinkSync(item.path);
        totalDeletedSize += size;
      }
    } catch (e) {
      console.log(`Skipping item: ${item.name} - might be in use or protected.`);
    }
  }

  if (totalDeletedSize === 0) {
    console.log('Cleanup finished. All eligible files were protected or in use.');
    return 0;
  }

  // 更新最后运行时间
  const cleanTime = new Date().toLocaleString();
  store.set('lastCleanTime', cleanTime);
  
  if (totalDeletedSize > 0) {
    const currentTotal = store.get('totalCleanedSize', 0);
    store.set('totalCleanedSize', currentTotal + totalDeletedSize);
    console.log(`Cleanup finished. Total deleted this time: ${formatSize(totalDeletedSize)}`);
  } else {
    console.log('Cleanup finished. No files were deleted.');
  }

  // 发送统计更新
  if (mainWindow) {
    const totalSaved = store.get('totalCleanedSize', 0);
    const currentSize = await getDirectorySize(cachePath);
    mainWindow.webContents.send('stats-updated', {
      lastCleanTime: cleanTime,
      totalCleanedSize: formatSize(totalSaved),
      currentDirSize: formatSize(currentSize)
    });

    // 如果开启了通知且清理了东西
    if (totalDeletedSize > 0 && store.get('enableNotification', true)) {
      new Notification({
        title: '清理完成',
        body: `本次共节省了 ${formatSize(totalDeletedSize)} 磁盘空间`,
        silent: false
      }).show();
    }
  }

  return totalDeletedSize;
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

  const autoClean = store.get('autoClean', DEFAULT_SETTINGS.autoClean);
  if (!autoClean) {
    console.log("AutoClean is disabled.");
    return;
  }

  const rawExpression = store.get('cronExpression', DEFAULT_SETTINGS.cronExpression);
  // 核心修复：node-cron 不支持 '?'，将其替换为 '*' 以保持兼容
  let cronExpression = (rawExpression ? String(rawExpression).trim() : DEFAULT_SETTINGS.cronExpression).replace(/\?/g, '*');
  
  // 针对 node-cron 的特殊处理：
  // 如果是 6 位表达式（如 0 */1 * * * *），且第一位是 0
  // 自动转为 5 位表达式（*/1 * * * *），这在 node-cron 中更稳健
  const parts = cronExpression.split(/\s+/);
  if (parts.length === 6 && parts[0] === '0') {
    cronExpression = parts.slice(1).join(' ');
  }
  
  console.log(`Attempting to schedule cron with expression: "${cronExpression}"`);
  
  try {
    cleanJob = cron.schedule(cronExpression, async () => {
      const now = new Date();
      console.log(`>>> CRON TRIGGERED at: ${now.toLocaleString()} <<<`);
      await cleanCache();
    });
    console.log(`✅ Cron job successfully scheduled: ${cronExpression}`);
  } catch (err) {
    console.error('Failed to schedule cron job:', err.message);
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
    currentDirSize: formatSize(currentSize),
    excludeList: store.get('excludeList', DEFAULT_SETTINGS.excludeList)
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
  store.set('excludeList', data.excludeList);
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
  await cleanCache();
  // 返回最新的统计数据给前端
  event.reply('clean-finished', { 
    success: true,
    totalCleanedSize: formatSize(store.get('totalCleanedSize') || 0),
    lastCleanTime: store.get('lastCleanTime')
  });
});
