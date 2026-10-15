import { createPeerEnvironmentAtoms } from "@t3tools/client-runtime/state/peers";

import { connectionAtomRuntime } from "../connection/runtime";

export const peerEnvironments = createPeerEnvironmentAtoms(connectionAtomRuntime);
