import Phaser from "phaser";
import { Room, Client, getStateCallbacks } from "@colyseus/sdk";

export class StateSyncBattleScene extends Phaser.Scene {
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
    inputPayload = {
        left: false,
        right: false,
        up: false,
        down: false,
    };

    constructor() {
        super({ key: "state_sync_battle" });
    }

    async create() {
        this.debugFPS = this.add.text(4, 4, "", { color: "#ff0000", });
        this.add.text(0, 40, "Back")
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", () => {
                this.game.scene.stop("state_sync_battle")
                this.game.scene.run("main")
            });

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
                const entity = this.add.rectangle(player.x, player.y, 20, 20, 0);
                this.playerEntities[sessionId] = entity;

                $(player).onChange(() => {
                    entity.x = player.x;
                    entity.y = player.y;
                });
            });

            $(state.players).onRemove((player, sessionId) => {
                const entity = this.playerEntities[sessionId];
                if (entity) {
                    entity.destroy();
                    delete this.playerEntities[sessionId]
                }
            });

            $(state.balls).onAdd((ball, key) => {
                const entity = this.add.arc(ball.x, ball.y, 5, 0, 360, false, 0);
                this.ballEntities.set(ball, entity);

                $(ball).onChange(() => {
                    entity.x = ball.x;
                    entity.y = ball.y;
                });
            });
            $(state.balls).onRemove((ball, key) => {
                const entity = this.ballEntities.get(ball);
                if (entity) {
                    entity.destroy();
                    this.ballEntities.delete(ball);
                }
            });
        });

        this.cameras.main.setBounds(0, 0, 375, 812);

        this.events.once("shutdown", () => {
            this.room.leave();
            this.room = undefined;
            this.playerEntities = {};
            this.ballEntities = new Map();
        });
    }

    async connect() {
        const connectionStatusText = this.add
            .text(0, 0, "Trying to connect with the server...")
            .setStyle({ color: "#ff0000" })
            .setPadding(4);
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            // Server is authoritative on identity: the ticket (issued by
            // battlesvr in the BATTLE_START_BATTLE response) is consumed in
            // Colyseus onAuth to recover {gid, openId, zoneId}. We deliberately
            // do NOT pass openId/zoneId here to avoid letting clients spoof.
            this.room = await client.joinOrCreate(startBattleRes.roomType,
                { ticket: startBattleRes.ticket });
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
