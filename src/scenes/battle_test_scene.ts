import Phaser from "phaser";
import { Room, Client } from "colyseus.js";

export class BattleTestScene extends Phaser.Scene {
    room: Room;
    playerEntities: { [sessionId: string]: Phaser.GameObjects.Rectangle } = {};
    ballEntities: { [key: number]: Phaser.GameObjects.Arc } = {};
    debugFPS: Phaser.GameObjects.Text;
    inputPayload = {
        left: false,
        right: false,
        up: false,
        down: false,
    };

    constructor() {
        super({ key: "battle_test" });
    }

    async create() {
        this.debugFPS = this.add.text(4, 4, "", { color: "#ff0000", });
        this.add.text(0, 40, "Back")
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", () => {
                this.game.scene.stop("battle_test")
                this.game.scene.run("main")
            });

        await this.connect();
        this.room.state.players.onAdd((player, sessionId) => {
            const entity = this.add.rectangle(player.x, player.y, 20, 20, 0);
            this.playerEntities[sessionId] = entity;

            player.onChange(() => {
                entity.x = player.x;
                entity.y = player.y;
            });
        });

        this.room.state.players.onRemove((player, sessionId) => {
            const entity = this.playerEntities[sessionId];
            if (entity) {
                entity.destroy();
                delete this.playerEntities[sessionId]
            }
        });

        this.room.state.balls.onAdd((ball, key) => {
            const entity = this.add.arc(ball.x, ball.y, 5, 0, 360, false, 0);
            this.ballEntities[key] = entity;

            ball.onChange(() => {
                entity.x = ball.x;
                entity.y = ball.y;
            });
        });
        this.room.state.balls.onRemove((ball, key) => {
            const entity = this.ballEntities[key];
            if (entity) {
                entity.destroy();
                delete this.ballEntities[key];
            }
        });

        this.cameras.main.setBounds(0, 0, 375, 812);

        this.events.once("shutdown", () => {
            this.room.leave();
            this.room = undefined;
            this.playerEntities = {};
        });
    }

    async connect() {
        const connectionStatusText = this.add
            .text(0, 0, "Trying to connect with the server...")
            .setStyle({ color: "#ff0000" })
            .setPadding(4);
        const role = this.registry.get('roleLocal');
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            
            this.room = await client.joinOrCreate(startBattleRes.roomType,
                { openId: role.openId, zoneId: role.zoneId });
            connectionStatusText.destroy();
        } catch (e) {
            connectionStatusText.text = "Could not connect with the server.";
        }
    }

    update(time: number, delta: number): void {
        if (!this.room) {
            return;
        }
        let pointer = this.input.activePointer;
        this.inputPayload.left = pointer.isDown && pointer.position.x < pointer.downX;
        this.inputPayload.right = pointer.isDown && pointer.position.x > pointer.downX;
        this.inputPayload.up = pointer.isDown && pointer.position.y < pointer.downY;
        this.inputPayload.down = pointer.isDown && pointer.position.y > pointer.downY;
        this.room.send(0, this.inputPayload);

        this.debugFPS.text = `Frame rate: ${this.game.loop.actualFps}`;
    }
}
