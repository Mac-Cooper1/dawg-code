export const packageName = "@dawg/eval-proxy";

export type { ProxyOptions, RunningProxy } from "./proxy.ts";
export { startProxy } from "./proxy.ts";
export type {
  ApiKind,
  ProxyRecord,
  TimingsRecord,
  ToolCallRecord,
  UsageRecord,
} from "./record.ts";
export {
  ApiKindSchema,
  ProxyRecordSchema,
  TimingsRecordSchema,
  ToolCallRecordSchema,
  UsageRecordSchema,
} from "./record.ts";
