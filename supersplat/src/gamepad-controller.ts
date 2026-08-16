import { Vec3, math } from 'playcanvas';

import { Camera } from './camera';
import {
    GamepadConfig,
    defaultConfig,
    loadConfig,
    saveConfig
} from './gamepad-config';
import { Events } from './events';

// --- Constants ---

const DEADZONE = 0.08;          // default deadzone (used as applyDeadzone fallback)
const TRIGGER_DEADZONE = 0.02;  // analog trigger deadzone (fixed)
const PITCH_LIMIT = 80;         // degrees, -80 ~ +80

// Base movement speed (scene units per second at gear 1)
const BASE_MOVE_SPEED = 2.0;
// Rotation speed (degrees per second at full stick deflection)
const ROTATION_SPEED = 120.0;
// Height change speed (scene units per second)
const HEIGHT_SPEED = 3.0;
// Gimbal pitch speed (degrees per second, drone mode)
const GIMBAL_PITCH_SPEED = 60.0;
// FOV adjust speed (degrees per second, D-pad left/right held)
const FOV_ADJUST_SPEED = 30.0;

// Exponential speed gears (×2 each step). Gear index 2 = 2.0x is the default.
const SPEED_GEARS = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0];

// --- Utility functions ---

const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Apply radial dead zone to a 2D stick value
const applyDeadzone = (value: number, deadzone: number = DEADZONE) => {
    const mag = Math.abs(value);
    if (mag < deadzone) return 0;
    const sign = Math.sign(value);
    const normalized = (mag - deadzone) / (1 - deadzone);
    return sign * normalized;
};

// Square easing curve - finer control at low deflection, full speed at max
const applyCurve = (value: number) => {
    return Math.sign(value) * value * value;
};

// Exponential smoothing - lerp current towards target
const smooth = (current: number, target: number, factor: number) => {
    return current + (target - current) * factor;
};

// --- Types ---

type GamepadMode = 'gamepad' | 'drone';

interface StickState {
    x: number;
    y: number;
}

// Standard gamepad button indices (reference only - actions use user bindings)
// LS click (10) is fixed and reserved for toggling the settings panel.

// Reusable vectors
const forwardVec = new Vec3();
const cameraPos = new Vec3();
const moveVec = new Vec3();
const newFocal = new Vec3();

/**
 * GamepadController - handles gamepad input for 3DGS model viewing.
 *
 * Supports two modes:
 * 1. "gamepad" - FPS roaming style (left stick move, right stick look, triggers height)
 * 2. "drone"   - American-hand drone flight style (left stick throttle+yaw, right stick pitch+roll)
 *
 * Designed for GameSir T4N Lite (Nova Lite) 2.4G with standard gamepad mapping.
 */
class GamepadController {
    private camera: Camera;
    private events: Events;
    private mode: GamepadMode = 'gamepad';

    // User configuration (button bindings + axis tuning) - single source of truth
    private config: GamepadConfig;

    // True while the settings panel is open (panel takes over all input)
    private settingsOpen = false;

    // True while the RC-N1 remote controller is connected (RC takes over camera input)
    private rcActive = false;

    // True while the bottom control menu is open (D-pad left/right switch mode)
    private menuOpen = false;

    // Speed state
    private speedGearIndex = 2;  // start at gear 2 (2.0x, the default)

    // Height lock
    private heightLocked = false;

    // Drone mode gimbal independence
    private followMode = true;  // true: gimbal follows flight direction; false: free gimbal

    // Smoothed stick values for buttery control
    private leftStick: StickState = { x: 0, y: 0 };
    private rightStick: StickState = { x: 0, y: 0 };
    private ltValue = 0;
    private rtValue = 0;
    private lbHeld = false;
    private rbHeld = false;

    // Button edge detection (previous frame state)
    private prevButtons: boolean[] = new Array(18).fill(false);

    // Throttle for the button-mapping diagnostic log
    private diagLogTime = 0;

    // Initial camera pose for reset (model baseline, set when the scene bound changes)
    private initialPose: {
        focalPoint: Vec3;
        azim: number;
        elev: number;
        distance: number;
    } | null = null;

    // User-defined start pose (set via the "set origin" action).
    // Reset restores this pose; it defaults to the model baseline on load.
    private startPose: {
        focalPoint: Vec3;
        azim: number;
        elev: number;
        distance: number;
    } | null = null;

    // Active gamepad index
    private gamepadIndex: number | null = null;

    // Track whether gamepad was ever connected
    private wasConnected = false;

    constructor(camera: Camera, events: Events) {
        this.camera = camera;
        this.events = events;

        // Load persisted user configuration (button bindings + axis tuning)
        this.config = loadConfig();

        // Guarantee every action has a valid binding even if persisted storage
        // is partial/corrupted. A missing entry would throw inside
        // handleButtons ('Cannot read properties of undefined') and silently
        // kill ALL button actions while sticks/triggers keep working - which
        // looks exactly like "only direction and height keys respond".
        const fullDefaults = defaultConfig();
        for (const id of Object.keys(fullDefaults.bindings)) {
            const b = this.config.bindings[id];
            if (!b || typeof b.index !== 'number' || (b.type !== 'button' && b.type !== 'trigger')) {
                this.config.bindings[id] = { ...fullDefaults.bindings[id] };
            }
        }

        // Expose the authoritative config to UI panels (e.g. the settings overlay)
        events.function('gamepad.config', () => this.config);

        // Settings panel applies a modified config
        events.on('gamepad.setConfig', (cfg: GamepadConfig) => {
            this.config = cfg;
            saveConfig(cfg);
            events.fire('gamepad.configChanged', cfg);
        });

        // Settings panel restores defaults
        events.on('gamepad.resetConfig', () => {
            this.config = defaultConfig();
            saveConfig(this.config);
            events.fire('gamepad.configChanged', this.config);
        });

        // Settings panel open/close (triggered by LS click or the bottom menu)
        events.on('gamepad.settingsOpen', () => {
            this.settingsOpen = true;
        });
        events.on('gamepad.settingsClosed', () => {
            this.settingsOpen = false;
        });

        // Bottom control menu visibility (D-pad left/right switch mode while open)
        events.on('gamepad.menuVisibility', (open: boolean) => {
            this.menuOpen = open;
        });

        // Listen for mode changes from the menu UI
        events.on('gamepad.setMode', (mode: GamepadMode) => {
            this.mode = mode;
        });

        events.function('gamepad.mode', () => this.mode);

        // RC-N1 遥控器连接/断开时让位，避免双控制器抢相机
        events.on('rc.active', (active: boolean) => {
            this.rcActive = !!active;
        });

        // 菜单按钮动作（RC-N1 无按键，这些动作从菜单/键盘触发）
        events.on('gamepad.reset', () => { this.resetToInitial(); });
        events.on('gamepad.setOrigin', () => { this.setOrigin(); });
        events.on('gamepad.resetView', () => { this.camera.setAzimElev(this.camera.azim, 0, 0); });
        events.on('gamepad.fullscreen', () => { this.toggleFullscreen(); });

        // Listen for height lock toggle from external sources (e.g. the settings panel)
        events.on('gamepad.toggleHeightLock', () => {
            this.toggleHeightLock();
        });

        events.function('gamepad.heightLocked', () => this.heightLocked);

        // Listen for manual speed gear changes
        events.on('gamepad.setSpeedGear', (index: number) => {
            this.speedGearIndex = clamp(index, 0, SPEED_GEARS.length - 1);
            events.fire('gamepad.speedGear', this.speedGearIndex);
        });

        events.function('gamepad.speedGear', () => this.speedGearIndex);

        // Store initial pose when scene bound changes (model loaded)
        events.on('scene.boundChanged', () => {
            this.storeInitialPose();
        });

        // Detect gamepad connection/disconnection
        window.addEventListener('gamepadconnected', (e: GamepadEvent) => {
            this.gamepadIndex = e.gamepad.index;
            this.wasConnected = true;
            console.log(`Gamepad connected: ${e.gamepad.id}`);
            events.fire('gamepad.connected', e.gamepad.id);
        });

        window.addEventListener('gamepaddisconnected', (e: GamepadEvent) => {
            if (this.gamepadIndex === e.gamepad.index) {
                this.gamepadIndex = null;
                console.log(`Gamepad disconnected: ${e.gamepad.id}`);
                events.fire('gamepad.disconnected');
            }
        });

        // Keyboard shortcuts: keep the gamepad button actions available to
        // keyboard/mouse users (RC-N1 has no exposed buttons).
        window.addEventListener('keydown', (e: KeyboardEvent) => {
            this.handleKeydown(e);
        });

        // Register for the per-frame update event
        events.on('update', (dt: number) => this.update(dt));
    }

    /**
     * Keyboard shortcuts for the gamepad button actions. Uses F8-F10, Home,
     * End, Numpad +/- (none conflict with the editor or WASD fly keys).
     * F11 为 Electron 原生窗口全屏（由主进程默认菜单提供），此处不再重复绑定。
     */
    private handleKeydown(e: KeyboardEvent) {
        // 忽略按键自动重复：长按 F9/F10 等会重复触发截图/录制等离散动作
        if (e.repeat) return;

        // 方向键：↑/↓ 调节速度，←/→ 调节视场角（FOV）。
        // 优先处理（即使焦点在 range 滑条等控件上也生效）。
        switch (e.code) {
            case 'ArrowUp':
                e.preventDefault();
                this.stepRcGear(1);
                return;
            case 'ArrowDown':
                e.preventDefault();
                this.stepRcGear(-1);
                return;
            case 'ArrowLeft':
                e.preventDefault();
                this.stepFov(-5);
                return;
            case 'ArrowRight':
                e.preventDefault();
                this.stepFov(5);
                return;
        }

        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }

        switch (e.key) {
            case 'h':
            case 'H':        // 返回起始点
                e.preventDefault();
                this.resetToInitial();
                break;
            case 'r':
            case 'R':        // 云台回中 / 重置视角
                e.preventDefault();
                this.camera.setAzimElev(this.camera.azim, 0, 0);
                break;
            case 'f':
            case 'F':        // 设置起始点
                e.preventDefault();
                this.setOrigin();
                break;
            case 'F8':        // 锁定高度
                e.preventDefault();
                this.events.fire('rc.toggleHeightLock');
                break;
            case 'F9':        // 截屏
                e.preventDefault();
                this.events.fire('gamepad.capture');
                break;
            case 'F10':       // 开始/停止录制
                e.preventDefault();
                this.events.fire('gamepad.recordToggle');
                break;
        }
    }

    // 调整 RC-N1 速度（键盘方向键上下与菜单共用同一份 RC 配置）
    private stepRcGear(delta: number) {
        const cfg = this.events.invoke('rc.config') as any;
        const cur = cfg ? (cfg.speedGear ?? 2) : 2;
        const next = Math.max(0, Math.min(5, cur + delta));
        this.events.fire('rc.setSpeedGear', next);
    }

    // 调整视场角（键盘方向键左右与菜单共用同一份 FOV 设置）
    private stepFov(delta: number) {
        const fov = this.events.invoke('camera.fov') as number;
        const cur = typeof fov === 'number' ? fov : 75;
        const next = Math.max(10, Math.min(120, cur + delta));
        this.events.fire('camera.setFov', next);
    }

    private storeInitialPose() {
        const pose = {
            focalPoint: this.camera.focalPoint.clone(),
            azim: this.camera.azim,
            elev: this.camera.elevation,
            distance: this.camera.distance
        };
        this.initialPose = pose;
        // A newly loaded model also resets the user-defined start point,
        // so "reset" always returns somewhere meaningful.
        this.startPose = pose;
    }

    /**
     * Get the currently active gamepad, if any.
     * Polls navigator.getGamepads() because Gamepad state must be read each frame.
     */
    private getGamepad(): Gamepad | null {
        // If we have a known index, try that first
        if (this.gamepadIndex !== null) {
            const pads = navigator.getGamepads();
            if (pads[this.gamepadIndex]) {
                return pads[this.gamepadIndex];
            }
        }

        // Fall back to scanning all gamepads
        const pads = navigator.getGamepads();
        for (let i = 0; i < pads.length; i++) {
            if (pads[i]) {
                this.gamepadIndex = i;
                return pads[i];
            }
        }

        return null;
    }

    /**
     * A button counts as "active" when .pressed is true OR when its analog
     * .value exceeds a threshold. Some gamepads (e.g. in non-standard mapping
     * modes) keep .pressed false while still reporting .value - relying on
     * .pressed alone would silently disable every button action while
     * sticks/triggers (read via .value) keep working.
     */
    private btnActive(buttonIndex: number, gamepad: Gamepad): boolean {
        const b = gamepad.buttons[buttonIndex];
        if (!b) return false;
        if (b.pressed) return true;
        return typeof b.value === 'number' && b.value > 0.5;
    }

    /**
     * Check if a button was just pressed (rising edge).
     */
    private justPressed(buttonIndex: number, gamepad: Gamepad): boolean {
        const current = this.btnActive(buttonIndex, gamepad);
        const prev = this.prevButtons[buttonIndex] ?? false;
        return current && !prev;
    }

    /**
     * Get analog trigger value (0-1).
     */
    private getTriggerValue(buttonIndex: number, gamepad: Gamepad): number {
        const button = gamepad.buttons[buttonIndex];
        if (!button) return 0;
        // Triggers expose a .value property (0-1)
        if (typeof button.value === 'number') {
            return Math.max(0, button.value - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE);
        }
        // Digital-only buttons fall back to the shared active check
        return this.btnActive(buttonIndex, gamepad) ? 1 : 0;
    }

    /**
     * Snapshot the current button state into prevButtons for rising-edge
     * detection.
     *
     * IMPORTANT: must run AFTER every justPressed() consumer (the LS toggle
     * above and handleButtons below). If the snapshot is refreshed mid-frame
     * before those consumers run, prev equals the current state, every rising
     * edge reads `current && !prev` = false, and ALL button actions silently
     * die while sticks/triggers (read via .value) keep working - which looked
     * exactly like "only direction and height keys respond".
     */
    private refreshPrevButtons(gamepad: Gamepad) {
        for (let i = 0; i < gamepad.buttons.length; i++) {
            this.prevButtons[i] = this.btnActive(i, gamepad);
        }
    }

    /**
     * Main per-frame update.
     */
    private update(deltaTime: number) {
        const gamepad = this.getGamepad();
        if (!gamepad) return;

        // LS click (index 10 - fixed, not rebindable) toggles the settings panel.
        // Checked even while the panel is open so it can be closed from the controller.
        // While the panel is open only the close direction is allowed: a press can
        // never re-open it or desync the panel from the controller.
        if (this.justPressed(10, gamepad)) {
            if (this.settingsOpen) {
                this.settingsOpen = false;
                this.events.fire('gamepad.settingsClosed');
            } else {
                this.settingsOpen = true;
                this.events.fire('gamepad.settingsOpen');
            }
        }

        // While the settings panel is open the controller pauses all camera input.
        // Keep edge-detection state fresh so a held button can't trigger an
        // action right after the panel closes.
        if (this.settingsOpen) {
            this.refreshPrevButtons(gamepad);
            return;
        }

        // RC-N1 连接时遥控器接管相机控制，手柄仅保持按键边沿状态同步
        if (this.rcActive) {
            this.refreshPrevButtons(gamepad);
            return;
        }

        const cfg = this.config.axis;
        const bindings = this.config.bindings;

        // --- Read raw stick values ---
        const rawLeftX = gamepad.axes[0] ?? 0;
        const rawLeftY = gamepad.axes[1] ?? 0;
        const rawRightX = gamepad.axes[2] ?? 0;
        const rawRightY = gamepad.axes[3] ?? 0;

        // Apply user-configured dead zone
        const targetLeftX = applyDeadzone(rawLeftX, cfg.deadzone);
        const targetLeftY = applyDeadzone(rawLeftY, cfg.deadzone);
        const targetRightX = applyDeadzone(rawRightX, cfg.deadzone);
        const targetRightY = applyDeadzone(rawRightY, cfg.deadzone);

        // Square easing curve, then user sensitivity and axis inversion
        let curvedLeftX = applyCurve(targetLeftX);
        let curvedLeftY = applyCurve(targetLeftY);
        let curvedRightX = applyCurve(targetRightX);
        let curvedRightY = applyCurve(targetRightY);

        // Apply per-axis sensitivity. The physical meaning of each stick differs
        // by mode (Mode 2):
        //   gamepad mode: left stick = move (translate), right stick = look (rotate)
        //   drone mode:   left stick = yaw (rotate) + throttle (translate),
        //                 right stick = pitch/forward + roll/strafe (translate)
        if (this.mode === 'gamepad') {
            curvedLeftX *= cfg.moveSensitivity;
            curvedLeftY *= cfg.moveSensitivity;
            curvedRightX *= cfg.lookSensitivity;        // yaw
            curvedRightY *= cfg.lookPitchSensitivity;   // pitch
        } else {
            curvedLeftX *= cfg.lookSensitivity;         // yaw (heading)
            curvedLeftY *= cfg.moveSensitivity;         // throttle (climb)
            curvedRightX *= cfg.moveSensitivity;        // roll (strafe)
            curvedRightY *= cfg.moveSensitivity;        // pitch (forward/back)
        }

        if (cfg.invertLeftX) curvedLeftX = -curvedLeftX;
        if (cfg.invertLeftY) curvedLeftY = -curvedLeftY;
        if (cfg.invertRightX) curvedRightX = -curvedRightX;
        if (cfg.invertRightY) curvedRightY = -curvedRightY;

        // Exponential smoothing for buttery analog feel
        const sf = 1 - Math.pow(1 - cfg.smoothing, deltaTime * 60);
        this.leftStick.x = smooth(this.leftStick.x, curvedLeftX, sf);
        this.leftStick.y = smooth(this.leftStick.y, curvedLeftY, sf);
        this.rightStick.x = smooth(this.rightStick.x, curvedRightX, sf);
        this.rightStick.y = smooth(this.rightStick.y, curvedRightY, sf);

        // Read triggers (analog or digital depending on the bound control)
        const targetLT = this.getTriggerValue(bindings['ascend'].index, gamepad);
        const targetRT = this.getTriggerValue(bindings['descend'].index, gamepad);
        this.ltValue = smooth(this.ltValue, targetLT, sf);
        this.rtValue = smooth(this.rtValue, targetRT, sf);

        // Read shoulder buttons (hold-to-sprint / hold-to-slow)
        this.lbHeld = this.btnActive(bindings['sprint'].index, gamepad);
        this.rbHeld = this.btnActive(bindings['slow'].index, gamepad);

        // --- Handle button presses (edge detected) ---
        this.handleButtons(gamepad);

        // --- D-pad left/right ---
        // While the control menu is open, left/right switch the control mode
        // (left = FPS roam, right = drone) instead of adjusting FOV.
        if (this.menuOpen) {
            if (this.justPressed(bindings['dpadLeft'].index, gamepad)) {
                this.events.fire('gamepad.setMode', 'gamepad');
            }
            if (this.justPressed(bindings['dpadRight'].index, gamepad)) {
                this.events.fire('gamepad.setMode', 'drone');
            }
        } else {
            // Menu closed: FOV adjust (hold to continuously change).
            // Left = decrease FOV (telephoto / zoom in), Right = increase FOV (wide / zoom out)
            if (this.btnActive(bindings['dpadLeft'].index, gamepad)) {
                const fov = this.events.invoke('camera.fov') as number;
                this.events.fire('camera.setFov', clamp(fov - FOV_ADJUST_SPEED * deltaTime, 10, 120));
            }
            if (this.btnActive(bindings['dpadRight'].index, gamepad)) {
                const fov = this.events.invoke('camera.fov') as number;
                this.events.fire('camera.setFov', clamp(fov + FOV_ADJUST_SPEED * deltaTime, 10, 120));
            }
        }

        // --- Apply movement based on mode ---
        if (this.mode === 'gamepad') {
            this.updateGamepadMode(deltaTime);
        } else {
            this.updateDroneMode(deltaTime);
        }

        // Snapshot button state for rising-edge detection. Must run at the END
        // of the frame - after all justPressed() consumers (LS toggle above and
        // handleButtons) have read the previous-frame snapshot. Refreshing any
        // earlier makes every rising edge read prev == current and silently
        // disables ALL button actions.
        this.refreshPrevButtons(gamepad);
    }

    /**
     * Handle discrete button presses using the user-configured bindings.
     */
    private handleButtons(gamepad: Gamepad) {
        const b = this.config.bindings;

        // Reset to origin / birth point (HOME)
        if (this.justPressed(b['reset'].index, gamepad)) {
            this.resetToInitial();
        }

        // Toggle fullscreen
        if (this.justPressed(b['fullscreen'].index, gamepad)) {
            this.toggleFullscreen();
        }

        // Toggle mode selection menu (gamepad X: menu only, no import card)
        if (this.justPressed(b['menu'].index, gamepad)) {
            this.events.fire('gamepad.menu.toggle', false);
        }

        // Toggle height lock
        if (this.justPressed(b['lockHeight'].index, gamepad)) {
            this.toggleHeightLock();
        }

        // Increase speed gear
        if (this.justPressed(b['gearUp'].index, gamepad)) {
            if (this.speedGearIndex < SPEED_GEARS.length - 1) {
                this.speedGearIndex++;
                this.events.fire('gamepad.speedGear', this.speedGearIndex);
            }
        }

        // Decrease speed gear
        if (this.justPressed(b['gearDown'].index, gamepad)) {
            if (this.speedGearIndex > 0) {
                this.speedGearIndex--;
                this.events.fire('gamepad.speedGear', this.speedGearIndex);
            }
        }

        // D-pad left/right - FOV adjust (handled in update() for continuous hold)

        // Set origin / birth point (A) - store the current pose as the reset start point
        if (this.justPressed(b['setOrigin'].index, gamepad)) {
            this.setOrigin();
        }

        // Screenshot (BACK) - capture a still frame of the current view
        if (this.justPressed(b['screenshot'].index, gamepad)) {
            this.events.fire('gamepad.capture');
        }

        // Record video (START) - start / stop canvas recording
        if (this.justPressed(b['recordVideo'].index, gamepad)) {
            this.events.fire('gamepad.recordToggle');
        }

        // Reset view orientation (level pitch)
        if (this.justPressed(b['resetView'].index, gamepad)) {
            const cam = this.camera;
            cam.setAzimElev(cam.azim, 0, 0);
        }

        // --- Diagnostic: pressed buttons that map to no action ---
        // Helps identify gamepad mapping/mode problems: if the controller
        // reports a different button index than the default binding (e.g. the
        // pad was switched to DInput/Android mode), the press shows up here.
        // Throttled to ~1 log per 3s so a held button doesn't spam the console.
        const now = Date.now();
        if (now - this.diagLogTime > 3000) {
            const pressedIdx: number[] = [];
            for (let i = 0; i < Math.min(gamepad.buttons.length, 32); i++) {
                const btn = gamepad.buttons[i];
                // Include buttons reported via .value only (some mappings report
                // analog buttons without flipping .pressed)
                if (btn?.pressed) pressedIdx.push(i);
                else if (btn && typeof btn.value === 'number' && btn.value > 0.5) pressedIdx.push(i);
            }
            if (pressedIdx.length > 0) {
                const bound = new Set<number>();
                for (const key of Object.keys(b)) {
                    const bind = b[key];
                    if (bind && typeof bind.index === 'number') bound.add(bind.index);
                }
                const unbound = pressedIdx.filter((i) => !bound.has(i));
                if (unbound.length > 0) {
                    console.warn(
                        `[gamepad] 检测到未绑定/异常的按钮按下: [${unbound.join(', ')}] ` +
                        `(默认: A=0 B=1 X=2 Y=3 LB=4 RB=5 LT=6 RT=7 Back=8 Start=9 LS=10 RS=11 ` +
                        `十字=12-15 Home=16 Share=17)。若与实际按键不符，说明手柄处于非标准映射模式，` +
                        `可在设置面板中重新绑定按键。`
                    );
                    this.diagLogTime = now;
                }
            }
        }
    }

    /**
     * Get the current speed multiplier based on gear, shoulder buttons, and triggers.
     */
    private getSpeedMultiplier(): number {
        const gear = SPEED_GEARS[this.speedGearIndex];

        // Shoulder buttons provide discrete speed modifiers in BOTH modes.
        // In drone mode LB/RB no longer drive the gimbal (LT/RT do now), so
        // they act as sprint/slow here exactly like in gamepad mode. This also
        // removes the old side effect where holding LB/RB to tilt the gimbal
        // silently changed the flight speed.
        if (this.lbHeld) return gear * 2.0;       // LB: sprint 2x
        if (this.rbHeld) return gear * 0.3;       // RB: precision 0.3x

        // Triggers no longer scale speed in either mode:
        // gamepad mode uses them for height, drone mode for gimbal pitch.
        return gear;
    }

    // --- Camera manipulation helpers ---

    /**
     * Move the camera's focal point by a world-space delta.
     * Uses immediate update (no tween) for responsive gamepad control.
     */
    private moveFocalPoint(dx: number, dy: number, dz: number) {
        const cam = this.camera;
        const fp = cam.focalPoint;
        newFocal.set(fp.x + dx, fp.y + dy, fp.z + dz);
        cam.setFocalPoint(newFocal, 0);
    }

    /**
     * Rotate the camera's view (azim/elev) while keeping the camera position fixed.
     * This is the "look around" behavior - the camera stays in place but rotates.
     */
    private lookAround(deltaAzim: number, deltaElev: number) {
        const cam = this.camera;
        const d = cam.distance * cam.sceneRadius / cam.fovFactor;

        // Get current camera position (before rotation)
        Camera.calcForwardVec(forwardVec, cam.azim, cam.elevation);
        cameraPos.copy(cam.focalPoint).add(forwardVec.mulScalar(d));

        // Calculate new angles with clamping
        const newAzim = mod(cam.azim - deltaAzim, 360);
        const newElev = clamp(cam.elevation - deltaElev, -PITCH_LIMIT, PITCH_LIMIT);

        // Calculate new focal point so camera stays in place
        Camera.calcForwardVec(forwardVec, newAzim, newElev);
        newFocal.copy(cameraPos).sub(forwardVec.mulScalar(d));

        // Apply immediately
        cam.setAzimElev(newAzim, newElev, 0);
        cam.setFocalPoint(newFocal, 0);
        cam.lookCameraPos = null;
    }

    /**
     * Rotate the camera's view without moving the camera position.
     * Only adjusts azim/elev, which changes where the camera looks.
     * In the orbit-based camera system, changing azim/elev while keeping
     * the focal point and distance the same effectively rotates the view.
     */
    private rotateView(deltaAzim: number, deltaElev: number) {
        const cam = this.camera;
        const newAzim = mod(cam.azim - deltaAzim, 360);
        const newElev = clamp(cam.elevation - deltaElev, -PITCH_LIMIT, PITCH_LIMIT);
        cam.setAzimElev(newAzim, newElev, 0);
    }

    /**
     * Adjust camera elevation (gimbal pitch) independently - used in drone mode
     * for LT/RT trigger gimbal control (RT up / LT down, analog amplitude).
     * This rotates the view while keeping position fixed.
     */
    private pitchGimbal(deltaElev: number) {
        this.lookAround(0, deltaElev);
    }

    // --- Mode: Gamepad (FPS roaming) ---

    private updateGamepadMode(deltaTime: number) {
        const cam = this.camera;
        const speed = this.getSpeedMultiplier();
        const moveSpeed = BASE_MOVE_SPEED * speed * deltaTime;
        const rotSpeed = ROTATION_SPEED * speed * deltaTime;
        const heightSpd = HEIGHT_SPEED * speed * deltaTime;

        // Left stick: planar movement (WASD-style)
        // X = strafe left/right, Y = forward/backward
        const strafe = this.leftStick.x;
        const forward = -this.leftStick.y;  // stick up is negative Y

        if (strafe !== 0 || forward !== 0) {
            const wt = cam.worldTransform;
            moveVec.set(0, 0, 0);

            // Forward/backward along horizontal forward direction (fixed Y)
            if (forward !== 0) {
                const zAxis = wt.getZ();
                zAxis.y = 0;
                // Safety: if camera looks straight up/down, use azim-based direction
                if (zAxis.lengthSq() < 1e-6) {
                    const azimRad = cam.azim * math.DEG_TO_RAD;
                    zAxis.set(Math.sin(azimRad), 0, -Math.cos(azimRad));
                }
                zAxis.normalize();
                moveVec.add(zAxis.mulScalar(-forward * moveSpeed));
            }

            // Strafe left/right (horizontal)
            if (strafe !== 0) {
                const xAxis = wt.getX();
                xAxis.y = 0;
                if (xAxis.lengthSq() < 1e-6) {
                    const azimRad = cam.azim * math.DEG_TO_RAD;
                    xAxis.set(Math.cos(azimRad), 0, Math.sin(azimRad));
                }
                xAxis.normalize();
                moveVec.add(xAxis.mulScalar(strafe * moveSpeed));
            }

            this.moveFocalPoint(moveVec.x, moveVec.y, moveVec.z);
        }

        // Right stick: look around (yaw + pitch)
        const lookX = this.rightStick.x;
        const lookY = this.rightStick.y;
        if (lookX !== 0 || lookY !== 0) {
            this.lookAround(
                lookX * rotSpeed,
                lookY * rotSpeed
            );
        }

        // Triggers: height up/down (unless height is locked)
        if (!this.heightLocked) {
            const heightDelta = (this.rtValue - this.ltValue) * heightSpd;
            if (heightDelta !== 0) {
                this.moveFocalPoint(0, heightDelta, 0);
            }
        }
    }

    // --- Mode: Drone (American-hand flight) ---
    //
    // Stick layout (unchanged):
    //   left stick  = throttle (Y) + yaw (X)
    //   right stick = pitch / forward-back (Y) + roll / strafe (X)
    // Trigger layout (gimbal pitch with analog amplitude):
    //   RT = look up, LT = look down; tilt speed follows trigger depth
    // Shoulder buttons (speed modifiers):
    //   LB = 2x sprint, RB = 0.3x precision (same as gamepad mode)

    private updateDroneMode(deltaTime: number) {
        const cam = this.camera;
        const speed = this.getSpeedMultiplier();
        const moveSpeed = BASE_MOVE_SPEED * speed * deltaTime;
        const rotSpeed = ROTATION_SPEED * speed * deltaTime;
        const heightSpd = HEIGHT_SPEED * speed * deltaTime;

        // Left stick: throttle (Y) + yaw (X)
        // Y up = ascend, Y down = descend
        // X left/right = rotate left/right (yaw)
        const throttle = -this.leftStick.y;  // stick up is negative Y
        const yaw = this.leftStick.x;

        // Right stick: pitch (Y) + roll (X)
        // Y up = fly forward, Y down = fly backward
        // X = strafe left/right
        const pitch = -this.rightStick.y;    // stick up is negative Y
        const roll = this.rightStick.x;

        // Yaw - rotate view (changes heading)
        if (yaw !== 0) {
            // In drone mode, yaw rotates the view while keeping position fixed
            this.lookAround(yaw * rotSpeed, 0);
        }

        // Throttle - ascend/descend (unless height locked)
        if (!this.heightLocked && throttle !== 0) {
            this.moveFocalPoint(0, throttle * heightSpd, 0);
        }

        // Forward/backward flight
        // In follow mode, movement is along the camera's forward direction
        // In free gimbal mode, movement is along the heading (azim) direction
        if (pitch !== 0 || roll !== 0) {
            moveVec.set(0, 0, 0);

            if (this.followMode) {
                // Use camera's actual forward/right vectors
                const wt = cam.worldTransform;
                if (pitch !== 0) {
                    const zAxis = wt.getZ();
                    zAxis.y = 0;
                    if (zAxis.lengthSq() < 1e-6) {
                        const azimRad = cam.azim * math.DEG_TO_RAD;
                        zAxis.set(Math.sin(azimRad), 0, -Math.cos(azimRad));
                    }
                    zAxis.normalize();
                    moveVec.add(zAxis.mulScalar(-pitch * moveSpeed));
                }
                if (roll !== 0) {
                    const xAxis = wt.getX();
                    xAxis.y = 0;
                    if (xAxis.lengthSq() < 1e-6) {
                        const azimRad = cam.azim * math.DEG_TO_RAD;
                        xAxis.set(Math.cos(azimRad), 0, Math.sin(azimRad));
                    }
                    xAxis.normalize();
                    moveVec.add(xAxis.mulScalar(roll * moveSpeed));
                }
            } else {
                // Free gimbal: move along heading direction (azim only, no pitch influence)
                const azimRad = cam.azim * math.DEG_TO_RAD;
                const sinA = Math.sin(-azimRad);
                const cosA = Math.cos(-azimRad);
                if (pitch !== 0) {
                    // Camera view direction (horizontal component) = (-sinA, 0, -cosA)
                    moveVec.x += -sinA * pitch * moveSpeed;
                    moveVec.z += -cosA * pitch * moveSpeed;
                }
                if (roll !== 0) {
                    // Camera right direction = (cosA, 0, -sinA)
                    moveVec.x += cosA * roll * moveSpeed;
                    moveVec.z += -sinA * roll * moveSpeed;
                }
            }

            if (moveVec.x !== 0 || moveVec.y !== 0 || moveVec.z !== 0) {
                this.moveFocalPoint(moveVec.x, moveVec.y, moveVec.z);
            }
        }

        // Gimbal pitch driven by the analog triggers: RT = look up, LT = look
        // down, with the tilt speed scaling linearly with how far the trigger
        // is pressed - this gives the user fine amplitude control that the
        // old hold-to-tilt LB/RB mapping could not.
        //
        // Sign convention: deltaElev < 0 raises the elevation angle (look up,
        // same sign the old LB used), deltaElev > 0 lowers it (look down).
        // deltaElev = (ltValue - rtValue) * speed * dt => RT presses (rtValue
        // positive) yield a negative delta = up, LT presses yield down.
        const gimbalDelta = (this.ltValue - this.rtValue) * GIMBAL_PITCH_SPEED * this.config.axis.lookPitchSensitivity * deltaTime;
        if (gimbalDelta !== 0) {
            this.pitchGimbal(gimbalDelta);
        }
    }

    // --- Action handlers ---

    /**
     * Toggle the height lock and notify all UI (menu status bar, settings
     * panel lock row). Single funnel so controller and UI can never desync.
     */
    private toggleHeightLock() {
        this.heightLocked = !this.heightLocked;
        this.events.fire('gamepad.heightLock', this.heightLocked);
    }

    /**
     * Store the current camera pose as the reset start point.
     */
    private setOrigin() {
        this.startPose = {
            focalPoint: this.camera.focalPoint.clone(),
            azim: this.camera.azim,
            elev: this.camera.elevation,
            distance: this.camera.distance
        };
        this.events.fire('gamepad.originSet');
    }

    /**
     * Reset the camera to the user-defined start point (falls back to the
     * model baseline pose on first use / after a model load).
     */
    private resetToInitial() {
        const pose = this.startPose ?? this.initialPose;
        if (!pose) {
            // Fallback: use camera reset event
            this.events.fire('camera.reset');
            return;
        }

        const cam = this.camera;
        cam.setFocalPoint(pose.focalPoint.clone(), 0);
        cam.setAzimElev(pose.azim, pose.elev, 0);
        cam.setDistance(pose.distance, 0);

        // Reset state - unlock height via the shared funnel so the lock
        // indicator (menu + settings panel) stays in sync (only if it was on)
        if (this.heightLocked) this.toggleHeightLock();
        this.followMode = true;
        this.events.fire('gamepad.followMode', true);
    }

    private toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {
                // Fallback: try webkit prefix for older browsers
                const anyEl = document.documentElement as any;
                if (anyEl.webkitRequestFullscreen) {
                    anyEl.webkitRequestFullscreen();
                }
            });
        } else {
            document.exitFullscreen().catch(() => {
                const anyDoc = document as any;
                if (anyDoc.webkitExitFullscreen) {
                    anyDoc.webkitExitFullscreen();
                }
            });
        }
    }
}

export { GamepadController };
