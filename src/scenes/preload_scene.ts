import Phaser from 'phaser';
import { ProgressOverlay } from '../ui/progress';
import { SceneBG } from '../theme';
import { paintGradientBackground } from '../ui/background';

/**
 * First scene the game boots into. Paints the gradient, hands off to
 * MainScene, stays alive to provide `showProgressWhile()` for other scenes'
 * dynamic imports. Deliberately avoids rexUI so it can run before rexUI is
 * bundled.
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

        this.game.registry.set('preloadScene', this);

        // `launch` (not `start`) keeps this scene alive beneath MainScene so
        // its overlay is reusable for battle-scene lazy loads.
        this.scene.launch('main');
        this.overlay.hide();

        // Signal DOM overlay (#app-loading) that the first frame is painted.
        // Wait one rAF tick so the gradient is actually rasterized before the
        // DOM 220ms fade starts — otherwise there's a 1-frame window where the
        // DOM overlay is half-transparent with nothing behind it.
        requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('dogsvr:phaser-ready'));
        });
    }

    /**
     * Show overlay, await promise, hide overlay. Used for dynamic imports
     * that don't expose byte-level progress — we fake a ramp capped at 90%.
     */
    async showProgressWhile<T>(label: string, promise: Promise<T>): Promise<T> {
        this.overlay.show(label);
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
