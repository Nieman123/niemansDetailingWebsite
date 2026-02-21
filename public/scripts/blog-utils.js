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
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
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
  let rendered = escapeHtml(value);
  const tokens = [];

  function putToken(html) {
    const token = `%%INLINE_TOKEN_${tokens.length}%%`;
    tokens.push({ token, html });
    return token;
  }

  function restoreTokens(input) {
    return tokens.reduce((acc, entry) => acc.split(entry.token).join(entry.html), input);
  }

  function applyBasicFormatting(input) {
    return input
      .replace(/(\*\*|__)(.*?)\1/g, "<strong>$2</strong>")
      .replace(/\*([^\*]+)\*/g, "<em>$1</em>")
      .replace(/\b_([^_]+)_\b/g, "<em>$1</em>")
      .replace(/~~(.*?)~~/g, "<del>$1</del>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function parseMarkdownTarget(rawTarget) {
    const target = String(rawTarget || "").trim();
    const match = target.match(/^(\S+)(?:\s+["'](.+?)["'])?$/);
    if (!match) return { url: target, title: "" };
    return { url: match[1] || "", title: match[2] || "" };
  }

  function sanitizeUrl(rawUrl) {
    let url = String(rawUrl || "").trim();
    if (!url) return "";
    if (/^www\./i.test(url)) url = `https://${url}`;
    if (/[\u0000-\u001F\u007F]/.test(url)) return "";

    const normalized = url.replace(/&amp;/g, "&").toLowerCase();
    if (
      normalized.startsWith("http://") ||
      normalized.startsWith("https://") ||
      normalized.startsWith("mailto:") ||
      normalized.startsWith("tel:") ||
      normalized.startsWith("/") ||
      normalized.startsWith("./") ||
      normalized.startsWith("../") ||
      normalized.startsWith("#") ||
      normalized.startsWith("?")
    ) {
      return url;
    }
    return "";
  }

  function isExternalUrl(url) {
    return /^https?:\/\//i.test(String(url || "").replace(/&amp;/g, "&"));
  }

  // Protect inline code first so markdown syntax inside code is left untouched.
  rendered = rendered.replace(/`([^`]+)`/g, (_, code) => putToken(`<code>${code}</code>`));

  rendered = rendered.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, altText, rawTarget) => {
    const { url, title } = parseMarkdownTarget(rawTarget);
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return match;

    const safeAlt = String(altText || "").trim();
    const titleAttr = title ? ` title="${title}"` : "";
    return putToken(
      `<img src="${safeUrl}" alt="${safeAlt}" loading="lazy"${titleAttr} />`
    );
  });

  rendered = rendered.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, rawTarget) => {
    const { url, title } = parseMarkdownTarget(rawTarget);
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return match;

    const linkText = applyBasicFormatting(String(label || ""));
    const titleAttr = title ? ` title="${title}"` : "";
    if (isExternalUrl(safeUrl)) {
      return putToken(
        `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer"${titleAttr}>${linkText}</a>`
      );
    }
    return putToken(`<a href="${safeUrl}"${titleAttr}>${linkText}</a>`);
  });

  rendered = applyBasicFormatting(rendered);
  return restoreTokens(rendered);
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

    if (/^---/.test(trimmed)) {
      blocks.push("<hr />");
      idx += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const language = trimmed.replace(/^```/, "").trim();
      idx += 1;
      const codeLines = [];
      while (idx < lines.length) {
        if (/^\s*```/.test(lines[idx])) {
          idx += 1;
          break;
        }
        codeLines.push(escapeHtml(lines[idx]));
        idx += 1;
      }
      const langClass = language ? ` class="language-${escapeHtml(language)}"` : "";
      blocks.push(`<pre><code${langClass}>${codeLines.join("\n")}</code></pre>`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      idx += 1;
      continue;
    }

    if (/^>\s+/.test(trimmed)) {
      const items = [];
      while (idx < lines.length) {
        const line = lines[idx].trim();
        if (!line || !/^>\s+/.test(line)) break;
        items.push(renderInline(line.replace(/^>\s+/, "")));
        idx += 1;
      }
      blocks.push(`<blockquote>${items.join("<br />")}</blockquote>`);
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
      if (/^---/.test(line)) break;
      if (/^```/.test(line)) break;
      if (/^#{1,6}\s+/.test(line)) break;
      if (/^>\s+/.test(line)) break;
      if (/^(-|\*)\s+/.test(line)) break;
      if (/^\d+\.\s+/.test(line)) break;
      paragraph.push(renderInline(line));
      idx += 1;
    }
    blocks.push(`<p>${paragraph.join("<br />")}</p>`);
  }

  return blocks.join("\n");
}
