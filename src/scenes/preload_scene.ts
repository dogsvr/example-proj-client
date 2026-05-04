import Phaser from 'phaser';
import { ProgressOverlay } from '../ui/progress';
import { SceneBG } from '../theme';
import { paintGradientBackground } from '../ui/background';

/**
 * PreloadScene is the first scene the Phaser.Game boots into. Two roles:
 *
 *   1. On first entry, show a subtle progress overlay, warm up, then hand off
 *      to MainScene. Because the game bundle is ALREADY downloaded by the
 *      time PreloadScene is instantiated (boot.ts is itself dynamically
 *      imported), this stage is very short — basically just one frame so the
 *      overlay flashes briefly and the gradient background is painted.
 *
 *   2. Stays alive in the background after MainScene takes over, and provides
 *      a `showProgressWhile(label, promise)` helper that other scenes use
 *      when dynamically importing battle-scene chunks. This keeps the "busy
 *      UI" rendering concern out of MainScene itself and out of each battle
 *      scene.
 *
 * We deliberately don't use rexUI here because this scene must run before
 * rexUI is guaranteed to be bundled — and keeping PreloadScene's imports
 * small means the Phase-B chunk can start rendering the overlay with zero
 * UI-framework dependency.
 */
export class PreloadScene extends Phaser.Scene {
    private overlay!: ProgressOverlay;

    constructor() {
        super({ key: 'preload' });
    }

    create() {
        paintGradientBackground(this, SceneBG.main.top, SceneBG.main.bottom);
        this.overlay = new ProgressOverlay(this);
        this.overlay.show('Loading');
        this.overlay.setProgress(1);

        // Stash this scene's overlay on the registry so MainScene can trigger
        // it later for battle-scene lazy loads.
        this.game.registry.set('preloadScene', this);

        // Hand off to MainScene and keep PreloadScene running in the
        // background so its overlay is reusable. `run` (not `start`) leaves
        // this scene alive beneath MainScene.
        this.scene.launch('main');
        this.overlay.hide();
    }

    /**
     * Public helper: show the overlay, await `promise`, hide the overlay.
     * Used by MainScene when dynamically importing battle-scene modules.
     */
    async showProgressWhile<T>(label: string, promise: Promise<T>): Promise<T> {
        this.overlay.show(label);
        // We don't get real byte-level progress from a dynamic import, so fake
        // a ramp to give the user feedback. Caps at 90% until the import
        // actually resolves, then jumps to 100.
        let fake = 0;
        const timer = this.time.addEvent({
            delay: 80,
            loop: true,
            callback: () => {
                fake = Math.min(fake + 0.03, 0.9);
                this.overlay.setProgress(fake, label);
            },
        });
        try {
            const result = await promise;
            timer.remove(false);
            this.overlay.setProgress(1, label);
            await new Promise((r) => this.time.delayedCall(80, r));
            this.overlay.hide();
            return result;
        } catch (e) {
            timer.remove(false);
            this.overlay.hide();
            throw e;
        }
    }
}

export function getPreloadScene(game: Phaser.Game): PreloadScene {
    return game.registry.get('preloadScene') as PreloadScene;
}
