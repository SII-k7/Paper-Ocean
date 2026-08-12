import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  normalizeModelCatalog,
  resolveCodexExecutable,
} from "../electron/codex-client.mjs";

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
