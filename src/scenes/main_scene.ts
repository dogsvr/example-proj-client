import Phaser from "phaser";

export class MainScene extends Phaser.Scene {
    constructor() {
        super({ key: "main", active: true });
    }

    preload() {
        this.cameras.main.setBackgroundColor(0x000000);
    }

    create() {
        const role = this.registry.get("roleLocal")
        this.add.text(0, 0, `OpenId: ${role.openid}\nZoneId: ${role.zoneid}\nScore: ${role.score}\n`);

        const textStyle: Phaser.Types.GameObjects.Text.TextStyle = {
            color: "#ff0000",
            fontSize: "32px",
            fontFamily: "Arial"
        };
        this.add.text(400, 300, "Start Battle", textStyle)
            .setInteractive()
            .setPadding(6)
            .on("pointerdown", () => {
                this.game.scene.switch("main", "battle_test")
            });
    }
}
