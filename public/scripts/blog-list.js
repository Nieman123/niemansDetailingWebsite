import { db } from "/scripts/firebase-client.js";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  escapeHtml,
  excerptFromContent,
  formatDate,
  toDate,
} from "/scripts/blog-utils.js";

const stateEl = document.getElementById("blog-state");
const listEl = document.getElementById("blog-list");

function setState(message, type = "info") {
  if (!stateEl) return;
  stateEl.textContent = message;
  stateEl.dataset.type = type;
}

function getPostUrl(slug) {
  return `/blog/${encodeURIComponent(slug)}`;
}

function renderList(posts) {
  if (!listEl) return;
  if (!posts.length) {
    listEl.innerHTML =
      '<p class="blog-empty">No blog posts are published yet. Check back soon for detailing tips.</p>';
    setState("No published posts yet.");
    return;
  }

  listEl.innerHTML = posts
    .map((post) => {
      const slug = post.slug || post.id;
      const title = escapeHtml(post.title || "Untitled article");
      const excerpt = escapeHtml(post.excerpt || excerptFromContent(post.content, 165));
      const publishedLabel = escapeHtml(formatDate(post.publishedAt) || "Recent post");
      const publishedDate = toDate(post.publishedAt);
      const publishedIso = publishedDate ? publishedDate.toISOString() : "";
      const readTime = Number(post.readingMinutes) > 0 ? `${post.readingMinutes} min read` : "";
      const coverImage = typeof post.coverImage === "string" ? post.coverImage.trim() : "";
      const tags = Array.isArray(post.tags)
        ? post.tags
          .slice(0, 4)
          .map((tag) => `<span class="blog-tag">${escapeHtml(tag)}</span>`)
          .join("")
        : "";

      return `
        <article class="blog-card">
          <a class="blog-card-link" href="${getPostUrl(slug)}">
            ${coverImage
          ? `<img class="blog-card-image" src="${escapeHtml(coverImage.startsWith("/") || coverImage.startsWith("http") ? coverImage : "/" + coverImage)
          }" alt="${title}" loading="lazy" decoding="async">`
          : ""
        }
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
    })
    .join("");

  setState(`${posts.length} published article${posts.length === 1 ? "" : "s"}.`);
}

function renderJsonLd(posts) {
  const existing = document.getElementById("blog-jsonld");
  if (existing) existing.remove();

  if (!posts.length) return;

  const itemListElement = posts.slice(0, 20).map((post, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: post.title || "Detailing article",
    url: `https://niemansdetailing.com${getPostUrl(post.slug || post.id)}`,
  }));

  const payload = {
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

  const script = document.createElement("script");
  script.id = "blog-jsonld";
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(payload);
  document.head.appendChild(script);
}

async function loadPosts() {
  try {
    setState("Loading articles...");
    const postsQuery = query(
      collection(db, "blogPosts"),
      where("status", "==", "published"),
      orderBy("publishedAt", "desc"),
      limit(50)
    );
    const snapshot = await getDocs(postsQuery);
    const posts = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    renderList(posts);
    renderJsonLd(posts);
  } catch (error) {
    console.error("Failed to load blog posts", error);
    setState("Could not load blog posts right now. Please try again.", "error");
    if (listEl) {
      listEl.innerHTML =
        '<p class="blog-empty">The blog is temporarily unavailable. Please check again later.</p>';
    }
  }
}

loadPosts();
