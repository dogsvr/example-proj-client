import { ServiceProto } from 'tsrpc-proto';
import { MsgCommon } from './MsgCommon';
import { ReqCommon, ResCommon } from './PtlCommon';

export interface ServiceType {
    api: {
        "Common": {
            req: ReqCommon,
            res: ResCommon
        }
    },
    msg: {
        "Common": MsgCommon
    }
}

export const serviceProto: ServiceProto<ServiceType> = {
    "services": [
        {
            "id": 0,
            "name": "Common",
            "type": "msg"
        },
        {
            "id": 1,
            "name": "Common",
            "type": "api"
        }
    ],
    "types": {
        "MsgCommon/MsgCommon": {
            "type": "Interface",
            "properties": [
                {
                    "id": 0,
                    "name": "head",
                    "type": {
                        "type": "Reference",
                        "target": "head/Head"
                    }
                },
                {
                    "id": 1,
                    "name": "innerMsg",
                    "type": {
                        "type": "Union",
                        "members": [
                            {
                                "id": 0,
                                "type": {
                                    "type": "Buffer",
                                    "arrayType": "Uint8Array"
                                }
                            },
                            {
                                "id": 1,
                                "type": {
                                    "type": "String"
                                }
                            }
                        ]
                    }
                }
            ]
        },
        "head/Head": {
            "type": "Interface",
            "properties": [
                {
                    "id": 0,
                    "name": "cmdId",
                    "type": {
                        "type": "Number"
                    }
                },
                {
                    "id": 1,
                    "name": "openId",
                    "type": {
                        "type": "String"
                    }
                },
                {
                    "id": 2,
                    "name": "zoneId",
                    "type": {
                        "type": "Number"
                    }
                }
            ]
        },
        "PtlCommon/ReqCommon": {
            "type": "Interface",
            "properties": [
                {
                    "id": 0,
                    "name": "head",
                    "type": {
                        "type": "Reference",
                        "target": "head/Head"
                    }
                },
                {
                    "id": 1,
                    "name": "innerReq",
                    "type": {
                        "type": "Union",
                        "members": [
                            {
                                "id": 0,
                                "type": {
                                    "type": "Buffer",
                                    "arrayType": "Uint8Array"
                                }
                            },
                            {
                                "id": 1,
                                "type": {
                                    "type": "String"
                                }
                            }
                        ]
                    }
                }
            ]
        },
        "PtlCommon/ResCommon": {
            "type": "Interface",
            "properties": [
                {
                    "id": 0,
                    "name": "head",
                    "type": {
                        "type": "Reference",
                        "target": "head/Head"
                    }
                },
                {
                    "id": 1,
                    "name": "innerRes",
                    "type": {
                        "type": "Union",
                        "members": [
                            {
                                "id": 0,
                                "type": {
                                    "type": "Buffer",
                                    "arrayType": "Uint8Array"
                                }
                            },
                            {
                                "id": 1,
                                "type": {
                                    "type": "String"
                                }
                            }
                        ]
                    }
                }
            ]
        }
    }
};