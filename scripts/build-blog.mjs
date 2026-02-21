import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, where, orderBy } from 'firebase/firestore';

// Define `__dirname` for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Basic Firebase configuration for reading public posts
const firebaseConfig = {
    apiKey: "AIzaSyBgUntKRCQsi_SyJmNOgJLBI8Yj8gEsmA4",
    authDomain: "niemansdetailing.firebaseapp.com",
    projectId: "niemansdetailing",
    storageBucket: "niemansdetailing.firebasestorage.app",
};

// --- Re-implementing necessary utils for Node.js context ---
export function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function toDate(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate(); // Firestore Timestamp handling
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
// --- End Utils ---


function getPostUrl(slug) {
    return `/blog/${encodeURIComponent(slug)}.html`;
}

async function fetchPosts() {
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const postsQuery = query(
        collection(db, "blogPosts"),
        where("status", "==", "published"),
        //orderBy("publishedAt", "desc") // Commenting out to avoid needing a composite index. We will sort manually instead.
    );

    console.log("Fetching posts from Firestore...");
    const snapshot = await getDocs(postsQuery);
    let posts = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));

    // Manually sort by publishedAt descending
    posts.sort((a, b) => {
        const dateA = toDate(a.publishedAt) || new Date(0);
        const dateB = toDate(b.publishedAt) || new Date(0);
        return dateB.getTime() - dateA.getTime();
    });

    console.log(`Successfully fetched ${posts.length} published posts.`);
    return posts;
}

// Generate the primary blog index.html page
function generateIndexPage(posts) {
    const indexPath = path.join(projectRoot, 'public', 'blog', 'index.html');
    const htmlString = fs.readFileSync(indexPath, 'utf-8');
    const $ = cheerio.load(htmlString);

    // Remove client-side JS script tag to prevent double rendering
    $('script[src="/scripts/blog-list.js"]').remove();

    if (!posts.length) {
        $('#blog-list').html('<p class="blog-empty">No blog posts are published yet. Check back soon for detailing tips.</p>');
        $('#blog-state').text("No published posts yet.");
    } else {
        const listHTML = posts.map(post => {
            const slug = post.slug || post.id;
            const title = escapeHtml(post.title || "Untitled article");
            const excerpt = escapeHtml(post.excerpt || excerptFromContent(post.content, 165));
            const publishedLabel = escapeHtml(formatDate(post.publishedAt) || "Recent post");
            const publishedDate = toDate(post.publishedAt);
            const publishedIso = publishedDate ? publishedDate.toISOString() : "";
            const readTime = Number(post.readingMinutes) > 0 ? `${post.readingMinutes} min read` : "";
            const coverImage = typeof post.coverImage === "string" ? post.coverImage.trim() : "";
            const tags = Array.isArray(post.tags)
                ? post.tags.slice(0, 4).map((tag) => `<span class="blog-tag">${escapeHtml(tag)}</span>`).join("")
                : "";

            return `
                <article class="blog-card">
                    <a class="blog-card-link" href="${getPostUrl(slug)}">
                        ${coverImage
                    ? `<img class="blog-card-image" src="${escapeHtml(coverImage.startsWith("/") || coverImage.startsWith("http") ? coverImage : "/" + coverImage)}" alt="${title}" loading="lazy" decoding="async">`
                    : ""}
                        <div class="blog-card-body">
                            <h2>${title}</h2>
                            <p>${excerpt}</p>
                            <div class="blog-card-meta">
                                <time datetime="${publishedIso}">${publishedLabel}</time>
                                ${readTime ? `<span>${escapeHtml(readTime)}</span>` : ""}
                            </div>
                            ${tags ? `<div class="blog-card-tags">${tags}</div>` : ""}
                        </div>
                    </a>
                </article>
            `;
        }).join("");

        $('#blog-list').html(listHTML);
        $('#blog-state').text(`${posts.length} published article${posts.length === 1 ? "" : "s"}.`);

        // Generate JSON-LD schema
        const itemListElement = posts.slice(0, 20).map((post, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: post.title || "Detailing article",
            url: `https://niemansdetailing.com${getPostUrl(post.slug || post.id)}`,
        }));

        const schemaPayload = {
            "@context": "https://schema.org",
            "@type": "Blog",
            name: "Nieman's Detailing Blog",
            url: "https://niemansdetailing.com/blog",
            blogPost: itemListElement.map((item) => ({
                "@type": "BlogPosting",
                headline: item.name,
                url: item.url,
            })),
        };

        const jsonLdTag = `<script id="blog-jsonld" type="application/ld+json">\n${JSON.stringify(schemaPayload, null, 2)}\n</script>`;
        $('head').append(jsonLdTag);
    }

    fs.writeFileSync(indexPath, $.html(), 'utf-8');
    console.log("Updated public/blog/index.html statically.");
}

// Generate individual static HTML files for each post
function generatePostPages(posts) {
    const defaultTemplatePath = path.join(projectRoot, 'public', 'blog', 'post.html');
    const defaultHtmlString = fs.readFileSync(defaultTemplatePath, 'utf-8');

    posts.forEach((post) => {
        const slug = post.slug || post.id;
        const outputPath = path.join(projectRoot, 'public', 'blog', `${slug}.html`);
        const $ = cheerio.load(defaultHtmlString);

        const title = post.title || "Detailing article";
        const excerpt = post.excerpt || excerptFromContent(post.content, 165);
        const canonicalUrl = `https://niemansdetailing.com/blog/${encodeURIComponent(slug)}.html`;
        const publishedDateStr = formatDate(post.publishedAt) || "";
        const readTime = Number(post.readingMinutes) > 0 ? `${post.readingMinutes} min read` : "";
        const coverImage = typeof post.coverImage === "string" ? post.coverImage.trim() : "";
        const htmlContent = renderRichText(post.content || "");

        // 1. Remove JavaScript
        $('script[src="/scripts/blog-post.js"]').remove();

        // 2. Set Meta Data
        $('title').text(`${title} | Nieman's Detailing Blog`);
        $('meta[name="description"]').attr('content', excerpt);
        $('meta[name="twitter:description"]').attr('content', excerpt);
        $('meta[property="og:description"]').attr('content', excerpt);
        $('meta[property="og:title"]').attr('content', `${title} | Nieman's Detailing Blog`);
        $('meta[name="twitter:title"]').attr('content', `${title} | Nieman's Detailing Blog`);
        $('meta[property="og:url"]').attr('content', canonicalUrl);
        $('#canonical-link').attr('href', canonicalUrl);

        if (coverImage) {
            $('meta[property="og:image"]').attr('content', coverImage);
            $('meta[name="twitter:image"]').attr('content', coverImage);
        }

        // 3. Populate Content Elements
        $('#post-state').remove(); // remove the 'Loading article...' text
        $('#post-title').html(escapeHtml(title));
        $('#post-excerpt').html(escapeHtml(excerpt));
        $('#post-date').text(publishedDateStr);
        $('#post-reading-time').text(readTime);
        $('#post-content').html(htmlContent);

        if (Array.isArray(post.tags) && post.tags.length > 0) {
            const tagsHtml = post.tags.slice(0, 8)
                .map((tag) => `<span class="post-tag">${escapeHtml(tag)}</span>`).join("");
            $('#post-tags').html(tagsHtml);
        } else {
            $('#post-tags').html("");
        }

        if (coverImage) {
            const src = coverImage.startsWith("/") || coverImage.startsWith("http") ? coverImage : "/" + coverImage;
            $('#post-cover').attr('src', src);
            $('#post-cover').attr('alt', title);
            $('#post-cover-wrap').removeAttr('hidden');
        } else {
            $('#post-cover-wrap').attr('hidden', 'true');
        }

        // Schema
        const publishedDate = toDate(post.publishedAt);
        const modifiedDate = toDate(post.updatedAt || post.publishedAt);
        const schemaPayload = {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: title,
            description: excerpt,
            datePublished: publishedDate ? publishedDate.toISOString() : undefined,
            dateModified: modifiedDate ? modifiedDate.toISOString() : undefined,
            author: { "@type": "Organization", name: "Nieman's Detailing" },
            publisher: {
                "@type": "Organization",
                name: "Nieman's Detailing",
                logo: { "@type": "ImageObject", url: "https://niemansdetailing.com/images/ND-logo-white-transparentbg-horizontal.png" }
            },
            mainEntityOfPage: canonicalUrl,
            image: coverImage ? [coverImage] : undefined,
        };
        const jsonLdTag = `<script id="post-jsonld" type="application/ld+json">\n${JSON.stringify(schemaPayload, null, 2)}\n</script>`;
        $('head').append(jsonLdTag);

        // Related Posts Logic
        const related = posts.filter((p) => (p.slug || p.id) !== slug).slice(0, 3);
        if (related.length > 0) {
            const relatedHTML = related.map((p) => {
                const pSlug = p.slug || p.id;
                const pTitle = escapeHtml(p.title || "Detailing article");
                const pDesc = escapeHtml(p.excerpt || excerptFromContent(p.content, 120));
                return `<li><a href="/blog/${encodeURIComponent(pSlug)}.html">${pTitle}</a><p>${pDesc}</p></li>`;
            }).join("");
            $('#related-posts').html(relatedHTML);
            $('#related-section').removeAttr('hidden');
        } else {
            $('#related-section').attr('hidden', 'true');
        }

        fs.writeFileSync(outputPath, $.html(), 'utf-8');
        console.log(`Generated public/blog/${slug}.html`);
    });
}

// Generate an updated sitemap.xml to include all dynamic posts
function updateSitemap(posts) {
    const sitemapPath = path.join(projectRoot, 'public', 'sitemap.xml');
    let xmlString = fs.readFileSync(sitemapPath, 'utf-8');

    // Simple string manipulation to dynamically add/replace posts within the sitemap
    const sitemapUrls = posts.map(post => {
        const slug = post.slug || post.id;
        const modifiedDate = toDate(post.updatedAt || post.publishedAt);
        const dateStr = modifiedDate ? modifiedDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

        return `  <url>\n    <loc>https://niemansdetailing.com/blog/${encodeURIComponent(slug)}.html</loc>\n    <lastmod>${dateStr}</lastmod>\n    <priority>0.70</priority>\n  </url>`;
    });

    // Strategy: Remove any existing post URLs, then append the fresh list
    const basicLines = xmlString.split('\n');
    const filteredLines = [];
    let isSkipping = false;

    for (let i = 0; i < basicLines.length; i++) {
        const line = basicLines[i];
        if (line.includes('<loc>https://niemansdetailing.com/blog/') && !line.includes('<loc>https://niemansdetailing.com/blog</loc>')) {
            // We found a specific blog post, so skip the opening url, loc, lastmod, priority, and closing url.
            // Since we can't easily parse backwards, we identify a block by `<url>` before `<loc>`
            // Best approach with simple regex:
        }
    }

    // Rather than manually parsing, let's use cheerio's xmlMode to manipulate the actual XML safely
    const $ = cheerio.load(xmlString, { xmlMode: true });

    // Remove old dynamic posts from sitemap
    $('loc').each((_, el) => {
        const text = $(el).text();
        if (text.startsWith('https://niemansdetailing.com/blog/') && text !== 'https://niemansdetailing.com/blog/') {
            $(el).parent('url').remove();
        }
    });

    // Append new entries
    const urlSet = $('urlset');
    posts.forEach(post => {
        const slug = post.slug || post.id;
        const modifiedDate = toDate(post.updatedAt || post.publishedAt);
        const dateStr = modifiedDate ? modifiedDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

        urlSet.append(`\n  <url>\n    <loc>https://niemansdetailing.com/blog/${encodeURIComponent(slug)}.html</loc>\n    <lastmod>${dateStr}</lastmod>\n    <priority>0.70</priority>\n  </url>`);
    });

    fs.writeFileSync(sitemapPath, $.xml(), 'utf-8');
    console.log("Appended static blog files to sitemap.xml");
}


// --- Execute Build ---
async function build() {
    try {
        const posts = await fetchPosts();
        generateIndexPage(posts);
        generatePostPages(posts);
        updateSitemap(posts);
        console.log("✅ Blog Static Build Complete!");
        process.exit(0);
    } catch (e) {
        console.error("❌ Failed to build blog!", e);
        process.exit(1);
    }
}

build();
