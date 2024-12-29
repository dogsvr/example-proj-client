import Phaser from "phaser";
import { MainScene } from "./scenes/main_scene";
import { BattleTestScene } from "./scenes/battle_test_scene";
import { WsClient, HttpClient } from 'tsrpc-browser';
import { serviceProto } from './shared/protocols/serviceProto';
import { MsgCommon } from './shared/protocols/MsgCommon';
import * as cmdId from './shared/cmd_id';

async function getZoneList() {
    const dir_client = new HttpClient(serviceProto, {
        server: `http://${window.location.hostname}:10000`
    });
    const req = {};
    let ret = await dir_client.callApi('Common', {
        head: {
            cmdId: cmdId.DIR_QUERY_ZONE_LIST,
            openId: "",
            zoneId: 0
        },
        innerReq: JSON.stringify(req)
    });

    if (!ret.isSucc) {
        console.log('call failed', ret.err.message);
        return;
    }

    let res = JSON.parse(ret.res.innerRes as string);
    return res;
}

let zone_client = null;
async function zoneLogin(openId: string, zoneId: number, name: string) {
    zone_client = new WsClient(serviceProto, {
        server: `ws://${window.location.hostname}:20000`
    });

    let connRes = await zone_client.connect();
    if (!connRes.isSucc) {
        console.log('connect failed', connRes.errMsg);
        return;
    }

    const req = { openId: openId, zoneId: zoneId };
    let ret = await zone_client.callApi('Common', {
        head: {
            cmdId: cmdId.ZONE_LOGIN,
            openId: openId,
            zoneId: zoneId
        },
        innerReq: JSON.stringify(req)
    });

    if (!ret.isSucc) {
        console.log('call failed', ret.err.message);
        return;
    }

    let res = JSON.parse(ret.res.innerRes as string);
    startGame(res.role);

    zone_client.listenMsg("Common", (msg: MsgCommon) => {
        console.log("recv server push:", msg);
        let ntf = JSON.parse(msg.innerMsg as string);
        if (msg.head.cmdId === cmdId.ZONE_BATTLE_END_NTF) {
            game.registry.set('roleLocal', ntf.role);
            const scene = game.scene.getScene('main') as MainScene;
            scene.onBattleEnd(ntf);
        }
    });
}

export async function startBattle() {
    const role = game.registry.get('roleLocal');
    const req = {};
    let ret = await zone_client.callApi('Common', {
        head: {
            cmdId: cmdId.ZONE_START_BATTLE,
            openId: role.openId,
            zoneId: role.zoneId
        },
        innerReq: JSON.stringify(req)
    });

    if (!ret.isSucc) {
        console.log('call failed', ret.err.message);
        return;
    }

    let res = JSON.parse(ret.res.innerRes as string);
    game.registry.set('startBattleRes', res);
}

let game: Phaser.Game = null;
function startGame(role: {}) {
    const config: Phaser.Types.Core.GameConfig = {
        type: Phaser.AUTO,
        fps: {
            target: 60,
            forceSetTimeOut: true,
            smoothStep: false,
        },
        width: 375,
        height: 812,
        backgroundColor: '#3cb5d5',
        parent: 'game',
        scale: {
            mode: Phaser.Scale.FIT,
            // autoCenter: Phaser.Scale.CENTER_BOTH,
        },
        physics: {
            default: "arcade"
        },
        pixelArt: true,
        scene: [MainScene, BattleTestScene],
    };

    game = new Phaser.Game(config);
    game.registry.set('roleLocal', role);
}

async function main() {
    let res = await getZoneList();
    const zoneidSelect = document.querySelector<HTMLSelectElement>("select#zoneid");
    for (let zone of res.zoneList) {
        const opt = document.createElement("option");
        opt.value = zone.zoneId;
        opt.innerHTML = zone.zoneId;
        zoneidSelect.appendChild(opt);
    }

    const openidInput = document.querySelector<HTMLInputElement>("input#openid");
    const form = document.querySelector<HTMLFormElement>("form#login");
    form.onsubmit = function (event) {
        zoneLogin(openidInput.value, Number(zoneidSelect.value), "");
        form.hidden = true;
        event.preventDefault();
    }
}
main();
