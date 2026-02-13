import { db } from "/scripts/firebase-client.js";
import {
  collection,
  doc,
  getDoc,
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
  renderRichText,
  toDate,
} from "/scripts/blog-utils.js";

const stateEl = document.getElementById("post-state");
const titleEl = document.getElementById("post-title");
const excerptEl = document.getElementById("post-excerpt");
const dateEl = document.getElementById("post-date");
const readingTimeEl = document.getElementById("post-reading-time");
const tagsEl = document.getElementById("post-tags");
const coverWrapEl = document.getElementById("post-cover-wrap");
const coverEl = document.getElementById("post-cover");
const contentEl = document.getElementById("post-content");
const relatedSectionEl = document.getElementById("related-section");
const relatedPostsEl = document.getElementById("related-posts");

function setState(message, type = "info") {
  if (!stateEl) return;
  stateEl.textContent = message;
  stateEl.dataset.type = type;
}

function getSlugFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = (params.get("slug") || "").trim();
  if (fromQuery) return fromQuery.toLowerCase();

  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "blog" || parts.length < 2) return "";
  const candidate = decodeURIComponent(parts[1] || "").trim().toLowerCase();
  if (!candidate || candidate === "post.html" || candidate === "index.html") return "";
  return candidate;
}

function setMeta(nameOrProperty, value, useProperty = false) {
  if (!value) return;
  const selector = useProperty
    ? `meta[property="${nameOrProperty}"]`
    : `meta[name="${nameOrProperty}"]`;
  const node = document.querySelector(selector);
  if (node) node.setAttribute("content", value);
}

function setCanonical(url) {
  const canonical = document.getElementById("canonical-link");
  if (canonical) canonical.setAttribute("href", url);
}

function setNoIndex() {
  const robots = document.querySelector('meta[name="robots"]');
  if (robots) robots.setAttribute("content", "noindex,nofollow");
}

function renderTags(tags) {
  if (!tagsEl) return;
  if (!Array.isArray(tags) || !tags.length) {
    tagsEl.innerHTML = "";
    return;
  }
  tagsEl.innerHTML = tags
    .slice(0, 8)
    .map((tag) => `<span class="post-tag">${escapeHtml(tag)}</span>`)
    .join("");
}

function updateStructuredData(post, canonicalUrl) {
  const existing = document.getElementById("post-jsonld");
  if (existing) existing.remove();

  const publishedDate = toDate(post.publishedAt);
  const modifiedDate = toDate(post.updatedAt || post.publishedAt);
  const payload = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title || "Detailing article",
    description: post.excerpt || excerptFromContent(post.content, 165),
    datePublished: publishedDate ? publishedDate.toISOString() : undefined,
    dateModified: modifiedDate ? modifiedDate.toISOString() : undefined,
    author: {
      "@type": "Organization",
      name: "Nieman's Detailing",
    },
    publisher: {
      "@type": "Organization",
      name: "Nieman's Detailing",
      logo: {
        "@type": "ImageObject",
        url: "https://niemansdetailing.com/images/ND-logo-white-transparentbg-horizontal.png",
      },
    },
    mainEntityOfPage: canonicalUrl,
    image: post.coverImage ? [post.coverImage] : undefined,
  };

  const script = document.createElement("script");
  script.id = "post-jsonld";
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(payload);
  document.head.appendChild(script);
}

function renderPost(slug, post) {
  const title = post.title || "Detailing article";
  const excerpt = post.excerpt || excerptFromContent(post.content, 165);
  const canonicalUrl = `https://niemansdetailing.com/blog/${encodeURIComponent(slug)}`;
  const published = formatDate(post.publishedAt) || "";
  const readTime =
    Number(post.readingMinutes) > 0 ? `${post.readingMinutes} min read` : "";
  const coverImage = typeof post.coverImage === "string" ? post.coverImage.trim() : "";

  if (titleEl) titleEl.textContent = title;
  if (excerptEl) excerptEl.textContent = excerpt;
  if (dateEl) dateEl.textContent = published;
  if (readingTimeEl) readingTimeEl.textContent = readTime;
  if (contentEl) contentEl.innerHTML = renderRichText(post.content || "");
  renderTags(post.tags);

  if (coverWrapEl && coverEl) {
    if (coverImage) {
      // Ensure image path is absolute to root
      const src = coverImage.startsWith("/") || coverImage.startsWith("http")
        ? coverImage
        : "/" + coverImage;

      coverEl.src = src;
      coverEl.alt = title;
      coverWrapEl.hidden = false;
    } else {
      coverWrapEl.hidden = true;
    }
  }

  document.title = `${title} | Nieman's Detailing Blog`;
  setMeta("description", excerpt);
  setMeta("twitter:description", excerpt);
  setMeta("og:description", excerpt, true);
  setMeta("og:title", `${title} | Nieman's Detailing Blog`, true);
  setMeta("twitter:title", `${title} | Nieman's Detailing Blog`);
  setMeta("og:url", canonicalUrl, true);
  if (coverImage) {
    setMeta("og:image", coverImage, true);
    setMeta("twitter:image", coverImage);
  }
  setCanonical(canonicalUrl);
  updateStructuredData(post, canonicalUrl);
  setState("Published article");
}

function renderNotFound(message) {
  setState(message, "error");
  setNoIndex();
  if (titleEl) titleEl.textContent = "Article not found";
  if (excerptEl) excerptEl.textContent = "The requested blog article is unavailable.";
  if (contentEl) {
    contentEl.innerHTML = `
      <p>The article you requested could not be loaded.</p>
      <p><a href="/blog">Return to the blog index</a></p>
    `;
  }
  if (relatedSectionEl) relatedSectionEl.hidden = true;
}

async function loadRelatedPosts(currentSlug) {
  if (!relatedSectionEl || !relatedPostsEl) return;

  try {
    const postsQuery = query(
      collection(db, "blogPosts"),
      where("status", "==", "published"),
      orderBy("publishedAt", "desc"),
      limit(5)
    );
    const snapshot = await getDocs(postsQuery);
    const related = snapshot.docs
      .map((docSnap) => ({ slug: docSnap.id, ...docSnap.data() }))
      .filter((post) => post.slug !== currentSlug)
      .slice(0, 3);

    if (!related.length) {
      relatedSectionEl.hidden = true;
      return;
    }

    relatedPostsEl.innerHTML = related
      .map((post) => {
        const slug = post.slug;
        const title = escapeHtml(post.title || "Detailing article");
        const description = escapeHtml(
          post.excerpt || excerptFromContent(post.content, 120)
        );
        return `
          <li>
            <a href="/blog/${encodeURIComponent(slug)}">${title}</a>
            <p>${description}</p>
          </li>
        `;
      })
      .join("");
    relatedSectionEl.hidden = false;
  } catch (error) {
    console.warn("Could not load related posts", error);
    relatedSectionEl.hidden = true;
  }
}

async function loadPost() {
  const slug = getSlugFromLocation();
  if (!slug) {
    renderNotFound("Missing blog slug in the URL.");
    return;
  }

  try {
    setState("Loading article...");
    const snapshot = await getDoc(doc(db, "blogPosts", slug));
    if (!snapshot.exists()) {
      renderNotFound("This article does not exist.");
      return;
    }

    const post = snapshot.data();
    if (post.status !== "published") {
      renderNotFound("This article is not publicly available.");
      return;
    }

    renderPost(slug, post);
    await loadRelatedPosts(slug);
  } catch (error) {
    console.error("Failed to load blog post", error);
    renderNotFound("Unable to load this article right now.");
  }
}

loadPost();
