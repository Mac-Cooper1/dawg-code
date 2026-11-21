/**
 * Version negotiation.
 *
 * The client sends the version it speaks in `initialize`. The engine either speaks it too and
 * echoes it back, or answers `UnsupportedProtocolVersion` with the versions it does speak in
 * `data.supported`. There is no downgrade inside one version: a version names one wire format.
 * A client that gets the error (or, defensively, a different version in the result) must close
 * the connection and tell the person the app and engine are out of step.
 */
import { PROTOCOL_VERSION } from "./common.ts";
import { ErrorCodes, RpcError } from "./jsonrpc.ts";

/** Versions this build of the package can speak. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

export interface UnsupportedVersionData {
  requested: number;
  supported: number[];
}

/** Returns null when `requested` is supported, otherwise the error to answer with. */
export function checkProtocolVersion(
  requested: number,
  supported: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS,
): RpcError | null {
  if (supported.includes(requested)) return null;
  const data: UnsupportedVersionData = { requested, supported: [...supported] };
  return new RpcError(
    ErrorCodes.UnsupportedProtocolVersion,
    `Protocol version ${requested} is not supported; this engine speaks ${supported.join(", ")}`,
    data,
  );
}
