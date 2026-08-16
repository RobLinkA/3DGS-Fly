/**
 * gamepad-config.ts
 *
 * Central configuration model for the gamepad controller.
 *
 * Two categories of settings:
 *  1. Button bindings  - remappable actions (buttons & analog triggers)
 *  2. Axis settings    - stick sensitivity, invert, deadzone, smoothing
 *
 * Defaults match the GameSir T4N Lite (Nova Lite) standard mapping.
 * User changes are persisted to localStorage.
 */

// --- Binding model ---

export type BindingType = 'button' | 'trigger';

export interface Binding {
    type: BindingType;
    index: number;
}

export interface ActionDef {
    id: string;
    label: string;
    default: Binding;
}

// Standard gamepad button indices (GameSir T4N Lite follows the standard mapping)
export const BTN_NAMES: Record<number, string> = {
    0: 'A',
    1: 'B',
    2: 'X',
    3: 'Y',
    4: 'LB',
    5: 'RB',
    6: 'LT',
    7: 'RT',
    8: 'Back',
    9: 'Start',
    10: 'LS(左摇杆按下)',
    11: 'RS(右摇杆按下)',
    12: '十字键上',
    13: '十字键下',
    14: '十字键左',
    15: '十字键右',
    16: 'Home',
    17: '分享',
    26: '未绑定'
};

// PlayStation protocol names (indices are identical to the standard layout;
// only the labels differ). Used when the 'playstation' preset is active.
export const BTN_NAMES_PS: Record<number, string> = {
    0: '✕ (Cross)',
    1: '○ (Circle)',
    2: '□ (Square)',
    3: '△ (Triangle)',
    4: 'L1',
    5: 'R1',
    6: 'L2',
    7: 'R2',
    8: 'Share',
    9: 'Options',
    10: 'L3(左摇杆按下)',
    11: 'R3(右摇杆按下)',
    12: '十字键上',
    13: '十字键下',
    14: '十字键左',
    15: '十字键右',
    16: 'PS',
    17: '触摸板',
    26: '未绑定'
};

export type PresetId = 'xbox' | 'playstation';

export const bindingName = (binding: Binding, preset: PresetId = 'xbox'): string => {
    const table = preset === 'playstation' ? BTN_NAMES_PS : BTN_NAMES;
    return table[binding.index] ?? `按键${binding.index}`;
};

export const bindingEquals = (a: Binding, b: Binding): boolean => {
    return a.type === b.type && a.index === b.index;
};

// Indices that can never be reassigned: LS/RS clicks open the settings panel,
// so they are excluded from the rebinding targets and filtered on load.
export const RESERVED_BINDING_INDICES = [10, 11];

// --- Default bindings ---

export const DEFAULT_BINDINGS: ActionDef[] = [
    { id: 'reset',        label: '回到出生点',       default: { type: 'button',  index: 16 } },  // HOME
    { id: 'fullscreen',   label: '全屏',             default: { type: 'button',  index: 1 } },   // B
    { id: 'menu',         label: '开关控制菜单',      default: { type: 'button',  index: 2 } },   // X
    { id: 'lockHeight',   label: '锁定高度',         default: { type: 'button',  index: 3 } },   // Y
    { id: 'sprint',       label: '冲刺加速 (按住)',   default: { type: 'button',  index: 4 } },   // LB
    { id: 'slow',         label: '慢速 (按住)',       default: { type: 'button',  index: 5 } },   // RB
    { id: 'ascend',       label: '上升 / 慢飞',       default: { type: 'trigger', index: 6 } },   // LT
    { id: 'descend',      label: '下降 / 加速',       default: { type: 'trigger', index: 7 } },   // RT
    { id: 'gearUp',       label: '升档 (速度+)',     default: { type: 'button',  index: 12 } },  // DPAD_UP
    { id: 'gearDown',     label: '降档 (速度-)',     default: { type: 'button',  index: 13 } },  // DPAD_DOWN
    { id: 'dpadLeft',     label: '左十字键 (缩小视场角)', default: { type: 'button', index: 14 } },
    { id: 'dpadRight',    label: '右十字键 (放大视场角)', default: { type: 'button', index: 15 } },
    { id: 'setOrigin',    label: '设为出生点',             default: { type: 'button', index: 0 } },   // A
    { id: 'screenshot',   label: '截屏',                   default: { type: 'button', index: 8 } },   // BACK
    { id: 'recordVideo',  label: '开始/停止录制',          default: { type: 'button', index: 9 } },   // START
    { id: 'resetView',    label: '重置视角 / 云台回中',    default: { type: 'button', index: 26 } }   // 默认未绑定，可在设置中自行重绑
];

// --- Presets (one-click config profiles) ---

export interface PresetDef {
    id: PresetId;
    label: string;
    bindings: Record<string, Binding>;
}

// Builds a full action set from an index map. Any action missing from the map
// keeps its DEFAULT_BINDINGS entry, so the Xbox preset (empty map) is
// guaranteed to stay in sync with the defaults. Indices 6/7 (LT/RT, L2/R2)
// are always analog triggers, matching the settings panel rebind rules.
const buildPreset = (id: PresetId, label: string, indexMap: Record<string, number>): PresetDef => {
    const bindings: Record<string, Binding> = {};
    for (const def of DEFAULT_BINDINGS) {
        const idx = indexMap[def.id] ?? def.default.index;
        const trigger = def.default.type === 'trigger' || idx === 6 || idx === 7;
        bindings[def.id] = { type: trigger ? 'trigger' : 'button', index: idx };
    }
    return { id, label, bindings };
};

export const PRESETS: PresetDef[] = [
    // Xbox: identical to DEFAULT_BINDINGS (A/B/X/Y, LB/RB, LT/RT, Back/Start,
    // D-pad 12-15). Kept as a named preset so one click can restore it after
    // switching to PlayStation.
    buildPreset('xbox', 'Xbox 手柄预设（默认）', {}),
    // PlayStation protocol: face buttons at Cross/Circle/Square/Triangle,
    // bumpers L1/R1, analog triggers L2/R2, Share/Options, D-pad 12-15,
    // PS(16)=reset, Touchpad(17) left unbound. LS(10)/RS(11) stay reserved
    // for the settings toggle; resetView remains unbound (26).
    buildPreset('playstation', 'PlayStation 手柄预设', {
        reset: 16,       // PS button
        fullscreen: 1,   // ○ Circle
        menu: 2,         // □ Square
        lockHeight: 3,   // △ Triangle
        sprint: 4,       // L1
        slow: 5,         // R1
        ascend: 6,       // L2 (analog trigger)
        descend: 7,      // R2 (analog trigger)
        gearUp: 12,      // 十字键上
        gearDown: 13,    // 十字键下
        dpadLeft: 14,    // 十字键左
        dpadRight: 15,   // 十字键右
        setOrigin: 0,    // ✕ Cross
        screenshot: 8,   // Share
        recordVideo: 9,  // Options
        resetView: 26    // 未绑定
    })
];

// Full config for a preset: preset bindings + fresh axis defaults. Returns a
// new object graph, never mutates the preset definition.
export const presetConfig = (id: PresetId): GamepadConfig => {
    const preset = PRESETS.find(p => p.id === id) ?? PRESETS[0];
    const bindings: Record<string, Binding> = {};
    for (const [k, v] of Object.entries(preset.bindings)) {
        bindings[k] = { ...v };
    }
    return {
        preset: preset.id,
        bindings,
        axis: { ...DEFAULT_AXIS }
    };
};

// --- Axis settings ---

export interface AxisSettings {
    moveSensitivity: number;      // 平移灵敏度（移动速度倍率）
    lookSensitivity: number;      // 视角旋转灵敏度（左右 / 偏航）
    lookPitchSensitivity: number; // 视角旋转灵敏度（上下 / 俯仰，通常低于左右）
    deadzone: number;             // stick deadzone (0.0 - 0.3)
    smoothing: number;            // exponential smoothing factor (0.0 - 0.9)
    invertLeftX: boolean;
    invertLeftY: boolean;
    invertRightX: boolean;
    invertRightY: boolean;
}

export const DEFAULT_AXIS: AxisSettings = {
    moveSensitivity: 4.0,          // 平移明显加快（原单一 sensitivity=1.0 太慢）
    lookSensitivity: 0.35,         // 视角左右明显放慢（避免轻轻一拨就转圈）
    lookPitchSensitivity: 0.20,    // 视角上下比左右更慢
    deadzone: 0.08,
    smoothing: 0.15,
    invertLeftX: false,
    invertLeftY: false,
    invertRightX: false,
    invertRightY: false
};

export interface GamepadConfig {
    preset?: PresetId;   // 'xbox' (default) | 'playstation' - active layout preset
    bindings: Record<string, Binding>;
    axis: AxisSettings;
}

// v3: A=set origin, START=record video, HOME=reset (return to origin).
// Previously v2 had A=reset, START=set origin, recordVideo=unbound.
// Bumped so stale v2 bindings cannot conflict with the new defaults.
export const CONFIG_STORAGE_KEY = 'supersplat.gamepad.config.v3';

// --- Persistence ---

export const defaultConfig = (): GamepadConfig => {
    const bindings: Record<string, Binding> = {};
    for (const def of DEFAULT_BINDINGS) {
        bindings[def.id] = { ...def.default };
    }
    return {
        preset: 'xbox',
        bindings,
        axis: { ...DEFAULT_AXIS }
    };
};

export const loadConfig = (): GamepadConfig => {
    const cfg = defaultConfig();
    try {
        const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (!raw) return cfg;

        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            if (parsed.preset === 'xbox' || parsed.preset === 'playstation') {
                cfg.preset = parsed.preset;
            }
            if (parsed.bindings && typeof parsed.bindings === 'object') {
                for (const def of DEFAULT_BINDINGS) {
                    const b = parsed.bindings[def.id];
                    if (b && typeof b.index === 'number' && (b.type === 'button' || b.type === 'trigger') && !RESERVED_BINDING_INDICES.includes(b.index)) {
                        cfg.bindings[def.id] = { type: b.type, index: Math.round(b.index) };
                    }
                }
            }
            if (parsed.axis && typeof parsed.axis === 'object') {
                const a = parsed.axis;
                if (typeof a.moveSensitivity === 'number') cfg.axis.moveSensitivity = clamp(a.moveSensitivity, 0.5, 7.5);
                if (typeof a.lookSensitivity === 'number') cfg.axis.lookSensitivity = clamp(a.lookSensitivity, 0.05, 0.65);
                if (typeof a.lookPitchSensitivity === 'number') cfg.axis.lookPitchSensitivity = clamp(a.lookPitchSensitivity, 0.04, 0.36);
                if (typeof a.deadzone === 'number') cfg.axis.deadzone = clamp(a.deadzone, 0.0, 0.3);
                if (typeof a.smoothing === 'number') cfg.axis.smoothing = clamp(a.smoothing, 0.0, 0.9);
                if (typeof a.invertLeftX === 'boolean') cfg.axis.invertLeftX = a.invertLeftX;
                if (typeof a.invertLeftY === 'boolean') cfg.axis.invertLeftY = a.invertLeftY;
                if (typeof a.invertRightX === 'boolean') cfg.axis.invertRightX = a.invertRightX;
                if (typeof a.invertRightY === 'boolean') cfg.axis.invertRightY = a.invertRightY;
            }
        }
    } catch (e) {
        // corrupted storage - fall back to defaults
        console.warn('Failed to load gamepad config, using defaults', e);
    }
    return cfg;
};

export const saveConfig = (cfg: GamepadConfig) => {
    try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {
        console.warn('Failed to save gamepad config', e);
    }
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
