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

async function zoneLogin(openId: string, zoneId: number): Promise<ZoneLoginRes | null> {
    zoneClient = new WsClient(serviceProto, {
        server: `ws://${window.location.hostname}:20000`,
    });
    const connRes = await zoneClient.connect();
    if (!connRes.isSucc) {
        console.error('zone connect failed', connRes.errMsg);
        return null;
    }
    const req: ZoneLoginReq = { openId, zoneId };
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

async function loadGameBundle(role: any) {
    // Dynamic import: Parcel emits Phaser/rexUI/Colyseus/Matter into a separate
    // chunk that is fetched here — only after the user clicks Login.
    const { createGame } = await import('./game/boot');
    createGame(role);
}

export async function start() {
    const loading = document.getElementById('app-loading');
    const loginCard = document.getElementById('login-card');
    const res = await getZoneList();
    if (loading) loading.style.display = 'none';
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

    const openidInput = document.querySelector<HTMLInputElement>('input#openid');
    const form = document.querySelector<HTMLFormElement>('form#login');
    const errorEl = document.getElementById('login-error');
    // Parcel's HTML minifier strips `type="submit"` because it's the default
    // for `<button>` inside a `<form>`, so a `button[type="submit"]` selector
    // fails in production builds. Just grab the first button inside the form.
    const submitBtn = form?.querySelector<HTMLButtonElement>('button');

    if (!openidInput || !zoneidSelect || !form || !submitBtn) {
        console.error('login form elements missing', {
            openidInput: !!openidInput,
            zoneidSelect: !!zoneidSelect,
            form: !!form,
            submitBtn: !!submitBtn,
            loginCardInDom: !!document.getElementById('login-card'),
            bodyHTMLLen: document.body?.innerHTML.length,
        });
        return;
    }

    form.onsubmit = async (event) => {
        event.preventDefault();
        const openId = openidInput.value.trim();
        if (!openId) {
            if (errorEl) errorEl.textContent = 'Please enter an OpenId.';
            return;
        }
        if (errorEl) errorEl.textContent = '';
        submitBtn.disabled = true;
        submitBtn.textContent = 'Loading...';

        try {
            const loginRes = await zoneLogin(openId, Number(zoneidSelect.value));
            if (!loginRes) {
                if (errorEl) errorEl.textContent = 'Login failed. Check console for details.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Login';
                return;
            }
            if (loginCard) loginCard.style.display = 'none';
            await loadGameBundle(loginRes.role);
        } catch (e: any) {
            if (errorEl) errorEl.textContent = e?.message ?? String(e);
            submitBtn.disabled = false;
            submitBtn.textContent = 'Login';
        }
    };
}
