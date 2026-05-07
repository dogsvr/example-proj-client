import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import type VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import type VirtualJoyStick from 'phaser4-rex-plugins/plugins/virtualjoystick.js';
import { Room, Client, getStateCallbacks } from '@colyseus/sdk';
import { FontSize, HexText, Palette, Spacing, SceneBG, textStyle } from '../theme';
import { paintGradientBackground } from '../ui/background';
import { paintArenaBoundary } from '../ui/arena_boundary';
import { createBattleHud, type BattleHud } from '../ui/battle_hud';

// Mirror of server-side constants (see state_sync_battle_room.ts).
const MAP_W = 800;
const MAP_H = 1200;
const INVULN_DURATION = 2500;     // must match server
const PLAYER_SIZE = 20;
const BALL_RADIUS = 5;
const STATE_INVULN = 1;

// Linear interpolation window between patches. Without this, entity.x
// steps once per patch (~20Hz) while the camera lerps every frame, and
// the subframe delta oscillates visibly around self. 100ms ≈ 2× default
// patchRate to tolerate WebSocket jitter.
const INTERP_DURATION = 100;

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
    // Render lerps prev→target over INTERP_DURATION from interpStart.
    prevX: number;
    prevY: number;
    targetX: number;
    targetY: number;
    interpStart: number;
    onChangeUnsub?: () => void;
    onStateListenUnsub?: () => void;
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
    playerEntities: { [sessionId: string]: PlayerEntity } = {};
    // Keyed by the Ball schema instance — ArraySchema.onAdd gives insertion
    // ordinal while onRemove gives shifting array index, so neither is
    // usable as a correlation key.
    // Bullets render at the authoritative position (no interp); lerping
    // across a ricochet draws a straight line across the bounce.
    ballEntities: Map<object, Phaser.GameObjects.Arc> = new Map();
    private hud!: BattleHud;
    inputPayload = { left: false, right: false, up: false, down: false };

    private joystick!: VirtualJoyStick;
    private joystickBase!: Phaser.GameObjects.Arc;
    private joystickThumb!: Phaser.GameObjects.Arc;
    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!: {
        W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
        S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    };
    private joystickPointerId: number | null = null;

    private selfInvulnEndsAt: number = 0;   // scene-clock ms

    // Gate async Colyseus callbacks after scene.stop(); without it
    // onPlayerAdd can leak a rect that survives into the next scene enter.
    private isShuttingDown = false;

    constructor() { super({ key: 'state_sync_battle' }); }

    async create() {
        // Phaser reuses Scene instances by key — reset per-instance state.
        this.isShuttingDown = false;
        this.playerEntities = {};
        this.ballEntities = new Map();
        this.joystickPointerId = null;
        this.selfInvulnEndsAt = 0;

        paintGradientBackground(this, SceneBG.state.top, SceneBG.state.bottom,
            { width: MAP_W, height: MAP_H });
        this.hud = createBattleHud(this, () => {
            this.scene.switch('main');
            this.scene.stop('state_sync_battle');
        }, { kills: true, invuln: true });
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

            // DisplayList.shutdown destroys scene GameObjects automatically;
            // these explicit destroys release tween-held target refs that
            // otherwise leak across restarts. destroy() is idempotent.
            try {
                for (const sid of Object.keys(this.playerEntities)) {
                    this.destroyPlayerEntity(this.playerEntities[sid]);
                }
            } catch {}
            try {
                for (const entity of this.ballEntities.values()) entity.destroy();
            } catch {}
            this.playerEntities = {};
            this.ballEntities = new Map();

            // rex joystick holds refs to base+thumb; destroy() detaches
            // its pointer listeners, then DisplayList handles the visuals.
            try { this.joystick?.destroy(); } catch {}

            this.joystickPointerId = null;
            this.selfInvulnEndsAt = 0;
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
            entity.setStrokeStyle(3, 0xFFFFFF, 1);
            this.cameras.main.startFollow(entity, true, 0.1, 0.1);
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

        this.playerEntities[sessionId] = {
            entity, ring, ringTween, label, colorIdx, isSelf,
            prevX: player.x, prevY: player.y,
            targetX: player.x, targetY: player.y,
            interpStart: this.time.now,
        };

        // listen('state', ...) MUST fire before onChange updates the interp
        // target so the explosion plays at the old (death) position. Colyseus
        // 0.17 applies fields in declaration order; server schema declares
        // `state` before `x/y`.
        $(player).listen('state', (newVal: number, oldVal: number | undefined) => {
            // oldVal undefined on first-ever delivery — not a transition.
            if (oldVal !== undefined && oldVal !== newVal) {
                this.spawnExplosion(entity.x, entity.y, bodyColor);
            }
            if (newVal === STATE_INVULN) {
                ring.setVisible(true);
                ringTween.resume();
                if (isSelf) this.selfInvulnEndsAt = this.time.now + INVULN_DURATION;
            } else {
                ring.setVisible(false);
                ringTween.pause();
                ring.setScale(1);
                ring.setAlpha(1);
                if (isSelf) this.selfInvulnEndsAt = 0;
            }
        });

        // onChange fires once per patch (~20Hz). We update the interp
        // target and let update() smooth it. A large jump (respawn) snaps
        // prev to target so we don't draw a line across the map.
        $(player).onChange(() => {
            const pe = this.playerEntities[sessionId];
            if (!pe) return;
            const dx = player.x - pe.targetX;
            const dy = player.y - pe.targetY;
            const jumped = dx * dx + dy * dy > (PLAYER_SIZE * 4) ** 2;
            if (jumped) {
                pe.prevX = player.x; pe.prevY = player.y;
            } else {
                pe.prevX = pe.entity.x; pe.prevY = pe.entity.y;
            }
            pe.targetX = player.x;
            pe.targetY = player.y;
            pe.interpStart = this.time.now;
            if (isSelf) this.hud.kills?.setText(`Kills ${player.kills}`);
        });

        // First-paint prime: listen/onChange only fire on future changes.
        if (player.state === STATE_INVULN) {
            ring.setVisible(true);
            ringTween.resume();
            if (isSelf) this.selfInvulnEndsAt = this.time.now + INVULN_DURATION;
        }
        if (isSelf) this.hud.kills?.setText(`Kills ${player.kills ?? 0}`);
    }

    private onPlayerRemove(sessionId: string): void {
        const pe = this.playerEntities[sessionId];
        if (!pe) return;
        this.destroyPlayerEntity(pe);
        delete this.playerEntities[sessionId];
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

        const entity = this.add.arc(ball.x, ball.y, BALL_RADIUS, 0, 360, false, color);
        // White outline on own bullets — subtle cue these can't hit you.
        if (ball.ownerSessionId === this.room.sessionId) {
            entity.setStrokeStyle(1.5, 0xFFFFFF, 1);
        }
        this.ballEntities.set(ball, entity);
        $(ball).onChange(() => { entity.x = ball.x; entity.y = ball.y; });
    }

    private onBallRemove(ball: any): void {
        this.ballEntities.get(ball)?.destroy();
        this.ballEntities.delete(ball);
    }

    /** Cheap radial particle burst: 6 small circles tween outward + fade. */
    private spawnExplosion(x: number, y: number, color: number): void {
        const N = 6;
        for (let i = 0; i < N; i++) {
            const angle = (i / N) * Math.PI * 2;
            const shard = this.add.circle(x, y, 3, color, 1);
            const dx = Math.cos(angle) * 28;
            const dy = Math.sin(angle) * 28;
            this.tweens.add({
                targets: shard,
                x: x + dx,
                y: y + dy,
                alpha: 0,
                scale: 0.5,
                duration: 300,
                ease: 'Cubic.easeOut',
                onComplete: () => shard.destroy(),
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
        // Screen-space UI: stays on-screen as the camera follows self.
        this.joystickBase.setScrollFactor(0);
        this.joystickThumb = this.add.circle(0, 0, THUMB_RADIUS, Palette.textSecondary, 0.55);
        this.joystickThumb.setDepth(1001);
        this.joystickThumb.setScrollFactor(0);

        this.joystick = this.rexVirtualJoyStick.add(this, {
            x: 0, y: 0, radius: BASE_RADIUS,
            base: this.joystickBase, thumb: this.joystickThumb,
            dir: '4dir', // L/R and U/D mutually exclusive, matches server handler
            forceMin: 8, // dead zone (px)
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

        this.inputPayload.left = this.joystick.left || leftKey;
        this.inputPayload.right = this.joystick.right || rightKey;
        this.inputPayload.up = this.joystick.up || upKey;
        this.inputPayload.down = this.joystick.down || downKey;

        this.room.send(0, this.inputPayload);

        // Per-frame interp: players lerp prev→target over INTERP_DURATION.
        // Decouples render from patch rate so the camera lerp has a smooth
        // target. Bullets skip interp to keep ricochets honest.
        const now = this.time.now;
        for (const sid of Object.keys(this.playerEntities)) {
            const pe = this.playerEntities[sid];
            const t = Math.min(1, (now - pe.interpStart) / INTERP_DURATION);
            const x = pe.prevX + (pe.targetX - pe.prevX) * t;
            const y = pe.prevY + (pe.targetY - pe.prevY) * t;
            pe.entity.x = x; pe.entity.y = y;
            pe.ring.x = x;   pe.ring.y = y;
            pe.label.x = x;  pe.label.y = y - PLAYER_SIZE;
        }

        // Invuln countdown from the client-side snapshot taken at the last
        // STATE_ALIVE→STATE_INVULN transition (no server streaming needed).
        if (this.hud.invuln) {
            const remain = Math.max(0, this.selfInvulnEndsAt - this.time.now);
            this.hud.invuln.setText(remain > 0
                ? `Invuln ${(remain / 1000).toFixed(1)}s`
                : 'Invuln --');
        }
    }
}
