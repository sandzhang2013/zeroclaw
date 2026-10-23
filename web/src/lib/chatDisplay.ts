/** Drop runs of blank lines that `whitespace-pre-wrap` would otherwise paint as a hole.
 *  Closed fences keep their own spacing. */
export function collapseChatBlankRuns(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  const joined = parts
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n')))
    .join('');
  return joined.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:[ \t]*\r?\n)+$/, '');
}
