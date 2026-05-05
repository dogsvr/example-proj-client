# example-proj-client

Phaser 4 web client for [`example-proj`](https://github.com/dogsvr/example-proj) — connects to the three reference servers (`dir` / `zonesvr` / `battlesvr`) via `tsrpc-browser` and `@colyseus/sdk`, bundled with Parcel.

## Install

```sh
git clone https://github.com/dogsvr/example-proj-client.git
cd example-proj-client
npm install
```

**Node.js**: tested on **v24.13.0 on Linux (x86-64)**; other maintained LTS lines are expected to work but are not routinely exercised. File an issue if something breaks on your runtime.

## Usage

Start the bundler (Parcel serves on `:4567`):

```sh
npm run start       # http://localhost:4567
```

The servers from [`example-proj`](https://github.com/dogsvr/example-proj) must already be running — the client connects to `dir` on :10000, `zonesvr` on :20000, and `battlesvr`'s Colyseus on :30040.

Scenes live under `src/scenes/`:

- `main_scene` — login, zone list, lobby
- `state_sync_battle_scene` — state-synchronized rooms
- `lockstep_sync_battle_scene` — lockstep rooms

## Role in dogsvr

Reference client for exercising the whole dogsvr stack end-to-end. Not framework code — consider it a worked example of hooking a browser-side game into a dogsvr backend.

## See also

- [`example-proj`](https://github.com/dogsvr/example-proj) — the servers this client talks to, plus the full topology
- [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr) — the framework powering those servers
