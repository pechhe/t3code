import * as Layer from "effect/Layer";
import * as AdviceService from "../agents/AdviceService.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";

export const layer = RemoteDelegation.layer.pipe(Layer.provideMerge(AdviceService.layer));
