const MAX_SLUG_LENGTH = 90;

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
}

export function normalizeTags(input) {
  if (!input) return [];
  const tags = Array.isArray(input) ? input : String(input).split(",");
  const normalized = tags
    .map((tag) => String(tag || "").trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
  return Array.from(new Set(normalized));
}

export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function formatDate(value) {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function stripLinePrefix(line) {
  return line
    .replace(/^#{1,3}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

export function contentToPlainText(content) {
  return String(content || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(stripLinePrefix)
    .filter(Boolean)
    .join(" ");
}

export function excerptFromContent(content, maxLength = 165) {
  const text = contentToPlainText(content);
  if (!text) return "";
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

export function estimateReadingMinutes(content) {
  const words = contentToPlainText(content).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/(\*\*|__)(.*?)\1/g, "<strong>$2</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function renderRichText(content) {
  const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let idx = 0;

  while (idx < lines.length) {
    const current = lines[idx];
    const trimmed = current.trim();

    if (!trimmed) {
      idx += 1;
      continue;
    }

    if (/^###\s+/.test(trimmed)) {
      blocks.push(`<h3>${renderInline(trimmed.replace(/^###\s+/, ""))}</h3>`);
      idx += 1;
      continue;
    }

    if (/^##\s+/.test(trimmed)) {
      blocks.push(`<h2>${renderInline(trimmed.replace(/^##\s+/, ""))}</h2>`);
      idx += 1;
      continue;
    }

    if (/^-\s+/.test(trimmed) || /^\*\s+/.test(trimmed)) {
      const items = [];
      while (idx < lines.length) {
        const line = lines[idx].trim();
        if (!/^(-|\*)\s+/.test(line)) break;
        items.push(`<li>${renderInline(line.replace(/^(-|\*)\s+/, ""))}</li>`);
        idx += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (idx < lines.length) {
        const line = lines[idx].trim();
        if (!/^\d+\.\s+/.test(line)) break;
        items.push(`<li>${renderInline(line.replace(/^\d+\.\s+/, ""))}</li>`);
        idx += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paragraph = [];
    while (idx < lines.length) {
      const line = lines[idx].trim();
      if (!line) break;
      if (/^#{2,3}\s+/.test(line)) break;
      if (/^(-|\*)\s+/.test(line)) break;
      if (/^\d+\.\s+/.test(line)) break;
      paragraph.push(renderInline(line));
      idx += 1;
    }
    blocks.push(`<p>${paragraph.join("<br />")}</p>`);
  }

  return blocks.join("\n");
}
