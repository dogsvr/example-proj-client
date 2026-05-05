import Phaser from 'phaser';
import UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import { PreloadScene } from '../scenes/preload_scene';
import { MainScene } from '../scenes/main_scene';

/**
 * Phase B entry: loaded dynamically from bootstrap.ts after the user logs in.
 * Because this module statically imports Phaser and MainScene, the whole
 * graph (Phaser engine + rexUI + Colyseus via MainScene's lazy imports) is
 * code-split by Parcel into a chunk that is only fetched post-login.
 *
 * Scale strategy: RESIZE + CENTER_BOTH.
 *
 *   - RESIZE lets the canvas fill the browser viewport and emits 'resize'
 *     events whenever the window size changes (orientation flip, desktop
 *     resize, DevTools device toolbar swap). Every scene listens for this
 *     and re-lays out its rexUI Sizer root.
 *
 *   - `width` / `height` are seeded from `window.innerWidth/innerHeight`
 *     just to give Phaser a sensible initial size; RESIZE mode promptly
 *     overwrites them from the parent div's client box.
 *
 *   - `min` provides a floor so extremely narrow devices (<320px) don't
 *     collapse below the point where rexUI Sizers still fit.
 *
 * pixelArt = false: the original code had pixelArt=true, which turns off
 * texture smoothing. That was fine for the old rectangle-only rendering but
 * makes rexUI's rounded-rectangle panels and text look jagged. Since we're
 * not using pixel-art sprites, turn it off.
 */
export function createGame(role: any) {
    const config: Phaser.Types.Core.GameConfig = {
        type: Phaser.AUTO,
        fps: { target: 60, forceSetTimeOut: true, smoothStep: false },
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
                // rexUI is installed as a scene plugin: every scene gets
                // `this.rexUI` for Sizer / Label / RoundRectangle / Toast.
                { key: 'rexUI', plugin: UIPlugin, mapping: 'rexUI' },
                // VirtualJoyStick: every scene can call
                // `this.rexVirtualJoyStick.add(this, cfg)` to get a floating
                // on-screen stick. Currently consumed only by
                // state_sync_battle_scene; lockstep scene is untouched.
                { key: 'rexVirtualJoyStick', plugin: VirtualJoyStickPlugin, mapping: 'rexVirtualJoyStick' },
            ],
        },
        scene: [PreloadScene, MainScene],
    };

    // Phaser 4 removed the game-level `resolution` field that existed in
    // Phaser 3; crisp Text rasterization is now handled per-Text via the
    // `resolution` field of each TextStyle. See `textStyle()` in theme.ts —
    // all Text objects go through that helper and pick up a capped DPR.

    const game = new Phaser.Game(config);
    game.registry.set('roleLocal', role);
    return game;
}
