import type { Atom } from "effect/reactivity";
import { createPeerEnvironmentAtoms } from "@t3tools/client-runtime/state/peers";

import { connectionAtomRuntime } from "../connection/runtime";

type PeerAtoms<R, E> = ReturnType<typeof createPeerEnvironmentAtoms<R, E>>;
type RuntimePeers<T> = T extends Atom.AtomRuntime<infer R, infer E> ? PeerAtoms<R, E> : never;

export const peerEnvironments: RuntimePeers<typeof connectionAtomRuntime> =
  createPeerEnvironmentAtoms(connectionAtomRuntime);
