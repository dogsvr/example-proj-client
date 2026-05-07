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
import { NAME_MAX_CHARS } from './util/name_truncate';

/**
 * First-paint bootstrap. Deliberately does NOT import Phaser/rexUI/Colyseus —
 * those are dynamically imported after login to keep first-paint JS small.
 */

// Module-level so the WsClient survives scene switches.
let zoneClient: WsClient<typeof serviceProto> | null = null;
let loggedInRole: any = null;
let onBattleEndHandler: ((ntf: ZoneBattleEndNtf) => void) | null = null;

export function registerBattleEndHandler(fn: (ntf: ZoneBattleEndNtf) => void) {
    onBattleEndHandler = fn;
}

export function getLoggedInRole() {
    return loggedInRole;
}

// --- Connection status ----------------------------------------------------
// Merges tsrpc flows + window online/offline + visibilitychange. Never flips
// to disconnected on `hidden` (lock screen would flicker red).

type ConnectionListener = (connected: boolean) => void;

const connectionListeners = new Set<ConnectionListener>();
let connectionState = false;

function readLiveConnected(): boolean {
    if (!zoneClient) return false;
    // navigator.onLine false is authoritative; true can be stale.
    if (navigator.onLine === false) return false;
    return zoneClient.isConnected;
}

function updateConnectionState(next: boolean) {
    if (next === connectionState) return;
    connectionState = next;
    // Copy before iterating: listeners may unsubscribe themselves.
    for (const l of [...connectionListeners]) {
        try { l(next); } catch (e) { console.error('connection listener threw', e); }
    }
}

/** Subscribe to connection changes. Fires immediately with current state. Returns unsubscribe. */
export function onConnectionChange(listener: ConnectionListener): () => void {
    connectionListeners.add(listener);
    const live = readLiveConnected();
    if (live !== connectionState) connectionState = live;
    listener(connectionState);
    return () => { connectionListeners.delete(listener); };
}

window.addEventListener('online', () => updateConnectionState(readLiveConnected()));
window.addEventListener('offline', () => updateConnectionState(false));
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateConnectionState(readLiveConnected());
});

// --- Zone list / login ----------------------------------------------------

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
    // Hook flows before connect() so postConnect isn't missed.
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

    zoneClient.listenMsg('Common', (msg: MsgCommon) => {
        if (msg.head.cmdId === cmdId.ZONE_BATTLE_END_NTF) {
            const ntf: ZoneBattleEndNtf = JSON.parse(msg.innerMsg as string);
            loggedInRole = ntf.role;
            onBattleEndHandler?.(ntf);
        }
    });

    return res;
}

// --- Game-side API (invoked by scenes) ------------------------------------

/** Shared Common-cmd RPC helper for zone calls. */
async function callZone<TReq, TRes>(cmd: number, req: TReq): Promise<TRes> {
    if (!zoneClient || !loggedInRole) throw new Error('callZone before login');
    const ret = await zoneClient.callApi('Common', {
        head: { cmdId: cmd, openId: loggedInRole.openId, zoneId: loggedInRole.zoneId },
        innerReq: JSON.stringify(req),
    });
    if (!ret.isSucc) throw new Error(ret.err.message);
    return JSON.parse(ret.res.innerRes as string) as TRes;
}

export function startBattle(syncType: string) {
    const req: ZoneStartBattleReq = { syncType };
    return callZone<ZoneStartBattleReq, ZoneStartBattleRes>(cmdId.ZONE_START_BATTLE, req);
}

export function queryRankList() {
    const req: ZoneQueryRankListReq = { rankId: 1, offset: 0, count: 100 };
    return callZone<ZoneQueryRankListReq, ZoneQueryRankListRes>(cmdId.ZONE_QUERY_RANK_LIST, req);
}

// --- Login form wiring + deferred game bundle load ------------------------

// Idempotent prefetch of the Phase B chunk. Kicked after the login card is
// painted so the ~1–3 MB download overlaps with the user reading/typing,
// instead of starting only after the submit click.
let gameBundlePromise: Promise<typeof import('./game/boot')> | null = null;
function prefetchGameBundle() {
    if (!gameBundlePromise) {
        gameBundlePromise = import('./game/boot');
        // Drop the rejection so a transient failure doesn't poison later retries.
        gameBundlePromise.catch(() => { gameBundlePromise = null; });
    }
    return gameBundlePromise;
}

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
    // Fade via CSS, then hide. Timer matches the 220ms transition.
    overlay.classList.add('is-fading');
    window.setTimeout(() => { overlay.style.display = 'none'; }, 260);
}

export async function start() {
    const loginCard = document.getElementById('login-card');
    setLoadingDetail('Fetching zone list');
    const res = await getZoneList();
    hideLoading();
    if (loginCard) loginCard.style.display = '';

    const zoneidSelect = document.querySelector<HTMLSelectElement>('select#zoneid');
    if (res && zoneidSelect) {
        zoneidSelect.innerHTML = ''; // clear stale options on HMR
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
    // Parcel's minifier strips default `type="submit"`; pick first button instead.
    const submitBtn = form?.querySelector<HTMLButtonElement>('button');

    if (!nameInput || !zoneidSelect || !form || !submitBtn) {
        console.error('login form elements missing', {
            nameInput: !!nameInput,
            zoneidSelect: !!zoneidSelect,
            form: !!form,
            submitBtn: !!submitBtn,
        });
        return;
    }

    // PreloadScene dispatches this once its first frame renders.
    window.addEventListener('dogsvr:phaser-ready', () => hideLoading(), { once: true });

    // Login card is now visible → first paint is done. Warm up the Phase B
    // chunk in the background so the ~1–3 MB of Phaser + rexUI overlaps with
    // the user reading the form, not the "Entering game…" wait. Uses
    // requestIdleCallback when available to yield to any pending main-thread
    // work; falls back to setTimeout(0) on Safari.
    const kickPrefetch = () => { void prefetchGameBundle(); };
    if (typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(kickPrefetch, { timeout: 2000 });
    } else {
        window.setTimeout(kickPrefetch, 0);
    }

    form.onsubmit = async (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) {
            if (errorEl) errorEl.textContent = 'Please enter a name.';
            return;
        }
        // Count code points (1 CJK = 1); `name.length` is UTF-16 units and
        // would over-count surrogate-pair emoji.
        if (Array.from(name).length > NAME_MAX_CHARS) {
            if (errorEl) errorEl.textContent = `Name must be ${NAME_MAX_CHARS} characters or fewer.`;
            return;
        }
        // openId = deviceId + name, stable across same-name collisions on other devices.
        const openId = composeOpenId(getDeviceId(), name);
        if (errorEl) errorEl.textContent = '';
        submitBtn.disabled = true;
        submitBtn.textContent = 'Loading...';

        // Show overlay BEFORE hiding the card — reverse order flashes blank.
        showLoading('Signing in…', 'Contacting server');
        if (loginCard) loginCard.style.display = 'none';

        // Surface bundle-fetch failure to the overlay; the await below will still catch it.
        // Reuses the prefetched promise when available — falls back to a fresh
        // import() if prefetch never ran or failed.
        const bundlePromise = prefetchGameBundle();
        bundlePromise.then(undefined, (err) => {
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
                if (loginCard) loginCard.style.display = '';
                hideLoading();
                return;
            }

            setLoadingTitle('Entering game…');
            setLoadingDetail('Loading game assets');
            const mod = await bundlePromise;
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
