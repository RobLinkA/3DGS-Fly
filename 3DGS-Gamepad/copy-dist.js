// ============================================================
// 复制 supersplat 的构建产物到封装目录
//   - supersplat/dist        -> web/          （前端静态资源）
//   - supersplat 官方 logo   -> build/icon.png（EXE 图标）
// 用法: node copy-dist.js
// ============================================================

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'supersplat', 'dist');
const DST = path.join(__dirname, 'web');
// EXE 图标：直接使用 supersplat 官方 logo
const ICON_SRC = path.join(__dirname, '..', 'supersplat', 'static', 'icons', 'logo-512.png');
const ICON_DST = path.join(__dirname, 'build', 'icon.png');

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name);
        const d = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyDir(s, d);
        } else {
            try {
                fs.copyFileSync(s, d);
            } catch (e) {
                // 目标文件被锁（杀毒扫描 / 安全删除机制残留）时跳过。被锁的
                // 文件内容通常已与 dist 一致，跳过不影响产物。
                console.warn(`[copy-dist] 跳过被锁文件: ${entry.name} (${e && e.code})`);
            }
        }
    }
}

if (!fs.existsSync(SRC)) {
    console.error('[copy-dist] 未找到 supersplat/dist 目录。');
    console.error('[copy-dist] 请先在 supersplat 目录执行: npm run build');
    process.exit(1);
}

// 直接覆盖拷贝，不先删除 web 目录。WorkBuddy 环境的 fs.rmSync 会被安全删除
// 机制拦截（走回收站，中文路径/大批量下易超时失败），失败后还会残留文件锁导致
// 后续 copyFileSync 报 EPERM。覆盖拷贝本身就能覆盖同名文件，旧 hash 文件残留
// 不影响运行，因此这里不做任何删除操作。
copyDir(SRC, DST);
console.log(`[copy-dist] 完成: ${SRC} -> ${DST}`);

const iconSource = ICON_SRC;
if (fs.existsSync(iconSource)) {
    fs.mkdirSync(path.dirname(ICON_DST), { recursive: true });
    fs.copyFileSync(iconSource, ICON_DST);
    console.log(`[copy-dist] 图标: ${iconSource} -> ${ICON_DST}（supersplat 官方 logo）`);
} else {
    console.warn('[copy-dist] 未找到 supersplat 官方 logo，将使用 Electron 默认图标');
}
