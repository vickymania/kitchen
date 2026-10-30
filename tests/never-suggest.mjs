// The never-suggest list the tests use. The household's own word list is
// private data (public/shared/excluded-words.js), so the tests bring a
// made-up one: sprouts, the brand "Groenhof" and the brand "Groene Ster".
// Import it first; tests/mcp.test.mjs also preloads it into the MCP server.
import { useExcludedWords } from "../public/shared/excluded.js";

export const TEST_EXCLUDED = {
  WORDS: ["spruitjes", "spruitje", "spruiten", "groenhof"],
  PHRASES: ["groene ster"],
  ENDINGS: ["spruitjes", "spruiten"],
  LOOKALIKE: /\bspruitsmaak\b/i,
};

useExcludedWords(TEST_EXCLUDED);
