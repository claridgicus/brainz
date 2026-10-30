export type {
  ConceptType,
  AnyConceptType,
  ConceptStatus,
  TaskStatus,
  ConceptMeta,
  Concept,
  Edge,
  SearchOptions,
  SearchHit,
  RelatedOptions,
  RelatedNode,
  ContextOptions,
  ContextBundle,
  UpsertInput,
  VaultStats,
} from "./types.js";

export { slugify } from "./slugify.js";

export { extractWikiLinks, parseNote, readFrontmatter, serializeNote } from "./note.js";
export type { NoteMeta, ParsedNote, ParseNoteOptions } from "./note.js";

export { cosineSim, packVector, rrfFuse, unpackVector } from "./search.js";
export type { FusedResult } from "./search.js";

export { bfsRelated } from "./graph.js";

export { assembleContext } from "./context.js";
export type { AssembleContextOptions, ContextSource } from "./context.js";

export {
  ONBOARDING_NOTICE,
  ONBOARDING_NUDGE,
  ONBOARDING_SUMMARY_ID,
  onboardingPlaybook,
  computeCoverage,
} from "./onboard.js";
export type { OnboardingPlaybookOptions, Coverage, CoverageConcept } from "./onboard.js";

export {
  SYNC_STALENESS_DAYS,
  SYNC_STALENESS_MS,
  SYNC_STALENESS_NOTICE,
  SYNC_STALENESS_NUDGE,
  isSyncStale,
  syncPlaybook,
} from "./sync.js";
export type { SyncPlaybookOptions } from "./sync.js";

export { TASK_COMPLETE_NOTICE, TASK_COMPLETE_REMINDER } from "./tasks.js";

export {
  DEFAULT_MCP_SERVER_NAME,
  SESSION_BLOCK_END,
  SESSION_BLOCK_START,
  SESSION_HOOK_CLIENTS,
  SESSION_PRIMER_PATH,
  claudeCodeSessionHook,
  serverInstructions,
  sessionHookPlaybook,
  sessionInstructions,
} from "./session.js";
export type {
  SessionHookClient,
  SessionHookPlaybookOptions,
  ServerInstructionsOptions,
  SessionInstructionsOptions,
} from "./session.js";

export {
  DREAM_DEFAULTS,
  DREAM_DEFAULT_CADENCE_HOURS,
  DREAM_LLM_PROVIDERS,
  DREAM_MODEL_RE,
  DREAM_MODES,
  DREAM_SETTINGS_BOUNDS,
  DREAM_SETTINGS_DEFAULTS,
  DREAM_MAX_CADENCE_HOURS,
  DREAM_MIN_CADENCE_HOURS,
  DREAM_PROMOTABLE_TYPES,
  DREAM_PROTECTED_IDS,
  DREAM_REM_SYSTEM,
  advanceSweep,
  clampCadenceHours,
  decideEntry,
  diaryEntry,
  dreamId,
  dreamOptionsFromSettings,
  extractOutcome,
  isEmptySweep,
  lexicalSimilarity,
  nextDreamDue,
  normalizeDreamSettings,
  parseRemResponse,
  patchDreamSettings,
  planDeep,
  remChunkPrompt,
  renderDiaryEntry,
  selectProposals,
  startSweep,
} from "./dream.js";
export type {
  ContradictionProposal,
  DreamAppliedChange,
  DreamChangeKind,
  DreamConcept,
  DreamDiaryEntry,
  DreamEntryStatus,
  DreamLlm,
  DreamLlmProvider,
  DreamMode,
  DreamOp,
  DreamOptions,
  DreamPhase,
  DreamPhaseToggles,
  DreamProposal,
  DreamPlan,
  DreamRejectReason,
  DreamSettings,
  DreamSettingsPatch,
  DreamSnapshot,
  DreamSweepState,
  DreamTrigger,
  DuplicateCandidate,
  LinkProposal,
  MergeProposal,
  OutcomeCandidate,
  PromoteProposal,
  RemProposals,
} from "./dream.js";

export { validateGraph } from "./validate.js";
export type { GraphIssue, GraphValidation } from "./validate.js";
