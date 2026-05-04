import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import { Room, Client, getStateCallbacks } from '@colyseus/sdk';
import { Palette, Radius, Spacing, FontSize, HexText, SceneBG } from '../theme';
import { paintGradientBackground } from '../ui/background';

/**
 * State-sync battle scene (server-authoritative, every entity broadcast).
 *
 * The gameplay pipeline (Colyseus Room, rectangle/arc entity sync) is
 * unchanged from the original implementation — see inline comments at
 * `onStateChange.once` for the v4 schema-callbacks gotcha.
 *
 * UI changes vs. the original:
 *   - Apricot warm-sunlight gradient background (visually distinct from
 *     main menu's mint and lockstep's lavender) so scene switches are
 *     visually obvious.
 *   - Top HUD bar is a rexUI horizontal Sizer with rounded card background,
 *     replacing the bare "FPS: xxx" text + bare "Back" text.
 *   - Layout follows `this.scale.width/height` and rebuilds on resize —
 *     previously hard-coded to 375 × 812 via `cameras.main.setBounds(0,0,375,812)`.
 */
export class StateSyncBattleScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    room: Room;
    playerEntities: { [sessionId: string]: Phaser.GameObjects.Rectangle } = {};
    // ArraySchema's onAdd/onRemove in @colyseus/schema v4 use different key
    // semantics: onAdd gives insertion ordinal (monotonic), onRemove gives
    // current array index (shifts left when items are removed). Keying by
    // either number makes them impossible to correlate, so we key entities by
    // the Ball schema instance itself, which is the same object reference in
    // both callbacks.
    ballEntities: Map<object, Phaser.GameObjects.Arc> = new Map();
    debugFPS: Phaser.GameObjects.Text;
    statusText: Phaser.GameObjects.Text;
    private hud: any;
    inputPayload = { left: false, right: false, up: false, down: false };

    constructor() {
        super({ key: 'state_sync_battle' });
    }

    async create() {
        paintGradientBackground(this, SceneBG.state.top, SceneBG.state.bottom);
        this.buildHud();
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        await this.connect();

        // colyseus 0.17 + @colyseus/schema v4: collection callbacks are no
        // longer methods on MapSchema / ArraySchema themselves. They are
        // accessed through a proxy returned by getStateCallbacks(room).
        //
        //   const $ = getStateCallbacks(room)
        //   $(collection).onAdd((item, key) => ...)    -- MapSchema / ArraySchema
        //   $(collection).onRemove((item, key) => ...)
        //   $(schemaInstance).onChange(() => ...)      -- whole-schema change
        //   $(schemaInstance).listen("field", (v, prev) => ...)
        //
        // Also: `await client.joinOrCreate()` resolves before the server's
        // initial state arrives. `room.state.players` is undefined at that
        // point. We must wait for the first `onStateChange` (which fires after
        // the schema reflection + initial state snapshot) before registering
        // collection callbacks.
        this.room.onStateChange.once((state) => {
            const $ = getStateCallbacks(this.room);

            $(state.players).onAdd((player, sessionId) => {
                const entity = this.add.rectangle(player.x, player.y, 20, 20, Palette.textPrimary);
                this.playerEntities[sessionId] = entity;
                $(player).onChange(() => {
                    entity.x = player.x;
                    entity.y = player.y;
                });
            });
            $(state.players).onRemove((_player, sessionId) => {
                const entity = this.playerEntities[sessionId];
                if (entity) {
                    entity.destroy();
                    delete this.playerEntities[sessionId];
                }
            });
            $(state.balls).onAdd((ball) => {
                const entity = this.add.arc(ball.x, ball.y, 5, 0, 360, false, Palette.accent);
                this.ballEntities.set(ball, entity);
                $(ball).onChange(() => {
                    entity.x = ball.x;
                    entity.y = ball.y;
                });
            });
            $(state.balls).onRemove((ball) => {
                const entity = this.ballEntities.get(ball);
                if (entity) {
                    entity.destroy();
                    this.ballEntities.delete(ball);
                }
            });
        });

        const onResize = () => this.relayoutHud();
        this.scale.on(Phaser.Scale.Events.RESIZE, onResize);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
            this.room?.leave();
            this.room = undefined;
            this.playerEntities = {};
            this.ballEntities = new Map();
        });
    }

    private buildHud() {
        this.debugFPS = this.add.text(0, 0, 'FPS --', {
            color: HexText.primary,
            fontSize: `${FontSize.caption}px`,
            fontFamily: 'sans-serif',
        });
        this.statusText = this.add.text(0, 0, 'Connecting…', {
            color: HexText.secondary,
            fontSize: `${FontSize.caption}px`,
            fontFamily: 'sans-serif',
        });

        const backBg = new RoundRectangle(this, 0, 0, 2, 2, Radius.btn, Palette.accent);
        this.add.existing(backBg);
        const backText = this.add.text(0, 0, '← Back', {
            color: HexText.white,
            fontSize: `${FontSize.caption}px`,
            fontFamily: 'sans-serif',
            fontStyle: '600',
        });
        const backBtn = this.rexUI.add
            .label({
                background: backBg,
                text: backText,
                space: { left: Spacing.md, right: Spacing.md, top: Spacing.xs, bottom: Spacing.xs },
            })
            .setInteractive({ useHandCursor: true });
        backBtn.on('pointerdown', () => {
            // Tear down the battle room synchronously so leaving is instant,
            // then switch back. We use `scene.switch` (not stop+run) so main
            // wakes up deterministically through its WAKE handler which
            // re-fades its camera in — avoids any race with this scene's
            // own camera FX during the transition.
            this.scene.switch('main');
            this.scene.stop('state_sync_battle');
        });

        const hudBg = new RoundRectangle(this, 0, 0, 2, 2, Radius.btn, Palette.cardBg, 0.92);
        hudBg.setStrokeStyle(1, Palette.cardStroke, 1);
        this.add.existing(hudBg);

        this.hud = this.rexUI.add
            .sizer({
                orientation: 'horizontal',
                space: { left: Spacing.md, right: Spacing.md, top: Spacing.sm, bottom: Spacing.sm, item: Spacing.md },
            })
            .addBackground(hudBg)
            .add(this.debugFPS, { align: 'center' })
            .addSpace()
            .add(this.statusText, { align: 'center' })
            .addSpace()
            .add(backBtn, { align: 'center' });

        this.relayoutHud();
    }

    private relayoutHud() {
        const { width } = this.scale;
        const hudWidth = Math.min(width - Spacing.lg * 2, 500);
        this.hud.setMinSize(hudWidth, 0);
        this.hud.layout();
        this.hud.setPosition(width / 2, Spacing.lg + this.hud.height / 2);
    }

    async connect() {
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            // Server is authoritative on identity: the ticket (issued by
            // battlesvr in the BATTLE_START_BATTLE response) is consumed in
            // Colyseus onAuth to recover {gid, openId, zoneId}. We deliberately
            // do NOT pass openId/zoneId here to avoid letting clients spoof.
            this.room = await client.joinOrCreate(startBattleRes.roomType, {
                ticket: startBattleRes.ticket,
            });
            this.statusText.setText('Connected');
        } catch (e) {
            this.statusText.setText('Connection failed');
        }
    }

    update(): void {
        if (!this.room) return;
        const pointer = this.input.activePointer;
        this.inputPayload.left = pointer.isDown && pointer.position.x < pointer.downX;
        this.inputPayload.right = pointer.isDown && pointer.position.x > pointer.downX;
        this.inputPayload.up = pointer.isDown && pointer.position.y < pointer.downY;
        this.inputPayload.down = pointer.isDown && pointer.position.y > pointer.downY;
        this.room.send(0, this.inputPayload);
        this.debugFPS.setText(`FPS ${Math.round(this.game.loop.actualFps)}`);
    }
}
