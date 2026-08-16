/**
 * gamepad-capture.ts
 *
 * Screenshot & video recording for the gamepad viewer.
 *
 * - Screenshot  ('gamepad.capture'): renders one offscreen frame via the same
 *   postrender/readPixels pipeline used by render.ts, encodes it as PNG and
 *   downloads it (or saves through the Electron save dialog when running in
 *   the 3DGS-Gamepad desktop wrapper).
 * - Video       ('gamepad.recordToggle'): captures the WebGL canvas with
 *   captureStream() + MediaRecorder (webm). While recording the scene is
 *   forced to render every frame so the stream stays smooth. On stop the
 *   blob is downloaded or routed to the native save dialog via
 *   window.gamepadApi.saveFile.
 *
 * Also owns lightweight global feedback UI (recording indicator + toast),
 * which is appended to <body> and styled in gamepad-settings.scss.
 */

import { Scene } from './scene';
import { Events } from './events';

// timestamp used for capture filenames: YYYYMMDD-HHMMSS
const timestamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// A single trajectory sample in "frames" mode (one sample per output frame).
// Matches TRAJECTORY/templates/trajectory-frames.template.json.
interface TrajectoryFrame {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fov: number;
}

declare global {
    interface Window {
        gamepadApi?: {
            /** Electron main-process save via native dialog. Resolves true on save, false on cancel. */
            saveFile: (payload: {
                data: ArrayBuffer;
                type: string;
                suggestedName: string;
            }) => Promise<boolean>;
        };
    }
}

class GamepadCapture {
    private scene: Scene;
    private canvas: HTMLCanvasElement;
    private events: Events;

    // video recording state
    private recording = false;
    private mediaRecorder: MediaRecorder | null = null;
    private stream: MediaStream | null = null;
    private chunks: Blob[] = [];
    private capturing = false;

    // trajectory recording state (one sample per output frame, 30 fps)
    private trajectoryFrames: TrajectoryFrame[] = [];
    private trajectoryLastSample = 0;
    private readonly TRAJECTORY_FPS = 30;

    // feedback UI
    private recIndicator: HTMLElement | null = null;
    private toastEl: HTMLElement | null = null;
    private toastTimer: number | null = null;

    constructor(scene: Scene, canvas: HTMLCanvasElement, events: Events) {
        this.scene = scene;
        this.canvas = canvas;
        this.events = events;

        // Screenshot
        events.on('gamepad.capture', () => {
            this.capture();
        });

        // Video record toggle
        events.on('gamepad.recordToggle', () => {
            this.toggleRecording();
        });

        // Start point feedback
        events.on('gamepad.originSet', () => {
            this.showToast('\u5df2\u8bbe\u7f6e\u8d77\u59cb\u70b9');
        });

        // While recording, keep the scene rendering every frame so the
        // captured stream stays smooth even when nothing in the scene changed.
        // Also sample the camera trajectory at the recording frame rate.
        events.on('update', () => {
            if (this.recording) {
                this.scene.forceRender = true;
                this.sampleTrajectory();
            }
        });

        this.buildIndicator();
    }

    // --- Screenshot ---

    private async capture() {
        if (this.capturing) return;
        this.capturing = true;

        const scene = this.scene;
        const maxTex = scene.graphicsDevice.maxTextureSize;
        const width = Math.min(this.canvas.width, maxTex);
        const height = Math.min(this.canvas.height, maxTex);
        if (width < 2 || height < 2) {
            this.capturing = false;
            return;
        }

        try {
            // render one frame to the offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;

            // keep the configured background colour
            const bgClr = this.events.invoke('bgClr');
            if (bgClr) scene.camera.clearPass.setClearColor(bgClr);

            // render the next frame and wait for it to finish
            scene.forceRender = true;
            await this.postRender();

            // read the rendered frame into a cpu buffer
            const { mainTarget, workTarget } = scene.camera;
            scene.dataProcessor.copyRt(mainTarget, workTarget);

            const data = new Uint8Array(width * height * 4);
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

            // flip rows: the framebuffer read is bottom-up, images are top-down
            const line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                const top = y * width * 4;
                const bottom = (height - y - 1) * width * 4;
                line.set(data.subarray(top, top + width * 4));
                data.copyWithin(top, bottom, bottom + width * 4);
                data.set(line, bottom);
            }

            const blob = await this.encodePng(data, width, height);
            const name = `3DGS-${timestamp()}.png`;

            if (!(await this.saveWithDialog(blob, name))) {
                this.download(blob, name);
            }
        } catch (e) {
            console.warn('\u622a\u56fe\u5931\u8d25', e);
        } finally {
            this.capturing = false;
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
        }
    }

    // wait for the next postrender event
    private postRender(): Promise<void> {
        return new Promise((resolve) => {
            const handle = this.scene.events.on('postrender', () => {
                handle.off();
                resolve();
            });
        });
    }

    private async encodePng(data: Uint8Array, width: number, height: number): Promise<Blob> {
        const imageData = new ImageData(
            new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
            width,
            height
        );

        if (typeof OffscreenCanvas !== 'undefined') {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('failed to create 2d context');
            context.putImageData(imageData, 0, 0);
            return canvas.convertToBlob({ type: 'image/png' });
        }

        // fallback for environments without OffscreenCanvas
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('failed to create 2d context');
        context.putImageData(imageData, 0, 0);
        return new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('failed to encode png'))), 'image/png');
        });
    }

    // --- Video recording ---

    private toggleRecording() {
        if (this.recording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    }

    private startRecording() {
        if (this.recording) return;

        let stream: MediaStream;
        try {
            stream = this.canvas.captureStream(30);
        } catch (e) {
            console.warn('captureStream \u4e0d\u53ef\u7528\uff0c\u65e0\u6cd5\u5f55\u5236', e);
            this.showToast('\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u89c6\u9891\u5f55\u5236');
            return;
        }

        // prefer vp9, fall back to whatever webm codec is available
        let mimeType = '';
        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) mimeType = 'video/webm;codecs=vp9';
        else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) mimeType = 'video/webm;codecs=vp8';
        else if (MediaRecorder.isTypeSupported('video/webm')) mimeType = 'video/webm';

        let recorder: MediaRecorder;
        try {
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch (e) {
            recorder = new MediaRecorder(stream);
        }

        this.stream = stream;
        this.mediaRecorder = recorder;
        this.chunks = [];
        recorder.ondataavailable = (e: BlobEvent) => {
            if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        recorder.onstop = () => this.onRecordingStopped();
        // timeslice keeps chunks arriving steadily (and on Safari/older Chromium)
        recorder.start(250);

        this.recording = true;
        this.trajectoryFrames = [];
        this.trajectoryLastSample = 0;
        this.setRecIndicator(true);
        this.showToast('\u5f00\u59cb\u5f55\u5236');
    }

    private stopRecording() {
        if (!this.recording || !this.mediaRecorder) return;
        if (this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        } else {
            this.recording = false;
            this.setRecIndicator(false);
        }
    }

    private async onRecordingStopped() {
        this.recording = false;
        this.setRecIndicator(false);

        const recorder = this.mediaRecorder;
        const stream = this.stream;
        this.mediaRecorder = null;
        this.stream = null;
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
        }

        // shared timestamp so the video and trajectory filenames match
        const ts = timestamp();
        const baseName = `3DGS-${ts}`;

        const type = recorder?.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];

        const name = `${baseName}.webm`;
        if (!(await this.saveWithDialog(blob, name))) {
            this.download(blob, name);
        }

        // save the trajectory alongside the video (same prefix)
        await this.saveTrajectory(baseName);
    }

    // --- Trajectory recording ---

    /**
     * Sample the current camera pose once per output frame (30 fps), matching
     * the captureStream frame rate. Samples accumulate into trajectoryFrames
     * and are written out on stop as a "frames"-mode JSON trajectory.
     */
    private sampleTrajectory() {
        const now = performance.now();
        const interval = 1000 / this.TRAJECTORY_FPS;
        if (now - this.trajectoryLastSample < interval) return;
        this.trajectoryLastSample = now;

        const cam = this.scene.camera;
        const pos = cam.position;
        const target = cam.focalPoint;
        const up = cam.up;

        // PlayCanvas exposes a horizontal fov when the view is landscape.
        // The trajectory spec expects a vertical fov, so convert when needed.
        let fov = cam.fov;
        const camComponent = cam.camera;
        if (camComponent.horizontalFov) {
            const { width, height } = cam.targetSize;
            if (width > 0 && height > 0) {
                const hRad = fov * Math.PI / 180;
                fov = 2 * Math.atan(Math.tan(hRad / 2) * (height / width)) * 180 / Math.PI;
            }
        }

        this.trajectoryFrames.push({
            position: [pos.x, pos.y, pos.z],
            target: [target.x, target.y, target.z],
            up: [up.x, up.y, up.z],
            fov
        });
    }

    /**
     * Serialize the recorded trajectory to a "frames"-mode JSON file and save
     * it next to the video (same filename prefix).
     */
    private async saveTrajectory(baseName: string) {
        if (this.trajectoryFrames.length === 0) {
            this.trajectoryFrames = [];
            return;
        }

        const json = {
            _meta: {
                formatVersion: 1,
                mode: 'one-sample-per-output-frame',
                outputFps: this.TRAJECTORY_FPS,
                coordinateSystem: 'right-handed, Y-up, camera forward is local -Z'
            },
            frames: this.trajectoryFrames
        };

        this.trajectoryFrames = [];

        const text = JSON.stringify(json, null, 2);
        const blob = new Blob([text], { type: 'application/json' });
        const name = `${baseName}.trajectory.json`;

        if (!(await this.saveWithDialog(blob, name))) {
            this.download(blob, name);
        }
    }

    // --- Save / download ---

    /** Route the blob through the Electron native save dialog when available. */
    private async saveWithDialog(blob: Blob, suggestedName: string): Promise<boolean> {
        const api = window.gamepadApi;
        if (!api?.saveFile) return false;
        try {
            return await api.saveFile({
                data: await blob.arrayBuffer(),
                type: blob.type || 'application/octet-stream',
                suggestedName
            });
        } catch (e) {
            console.warn('native save dialog failed, falling back to download', e);
            return false;
        }
    }

    private download(blob: Blob, filename: string) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // --- Feedback UI ---

    private buildIndicator() {
        this.recIndicator = document.createElement('div');
        this.recIndicator.className = 'gps-rec-indicator';
        this.recIndicator.innerHTML = '<span class="dot"></span><span>\u6b63\u5728\u5f55\u5236</span>';
        this.recIndicator.style.display = 'none';
        document.body.appendChild(this.recIndicator);
    }

    private setRecIndicator(on: boolean) {
        if (!this.recIndicator) return;
        this.recIndicator.style.display = on ? 'flex' : 'none';
    }

    private showToast(message: string) {
        if (!this.toastEl) {
            this.toastEl = document.createElement('div');
            this.toastEl.className = 'gps-toast';
            document.body.appendChild(this.toastEl);
        }
        this.toastEl.textContent = message;
        this.toastEl.classList.add('on');
        if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => this.toastEl?.classList.remove('on'), 1800);
    }
}

export { GamepadCapture };
