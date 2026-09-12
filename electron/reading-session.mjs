// Paper Ocean supplies the paper and conversation explicitly. Development
// plugins and cross-project memories add unrelated work to every first answer.
// These overrides belong only to Paper Ocean's child process / reading threads;
// the user's Codex configuration, login, hooks and permission policy stay intact.
export const READING_SESSION_OVERRIDES = Object.freeze({
  "features.plugins": false,
  "features.apps": false,
  "memories.use_memories": false,
  "memories.generate_memories": false,
});

export function readingSessionConfig(config = {}, skillEntries = []) {
  const paths = new Set();
  for (const entry of config.skills?.config ?? []) {
    if (typeof entry?.path === "string" && entry.path) paths.add(entry.path);
  }
  for (const entry of skillEntries) {
    for (const skill of entry?.skills ?? []) {
      if (typeof skill?.path === "string" && skill.path) paths.add(skill.path);
    }
  }
  return {
    ...READING_SESSION_OVERRIDES,
    // A nested table preserves literal server IDs, including dots. Passing
    // quoted IDs in a dotted override creates a different, invalid server.
    mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map(name => [name, { enabled: false }])),
    "skills.config": [...paths].map(path => ({ path, enabled: false })),
  };
}
