import { Head } from "./head"

export interface ReqCommon {
    head: Head,
    innerReq: Uint8Array | string
}

export interface ResCommon {
    head: Head,
    innerRes: Uint8Array | string
}
