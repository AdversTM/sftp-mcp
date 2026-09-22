import type { LogSink } from "./log-sink.js";

export function createEntrypointLogger(sink: LogSink | undefined): (message: string) => void {
  return (message: string): void => {
    console.error(message);
    sink?.write(message);
  };
}
