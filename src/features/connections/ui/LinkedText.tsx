import { openUrl } from "@tauri-apps/plugin-opener";

const URL_PATTERN = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Splits text into plain parts and web links, such as the sign-in link
 * Tailscale SSH prints before it lets a connection through. */
export function linkParts(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: match[0], url: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Text whose web links open in the user's browser. */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((part, index) =>
        part.url ? (
          <a
            key={index}
            href={part.url}
            className="underline underline-offset-2 hover:opacity-80"
            onClick={(event) => {
              event.preventDefault();
              void openUrl(part.url!).catch(() => undefined);
            }}
          >
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
