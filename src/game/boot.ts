import Phaser from 'phaser';
import UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import { PreloadScene } from '../scenes/preload_scene';
import { MainScene } from '../scenes/main_scene';

/**
 * Phase B entry: dynamically imported from bootstrap.ts after login. Pulls in
 * Phaser + rexUI + (via MainScene's lazy imports) Colyseus, so the whole graph
 * is code-split into a post-login chunk.
 *
 * Scale: RESIZE + CENTER_BOTH — canvas fills the viewport; every scene listens
 * for `resize` and re-lays out its rexUI Sizer. `min` floors at 320×480.
 * pixelArt = false so rexUI's rounded rects render smooth.
 */
export function createGame(role: any) {
    const config: Phaser.Types.Core.GameConfig = {
        type: Phaser.AUTO,
        // RAF (forceSetTimeOut: false) — setTimeout-driven loop fires off vsync.
        fps: { target: 60, forceSetTimeOut: false, smoothStep: true },
        width: window.innerWidth,
        height: window.innerHeight,
        parent: 'game',
        scale: {
            mode: Phaser.Scale.RESIZE,
            autoCenter: Phaser.Scale.CENTER_BOTH,
            width: window.innerWidth,
            height: window.innerHeight,
            min: { width: 320, height: 480 },
        },
        physics: { default: 'matter' },
        pixelArt: false,
        roundPixels: false,
        plugins: {
            scene: [
                { key: 'rexUI', plugin: UIPlugin, mapping: 'rexUI' },
                { key: 'rexVirtualJoyStick', plugin: VirtualJoyStickPlugin, mapping: 'rexVirtualJoyStick' },
            ],
        },
        scene: [PreloadScene, MainScene],
    };

    // Phaser 4 removed game-level `resolution`; crisp Text is per-Text via
    // TextStyle.resolution — see theme.ts `textStyle()`.
    const game = new Phaser.Game(config);
    game.registry.set('roleLocal', role);
    return game;
}
