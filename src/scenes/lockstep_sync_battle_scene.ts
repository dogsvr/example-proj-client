import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import { Room, Client } from '@colyseus/sdk';
import { BodyType } from 'matter';
import { Palette, SceneBG } from '../theme';
import { paintGradientBackground } from '../ui/background';
import { createBattleHud, type BattleHud } from '../ui/battle_hud';

type Action = { vkey: any; args: any; playerId: any };
class Frame {
    frameId: number = 0;
    actions: Action[] = [];
}

/**
 * Lockstep (deterministic frame-sync) battle scene.
 */
export class LockstepSyncBattleScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    room: Room;
    playerEntities: { [sessionId: string]: Phaser.GameObjects.GameObject } = {};
    frameArray: Frame[] = [];
    currFrameId = 0;
    frameFrequency = 0;
    private hud!: BattleHud;
    private walls: BodyType[] = [];

    constructor() { super({ key: 'lockstep_sync_battle' }); }

    async create() {
        paintGradientBackground(this, SceneBG.lockstep.top, SceneBG.lockstep.bottom);
        this.hud = createBattleHud(this, () => {
            this.scene.switch('main');
            this.scene.stop('lockstep_sync_battle');
        });
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        await this.connect();
        this.initPhysics();

        this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
            if (!pointer.isDown) return;
            const deltaX = pointer.x - pointer.downX;
            const deltaY = pointer.y - pointer.downY;
            const dir = Math.abs(deltaX) > Math.abs(deltaY)
                ? (deltaX > 0 ? 'left' : 'right')
                : (deltaY > 0 ? 'down' : 'up');
            this.room.send('submitAction', { vkey: 'move', args: [dir], playerId: this.room.sessionId });
        });
        this.input.on('pointerup', () => {
            this.room.send('submitAction', { vkey: 'moveStop', args: [], playerId: this.room.sessionId });
        });

        const onResize = () => {
            this.hud.relayout();
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

    initPhysics() {
        this.matter.world.disableGravity();
        this.rebuildWalls();
    }

    /** Rebuild 4 enclosing static walls sized to the current viewport. */
    private rebuildWalls() {
        for (const body of this.walls) this.matter.world.remove(body);
        this.walls = [];

        const w = this.scale.width, h = this.scale.height;
        const thick = 1000; // wider than viewport so fast bodies can't tunnel out
        const make = (x: number, y: number, ww: number, wh: number) => {
            this.walls.push(this.matter.add.rectangle(x, y, ww, wh, { isStatic: true }));
        };
        make(-thick / 2, h / 2, thick, h + thick * 2);
        make(w + thick / 2, h / 2, thick, h + thick * 2);
        make(w / 2, -thick / 2, w + thick * 2, thick);
        make(w / 2, h + thick / 2, w + thick * 2, thick);
    }

    async connect() {
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            // Identity is carried by the one-time ticket; do not pass openId/zoneId.
            this.room = await client.joinOrCreate(startBattleRes.roomType, {
                ticket: startBattleRes.ticket,
            });
            this.hud.status.setText('Connected');

            this.room.onMessage(0, (message) => {
                this.frameArray = message.frameArray;
                this.frameFrequency = message.frameFrequency;
            });
            this.room.onMessage('broadcastFrame', (message) => {
                this.frameArray.push(message);
            });
        } catch (e) {
            this.hud.status.setText('Connection failed');
        }
    }

    update(): void {
        this.hud.fps.setText(`FPS ${Math.round(this.game.loop.actualFps)}`);
        if (this.frameFrequency <= 0) return;
        let execFrameCount = 0;
        while (execFrameCount < 4 && this.currFrameId < this.frameArray.length) {
            const frame = this.frameArray[this.currFrameId];
            if (frame) this.execFrame(frame);
            ++this.currFrameId;
            ++execFrameCount;
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

        for (const entity of Object.values(this.playerEntities) as any[]) {
            if (!entity || !entity['direction']) continue;
            let x = entity.body.position.x;
            let y = entity.body.position.y;
            const speed = 4; // lockstep: fixed step — MUST NOT multiply by dt
            if (entity['direction'] === 'left') x += speed;
            else if (entity['direction'] === 'right') x -= speed;
            else if (entity['direction'] === 'up') y -= speed;
            else if (entity['direction'] === 'down') y += speed;
            this.matter.body.setPosition(entity.body as BodyType, { x, y });
        }
    }
}
