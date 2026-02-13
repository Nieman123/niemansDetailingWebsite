import { auth, db, storage } from "/scripts/firebase-client.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  escapeHtml,
  estimateReadingMinutes,
  excerptFromContent,
  formatDate,
  normalizeTags,
  renderRichText,
  slugify,
} from "/scripts/blog-utils.js";

const els = {
  status: document.getElementById("admin-status"),
  authView: document.getElementById("auth-view"),
  unauthorizedView: document.getElementById("unauthorized-view"),
  adminView: document.getElementById("admin-view"),
  userEmail: document.getElementById("admin-user-email"),
  userUid: document.getElementById("admin-uid"),
  postList: document.getElementById("post-list"),
  emptyList: document.getElementById("post-list-empty"),
  signInBtn: document.getElementById("sign-in-btn"),
  signOutBtn: document.getElementById("sign-out-btn"),
  unauthorizedSignOutBtn: document.getElementById("sign-out-unauthorized-btn"),
  postForm: document.getElementById("post-form"),
  postTitle: document.getElementById("post-title-input"),
  postSlug: document.getElementById("post-slug-input"),
  slugFromTitleBtn: document.getElementById("slug-from-title-btn"),
  postExcerpt: document.getElementById("post-excerpt-input"),
  postTags: document.getElementById("post-tags-input"),
  postCoverImage: document.getElementById("post-cover-image-input"),
  postStatus: document.getElementById("post-status-input"),
  postContent: document.getElementById("post-content-input"),
  saveBtn: document.getElementById("save-post-btn"),
  deleteBtn: document.getElementById("delete-post-btn"),
  newPostBtn: document.getElementById("new-post-btn"),
  openPostLink: document.getElementById("open-post-link"),
  preview: document.getElementById("post-preview"),
  formHeading: document.getElementById("editor-heading"),
  authHint: document.getElementById("auth-hint"),
  coverImageFile: document.getElementById("cover-image-file"),
  uploadCoverBtn: document.getElementById("upload-cover-btn"),
  contentImageFile: document.getElementById("content-image-file"),
  uploadContentBtn: document.getElementById("upload-content-image-btn"),
};

const state = {
  user: null,
  isAdmin: false,
  activeSlug: null,
};

function setStatus(message, type = "info") {
  if (!els.status) return;
  els.status.textContent = message;
  els.status.dataset.type = type;
}

function showView(view) {
  if (els.authView) els.authView.hidden = view !== "auth";
  if (els.unauthorizedView) els.unauthorizedView.hidden = view !== "unauthorized";
  if (els.adminView) els.adminView.hidden = view !== "admin";
}

function setSaving(isSaving) {
  const controls = [
    els.saveBtn,
    els.deleteBtn,
    els.newPostBtn,
    els.slugFromTitleBtn,
    els.postTitle,
    els.postSlug,
    els.postExcerpt,
    els.postTags,
    els.postCoverImage,
    els.postStatus,
    els.postContent,
  ];
  controls.forEach((control) => {
    if (control) control.disabled = isSaving;
  });
}

function getCurrentPostUrl(slug) {
  return `/blog/${encodeURIComponent(slug)}`;
}

async function checkAdmin(uid) {
  const snap = await getDoc(doc(db, "adminUsers", uid));
  return snap.exists();
}

function renderPostList(posts) {
  if (!els.postList || !els.emptyList) return;

  if (!posts.length) {
    els.postList.innerHTML = "";
    els.emptyList.hidden = false;
    return;
  }

  els.emptyList.hidden = true;
  els.postList.innerHTML = posts
    .map((post) => {
      const slug = post.slug || post.id;
      const title = escapeHtml(post.title || "Untitled");
      const status = post.status === "published" ? "published" : "draft";
      const updatedLabel = formatDate(post.updatedAt || post.createdAt) || "No date";
      return `
        <li class="post-list-item">
          <button type="button" class="post-list-btn" data-slug="${escapeHtml(slug)}">
            <span class="post-list-title">${title}</span>
            <span class="post-list-meta">
              <span class="pill pill-${status}">${status}</span>
              <span>${escapeHtml(updatedLabel)}</span>
            </span>
          </button>
        </li>
      `;
    })
    .join("");

  els.postList.querySelectorAll(".post-list-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const slug = button.getAttribute("data-slug");
      if (slug) loadPostIntoEditor(slug);
    });
  });
}

function applyPostToEditor(post, slug) {
  if (!els.postForm) return;
  state.activeSlug = slug;
  if (els.formHeading) {
    els.formHeading.textContent = `Editing: ${post.title || slug}`;
  }
  if (els.postTitle) els.postTitle.value = post.title || "";
  if (els.postSlug) els.postSlug.value = post.slug || slug;
  if (els.postExcerpt) els.postExcerpt.value = post.excerpt || "";
  if (els.postTags) els.postTags.value = Array.isArray(post.tags) ? post.tags.join(", ") : "";
  if (els.postCoverImage) els.postCoverImage.value = post.coverImage || "";
  if (els.postStatus) els.postStatus.value = post.status === "published" ? "published" : "draft";
  if (els.postContent) els.postContent.value = post.content || "";
  if (els.deleteBtn) els.deleteBtn.hidden = false;
  if (els.openPostLink) {
    els.openPostLink.href = getCurrentPostUrl(slug);
    els.openPostLink.hidden = false;
  }
  renderPreview();
}

function resetEditor() {
  if (els.postForm) els.postForm.reset();
  state.activeSlug = null;
  if (els.formHeading) els.formHeading.textContent = "Create a new post";
  if (els.deleteBtn) els.deleteBtn.hidden = true;
  if (els.openPostLink) {
    els.openPostLink.hidden = true;
    els.openPostLink.href = "#";
  }
  if (els.preview) {
    els.preview.innerHTML =
      "<p>Write your article content to see a safe, formatted preview.</p>";
  }
}

function renderPreview() {
  if (!els.preview || !els.postContent) return;
  const content = els.postContent.value || "";
  const rendered = renderRichText(content);
  els.preview.innerHTML = rendered || "<p>Nothing to preview yet.</p>";
}

async function loadPostList() {
  const postQuery = query(collection(db, "blogPosts"), orderBy("updatedAt", "desc"), limit(100));
  const snapshot = await getDocs(postQuery);
  const posts = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  renderPostList(posts);
}

async function loadPostIntoEditor(slug) {
  try {
    setStatus("Loading post...");
    const snapshot = await getDoc(doc(db, "blogPosts", slug));
    if (!snapshot.exists()) {
      setStatus("That post could not be found.", "error");
      return;
    }
    applyPostToEditor(snapshot.data(), slug);
    setStatus(`Loaded "${snapshot.data().title || slug}".`);
  } catch (error) {
    console.error("Failed to load post", error);
    setStatus("Could not load that post.", "error");
  }

}

async function uploadImage(file) {
  if (!file) return null;
  // Create a unique filename: timestamp-filename
  const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
  const storageRef = ref(storage, `blog-images/${filename}`);

  setStatus("Uploading image...");
  try {
    const snapshot = await uploadBytes(storageRef, file);
    const url = await getDownloadURL(snapshot.ref);
    setStatus("Image uploaded successfully.");
    return url;
  } catch (error) {
    console.error("Upload failed", error);
    setStatus("Image upload failed.", "error");
    throw error;
  }
}

function validatePostInput() {
  const title = (els.postTitle?.value || "").trim().slice(0, 120);
  const slug = slugify((els.postSlug?.value || "").trim() || title);
  const content = (els.postContent?.value || "").trim();
  const excerptRaw = (els.postExcerpt?.value || "").trim().slice(0, 220);
  const excerpt = excerptRaw || excerptFromContent(content, 165);
  const status = els.postStatus?.value === "published" ? "published" : "draft";
  const tags = normalizeTags(els.postTags?.value || "");
  const coverImage = (els.postCoverImage?.value || "").trim().slice(0, 500);

  if (!title) throw new Error("A title is required.");
  if (!slug) throw new Error("A slug is required.");
  if (!content) throw new Error("Content is required.");

  return {
    title,
    slug,
    excerpt,
    status,
    tags,
    coverImage,
    content,
    readingMinutes: estimateReadingMinutes(content),
  };
}

async function savePost(event) {
  event.preventDefault();
  if (!state.user || !state.isAdmin) {
    setStatus("Sign in with admin access before saving.", "error");
    return;
  }

  try {
    setSaving(true);
    setStatus("Saving post...");

    const input = validatePostInput();
    const targetRef = doc(db, "blogPosts", input.slug);
    const existingSnap = await getDoc(targetRef);
    const existing = existingSnap.exists() ? existingSnap.data() : null;
    const previousSlug = state.activeSlug;
    const slugChanged = Boolean(previousSlug && previousSlug !== input.slug);

    const payload = {
      title: input.title,
      slug: input.slug,
      excerpt: input.excerpt,
      content: input.content,
      tags: input.tags,
      status: input.status,
      coverImage: input.coverImage || null,
      authorUid: state.user.uid,
      authorEmail: state.user.email || null,
      readingMinutes: input.readingMinutes,
      updatedAt: serverTimestamp(),
      createdAt: existing?.createdAt || serverTimestamp(),
      publishedAt:
        input.status === "published"
          ? existing?.publishedAt || serverTimestamp()
          : null,
    };

    await setDoc(targetRef, payload, { merge: true });

    if (slugChanged) {
      const shouldDeleteOld = window.confirm(
        "Slug changed. Delete the old post document to avoid duplicates?"
      );
      if (shouldDeleteOld) {
        await deleteDoc(doc(db, "blogPosts", previousSlug));
      }
    }

    state.activeSlug = input.slug;
    if (els.postSlug) els.postSlug.value = input.slug;
    if (els.postExcerpt && !els.postExcerpt.value.trim()) {
      els.postExcerpt.value = input.excerpt;
    }
    if (els.openPostLink) {
      els.openPostLink.href = getCurrentPostUrl(input.slug);
      els.openPostLink.hidden = false;
    }
    if (els.deleteBtn) els.deleteBtn.hidden = false;
    if (els.formHeading) els.formHeading.textContent = `Editing: ${input.title}`;

    await loadPostList();
    setStatus("Post saved.");
  } catch (error) {
    console.error("Failed to save post", error);
    setStatus(error.message || "Could not save post.", "error");
  } finally {
    setSaving(false);
  }
}

async function deleteCurrentPost() {
  if (!state.user || !state.isAdmin || !state.activeSlug) return;
  const confirmed = window.confirm("Delete this post? This cannot be undone.");
  if (!confirmed) return;

  try {
    setSaving(true);
    setStatus("Deleting post...");
    await deleteDoc(doc(db, "blogPosts", state.activeSlug));
    resetEditor();
    await loadPostList();
    setStatus("Post deleted.");
  } catch (error) {
    console.error("Failed to delete post", error);
    setStatus("Could not delete post.", "error");
  } finally {
    setSaving(false);
  }
}

function bindEvents() {
  if (els.signInBtn) {
    els.signInBtn.addEventListener("click", async () => {
      try {
        setStatus("Signing in...");
        await signInWithPopup(auth, new GoogleAuthProvider());
      } catch (error) {
        console.error("Sign in failed", error);
        setStatus("Sign in failed. Check Google Auth settings.", "error");
      }
    });
  }

  if (els.signOutBtn) {
    els.signOutBtn.addEventListener("click", async () => {
      await signOut(auth);
    });
  }

  if (els.unauthorizedSignOutBtn) {
    els.unauthorizedSignOutBtn.addEventListener("click", async () => {
      await signOut(auth);
    });
  }

  if (els.newPostBtn) {
    els.newPostBtn.addEventListener("click", () => {
      resetEditor();
      if (els.postTitle) els.postTitle.focus();
    });
  }

  if (els.slugFromTitleBtn) {
    els.slugFromTitleBtn.addEventListener("click", () => {
      if (!els.postTitle || !els.postSlug) return;
      const nextSlug = slugify(els.postTitle.value);
      if (!nextSlug) return;
      els.postSlug.value = nextSlug;
      if (els.openPostLink) {
        els.openPostLink.href = getCurrentPostUrl(nextSlug);
        els.openPostLink.hidden = false;
      }
    });
  }

  if (els.postContent) {
    els.postContent.addEventListener("input", renderPreview);
  }

  if (els.postForm) {
    els.postForm.addEventListener("submit", savePost);
  }

  if (els.deleteBtn) {
    els.deleteBtn.addEventListener("click", deleteCurrentPost);
  }

  // Cover Image Upload
  if (els.uploadCoverBtn && els.coverImageFile) {
    els.uploadCoverBtn.addEventListener("click", () => els.coverImageFile.click());
    els.coverImageFile.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const url = await uploadImage(file);
        if (url && els.postCoverImage) {
          els.postCoverImage.value = url;
        }
      } catch (err) {
        // Error handled in uploadImage
      } finally {
        els.coverImageFile.value = ""; // Reset
      }
    });
  }

  // Content Image Upload
  if (els.uploadContentBtn && els.contentImageFile) {
    els.uploadContentBtn.addEventListener("click", () => els.contentImageFile.click());
    els.contentImageFile.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const url = await uploadImage(file);
        if (url && els.postContent) {
          const imageMarkdown = `\n![Image Description](${url})\n`;
          // Insert at cursor position or append
          const startPos = els.postContent.selectionStart;
          const endPos = els.postContent.selectionEnd;
          const text = els.postContent.value;

          if (typeof startPos === 'number' && typeof endPos === 'number') {
            els.postContent.value = text.substring(0, startPos) + imageMarkdown + text.substring(endPos);
          } else {
            els.postContent.value += imageMarkdown;
          }
          renderPreview();
        }
      } catch (err) {
        // Error handled in uploadImage
      } finally {
        els.contentImageFile.value = ""; // Reset
      }
    });
  }
}

async function handleAuth(user) {
  state.user = user;

  if (!user) {
    state.isAdmin = false;
    if (els.authHint) {
      els.authHint.textContent =
        "You must be listed in adminUsers/<uid> to edit posts.";
    }
    if (els.userEmail) els.userEmail.textContent = "-";
    if (els.userUid) els.userUid.textContent = "-";
    showView("auth");
    setStatus("Sign in to manage blog posts.");
    resetEditor();
    return;
  }

  if (els.userEmail) els.userEmail.textContent = user.email || "(no email)";
  if (els.userUid) els.userUid.textContent = user.uid;
  if (els.authHint) {
    els.authHint.textContent = `Signed in as ${user.email || user.uid}`;
  }

  try {
    setStatus("Checking admin access...");
    state.isAdmin = await checkAdmin(user.uid);

    if (!state.isAdmin) {
      showView("unauthorized");
      setStatus("You are signed in but not listed in adminUsers.", "error");
      return;
    }

    showView("admin");
    resetEditor();
    await loadPostList();
    setStatus("Blog admin ready.");
  } catch (error) {
    console.error("Admin access check failed", error);
    showView("unauthorized");
    setStatus("Could not verify admin access.", "error");
  }
}

bindEvents();
onAuthStateChanged(auth, (user) => {
  handleAuth(user).catch((error) => {
    console.error("Unexpected auth handler error", error);
    setStatus("Unexpected authentication error.", "error");
  });
});
