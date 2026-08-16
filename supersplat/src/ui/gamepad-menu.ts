import { Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { Tooltips } from './tooltips';

const AUTO_HIDE_DELAY = 5000;

// 速度倍率（6 档），与 rc-n1-controller 的 SPEED_GEARS 保持一致
const SPEED_GEARS = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0];

/**
 * GamepadMenu —— 底部居中的飞行控制菜单（单层级、单组件）。
 *
 * 布局（横向铺开、压低高度）：
 *  - 顶部：打开 / 更换 3D 场景文件（醒目按钮）
 *  - 一行：手型 · 速度 · 高度锁定
 *  - 两行滑块（每行 2 个）：视场角 · 平移 / 转向 · 俯仰
 *  - 动作按钮（返回起始点·设置起始点·云台回中·全屏体验·保存截屏·录制视频）
 *  - 底部：快捷键提示
 *
 * 空场景时额外在屏幕上方显示遥控器引导图 + 「请接入 DJI RC-N1 遥控器」。
 *
 * 显示规则：空场景始终显示；加载模型后隐藏；ESC 唤起/收起；
 * 点击菜单外 / 5 秒无键鼠操作（已加载模型时）自动隐藏。
 */
class GamepadMenu extends Container {
    private events: Events;
    private visible = true;
    private autoHideTimer: number | null = null;
    private lastActivity = 0;

    private rcOverlay: HTMLDivElement;
    private fileInput: HTMLInputElement;
    private handMode2Btn: HTMLButtonElement;
    private handMode1Btn: HTMLButtonElement;
    private gearValue: HTMLSpanElement;
    private heightLockBtn: HTMLButtonElement;
    private fovValue: HTMLSpanElement;
    private sensH: HTMLInputElement;
    private sensHVal: HTMLSpanElement;
    private sensY: HTMLInputElement;
    private sensYVal: HTMLSpanElement;
    private sensG: HTMLInputElement;
    private sensGVal: HTMLSpanElement;
    private connDot: HTMLSpanElement;
    private hasLoadedModel = false;

    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = { ...args, id: 'gamepad-menu' };
        super(args);
        this.events = events;

        const dom = this.dom;

        // ---- 空场景引导图（遥控器 + 提示文字），仅未加载模型时显示 ----
        this.rcOverlay = document.createElement('div');
        this.rcOverlay.className = 'rc-n1-overlay';
        const rcImg = document.createElement('img');
        rcImg.className = 'rc-n1-img';
        rcImg.src = './static/images/rc-n1.png';
        rcImg.alt = 'DJI RC-N1';
        const rcText = document.createElement('div');
        rcText.className = 'rc-n1-text';
        rcText.textContent = '请接入 DJI RC-N1 遥控器';
        this.rcOverlay.appendChild(rcImg);
        this.rcOverlay.appendChild(rcText);
        document.body.append(this.rcOverlay);

        // 单击引导图（图片/文字）也打开文件选择器，降低新用户上手门槛
        this.rcOverlay.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openFilePicker();
        });

        // ---- 头部：标题 + 连接状态 ----
        const header = document.createElement('div');
        header.className = 'gm-header';

        const title = document.createElement('span');
        title.className = 'gm-title';
        title.textContent = '飞行控制';
        header.appendChild(title);

        const status = document.createElement('span');
        status.className = 'gm-status';
        this.connDot = document.createElement('span');
        this.connDot.className = 'gamepad-menu-conn-dot gamepad-menu-conn-off';
        this.connDot.textContent = '●';
        const statusLabel = document.createElement('span');
        statusLabel.textContent = 'RC-N1';
        status.appendChild(this.connDot);
        status.appendChild(statusLabel);
        header.appendChild(status);
        dom.appendChild(header);

        // ---- 打开文件（顶部，醒目）----
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.ply,.splat,meta.json,.json,.webp,.ssproj,.sog,.lcc,.lcc2,.bin,.txt,.ksplat,.spz';
        this.fileInput.multiple = true;
        this.fileInput.style.display = 'none';
        this.fileInput.onchange = () => {
            const files: { filename: string, contents: File }[] = [];
            for (const f of Array.from(this.fileInput.files ?? [])) {
                files.push({ filename: f.name, contents: f });
            }
            this.fileInput.value = '';
            if (files.length > 0) {
                events.invoke('import', files);
            }
        };
        document.body.append(this.fileInput);

        const openBtn = this.button('打开 / 更换 3D 场景');
        openBtn.className += ' gm-open';
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openFilePicker();
        });
        dom.appendChild(openBtn);

        // ---- 一行：手型 · 速度 · 高度锁定 ----
        const rowTop = document.createElement('div');
        rowTop.className = 'gm-row-top';

        const cHand = this.col('手型');
        this.handMode2Btn = this.button('美国手');
        this.handMode2Btn.classList.add('active');
        this.handMode1Btn = this.button('日本手');
        cHand.body.appendChild(this.handMode2Btn);
        cHand.body.appendChild(this.handMode1Btn);
        rowTop.appendChild(cHand.root);

        const cSpeed = this.col('速度');
        const gearDown = this.button('−');
        this.gearValue = document.createElement('span');
        this.gearValue.className = 'gm-value';
        this.gearValue.textContent = '2x';
        const gearUp = this.button('＋');
        cSpeed.body.appendChild(gearDown);
        cSpeed.body.appendChild(this.gearValue);
        cSpeed.body.appendChild(gearUp);
        rowTop.appendChild(cSpeed.root);

        const cFov = this.col('视场角');
        const fovDown = this.button('−');
        this.fovValue = this.valueLabel('75°');
        const fovUp = this.button('＋');
        cFov.body.appendChild(fovDown);
        cFov.body.appendChild(this.fovValue);
        cFov.body.appendChild(fovUp);
        rowTop.appendChild(cFov.root);

        const cLock = this.col('高度锁定');
        this.heightLockBtn = this.button('关');
        cLock.body.appendChild(this.heightLockBtn);
        rowTop.appendChild(cLock.root);

        dom.appendChild(rowTop);

        // ---- 滑块区：平移 · 转向 · 俯仰（一行 3 个）----
        const sliders = document.createElement('div');
        sliders.className = 'gm-sliders';

        const cSensH = this.col('平移');
        this.sensH = this.slider(0.2, 3.0, 0.05, 0.7);
        this.sensHVal = this.valueLabel('0.70');
        cSensH.body.appendChild(this.sensH);
        cSensH.body.appendChild(this.sensHVal);
        sliders.appendChild(cSensH.root);

        const cSensY = this.col('转向');
        this.sensY = this.slider(0.2, 3.0, 0.05, 0.5);
        this.sensYVal = this.valueLabel('0.50');
        cSensY.body.appendChild(this.sensY);
        cSensY.body.appendChild(this.sensYVal);
        sliders.appendChild(cSensY.root);

        const cSensG = this.col('俯仰');
        this.sensG = this.slider(0.2, 3.0, 0.05, 0.5);
        this.sensGVal = this.valueLabel('0.50');
        cSensG.body.appendChild(this.sensG);
        cSensG.body.appendChild(this.sensGVal);
        sliders.appendChild(cSensG.root);

        dom.appendChild(sliders);

        // ---- 动作按钮 ----
        const actions = document.createElement('div');
        actions.className = 'gm-actions';
        actions.appendChild(this.button('返回起点', () => events.fire('gamepad.reset')));
        actions.appendChild(this.button('设置起点', () => events.fire('gamepad.setOrigin')));
        actions.appendChild(this.button('云台回中', () => events.fire('gamepad.resetView')));
        actions.appendChild(this.button('全屏体验', () => events.fire('gamepad.fullscreen')));
        actions.appendChild(this.button('保存截屏', () => events.fire('gamepad.capture')));
        actions.appendChild(this.button('录制视频', () => events.fire('gamepad.recordToggle')));
        dom.appendChild(actions);

        // ---- 快捷键提示 ----
        const hint = document.createElement('div');
        hint.className = 'gm-hint';
        hint.textContent = 'ESC 菜单 · H 返回起点 · R 云台回中 · F 设置起点 · F8 锁高 · F9 截屏 · F10 录制 · ↑↓ 速度 · ←→ 视场角 · F11 全屏';
        dom.appendChild(hint);

        // ==== 事件绑定 ====
        this.handMode2Btn.addEventListener('click', (e) => { e.stopPropagation(); this.setHandMode('mode2'); });
        this.handMode1Btn.addEventListener('click', (e) => { e.stopPropagation(); this.setHandMode('mode1'); });
        gearDown.addEventListener('click', (e) => { e.stopPropagation(); this.stepGear(-1); });
        gearUp.addEventListener('click', (e) => { e.stopPropagation(); this.stepGear(1); });
        this.heightLockBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            events.fire('rc.toggleHeightLock');
        });
        fovDown.addEventListener('click', (e) => { e.stopPropagation(); this.stepFov(-5); });
        fovUp.addEventListener('click', (e) => { e.stopPropagation(); this.stepFov(5); });
        this.sensH.addEventListener('input', () => {
            const v = parseFloat(this.sensH.value);
            this.sensHVal.textContent = v.toFixed(2);
            events.fire('rc.setSensitivity', 'horizontal', v);
        });
        this.sensY.addEventListener('input', () => {
            const v = parseFloat(this.sensY.value);
            this.sensYVal.textContent = v.toFixed(2);
            events.fire('rc.setSensitivity', 'yaw', v);
        });
        this.sensG.addEventListener('input', () => {
            const v = parseFloat(this.sensG.value);
            this.sensGVal.textContent = v.toFixed(2);
            events.fire('rc.setSensitivity', 'gimbal', v);
        });

        // 菜单内部活动：阻止 pointerdown 冒泡到 canvas-container（否则会触发
        // 相机 PointerController 的 setPointerCapture，吞掉按钮的 click）+ 重置计时
        this.dom.addEventListener('pointermove', () => this.scheduleAutoHide());
        this.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            this.scheduleAutoHide();
        });

        // 全局键鼠活动（菜单外）：重置自动隐藏计时（遥控器/手柄输入不算活动）
        window.addEventListener('pointermove', () => this.scheduleAutoHide());
        window.addEventListener('pointerdown', () => this.scheduleAutoHide());
        window.addEventListener('keydown', () => this.scheduleAutoHide());

        events.on('gamepad.menu.toggle', () => this.toggle());
        events.on('rc.active', (active: boolean) => {
            this.connDot.className = active
                ? 'gamepad-menu-conn-dot gamepad-menu-conn-on'
                : 'gamepad-menu-conn-dot gamepad-menu-conn-off';
            this.syncConfig();
        });
        // RC 配置变化（手型/速度/灵敏度/锁高）时刷新菜单 UI
        events.on('rc.configChanged', () => this.syncConfig());
        // 相机 FOV 变化（按钮 / 方向键）时刷新显示
        events.on('camera.fov', (fov: number) => {
            this.fovValue.textContent = `${Math.round(fov)}°`;
        });

        // 模型加载完成后收起菜单（第一次加载与换模型一致）；
        // 场景被清空回无模型时，重新显示菜单与引导图
        events.on('scene.boundChanged', () => {
            this.syncEmptyState();
        });

        this.syncConfig();

        // ESC 呼出/收起菜单
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
            e.preventDefault();
            this.toggle();
        });

        // 点击菜单外区域：隐藏菜单（空场景除外）
        document.addEventListener('click', (e) => {
            if (!this.visible) return;
            if (this.isSceneEmpty()) return;
            const t = e.target as HTMLElement | null;
            if (!t) return;
            if (this.dom.contains(t)) return;
            this.hideMenu();
        });

        // 初始：未加载模型时菜单 + 引导图始终显示
        this.syncEmptyState();
    }

    private col(label: string): { root: HTMLDivElement, body: HTMLDivElement } {
        const root = document.createElement('div');
        root.className = 'gm-col';
        const l = document.createElement('span');
        l.className = 'gm-label';
        l.textContent = label;
        const body = document.createElement('div');
        body.className = 'gm-col-body';
        root.appendChild(l);
        root.appendChild(body);
        return { root, body };
    }

    private valueLabel(text: string): HTMLSpanElement {
        const s = document.createElement('span');
        s.className = 'gm-value';
        s.textContent = text;
        return s;
    }

    private button(text: string, onClick?: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.className = 'gamepad-menu-btn';
        b.textContent = text;
        if (onClick) {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                onClick();
                this.scheduleAutoHide();
            });
        }
        return b;
    }

    private slider(min: number, max: number, step: number, value: number): HTMLInputElement {
        const s = document.createElement('input');
        s.type = 'range';
        s.className = 'gamepad-menu-slider';
        s.min = String(min);
        s.max = String(max);
        s.step = String(step);
        s.value = String(value);
        return s;
    }

    private gearLabel(gear: number): string {
        const g = Math.max(0, Math.min(SPEED_GEARS.length - 1, Math.round(gear)));
        return `${SPEED_GEARS[g]}x`;
    }

    private setHandMode(mode: 'mode1' | 'mode2') {
        this.events.fire('rc.setHandMode', mode);
    }

    private stepGear(delta: number) {
        const cfg = this.events.invoke('rc.config') as any;
        const cur = cfg ? (cfg.speedGear ?? 2) : 2;
        const next = Math.max(0, Math.min(SPEED_GEARS.length - 1, cur + delta));
        this.events.fire('rc.setSpeedGear', next);
    }

    private stepFov(delta: number) {
        const fov = this.events.invoke('camera.fov') as number;
        const cur = typeof fov === 'number' ? fov : 75;
        const next = Math.max(10, Math.min(120, cur + delta));
        this.events.fire('camera.setFov', next);
    }

    // 打开文件选择器；打开对话框期间保持菜单显示（取消自动隐藏计时）
    private openFilePicker() {
        if (this.autoHideTimer !== null) {
            clearTimeout(this.autoHideTimer);
            this.autoHideTimer = null;
        }
        this.fileInput.click();
    }

    // 只刷新 UI，不 fire 事件（避免与 rc.configChanged 形成回环）
    private syncConfig() {
        const cfg = this.events.invoke('rc.config') as any;
        if (!cfg) return;
        const handMode = cfg.handMode ?? 'mode2';
        this.handMode2Btn.classList.toggle('active', handMode === 'mode2');
        this.handMode1Btn.classList.toggle('active', handMode === 'mode1');
        this.gearValue.textContent = this.gearLabel(cfg.speedGear ?? 2);
        this.heightLockBtn.textContent = cfg.heightLocked ? '开' : '关';
        this.heightLockBtn.classList.toggle('active', !!cfg.heightLocked);
        this.sensH.value = String(cfg.sensHorizontal ?? 0.7);
        this.sensHVal.textContent = (cfg.sensHorizontal ?? 0.7).toFixed(2);
        this.sensY.value = String(cfg.sensYaw ?? 0.5);
        this.sensYVal.textContent = (cfg.sensYaw ?? 0.5).toFixed(2);
        this.sensG.value = String(cfg.sensGimbal ?? 0.5);
        this.sensGVal.textContent = (cfg.sensGimbal ?? 0.5).toFixed(2);
    }

    private toggle() {
        if (this.visible) {
            // 空场景时菜单始终显示，ESC 不隐藏
            if (!this.isSceneEmpty()) {
                this.hideMenu();
            }
        } else {
            this.showMenu();
        }
    }

    private showMenu() {
        this.visible = true;
        this.dom.classList.remove('gamepad-menu-hidden');
        this.dom.classList.add('gamepad-menu-visible');
        this.scheduleAutoHide();
    }

    private hideMenu() {
        this.visible = false;
        this.dom.classList.remove('gamepad-menu-visible');
        this.dom.classList.add('gamepad-menu-hidden');
    }

    // 场景是否为空（scene.empty 未注册的初始化早期，按空场景处理）
    private isSceneEmpty(): boolean {
        const r = this.events.invoke('scene.empty');
        return r === undefined || r === true;
    }

    // 同步「菜单 + 引导图」到场景空/非空状态。
    // 引导图只在从未加载过模型时显示：一旦加载过模型，之后换模型/拖拽
    // 都不再显示引导图，只显示菜单。
    private syncEmptyState() {
        const empty = this.isSceneEmpty();
        if (empty) {
            this.showMenu();
        } else {
            this.hasLoadedModel = true;
            this.hideMenu();
        }
        const showImage = empty && !this.hasLoadedModel;
        this.rcOverlay.classList.toggle('rc-n1-hidden', !showImage);
    }

    private scheduleAutoHide() {
        if (!this.visible) return;          // 菜单已隐藏，不启动计时
        if (this.isSceneEmpty()) return;    // 空场景不自动隐藏
        this.lastActivity = Date.now();
        if (this.autoHideTimer !== null) {
            clearTimeout(this.autoHideTimer);
        }
        this.autoHideTimer = window.setTimeout(() => {
            if (this.visible && Date.now() - this.lastActivity >= AUTO_HIDE_DELAY - 100) {
                this.hideMenu();
            }
        }, AUTO_HIDE_DELAY);
    }
}

export { GamepadMenu };
