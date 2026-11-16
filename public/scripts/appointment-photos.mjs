import { storage } from "./firebase-client.js";
import { deleteObject, getBlob, list, ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

export function jobPhotosSection(appointmentId) {
  const area = document.createElement("details");
  const folder = ref(storage, `job-photos/${appointmentId}`);
  const title = Object.assign(document.createElement("summary"), { textContent: "Private job photos" });
  const when = document.createElement("select");
  when.setAttribute("aria-label", "Photo stage");
  when.append(new Option("Before detail", "before"), new Option("After detail", "after"));
  const camera = Object.assign(document.createElement("input"), { type: "file", accept: "image/jpeg,image/png,image/webp" });
  camera.setAttribute("capture", "environment");
  camera.setAttribute("aria-label", "Choose a job photo");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const photos = document.createElement("div");
  const preview = document.createElement("img");
  preview.alt = "Private job photo";
  preview.className = "job-photo-preview";
  preview.hidden = true;
  let previewUrl;
  async function load() {
    const page = await list(folder, { maxResults: 50 });
    photos.replaceChildren(...page.items.map((photo, index) => {
      const row = document.createElement("p");
      const stage = photo.name.startsWith("before-") ? "Before" : "After";
      const view = Object.assign(document.createElement("button"), { type: "button", className: "quiet", textContent: `${stage} photo ${index + 1}` });
      const remove = Object.assign(document.createElement("button"), { type: "button", className: "quiet", textContent: "Delete" });
      view.onclick = async () => {
        try {
          const blob = await getBlob(photo, 8 * 1024 * 1024);
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = URL.createObjectURL(blob);
          preview.src = previewUrl;
          preview.hidden = false;
        } catch { status.textContent = "Couldn't load this photo. Check the staging Storage configuration."; }
      };
      remove.onclick = async () => {
        if (!confirm("Delete this private job photo?")) return;
        try {
          await deleteObject(photo);
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          preview.hidden = true;
          await load();
        } catch { status.textContent = "Couldn't delete this photo."; }
      };
      row.append(view, remove);
      return row;
    }));
  }
  area.ontoggle = () => {
    if (area.open) load().catch(() => { status.textContent = "Private Storage is unavailable."; });
    else {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      preview.hidden = true;
    }
  };
  camera.onchange = async () => {
    const file = camera.files[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      status.textContent = "Choose a JPEG, PNG, or WebP image up to 8 MB.";
      camera.value = "";
      return;
    }
    camera.disabled = true;
    status.textContent = "Uploading…";
    try {
      await uploadBytes(ref(folder, `${when.value}-${crypto.randomUUID()}`), file, { contentType: file.type, cacheControl: "private,no-store" });
      status.textContent = "Private photo saved.";
      await load();
    } catch { status.textContent = "Upload failed. Try again after reconnecting."; }
    finally { camera.disabled = false; camera.value = ""; }
  };
  area.append(title, when, camera, status, photos, preview);
  return area;
}
