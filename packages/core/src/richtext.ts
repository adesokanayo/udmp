import TurndownService from "turndown";
import type { RichText } from "./types.js";

let _td: TurndownService | null = null;
function td(): TurndownService {
  if (_td) return _td;
  _td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  _td.addRule("strike", { filter: ["del", "s"], replacement: (c) => `~~${c}~~` });
  return _td;
}

export function htmlToMarkdown(html: string): string {
  return td().turndown(html).trim();
}

export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>]+/g, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a richtext value from HTML, preserving the original. */
export function richTextFromHtml(html: string | null | undefined): RichText | null {
  if (html === null || html === undefined) return null;
  const markdown = htmlToMarkdown(html);
  return { markdown, plain: markdownToPlain(markdown), original: { format: "html", content: html } };
}

/** Build a richtext value from Markdown the source already provides. */
export function richTextFromMarkdown(md: string | null | undefined): RichText | null {
  if (md === null || md === undefined) return null;
  return { markdown: md, plain: markdownToPlain(md), original: { format: "markdown", content: md } };
}

export function richTextFromPlain(text: string | null | undefined): RichText | null {
  if (text === null || text === undefined) return null;
  return { markdown: text, plain: text, original: { format: "plain", content: text } };
}

/**
 * Minimal Atlassian Document Format → Markdown. Covers the node types that
 * appear in ordinary Jira/Confluence content; unknown nodes fall back to their text.
 */
export function adfToMarkdown(doc: unknown): string {
  const render = (n: AdfNode, depth = 0): string => {
    const kids = (sep = "") => (n.content ?? []).map((c) => render(c, depth)).join(sep);
    switch (n.type) {
      case "doc": return kids("\n\n");
      case "paragraph": return kids();
      case "text": {
        let t = n.text ?? "";
        for (const m of n.marks ?? []) {
          if (m.type === "strong") t = `**${t}**`;
          else if (m.type === "em") t = `*${t}*`;
          else if (m.type === "code") t = `\`${t}\``;
          else if (m.type === "strike") t = `~~${t}~~`;
          else if (m.type === "link") t = `[${t}](${m.attrs?.href ?? ""})`;
        }
        return t;
      }
      case "heading": return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${kids()}`;
      case "bulletList": return (n.content ?? []).map((li) => `${"  ".repeat(depth)}- ${render(li, depth + 1)}`).join("\n");
      case "orderedList": return (n.content ?? []).map((li, i) => `${"  ".repeat(depth)}${i + 1}. ${render(li, depth + 1)}`).join("\n");
      case "listItem": return kids("\n");
      case "codeBlock": return `\`\`\`${n.attrs?.language ?? ""}\n${kids()}\n\`\`\``;
      case "blockquote": return kids("\n").split("\n").map((l) => `> ${l}`).join("\n");
      case "hardBreak": return "\n";
      case "rule": return "---";
      case "mention": return `@${n.attrs?.text ?? n.attrs?.id ?? "mention"}`.replace(/^@@/, "@");
      case "emoji": return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
      case "inlineCard": return String(n.attrs?.url ?? "");
      case "mediaSingle": case "mediaGroup": return kids("\n");
      case "media": return `![${n.attrs?.alt ?? "attachment"}](media:${n.attrs?.id ?? ""})`;
      case "table": return (n.content ?? []).map((row, i) => {
        const cells = (row.content ?? []).map((c) => render(c, depth).replace(/\n/g, " "));
        const line = `| ${cells.join(" | ")} |`;
        return i === 0 ? `${line}\n| ${cells.map(() => "---").join(" | ")} |` : line;
      }).join("\n");
      case "tableRow": return kids(" | ");
      case "tableHeader": case "tableCell": return kids(" ");
      case "panel": return kids("\n").split("\n").map((l) => `> ${l}`).join("\n");
      case "taskList": return kids("\n");
      case "taskItem": return `- [${n.attrs?.state === "DONE" ? "x" : " "}] ${kids()}`;
      default: return kids(" ");
    }
  };
  return render(doc as AdfNode).trim();
}

interface AdfNode { type: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: AdfNode[] }

export function richTextFromAdf(doc: unknown): RichText | null {
  if (doc === null || doc === undefined) return null;
  const markdown = adfToMarkdown(doc);
  return { markdown, plain: markdownToPlain(markdown), original: { format: "adf", content: doc } };
}
