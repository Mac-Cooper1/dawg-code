export {
  type InstallRipgrepOptions,
  type InstallRipgrepResult,
  installRipgrep,
  RIPGREP_BINARY,
  RIPGREP_MANIFEST,
  type RipgrepManifest,
  type VerifyRipgrepResult,
  verifyInstalledRipgrep,
} from "./install.ts";
export {
  currentTarget,
  defaultBinRoot,
  defaultLockPath,
  fetchedBinaryPath,
  isRipgrepTarget,
  RIPGREP_TARGETS,
  type RipgrepArchive,
  type RipgrepLock,
  type RipgrepTarget,
  readRipgrepLock,
  ripgrepLockSchema,
} from "./lock.ts";
export {
  clearRipgrepCache,
  type ResolveRipgrepOptions,
  RIPGREP_ENV_VAR,
  type RipgrepLocation,
  RipgrepNotFoundError,
  type RipgrepSource,
  resolveRipgrep,
  type VerifyOutcome,
  verifyByRunning,
} from "./resolve.ts";
