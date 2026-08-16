import { Container } from '@playcanvas/pcui';

import { Events } from '../events';
import {
    DEFAULT_BINDINGS,
    GamepadConfig,
    PresetId,
    RESERVED_BINDING_INDICES,
    bindingName,
    defaultConfig,
    presetConfig
} from '../gamepad-config';
import { Tooltips } from './tooltips';

const DEFAULT_HINT = '十字键 ↑↓ 选择 · A/→ 调整 · B/Start/X/ESC 关闭 · LS 打开/关闭';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

interface RowInfo {
    kind: 'binding' | 'slider' | 'toggle' | 'button' | 'stepper' | 'lock';
    key: string;
    label: string;
    el: HTMLElement;
    // binding
    bindingKey?: string;
    keyEl?: HTMLElement;
    // slider / stepper
    getValue?: () => number;
    setValue?: (v: number) => void;
    rangeEl?: HTMLInputElement;
    valueEl?: HTMLElement;
    min?: number;
    max?: number;
    step?: number;
    // toggle / lock
    getToggle?: () => boolean;
    setToggle?: (v: boolean) => void;
    switchEl?: HTMLElement;
    // button
    onActivate?: () => void;
    btnEl?: HTMLElement;
    presetId?: PresetId;
}

/**
 * GamepadSettings - game-style settings overlay for remapping gamepad buttons
 * and tuning stick behavior (sensitivity, deadzone, smoothing, invert).
 *
 * - Mouse: click binding rows to rebind, drag sliders, click switches/buttons.
 * - Keyboard: arrow keys + Enter navigate, ESC closes.
 * - Gamepad: D-pad up/down to select, A or D-pad right to activate,
 *   D-pad left to decrease / enter rebind, B/Start to close.
 *
 * While this panel is open the GamepadController pauses all camera input.
 * Changes are pushed through the 'gamepad.setConfig' / 'gamepad.resetConfig'
 * events; the authoritative copy lives in the controller and is persisted to
 * localStorage. The controller echoes every change back via 'gamepad.configChanged'.
 */
class GamepadSettings extends Container {
    private events: Events;
    private config: GamepadConfig;
    private open = false;
    private selectedIndex = 0;
    private rows: RowInfo[] = [];
    private listeningKey: string | null = null;
    private listenArmed = false;
    private rafId: number | null = null;
    private prevButtons: boolean[] = new Array(18).fill(false);
    private bodyEl: HTMLElement;
    private hintEl: HTMLElement;

    // mirrored controller state (kept in sync via events, not persisted in config)
    private gearValue = 2;        // 0..5 (displayed as 1..6), default 2.0x
    private heightLocked = false;

    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'gamepad-settings',
            class: 'blocks-shortcuts'
        };

        super(args);

        this.events = events;
        this.config = defaultConfig();
        this.hintEl = document.createElement('div');
        this.bodyEl = document.createElement('div');

        this.buildDom();
        this.hidden = true;

        // Open/close triggered by the controller (LS click) or the bottom menu
        events.on('gamepad.settingsOpen', () => this.openPanel());
        events.on('gamepad.settingsClosed', () => this.closePanel());

        // Controller echoes config changes (authoritative copy + persistence).
        // Adopt a cloned copy so the panel never shares an object reference
        // with the controller - otherwise local edits would pollute the
        // authoritative state before being pushed.
        events.on('gamepad.configChanged', (cfg: GamepadConfig) => {
            this.config = {
                preset: cfg.preset ?? 'xbox',
                bindings: { ...cfg.bindings },
                axis: { ...cfg.axis }
            };
            this.refresh();
        });

        // Mirror controller state for the speed gear / height lock rows
        events.on('gamepad.speedGear', (gear: number) => {
            this.gearValue = gear;
            this.refresh();
        });
        events.on('gamepad.heightLock', (locked: boolean) => {
            this.heightLocked = locked;
            this.refresh();
        });

        // Keyboard navigation while the panel is open
        document.addEventListener('keydown', (e) => {
            if (!this.open) return;
            if (this.listeningKey) {
                if (e.key === 'Escape') {
                    this.cancelListen();
                    e.preventDefault();
                }
                return;
            }

            const target = e.target as HTMLElement | null;

            switch (e.key) {
                case 'Escape':
                    this.closePanel();
                    break;
                case 'ArrowUp':
                    this.moveSelection(-1);
                    e.preventDefault();
                    break;
                case 'ArrowDown':
                    this.moveSelection(1);
                    e.preventDefault();
                    break;
                case 'ArrowLeft':
                case 'ArrowRight':
                    // Range inputs own the left/right arrows natively while focused
                    if (target?.tagName === 'INPUT') return;
                    this.activateRow(e.key === 'ArrowLeft' ? 'left' : 'right');
                    e.preventDefault();
                    break;
                case 'Enter':
                    // Buttons own Enter natively (fires click -> delegated row action)
                    if (target?.tagName === 'BUTTON') return;
                    this.activateRow('right');
                    e.preventDefault();
                    break;
                default:
                    break;
            }
        });

        // Standalone keyboard shortcut: F2 opens/closes the panel even when
        // the gamepad LS click is unavailable (e.g. wrong pad mapping).
        // Uses the same 'gamepad.settingsOpen'/'gamepad.settingsClosed' events
        // as the LS click so the controller's settingsOpen state stays in sync.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'F2') return;
            e.preventDefault();
            if (this.open) {
                this.closePanel();
            } else {
                this.events.fire('gamepad.settingsOpen');
            }
        });
    }

    /**
     * Pull the authoritative config from the controller. Falls back to defaults
     * if the controller hasn't registered yet (should not happen at runtime).
     * Returns a deep-enough clone so edits never mutate the controller's copy.
     */
    private readConfig(): GamepadConfig {
        const cfg = this.events.invoke('gamepad.config') as GamepadConfig | undefined;
        const src = cfg ?? defaultConfig();
        return {
            preset: src.preset ?? 'xbox',
            bindings: { ...src.bindings },
            axis: { ...src.axis }
        };
    }

    // --- DOM construction ---

    private buildDom() {
        const dom = this.dom;

        // Backdrop - click closes the panel
        const backdrop = document.createElement('div');
        backdrop.className = 'gps-backdrop';
        backdrop.addEventListener('click', () => this.closePanel());
        dom.appendChild(backdrop);

        const panel = document.createElement('div');
        panel.className = 'gps-panel';
        dom.appendChild(panel);

        // Header
        const header = document.createElement('div');
        header.className = 'gps-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'gps-title-wrap';

        const title = document.createElement('div');
        title.className = 'gps-title';
        title.textContent = '\u624b\u67c4\u8bbe\u7f6e';
        titleWrap.appendChild(title);

        const subtitle = document.createElement('div');
        subtitle.className = 'gps-subtitle';
        subtitle.textContent = 'GAMEPAD SETTINGS';
        titleWrap.appendChild(subtitle);

        header.appendChild(titleWrap);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gps-close-btn';
        closeBtn.textContent = '\u2715';
        closeBtn.title = '\u5173\u95ed (ESC / B / Start)';
        closeBtn.addEventListener('click', () => this.closePanel());
        header.appendChild(closeBtn);

        panel.appendChild(header);

        // Scrollable body
        this.bodyEl.className = 'gps-body';
        panel.appendChild(this.bodyEl);

        // --- Section: config presets (one-click apply) ---
        this.bodyEl.appendChild(this.sectionTitle('\u914d\u7f6e\u9884\u8bbe', 'ONE-CLICK PRESETS'));
        this.rows.push(this.buildButtonRow('preset-xbox', 'Xbox \u624b\u67c4\u9884\u8bbe\uff08\u9ed8\u8ba4\uff09', () => {
            this.applyPreset('xbox');
        }, 'xbox'));
        this.rows.push(this.buildButtonRow('preset-playstation', 'PlayStation \u624b\u67c4\u9884\u8bbe', () => {
            this.applyPreset('playstation');
        }, 'playstation'));

        // --- Section: button bindings ---
        this.bodyEl.appendChild(this.sectionTitle('\u6309\u952e\u7ed1\u5b9a', 'BUTTON BINDINGS'));

        for (const def of DEFAULT_BINDINGS) {
            this.rows.push(this.buildBindingRow(def.id, def.label));
        }

        // --- Section: flight controls ---
        this.bodyEl.appendChild(this.sectionTitle('\u98de\u884c\u63a7\u5236', 'FLIGHT CONTROLS'));

        this.rows.push(this.buildStepperRow(
            'speedGear', '\u901f\u5ea6\u6863\u4f4d', 0, 5,
            () => this.gearValue,
            (index) => this.events.fire('gamepad.setSpeedGear', index)
        ));
        this.rows.push(this.buildLockRow(
            'heightLock', '\u9ad8\u5ea6\u9501\u5b9a',
            () => this.heightLocked,
            () => this.events.fire('gamepad.toggleHeightLock')
        ));

        // --- Section: stick tuning ---
        this.bodyEl.appendChild(this.sectionTitle('\u6447\u6746\u4e0e\u7075\u654f\u5ea6', 'STICK & SENSITIVITY'));

        this.rows.push(this.buildSliderRow(
            'moveSensitivity', '\u5e73\u79fb\u7075\u654f\u5ea6', 0.5, 7.5, 0.1,
            () => this.config.axis.moveSensitivity,
            (v) => { this.config.axis.moveSensitivity = v; }
        ));
        this.rows.push(this.buildSliderRow(
            'lookSensitivity', '\u89c6\u89d2\u7075\u654f\u5ea6\uff08\u5de6\u53f3\uff09', 0.05, 0.65, 0.01,
            () => this.config.axis.lookSensitivity,
            (v) => { this.config.axis.lookSensitivity = v; }
        ));
        this.rows.push(this.buildSliderRow(
            'lookPitchSensitivity', '\u89c6\u89d2\u7075\u654f\u5ea6\uff08\u4e0a\u4e0b\uff09', 0.04, 0.36, 0.01,
            () => this.config.axis.lookPitchSensitivity,
            (v) => { this.config.axis.lookPitchSensitivity = v; }
        ));
        this.rows.push(this.buildSliderRow(
            'deadzone', '\u6447\u6746\u6b7b\u533a', 0.0, 0.3, 0.01,
            () => this.config.axis.deadzone,
            (v) => { this.config.axis.deadzone = v; }
        ));
        this.rows.push(this.buildSliderRow(
            'smoothing', '\u5e73\u6ed1', 0.0, 0.9, 0.01,
            () => this.config.axis.smoothing,
            (v) => { this.config.axis.smoothing = v; }
        ));

        this.rows.push(this.buildToggleRow(
            'invertLeftX', '\u5de6\u6447\u6746 X \u53cd\u8f6c',
            () => this.config.axis.invertLeftX,
            (v) => { this.config.axis.invertLeftX = v; }
        ));
        this.rows.push(this.buildToggleRow(
            'invertLeftY', '\u5de6\u6447\u6746 Y \u53cd\u8f6c',
            () => this.config.axis.invertLeftY,
            (v) => { this.config.axis.invertLeftY = v; }
        ));
        this.rows.push(this.buildToggleRow(
            'invertRightX', '\u53f3\u6447\u6746 X \u53cd\u8f6c',
            () => this.config.axis.invertRightX,
            (v) => { this.config.axis.invertRightX = v; }
        ));
        this.rows.push(this.buildToggleRow(
            'invertRightY', '\u53f3\u6447\u6746 Y \u53cd\u8f6c',
            () => this.config.axis.invertRightY,
            (v) => { this.config.axis.invertRightY = v; }
        ));

        // --- Footer buttons ---
        this.rows.push(this.buildButtonRow('reset', '\u6062\u590d\u9ed8\u8ba4\u8bbe\u7f6e', () => {
            this.events.fire('gamepad.resetConfig');
        }));
        this.rows.push(this.buildButtonRow('done', '\u4fdd\u5b58\u5e76\u8fd4\u56de', () => {
            this.closePanel();
        }));

        // Delegate row clicks (binding rebind / toggle / action buttons)
        this.bodyEl.addEventListener('click', (e) => {
            const target = (e.target as HTMLElement).closest('.gps-row') as HTMLElement | null;
            if (!target) return;
            const idx = parseInt(target.dataset.rowIndex ?? '-1', 10);
            if (idx < 0 || idx >= this.rows.length) return;

            this.selectedIndex = idx;
            const row = this.rows[idx];
            switch (row.kind) {
                case 'binding':
                    this.startListen(row.bindingKey!);
                    break;
                case 'slider':
                case 'stepper':
                    break; // the slider / +/- buttons handle their own input
                case 'toggle':
                    this.toggleRow(row);
                    break;
                case 'lock':
                    this.toggleRow(row);
                    break;
                case 'button':
                    row.onActivate?.();
                    break;
                default:
                    break;
            }
            this.refresh();
        });

        // Assign row indices for the delegated click handler
        this.rows.forEach((row, i) => {
            row.el.dataset.rowIndex = String(i);
        });

        // Hint
        this.hintEl.className = 'gps-hint';
        this.hintEl.textContent = DEFAULT_HINT;
        panel.appendChild(this.hintEl);
    }

    private sectionTitle(title: string, sub: string): HTMLElement {
        const el = document.createElement('div');
        el.className = 'gps-section-title';

        const t = document.createElement('span');
        t.textContent = title;
        el.appendChild(t);

        const s = document.createElement('span');
        s.className = 'gps-section-sub';
        s.textContent = sub;
        el.appendChild(s);

        return el;
    }

    private buildBindingRow(actionId: string, label: string): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const keyEl = document.createElement('button');
        keyEl.className = 'gps-key';
        keyEl.title = '\u70b9\u51fb\u91cd\u65b0\u7ed1\u5b9a';
        row.appendChild(keyEl);

        this.bodyEl.appendChild(row);

        return {
            kind: 'binding',
            key: actionId,
            label,
            el: row,
            bindingKey: actionId,
            keyEl
        };
    }

    /**
     * Update the orange fill width of a range input's track to reflect the
     * current value's position between min and max. The track uses a
     * two-layer background (orange gradient over grey); the first entry of
     * background-size controls how much of the track is orange. Without this
     * the fill stays fixed and never tracks the thumb.
     */
    private setRangeFill(rangeEl: HTMLInputElement, min: number, max: number) {
        if (max <= min) return;
        const val = parseFloat(rangeEl.value);
        if (isNaN(val)) return;
        const pct = ((val - min) / (max - min)) * 100;
        rangeEl.style.backgroundSize = `${Math.max(0, Math.min(100, pct))}% 100%`;
    }

    private buildSliderRow(
        key: string,
        label: string,
        min: number,
        max: number,
        step: number,
        getValue: () => number,
        setValue: (v: number) => void
    ): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row gps-row-slider';

        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const valueEl = document.createElement('span');
        valueEl.className = 'gps-slider-value';

        const rangeEl = document.createElement('input');
        rangeEl.type = 'range';
        rangeEl.className = 'gps-range';
        rangeEl.min = String(min);
        rangeEl.max = String(max);
        rangeEl.step = String(step);
        rangeEl.value = String(getValue());
        this.setRangeFill(rangeEl, min, max);
        rangeEl.addEventListener('input', () => {
            setValue(parseFloat(rangeEl.value));
            valueEl.textContent = parseFloat(rangeEl.value).toFixed(2);
            this.setRangeFill(rangeEl, min, max);
            this.pushConfig();
        });

        const control = document.createElement('div');
        control.className = 'gps-row-control';
        control.appendChild(rangeEl);
        control.appendChild(valueEl);
        row.appendChild(control);

        this.bodyEl.appendChild(row);

        return {
            kind: 'slider',
            key,
            label,
            el: row,
            getValue,
            setValue,
            rangeEl,
            valueEl,
            min,
            max,
            step
        };
    }

    private buildToggleRow(
        key: string,
        label: string,
        getToggle: () => boolean,
        setToggle: (v: boolean) => void
    ): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const switchEl = document.createElement('button');
        switchEl.className = 'gps-switch off';
        row.appendChild(switchEl);

        this.bodyEl.appendChild(row);

        return {
            kind: 'toggle',
            key,
            label,
            el: row,
            getToggle,
            setToggle,
            switchEl
        };
    }

    /**
     * Stepper row - decrement / value / increment (+/- buttons, mouse clickable).
     * The value is displayed 1-based (1..max+1) while the underlying state is
     * 0-based, matching the controller's speed gear index.
     */
    private buildStepperRow(
        key: string,
        label: string,
        min: number,
        max: number,
        getValue: () => number,
        setValue: (v: number) => void
    ): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row gps-row-stepper';

        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const control = document.createElement('div');
        control.className = 'gps-row-control';

        const minusBtn = document.createElement('button');
        minusBtn.className = 'gps-stepper-btn';
        minusBtn.textContent = '\u2212';
        minusBtn.title = '\u964d\u6863';
        minusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setValue(clamp(getValue() - 1, min, max));
        });

        const valueEl = document.createElement('span');
        valueEl.className = 'gps-stepper-value';

        const plusBtn = document.createElement('button');
        plusBtn.className = 'gps-stepper-btn';
        plusBtn.textContent = '+';
        plusBtn.title = '\u5347\u6863';
        plusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setValue(clamp(getValue() + 1, min, max));
        });

        control.appendChild(minusBtn);
        control.appendChild(valueEl);
        control.appendChild(plusBtn);
        row.appendChild(control);

        this.bodyEl.appendChild(row);

        return {
            kind: 'stepper',
            key,
            label,
            el: row,
            getValue,
            setValue,
            valueEl,
            min,
            max
        };
    }

    /**
     * Lock row - a single clickable button that toggles height lock.
     * Fires 'gamepad.toggleHeightLock'; the controller echoes the new state
     * back via 'gamepad.heightLock' which keeps the button visual in sync.
     */
    private buildLockRow(
        key: string,
        label: string,
        getToggle: () => boolean,
        setToggle: (v: boolean) => void
    ): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row gps-row-lock';

        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const lockBtn = document.createElement('button');
        lockBtn.className = 'gps-lock-btn off';
        lockBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setToggle(!getToggle());
        });
        row.appendChild(lockBtn);

        this.bodyEl.appendChild(row);

        return {
            kind: 'lock',
            key,
            label,
            el: row,
            getToggle,
            setToggle,
            switchEl: lockBtn
        };
    }

    private buildButtonRow(key: string, label: string, onActivate: () => void, presetId?: PresetId): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row gps-button-row';

        const btn = document.createElement('button');
        btn.className = 'gps-action-btn';
        btn.textContent = label;
        row.appendChild(btn);

        this.bodyEl.appendChild(row);

        return {
            kind: 'button',
            key,
            label,
            el: row,
            onActivate,
            btnEl: btn,
            presetId
        };
    }

    // --- Panel lifecycle ---

    private openPanel() {
        if (this.open) return;
        this.open = true;
        this.config = this.readConfig();
        this.gearValue = (this.events.invoke('gamepad.speedGear') as number | undefined) ?? 2;
        this.heightLocked = (this.events.invoke('gamepad.heightLocked') as boolean | undefined) ?? false;
        this.selectedIndex = 0;
        this.listeningKey = null;
        this.listenArmed = false;
        this.prevButtons.fill(false);
        this.hidden = false;
        this.refresh();
        this.updateSelection();

        // Move focus off any control so panel keyboard handling owns the keys
        (document.activeElement as HTMLElement | null)?.blur?.();

        this.rafId = requestAnimationFrame(this.tick);
    }

    private closePanel() {
        if (!this.open) return;
        this.open = false;
        this.hidden = true;

        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }

        this.listeningKey = null;
        this.listenArmed = false;
        this.hintEl.textContent = DEFAULT_HINT;
        this.events.fire('gamepad.settingsClosed');
    }

    private tick = () => {
        if (!this.open) return;
        const gp = this.pollGamepad();
        if (gp) this.processGamepad(gp);
        this.rafId = requestAnimationFrame(this.tick);
    };

    private pollGamepad(): Gamepad | null {
        const pads = navigator.getGamepads();
        for (let i = 0; i < pads.length; i++) {
            if (pads[i]) return pads[i];
        }
        return null;
    }

    /**
     * Button active check matching the controller: accept .pressed OR a
     * significant analog .value (some mapping modes never flip .pressed).
     */
    private btnPressed(gp: Gamepad, i: number): boolean {
        const b = gp.buttons[i];
        if (!b) return false;
        if (b.pressed) return true;
        return typeof b.value === 'number' && b.value > 0.5;
    }

    private processGamepad(gp: Gamepad) {
        // Find the first pressed button this frame
        let pressedIdx = -1;
        let anyPressed = false;
        for (let i = 0; i < Math.min(gp.buttons.length, 18); i++) {
            if (this.btnPressed(gp, i)) {
                pressedIdx = i;
                anyPressed = true;
                break;
            }
        }

        // --- Rebinding capture mode ---
        if (this.listeningKey) {
            // B cancels rebinding
            if (this.btnPressed(gp, 1) && !this.prevButtons[1]) {
                this.cancelListen();
            } else if (!anyPressed) {
                // All buttons released - arm the capture
                this.listenArmed = true;
            } else if (this.listenArmed && !RESERVED_BINDING_INDICES.includes(pressedIdx)) {
                const binding = this.config.bindings[this.listeningKey];
                binding.index = pressedIdx;
                binding.type = (pressedIdx === 6 || pressedIdx === 7) ? 'trigger' : 'button';
                this.listeningKey = null;
                this.listenArmed = false;
                this.hintEl.textContent = DEFAULT_HINT;
                this.pushConfig();
            }

            for (let i = 0; i < 18; i++) {
                this.prevButtons[i] = this.btnPressed(gp, i);
            }
            return;
        }

        // --- Navigation mode ---
        const jp = (i: number) => this.btnPressed(gp, i) && !this.prevButtons[i];

        if (jp(12)) {
            this.moveSelection(-1);          // D-pad up
        } else if (jp(13)) {
            this.moveSelection(1);           // D-pad down
        } else if (jp(14)) {
            this.activateRow('left');        // D-pad left
        } else if (jp(15) || jp(0)) {
            this.activateRow('right');       // D-pad right / A
        } else if (jp(1) || jp(9) || jp(2)) {
            this.closePanel();               // B / Start / X
        }

        for (let i = 0; i < 18; i++) {
            this.prevButtons[i] = this.btnPressed(gp, i);
        }
    }

    // --- Row interactions ---

    private moveSelection(delta: number) {
        if (this.rows.length === 0) return;
        this.selectedIndex = (this.selectedIndex + delta + this.rows.length) % this.rows.length;
        this.updateSelection();
    }

    private updateSelection(scroll = true) {
        this.rows.forEach((row, i) => {
            row.el.classList.toggle('selected', i === this.selectedIndex);
        });
        // Only scroll when the selection is moved by explicit navigation
        // (keyboard / gamepad). Data refreshes (slider drags, rebinds) must
        // NOT scroll, otherwise every config change snaps the panel back to
        // the selected row (typically the top row) — the "jumps to top" bug.
        if (scroll) {
            const active = this.rows[this.selectedIndex];
            if (active) {
                active.el.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    private activateRow(dir: 'left' | 'right') {
        const row = this.rows[this.selectedIndex];
        if (!row) return;

        switch (row.kind) {
            case 'binding':
                this.startListen(row.bindingKey!);
                break;
            case 'slider': {
                if (row.rangeEl && row.step && row.min !== undefined && row.max !== undefined) {
                    const step = (dir === 'left' ? -1 : 1) * row.step;
                    const v = clamp(parseFloat(row.rangeEl.value) + step, row.min, row.max);
                    row.rangeEl.value = String(v);
                    row.setValue?.(v);
                    if (row.valueEl) row.valueEl.textContent = v.toFixed(2);
                    this.pushConfig();
                }
                break;
            }
            case 'toggle':
                this.toggleRow(row);
                break;
            case 'stepper': {
                if (row.getValue && row.setValue && row.min !== undefined && row.max !== undefined) {
                    const delta = dir === 'left' ? -1 : 1;
                    row.setValue(clamp(row.getValue() + delta, row.min, row.max));
                }
                break;
            }
            case 'lock':
                this.toggleRow(row);
                break;
            case 'button':
                row.onActivate?.();
                break;
            default:
                break;
        }
        this.refresh();
    }

    private startListen(actionId: string) {
        this.listeningKey = actionId;
        this.listenArmed = false;   // require all buttons released first
        this.hintEl.textContent = '\u6309\u4e0b\u8981\u7ed1\u5b9a\u7684\u6309\u952e\u2026 (LS/RS \u4e0d\u53ef\u7528)';
        this.refresh();
    }

    private cancelListen() {
        this.listeningKey = null;
        this.listenArmed = false;
        this.hintEl.textContent = DEFAULT_HINT;
        this.refresh();
    }

    private toggleRow(row: RowInfo) {
        const next = !(row.getToggle?.() ?? false);
        row.setToggle?.(next);
        this.pushConfig();
    }

    /**
     * One-click apply of a layout preset (Xbox / PlayStation). Replaces the
     * working config with the preset's bindings + default axis settings and
     * pushes it through the same 'gamepad.setConfig' channel as manual edits,
     * so the controller persists it and echoes it back via
     * 'gamepad.configChanged' (which re-renders the whole panel).
     */
    private applyPreset(id: PresetId) {
        const next = presetConfig(id);
        this.config = {
            preset: next.preset,
            bindings: { ...next.bindings },
            axis: { ...next.axis }
        };
        this.pushConfig();
    }

    private pushConfig() {
        // Clone before publishing so the controller never ends up sharing an
        // object reference with the panel's working copy.
        const next: GamepadConfig = {
            preset: this.config.preset ?? 'xbox',
            bindings: { ...this.config.bindings },
            axis: { ...this.config.axis }
        };
        this.config = next;
        this.events.fire('gamepad.setConfig', next);
    }

    // --- UI refresh ---

    private refresh() {
        for (const row of this.rows) {
            switch (row.kind) {
                case 'binding': {
                    const isListening = this.listeningKey === row.bindingKey;
                    if (row.keyEl) {
                        row.keyEl.textContent = isListening
                            ? '\u6309\u4efb\u610f\u952e\u2026'
                            : bindingName(this.config.bindings[row.bindingKey!], this.config.preset ?? 'xbox');
                        row.keyEl.classList.toggle('listening', isListening);
                    }
                    break;
                }
                case 'slider': {
                    if (row.rangeEl && row.getValue) {
                        const v = row.getValue();
                        row.rangeEl.value = String(v);
                        if (row.valueEl) row.valueEl.textContent = v.toFixed(2);
                        if (row.min !== undefined && row.max !== undefined) {
                            this.setRangeFill(row.rangeEl, row.min, row.max);
                        }
                    }
                    break;
                }
                case 'toggle': {
                    const on = row.getToggle?.() ?? false;
                    if (row.switchEl) {
                        row.switchEl.textContent = on ? '\u5f00\u542f' : '\u5173\u95ed';
                        row.switchEl.classList.toggle('on', on);
                        row.switchEl.classList.toggle('off', !on);
                    }
                    break;
                }
                case 'stepper': {
                    if (row.valueEl && row.getValue !== undefined) {
                        const v = row.getValue();
                        const total = (row.max ?? 0) + 1;
                        row.valueEl.textContent = `${v + 1}/${total}`;
                    }
                    break;
                }
                case 'lock': {
                    const on = row.getToggle?.() ?? false;
                    if (row.switchEl) {
                        row.switchEl.textContent = on ? '\u5df2\u9501\u5b9a' : '\u9501\u5b9a\u9ad8\u5ea6';
                        row.switchEl.classList.toggle('on', on);
                        row.switchEl.classList.toggle('off', !on);
                    }
                    break;
                }
                case 'button':
                    // Preset rows mark the active layout with a check mark.
                    if (row.presetId && row.btnEl) {
                        const active = (this.config.preset ?? 'xbox') === row.presetId;
                        row.btnEl.textContent = active ? `${row.label}\uff08\u5f53\u524d\uff09` : row.label;
                        row.btnEl.classList.toggle('gps-preset-active', active);
                    }
                    break;
                default:
                    break;
            }
        }
        // Refresh data only — do not scroll (scroll would snap the panel on
        // every slider drag / rebind, see updateSelection).
        this.updateSelection(false);
    }
}

export { GamepadSettings };
