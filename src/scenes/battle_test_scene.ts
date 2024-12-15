import Phaser from "phaser";
import { Room, Client } from "colyseus.js";

export class BattleTestScene extends Phaser.Scene {
    room: Room;
    playerEntities: { [sessionId: string]: Phaser.Types.Physics.Arcade.ImageWithDynamicBody } = {};
    debugFPS: Phaser.GameObjects.Text;
    cursorKeys: Phaser.Types.Input.Keyboard.CursorKeys;
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
        this.cursorKeys = this.input.keyboard.createCursorKeys();
        this.debugFPS = this.add.text(4, 4, "", { color: "#ff0000", });
        this.add.text(0, 500, "Back")
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", () => {
                this.game.scene.stop("battle_test")
                this.game.scene.run("main")
            });

        await this.connect();
        this.room.state.players.onAdd((player, sessionId) => {
            const entity = this.physics.add.image(player.x, player.y, '');
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

        this.cameras.main.setBounds(0, 0, 800, 600);

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
            .setPadding(4)
        const client = new Client(`ws://${window.location.hostname}:2567`);
        try {
            this.room = await client.joinOrCreate("battle_test_room", {});
            connectionStatusText.destroy();

        } catch (e) {
            connectionStatusText.text = "Could not connect with the server.";
        }
    }

    update(time: number, delta: number): void {
        if (!this.room) {
            return;
        }
        this.inputPayload.left = this.cursorKeys.left.isDown;
        this.inputPayload.right = this.cursorKeys.right.isDown;
        this.inputPayload.up = this.cursorKeys.up.isDown;
        this.inputPayload.down = this.cursorKeys.down.isDown;
        this.room.send(0, this.inputPayload);

        this.debugFPS.text = `Frame rate: ${this.game.loop.actualFps}`;
    }
}
