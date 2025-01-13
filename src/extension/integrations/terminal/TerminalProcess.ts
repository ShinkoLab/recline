import type * as vscode from "vscode";

import type { TerminalProcessEvents } from "./types";

import { EventEmitter } from "node:events";

import stripAnsi from "strip-ansi";


const PROCESS_HOT_TIMEOUT_NORMAL = 2_000;
const PROCESS_HOT_TIMEOUT_COMPILING = 15_000;

const regexes = {
  LINE_ENDINGS: /\r\n/g,
  STANDALONE_CR: /\r/g,
  NON_ASCII_CONTROL: /[\x00-\x09\x0B-\x1F\x7F-\uFFFF]/g,
  PROMPT_CHARS: /[%$#>]\s*$/,
  VS_CODE_SEQUENCE: /\x1B\]633;.[^\x07]*\x07/g,
  NON_PRINTABLE: /[^\x20-\x7E]/g,
  COMMAND_START_SEQUENCE: /\]633;C([\s\S]*?)\]633;D/,
  LEADING_NON_ALPHANUMERIC: /^[^a-z0-9]*/i,
  RANDOM_COMMAS: /,/g
};

function sanitizeOutput(output: string): string {
  return output
    .replace(regexes.LINE_ENDINGS, "\n")
    .replace(regexes.STANDALONE_CR, "")
    .replace(regexes.NON_ASCII_CONTROL, "")
    .trim();
}

function sanitizeLines(lines: string[]): string[] {
  return lines
    .map(line =>
      line
        .replace(regexes.PROMPT_CHARS, "")
        .replace(regexes.NON_ASCII_CONTROL, "")
        .trim()
    )
    .filter(line => line.length > 0);
}

function extractVsCodeCommandOutput(data: string): string {
  const output = data.match(regexes.COMMAND_START_SEQUENCE)?.[1] || "";
  return sanitizeOutput(output).trim();
}

export class TerminalProcess extends EventEmitter<TerminalProcessEvents> {
  private buffer: string = "";
  private cooldownTimeout: number = PROCESS_HOT_TIMEOUT_NORMAL;
  private fullOutput: string = "";
  private isListening: boolean = true;
  private lastActivityTime: number = 0;
  private lastRetrievedIndex: number = 0;
  // Required elsewhere in the extension... TODO: Fix this hack
  public waitForShellIntegration: boolean = true;

  get isHot(): boolean {
    if (this.lastActivityTime === 0)
      return false;
    return Date.now() - this.lastActivityTime < this.cooldownTimeout;
  }

  private emitIfEol(chunk: string) {
    this.buffer += chunk;
    this.buffer = this.buffer.replace(regexes.LINE_ENDINGS, "\n");

    let lineEndIndex: number;
    while ((lineEndIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = sanitizeOutput(this.buffer.slice(0, lineEndIndex));
      this.emit("line", line);
      this.buffer = this.buffer.slice(lineEndIndex + 1);
    }
  }

  private emitRemainingBufferIfListening() {
    if (this.buffer && this.isListening) {
      const remainingBuffer = this.sanitizeRemainingBuffer(this.buffer);
      if (remainingBuffer) {
        this.emit("line", remainingBuffer);
      }
      this.buffer = "";
      this.lastRetrievedIndex = this.fullOutput.length;
    }
  }

  private sanitizeRemainingBuffer(output: string): string {
    const lines = output.split("\n");
    const sanitizedLines = sanitizeLines(lines);
    return sanitizedLines.join("\n").trimEnd();
  }

  private updateHotState(isCompiling: boolean) {
    this.lastActivityTime = Date.now();
    this.cooldownTimeout = isCompiling
      ? PROCESS_HOT_TIMEOUT_COMPILING
      : PROCESS_HOT_TIMEOUT_NORMAL;
  }

  continue() {
    this.emitRemainingBufferIfListening();
    this.isListening = false;
    this.removeAllListeners("line");
    this.emit("continue");
  }

  getUnretrievedOutput(): string {
    const unretrieved = this.fullOutput.slice(this.lastRetrievedIndex);
    this.lastRetrievedIndex = this.fullOutput.length;
    return this.sanitizeRemainingBuffer(unretrieved);
  }

  async run(terminal: vscode.Terminal, command: string) {
    // Create a unique marker for command output
    const startMarker = `START_CMD_${Date.now()}`;
    const endMarker = `END_CMD_${Date.now()}`;
    
    // Wrap the command with echo markers for output capture
    const wrappedCommand = `
echo "${startMarker}";
{ ${command}; } 2>&1;
EXIT_CODE=$?;
echo "${endMarker}";
exit $EXIT_CODE
`.trim();

    let outputStarted = false;
    let outputBuffer = "";

    // Set up output handling
    const outputHandler = terminal.onDidWriteData((data: string) => {
      const sanitizedData = stripAnsi(data);
      
      if (sanitizedData.includes(startMarker)) {
        outputStarted = true;
        return;
      }

      if (sanitizedData.includes(endMarker)) {
        outputStarted = false;
        // Process any remaining output
        if (outputBuffer) {
          this.processOutput(outputBuffer);
        }
        outputHandler.dispose();
        this.emit("completed");
        this.emit("continue");
        return;
      }

      if (outputStarted) {
        outputBuffer += sanitizedData;
        // Process complete lines
        const lines = outputBuffer.split("\n");
        if (lines.length > 1) {
          // Process all complete lines except the last one
          for (let i = 0; i < lines.length - 1; i++) {
            this.processOutput(lines[i]);
          }
          // Keep the incomplete line in the buffer
          outputBuffer = lines[lines.length - 1];
        }
      }
    });

    // Execute the wrapped command
    terminal.sendText(wrappedCommand, true);
  }

  private processOutput(data: string) {
    if (!data.trim()) return;

    const sanitizedOutput = sanitizeOutput(data);
    if (sanitizedOutput) {
      this.fullOutput += sanitizedOutput + "\n";
      if (this.isListening) {
        this.emit("line", sanitizedOutput);
      }
    }

    // Update hot state based on output content
    const compilingMarkers = [
      "compiling",
      "building",
      "bundling",
      "transpiling",
      "generating",
      "starting"
    ];
    const markerNullifiers = [
      "compiled",
      "success",
      "finish",
      "complete",
      "succeed",
      "done",
      "end",
      "stop",
      "exit",
      "terminate",
      "error",
      "fail"
    ];

    const isCompiling =
      compilingMarkers.some(marker =>
        data.toLowerCase().includes(marker.toLowerCase())
      ) &&
      !markerNullifiers.some(nullifier =>
        data.toLowerCase().includes(nullifier.toLowerCase())
      );

    this.updateHotState(isCompiling);
  }
}

export type TerminalProcessResultPromise = TerminalProcess & Promise<void>;

export function mergePromise(
  process: TerminalProcess,
  promise: Promise<void>
): TerminalProcessResultPromise {
  const nativePromisePrototype = (async () => {})().constructor.prototype;
  const descriptors = ["then", "catch", "finally"].map(property => [
    property,
    Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property)
  ]);
  for (const [property, descriptor] of descriptors) {
    if (descriptor) {
      const value = descriptor.value.bind(promise);
      Reflect.defineProperty(process, property, { ...descriptor, value });
    }
  }
  return process as TerminalProcessResultPromise;
}
