import { ChampionRelayedApproval, IsoDateTime, MessageId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Verified on the source machine, then rechecked against the request's filing time there. */
export const ForwardedChampionApproval = Schema.Struct({
  quote: ChampionRelayedApproval.fields.quote,
  threadId: ChampionRelayedApproval.fields.threadId,
  threadTitle: ChampionRelayedApproval.fields.threadTitle,
  model: ChampionRelayedApproval.fields.model,
  messageId: MessageId,
  createdAt: IsoDateTime,
});
export type ForwardedChampionApproval = typeof ForwardedChampionApproval.Type;
