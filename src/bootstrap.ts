import { WsClient, HttpClient } from 'tsrpc-browser';
import { serviceProto } from '@dogsvr/cl-tsrpc/protocols/serviceProto';
import type { MsgCommon } from '@dogsvr/cl-tsrpc/protocols/MsgCommon';
import * as cmdId from 'example-proj/protocols/cmd_id';
import type {
    DirQueryZoneListReq, DirQueryZoneListRes,
    ZoneLoginReq, ZoneLoginRes,
    ZoneStartBattleReq, ZoneStartBattleRes,
    ZoneQueryRankListReq, ZoneQueryRankListRes,
    ZoneBattleEndNtf,
} from 'example-proj/protocols/cmd_proto';
import { composeOpenId, getDeviceId } from './util/device_id';

/**
 * First-paint bootstrap.
 *
 * This module is the ONLY thing the user sees and downloads before clicking
 * Login. It deliberately does NOT import Phaser / rexUI / Colyseus / Matter —
 * those are dynamically imported in `loadGameBundle()` after the user submits
 * the login form. That cuts the first-paint JS from ~2 MB (Phaser + friends)
 * down to tsrpc-browser + this file.
 *
 * The DOM login form in `index.html` stays as real `<form>` / `<input>` /
 * `<select>` elements: browsers handle IME, autofill, password managers and
 * mobile keyboards correctly for free. There's no benefit to re-implementing
 * those in Phaser.
 */

// --- Module-level state shared with the game bundle -------------------------
//
// Once the game bundle is loaded, it reaches back into this module via the
// exported `zoneClient` / `loggedInRole` and calls `startBattle()` /
// `queryRankList()`. Keeping these in bootstrap (not in a Phaser scene) means
// the WebSocket connection survives scene switches and remains the single
// source of truth for server-push messages.

let zoneClient: WsClient<typeof serviceProto> | null = null;
let loggedInRole: any = null;
let onBattleEndHandler: ((ntf: ZoneBattleEndNtf) => void) | null = null;

export function registerBattleEndHandler(fn: (ntf: ZoneBattleEndNtf) => void) {
    onBattleEndHandler = fn;
}

export function getLoggedInRole() {
    return loggedInRole;
}

// --- Connection status observation ----------------------------------------
//
// Surface zoneClient's connected/disconnected state so scenes can light up a
// status indicator without having to import tsrpc internals. We combine
// three signals:
//
//   1. tsrpc `postConnectFlow` / `postDisconnectFlow` — the authoritative
//      source once the WebSocket transitions happen. Covers server crash,
//      network drop, middleware idle-kill, explicit `client.disconnect()`.
//
//   2. `window.online` / `window.offline` — the browser knows the OS-level
//      NIC went down (Wi-Fi off, airplane mode) before the ws `close` event
//      has a chance to fire through the TCP layer. We flip to "disconnected"
//      immediately on `offline` and re-verify against `zoneClient.isConnected`
//      on `online`.
//
//   3. `document.visibilitychange` — when the tab becomes visible after
//      being hidden (phone lock → unlock, tab switch back), the underlying
//      TCP connection may be broken but the `close` event not yet delivered.
//      We re-read `zoneClient.isConnected` on `visible` to paint whichever
//      state is current right now. We do NOT flip to disconnected on
//      `hidden` — the connection is usually fine, and flickering the dot
//      red the moment the user locks the screen is noise.
//
// Exposes a simple listener contract: every listener is invoked once
// synchronously with the current state when it subscribes (so late
// subscribers don't have to poll), then again on every change.

type ConnectionListener = (connected: boolean) => void;

const connectionListeners = new Set<ConnectionListener>();
let connectionState = false;

function readLiveConnected(): boolean {
    if (!zoneClient) return false;
    // navigator.onLine can be stale on some platforms, but when it reports
    // offline it's authoritative for our purposes: even if the WebSocket
    // object still thinks it's open, the OS has torn down the NIC.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return zoneClient.isConnected;
}

function updateConnectionState(next: boolean) {
    if (next === connectionState) return;
    connectionState = next;
    // Copy the set before iterating so a listener that unsubscribes itself
    // inside the callback doesn't skip the next listener.
    for (const l of [...connectionListeners]) {
        try { l(next); } catch (e) { console.error('connection listener threw', e); }
    }
}

/**
 * Subscribe to connection-status changes. The listener is invoked
 * immediately with the current state, then on every subsequent change.
 * Returns an unsubscribe function.
 */
export function onConnectionChange(listener: ConnectionListener): () => void {
    connectionListeners.add(listener);
    // Re-read instead of trusting `connectionState`, in case window events
    // fired while no scene was listening.
    const live = readLiveConnected();
    if (live !== connectionState) connectionState = live;
    listener(connectionState);
    return () => { connectionListeners.delete(listener); };
}

// Browser-level signals. Registered once at module load; safe because the
// client is loaded inside a browser tab. In SSR there's no `window`, so
// the typeof guards keep the module importable.
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        updateConnectionState(readLiveConnected());
    });
    window.addEventListener('offline', () => {
        updateConnectionState(false);
    });
}
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            // Re-sync on resume; a WebSocket close that arrived during the
            // hidden interval already updated connectionState via
            // postDisconnectFlow, but reading the live state here also
            // catches the rarer case where the socket is still technically
            // open but navigator.onLine turned false while hidden.
            updateConnectionState(readLiveConnected());
        }
    });
}

// --- Zone list / login ------------------------------------------------------

async function getZoneList(): Promise<DirQueryZoneListRes | null> {
    const dirClient = new HttpClient(serviceProto, {
        server: `http://${window.location.hostname}:10000`,
    });
    const req: DirQueryZoneListReq = {};
    const ret = await dirClient.callApi('Common', {
        head: { cmdId: cmdId.DIR_QUERY_ZONE_LIST, openId: '', zoneId: 0 },
        innerReq: JSON.stringify(req),
    });
    if (!ret.isSucc) {
        console.error('getZoneList failed', ret.err.message);
        return null;
    }
    return JSON.parse(ret.res.innerRes as string) as DirQueryZoneListRes;
}

async function zoneLogin(openId: string, zoneId: number, name: string): Promise<ZoneLoginRes | null> {
    zoneClient = new WsClient(serviceProto, {
        server: `ws://${window.location.hostname}:20000`,
    });
    // Hook tsrpc's lifecycle flows BEFORE connect() so we don't miss the
    // postConnect notification. Both flows are mutation-style pipelines:
    // return the unchanged `v` to let the flow continue normally.
    zoneClient.flows.postConnectFlow.push((v) => {
        updateConnectionState(readLiveConnected());
        return v;
    });
    zoneClient.flows.postDisconnectFlow.push((v) => {
        updateConnectionState(false);
        return v;
    });
    const connRes = await zoneClient.connect();
    if (!connRes.isSucc) {
        console.error('zone connect failed', connRes.errMsg);
        return null;
    }
    const req: ZoneLoginReq = { openId, zoneId, name };
    const ret = await zoneClient.callApi('Common', {
        head: { cmdId: cmdId.ZONE_LOGIN, openId, zoneId },
        innerReq: JSON.stringify(req),
    });
    if (!ret.isSucc) {
        console.error('zone login failed', ret.err.message);
        return null;
    }
    const res = JSON.parse(ret.res.innerRes as string) as ZoneLoginRes;
    loggedInRole = res.role;

    // Bind server-push listener; forwarded to the game bundle after it loads.
    zoneClient.listenMsg('Common', (msg: MsgCommon) => {
        if (msg.head.cmdId === cmdId.ZONE_BATTLE_END_NTF) {
            const ntf: ZoneBattleEndNtf = JSON.parse(msg.innerMsg as string);
            loggedInRole = ntf.role;
            onBattleEndHandler?.(ntf);
        }
    });

    return res;
}

// --- Game-side API surface (invoked by scenes after they load) -------------

export async function startBattle(syncType: string) {
    if (!zoneClient || !loggedInRole) {
        throw new Error('startBattle called before login');
    }
    const req: ZoneStartBattleReq = { syncType };
    const ret = await zoneClient.callApi('Common', {
        head: {
            cmdId: cmdId.ZONE_START_BATTLE,
            openId: loggedInRole.openId,
            zoneId: loggedInRole.zoneId,
        },
        innerReq: JSON.stringify(req),
    });
    if (!ret.isSucc) {
        throw new Error(ret.err.message);
    }
    return JSON.parse(ret.res.innerRes as string) as ZoneStartBattleRes;
}

export async function queryRankList() {
    if (!zoneClient || !loggedInRole) {
        throw new Error('queryRankList called before login');
    }
    const req: ZoneQueryRankListReq = { rankId: 1, offset: 0, count: 100 };
    const ret = await zoneClient.callApi('Common', {
        head: {
            cmdId: cmdId.ZONE_QUERY_RANK_LIST,
            openId: loggedInRole.openId,
            zoneId: loggedInRole.zoneId,
        },
        innerReq: JSON.stringify(req),
    });
    if (!ret.isSucc) {
        throw new Error(ret.err.message);
    }
    return JSON.parse(ret.res.innerRes as string) as ZoneQueryRankListRes;
}

// --- Login form wiring + deferred game bundle load -------------------------

/**
 * DOM overlay helpers.
 *
 * The `#app-loading` div lives in index.html. It's:
 *   - Shown on first paint (before zone list is fetched).
 *   - Hidden once the login card becomes interactive.
 *   - Re-shown on login submit and kept up through the *entire* game-bundle
 *     download. The bundle is ~2.5 MB on the wire; on slow networks that
 *     window is measured in seconds-to-minutes and MUST have positive
 *     feedback rather than a blank white screen.
 *   - Faded out only after Phaser has painted its first frame — see the
 *     `dogsvr:phaser-ready` event dispatched from PreloadScene.
 */
function showLoading(title: string, detail: string) {
    const overlay = document.getElementById('app-loading');
    if (overlay) {
        overlay.classList.remove('is-fading');
        overlay.style.display = '';
    }
    setLoadingTitle(title);
    setLoadingDetail(detail);
}

function setLoadingTitle(title: string) {
    const el = document.getElementById('app-loading-title');
    if (el) el.textContent = title;
}

function setLoadingDetail(detail: string) {
    const el = document.getElementById('app-loading-detail');
    if (el) el.textContent = detail;
}

function hideLoading() {
    const overlay = document.getElementById('app-loading');
    if (!overlay) return;
    // Add the fade class; the 220 ms CSS transition runs, then we hide
    // completely so the element stops taking any paint work. `transitionend`
    // would be cleaner but bails silently if opacity is already 0, so we
    // use a timer matched to the transition duration.
    overlay.classList.add('is-fading');
    window.setTimeout(() => {
        overlay.style.display = 'none';
    }, 260);
}

/**
 * Kick off the dynamic import for the Phaser bundle. Returns the module
 * promise so callers can await it once they need `createGame`.
 *
 * The import is intentionally *triggered* before we know the login will
 * succeed — chunk download is by far the dominant cost on slow networks
 * (2.5 MB vs. a ~1 KB login RPC), so overlapping the two saves real time
 * on fast networks and hurts nothing on slow ones (we were going to pay
 * the download cost anyway). If login later fails, the already-downloaded
 * chunk simply sits in the browser cache for the next attempt.
 */
function prefetchGameBundle(): Promise<typeof import('./game/boot')> {
    return import('./game/boot');
}

export async function start() {
    const loginCard = document.getElementById('login-card');
    // Update the initial spinner's text while the zone list is being fetched;
    // on slow DNS / first-contact this is the one meaningful feedback the
    // user has.
    setLoadingDetail('Fetching zone list');
    const res = await getZoneList();
    hideLoading();
    if (loginCard) loginCard.style.display = '';

    const zoneidSelect = document.querySelector<HTMLSelectElement>('select#zoneid');
    if (res && zoneidSelect) {
        // Clear any existing options (re-running during HMR).
        zoneidSelect.innerHTML = '';
        for (const zone of res.zoneList) {
            const opt = document.createElement('option');
            opt.value = String(zone.zoneId);
            opt.textContent = String(zone.zoneId);
            zoneidSelect.appendChild(opt);
        }
    }

    const nameInput = document.querySelector<HTMLInputElement>('input#name');
    const form = document.querySelector<HTMLFormElement>('form#login');
    const errorEl = document.getElementById('login-error');
    // Parcel's HTML minifier strips `type="submit"` because it's the default
    // for `<button>` inside a `<form>`, so a `button[type="submit"]` selector
    // fails in production builds. Just grab the first button inside the form.
    const submitBtn = form?.querySelector<HTMLButtonElement>('button');

    if (!nameInput || !zoneidSelect || !form || !submitBtn) {
        console.error('login form elements missing', {
            nameInput: !!nameInput,
            zoneidSelect: !!zoneidSelect,
            form: !!form,
            submitBtn: !!submitBtn,
            loginCardInDom: !!document.getElementById('login-card'),
            bodyHTMLLen: document.body?.innerHTML.length,
        });
        return;
    }

    // PreloadScene dispatches this once its first frame has rendered (see
    // preload_scene.ts). Register the listener now so we don't miss it if
    // Phaser finishes extremely fast on a warm cache.
    window.addEventListener('dogsvr:phaser-ready', () => hideLoading(), { once: true });

    form.onsubmit = async (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) {
            if (errorEl) errorEl.textContent = 'Please enter a name.';
            return;
        }
        // openId is assembled from a persistent per-browser device id plus the
        // display name. The user never sees this; it only exists so MongoDB
        // has a stable primary key that doesn't collide with other devices
        // happening to pick the same name. See util/device_id.ts.
        const openId = composeOpenId(getDeviceId(), name);
        if (errorEl) errorEl.textContent = '';
        submitBtn.disabled = true;
        submitBtn.textContent = 'Loading...';

        // IMPORTANT: show the overlay BEFORE hiding the login card. If you
        // hide the card first and then show the overlay the user sees a
        // flash of blank viewport (gradient only) between the two DOM
        // mutations — small but noticeable, especially on slow devices.
        showLoading('Signing in…', 'Contacting server');
        if (loginCard) loginCard.style.display = 'none';

        // Fire the game-bundle download NOW, in parallel with the login RPC.
        // See prefetchGameBundle() for the rationale.
        const bundlePromise = prefetchGameBundle();
        // Log and surface any network error on the bundle fetch so the user
        // doesn't stare at a stuck spinner forever.
        bundlePromise.catch((err) => {
            console.error('game bundle fetch failed', err);
            setLoadingTitle('Download failed');
            setLoadingDetail('Check your network and refresh.');
        });

        try {
            const loginRes = await zoneLogin(openId, Number(zoneidSelect.value), name);
            if (!loginRes) {
                if (errorEl) errorEl.textContent = 'Login failed. Check console for details.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Login';
                // Return the user to the login card — but keep bundlePromise
                // alive in the background so a retry reuses the cached chunk.
                if (loginCard) loginCard.style.display = '';
                hideLoading();
                return;
            }

            // Login succeeded. Depending on network speed, the bundle may
            // already be resolved (fast link) or still downloading (slow).
            // Either way, await it now and let the overlay keep the user
            // informed.
            setLoadingTitle('Entering game…');
            setLoadingDetail('Loading game assets');
            const mod = await bundlePromise;
            // The Phaser.Game constructor boots PreloadScene immediately;
            // PreloadScene's create() fires `dogsvr:phaser-ready` after the
            // first frame, which the listener above turns into hideLoading().
            mod.createGame(loginRes.role);
        } catch (e: any) {
            if (errorEl) errorEl.textContent = e?.message ?? String(e);
            if (loginCard) loginCard.style.display = '';
            hideLoading();
            submitBtn.disabled = false;
            submitBtn.textContent = 'Login';
        }
    };
}
