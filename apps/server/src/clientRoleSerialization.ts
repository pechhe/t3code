import { RpcSerialization } from "effect/rpc";

// Role values in compact JSON: a `role` or `agentRole` field, or an `agentRoles` list.
const ROLE_FIELD = /"(role|agentRole)":"implementer"/g;
const ROLE_LIST = /"agentRoles":\[[^\]]*\]/g;

/** Rewrites the role values a client built before `implementer` cannot read; nothing else. */
function downgradeImplementerRole(text: string): string {
  if (!text.includes('"implementer"')) return text;
  return text
    .replace(ROLE_FIELD, '"$1":"implementation-worker"')
    .replace(ROLE_LIST, (list) => list.replaceAll('"implementer"', '"implementation-worker"'));
}

/**
 * JSON RPC serialization for a client that has not opted into the `implementer` role: clients
 * built before it decode a closed list of role names and would reject the whole message, so
 * they get the nearest name they know.
 */
export function rpcSerializationForClient(implementerRole: boolean) {
  if (implementerRole) return RpcSerialization.json;
  return RpcSerialization.RpcSerialization.of({
    ...RpcSerialization.json,
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      return {
        decode: parser.decode,
        encode: (response) => {
          const encoded = parser.encode(response);
          return typeof encoded === "string" ? downgradeImplementerRole(encoded) : encoded;
        },
      };
    },
  });
}
