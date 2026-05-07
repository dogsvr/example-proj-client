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
// Only the values the client has to reason about locally live here.
const MAP_W = 800;
const MAP_H = 1200;
const INVULN_DURATION = 2500;     // must match server
const PLAYER_SIZE = 20;
const BALL_RADIUS = 5;
const STATE_INVULN = 1;

// 8 distinct high-contrast colours for up to MAX_PLAYERS=8 on server. The
// server assigns each player a stable `colorIdx`; every client uses the
// same array so everybody sees the same colour for the same player. Self
// gets a white outline and "YOU" label on top of its palette colour.
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

// CSS hex mirrors of PLAYER_PALETTE for the head labels. Keeping the
// name-tag colour in sync with the body means a glance at any player
// groups their bullets + label + body as the same entity.
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
    onChangeUnsub?: () => void;
    onStateListenUnsub?: () => void;
};

/**
 * State-sync battle: server-authoritative Matter physics, client renders state
 * and forwards input. Map is larger than the viewport; camera follows self.
 *
 * Each player is assigned a stable `colorIdx` by the server so every client
 * sees a consistent colour for the same player. Self additionally gets a
 * white outline + "YOU" label; others get "P<n>" labels. Bullets are
 * coloured by their owner's palette slot, so you can tell at a glance
 * whose projectile is coming at you.
 */
export class StateSyncBattleScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    rexVirtualJoyStick!: VirtualJoyStickPlugin;
    room: Room;
    playerEntities: { [sessionId: string]: PlayerEntity } = {};
    // Key by the Ball schema instance, not by numeric index: ArraySchema's
    // onAdd gives insertion ordinal, onRemove gives shifting array index —
    // the two can't be correlated by number.
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

    private selfInvulnEndsAt: number = 0;   // scene-clock ms (this.time.now)

    // Shutdown gate: Colyseus state callbacks can fire asynchronously after
    // scene.stop() is called (room.leave takes a tick to propagate). Without
    // this flag, onPlayerAdd can create a new rect right after shutdown and
    // leave a stray GameObject behind the next time the scene starts.
    private isShuttingDown = false;

    constructor() { super({ key: 'state_sync_battle' }); }

    async create() {
        // create() runs on each scene.start() / .switch(); reset per-instance
        // state explicitly because Phaser reuses Scene instances by key.
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

        // Collection callbacks go through `getStateCallbacks(room)`; wait for
        // the first onStateChange since joinOrCreate resolves before state arrives.
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

            // Defensive cleanup: each step is wrapped in try/catch because
            // Phaser 4's scene sub-systems tear down in an order we don't
            // control — an early failure (e.g. `cameras.main.stopFollow()`
            // after CameraManager already nulled the Camera) used to abort
            // the rest of the handler and leave ghost entities behind on
            // the next scene enter.
            try { this.scale.off(Phaser.Scale.Events.RESIZE, onResize); } catch {}
            // Intentionally NOT calling `this.cameras.main.stopFollow()`:
            // the CameraManager may have already disposed the Camera by
            // the time our SHUTDOWN handler runs, and the framework
            // cleans up camera follow state on its own.
            try { this.room?.leave(); } catch {}
            this.room = undefined;

            // Phaser's DisplayList.shutdown destroys everything on the scene
            // list automatically. The explicit destroys below cover tween-
            // held target refs that wouldn't otherwise be released cleanly
            // across scene restarts. destroy() is idempotent on Phaser GOs.
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

            // Virtual joystick holds refs to base+thumb via the rex plugin —
            // destroy() detaches the plugin's pointer listeners; the orphan
            // visuals are then collected by DisplayList.shutdown.
            try { this.joystick?.destroy(); } catch {}

            this.joystickPointerId = null;
            this.selfInvulnEndsAt = 0;
        });
    }

    async connect() {
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            // Identity lives in the ticket (consumed in onAuth); never pass openId/zoneId.
            this.room = await client.joinOrCreate(startBattleRes.roomType, {
                ticket: startBattleRes.ticket,
            });
        } catch (e) {
            // HUD no longer has a status widget for state-sync; leave the
            // scene empty — the next Back will take user back to main.
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
            entity.setStrokeStyle(3, 0xFFFFFF, 1);   // extra "this is you" tell
            this.cameras.main.startFollow(entity, true, 0.1, 0.1);
        }

        // Head-label: always visible, colour-matched to body so you group
        // label + body + bullets by colour at a glance. "YOU" for self,
        // "P<n>" for others (1-indexed based on colorIdx).
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

        // Invuln ring: green stroked circle that pulses; attached to the
        // same position as entity, toggled by player.state.
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

        this.playerEntities[sessionId] = { entity, ring, ringTween, label, colorIdx, isSelf };

        // IMPORTANT: listen('state', ...) MUST fire before onChange() updates
        // entity.x/y, so the explosion plays at the death position. Colyseus
        // 0.17 applies fields in declaration order and fires listens inline;
        // the server-side Player schema declares `state` before `x/y`.
        $(player).listen('state', (newVal: number, oldVal: number | undefined) => {
            // oldVal is undefined on first-ever delivery (onAdd initial state) —
            // treat that as no transition; a new player is already invuln.
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

        $(player).onChange(() => {
            entity.x = player.x; entity.y = player.y;
            ring.x = player.x;   ring.y = player.y;
            label.x = player.x;  label.y = player.y - PLAYER_SIZE;
            if (isSelf) this.hud.kills?.setText(`Kills ${player.kills}`);
        });

        // First-paint: listen/onChange only fire on future changes, so the
        // initial ring visibility and kills text need a one-off prime here.
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
        // Stop tween first — Phaser tweens hold a hard ref to their target,
        // destroying the target while the tween is active leaves a zombie
        // tween that re-creates a listener on next update tick.
        pe.ringTween.stop();
        pe.ringTween.remove();
        pe.ring.destroy();
        pe.label.destroy();
        pe.entity.destroy();
    }

    private onBallAdd(ball: any, state: any, $: any): void {
        if (this.isShuttingDown) return;

        // Colour the ball by its owner's palette slot. If the owner already
        // left (orphan bullet), fall back to a neutral grey — the server
        // keeps these bullets inert anyway (no kill), grey signals "stray".
        const owner = state.players.get(ball.ownerSessionId);
        const color = owner
            ? PLAYER_PALETTE[(owner.colorIdx ?? 0) % PLAYER_PALETTE.length]
            : Palette.textSecondary;

        const entity = this.add.arc(ball.x, ball.y, BALL_RADIUS, 0, 360, false, color);
        // Tiny white outline on my own bullets — subtle cue that you can't
        // be hit by these. Matches the white outline on self's rect.
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
        // Joystick is in screen space (UI), not world space — pin its depth
        // above entities and its scroll factor to 0 so it stays on-screen
        // when the camera follows self around the larger world.
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

        // ⚠️ rex-plugins TouchCursor subscribes to `base.on('pointerdown')`,
        // but our base is at (0,0) + invisible when Phaser fires pointerdown,
        // so the plugin never starts tracking. Feed the pointer in manually
        // via its onKeyDownStart method. Not in VirtualJoyStick.d.ts — the
        // cast is the one place we reach past the public API.
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
        // setVisible(false) also disables → clears TouchCursor's captured
        // pointer and zeros joystick.{left,right,up,down}.
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

        // Invuln countdown: driven from the client clock snapshot taken at
        // the last STATE_ALIVE→STATE_INVULN transition, so we don't need
        // the server to stream a remaining-time field every tick.
        if (this.hud.invuln) {
            const remain = Math.max(0, this.selfInvulnEndsAt - this.time.now);
            this.hud.invuln.setText(remain > 0
                ? `Invuln ${(remain / 1000).toFixed(1)}s`
                : 'Invuln --');
        }
    }
}
