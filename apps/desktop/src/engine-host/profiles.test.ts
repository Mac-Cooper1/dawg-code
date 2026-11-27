import { describe, expect, it } from "vitest";
import { profileIdFor, profileIdForModel } from "./profiles.ts";

describe("profileIdFor", () => {
  it("uses the profile the grant names when the engine has it", () => {
    expect(
      profileIdFor({ modelId: "file:9f2c", serverName: "my-model", catalogProfile: "gpt-oss" }),
    ).toBe("gpt-oss");
    // The grant's profile wins over what the name suggests.
    expect(
      profileIdFor({
        modelId: "qwen3.8-27b-q8",
        serverName: "qwen3.8-27b-q8",
        catalogProfile: "laguna-xs-2.1",
      }),
    ).toBe("laguna-xs-2.1");
  });

  it("falls back to the model's family when the grant names no profile, or an unknown one", () => {
    expect(profileIdFor({ modelId: "qwen3.8-27b-q8", serverName: "x", catalogProfile: null })).toBe(
      "qwen3.8",
    );
    expect(
      profileIdFor({ modelId: "qwen3.6-35b-a3b-q4", serverName: "x", catalogProfile: "qwen9" }),
    ).toBe("qwen3.6");
    // A file added by hand: its id says nothing, the server's name for it does.
    expect(
      profileIdFor({
        modelId: "file:9f2c",
        serverName: "Laguna-XS-2.1-Q4_K_M",
        catalogProfile: null,
      }),
    ).toBe("laguna-xs-2.1");
    expect(
      profileIdFor({ modelId: "ollama/llama3:8b", serverName: "llama3:8b", catalogProfile: null }),
    ).toBeNull();
  });
});

describe("profileIdForModel", () => {
  it("reads only the last part of a path or server id", () => {
    expect(profileIdForModel("remote:1f3a9c/gpt-oss-120b")).toBe("gpt-oss");
    // The helper's grant names its catalog id.
    expect(profileIdForModel("minicpm5-1b-q8")).toBe("minicpm5");
    expect(profileIdForModel("/models/qwen3.8/other.gguf")).toBeNull();
  });
});
