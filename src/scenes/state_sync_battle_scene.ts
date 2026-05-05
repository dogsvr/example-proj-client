import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import type VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import type VirtualJoyStick from 'phaser4-rex-plugins/plugins/virtualjoystick.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import { Room, Client, getStateCallbacks } from '@colyseus/sdk';
import { Palette, Radius, Spacing, FontSize, HexText, SceneBG, textStyle } from '../theme';
import { paintGradientBackground } from '../ui/background';

/**
 * State-sync battle scene (server-authoritative, every entity broadcast).
 *
 * The gameplay pipeline (Colyseus Room, rectangle/arc entity sync) is
 * unchanged from the original implementation — see inline comments at
 * `onStateChange.once` for the v4 schema-callbacks gotcha.
 *
 * UI changes vs. the original:
 *   - Apricot warm-sunlight gradient background (visually distinct from
 *     main menu's mint and lockstep's lavender) so scene switches are
 *     visually obvious.
 *   - Top HUD bar is a rexUI horizontal Sizer with rounded card background,
 *     replacing the bare "FPS: xxx" text + bare "Back" text.
 *   - Layout follows `this.scale.width/height` and rebuilds on resize —
 *     previously hard-coded to 375 × 812 via `cameras.main.setBounds(0,0,375,812)`.
 */
export class StateSyncBattleScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    rexVirtualJoyStick!: VirtualJoyStickPlugin;
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
    statusText: Phaser.GameObjects.Text;
    private hud: any;
    inputPayload = { left: false, right: false, up: false, down: false };

    // Input: floating virtual joystick (mobile) + arrow keys / WASD (desktop),
    // merged via OR into inputPayload every frame. See setupInput() for the
    // "why we have to poke touchCursor manually" comment — that's the single
    // non-obvious trick in this file.
    private joystick!: VirtualJoyStick;
    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!: {
        W: Phaser.Input.Keyboard.Key;
        A: Phaser.Input.Keyboard.Key;
        S: Phaser.Input.Keyboard.Key;
        D: Phaser.Input.Keyboard.Key;
    };
    // The pointer currently driving the joystick; any other pointerdown is
    // ignored until this one is released (multi-touch safety).
    private joystickPointerId: number | null = null;
    // HUD hit-test list: pointerdown on any of these GameObjects skips
    // joystick activation so taps on the back button just trigger the button.
    private hudInteractives: Phaser.GameObjects.GameObject[] = [];

    constructor() {
        super({ key: 'state_sync_battle' });
    }

    async create() {
        paintGradientBackground(this, SceneBG.state.top, SceneBG.state.bottom);
        this.buildHud();
        this.setupInput();
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

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
                const entity = this.add.rectangle(player.x, player.y, 20, 20, Palette.textPrimary);
                this.playerEntities[sessionId] = entity;
                $(player).onChange(() => {
                    entity.x = player.x;
                    entity.y = player.y;
                });
            });
            $(state.players).onRemove((_player, sessionId) => {
                const entity = this.playerEntities[sessionId];
                if (entity) {
                    entity.destroy();
                    delete this.playerEntities[sessionId];
                }
            });
            $(state.balls).onAdd((ball) => {
                const entity = this.add.arc(ball.x, ball.y, 5, 0, 360, false, Palette.accent);
                this.ballEntities.set(ball, entity);
                $(ball).onChange(() => {
                    entity.x = ball.x;
                    entity.y = ball.y;
                });
            });
            $(state.balls).onRemove((ball) => {
                const entity = this.ballEntities.get(ball);
                if (entity) {
                    entity.destroy();
                    this.ballEntities.delete(ball);
                }
            });
        });

        const onResize = () => this.relayoutHud();
        this.scale.on(Phaser.Scale.Events.RESIZE, onResize);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
            this.room?.leave();
            this.room = undefined;
            this.playerEntities = {};
            this.ballEntities = new Map();
            this.hudInteractives = [];
            this.joystickPointerId = null;
        });
    }

    private buildHud() {
        // HUD design: opaque white card, navy text, navy-with-white-text
        // Back button. Everything here targets maximum WCAG contrast
        // (AAA, 12.6:1 across all three text elements) with zero visual
        // gimmickry — the earlier iterations of this scene accumulated a
        // drop shadow, glyph shadows, a transparent card, and other
        // layers that in combination produced the "text blends into
        // card" symptom the user reported. We now rely solely on color
        // contrast + font weight to carry legibility.
        //
        // Visual hierarchy: FPS (bold) vs. status (regular) — same color,
        // weight carries the "primary readout vs. supporting info"
        // distinction. Same color means we can't accidentally regress
        // contrast, and regular-vs-bold is perceptible at 14px.
        //
        // No glyph shadow: Phaser 4 Text shadow uses blur 2px which
        // smears 14px caption glyphs on low-DPR displays. It was the
        // second source of the "foggy text" symptom in earlier revisions.
        this.debugFPS = this.add.text(0, 0, 'FPS --',
            textStyle({ size: FontSize.caption, color: HexText.primary, weight: 'bold' }));
        this.statusText = this.add.text(0, 0, 'Connecting…',
            textStyle({ size: FontSize.caption, color: HexText.primary }));

        // Back button: navy background with white bold text. 12.6:1
        // contrast (AAA) — the old accent-blue + white-text pairing was
        // ~2.5:1 (failed AA). Navy-on-white card creates a clean inverted
        // tile: the button becomes the darkest element in the HUD and
        // signals "interactive" unambiguously.
        const backBg = new RoundRectangle(this, 0, 0, 2, 2, Radius.btn, Palette.textPrimary);
        this.add.existing(backBg);
        const backText = this.add.text(0, 0, '← Back',
            textStyle({ size: FontSize.caption, color: HexText.white, weight: 'bold' }));
        // Explicit 44×44 minimum per UI Design Rules: touch hit-zones must be
        // at least 44×44 px. Caption text alone + tiny padding rendered at
        // ~26px tall which was too small to tap reliably on phones.
        const backBtn = this.rexUI.add
            .label({
                width: 88,
                height: 44,
                background: backBg,
                text: backText,
                align: 'center',
                space: { left: Spacing.md, right: Spacing.md },
            })
            .setInteractive({ useHandCursor: true });
        // Record HUD interactives so the pointerdown guard in onPointerDown
        // can bail out when a tap lands on the back button. Phaser hit-tests
        // concrete GameObjects (not compound rexUI components), so we push
        // the Label plus its background + text children — any of the three
        // may appear in `currentlyOver` depending on which pixel was hit.
        this.hudInteractives.push(backBtn, backBg, backText);
        backBtn.on('pointerdown', () => {
            // Tear down the battle room synchronously so leaving is instant,
            // then switch back. We use `scene.switch` (not stop+run) so main
            // wakes up deterministically through its WAKE handler which
            // re-fades its camera in — avoids any race with this scene's
            // own camera FX during the transition.
            this.scene.switch('main');
            this.scene.stop('state_sync_battle');
        });

        // HUD card: fully opaque white + darker stroke for sharp
        // separation against the pastel scene. setDepth(-1) forces it
        // below the text / button children in the display list. Without
        // this, rexUI Sizer's `addBackground(hudBg)` only affects Sizer's
        // own layout pass — the actual Phaser z-order is still insertion
        // order, which would paint the white card *over* the text. This
        // was the root cause of the "text and card are the same color"
        // symptom in the previous revision.
        const hudBg = new RoundRectangle(this, 0, 0, 2, 2, Radius.btn, Palette.cardBg, 1);
        hudBg.setStrokeStyle(1.5, Palette.cardStroke, 1);
        hudBg.setDepth(-1);
        this.add.existing(hudBg);

        this.hud = this.rexUI.add
            .sizer({
                orientation: 'horizontal',
                space: { left: Spacing.md, right: Spacing.md, top: Spacing.sm, bottom: Spacing.sm, item: Spacing.md },
            })
            .addBackground(hudBg)
            .add(this.debugFPS, { align: 'center' })
            .addSpace()
            .add(this.statusText, { align: 'center' })
            .addSpace()
            .add(backBtn, { align: 'center' });

        this.relayoutHud();
    }

    private relayoutHud() {
        const { width } = this.scale;
        const hudWidth = Math.min(width - Spacing.lg * 2, 500);
        this.hud.setMinSize(hudWidth, 0);
        this.hud.layout();
        this.hud.setPosition(width / 2, Spacing.lg + this.hud.height / 2);
    }

    async connect() {
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            // Server is authoritative on identity: the ticket (issued by
            // battlesvr in the BATTLE_START_BATTLE response) is consumed in
            // Colyseus onAuth to recover {gid, openId, zoneId}. We deliberately
            // do NOT pass openId/zoneId here to avoid letting clients spoof.
            this.room = await client.joinOrCreate(startBattleRes.roomType, {
                ticket: startBattleRes.ticket,
            });
            this.statusText.setText('Connected');
        } catch (e) {
            this.statusText.setText('Connection failed');
        }
    }

    /**
     * Install input sources: a floating virtual joystick (mobile / pointer)
     * plus arrow keys and WASD (desktop). All three feed {left,right,up,down}
     * booleans, which update() merges via OR into inputPayload and sends via
     * `room.send(0, payload)` — the same contract the state_sync room has
     * always consumed (see example-proj/src/battlesvr/rooms/state_sync_battle_room.ts).
     *
     * "Floating" = base + thumb are hidden until the user presses inside the
     * gameplay area (below the HUD bar). On pointerdown we relocate them
     * under the finger; on pointerup / pointerupoutside / pointercancel we
     * hide again. No fixed-position base, matching modern MOBA / battle-royale
     * conventions.
     */
    private setupInput(): void {
        const BASE_RADIUS = 60;
        const THUMB_RADIUS = 25;

        // Procedural Arc visuals — no assets required, matches the rest of
        // this scene (players = rectangles, balls = arcs). Intentionally
        // low-saturation and translucent so the joystick reads as a guide,
        // not a gameplay element: base uses textPrimary at 10% fill + 22%
        // stroke (a near-invisible grey ring), thumb uses neutral
        // textSecondary at 55% (a soft dove-grey disc). Avoid Palette.accent
        // here — the bright blue drew the eye away from the action.
        const base = this.add.circle(0, 0, BASE_RADIUS, Palette.textPrimary, 0.10);
        base.setStrokeStyle(2, Palette.textPrimary, 0.22);
        // Depth above gameplay entities (default depth 0). HUD is drawn after
        // this call returns so it still covers the joystick naturally via
        // draw order, but explicit depths make ordering robust to reshuffles.
        base.setDepth(1000);
        const thumb = this.add.circle(0, 0, THUMB_RADIUS, Palette.textSecondary, 0.55);
        thumb.setDepth(1001);

        this.joystick = this.rexVirtualJoyStick.add(this, {
            x: 0,
            y: 0,
            radius: BASE_RADIUS, // thumb clamp range = base visual radius
            base,
            thumb,
            // '4dir' makes L/R and U/D mutually exclusive (the plugin picks
            // the dominant axis), matching the server's `if/else if` handler
            // at state_sync_battle_room.ts:55-67.
            dir: '4dir',
            forceMin: 8, // dead zone in px; kills jitter around origin
            fixed: true,
        });
        this.joystick.setVisible(false);

        // Desktop keyboard. Phaser listens on `window`, so canvas focus is
        // not required. No keys conflict with browser shortcuts; no need to
        // call `captureKey` / `preventDefault`.
        this.cursors = this.input.keyboard!.createCursorKeys();
        this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd;

        this.input.on('pointerdown', this.onPointerDown, this);
        this.input.on('pointerup', this.onPointerUp, this);
        this.input.on('pointerupoutside', this.onPointerUp, this);
        this.input.on('pointercancel', this.onPointerUp, this);

        // Orientation change / window resize: hide any in-flight joystick to
        // avoid a stale base position in a now-remapped viewport. Registered
        // here (instead of in create's existing resize handler) so the two
        // concerns stay decoupled.
        const onInputResize = () => {
            if (this.joystick.visible) this.hideJoystick();
        };
        this.scale.on(Phaser.Scale.Events.RESIZE, onInputResize);
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off(Phaser.Scale.Events.RESIZE, onInputResize);
        });
    }

    private onPointerDown(
        pointer: Phaser.Input.Pointer,
        currentlyOver: Phaser.GameObjects.GameObject[],
    ): void {
        // Multi-touch guard: a finger is already driving the joystick; ignore
        // subsequent pointerdowns until that pointer is released.
        if (this.joystickPointerId !== null) return;

        // HUD guard: if the tap hit the back button (or its background /
        // text children), let the button handler run without spawning a
        // joystick on top of it. Phaser passes the list of interactive
        // GameObjects under the pointer as the 2nd arg, which is cheaper
        // than calling hitTestPointer ourselves.
        for (const obj of currentlyOver) {
            if (this.hudInteractives.includes(obj)) return;
        }

        // Geometric guard: refuse taps inside the top HUD bar area. Covers
        // the gaps between HUD children (FPS ↔ status ↔ back) which have
        // no interactive target and would otherwise activate the joystick.
        const hudBottom = Spacing.lg + (this.hud?.height ?? 0);
        if (pointer.y < hudBottom) return;

        this.joystickPointerId = pointer.id;
        this.joystick.setPosition(pointer.x, pointer.y);
        this.joystick.setVisible(true);

        // ⚠️ The rex-plugins TouchCursor subscribes to `base.on('pointerdown')`
        // (see node_modules/phaser4-rex-plugins/plugins/input/touchcursor/
        // TouchCursor.js line ~47). At the moment Phaser fires pointerdown,
        // our base is at (0,0) and invisible, so it never gets hit and the
        // plugin never starts tracking — .left/.right/.up/.down stay false
        // forever. We have to feed the pointer into the TouchCursor
        // ourselves, which its `onKeyDownStart` method supports cleanly (it
        // only checks `pointer.isDown && this.pointer === undefined`).
        //
        // `touchCursor` is intentionally omitted from VirtualJoyStick.d.ts,
        // so this is the one place we reach past the public API. If a future
        // rex-plugins release exposes a capture(pointer) method, replace the
        // cast; the surrounding logic stays unchanged.
        const tc = (this.joystick as unknown as {
            touchCursor: { onKeyDownStart(p: Phaser.Input.Pointer): void };
        }).touchCursor;
        tc.onKeyDownStart(pointer);
    }

    private onPointerUp(pointer: Phaser.Input.Pointer): void {
        if (this.joystickPointerId !== pointer.id) return;
        this.hideJoystick();
    }

    private hideJoystick(): void {
        // setVisible(false) on the plugin also sets enable=false, which
        // clears the captured pointer in TouchCursor and zeros all four
        // direction booleans — guaranteeing joystick.{left,right,up,down}
        // are all false on the next update() tick.
        this.joystick.setVisible(false);
        this.joystickPointerId = null;
    }

    update(): void {
        if (!this.room) return;

        // Merge joystick + both keyboard bindings (arrow keys AND WASD) via
        // OR. Any active source counts as pressed. The server consumes
        // {left,right,up,down} with `if/else if`, so simultaneous L+R
        // resolves to L — same behavior as the prior pointer-drag impl.
        const leftKey = this.cursors.left.isDown || this.wasd.A.isDown;
        const rightKey = this.cursors.right.isDown || this.wasd.D.isDown;
        const upKey = this.cursors.up.isDown || this.wasd.W.isDown;
        const downKey = this.cursors.down.isDown || this.wasd.S.isDown;

        this.inputPayload.left = this.joystick.left || leftKey;
        this.inputPayload.right = this.joystick.right || rightKey;
        this.inputPayload.up = this.joystick.up || upKey;
        this.inputPayload.down = this.joystick.down || downKey;

        this.room.send(0, this.inputPayload);
        this.debugFPS.setText(`FPS ${Math.round(this.game.loop.actualFps)}`);
    }
}
