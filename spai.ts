/**
 * SPAI ledger reader/writer for pi-klid — public entry point.
 *
 * Format is 1:1 compatible with pi-spai / mozek_rust:
 *   docs/spai/
 *   ├── .index.json              # fast index (status, tags, deadlines)
 *   └── YYYY-MM-DD-SPAI-NNN-*.md # SPAI markdown with YAML frontmatter
 *
 * First non-empty line decides type/status:
 *   .   todo       /   working       /.  waiting
 *   x   done       z   cancelled     ?   idea      -   note
 *   !   high priority        @YYYY-MM-DD deadline        :tag: chained tags
 *
 * The implementation lives in src/spai/. This module re-exports the same
 * symbols it always did, so every existing importer is unaffected; the
 * submodules export a few extra internals for each other's use.
 */
export type {
  SpaiIndex,
  SpaiIndexEntry,
  SpaiNoteType,
  SpaiPriority,
  SpaiStatus,
} from "./src/spai/types.js";
export {
  cycleStatus,
  getStatusPrefix,
  parseSpai,
  parseSpaiMarkdown,
  slugify,
} from "./src/spai/parse.js";
export {
  getSpaiDir,
  loadIndex,
  readRecordBody,
  saveRecord,
  updateRecordStatus,
} from "./src/spai/store.js";
