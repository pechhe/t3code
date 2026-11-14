import { modelMaker } from "@t3tools/contracts";
import type { ProviderIcon } from "@t3tools/provider-core/client";

export type ModelIconMaker =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "deepseek"
  | "moonshot"
  | "alibaba"
  | "meta"
  | "mistral"
  | "zhipu"
  | "minimax";

const MULTI_MODEL_DRIVER_KINDS = new Set(["pi", "opencode", "openrouter"]);

const MAKER_SET: ReadonlySet<ModelIconMaker> = new Set<ModelIconMaker>([
  "openai",
  "anthropic",
  "google",
  "xai",
  "deepseek",
  "moonshot",
  "alibaba",
  "meta",
  "mistral",
  "zhipu",
  "minimax",
]);

function inferMakerFromModelTail(tail: string): ModelIconMaker | null {
  if (!tail) return null;
  if (tail.startsWith("claude")) return "anthropic";
  if (
    tail.startsWith("gpt") ||
    tail.startsWith("chatgpt") ||
    tail.startsWith("codex") ||
    /^o[134](?:$|[-.])/.test(tail)
  ) {
    return "openai";
  }
  if (tail.startsWith("gemini") || tail.startsWith("gemma")) return "google";
  if (tail.startsWith("grok")) return "xai";
  if (tail.startsWith("deepseek")) return "deepseek";
  if (tail.startsWith("kimi") || tail.startsWith("moonshot")) return "moonshot";
  if (tail.startsWith("qwen") || tail.startsWith("qwq")) return "alibaba";
  if (tail.startsWith("llama")) return "meta";
  if (
    tail.startsWith("mistral") ||
    tail.startsWith("mixtral") ||
    tail.startsWith("codestral") ||
    tail.startsWith("devstral") ||
    tail.startsWith("pixtral") ||
    tail.startsWith("magistral")
  ) {
    return "mistral";
  }
  if (tail.startsWith("glm")) return "zhipu";
  if (tail.startsWith("minimax")) return "minimax";
  return null;
}

function inferMakerFromVendorSegment(segment: string): ModelIconMaker | null {
  const normalized = segment.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "openai" || normalized.startsWith("openai-")) return "openai";
  if (normalized === "anthropic") return "anthropic";
  if (
    normalized === "google" ||
    normalized === "google-vertex" ||
    normalized === "google-gemini-cli"
  ) {
    return "google";
  }
  if (normalized === "xai" || normalized === "x-ai") return "xai";
  if (normalized === "deepseek") return "deepseek";
  if (normalized === "moonshotai" || normalized === "moonshot") return "moonshot";
  if (normalized === "alibaba" || normalized === "qwen") return "alibaba";
  if (normalized === "meta" || normalized === "meta-llama") return "meta";
  if (normalized === "mistral" || normalized === "mistralai") return "mistral";
  if (normalized === "z-ai" || normalized === "zai" || normalized === "zhipu") return "zhipu";
  if (normalized === "minimax") return "minimax";
  return null;
}

/**
 * Resolves the upstream model maker for drivers that host models from multiple
 * labs (`pi`, `opencode`, `openrouter`), returning `null` for single-brand
 * drivers or unrecognized/default model slugs so callers fall back to the
 * provider instance icon.
 */
export function resolveModelIconMaker(input: {
  readonly driverKind: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly subProvider?: string | null | undefined;
}): ModelIconMaker | null {
  if (!input.driverKind || !MULTI_MODEL_DRIVER_KINDS.has(input.driverKind)) {
    return null;
  }
  const rawModel = input.model?.trim().toLowerCase();
  if (!rawModel || rawModel === "default") {
    return null;
  }

  const segments = rawModel.split("/").filter((part) => part.length > 0);
  const tail = segments[segments.length - 1] ?? rawModel;
  const fromTail = inferMakerFromModelTail(tail);
  if (fromTail) {
    return fromTail;
  }

  for (const segment of segments.slice(0, -1)) {
    const fromVendor = inferMakerFromVendorSegment(segment);
    if (fromVendor) {
      return fromVendor;
    }
  }

  const contractMaker = modelMaker({
    driverKind: input.driverKind,
    model: rawModel,
  });
  if (MAKER_SET.has(contractMaker as ModelIconMaker)) {
    return contractMaker as ModelIconMaker;
  }

  if (input.subProvider) {
    const fromSubProvider = inferMakerFromVendorSegment(input.subProvider);
    if (fromSubProvider) {
      return fromSubProvider;
    }
  }

  return null;
}

export const MODEL_MAKER_ICONS: Readonly<
  Record<Exclude<ModelIconMaker, "openai" | "anthropic" | "xai">, ProviderIcon>
> = {
  google: {
    viewBox: "0 0 24 24",
    fill: { light: "#4285F4", dark: "#669DF6" },
    paths: [
      {
        d: "M12 2C12 7.523 7.523 12 2 12c5.523 0 10 4.477 10 10 0-5.523 4.477-10 10-10-5.523 0-10-4.477-10-10Z",
        gradient: {
          x1: 2,
          y1: 2,
          x2: 22,
          y2: 22,
          stops: [
            { offset: 0, color: "#1C7DFF" },
            { offset: 0.55, color: "#4E82EE" },
            { offset: 1, color: "#8B6CF7" },
          ],
        },
      },
    ],
  },
  deepseek: {
    viewBox: "0 0 24 24",
    fill: { light: "#4D6BFE", dark: "#6682FF" },
    paths: [
      {
        fillRule: "evenodd",
        d: "M18.6 10.6c1.2-.2 2.4.2 3.1 1-.6 1.5-1.8 2.6-3.3 3-1 3.7-4.5 6.2-8.7 6.2-4.6 0-7.7-2.8-7.7-6.8 0-3.4 2.4-6.3 6.2-6.9.2-1.7 1.1-3.1 2.6-3.9-.2 1.3.2 2.6 1 3.5.5 0 1 .1 1.5.2.9-1 2.2-1.5 3.6-1.4-.4 1-.2 2.1.3 3 .5.6.9 1.3 1.4 2.1ZM7.2 12.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z",
      },
    ],
  },
  moonshot: {
    viewBox: "0 0 24 24",
    fill: { light: "#171717", dark: "#EDEDED" },
    paths: [
      {
        d: "M13.5 3.2A8.8 8.8 0 1 0 20.8 14.5 7.1 7.1 0 0 1 13.5 3.2Z",
      },
      {
        d: "M18.5 4.2l.65 1.85 1.85.65-1.85.65-.65 1.85-.65-1.85L16 6.7l1.85-.65.65-1.85Z",
      },
    ],
  },
  alibaba: {
    viewBox: "0 0 24 24",
    fill: { light: "#615CED", dark: "#847FFF" },
    paths: [
      {
        fillRule: "evenodd",
        d: "M12 2.2 14.9 7h5.2l-2.6 5 2.6 5h-5.2L12 21.8 9.1 17H3.9l2.6-5L3.9 7h5.2L12 2.2Zm0 5.3L8.2 12l3.8 4.5 3.8-4.5L12 7.5Z",
      },
    ],
  },
  meta: {
    viewBox: "0 0 24 24",
    fill: { light: "#0668E1", dark: "#3D8BFF" },
    paths: [
      {
        fillRule: "evenodd",
        d: "M6.8 6.5c-2.6 0-4.8 2.5-4.8 5.6 0 3 2 5.4 4.5 5.4 1.7 0 3-1 4.4-3.3l1.1-1.9 1.1 1.9c1.4 2.3 2.7 3.3 4.4 3.3 2.5 0 4.5-2.4 4.5-5.4 0-3.1-2.2-5.6-4.8-5.6-1.9 0-3.3 1.2-4.7 3.6l-.5.9-.5-.9C10.1 7.7 8.7 6.5 6.8 6.5Zm0 2.3c1.1 0 2 .9 3.1 2.8l.9 1.6-.9 1.5c-.9 1.6-1.9 2.5-3.1 2.5-1.3 0-2.5-1.4-2.5-4.1 0-2.6 1.2-4.3 2.5-4.3Zm10.4 0c1.3 0 2.5 1.7 2.5 4.3 0 2.7-1.2 4.1-2.5 4.1-1.2 0-2.2-.9-3.1-2.5l-.9-1.5.9-1.6c1.1-1.9 2-2.8 3.1-2.8Z",
      },
    ],
  },
  mistral: {
    viewBox: "0 0 24 24",
    fill: { light: "#FA520F", dark: "#FA520F" },
    paths: [
      { d: "M3 3.2h4v3.4H3V3.2Zm14 0h4v3.4h-4V3.2Z", fill: { light: "#FFD800", dark: "#FFD800" } },
      {
        d: "M3 6.6h7.4V10H3V6.6Zm10.6 0H21V10h-7.4V6.6Z",
        fill: { light: "#FFAF00", dark: "#FFAF00" },
      },
      { d: "M3 10h18v3.4H3V10Z", fill: { light: "#FF8205", dark: "#FF8205" } },
      {
        d: "M3 13.4h4v3.4H3v-3.4Zm7.2 0h3.6v3.4h-3.6v-3.4Zm6.8 0h4v3.4h-4v-3.4Z",
        fill: { light: "#FA500F", dark: "#FA500F" },
      },
      {
        d: "M1.6 16.8h6.8v3.4H1.6v-3.4Zm14 0h6.8v3.4h-6.8v-3.4Z",
        fill: { light: "#E10500", dark: "#E10500" },
      },
    ],
  },
  zhipu: {
    viewBox: "0 0 24 24",
    fill: { light: "#3859FF", dark: "#637DFF" },
    paths: [
      {
        d: "M5 5.5h14v3.1L9.6 15.4H19v3.1H5v-3.1l9.4-6.8H5V5.5Z",
      },
    ],
  },
  minimax: {
    viewBox: "0 0 24 24",
    fill: { light: "#F23F5D", dark: "#FF5C77" },
    paths: [
      {
        d: "M3.5 16.5V9.8a3.8 3.8 0 0 1 6.7-2.4L12 9.5l1.8-2.1a3.8 3.8 0 0 1 6.7 2.4v6.7h-3v-6.7a.8.8 0 0 0-1.4-.5L12 14.1 7.9 9.3a.8.8 0 0 0-1.4.5v6.7h-3Z",
      },
    ],
  },
};
