import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import type VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import type VirtualJoyStick from 'phaser4-rex-plugins/plugins/virtualjoystick.js';
import { Room, Client, getStateCallbacks } from '@colyseus/sdk';
import { FontSize, HexText, Palette, Spacing, SceneBG, textStyle } from '../theme';
import { paintGradientBackground } from '../ui/background';
import { paintArenaBoundary } from '../ui/arena_boundary';
import { createBattleHud, type BattleHud } from '../ui/battle_hud';
import { DebugOverlay } from '../util/debug_overlay';

/**
 * Naive state-sync rendering, A/B counterpart to `state_sync_battle_scene.ts`:
 * snap entities to latest patch (no SnapshotBuffer / no interpolation), no
 * Arc pools. Server room is identical (`state_sync_battle_room`).
 */

// Mirror of server-side constants (see state_sync_battle_room.ts).
const MAP_W = 800;
const MAP_H = 1200;
const PLAYER_SIZE = 20;
const BALL_RADIUS = 5;
const STATE_INVULN = 1;

const PLAYER_PALETTE: readonly number[] = [
    0x4A90E2, 0xE74C3C, 0x27AE60, 0xF5A623,
    0x9B59B6, 0x1ABC9C, 0xE91E63, 0x34495E,
] as const;

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
};

type BallEntity = {
    entity: Phaser.GameObjects.Arc;
};

export class StateSyncBattleRawScene extends Phaser.Scene {
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
    private patchTimes: number[] = [];
    private latestPing: number = 0;
    private pingTimer?: Phaser.Time.TimerEvent;
    private static readonly DEBUG_WINDOW = 20;
    private static readonly DEBUG_INTERVAL = 250;
    private nextDebugUpdateTime = 0;

    constructor() { super({ key: 'state_sync_battle_raw' }); }

    async create() {
        // Phaser reuses Scene instances by key — reset per-instance state.
        this.isShuttingDown = false;
        this.playerEntities = new Map();
        this.ballEntities = new Map();
        this.joystickPointerId = null;
        this.patchTimes = [];
        this.latestPing = 0;
        this.nextDebugUpdateTime = 0;

        paintGradientBackground(this, SceneBG.state.top, SceneBG.state.bottom,
            { width: MAP_W, height: MAP_H });
        this.hud = createBattleHud(this, () => {
            this.scene.switch('main');
            this.scene.stop('state_sync_battle_raw');
        }, { kills: true, deaths: true });
        this.debugOverlay = new DebugOverlay(this);
        this.setupInput();
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        await this.connect();
        if (!this.room || this.isShuttingDown) return;

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

        this.room.onStateChange(() => {
            if (this.isShuttingDown) return;
            this.patchTimes.push(this.time.now);
            if (this.patchTimes.length > StateSyncBattleRawScene.DEBUG_WINDOW) {
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

            try { this.scale.off(Phaser.Scale.Events.RESIZE, onResize); } catch {}
            try { this.room?.leave(); } catch {}
            this.room = undefined;
            try { this.pingTimer?.remove(); } catch {}
            this.pingTimer = undefined;

            try {
                for (const pe of this.playerEntities.values()) {
                    this.destroyPlayerEntity(pe);
                }
            } catch {}
            try {
                for (const be of this.ballEntities.values()) be.entity.destroy();
            } catch {}
            this.playerEntities = new Map();
            this.ballEntities = new Map();

            try { this.joystick?.destroy(); } catch {}

            this.joystickPointerId = null;
        });
    }

    async connect() {
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
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

        this.playerEntities.set(sessionId, {
            entity, ring, ringTween, label, colorIdx, isSelf,
        });

        let lastKills = -1, lastDeaths = -1;

        // listen('state') MUST run before onChange so the explosion plays at
        // the pre-respawn position. Server schema declares `state` before x/y;
        // Colyseus 0.17 applies in declaration order.
        $(player).listen('state', (newVal: number, oldVal: number | undefined) => {
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
            pe.entity.x = player.x; pe.entity.y = player.y;
            pe.ring.x = player.x;   pe.ring.y = player.y;
            pe.label.x = player.x;  pe.label.y = player.y - PLAYER_SIZE;
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
        pe.ringTween.stop();
        pe.ringTween.remove();
        pe.ring.destroy();
        pe.label.destroy();
        pe.entity.destroy();
    }

    private onBallAdd(ball: any, state: any, $: any): void {
        if (this.isShuttingDown) return;

        const owner = state.players.get(ball.ownerSessionId);
        const color = owner
            ? PLAYER_PALETTE[(owner.colorIdx ?? 0) % PLAYER_PALETTE.length]
            : Palette.textSecondary;

        const entity = this.add.arc(ball.x, ball.y, BALL_RADIUS, 0, 360, false, color);
        this.ballEntities.set(ball, { entity });
        $(ball).onChange(() => {
            const be = this.ballEntities.get(ball);
            if (!be) return;
            be.entity.x = ball.x; be.entity.y = ball.y;
        });
    }

    private onBallRemove(ball: any): void {
        const be = this.ballEntities.get(ball);
        if (!be) return;
        be.entity.destroy();
        this.ballEntities.delete(ball);
    }

    /** Cheap radial particle burst: 6 small circles fly outward + fade. */
    private spawnExplosion(x: number, y: number, color: number): void {
        const N = 6;
        for (let i = 0; i < N; i++) {
            const angle = (i / N) * Math.PI * 2;
            const dx = Math.cos(angle) * 28;
            const dy = Math.sin(angle) * 28;
            const circle = this.add.circle(x, y, 3, color, 1);
            this.tweens.add({
                targets: circle,
                x: x + dx,
                y: y + dy,
                alpha: 0,
                scale: 0.5,
                duration: 300,
                ease: 'Cubic.easeOut',
                onComplete: () => circle.destroy(),
            });
        }
    }

    // ── Input (joystick + keyboard) ─────────────────────────────────────

    /** Floating virtual joystick + arrow keys / WASD. */
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
            dir: '4dir',
            forceMin: 8,
            fixed: true,
        });
        this.joystick.setVisible(false);

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
        this.joystick.setVisible(false);
        this.joystickPointerId = null;
    }

    update(): void {
        if (!this.room || this.isShuttingDown) return;
        const leftKey = this.cursors.left.isDown || this.wasd.A.isDown;
        const rightKey = this.cursors.right.isDown || this.wasd.D.isDown;
        const upKey = this.cursors.up.isDown || this.wasd.W.isDown;
        const downKey = this.cursors.down.isDown || this.wasd.S.isDown;

        // 4dir + fixed UI by design (this scene is the analog-counterpart's
        // raw baseline). Keep boolean inputs but emit the unified vector
        // payload, normalised so diagonals don't ride the √2 speed bump.
        const left = this.joystick.left || leftKey;
        const right = this.joystick.right || rightKey;
        const up = this.joystick.up || upKey;
        const down = this.joystick.down || downKey;
        const kx = (right ? 1 : 0) - (left ? 1 : 0);
        const ky = (down ? 1 : 0) - (up ? 1 : 0);
        let dx = 0, dy = 0;
        if (kx !== 0 || ky !== 0) {
            const m = Math.hypot(kx, ky);
            dx = kx / m;
            dy = ky / m;
        }
        this.inputPayload.dx = dx;
        this.inputPayload.dy = dy;

        this.room.send(0, this.inputPayload);

        this.updateDebug();
    }

    /** Emit default diagnostic metrics. */
    private updateDebug(): void {
        if (this.time.now < this.nextDebugUpdateTime) return;
        this.nextDebugUpdateTime = this.time.now + StateSyncBattleRawScene.DEBUG_INTERVAL;

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
