import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import { Room, Client } from '@colyseus/sdk';
import { BodyType } from 'matter';
import { Palette, Radius, Spacing, FontSize, HexText, SceneBG, textStyle } from '../theme';
import { paintGradientBackground } from '../ui/background';

type Action = { vkey: any; args: any; playerId: any };
class Frame {
    frameId: number = 0;
    actions: Action[] = [];
}

/**
 * Lockstep (deterministic frame-sync) battle scene.
 *
 * UI changes vs. the original:
 *   - Lavender dusk gradient background (distinct from main mint and
 *     state-sync apricot).
 *   - HUD card at the top replacing bare FPS text and bare Back text.
 *   - Matter physics walls are now rebuilt from `this.scale.width/height`
 *     and also re-built on resize so that the 20×20 player bodies always
 *     stay bounded to the visible area. Originally the wall positions used
 *     `this.game.config.width/height` which was a fixed 375 × 812 and
 *     would have left physics bodies drifting into off-screen space on
 *     larger viewports after switching to RESIZE scale mode.
 */
export class LockstepSyncBattleScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    room: Room;
    playerEntities: { [sessionId: string]: Phaser.GameObjects.GameObject } = {};
    frameArray: Frame[] = [];
    currFrameId = 0;
    frameFrequency = 0;
    debugFPS: Phaser.GameObjects.Text;
    statusText: Phaser.GameObjects.Text;
    private hud: any;
    private walls: { body: BodyType; which: 'L' | 'R' | 'T' | 'B' }[] = [];

    constructor() {
        super({ key: 'lockstep_sync_battle' });
    }

    async create() {
        paintGradientBackground(this, SceneBG.lockstep.top, SceneBG.lockstep.bottom);
        this.buildHud();
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        await this.connect();
        this.initPhysics();

        this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
            if (pointer.isDown) {
                const deltaX = pointer.x - pointer.downX;
                const deltaY = pointer.y - pointer.downY;
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    if (deltaX > 0) {
                        this.room.send('submitAction', { vkey: 'move', args: ['left'], playerId: this.room.sessionId });
                    } else {
                        this.room.send('submitAction', { vkey: 'move', args: ['right'], playerId: this.room.sessionId });
                    }
                } else {
                    if (deltaY > 0) {
                        this.room.send('submitAction', { vkey: 'move', args: ['down'], playerId: this.room.sessionId });
                    } else {
                        this.room.send('submitAction', { vkey: 'move', args: ['up'], playerId: this.room.sessionId });
                    }
                }
            }
        });
        this.input.on('pointerup', () => {
            this.room.send('submitAction', { vkey: 'moveStop', args: [], playerId: this.room.sessionId });
        });

        const onResize = () => {
            this.relayoutHud();
            this.rebuildWalls();
        };
        this.scale.on(Phaser.Scale.Events.RESIZE, onResize);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
            this.room?.leave();
            this.room = undefined;
            this.playerEntities = {};
            this.frameArray = [];
            this.currFrameId = 0;
            this.frameFrequency = 0;
            this.walls = [];
        });
    }

    private buildHud() {
        // White HUD with navy text, navy Back button with white text.
        // 12.6:1 contrast on every element (AAA) with no layering /
        // shadow / alpha gimmicks — the earlier "white-card + drop
        // shadow + glyph shadow" revision had a display-list z-order
        // bug that painted the card over the text. See
        // state_sync_battle_scene.buildHud() for the full debug trail.
        this.debugFPS = this.add.text(0, 0, 'FPS --',
            textStyle({ size: FontSize.caption, color: HexText.primary, weight: 'bold' }));
        this.statusText = this.add.text(0, 0, 'Connecting…',
            textStyle({ size: FontSize.caption, color: HexText.primary }));

        const backBg = new RoundRectangle(this, 0, 0, 2, 2, Radius.btn, Palette.textPrimary);
        this.add.existing(backBg);
        const backText = this.add.text(0, 0, '← Back',
            textStyle({ size: FontSize.caption, color: HexText.white, weight: 'bold' }));
        // Explicit 44×44 minimum per UI Design Rules: touch hit-zones must be
        // at least 44×44 px. See state_sync_battle_scene.ts for the same
        // rationale.
        const backBtn = this.rexUI.add
            .label({
                width: 88,
                height: 44,
                background: backBg,
                text: backText,
                align: 'center',
                space: { left: Spacing.md, right: Spacing.md },
            })
            .setInteractive({ useHandCursor: true });
        backBtn.on('pointerdown', () => {
            // See state_sync_battle_scene for why we use switch + stop here
            // instead of fadeOut → stop + run.
            this.scene.switch('main');
            this.scene.stop('lockstep_sync_battle');
        });

        // Opaque white card, darker stroke, depth -1 so it never paints
        // over the text / button children. See state_sync_battle_scene
        // for why setDepth(-1) is needed despite rexUI Sizer's
        // `addBackground()` (it only handles layout, not z-order).
        const hudBg = new RoundRectangle(this, 0, 0, 2, 2, Radius.btn, Palette.cardBg, 1);
        hudBg.setStrokeStyle(1.5, Palette.cardStroke, 1);
        hudBg.setDepth(-1);
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

    initPhysics() {
        this.matter.world.disableGravity();
        this.rebuildWalls();
    }

    /**
     * Recreate the 4 enclosing static walls sized to the current viewport.
     * Called on initial create and on every scale `resize` event so physics
     * bodies follow a resizing browser window / device rotation.
     */
    private rebuildWalls() {
        // Remove previous walls.
        for (const { body } of this.walls) {
            this.matter.world.remove(body);
        }
        this.walls = [];

        const w = this.scale.width;
        const h = this.scale.height;
        const thick = 1000; // far wider than the viewport so fast bodies can't tunnel out
        const make = (x: number, y: number, ww: number, wh: number, which: 'L' | 'R' | 'T' | 'B') => {
            const body = this.matter.add.rectangle(x, y, ww, wh, { isStatic: true });
            this.walls.push({ body, which });
        };
        make(-thick / 2, h / 2, thick, h + thick * 2, 'L');
        make(w + thick / 2, h / 2, thick, h + thick * 2, 'R');
        make(w / 2, -thick / 2, w + thick * 2, thick, 'T');
        make(w / 2, h + thick / 2, w + thick * 2, thick, 'B');
    }

    async connect() {
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            // Identity is carried by the one-time ticket issued by battlesvr
            // (consumed in Colyseus onAuth). Do not pass openId/zoneId here --
            // server must not trust client-supplied identity fields.
            this.room = await client.joinOrCreate(startBattleRes.roomType, {
                ticket: startBattleRes.ticket,
            });
            this.statusText.setText('Connected');

            this.room.onMessage(0, (message) => {
                this.frameArray = message.frameArray;
                this.frameFrequency = message.frameFrequency;
            });
            this.room.onMessage('broadcastFrame', (message) => {
                this.frameArray.push(message);
            });
        } catch (e) {
            this.statusText.setText('Connection failed');
        }
    }

    update(): void {
        this.debugFPS.setText(`FPS ${Math.round(this.game.loop.actualFps)}`);
        if (this.frameFrequency > 0) {
            let execFrameCount = 0;
            while (execFrameCount < 4) {
                if (this.currFrameId >= this.frameArray.length) break;
                const frame = this.frameArray[this.currFrameId];
                if (frame) this.execFrame(frame);
                ++this.currFrameId;
                ++execFrameCount;
            }
        }
    }

    execFrame(frame: Frame) {
        frame.actions.forEach((action) => {
            switch (action.vkey) {
                case 'join': {
                    const entity = this.matter.add.gameObject(
                        this.add.rectangle(action.args[0], action.args[1], 20, 20, Palette.textPrimary),
                        { frictionAir: 0 },
                    );
                    this.playerEntities[action.playerId] = entity;
                    break;
                }
                case 'move': {
                    const entity = this.playerEntities[action.playerId];
                    if (entity) (entity as any)['direction'] = action.args[0];
                    break;
                }
                case 'moveStop': {
                    const entity = this.playerEntities[action.playerId];
                    if (entity) (entity as any)['direction'] = undefined;
                    break;
                }
                case 'leave': {
                    const entity = this.playerEntities[action.playerId];
                    if (entity) {
                        entity.destroy();
                        delete this.playerEntities[action.playerId];
                    }
                    break;
                }
            }
        });

        for (const sessionId in this.playerEntities) {
            const entity = this.playerEntities[sessionId] as any;
            if (!entity) continue;
            if (!entity['direction']) continue;
            let x = entity.body.position.x;
            let y = entity.body.position.y;
            const speed = 4;
            if (entity['direction'] === 'left') x += speed;
            else if (entity['direction'] === 'right') x -= speed;
            else if (entity['direction'] === 'up') y -= speed;
            else if (entity['direction'] === 'down') y += speed;
            this.matter.body.setPosition(entity.body as BodyType, { x, y });
        }
    }
}
