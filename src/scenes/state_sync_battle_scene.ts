import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import type VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import type VirtualJoyStick from 'phaser4-rex-plugins/plugins/virtualjoystick.js';
import { Room, Client, getStateCallbacks } from '@colyseus/sdk';
import { FontSize, HexText, Palette, Spacing, SceneBG, textStyle } from '../theme';
import { paintGradientBackground } from '../ui/background';
import { paintArenaBoundary } from '../ui/arena_boundary';
import { createBattleHud, type BattleHud } from '../ui/battle_hud';
import { SnapshotBuffer } from '../util/snapshot_buffer';
import { DebugOverlay } from '../util/debug_overlay';

// Mirror of server-side constants (see state_sync_battle_room.ts).
const MAP_W = 800;
const MAP_H = 1200;
const PLAYER_SIZE = 20;
const BALL_RADIUS = 5;
const STATE_INVULN = 1;

// Delayed-render interpolation. 100ms ≈ 2× default patchRate (50ms) —
// absorbs WebSocket jitter and a single dropped patch.
const INTERP_DELAY = 100;
// Per-patch displacement above this is a teleport (respawn) — buffer resets.
const JUMP_DIST_SQ = (PLAYER_SIZE * 4) ** 2;

// Joystick geometry. Module-scoped so the follow-update closure (which
// drags the base when the finger overshoots) can read them.
const JOYSTICK_BASE_RADIUS = 60;
const JOYSTICK_THUMB_RADIUS = 25;

// 8 high-contrast colours for up to MAX_PLAYERS=8. Stable per-session
// colorIdx from the server gives every client the same colour for the
// same player; self gets a white outline + "YOU" label on top.
const PLAYER_PALETTE: readonly number[] = [
    0x4A90E2, // 1 blue
    0xE74C3C, // 2 red
    0x27AE60, // 3 green
    0xF5A623, // 4 amber
    0x9B59B6, // 5 purple
    0x1ABC9C, // 6 teal
    0xE91E63, // 7 pink
    0x34495E, // 8 slate
] as const;

// CSS hex mirror of PLAYER_PALETTE for head labels.
const PLAYER_PALETTE_HEX: readonly string[] = [
    '#4A90E2', '#E74C3C', '#27AE60', '#F5A623',
    '#9B59B6', '#1ABC9C', '#E91E63', '#34495E',
] as const;

type PlayerEntity = {
    entity: Phaser.GameObjects.Rectangle;
    ring: Phaser.GameObjects.Arc;
    ringTween: Phaser.Tweens.Tween;
    label: Phaser.GameObjects.Text;
    colorIdx: number;
    isSelf: boolean;
    buffer: SnapshotBuffer;
};

type BallEntity = {
    entity: Phaser.GameObjects.Arc;
    buffer: SnapshotBuffer;
};

/**
 * State-sync battle: server-authoritative Matter physics, client renders
 * state and forwards input. Map is larger than the viewport; camera
 * follows self.
 */
export class StateSyncBattleScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    rexVirtualJoyStick!: VirtualJoyStickPlugin;
    room: Room;
    playerEntities: Map<string, PlayerEntity> = new Map();
    // Keyed by the Ball schema instance — ArraySchema.onAdd gives insertion
    // ordinal while onRemove gives shifting array index, so neither is
    // usable as a correlation key.
    ballEntities: Map<object, BallEntity> = new Map();
    private hud!: BattleHud;
    inputPayload: { dx: number; dy: number } = { dx: 0, dy: 0 };

    private joystick!: VirtualJoyStick;
    private joystickBase!: Phaser.GameObjects.Arc;
    private joystickThumb!: Phaser.GameObjects.Arc;
    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!: {
        W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
        S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    };
    private joystickPointerId: number | null = null;

    // Gate async Colyseus callbacks after scene.stop(); without it
    // onPlayerAdd can leak a rect that survives into the next scene enter.
    private isShuttingDown = false;

    private debugOverlay!: DebugOverlay;
    // Recent patch timestamps for patch_avg / patch_std.
    private patchTimes: number[] = [];
    private latestPing: number = 0;
    private pingTimer?: Phaser.Time.TimerEvent;
    private static readonly DEBUG_WINDOW = 20;
    private static readonly DEBUG_INTERVAL = 250;   // ms between updateDebug ticks
    private nextDebugUpdateTime = 0;

    // Pools grown on demand; destroyed in SHUTDOWN.
    private ballArcPool: Phaser.GameObjects.Arc[] = [];
    private explosionPool: Phaser.GameObjects.Arc[] = [];

    constructor() { super({ key: 'state_sync_battle' }); }

    async create() {
        // Phaser reuses Scene instances by key — reset per-instance state.
        this.isShuttingDown = false;
        this.playerEntities = new Map();
        this.ballEntities = new Map();
        this.joystickPointerId = null;
        this.patchTimes = [];
        this.latestPing = 0;
        this.nextDebugUpdateTime = 0;
        this.ballArcPool = [];
        this.explosionPool = [];

        paintGradientBackground(this, SceneBG.state.top, SceneBG.state.bottom,
            { width: MAP_W, height: MAP_H });
        this.hud = createBattleHud(this, () => {
            this.scene.switch('main');
            this.scene.stop('state_sync_battle');
        }, { kills: true, deaths: true });
        this.debugOverlay = new DebugOverlay(this);
        this.setupInput();
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        await this.connect();
        if (!this.room || this.isShuttingDown) return;

        // Collection callbacks go through `getStateCallbacks(room)`;
        // joinOrCreate resolves before state arrives so wait for first
        // onStateChange.
        this.room.onStateChange.once((state) => {
            if (this.isShuttingDown) return;
            this.cameras.main.setBounds(0, 0, state.mapWidth, state.mapHeight);
            paintArenaBoundary(this, state.mapWidth, state.mapHeight);
            const $ = getStateCallbacks(this.room);

            $(state.players).onAdd((player, sessionId) => this.onPlayerAdd(player, sessionId, $));
            $(state.players).onRemove((_player, sessionId) => this.onPlayerRemove(sessionId));
            $(state.balls).onAdd((ball) => this.onBallAdd(ball, state, $));
            $(state.balls).onRemove((ball) => this.onBallRemove(ball));
        });

        // Patch cadence (fires per patch, unlike onChange which gates on changes).
        this.room.onStateChange(() => {
            if (this.isShuttingDown) return;
            this.patchTimes.push(this.time.now);
            if (this.patchTimes.length > StateSyncBattleScene.DEBUG_WINDOW) {
                this.patchTimes.shift();
            }
        });

        this.pingTimer = this.time.addEvent({
            delay: 2000, loop: true, callback: () => {
                this.room?.ping((ms) => { this.latestPing = ms; });
            },
        });

        const onResize = () => {
            this.hud.relayout();
            if (this.joystick.visible) this.hideJoystick();
        };
        this.scale.on(Phaser.Scale.Events.RESIZE, onResize);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.isShuttingDown = true;

            // Each step try/catch-guarded: Phaser 4 tears down sub-systems
            // in an order we don't control, and a single throw used to
            // abort cleanup and leak GameObjects across scene restarts.
            try { this.scale.off(Phaser.Scale.Events.RESIZE, onResize); } catch {}
            // Don't call cameras.main.stopFollow() — CameraManager may have
            // already disposed the Camera; framework handles it.
            try { this.room?.leave(); } catch {}
            this.room = undefined;
            try { this.pingTimer?.remove(); } catch {}
            this.pingTimer = undefined;

            // DisplayList.shutdown destroys scene GameObjects automatically;
            // these explicit destroys release tween-held target refs that
            // otherwise leak across restarts. destroy() is idempotent.
            try {
                for (const pe of this.playerEntities.values()) {
                    this.destroyPlayerEntity(pe);
                }
            } catch {}
            try {
                for (const be of this.ballEntities.values()) be.entity.destroy();
                for (const arc of this.ballArcPool) arc.destroy();
            } catch {}
            try {
                for (const arc of this.explosionPool) arc.destroy();
            } catch {}
            this.playerEntities = new Map();
            this.ballEntities = new Map();
            this.ballArcPool = [];
            this.explosionPool = [];

            // rex joystick holds refs to base+thumb; destroy() detaches
            // its pointer listeners, then DisplayList handles the visuals.
            try { this.joystick?.destroy(); } catch {}

            this.joystickPointerId = null;
        });
    }

    async connect() {
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            // Identity lives in the ticket (consumed in onAuth).
            this.room = await client.joinOrCreate(startBattleRes.roomType, {
                ticket: startBattleRes.ticket,
            });
        } catch (e) {
            // No status widget on state-sync HUD; scene stays empty, Back works.
        }
    }

    // ── Render callbacks ────────────────────────────────────────────────

    private onPlayerAdd(player: any, sessionId: string, $: any): void {
        if (this.isShuttingDown) return;

        const isSelf = sessionId === this.room.sessionId;
        const colorIdx = (player.colorIdx ?? 0) % PLAYER_PALETTE.length;
        const bodyColor = PLAYER_PALETTE[colorIdx];
        const labelHex = PLAYER_PALETTE_HEX[colorIdx];

        const entity = this.add.rectangle(player.x, player.y,
            PLAYER_SIZE, PLAYER_SIZE, bodyColor);
        if (isSelf) {
            this.cameras.main.startFollow(entity, false, 0.1, 0.1);
        }

        // Head label: "YOU" for self, "P<n>" for others. Colour-matched
        // to body so bullets + label + body group at a glance.
        const label = this.add.text(player.x, player.y - PLAYER_SIZE, '', {
            ...textStyle({
                size: FontSize.caption,
                color: isSelf ? HexText.white : labelHex,
                weight: 'bold',
                shadow: true,
            }),
            align: 'center',
        }).setOrigin(0.5, 1);
        label.setText(isSelf ? 'YOU' : `P${colorIdx + 1}`);

        // Invuln ring: pulsing green circle, visibility driven by player.state.
        const ring = this.add.circle(player.x, player.y, PLAYER_SIZE * 0.9)
            .setStrokeStyle(3, Palette.success, 0.9)
            .setFillStyle(Palette.success, 0.0)
            .setVisible(false);
        const ringTween = this.tweens.add({
            targets: ring,
            scale: { from: 0.85, to: 1.25 },
            alpha: { from: 1, to: 0.4 },
            duration: 400,
            yoyo: true,
            repeat: -1,
            paused: true,
        });

        const buffer = new SnapshotBuffer();
        buffer.seed(this.time.now, player.x, player.y);

        this.playerEntities.set(sessionId, {
            entity, ring, ringTween, label, colorIdx, isSelf, buffer,
        });

        let lastKills = -1, lastDeaths = -1;

        // listen('state') MUST run before onChange so the explosion plays at
        // the pre-respawn position. Server schema declares `state` before x/y;
        // Colyseus 0.17 applies in declaration order.
        $(player).listen('state', (newVal: number, oldVal: number | undefined) => {
            // oldVal undefined on first-ever delivery — not a transition.
            if (oldVal !== undefined && oldVal !== newVal) {
                this.spawnExplosion(entity.x, entity.y, bodyColor);
            }
            if (newVal === STATE_INVULN) {
                ring.setVisible(true);
                ringTween.resume();
            } else {
                ring.setVisible(false);
                ringTween.pause();
                ring.setScale(1);
                ring.setAlpha(1);
            }
        });

        $(player).onChange(() => {
            const pe = this.playerEntities.get(sessionId);
            if (!pe) return;
            pe.buffer.push(this.time.now, player.x, player.y, JUMP_DIST_SQ);
            if (isSelf) {
                if (player.kills !== lastKills) {
                    this.hud.kills?.setText(`Score ${player.kills}`);
                    lastKills = player.kills;
                }
                if (player.deaths !== lastDeaths) {
                    this.hud.deaths?.setText(`Outs ${player.deaths}`);
                    lastDeaths = player.deaths;
                }
            }
        });

        // First-paint prime: listen/onChange only fire on future changes.
        if (player.state === STATE_INVULN) {
            ring.setVisible(true);
            ringTween.resume();
        }
        if (isSelf) {
            lastKills = player.kills ?? 0;
            lastDeaths = player.deaths ?? 0;
            this.hud.kills?.setText(`Score ${lastKills}`);
            this.hud.deaths?.setText(`Outs ${lastDeaths}`);
        }
    }

    private onPlayerRemove(sessionId: string): void {
        const pe = this.playerEntities.get(sessionId);
        if (!pe) return;
        this.destroyPlayerEntity(pe);
        this.playerEntities.delete(sessionId);
    }

    private destroyPlayerEntity(pe: PlayerEntity): void {
        // Stop tween first — it holds a hard ref to the target; destroying
        // the target while the tween is active leaves a zombie listener.
        pe.ringTween.stop();
        pe.ringTween.remove();
        pe.ring.destroy();
        pe.label.destroy();
        pe.entity.destroy();
    }

    private onBallAdd(ball: any, state: any, $: any): void {
        if (this.isShuttingDown) return;

        // Colour the ball by owner's palette slot; grey if owner already left
        // (orphan bullet — server keeps it inert, grey signals "stray").
        const owner = state.players.get(ball.ownerSessionId);
        const color = owner
            ? PLAYER_PALETTE[(owner.colorIdx ?? 0) % PLAYER_PALETTE.length]
            : Palette.textSecondary;

        const entity = this.acquireBallArc(ball.x, ball.y, color);
        const buffer = new SnapshotBuffer();
        buffer.seed(this.time.now, ball.x, ball.y);
        this.ballEntities.set(ball, { entity, buffer });
        $(ball).onChange(() => {
            const be = this.ballEntities.get(ball);
            if (!be) return;
            be.buffer.push(this.time.now, ball.x, ball.y, JUMP_DIST_SQ);
        });
    }

    private onBallRemove(ball: any): void {
        const be = this.ballEntities.get(ball);
        if (!be) return;
        this.releaseBallArc(be.entity);
        this.ballEntities.delete(ball);
    }

    private acquireBallArc(
        x: number, y: number, color: number,
    ): Phaser.GameObjects.Arc {
        const arc = this.ballArcPool.pop()
            ?? this.add.arc(0, 0, BALL_RADIUS, 0, 360, false, color);
        arc.setPosition(x, y).setFillStyle(color).setVisible(true).setActive(true);
        return arc;
    }

    private releaseBallArc(arc: Phaser.GameObjects.Arc): void {
        arc.setVisible(false).setActive(false);
        this.ballArcPool.push(arc);
    }

    /** Cheap radial particle burst: 6 small circles fly outward + fade. */
    private spawnExplosion(x: number, y: number, color: number): void {
        const N = 6;
        for (let i = 0; i < N; i++) {
            const angle = (i / N) * Math.PI * 2;
            const dx = Math.cos(angle) * 28;
            const dy = Math.sin(angle) * 28;
            const circle = this.explosionPool.pop()
                ?? this.add.circle(0, 0, 3, 0xffffff, 1);
            circle.setPosition(x, y)
                .setFillStyle(color)
                .setAlpha(1).setScale(1)
                .setVisible(true).setActive(true);
            this.tweens.add({
                targets: circle,
                x: x + dx,
                y: y + dy,
                alpha: 0,
                scale: 0.5,
                duration: 300,
                ease: 'Cubic.easeOut',
                onComplete: () => {
                    if (this.isShuttingDown) return;
                    circle.setVisible(false).setActive(false);
                    this.explosionPool.push(circle);
                },
            });
        }
    }

    // ── Input (joystick + keyboard) ─────────────────────────────────────

    /** Floating virtual joystick + arrow keys / WASD. */
    private setupInput(): void {
        this.joystickBase = this.add.circle(0, 0, JOYSTICK_BASE_RADIUS, Palette.textPrimary, 0.10);
        this.joystickBase.setStrokeStyle(2, Palette.textPrimary, 0.22);
        this.joystickBase.setDepth(1000);
        // Screen-space UI: stays on-screen as the camera follows self.
        this.joystickBase.setScrollFactor(0);
        this.joystickThumb = this.add.circle(0, 0, JOYSTICK_THUMB_RADIUS, Palette.textSecondary, 0.55);
        this.joystickThumb.setDepth(1001);
        this.joystickThumb.setScrollFactor(0);

        this.joystick = this.rexVirtualJoyStick.add(this, {
            x: 0, y: 0, radius: JOYSTICK_BASE_RADIUS,
            base: this.joystickBase, thumb: this.joystickThumb,
            dir: '8dir', // analog vector goes via forceX/Y; 8dir keeps boolean fallback diagonal-friendly
            forceMin: 8, // dead zone (px)
            fixed: true,
        });
        this.joystick.setVisible(false);

        // Drag the base when the finger overshoots radius — keeps the finger
        // glued to the base edge instead of detaching mid-stroke.
        // Recursion safety: setPosition re-emits 'update', but after the drag
        // force == BASE_RADIUS so the guard `f <= BASE_RADIUS` terminates.
        this.joystick.on('update', () => {
            if (!this.joystick.visible) return;
            const f = this.joystick.force;
            if (f <= JOYSTICK_BASE_RADIUS) return;
            const over = (f - JOYSTICK_BASE_RADIUS) / f;
            // forceX/Y is base→pointer in screen-space (rex internally
            // cancels camera scroll), so adding a fraction of it shifts
            // the base correctly without world↔screen conversion.
            let newX = this.joystick.x + this.joystick.forceX * over;
            let newY = this.joystick.y + this.joystick.forceY * over;
            const hudBand = Spacing.lg + this.hud.height();
            newX = Math.max(JOYSTICK_BASE_RADIUS,
                Math.min(this.scale.width - JOYSTICK_BASE_RADIUS, newX));
            newY = Math.max(hudBand + JOYSTICK_BASE_RADIUS,
                Math.min(this.scale.height - JOYSTICK_BASE_RADIUS, newY));
            this.joystick.setPosition(newX, newY);
        });

        this.cursors = this.input.keyboard!.createCursorKeys();
        this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd;

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
        // Geometric guard: block the HUD band (covers gaps between HUD children).
        if (pointer.y < Spacing.lg + this.hud.height()) return;

        this.joystickPointerId = pointer.id;
        this.joystick.setPosition(pointer.x, pointer.y);
        this.joystick.setVisible(true);

        // rex TouchCursor subscribes to base.on('pointerdown'), but our base
        // is at (0,0) + invisible when Phaser fires pointerdown so the plugin
        // never starts tracking. Feed the pointer in via its (undocumented)
        // onKeyDownStart.
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
        // Disabling also clears TouchCursor's captured pointer and zeros
        // joystick.{left,right,up,down}.
        this.joystick.setVisible(false);
        this.joystickPointerId = null;
    }

    update(): void {
        if (!this.room || this.isShuttingDown) return;
        const leftKey = this.cursors.left.isDown || this.wasd.A.isDown;
        const rightKey = this.cursors.right.isDown || this.wasd.D.isDown;
        const upKey = this.cursors.up.isDown || this.wasd.W.isDown;
        const downKey = this.cursors.down.isDown || this.wasd.S.isDown;

        let dx = 0, dy = 0;
        if (this.joystick.visible && !this.joystick.noKey) {
            const f = this.joystick.force;
            if (f > 0) {
                const mag = Math.min(f / JOYSTICK_BASE_RADIUS, 1);
                dx = (this.joystick.forceX / f) * mag;
                dy = (this.joystick.forceY / f) * mag;
            }
        } else {
            const kx = (rightKey ? 1 : 0) - (leftKey ? 1 : 0);
            const ky = (downKey ? 1 : 0) - (upKey ? 1 : 0);
            if (kx !== 0 || ky !== 0) {
                const m = Math.hypot(kx, ky);
                dx = kx / m;
                dy = ky / m;
            }
        }
        this.inputPayload.dx = dx;
        this.inputPayload.dy = dy;

        this.room.send(0, this.inputPayload);

        // Sample every entity at `now - INTERP_DELAY`.
        const renderTime = this.time.now - INTERP_DELAY;
        for (const pe of this.playerEntities.values()) {
            const s = pe.buffer.sample(renderTime);
            pe.entity.x = s.x; pe.entity.y = s.y;
            pe.ring.x = s.x;   pe.ring.y = s.y;
            pe.label.x = s.x;  pe.label.y = s.y - PLAYER_SIZE;
        }
        for (const be of this.ballEntities.values()) {
            const s = be.buffer.sample(renderTime);
            be.entity.x = s.x; be.entity.y = s.y;
        }

        this.updateDebug();
    }

    /** Emit default diagnostic metrics. */
    private updateDebug(): void {
        if (this.time.now < this.nextDebugUpdateTime) return;
        this.nextDebugUpdateTime = this.time.now + StateSyncBattleScene.DEBUG_INTERVAL;

        let avg = 0, std = 0;
        const t = this.patchTimes;
        if (t.length >= 2) {
            const gaps: number[] = [];
            for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
            avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const variance = gaps.reduce((a, b) => a + (b - avg) ** 2, 0) / gaps.length;
            std = Math.sqrt(variance);
        }
        const entityCount = this.playerEntities.size + this.ballEntities.size;
        const heap = (performance as any).memory?.usedJSHeapSize;
        this.debugOverlay.set('fps', this.game.loop.actualFps.toFixed(0));
        this.debugOverlay.set('ping', `${this.latestPing.toFixed(0)}ms`);
        this.debugOverlay.set('patch_avg', `${avg.toFixed(1)}ms`);
        this.debugOverlay.set('patch_std', `${std.toFixed(1)}ms`);
        this.debugOverlay.set('entities', entityCount);
        if (heap) this.debugOverlay.set('mem', `${(heap / 1048576).toFixed(1)}MB`);
    }
}
