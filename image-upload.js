// Image upload of the Markdown editors. GitHub's own "paste an image" endpoint needs a web session, so the images are
// committed to a public repository of the organization with the Contents API and linked by their raw URL.
// Loaded before app.js; it relies on globals declared there (githubRequest, accessToken, apiErrorMessage, API_ROOT).

const ASSET_REPO = "pankosmia/roadmap-assets";
const ASSET_MAX_BYTES = 10 * 1024 * 1024;
const ASSET_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const ASSET_ACCEPT = Object.keys(ASSET_TYPES).join(",");
const ASSET_CONFLICT_RETRIES = 3;

// The Contents API commits to one branch: two uploads at the same time can answer 409, so they go one after the other.
let assetQueue = Promise.resolve();

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error(`Could not read ${file.name || "the image"}.`));
    reader.readAsDataURL(file);
  });
}

// The pixel size of the image, so that the editor can write it down; null when the browser cannot decode the file.
async function imageSize(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

// Year and month folders keep the repository easy to browse and to clean by age.
function assetPath(extension) {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}/${month}/${crypto.randomUUID()}.${extension}`;
}

function assetUploadError(error) {
  if (error.rateLimited || error.networkError || error.unknownOutcome) return apiErrorMessage(error);
  if (error.accessDenied || [401, 403, 404].includes(error.status)) {
    const fix = error.classicToken
      ? "A classic token needs the public_repo scope and, when the organization uses SAML single sign-on, must be authorized for it."
      : "A fine-grained token must have the organization as resource owner and include this repository with the Contents permission set to Read and write.";
    return `Your token cannot upload images to ${ASSET_REPO}. ${fix} Edit the token on GitHub, then connect it again.`;
  }
  return error.message;
}

async function putAsset(path, content) {
  const url = `${API_ROOT}/repos/${ASSET_REPO}/contents/${path}`;
  const options = {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Add an image uploaded from the roadmap", content })
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await githubRequest(url, options, accessToken);
    } catch (error) {
      if (error.status !== 409 || attempt >= ASSET_CONFLICT_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

// Resolves to { url, alt, width, height } for the editor to turn into Markdown, rejects with a message fit for the user.
function uploadImageAsset(file) {
  const upload = async () => {
    const extension = ASSET_TYPES[file.type];
    if (!accessToken) throw new Error("Connect GitHub to upload images.");
    if (!extension) throw new Error(`${file.name || "This file"} is not a PNG, JPEG, GIF or WebP image.`);
    if (file.size > ASSET_MAX_BYTES) throw new Error(`${file.name || "The image"} is larger than ${ASSET_MAX_BYTES / 1024 / 1024} MB.`);
    const content = await readAsBase64(file);
    const { width, height } = await imageSize(file);
    try {
      const result = await putAsset(assetPath(extension), content);
      return { url: result.content.download_url, alt: file.name.replace(/\.[^.]*$/, "") || "image", width, height };
    } catch (error) {
      throw new Error(assetUploadError(error));
    }
  };
  const result = assetQueue.then(upload);
  assetQueue = result.catch(() => {});
  return result;
}
