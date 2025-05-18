import Phaser from "phaser";
import { Room, Client } from "colyseus.js";
import { BodyType } from "matter";

type Action = {
    vkey: any;
    args: any;
    playerId: any;
};
class Frame {
    frameId: number = 0;
    actions: Action[] = [];
};

export class LockstepSyncBattleScene extends Phaser.Scene {
    room: Room;
    playerEntities: { [sessionId: string]: Phaser.GameObjects.GameObject } = {};
    frameArray: Frame[] = [];
    currFrameId = 0;
    frameFrequency = 0;
    debugFPS: Phaser.GameObjects.Text;

    constructor() {
        super({ key: "lockstep_sync_battle" });
    }

    async create() {
        this.debugFPS = this.add.text(4, 4, "", { color: "#ff0000", });
        this.add.text(0, 40, "Back")
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", () => {
                this.game.scene.stop("lockstep_sync_battle")
                this.game.scene.run("main")
            });

        await this.connect();
        this.initPhysics();

        this.input.on('pointermove', (pointer) => {
            if (pointer.isDown) {
                let deltaX = pointer.x - pointer.downX;
                let deltaY = pointer.y - pointer.downY;
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    if (deltaX > 0) {
                        this.room.send("submitAction", { vkey: "move", args: ["left"], playerId: this.room.sessionId });
                    }
                    else {
                        this.room.send("submitAction", { vkey: "move", args: ["right"], playerId: this.room.sessionId });
                    }
                }
                else {
                    if (deltaY > 0) {
                        this.room.send("submitAction", { vkey: "move", args: ["down"], playerId: this.room.sessionId });
                    }
                    else {
                        this.room.send("submitAction", { vkey: "move", args: ["up"], playerId: this.room.sessionId });
                    }
                }
            }
        });
        this.input.on('pointerup', () => {
            this.room.send("submitAction", { vkey: "moveStop", args: [], playerId: this.room.sessionId });
        });

        this.cameras.main.setBounds(0, 0, 375, 812);

        this.events.once("shutdown", () => {
            this.room.leave();
            this.room = undefined;
            this.playerEntities = {};
            this.frameArray = [];
            this.currFrameId = 0;
            this.frameFrequency = 0;
        });
    }

    initPhysics() {
        this.matter.world.disableGravity();
        // create wall
        const wallWidth = 1000;
        const wallHeight = 1000;
        const wallMargin = 0;
        const wallLeft = this.matter.add.rectangle(wallMargin - wallWidth / 2, this.game.config.height as number / 2, wallWidth, wallHeight, { isStatic: true });
        const wallRight = this.matter.add.rectangle(this.game.config.width as number + wallWidth / 2 - wallMargin, this.game.config.height as number / 2, wallWidth, wallHeight, { isStatic: true });
        const wallTop = this.matter.add.rectangle(this.game.config.width as number / 2, wallMargin - wallHeight / 2, wallWidth, wallHeight, { isStatic: true });
        const wallBottom = this.matter.add.rectangle(this.game.config.width as number / 2, this.game.config.height as number + wallHeight / 2 - wallMargin, wallWidth, wallHeight, { isStatic: true });
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

            this.room.onMessage(0, (message) => {
                this.frameArray = message.frameArray;
                this.frameFrequency = message.frameFrequency;
                console.log("frameFrequency", this.frameFrequency);
                console.log("frameArray", this.frameArray.length);
            });
            this.room.onMessage("broadcastFrame", (message) => {
                this.frameArray.push(message);
            });
        } catch (e) {
            connectionStatusText.text = "Could not connect with the server.";
        }
    }

    update(time: number, delta: number): void {
        this.debugFPS.text = `Frame rate: ${this.game.loop.actualFps}`;
        if (this.frameFrequency > 0) {
            let execFrameCount = 0;
            while (execFrameCount < 4) {
                if (this.currFrameId >= this.frameArray.length) {
                    break;
                }
                let frame = this.frameArray[this.currFrameId];
                if (frame) {
                    this.execFrame(frame);
                }
                ++this.currFrameId;
                ++execFrameCount;
            }
        }
    }

    execFrame(frame: Frame) {
        frame.actions.forEach(action => {
            // console.log("exec action:", action);
            switch (action.vkey) {
                case "join": {
                    const entity = this.matter.add.gameObject(
                        this.add.rectangle(action.args[0], action.args[1], 20, 20, 0), { frictionAir: 0 });
                    this.playerEntities[action.playerId] = entity;
                    break;
                }
                case "move": {
                    const entity = this.playerEntities[action.playerId];
                    if (entity) {
                        entity["direction"] = action.args[0];
                    }
                    break;
                }
                case "moveStop": {
                    const entity = this.playerEntities[action.playerId];
                    if (entity) {
                        entity["direction"] = undefined;
                    }
                    break;
                }
                case "leave": {
                    const entity = this.playerEntities[action.playerId];
                    if (entity) {
                        entity.destroy();
                        delete this.playerEntities[action.playerId]
                    }
                    break;
                }
            }
        });

        for (const sessionId in this.playerEntities) {
            const entity = this.playerEntities[sessionId];
            if (!entity) {
                continue;
            }
            if (!entity["direction"]) {
                continue;
            }
            let x = entity.body.position.x;
            let y = entity.body.position.y;
            const speed = 1;
            if (entity["direction"] === "left") {
                x += speed;
            } else if (entity["direction"] === "right") {
                x -= speed;
            } else if (entity["direction"] === "up") {
                y -= speed;
            } else if (entity["direction"] === "down") {
                y += speed;
            }
            this.matter.body.setPosition(entity.body as BodyType, { x: x, y: y });
        }
    }
}
