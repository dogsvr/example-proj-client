import Phaser from "phaser";
import { startBattle } from "..";

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
        this.add.text(400, 300, "Start Battle", textStyle)
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", async () => {
                await startBattle();
                this.game.scene.switch("main", "battle_test")
            });
    }

    onBattleEnd(ntf) {
        const role = this.registry.get("roleLocal")
        this.roleText.setText(`OpenId: ${role.openId}\nZoneId: ${role.zoneId}\nScore: ${role.score}\n`);
    }
}
