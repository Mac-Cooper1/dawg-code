import { describe, expect, test } from "vitest";
import {
  ErrorCodes,
  makeError,
  makeNotification,
  makeRequest,
  makeSuccess,
  parseJson,
  parseMessage,
  RpcError,
} from "./jsonrpc.ts";
import { checkProtocolVersion } from "./version.ts";

describe("parseMessage", () => {
  test("classifies each kind of message", () => {
    expect(parseMessage(makeRequest(1, "session.list", {})).kind).toBe("request");
    expect(parseMessage(makeNotification("message.delta", {})).kind).toBe("notification");
    expect(parseMessage(makeSuccess("a", { ok: true })).kind).toBe("success");
    expect(parseMessage(makeError(null, -32600, "bad")).kind).toBe("error");
  });

  test("a success with a null result is still a success", () => {
    expect(parseMessage({ jsonrpc: "2.0", id: 1, result: null }).kind).toBe("success");
  });

  test("void results are sent as null", () => {
    expect(makeSuccess(1, undefined)).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  test.each([
    ["a number", 42, null],
    ["null", null, null],
    ["a batch", [makeRequest(1, "x")], null],
    ["a missing version", { id: 3, method: "x" }, 3],
    ["a wrong version", { jsonrpc: "1.0", id: 4, method: "x" }, 4],
    ["a null id on a request", { jsonrpc: "2.0", id: null, method: "x" }, null],
    ["a fractional id", { jsonrpc: "2.0", id: 1.5, method: "x" }, null],
    ["params that are a string", { jsonrpc: "2.0", id: 5, method: "x", params: "p" }, 5],
    ["an empty method", { jsonrpc: "2.0", id: 6, method: "" }, 6],
    ["a bare object", { jsonrpc: "2.0", id: 7 }, 7],
    ["an error without a code", { jsonrpc: "2.0", id: 8, error: { message: "x" } }, 8],
  ])("rejects %s without throwing", (_label, value, id) => {
    const parsed = parseMessage(value);
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.id).toBe(id);
      expect(parsed.error.code).toBe(ErrorCodes.InvalidRequest);
    }
  });

  test("strips unknown envelope fields", () => {
    const parsed = parseMessage({ jsonrpc: "2.0", method: "x", params: {}, extra: 1 });
    expect(parsed).toEqual({
      kind: "notification",
      message: { jsonrpc: "2.0", method: "x", params: {} },
    });
  });
});

describe("parseJson", () => {
  test("reports failure instead of throwing", () => {
    expect(parseJson("{")).toMatchObject({ ok: false });
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("RpcError", () => {
  test("serialises to an error object and back", () => {
    const error = new RpcError(ErrorCodes.SessionBusy, "Busy", { turnId: "t1" });
    expect(error.toJSON()).toEqual({ code: -32002, message: "Busy", data: { turnId: "t1" } });
    expect(RpcError.fromObject(error.toJSON())).toMatchObject({ code: -32002, message: "Busy" });
    expect(new RpcError(1, "x").toJSON()).toEqual({ code: 1, message: "x" });
  });

  test("application codes sit in the range JSON-RPC reserves for servers", () => {
    const application = [
      ErrorCodes.SessionNotFound,
      ErrorCodes.SessionBusy,
      ErrorCodes.InvalidState,
      ErrorCodes.UnsupportedProtocolVersion,
      ErrorCodes.NotInitialized,
      ErrorCodes.RequestNotFound,
      ErrorCodes.RequestCancelled,
      ErrorCodes.RequestTimeout,
      ErrorCodes.ConnectionClosed,
    ];
    for (const code of application) {
      expect(code).toBeLessThanOrEqual(-32000);
      expect(code).toBeGreaterThanOrEqual(-32099);
    }
    expect(new Set(Object.values(ErrorCodes)).size).toBe(Object.values(ErrorCodes).length);
  });
});

describe("checkProtocolVersion", () => {
  test("accepts supported versions and explains unsupported ones", () => {
    expect(checkProtocolVersion(1, [1])).toBeNull();
    const error = checkProtocolVersion(2, [1]);
    expect(error?.code).toBe(ErrorCodes.UnsupportedProtocolVersion);
    expect(error?.data).toEqual({ requested: 2, supported: [1] });
  });
});
