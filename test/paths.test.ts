import { describe, expect, it } from "vitest";

import { AuthorizationError, createPathGuards } from "../src/paths.js";

describe("remote path guards", () => {
  it("denies read paths outside independent read prefix", () => {
    // Given
    const guards = createPathGuards({ readOnly: false, allowedReadPrefix: "/public" });

    // When
    const read = (): void => {
      guards.guardRead("/private/secret.txt");
    };

    // Then
    expect(read).toThrow(AuthorizationError);
  });

  it("denies mutations before write-prefix matching in read-only mode", () => {
    // Given
    const guards = createPathGuards({ readOnly: true, allowedWritePrefix: "/deploy" });

    // When
    const write = (): void => {
      guards.guardWrite("/deploy/site.txt");
    };

    // Then
    expect(write).toThrow("read-only");
  });

  it("denies destructive actions after write authorization", () => {
    // Given
    const guards = createPathGuards({
      readOnly: false,
      destructiveActionsAllowed: false,
      allowedWritePrefix: "/deploy",
    });

    // When
    const destroy = (): void => {
      guards.guardDestructive("/deploy/site.txt");
    };

    // Then
    expect(destroy).toThrow("SFTP_ALLOW_DESTRUCTIVE=false");
  });
});
