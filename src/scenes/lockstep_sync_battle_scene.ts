import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import type VirtualJoyStickPlugin from 'phaser4-rex-plugins/plugins/virtualjoystick-plugin.js';
import type VirtualJoyStick from 'phaser4-rex-plugins/plugins/virtualjoystick.js';
import { BodyType } from 'matter';
import { Room, Client } from '@colyseus/sdk';
import { FontSize, HexText, Palette, Spacing, SceneBG, textStyle } from '../theme';
import { paintGradientBackground } from '../ui/background';
import { paintArenaBoundary } from '../ui/arena_boundary';
import { createBattleHud, type BattleHud } from '../ui/battle_hud';

// ──────────────────────────────────────────────────────────────────────────
// Lockstep battle scene. Gameplay matches state-sync exactly but physics
// runs on the CLIENT, not the server. Every client executes the same frame
// sequence with a fixed 50 ms timestep and a shared seed-driven PRNG, so
// the resulting world state stays in sync across clients without the
// server being the authority.
//
// The server (lockstep_sync_battle_room.ts) is thin: it generates a seed,
// broadcasts action frames at 20 fps, injects join/leave actions, relays
// player input, and receives `reportKills` right before the client leaves.
// ──────────────────────────────────────────────────────────────────────────
const MAP_W = 800;
const MAP_H = 1200;
const PLAYER_SIZE = 20;
const BALL_RADIUS = 5;
// Lockstep runs Matter at a 50 ms fixed timestep (vs state-sync's ~16.67 ms).
// Matter.Body.setVelocity internally scales by (deltaTime / _baseDelta=16.667)
// so a given speed-per-tick translates to a larger per-frame displacement
// here. Raised from state-sync's PLAYER_SPEED=3 / BALL_SPEED=5 so visible
// travel-per-second lands in the same ballpark as state-sync.
const PLAYER_SPEED = 4;
const BALL_SPEED = 6;
const FIRE_INTERVAL = 1000;         // ms, simNow-based
const BALL_TTL = 5000;
const INVULN_DURATION = 2500;
const FRAME_INTERVAL = 50;          // ms per lockstep frame (20 fps)
const MAX_APPLIED_PER_TICK = 8;     // budget: ≤ 400 ms of catchup per render tick

const CAT_WALL = 0x0001;
const CAT_PLAYER = 0x0002;
const CAT_BALL = 0x0004;

const STATE_ALIVE = 0;
const STATE_INVULN = 1;

// Mirror of state-sync's palette so the two modes look visually uniform —
// same colour for the same colorIdx across both scenes.
const PLAYER_PALETTE: readonly number[] = [
    0x4A90E2, 0xE74C3C, 0x27AE60, 0xF5A623,
    0x9B59B6, 0x1ABC9C, 0xE91E63, 0x34495E,
] as const;
const PLAYER_PALETTE_HEX: readonly string[] = [
    '#4A90E2', '#E74C3C', '#27AE60', '#F5A623',
    '#9B59B6', '#1ABC9C', '#E91E63', '#34495E',
] as const;

type Action = { vkey: string; args: any[]; playerId: string };
interface Frame { frameId: number; actions: Action[] }

type PlayerWorld = {
    sessionId: string;
    gid: number;
    colorIdx: number;
    body: BodyType;
    entity: Phaser.GameObjects.Rectangle;
    ring: Phaser.GameObjects.Arc;
    ringTween: Phaser.Tweens.Tween;
    label: Phaser.GameObjects.Text;
    isSelf: boolean;
    state: number;        // STATE_ALIVE | STATE_INVULN
    kills: number;
    lastDirX: number;
    lastDirY: number;
    // Current intended move direction (from the most recent input action).
    // Re-applied every frame via setVelocity so friction doesn't decay
    // a held key back to zero — input actions only arrive on change.
    curDirX: number;
    curDirY: number;
    hasMoved: boolean;
    invulnUntilTs: number;   // simNow
    nextFireTs: number;      // simNow
};

type BallWorld = {
    ownerSessionId: string;
    body: BodyType;
    entity: Phaser.GameObjects.Arc;
    createTs: number;        // simNow
};

/** Deterministic 32-bit PRNG. All clients with the same seed produce the
 *  same sequence — required for respawn positions to match across clients. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class LockstepSyncBattleScene extends Phaser.Scene {
    rexUI!: UIPlugin;
    rexVirtualJoyStick!: VirtualJoyStickPlugin;
    room: Room;

    // ── World state (owned by the client, driven by execFrame) ───────────
    private players: Map<string, PlayerWorld> = new Map();
    private balls: BallWorld[] = [];
    private pendingKills: { owner: PlayerWorld; victim: PlayerWorld; ball: BallWorld }[] = [];
    private prng: () => number = Math.random;   // replaced once seed arrives
    private simNow: number = 0;                 // simulation clock (ms)
    private nextFrameId: number = 0;
    private frameArray: Frame[] = [];
    private selfSessionId: string = '';
    private selfKills: number = 0;
    private startedExec: boolean = false;       // gate: don't execFrame before init packet arrives
    // Buffer broadcastFrame messages that arrive before init. Without this,
    // live frames would interleave with historical frames incorrectly.
    private preInitFrameBuffer: Frame[] = [];
    private initReceived: boolean = false;
    // Set while fast-forwarding through historical frames on join. The
    // explosion helper checks this and skips particle bursts for historical
    // deaths (they already happened; no need to animate them on entry).
    private isReplaying: boolean = false;

    private hud!: BattleHud;

    // ── Input ───────────────────────────────────────────────────────────
    private joystick!: VirtualJoyStick;
    private joystickBase!: Phaser.GameObjects.Arc;
    private joystickThumb!: Phaser.GameObjects.Arc;
    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!: {
        W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
        S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    };
    private joystickPointerId: number | null = null;
    private lastSentInput: number = -1;         // bitfield; -1 forces first send

    private selfInvulnEndsAt: number = 0;       // wall-clock ms (this.time.now) — HUD only

    // Same shutdown gate pattern as state_sync scene — prevents async
    // Colyseus callbacks from creating ghost GameObjects after shutdown.
    private isShuttingDown = false;

    constructor() { super({ key: 'lockstep_sync_battle' }); }

    async create() {
        // Phaser reuses Scene instances by key — reset every field on each
        // create() so a prior run doesn't leak state into the next run.
        this.isShuttingDown = false;
        this.players = new Map();
        this.balls = [];
        this.pendingKills = [];
        this.prng = Math.random;
        this.simNow = 0;
        this.nextFrameId = 0;
        this.frameArray = [];
        this.selfSessionId = '';
        this.selfKills = 0;
        this.startedExec = false;
        this.preInitFrameBuffer = [];
        this.initReceived = false;
        this.isReplaying = false;
        this.joystickPointerId = null;
        this.lastSentInput = -1;
        this.selfInvulnEndsAt = 0;

        paintGradientBackground(this, SceneBG.lockstep.top, SceneBG.lockstep.bottom,
            { width: MAP_W, height: MAP_H });
        this.hud = createBattleHud(this, () => {
            // Report final kill count BEFORE leaving so the server has it
            // when it processes onLeave and emits ZONE_BATTLE_END_NTF.
            try { this.room?.send('reportKills', this.selfKills); } catch {}
            this.scene.switch('main');
            this.scene.stop('lockstep_sync_battle');
        }, { kills: true, invuln: true });
        this.setupInput();
        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        await this.connect();
        if (!this.room || this.isShuttingDown) return;

        this.initPhysics();
        this.cameras.main.setBounds(0, 0, MAP_W, MAP_H);
        paintArenaBoundary(this, MAP_W, MAP_H);

        // onMessage(0) is the init packet (seed + self sid + currFrameId).
        // Colyseus SDK does not deliver messages until joinOrCreate resolves,
        // so registering here (right after resolve, before the next await)
        // is safe.
        this.room.onMessage(0, (msg: any) => {
            if (this.isShuttingDown) return;
            this.selfSessionId = msg.selfSessionId;
            this.prng = mulberry32(msg.seed >>> 0);

            // Seed local frame buffer with history (every frame already
            // broadcast to other clients before we joined), then append
            // anything that leaked in between connect and init arrival.
            // Live frames will continue to push onto frameArray after this.
            const historical: Frame[] = Array.isArray(msg.historicalFrames) ? msg.historicalFrames : [];
            this.frameArray = historical.concat(this.preInitFrameBuffer);
            this.preInitFrameBuffer = [];
            this.nextFrameId = 0;

            // Fast-forward: replay every historical frame synchronously so
            // our world matches the current server state before handing
            // control to the per-tick update loop. isReplaying suppresses
            // visual side effects (particle bursts for historical deaths).
            this.isReplaying = true;
            try {
                while (this.nextFrameId < historical.length) {
                    this.execFrame(this.frameArray[this.nextFrameId]);
                    this.nextFrameId++;
                }
            } finally {
                this.isReplaying = false;
            }

            this.initReceived = true;
            this.startedExec = true;
        });
        this.room.onMessage('broadcastFrame', (frame: Frame) => {
            if (this.isShuttingDown) return;
            // Messages can arrive in any order before init (Colyseus doesn't
            // guarantee ordering between channels). Buffer them until the
            // init message lands, then onMessage(0) will prepend history
            // and concat the buffer in the right order.
            if (!this.initReceived) {
                this.preInitFrameBuffer.push(frame);
            } else {
                this.frameArray.push(frame);
            }
        });

        const onResize = () => {
            this.hud.relayout();
            if (this.joystick.visible) this.hideJoystick();
        };
        this.scale.on(Phaser.Scale.Events.RESIZE, onResize);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.isShuttingDown = true;

            // Each step independently guarded — learned from state-sync: a
            // single throw (e.g. cameras.main.stopFollow after CameraManager
            // already tore down) used to abort cleanup and leak GameObjects.
            try { this.scale.off(Phaser.Scale.Events.RESIZE, onResize); } catch {}
            // Intentionally NOT calling this.cameras.main.stopFollow(): the
            // framework handles that and the call can null-deref late in
            // the shutdown sequence.
            try { this.room?.leave(); } catch {}
            this.room = undefined;

            try {
                for (const p of this.players.values()) this.destroyPlayerVisuals(p);
            } catch {}
            try {
                for (const b of this.balls) b.entity.destroy();
            } catch {}
            this.players = new Map();
            this.balls = [];
            this.pendingKills = [];

            try { this.joystick?.destroy(); } catch {}

            this.joystickPointerId = null;
            this.selfInvulnEndsAt = 0;
            this.startedExec = false;
            this.preInitFrameBuffer = [];
            this.initReceived = false;
            this.isReplaying = false;
        });
    }

    async connect() {
        const startBattleRes = this.registry.get('startBattleRes');
        const client = new Client(`ws://${window.location.hostname}:${startBattleRes.battleSvrAddr}`);
        try {
            this.room = await client.joinOrCreate(startBattleRes.roomType, {
                ticket: startBattleRes.ticket,
            });
        } catch (e) {
            // HUD has no status widget — leave the scene empty; user can Back.
        }
    }

    private initPhysics() {
        // Lockstep requires manual physics driving. Phaser's MatterPlugin
        // defaults to advancing Engine.update every scene tick with the
        // wall-clock delta; that would double-drive (once by Phaser, once
        // by us) AND make each client's timestep different, which diverges
        // the sim. Turning autoUpdate off and calling world.step(50) by
        // hand inside execFrame is what keeps all clients in lockstep.
        this.matter.world.autoUpdate = false;
        this.matter.world.disableGravity();

        // Four thick static walls — same layout as state-sync server.
        // setBounds isn't enough: the resulting edges don't bounce with
        // restitution=1 reliably, and we need the "bullets ricochet"
        // behaviour identical to state-sync.
        const thick = 1000;
        const wallOpts: any = {
            isStatic: true, restitution: 1, friction: 0, frictionStatic: 0,
            collisionFilter: { category: CAT_WALL, mask: CAT_PLAYER | CAT_BALL },
        };
        this.matter.add.rectangle(-thick / 2, MAP_H / 2, thick, MAP_H + thick * 2, wallOpts);
        this.matter.add.rectangle(MAP_W + thick / 2, MAP_H / 2, thick, MAP_H + thick * 2, wallOpts);
        this.matter.add.rectangle(MAP_W / 2, -thick / 2, MAP_W + thick * 2, thick, wallOpts);
        this.matter.add.rectangle(MAP_W / 2, MAP_H + thick / 2, MAP_W + thick * 2, thick, wallOpts);

        // Matter collisionStart is dispatched DURING Engine.update — do NOT
        // mutate the world here (no Composite.remove, no splice). Only push
        // to pendingKills; drain in execFrame after world.step returns.
        this.matter.world.on('collisionstart', (event: any) => this.onCollisionStart(event));
    }

    private onCollisionStart(event: any): void {
        for (const pair of event.pairs) {
            const plugA = (pair.bodyA as any).plugin ?? {};
            const plugB = (pair.bodyB as any).plugin ?? {};
            // One side must be a ball, the other a player — otherwise it's
            // a wall-ball, wall-player, or ball-ball bounce (pure physics,
            // no game effect).
            let ball: BallWorld | null = null;
            let player: PlayerWorld | null = null;
            if (plugA.ball && plugB.player) { ball = plugA.ball; player = plugB.player; }
            else if (plugB.ball && plugA.player) { ball = plugB.ball; player = plugA.player; }
            else continue;

            // Self-bounce: own bullet never kills, Matter already reflected it.
            const owner = this.players.get(ball!.ownerSessionId);
            if (owner === player) continue;
            // Invuln victim: bullet physically bounces (no game effect).
            if (player!.state === STATE_INVULN) continue;
            // Orphan bullet (owner already left): bounce, no kill.
            if (!owner) continue;

            this.pendingKills.push({ owner, victim: player!, ball: ball! });
        }
    }

    // ── Lockstep main loop ──────────────────────────────────────────────

    update(): void {
        if (!this.room || this.isShuttingDown) return;

        // 1) Input → bitfield. Only send when it changes to avoid per-tick
        //    spam (the server adds each send to the current frame; many
        //    identical sends per frame would bloat frameArray).
        const leftKey = this.cursors.left.isDown || this.wasd.A.isDown;
        const rightKey = this.cursors.right.isDown || this.wasd.D.isDown;
        const upKey = this.cursors.up.isDown || this.wasd.W.isDown;
        const downKey = this.cursors.down.isDown || this.wasd.S.isDown;
        const l = this.joystick.left || leftKey;
        const r = this.joystick.right || rightKey;
        const u = this.joystick.up || upKey;
        const d = this.joystick.down || downKey;
        const packed = (l ? 1 : 0) | (r ? 2 : 0) | (u ? 4 : 0) | (d ? 8 : 0);
        if (packed !== this.lastSentInput) {
            this.lastSentInput = packed;
            try { this.room.send('submitAction', { vkey: 'input', args: [packed] }); } catch {}
        }

        // 2) Drain up to N frames this render tick. Gate on startedExec so
        //    we don't apply any frames before the init packet (seed) lands.
        if (this.startedExec) {
            let applied = 0;
            while (applied < MAX_APPLIED_PER_TICK && this.nextFrameId < this.frameArray.length) {
                this.execFrame(this.frameArray[this.nextFrameId]);
                this.nextFrameId++;
                applied++;
            }
        }

        // 3) HUD invuln countdown — driven by wall-clock to stay smooth.
        //    This is display-only, not part of the deterministic sim.
        if (this.hud.invuln) {
            const remain = Math.max(0, this.selfInvulnEndsAt - this.time.now);
            this.hud.invuln.setText(remain > 0
                ? `Invuln ${(remain / 1000).toFixed(1)}s`
                : 'Invuln --');
        }
    }

    private execFrame(frame: Frame): void {
        // a) apply actions (join / leave / input → writes curDirX/Y)
        for (const action of frame.actions) {
            this.applyAction(action);
        }

        // b) refresh per-player velocity every frame from their current
        //    intended direction. Input actions only arrive on CHANGE, so
        //    without this refresh Matter's frictionAir would decay a held
        //    key back to zero within a few ticks. Bullets aren't refreshed
        //    (their initial setVelocity + restitution=1 carries them).
        for (const p of this.players.values()) {
            if (!p.body) continue;
            this.matter.body.setVelocity(p.body, {
                x: p.curDirX * PLAYER_SPEED,
                y: p.curDirY * PLAYER_SPEED,
            });
        }

        // c) fixed-timestep physics step — never use wall-clock delta here.
        this.matter.world.step(FRAME_INTERVAL);
        this.simNow += FRAME_INTERVAL;

        // d) drain pending kills queued by collisionStart during step.
        if (this.pendingKills.length > 0) {
            const killedBalls = new Set<BallWorld>();
            const killedVictims = new Set<PlayerWorld>();
            for (const k of this.pendingKills) {
                if (killedBalls.has(k.ball) || killedVictims.has(k.victim)) continue;
                killedBalls.add(k.ball);
                killedVictims.add(k.victim);

                k.owner.kills++;
                if (k.owner.sessionId === this.selfSessionId) {
                    this.selfKills = k.owner.kills;
                    this.hud.kills?.setText(`Kills ${this.selfKills}`);
                }
                // Particle burst at death position — this is visual only
                // and may use non-deterministic randomness (does not touch
                // world state or the PRNG).
                this.spawnExplosion(
                    k.victim.entity.x, k.victim.entity.y,
                    PLAYER_PALETTE[k.victim.colorIdx] ?? Palette.danger,
                );
                this.removeBall(k.ball);
                this.respawnPlayer(k.victim);
            }
            this.pendingKills.length = 0;
        }

        // d) invuln expiry + auto-fire.
        for (const p of this.players.values()) {
            if (!p.body) continue;
            if (p.state === STATE_INVULN && this.simNow >= p.invulnUntilTs) {
                p.state = STATE_ALIVE;
                p.ring.setVisible(false);
                p.ringTween.pause();
                if (p.isSelf) this.selfInvulnEndsAt = 0;
            }
            if (p.hasMoved && this.simNow >= p.nextFireTs) {
                this.spawnBall(p);
                p.nextFireTs += FIRE_INTERVAL;
            }
        }

        // e) ball TTL. Reverse iterate for splice safety.
        for (let i = this.balls.length - 1; i >= 0; i--) {
            if (this.simNow >= this.balls[i].createTs + BALL_TTL) {
                this.removeBall(this.balls[i]);
            }
        }

        // f) sync visuals from physics bodies.
        for (const p of this.players.values()) {
            if (!p.body) continue;
            p.entity.x = p.body.position.x;
            p.entity.y = p.body.position.y;
            p.ring.x = p.entity.x;
            p.ring.y = p.entity.y;
            p.label.x = p.entity.x;
            p.label.y = p.entity.y - PLAYER_SIZE;
        }
        for (const b of this.balls) {
            if (!b.body) continue;
            b.entity.x = b.body.position.x;
            b.entity.y = b.body.position.y;
        }
    }

    private applyAction(action: Action): void {
        switch (action.vkey) {
            case 'join': {
                const [sid, gid, colorIdx, sx, sy] = action.args;
                this.createPlayer(sid, gid, colorIdx, sx, sy);
                break;
            }
            case 'leave': {
                const [sid] = action.args;
                this.destroyPlayer(sid);
                break;
            }
            case 'input': {
                const p = this.players.get(action.playerId);
                if (!p || !p.body) break;
                const packed = action.args[0] | 0;
                const l = (packed & 1) !== 0;
                const r = (packed & 2) !== 0;
                const u = (packed & 4) !== 0;
                const d = (packed & 8) !== 0;
                const dx = r ? 1 : (l ? -1 : 0);
                const dy = d ? 1 : (u ? -1 : 0);
                // Record intent only; execFrame's per-frame velocity refresh
                // (step b) applies it. Clients only broadcast input on
                // change, so without the per-frame refresh, Matter's
                // frictionAir would decay a held key back to zero after a
                // few ticks.
                p.curDirX = dx;
                p.curDirY = dy;
                if (dx !== 0 || dy !== 0) {
                    p.lastDirX = dx;
                    p.lastDirY = dy;
                    if (!p.hasMoved) {
                        p.hasMoved = true;
                        p.nextFireTs = this.simNow + FIRE_INTERVAL;
                    }
                }
                break;
            }
        }
    }

    // ── Entity lifecycle ────────────────────────────────────────────────

    private createPlayer(sid: string, gid: number, colorIdx: number, spawnX: number, spawnY: number): void {
        if (this.isShuttingDown) return;
        if (this.players.has(sid)) return; // idempotent: late joiner might see a duplicate join frame

        const isSelf = sid === this.selfSessionId;
        const colorIdxSafe = ((colorIdx ?? 0) | 0) % PLAYER_PALETTE.length;
        const bodyColor = PLAYER_PALETTE[colorIdxSafe];
        const labelHex = PLAYER_PALETTE_HEX[colorIdxSafe];

        const body = this.matter.add.rectangle(spawnX, spawnY, PLAYER_SIZE, PLAYER_SIZE, {
            frictionAir: 0.08, friction: 0, frictionStatic: 0, restitution: 1,
            // `inertia` isn't in Phaser's MatterBodyConfig types but matter-js
            // honours it; cast avoids a type error without losing behaviour.
            inertia: Infinity,
            collisionFilter: { category: CAT_PLAYER, mask: CAT_WALL | CAT_BALL },
        } as any);

        const entity = this.add.rectangle(spawnX, spawnY, PLAYER_SIZE, PLAYER_SIZE, bodyColor);
        if (isSelf) {
            entity.setStrokeStyle(3, 0xFFFFFF, 1);
            this.cameras.main.startFollow(entity, true, 0.1, 0.1);
        }

        const label = this.add.text(spawnX, spawnY - PLAYER_SIZE, '', {
            ...textStyle({
                size: FontSize.caption,
                color: isSelf ? HexText.white : labelHex,
                weight: 'bold',
                shadow: true,
            }),
            align: 'center',
        }).setOrigin(0.5, 1);
        label.setText(isSelf ? 'YOU' : `P${colorIdxSafe + 1}`);

        const ring = this.add.circle(spawnX, spawnY, PLAYER_SIZE * 0.9)
            .setStrokeStyle(3, Palette.success, 0.9)
            .setFillStyle(Palette.success, 0.0)
            .setVisible(true);
        const ringTween = this.tweens.add({
            targets: ring,
            scale: { from: 0.85, to: 1.25 },
            alpha: { from: 1, to: 0.4 },
            duration: 400,
            yoyo: true,
            repeat: -1,
        });

        const pw: PlayerWorld = {
            sessionId: sid, gid, colorIdx: colorIdxSafe,
            body, entity, ring, ringTween, label, isSelf,
            state: STATE_INVULN,           // spawn protection
            kills: 0,
            lastDirX: 0, lastDirY: 0,
            curDirX: 0, curDirY: 0,
            hasMoved: false,
            invulnUntilTs: this.simNow + INVULN_DURATION,
            nextFireTs: 0,
        };
        (body as any).plugin = { player: pw };
        this.players.set(sid, pw);

        // Self invuln HUD countdown starts now (wall-clock).
        if (isSelf) {
            this.selfInvulnEndsAt = this.time.now + INVULN_DURATION;
            this.hud.kills?.setText(`Kills 0`);
        }
    }

    private destroyPlayer(sid: string): void {
        const p = this.players.get(sid);
        if (!p) return;
        this.destroyPlayerVisuals(p);
        try { this.matter.world.remove(p.body); } catch {}
        this.players.delete(sid);
    }

    /** Destroy only the visual + tween side of a player; used by both
     *  action-driven leave and SHUTDOWN cleanup. */
    private destroyPlayerVisuals(p: PlayerWorld): void {
        try { p.ringTween.stop(); p.ringTween.remove(); } catch {}
        try { p.ring.destroy(); } catch {}
        try { p.label.destroy(); } catch {}
        try { p.entity.destroy(); } catch {}
    }

    private spawnBall(p: PlayerWorld): void {
        if (this.isShuttingDown) return;

        const body = this.matter.add.circle(p.body.position.x, p.body.position.y, BALL_RADIUS, {
            frictionAir: 0, friction: 0, frictionStatic: 0, restitution: 1,
            // see createPlayer for note on the `inertia` type cast.
            inertia: Infinity,
            collisionFilter: { category: CAT_BALL, mask: CAT_WALL | CAT_PLAYER | CAT_BALL },
        } as any);
        // Fire in the reverse of the owner's last non-zero movement dir.
        this.matter.body.setVelocity(body, {
            x: -p.lastDirX * BALL_SPEED,
            y: -p.lastDirY * BALL_SPEED,
        });

        const isMine = p.sessionId === this.selfSessionId;
        const color = PLAYER_PALETTE[p.colorIdx] ?? Palette.danger;
        const entity = this.add.arc(p.body.position.x, p.body.position.y,
            BALL_RADIUS, 0, 360, false, color);
        if (isMine) entity.setStrokeStyle(1.5, 0xFFFFFF, 1);

        const ball: BallWorld = {
            ownerSessionId: p.sessionId,
            body, entity,
            createTs: this.simNow,
        };
        (body as any).plugin = { ball };
        this.balls.push(ball);
    }

    private removeBall(ball: BallWorld): void {
        try { this.matter.world.remove(ball.body); } catch {}
        try { ball.entity.destroy(); } catch {}
        const idx = this.balls.indexOf(ball);
        if (idx >= 0) this.balls.splice(idx, 1);
    }

    private respawnPlayer(p: PlayerWorld): void {
        // Must use the seeded PRNG so all clients produce the same position.
        // Every client drains pendingKills in the same order on the same
        // frame, so the number of prng() draws is identical across clients.
        const x = this.prng() * (MAP_W - PLAYER_SIZE) + PLAYER_SIZE / 2;
        const y = this.prng() * (MAP_H - PLAYER_SIZE) + PLAYER_SIZE / 2;
        this.matter.body.setPosition(p.body, { x, y });
        this.matter.body.setVelocity(p.body, { x: 0, y: 0 });
        p.state = STATE_INVULN;
        p.invulnUntilTs = this.simNow + INVULN_DURATION;
        // Reset input latch: respawned player must move again before
        // auto-fire resumes (matches state-sync behaviour).
        p.hasMoved = false;
        p.lastDirX = 0;
        p.lastDirY = 0;
        p.curDirX = 0;
        p.curDirY = 0;
        p.ring.setVisible(true);
        p.ringTween.resume();

        if (p.isSelf) this.selfInvulnEndsAt = this.time.now + INVULN_DURATION;
    }

    /** Radial particle burst: 6 small circles tween outward + fade. Visual
     *  only — non-deterministic Math.random is fine here since these
     *  particles don't feed back into the sim state or PRNG. Skipped
     *  during historical replay: those deaths are in the past and
     *  animating hundreds of them on scene entry looks like garbage. */
    private spawnExplosion(x: number, y: number, color: number): void {
        if (this.isShuttingDown || this.isReplaying) return;
        const N = 6;
        for (let i = 0; i < N; i++) {
            const angle = (i / N) * Math.PI * 2;
            const shard = this.add.circle(x, y, 3, color, 1);
            const dx = Math.cos(angle) * 28;
            const dy = Math.sin(angle) * 28;
            this.tweens.add({
                targets: shard,
                x: x + dx, y: y + dy,
                alpha: 0, scale: 0.5,
                duration: 300,
                ease: 'Cubic.easeOut',
                onComplete: () => shard.destroy(),
            });
        }
    }

    // ── Input setup (identical to state-sync scene) ─────────────────────

    private setupInput(): void {
        const BASE_RADIUS = 60, THUMB_RADIUS = 25;

        this.joystickBase = this.add.circle(0, 0, BASE_RADIUS, Palette.textPrimary, 0.10);
        this.joystickBase.setStrokeStyle(2, Palette.textPrimary, 0.22);
        this.joystickBase.setDepth(1000);
        this.joystickBase.setScrollFactor(0);
        this.joystickThumb = this.add.circle(0, 0, THUMB_RADIUS, Palette.textSecondary, 0.55);
        this.joystickThumb.setDepth(1001);
        this.joystickThumb.setScrollFactor(0);

        this.joystick = this.rexVirtualJoyStick.add(this, {
            x: 0, y: 0, radius: BASE_RADIUS,
            base: this.joystickBase, thumb: this.joystickThumb,
            dir: '4dir', forceMin: 8, fixed: true,
        });
        this.joystick.setVisible(false);

        this.cursors = this.input.keyboard!.createCursorKeys();
        this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd;

        this.input.on('pointerdown', this.onPointerDown, this);
        this.input.on('pointerup', this.onPointerUp, this);
        this.input.on('pointerupoutside', this.onPointerUp, this);
        this.input.on('pointercancel', this.onPointerUp, this);
    }

    private onPointerDown(
        pointer: Phaser.Input.Pointer,
        currentlyOver: Phaser.GameObjects.GameObject[],
    ): void {
        if (this.joystickPointerId !== null) return;
        for (const obj of currentlyOver) {
            if (this.hud.interactives.includes(obj)) return;
        }
        if (pointer.y < Spacing.lg + this.hud.height()) return;

        this.joystickPointerId = pointer.id;
        this.joystick.setPosition(pointer.x, pointer.y);
        this.joystick.setVisible(true);

        // rex TouchCursor needs pointer fed in manually — same workaround
        // as state-sync scene; see state_sync_battle_scene.ts for rationale.
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
        this.joystick.setVisible(false);
        this.joystickPointerId = null;
    }
}
