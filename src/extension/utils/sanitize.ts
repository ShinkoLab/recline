export function sanitizeUserInput(text: string): string {
  return text
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/[\x00-\x09\x0B-\x1F]/g, '') // Remove control chars except newline
    .trim();
}

export function sanitizeTerminalOutput(
  text: string,
  options?: {
    /**
     * If true, combine responses from multiple commands into single output.
     * Otherwise, treat each command response as separate message.
     */
    combineResponses?: boolean;
  }
): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // Remove ANSI escape sequences
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\r/g, '\n')
    .replace(/\u001b\[.*?[@-~]/g, '') // Remove ANSI escape sequences
    .trim();
}
