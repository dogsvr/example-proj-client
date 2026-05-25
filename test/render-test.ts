// Standalone Phaser entry for the local render-stutter test. No login,
// no zone server, no battle server — boots LocalRenderTestScene directly.
import Phaser from 'phaser';
import UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import { LocalRenderTestScene } from './local_render_test_scene';

// fps config defaults match current production (boot.ts):
//   forceSetTimeOut=true, smoothStep=false. URL params per-load A/B against
//   the Phaser-recommended fix values:
//     ?st=0 → forceSetTimeOut: false (RAF instead of setTimeout)
//     ?ss=1 → smoothStep: true (smoothed delta)
// Phaser 4 explicitly forbids changing forceSetTimeOut at runtime
// (TimeStep.js:235), hence URL params rather than runtime keys.
const params = new URLSearchParams(window.location.search);
const forceSetTimeOut = params.get('st') !== '0';
const smoothStep = params.get('ss') === '1';
console.log(
    '[render-test]',
    'forceSetTimeOut =', forceSetTimeOut, '(?st=0 to flip)',
    '| smoothStep =', smoothStep, '(?ss=1 to flip)',
);

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    fps: { target: 60, forceSetTimeOut, smoothStep },
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
    pixelArt: false,
    roundPixels: false,
    plugins: {
        scene: [
            { key: 'rexUI', plugin: UIPlugin, mapping: 'rexUI' },
            { key: 'rexVirtualJoyStick', plugin: VirtualJoyStickPlugin, mapping: 'rexVirtualJoyStick' },
        ],
    },
    scene: [LocalRenderTestScene],
};

new Phaser.Game(config);

