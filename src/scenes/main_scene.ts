import Phaser from "phaser";
import { queryRankList, startBattle } from "..";

export class MainScene extends Phaser.Scene {
    roleText: Phaser.GameObjects.Text;
    constructor() {
        super({ key: "main", active: true });
    }

    preload() {
        this.cameras.main.setBackgroundColor(0x000000);
    }

    create() {
        const role = this.registry.get("roleLocal")
        this.roleText = this.add.text(0, 0, `OpenId: ${role.openId}\nZoneId: ${role.zoneId}\nScore: ${role.score}\n`);

        const textStyle: Phaser.Types.GameObjects.Text.TextStyle = {
            color: "#ff0000",
            fontSize: "32px",
            fontFamily: "Arial"
        };
        this.add.text(0, 300, "Start Battle(state)", textStyle)
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", async () => {
                await startBattle("state");
                this.game.scene.switch("main", "state_sync_battle")
            });
        this.add.text(0, 500, "Start Battle(lockstep)", textStyle)
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", async () => {
                await startBattle("lockstep");
                this.game.scene.switch("main", "lockstep_sync_battle")
            });
        this.add.text(0, 700, "Query Rank List", { color: "#ff0000", fontSize: "16px", fontFamily: "Arial" })
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", async () => {
                await queryRankList();
            });
    }

    onBattleEnd(ntf) {
        const role = this.registry.get("roleLocal")
        this.roleText.setText(`OpenId: ${role.openId}\nZoneId: ${role.zoneId}\nScore: ${role.score}\n`);
        alert(`battle end\nscore change: ${ntf.scoreChange}`)
    }
}
