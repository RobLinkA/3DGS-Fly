// ============================================================
// 3DGS-Fly —— SuperSplat 3DGS 查看器（RC-N1 遥控版）Electron 主进程
// ------------------------------------------------------------
// 设计要点：
//  1. 内置本地静态服务器，固定 3835 端口（被占用时自动切换随机端口），
//     通过 http://127.0.0.1 加载 web/ 目录下的构建产物。
//     采用 HTTP 而非 file:// 协议，避免 wasm / fetch / ES Module / Service
//     Worker 在 file:// 下的加载失败与跨域限制。
//  2. 固定端口保证 localStorage 配置持久化的 origin 稳定，跨会话保留。
//  3. 渲染进程保持沙箱化（sandbox + contextIsolation + 无 Node 集成），
//     RC-N1 读取由主进程 spawn PowerShell 桥接脚本完成，经 IPC 转发给渲染层。
// ============================================================

const { app, BrowserWindow, shell, dialog, ipcMain, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');

// RC-N1 遥控器读取：spawn PowerShell 桥接脚本（无原生模块依赖），
// 脚本向 stdout 输出 JSON 流，主进程解析后转发给渲染进程。
let rcBridge = null;
const rcLatest = { connected: false, port: '', state: null };

const WEB_ROOT = path.join(__dirname, 'web');
const PREFERRED_PORT = 3835;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.ktx2': 'image/ktx2',
    '.basis': 'application/octet-stream',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
};

function requestHandler(req, res) {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) {
            pathname += 'index.html';
        }

        // 归一化路径并防止路径穿越
        const relative = path.normalize(pathname).replace(/^([\\/])+/, '');
        const filePath = path.join(WEB_ROOT, relative);
        if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden');
            return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found: ' + req.url);
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME[ext] || 'application/octet-stream',
                'Content-Length': data.length,
                'Cache-Control': 'no-cache',
                // 与开发期 `serve dist -C` 的跨域行为保持一致
                'Access-Control-Allow-Origin': '*',
            });
            res.end(data);
        });
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server Error');
    }
}

function startServer() {
    return new Promise((resolve, reject) => {
        const tryListen = (port) => {
            const server = http.createServer(requestHandler);
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE' && port === PREFERRED_PORT) {
                    console.warn(`[server] 端口 ${PREFERRED_PORT} 被占用，改用随机端口（注意：手柄配置将存于不同 origin）`);
                    tryListen(0);
                } else {
                    reject(err);
                }
            });
            server.listen(port, '127.0.0.1', () => resolve(server));
        };
        tryListen(PREFERRED_PORT);
    });
}

let mainWindow = null;
let server = null;

// ---- RC-N1 遥控器 IPC ----
// 渲染进程查询当前连接状态（初始拉取用）
ipcMain.handle('rc:getStatus', () => ({
    connected: rcLatest.connected,
    port: rcLatest.port,
}));

function broadcastRcState() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('rc:state', {
            connected: rcLatest.connected,
            port: rcLatest.port,
            state: rcLatest.state,
        });
    }
}

function startRcN1() {
    if (rcBridge) {
        return;
    }
    const bridgePath = app.isPackaged
        ? path.join(process.resourcesPath, 'rc-n1-bridge.ps1')
        : path.join(__dirname, 'rc-n1-bridge.ps1');
    if (!fs.existsSync(bridgePath)) {
        console.warn('[rc-n1] 桥接脚本不存在:', bridgePath);
        return;
    }

    console.log('[rc-n1] 启动桥接脚本:', bridgePath);
    const child = spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath],
        { windowsHide: true }
    );
    rcBridge = child;

    let buf = '';
    child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const data = JSON.parse(line);
                if (data.connected) {
                    rcLatest.connected = true;
                    rcLatest.port = 'RC-N1';
                    rcLatest.state = {
                        left_h: data.left_h,
                        left_v: data.left_v,
                        right_h: data.right_h,
                        right_v: data.right_v,
                        camera: data.camera,
                    };
                } else {
                    rcLatest.connected = false;
                    rcLatest.state = null;
                }
                broadcastRcState();
            } catch (e) {
                // 忽略非 JSON 行（如 PowerShell 启动横幅）
            }
        }
    });

    child.stderr.on('data', () => {
        // 桥接脚本 stderr 仅用于调试
    });

    child.on('exit', (code) => {
        console.log('[rc-n1] 桥接脚本退出, code =', code);
        rcBridge = null;
        rcLatest.connected = false;
        rcLatest.state = null;
        broadcastRcState();
    });
}

// 渲染进程请求保存录制的视频（或截图）：弹出系统保存对话框并写入文件。
// 由 preload.js 的 window.gamepadApi.saveFile 调用（IPC 通道 'save-video'）。
ipcMain.handle('save-video', async (event, payload) => {
    const { data, type, suggestedName } = payload ?? {};
    if (!data) {
        return false;
    }

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const ext = path.extname(suggestedName || '').toLowerCase() || '.webm';
    const defaultPath = path.join(
        app.getPath('downloads'),
        suggestedName || `capture-${Date.now()}${ext}`
    );

    const options = {
        title: '保存视频',
        defaultPath,
        filters: [
            { name: '视频文件', extensions: ['webm', 'mp4', 'mov'] },
            { name: '所有文件', extensions: ['*'] }
        ]
    };

    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
        return false;
    }

    try {
        await fs.promises.writeFile(result.filePath, buffer);
        console.log(`[save] 已保存: ${result.filePath} (${type || 'application/octet-stream'})`);
        return true;
    } catch (err) {
        console.error('[save] 写入失败:', err);
        return false;
    }
});

async function createWindow() {
    server = await startServer();
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    console.log(`[server] 静态服务已启动: ${origin}`);

    mainWindow = new BrowserWindow({
        width: 1600,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        title: '3DGS-Fly',
        backgroundColor: '#151515',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    // 锁定窗口标题：页面 <title>（SuperSplat）不得覆盖标题栏
    mainWindow.on('page-title-updated', (event) => {
        event.preventDefault();
        mainWindow.setTitle('3DGS-Fly');
    });

    // 外部链接交给系统浏览器，窗口内禁止跳离本应用
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith(origin)) {
            return { action: 'allow' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(origin)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    await mainWindow.loadURL(`${origin}/`);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 单实例锁：避免重复打开多个窗口
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
            const msg = '未找到 web/index.html。\n\n请先在 supersplat 目录执行 npm run build，\n然后在本目录执行 npm run copy:dist（或直接 npm run build:exe）。';
            console.error('[error] ' + msg);
            dialog.showErrorBox('3DGS-Fly', msg);
            app.quit();
            return;
        }

        // 桌面应用不需要 service worker 离线缓存：supersplat 的 sw.js 会缓存
        // index.js，导致「打包了新代码但打开还是旧版」的问题。每次启动先清掉
        // sw 注册 + CacheStorage 缓存，确保始终加载 asar 内最新的 index.js。
        // 这样无论接收方之前是否运行过旧版，都无需手动清缓存。
        try {
            await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
            console.log('[main] 已清除 service worker 缓存');
        } catch (e) {
            console.warn('[main] 清除 sw 缓存失败（忽略）:', e && e.message ? e.message : e);
        }

        await createWindow();

        // 启动 RC-N1 遥控器读取（spawn PowerShell 桥接脚本）
        startRcN1();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('will-quit', () => {
        if (rcBridge) {
            try {
                rcBridge.kill();
            } catch (e) {
                // ignore
            }
            rcBridge = null;
        }
    });
}
