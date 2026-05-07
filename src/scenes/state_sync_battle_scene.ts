import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import type VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import type VirtualJoyStick from 'phaser4-rex-plugins/plugins/virtualjoystick.js';
import { Room, Client, getStateCallbacks } from '@colyseus/sdk';
import { Palette, Spacing, SceneBG } from '../theme';
import { paintGradientBackground } from '../ui/background';
import { createBattleHud, type BattleHud } from '../ui/battle_hud';

/**
 * State-sync battle scene (server-authoritative, every entity broadcast).
 * Input: floating virtual joystick (touch) + arrow keys / WASD (desktop),
 * merged via OR into inputPayload and sent via `room.send(0, payload)`.
 */
export class StateSyncBattleScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    rexVirtualJoyStick!: VirtualJoyStickPlugin;
    room: Room;
    playerEntities: { [sessionId: string]: Phaser.GameObjects.Rectangle } = {};
    // Key by the Ball schema instance, not by numeric index: ArraySchema's
    // onAdd gives insertion ordinal, onRemove gives shifting array index —
    // the two can't be correlated by number.
    ballEntities: Map<object, Phaser.GameObjects.Arc> = new Map();
    private hud!: BattleHud;
    inputPayload = { left: false, right: false, up: false, down: false };

    private joystick!: VirtualJoyStick;
    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!: {
        W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
        S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    };
    private joystickPointerId: number | null = null;

    constructor() { super({ key: 'state_sync_battle' }); }

    async create() {
        paintGradientBackground(this, SceneBG.state.top, SceneBG.state.bottom);
        this.hud = createBattleHud(this, () => {
            this.scene.switch('main');
            this.scene.stop('state_sync_battle');
        });
        this.setupInput();
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        await this.connect();

        // Collection callbacks go through `getStateCallbacks(room)`; wait for
        // the first onStateChange since joinOrCreate resolves before state arrives.
        this.room.onStateChange.once((state) => {
            const $ = getStateCallbacks(this.room);

            $(state.players).onAdd((player, sessionId) => {
                const entity = this.add.rectangle(player.x, player.y, 20, 20, Palette.textPrimary);
                this.playerEntities[sessionId] = entity;
                $(player).onChange(() => { entity.x = player.x; entity.y = player.y; });
            });
            $(state.players).onRemove((_player, sessionId) => {
                this.playerEntities[sessionId]?.destroy();
                delete this.playerEntities[sessionId];
            });
            $(state.balls).onAdd((ball) => {
                const entity = this.add.arc(ball.x, ball.y, 5, 0, 360, false, Palette.accent);
                this.ballEntities.set(ball, entity);
                $(ball).onChange(() => { entity.x = ball.x; entity.y = ball.y; });
            });
            $(state.balls).onRemove((ball) => {
                this.ballEntities.get(ball)?.destroy();
                this.ballEntities.delete(ball);
            });
        });

        const onResize = () => {
            this.hud.relayout();
            if (this.joystick.visible) this.hideJoystick();
        };
        this.scale.on(Phaser.Scale.Events.RESIZE, onResize);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
            this.room?.leave();
            this.room = undefined;
            this.playerEntities = {};
            this.ballEntities = new Map();
            this.joystickPointerId = null;
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
            this.hud.status.setText('Connected');
        } catch (e) {
            this.hud.status.setText('Connection failed');
        }
    }

    /** Floating virtual joystick + arrow keys / WASD. */
    private setupInput(): void {
        const BASE_RADIUS = 60, THUMB_RADIUS = 25;

        const base = this.add.circle(0, 0, BASE_RADIUS, Palette.textPrimary, 0.10);
        base.setStrokeStyle(2, Palette.textPrimary, 0.22);
        base.setDepth(1000);
        const thumb = this.add.circle(0, 0, THUMB_RADIUS, Palette.textSecondary, 0.55);
        thumb.setDepth(1001);

        this.joystick = this.rexVirtualJoyStick.add(this, {
            x: 0, y: 0, radius: BASE_RADIUS, base, thumb,
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
        if (!this.room) return;
        const leftKey = this.cursors.left.isDown || this.wasd.A.isDown;
        const rightKey = this.cursors.right.isDown || this.wasd.D.isDown;
        const upKey = this.cursors.up.isDown || this.wasd.W.isDown;
        const downKey = this.cursors.down.isDown || this.wasd.S.isDown;

        this.inputPayload.left = this.joystick.left || leftKey;
        this.inputPayload.right = this.joystick.right || rightKey;
        this.inputPayload.up = this.joystick.up || upKey;
        this.inputPayload.down = this.joystick.down || downKey;

        this.room.send(0, this.inputPayload);
        this.hud.fps.setText(`FPS ${Math.round(this.game.loop.actualFps)}`);
    }
}
