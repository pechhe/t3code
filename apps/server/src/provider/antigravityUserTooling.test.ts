import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import { isAntigravityTextGenerationAvailable } from "../textGeneration/AntigravityTextGeneration.ts";
import { prepareAntigravityProfile } from "./antigravityAuthSupport.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Antigravity user tooling", (it) => {
  const setup = Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const userHome = path.join(directory, "home");
    const profileDirectory = path.join(directory, "profile");
    const userConfig = path.join(userHome, ".gemini", "config");
    const profileConfig = path.join(profileDirectory, "config");
    yield* fs.makeDirectory(userConfig, { recursive: true });
    const prepare = prepareAntigravityProfile({ profileDirectory, userHome });
    return { fs, path, userConfig, profileConfig, profileDirectory, prepare };
  });

  it.effect.skipIf(!symlinksSupported)(
    "links the user's MCP servers, hooks and plugins over the CLI's empty placeholder only",
    () =>
      Effect.gen(function* () {
        const { fs, path, userConfig, profileConfig, prepare } = yield* setup();
        const servers = '{"mcpServers":{"executor":{"serverUrl":"https://mcp.example/mcp"}}}';
        yield* fs.writeFileString(path.join(userConfig, "mcp_config.json"), servers);
        yield* fs.writeFileString(path.join(userConfig, "hooks.json"), '{"hooks":{}}');
        yield* fs.makeDirectory(path.join(userConfig, "plugins", "rtk"), { recursive: true });
        yield* fs.makeDirectory(profileConfig, { recursive: true });
        yield* fs.writeFileString(path.join(profileConfig, "mcp_config.json"), "");
        yield* fs.writeFileString(path.join(profileConfig, "hooks.json"), '{"own":{}}');

        yield* prepare;
        expect(yield* fs.readFileString(path.join(profileConfig, "mcp_config.json"))).toBe(servers);
        expect(yield* fs.readFileString(path.join(profileConfig, "hooks.json"))).toBe('{"own":{}}');
        expect(yield* fs.readLink(path.join(profileConfig, "plugins"))).toBe(
          path.join(userConfig, "plugins"),
        );

        yield* fs.remove(path.join(userConfig, "mcp_config.json"));
        yield* prepare;
        expect(yield* fs.exists(path.join(profileConfig, "mcp_config.json"))).toBe(false);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps text generation off a profile that runs the user's plugins",
    () =>
      Effect.gen(function* () {
        const { fs, path, userConfig, profileDirectory, prepare } = yield* setup();
        yield* fs.makeDirectory(path.join(userConfig, "plugins"), { recursive: true });
        yield* prepare;
        expect(yield* isAntigravityTextGenerationAvailable(profileDirectory)).toBe(true);

        yield* fs.makeDirectory(path.join(userConfig, "plugins", "rtk"));
        expect(yield* isAntigravityTextGenerationAvailable(profileDirectory)).toBe(false);
      }),
  );
});
