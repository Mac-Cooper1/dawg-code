export const packageName = "@dawg/mock-model";

export {
  contextOverflow,
  dropped,
  empty,
  httpError,
  invalidResponse,
  malformedToolCall,
  nonStreaming,
  reasoning,
  stalled,
  streamError,
  text,
  toolCall,
  toolCalls,
} from "./builders.ts";
export {
  contentText,
  MAIN_LANE,
  matches,
  parseScript,
  ScriptError,
  validateReply,
} from "./script.ts";
export { type MockModel, startMockModel, type UnansweredRequest } from "./server.ts";
export type {
  Fault,
  LaneSpec,
  MatchSpec,
  MockModelOptions,
  Pacing,
  RecordedRequest,
  RequestMatcher,
  Script,
  ScriptReply,
  ScriptToolCall,
  ScriptUsage,
  TemplateCaps,
  WireOptions,
} from "./types.ts";
