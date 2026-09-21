import { errorMessage } from "./errors.js";

export type McpResult = {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly isError?: true;
};

export type BatchItemResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function ok(text: string): McpResult {
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): McpResult {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

export function wrap(
  handler: (input: unknown) => Promise<McpResult>,
): (input: unknown) => Promise<McpResult> {
  return async (input: unknown): Promise<McpResult> => {
    try {
      return await handler(input);
    } catch (error) {
      return fail(errorMessage(error));
    }
  };
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<readonly BatchItemResult<R>[]> {
  const results: BatchItemResult<R>[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), Math.max(1, items.length)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined) {
          continue;
        }
        try {
          results[index] = { ok: true, value: await mapper(item) };
        } catch (error) {
          results[index] = { ok: false, error: errorMessage(error) };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function batchResult<T>(
  label: string,
  items: readonly T[],
  results: readonly BatchItemResult<unknown>[],
  describe: (item: T) => string,
): McpResult {
  const successful = results.filter((result) => result.ok).length;
  const failed = results.length - successful;
  const lines = results.flatMap((result, index) => {
    if (result.ok) {
      return [];
    }
    const item = items[index];
    return item === undefined ? [] : [`  FAIL ${describe(item)}: ${result.error}`];
  });
  const text = `${label}: ${successful}/${results.length} ok${failed === 0 ? "" : `, ${failed} failed`}${
    lines.length === 0 ? "" : `\n${lines.slice(0, 50).join("\n")}`
  }`;
  return failed === 0 ? ok(text) : { content: [{ type: "text", text }], isError: true };
}
