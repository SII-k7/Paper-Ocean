import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  codexAppServerArgs,
  normalizeModelCatalog,
  resolveCodexExecutable,
  splitAdditionalContextValue,
} from "../electron/codex-client.mjs";

test("Paper Ocean starts Codex app-server on the stable HTTP streaming transport", () => {
  assert.deepEqual(codexAppServerArgs(), [
    "--disable",
    "responses_websockets",
    "--disable",
    "responses_websockets_v2",
    "app-server",
  ]);
});

test("selected paper excerpts are losslessly split below the Codex context limit", () => {
  const source = `selected ${"A".repeat(1_700)} ${"海".repeat(400)} end`;
  const chunks = splitAdditionalContextValue(source);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 800));
});

test("model catalog exposes only the three requested GPT-5.6 models", () => {
  const models = normalizeModelCatalog({
    data: [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "ultra" },
        ],
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6-Terra",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6-Luna",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "max" },
        ],
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
      {
        id: "gpt-5.6-sol-hidden",
        hidden: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
    ],
  });

  assert.deepEqual(models.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  assert.equal(models[0].defaultEffort, "low");
  assert.deepEqual(models[2].supportedEfforts, ["low", "medium", "max"]);
  assert.equal(models[2].supportedEfforts.includes("ultra"), false);
});

test("manual Codex executable path wins on macOS", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-codex-path-"));
  const executable = path.join(tempRoot, "codex");
  try {
    await fs.writeFile(executable, "placeholder", "utf8");
    assert.equal(resolveCodexExecutable(
      { PAPER_OCEAN_CODEX_PATH: executable },
      { platform: "darwin", homeDir: tempRoot },
    ), executable);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
