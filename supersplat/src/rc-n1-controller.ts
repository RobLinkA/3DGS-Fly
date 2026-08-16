import { Vec3, math } from 'playcanvas';

import { Camera } from './camera';
import { Events } from './events';

// ============================================================
// DJI 手感调参（默认值，可在呼出菜单里实时调整）
// ============================================================
const DEADZONE = 0.03;               // 摇杆死区
const EXPO = 0.35;                   // 指数曲线（0=线性，1=最重）
const MAX_HORIZONTAL_SPEED = 5.0;    // 满杆水平速度（scene units/sec）
const MAX_VERTICAL_SPEED = 3.0;      // 满杆油门升降速度（scene units/sec）
const MAX_YAW_RATE = 90.0;           // 满杆航向旋转速度（度/sec）
const GIMBAL_RATE = 28.0;            // 满拨轮云台俯仰速度（度/sec）
const PITCH_LIMIT = 80;              // 相机俯仰角限制（度）
const SMOOTHING = 0.25;              // 平滑系数

// 速度档位（6 档指数）
const SPEED_GEARS = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0];

// 云台拨轮方向：false = 顺时针(值+1)抬头
const GIMBAL_INVERT = false;

export type HandMode = 'mode1' | 'mode2';   // mode1=日本手 mode2=美国手

export interface RcN1Config {
    handMode: HandMode;
    speedGear: number;          // 0..5 对应 SPEED_GEARS
    sensHorizontal: number;     // 平移灵敏度 0.2..3.0（默认 0.7）
    sensYaw: number;            // 转向灵敏度 0.2..3.0（默认 0.5）
    sensGimbal: number;         // 云台俯仰灵敏度 0.2..3.0（默认 0.5）
    heightLocked: boolean;      // 高度锁定
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const applyDeadzone = (value: number, deadzone: number = DEADZONE) => {
    const mag = Math.abs(value);
    if (mag < deadzone) return 0;
    return Math.sign(value) * (mag - deadzone) / (1 - deadzone);
};

const applyExpo = (value: number, expo: number = EXPO) => {
    const a = clamp(expo, 0, 1);
    return value * (a * value * value + (1 - a));
};

const smooth = (current: number, target: number, factor: number) =>
    current + (target - current) * factor;

const forwardVec = new Vec3();
const cameraPos = new Vec3();
const moveVec = new Vec3();
const newFocal = new Vec3();

interface RcState {
    left_h: number;
    left_v: number;
    right_h: number;
    right_v: number;
    camera: number;
}

/**
 * RcN1Controller —— 用 DJI RC-N1 遥控器操控 3DGS 相机（Mode 2）。
 */
class RcN1Controller {
    private camera: Camera;
    private events: Events;

    private connected = false;
    private state: RcState = { left_h: 0, left_v: 0, right_h: 0, right_v: 0, camera: 0 };

    private config: RcN1Config = {
        handMode: 'mode2',
        speedGear: 2,
        sensHorizontal: 0.7,
        sensYaw: 0.5,
        sensGimbal: 0.5,
        heightLocked: false,
    };

    private yaw = 0;
    private throttle = 0;
    private roll = 0;
    private pitch = 0;
    private gimbal = 0;

    private unsubscribe: (() => void) | null = null;

    constructor(camera: Camera, events: Events) {
        this.camera = camera;
        this.events = events;

        const rcApi = (window as any).rcApi;

        if (rcApi && typeof rcApi.onState === 'function') {
            this.unsubscribe = rcApi.onState((data: any) => {
                const wasConnected = this.connected;
                this.connected = !!data.connected;
                if (data.state) {
                    this.state = {
                        left_h: data.state.left_h,
                        left_v: data.state.left_v,
                        right_h: data.state.right_h,
                        right_v: data.state.right_v,
                        camera: data.state.camera,
                    };
                }
                if (wasConnected !== this.connected) {
                    events.fire('rc.active', this.connected);
                }
            });
        }

        if (rcApi && typeof rcApi.getStatus === 'function') {
            rcApi.getStatus().then((s: any) => {
                // 仅作初始查询：不覆盖 onState 已设置的 connected（避免竞态）
                if (!this.connected) {
                    this.connected = !!s && !!s.connected;
                    events.fire('rc.active', this.connected);
                }
            }).catch(() => {
                // ignore
            });
        }

        events.on('rc.setHandMode', (mode: HandMode) => {
            this.config.handMode = mode === 'mode1' ? 'mode1' : 'mode2';
            events.fire('rc.configChanged', this.config);
        });
        events.on('rc.setSpeedGear', (gear: number) => {
            this.config.speedGear = clamp(Math.round(gear), 0, SPEED_GEARS.length - 1);
            events.fire('rc.configChanged', this.config);
        });
        events.on('rc.setSensitivity', (axis: string, value: number) => {
            if (axis === 'horizontal') this.config.sensHorizontal = clamp(value, 0.2, 3.0);
            else if (axis === 'yaw') this.config.sensYaw = clamp(value, 0.2, 3.0);
            else if (axis === 'gimbal') this.config.sensGimbal = clamp(value, 0.2, 3.0);
            events.fire('rc.configChanged', this.config);
        });
        events.on('rc.toggleHeightLock', () => {
            this.config.heightLocked = !this.config.heightLocked;
            events.fire('rc.heightLock', this.config.heightLocked);
            events.fire('rc.configChanged', this.config);
        });

        events.function('rc.config', () => this.config);
        events.function('rc.heightLocked', () => this.config.heightLocked);

        events.on('update', (dt: number) => this.update(dt));
    }

    get isConnected(): boolean {
        return this.connected;
    }

    private lookAround(deltaAzim: number, deltaElev: number) {
        const cam = this.camera;
        const d = cam.distance * cam.sceneRadius / cam.fovFactor;

        Camera.calcForwardVec(forwardVec, cam.azim, cam.elevation);
        cameraPos.copy(cam.focalPoint).add(forwardVec.mulScalar(d));

        const newAzim = mod(cam.azim - deltaAzim, 360);
        const newElev = clamp(cam.elevation - deltaElev, -PITCH_LIMIT, PITCH_LIMIT);

        Camera.calcForwardVec(forwardVec, newAzim, newElev);
        newFocal.copy(cameraPos).sub(forwardVec.mulScalar(d));

        cam.setAzimElev(newAzim, newElev, 0);
        cam.setFocalPoint(newFocal, 0);
        cam.lookCameraPos = null;
    }

    private moveFocalPoint(dx: number, dy: number, dz: number) {
        const cam = this.camera;
        const fp = cam.focalPoint;
        newFocal.set(fp.x + dx, fp.y + dy, fp.z + dz);
        cam.setFocalPoint(newFocal, 0);
    }

    private applyHandMode(st: RcState) {
        if (this.config.handMode === 'mode1') {
            // 日本手：油门+航向在右杆，俯仰+横滚在左杆
            return {
                yaw: st.right_h,
                throttle: st.right_v,
                roll: st.left_h,
                pitch: st.left_v,
                gimbal: st.camera,
            };
        }
        // 美国手（默认）：油门+航向在左杆，俯仰+横滚在右杆
        return {
            yaw: st.left_h,
            throttle: st.left_v,
            roll: st.right_h,
            pitch: st.right_v,
            gimbal: st.camera,
        };
    }

    private update(dt: number) {
        if (!this.connected) return;

        const cfg = this.config;
        const c = this.applyHandMode(this.state);

        const targetYaw = applyExpo(applyDeadzone(c.yaw));
        const targetThrottle = applyExpo(applyDeadzone(c.throttle));
        const targetRoll = applyExpo(applyDeadzone(c.roll));
        const targetPitch = applyExpo(applyDeadzone(c.pitch));
        const targetGimbal = applyDeadzone(c.gimbal);

        const sf = 1 - Math.pow(1 - SMOOTHING, dt * 60);
        this.yaw = smooth(this.yaw, targetYaw, sf);
        this.throttle = smooth(this.throttle, targetThrottle, sf);
        this.roll = smooth(this.roll, targetRoll, sf);
        this.pitch = smooth(this.pitch, targetPitch, sf);
        this.gimbal = smooth(this.gimbal, targetGimbal, sf);

        const speed = SPEED_GEARS[cfg.speedGear];

        // 油门（升降速率，高度锁定时忽略）
        if (!cfg.heightLocked && this.throttle !== 0) {
            this.moveFocalPoint(0, this.throttle * MAX_VERTICAL_SPEED * speed * dt, 0);
        }

        // 航向（旋转速率）
        if (this.yaw !== 0) {
            this.lookAround(this.yaw * MAX_YAW_RATE * speed * cfg.sensYaw * dt, 0);
        }

        // 俯仰/横滚（右杆）：相机坐标系水平平移（等价 WASD）
        if (this.pitch !== 0 || this.roll !== 0) {
            const cam = this.camera;
            const hSpeed = MAX_HORIZONTAL_SPEED * speed * cfg.sensHorizontal * dt;

            moveVec.set(0, 0, 0);
            if (this.pitch !== 0) {
                const zAxis = cam.worldTransform.getZ();
                zAxis.y = 0;
                if (zAxis.lengthSq() < 1e-6) {
                    const azimRad = cam.azim * math.DEG_TO_RAD;
                    zAxis.set(Math.sin(azimRad), 0, -Math.cos(azimRad));
                }
                zAxis.normalize();
                moveVec.add(zAxis.mulScalar(-this.pitch * hSpeed));
            }
            if (this.roll !== 0) {
                const xAxis = cam.worldTransform.getX();
                xAxis.y = 0;
                if (xAxis.lengthSq() < 1e-6) {
                    const azimRad = cam.azim * math.DEG_TO_RAD;
                    xAxis.set(Math.cos(azimRad), 0, Math.sin(azimRad));
                }
                xAxis.normalize();
                moveVec.add(xAxis.mulScalar(this.roll * hSpeed));
            }
            if (moveVec.x !== 0 || moveVec.y !== 0 || moveVec.z !== 0) {
                this.moveFocalPoint(moveVec.x, moveVec.y, moveVec.z);
            }
        }

        // 云台俯仰（左拨轮）：速率控制
        if (this.gimbal !== 0) {
            const sign = GIMBAL_INVERT ? 1 : -1;
            this.lookAround(0, sign * this.gimbal * GIMBAL_RATE * cfg.sensGimbal * dt);
        }
    }

    dispose() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }
}

export { RcN1Controller };
