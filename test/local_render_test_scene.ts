import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import type VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import type VirtualJoyStick from 'phaser4-rex-plugins/plugins/virtualjoystick.js';
import { FontSize, HexText, Palette, Spacing, SceneBG, textStyle } from '../src/theme';
import { paintGradientBackground } from '../src/ui/background';
import { paintArenaBoundary } from '../src/ui/arena_boundary';
import { createBattleHud, type BattleHud } from '../src/ui/battle_hud';
import { SnapshotBuffer } from '../src/util/snapshot_buffer';
import { DebugOverlay } from '../src/util/debug_overlay';

// Mirrors state_sync_battle_scene constants verbatim — same map, same sizes,
// same interp delay — so this scene's render path is byte-for-byte
// equivalent to the networked one.
const MAP_W = 800;
const MAP_H = 1200;
const PLAYER_SIZE = 20;
const INTERP_DELAY = 100;
const JUMP_DIST_SQ = (PLAYER_SIZE * 4) ** 2;

// Mirror of server-side patchRate: state-sync clients see one snapshot
// per 50ms on a stable network. We push at exactly this cadence to feed
// the SnapshotBuffer the same way Colyseus would.
const PATCH_INTERVAL = 50;

// px/sec, tuned to roughly match state-sync's visible travel speed.
const PLAYER_SPEED = 240;
// Step-6: cycle ball speed via N. blur:size ratio at 60Hz scales linearly
// with speed → 180=30%, 360=60%, 540=90%.
const BALL_SPEED_OPTIONS: readonly number[] = [180, 360, 540] as const;
// Cycle ball radius via K. Larger ball masks the same hold-blur length.
const BALL_RADIUS_OPTIONS: readonly number[] = [5, 8, 12] as const;
const DEFAULT_BALL_SPEED_IDX = 1;     // 360 px/sec — production setting
const DEFAULT_BALL_RADIUS_IDX = 0;    // 5 px — production setting

const N_BALLS = 8;

const PLAYER_PALETTE: readonly number[] = [
    0x4A90E2, 0xE74C3C, 0x27AE60, 0xF5A623,
    0x9B59B6, 0x1ABC9C, 0xE91E63, 0x34495E,
] as const;

type RenderMode = 'buffered' | 'raw';

type SimPlayer = {
    x: number; y: number; vx: number; vy: number;
    entity: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
    buffer: SnapshotBuffer;
};

type SimBall = {
    x: number; y: number; vx: number; vy: number;
    entity: Phaser.GameObjects.Arc;
    buffer: SnapshotBuffer;
};

/**
 * Local stand-in for state_sync_battle_scene with no network. Sim runs
 * every Phaser tick (~60Hz); positions are pushed into a per-entity
 * SnapshotBuffer at the same 50ms cadence as the server's patchRate;
 * render samples at `now - INTERP_DELAY` exactly like state-sync.
 *
 * Press B to toggle between two render modes:
 *  - "buffered" (default, mode 1): SnapshotBuffer + 100ms delayed-interp.
 *    Identical code path to state-sync.
 *  - "raw"      (mode 3):           bypass the buffer, write sim 60Hz
 *    directly to entity.x/y. This is the upper bound on smoothness.
 *
 * If buffered stutters here but raw doesn't → blame the buffer/interp.
 * If both stutter → blame Phaser render layer (vsync, camera lerp, RAF).
 * If both are smooth → state-sync's stutter is from the network.
 */
export class LocalRenderTestScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    rexVirtualJoyStick!: VirtualJoyStickPlugin;

    private self!: SimPlayer;
    private balls: SimBall[] = [];

    private hud!: BattleHud;
    private debugOverlay!: DebugOverlay;

    private joystick!: VirtualJoyStick;
    private joystickBase!: Phaser.GameObjects.Arc;
    private joystickThumb!: Phaser.GameObjects.Arc;
    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!: {
        W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
        S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    };
    private joystickPointerId: number | null = null;

    private mode: RenderMode = 'buffered';
    private modeKey!: Phaser.Input.Keyboard.Key;
    // Step-1 diagnostic: live toggle for Camera.roundPixels. startFollow's
    // 2nd arg writes this; setting it true with lerp<1 is the classic
    // "follow stutters" footgun in Phaser 3/4.
    private roundPixelsKey!: Phaser.Input.Keyboard.Key;
    // Step-5 diagnostic: even with target static, startFollow runs its lerp
    // calc each frame and can write scrollX/Y at floating-point noise level.
    // F toggles between "follow with lerp" and "static center on player".
    private cameraFollowKey!: Phaser.Input.Keyboard.Key;
    private cameraFollowing: boolean = true;
    // Step-6 diagnostic: N cycles ball speed, K cycles radius. Lets the user
    // feel the blur:size ratio at different (speed × inverse-size) products.
    private speedKey!: Phaser.Input.Keyboard.Key;
    private sizeKey!: Phaser.Input.Keyboard.Key;
    private currentBallSpeed: number = BALL_SPEED_OPTIONS[DEFAULT_BALL_SPEED_IDX];
    private currentBallRadius: number = BALL_RADIUS_OPTIONS[DEFAULT_BALL_RADIUS_IDX];

    // Per-frame interval samples — used to derive monitor refresh & RAF jitter.
    private frameTimes: number[] = [];

    private lastPushTime: number = 0;
    private patchTimes: number[] = [];
    private static readonly DEBUG_WINDOW = 20;

    private rngSeed: number = 0xC0FFEE;

    constructor() { super({ key: 'local_render_test' }); }

    create(): void {
        this.balls = [];
        this.joystickPointerId = null;
        this.mode = 'buffered';
        this.lastPushTime = 0;
        this.patchTimes = [];
        this.frameTimes = [];
        this.cameraFollowing = true;
        this.currentBallSpeed = BALL_SPEED_OPTIONS[DEFAULT_BALL_SPEED_IDX];
        this.currentBallRadius = BALL_RADIUS_OPTIONS[DEFAULT_BALL_RADIUS_IDX];
        this.rngSeed = 0xC0FFEE;

        paintGradientBackground(this, SceneBG.state.top, SceneBG.state.bottom,
            { width: MAP_W, height: MAP_H });
        this.cameras.main.setBounds(0, 0, MAP_W, MAP_H);
        paintArenaBoundary(this, MAP_W, MAP_H);

        this.hud = createBattleHud(this, () => {
            // No parent scene to switch back to — a hard reload re-seeds the
            // sim and is the simplest "reset" affordance for a test page.
            window.location.reload();
        }, { fps: true });

        // Faster overlay refresh than default (300ms) so the mode label
        // updates within ~100ms of pressing B.
        this.debugOverlay = new DebugOverlay(this, 100);

        this.setupInput();

        this.self = this.spawnSelf(MAP_W / 2, MAP_H / 2);
        for (let i = 0; i < N_BALLS; i++) {
            this.balls.push(this.spawnBall(i));
        }

        // 2nd arg = roundPixels. Defaults to true to match production
        // (state-sync also passes true). R key flips at runtime.
        this.cameras.main.startFollow(this.self.entity, true, 0.1, 0.1);
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        const onResize = () => {
            this.hud.relayout();
            if (this.joystick.visible) this.hideJoystick();
        };
        this.scale.on(Phaser.Scale.Events.RESIZE, onResize);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            try { this.scale.off(Phaser.Scale.Events.RESIZE, onResize); } catch {}
            try { this.joystick?.destroy(); } catch {}
        });
    }

    /** Seeded LCG so ball positions and velocities are reproducible. */
    private rng(): number {
        this.rngSeed = (this.rngSeed * 1664525 + 1013904223) >>> 0;
        return this.rngSeed / 4294967296;
    }

    private spawnSelf(x: number, y: number): SimPlayer {
        const colorIdx = 0;
        const entity = this.add.rectangle(x, y, PLAYER_SIZE, PLAYER_SIZE,
            PLAYER_PALETTE[colorIdx]);
        entity.setStrokeStyle(3, 0xFFFFFF, 1);
        const label = this.add.text(x, y - PLAYER_SIZE, 'YOU', {
            ...textStyle({
                size: FontSize.caption, color: HexText.white,
                weight: 'bold', shadow: true,
            }),
            align: 'center',
        }).setOrigin(0.5, 1);
        const buffer = new SnapshotBuffer();
        buffer.seed(this.time.now, x, y);
        return { x, y, vx: 0, vy: 0, entity, label, buffer };
    }

    private spawnBall(idx: number): SimBall {
        const x = MAP_W * (0.15 + this.rng() * 0.7);
        const y = MAP_H * (0.15 + this.rng() * 0.7);
        const angle = this.rng() * Math.PI * 2;
        const vx = Math.cos(angle) * this.currentBallSpeed;
        const vy = Math.sin(angle) * this.currentBallSpeed;
        // idx+1 to skip color 0 (used by self).
        const color = PLAYER_PALETTE[(idx + 1) % PLAYER_PALETTE.length];
        const entity = this.add.arc(x, y, this.currentBallRadius, 0, 360, false, color);
        const buffer = new SnapshotBuffer();
        buffer.seed(this.time.now, x, y);
        return { x, y, vx, vy, entity, buffer };
    }

    private setupInput(): void {
        const BASE_RADIUS = 60, THUMB_RADIUS = 25;

        this.joystickBase = this.add.circle(0, 0, BASE_RADIUS, Palette.textPrimary, 0.10);
        this.joystickBase.setStrokeStyle(2, Palette.textPrimary, 0.22);
        this.joystickBase.setDepth(1000);
        this.joystickBase.setScrollFactor(0);
        this.joystickThumb = this.add.circle(0, 0, THUMB_RADIUS, Palette.textSecondary, 0.55);
        this.joystickThumb.setDepth(1001);
        this.joystickThumb.setScrollFactor(0);

        this.joystick = this.rexVirtualJoyStick.add(this, {
            x: 0, y: 0, radius: BASE_RADIUS,
            base: this.joystickBase, thumb: this.joystickThumb,
            dir: '4dir', forceMin: 8, fixed: true,
        });
        this.joystick.setVisible(false);

        this.cursors = this.input.keyboard!.createCursorKeys();
        this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd;
        this.modeKey = this.input.keyboard!.addKey('B');
        this.roundPixelsKey = this.input.keyboard!.addKey('R');
        this.cameraFollowKey = this.input.keyboard!.addKey('F');
        this.speedKey = this.input.keyboard!.addKey('N');
        this.sizeKey = this.input.keyboard!.addKey('K');

        this.input.on('pointerdown', this.onPointerDown, this);
        this.input.on('pointerup', this.onPointerUp, this);
        this.input.on('pointerupoutside', this.onPointerUp, this);
        this.input.on('pointercancel', this.onPointerUp, this);
    }

    private onPointerDown(
        pointer: Phaser.Input.Pointer,
        currentlyOver: Phaser.GameObjects.GameObject[],
    ): void {
        if (this.joystickPointerId !== null) return;
        for (const obj of currentlyOver) {
            if (this.hud.interactives.includes(obj)) return;
        }
        if (pointer.y < Spacing.lg + this.hud.height()) return;

        this.joystickPointerId = pointer.id;
        this.joystick.setPosition(pointer.x, pointer.y);
        this.joystick.setVisible(true);

        // rex TouchCursor needs the pointer fed in manually — same trick
        // as state_sync_battle_scene.
        const tc = (this.joystick as unknown as {
            touchCursor: { onKeyDownStart(p: Phaser.Input.Pointer): void };
        }).touchCursor;
        tc.onKeyDownStart(pointer);
    }

    private onPointerUp(pointer: Phaser.Input.Pointer): void {
        if (this.joystickPointerId !== pointer.id) return;
        this.hideJoystick();
    }

    private hideJoystick(): void {
        this.joystick.setVisible(false);
        this.joystickPointerId = null;
    }

    update(time: number, delta: number): void {
        if (Phaser.Input.Keyboard.JustDown(this.modeKey)) {
            this.mode = this.mode === 'buffered' ? 'raw' : 'buffered';
        }
        if (Phaser.Input.Keyboard.JustDown(this.roundPixelsKey)) {
            this.cameras.main.roundPixels = !this.cameras.main.roundPixels;
        }
        if (Phaser.Input.Keyboard.JustDown(this.cameraFollowKey)) {
            this.cameraFollowing = !this.cameraFollowing;
            if (this.cameraFollowing) {
                // Re-attach with the camera's current roundPixels — startFollow
                // overwrites it from the 2nd arg, so re-read instead of hard-coding.
                this.cameras.main.startFollow(
                    this.self.entity, this.cameras.main.roundPixels, 0.1, 0.1);
            } else {
                this.cameras.main.stopFollow();
                // Snap to current player pos so the view doesn't jerk away.
                this.cameras.main.centerOn(this.self.entity.x, this.self.entity.y);
            }
        }
        if (Phaser.Input.Keyboard.JustDown(this.speedKey)) {
            // Cycle [180, 360, 540]. Rescale every ball's velocity to the
            // new magnitude, preserving direction.
            const idx = (BALL_SPEED_OPTIONS.indexOf(this.currentBallSpeed) + 1)
                % BALL_SPEED_OPTIONS.length;
            this.currentBallSpeed = BALL_SPEED_OPTIONS[idx];
            for (const b of this.balls) {
                const mag = Math.hypot(b.vx, b.vy);
                if (mag > 0) {
                    b.vx = (b.vx / mag) * this.currentBallSpeed;
                    b.vy = (b.vy / mag) * this.currentBallSpeed;
                }
            }
        }
        if (Phaser.Input.Keyboard.JustDown(this.sizeKey)) {
            // Cycle [5, 8, 12]. Visual radius + bounce halfSize both updated.
            const idx = (BALL_RADIUS_OPTIONS.indexOf(this.currentBallRadius) + 1)
                % BALL_RADIUS_OPTIONS.length;
            this.currentBallRadius = BALL_RADIUS_OPTIONS[idx];
            for (const b of this.balls) {
                b.entity.setRadius(this.currentBallRadius);
            }
        }

        // Frame-interval sampler (drives frame_avg / frame_jitter in overlay).
        this.frameTimes.push(time);
        if (this.frameTimes.length > LocalRenderTestScene.DEBUG_WINDOW) {
            this.frameTimes.shift();
        }

        // 1) Read input → self velocity.
        const left = this.cursors.left.isDown || this.wasd.A.isDown || this.joystick.left;
        const right = this.cursors.right.isDown || this.wasd.D.isDown || this.joystick.right;
        const up = this.cursors.up.isDown || this.wasd.W.isDown || this.joystick.up;
        const down = this.cursors.down.isDown || this.wasd.S.isDown || this.joystick.down;
        const dx = right ? 1 : (left ? -1 : 0);
        const dy = down ? 1 : (up ? -1 : 0);
        this.self.vx = dx * PLAYER_SPEED;
        this.self.vy = dy * PLAYER_SPEED;

        // 2) Step sim. Clamp delta to prevent teleport on tab resume.
        const dt = Math.min(delta, 50) / 1000;
        this.stepEntity(this.self, dt, PLAYER_SIZE / 2, false);
        for (const b of this.balls) {
            this.stepEntity(b, dt, this.currentBallRadius, true);
        }

        // 3) Push to per-entity SnapshotBuffer at 50ms cadence, mirroring
        //    the server's patchRate. Skips frames that fall inside a 50ms
        //    window — actual gaps land at 50–67ms (one Phaser tick of jitter).
        if (time - this.lastPushTime >= PATCH_INTERVAL) {
            this.lastPushTime = time;
            this.self.buffer.push(time, this.self.x, this.self.y, JUMP_DIST_SQ);
            for (const b of this.balls) {
                b.buffer.push(time, b.x, b.y, JUMP_DIST_SQ);
            }
            this.patchTimes.push(time);
            if (this.patchTimes.length > LocalRenderTestScene.DEBUG_WINDOW) {
                this.patchTimes.shift();
            }
        }

        // 4) Render. mode='buffered' is the state-sync code path verbatim.
        if (this.mode === 'buffered') {
            const renderTime = time - INTERP_DELAY;
            const ps = this.self.buffer.sample(renderTime);
            this.self.entity.x = ps.x;
            this.self.entity.y = ps.y;
            this.self.label.x = ps.x;
            this.self.label.y = ps.y - PLAYER_SIZE;
            for (const b of this.balls) {
                const s = b.buffer.sample(renderTime);
                b.entity.x = s.x; b.entity.y = s.y;
            }
        } else {
            this.self.entity.x = this.self.x;
            this.self.entity.y = this.self.y;
            this.self.label.x = this.self.x;
            this.self.label.y = this.self.y - PLAYER_SIZE;
            for (const b of this.balls) {
                b.entity.x = b.x; b.entity.y = b.y;
            }
        }

        this.updateDebug();
    }

    /** Self clamps at walls (input drives velocity); balls reflect velocity
     *  to bounce around forever, giving steady motion to observe stutter. */
    private stepEntity(
        e: { x: number; y: number; vx: number; vy: number },
        dt: number, halfSize: number, bounce: boolean,
    ): void {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if (e.x < halfSize) {
            e.x = halfSize;
            if (bounce) e.vx = -e.vx;
        } else if (e.x > MAP_W - halfSize) {
            e.x = MAP_W - halfSize;
            if (bounce) e.vx = -e.vx;
        }
        if (e.y < halfSize) {
            e.y = halfSize;
            if (bounce) e.vy = -e.vy;
        } else if (e.y > MAP_H - halfSize) {
            e.y = MAP_H - halfSize;
            if (bounce) e.vy = -e.vy;
        }
    }

    private updateDebug(): void {
        let avg = 0, std = 0;
        const t = this.patchTimes;
        if (t.length >= 2) {
            const gaps: number[] = [];
            for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
            avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const variance = gaps.reduce((a, b) => a + (b - avg) ** 2, 0) / gaps.length;
            std = Math.sqrt(variance);
        }
        // Frame-level stats: f_avg ~ monitor refresh interval, f_std exposes
        // RAF jitter. On 60Hz: ~16.7ms / sub-1ms. On 144Hz: ~6.9ms / smaller.
        let fAvg = 0, fStd = 0, fMin = 0, fMax = 0;
        const ft = this.frameTimes;
        if (ft.length >= 2) {
            const gaps: number[] = [];
            for (let i = 1; i < ft.length; i++) gaps.push(ft[i] - ft[i - 1]);
            fAvg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const variance = gaps.reduce((a, b) => a + (b - fAvg) ** 2, 0) / gaps.length;
            fStd = Math.sqrt(variance);
            fMin = Math.min(...gaps);
            fMax = Math.max(...gaps);
        }
        const heap = (performance as any).memory?.usedJSHeapSize;
        const renderer = this.game.renderer.type === Phaser.WEBGL ? 'WebGL' : 'Canvas';

        // Hint the toggle key right in the value, so users notice the affordance.
        this.debugOverlay.set('mode', this.mode === 'buffered'
            ? 'buffered (B→raw)' : 'raw (B→buffered)');
        this.debugOverlay.set('round_px', this.cameras.main.roundPixels
            ? 'ON (R→off)' : 'OFF (R→on)');
        this.debugOverlay.set('cam_follow', this.cameraFollowing
            ? 'ON (F→off)' : 'OFF (F→on)');
        // Step-6 cycle indicators. Per-frame motion at 60fps = speed/60;
        // blur:size ratio at 60Hz LCD = (speed/60) / (radius*2).
        const blurRatio = (this.currentBallSpeed / 60) / (this.currentBallRadius * 2);
        this.debugOverlay.set('ball_speed',
            `${this.currentBallSpeed} px/s [${BALL_SPEED_OPTIONS.join('/')}] (N)`);
        this.debugOverlay.set('ball_size',
            `r=${this.currentBallRadius} [${BALL_RADIUS_OPTIONS.join('/')}] (K)`);
        this.debugOverlay.set('blur_ratio', `${(blurRatio * 100).toFixed(0)}% (lower=less blur)`);
        this.debugOverlay.set('loop', this.game.loop.forceSetTimeOut
            ? 'setTimeout (?st=0 to RAF)' : 'RAF (?st=1 to setTimeout)');
        this.debugOverlay.set('smoothstep', this.game.loop.smoothStep
            ? 'true (?ss=0 to false)' : 'false (?ss=1 to true)');
        this.debugOverlay.set('renderer', renderer);
        this.debugOverlay.set('dpr', window.devicePixelRatio.toFixed(2));
        this.debugOverlay.set('fps', this.game.loop.actualFps.toFixed(0));
        this.debugOverlay.set('frame_avg', `${fAvg.toFixed(2)}ms`);
        this.debugOverlay.set('frame_jitter', `±${fStd.toFixed(2)}ms (${fMin.toFixed(0)}-${fMax.toFixed(0)})`);
        this.debugOverlay.set('patch_avg', `${avg.toFixed(1)}ms`);
        this.debugOverlay.set('patch_std', `${std.toFixed(1)}ms`);
        this.debugOverlay.set('entities', 1 + this.balls.length);
        if (heap) this.debugOverlay.set('mem', `${(heap / 1048576).toFixed(1)}MB`);
    }
}
