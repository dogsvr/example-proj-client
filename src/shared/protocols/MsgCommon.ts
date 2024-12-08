import { Head } from "./head"

export interface MsgCommon {
    head: Head,
    innerMsg: Uint8Array | string
}
