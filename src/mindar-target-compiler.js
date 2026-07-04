(function () {
  const COMPILER_MODULE_URL = "https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image.prod.js";
  const MAX_TARGET_EDGE = 1200;
  const MAX_TARGET_PIXELS = 1400000;
  const MAX_ACTIVE_TARGETS = 10;

  const nameInput = document.querySelector("#targetNameInput");
  const imageInput = document.querySelector("#targetImageInput");
  const previewList = document.querySelector("#targetImagePreviewList");
  const compileButton = document.querySelector("#compileTargetButton");
  const downloadButton = document.querySelector("#downloadMindButton");
  const statusText = document.querySelector("#compilerStatus");
  const progress = document.querySelector("#compilerProgress");
  const overlayInput = document.querySelector("#overlayMediaInput");
  const overlayImagePreview = document.querySelector("#overlayImagePreview");
  const overlayVideoPreview = document.querySelector("#overlayVideoPreview");
  const overlayStatus = document.querySelector("#overlayMediaStatus");

  if (!nameInput || !imageInput || !previewList || !compileButton || !downloadButton || !statusText || !progress) {
    return;
  }

  let selectedImageFile = null;
  let selectedOverlayFile = null;
  let targetPreviewUrl = null;
  let overlayPreviewUrl = null;
  let compiledMindBlob = null;
  let compiledMindFileName = "targets.mind";
  let compilerLoadPromise = null;
  let editingTargetId = null;

  imageInput.addEventListener("change", () => {
    const file = imageInput.files && imageInput.files[0];

    // Some browsers fire change after the picker is cancelled.
    // Keep the previous selected file and preview in that case.
    if (!file) {
      updateCompileButton();
      return;
    }

    if (!file.type.startsWith("image/")) {
      setStatus("Please choose a PNG, JPG, or WebP target image.");
      updateCompileButton();
      return;
    }

    clearCompiledResult();
    clearTargetPreview();

    selectedImageFile = file;
    if (!nameInput.value.trim()) {
      nameInput.value = fileBaseName(file.name);
    }
    renderTargetPreview(file);
    setStatus(`Target ready: ${file.name}. Choose an MP4 overlay, then save to library.`);
    updateCompileButton();
  });

  nameInput.addEventListener("input", updateCompileButton);

  if (overlayInput && overlayImagePreview && overlayVideoPreview && overlayStatus) {
    overlayInput.addEventListener("change", () => {
      const file = overlayInput.files && overlayInput.files[0];

      // Preserve the previous selection when the file picker is cancelled.
      if (!file) {
        updateCompileButton();
        return;
      }

      if (file.type !== "video/mp4") {
        overlayStatus.textContent = "Please choose an MP4 overlay video.";
        updateCompileButton();
        return;
      }

      clearCompiledResult();
      revokeOverlayPreviewUrl();
      overlayImagePreview.classList.add("hidden");
      overlayVideoPreview.classList.add("hidden");
      overlayImagePreview.removeAttribute("src");
      overlayVideoPreview.pause();
      overlayVideoPreview.removeAttribute("src");

      selectedOverlayFile = file;
      overlayPreviewUrl = URL.createObjectURL(file);
      overlayVideoPreview.src = overlayPreviewUrl;
      overlayVideoPreview.classList.remove("hidden");
      overlayStatus.textContent = `Overlay ready: ${file.name}`;
      updateCompileButton();
    });
  }

  compileButton.addEventListener("click", async () => {
    if (!selectedImageFile || !selectedOverlayFile) return;

    const currentLibrary = window.AR_LIBRARY;
    const target = buildTargetEntry(currentLibrary);
    const existingTarget = findLibraryTarget(target.id);

    if (existingTarget) {
      const confirmed = window.confirm(
        `Target "${existingTarget.name}" already exists.\n\n` +
        "Saving will replace its target image and overlay video, then recompile all enabled targets.\n\n" +
        "Continue and overwrite it?"
      );

      if (!confirmed) {
        setStatus(`Update cancelled. Target "${existingTarget.name}" was not changed.`);
        updateCompileButton();
        return;
      }
    }

    clearCompiledResult();
    compileButton.disabled = true;
    progress.value = 0;
    progress.classList.remove("hidden");

    try {
      const nextLibrary = buildNextLibrary(currentLibrary, target);
      const activeTargets = nextLibrary.targets.filter((item) => item.enabled);
      if (activeTargets.length > MAX_ACTIVE_TARGETS) {
        throw new Error(`This prototype supports up to ${MAX_ACTIVE_TARGETS} active targets.`);
      }

      const Compiler = await loadCompiler();
      const targetImages = [];
      for (let index = 0; index < activeTargets.length; index++) {
        const activeTarget = activeTargets[index];
        setStatus(`Preparing target ${index + 1} of ${activeTargets.length}: ${activeTarget.name}`);
        const blob = activeTarget.id === target.id ? selectedImageFile : await fetchAssetBlob(activeTarget.imagePath);
        targetImages.push(await createCompileImage(blob));
      }

      const compiler = new Compiler();
      setStatus(`Compiling ${activeTargets.length} active target${activeTargets.length === 1 ? "" : "s"}...`);
      await compiler.compileImageTargets(targetImages, (percent) => {
        progress.value = clampPercent(percent);
        setStatus(`Compiling... ${Math.round(progress.value)}%`);
      });

      const exported = compiler.exportData();
      compiledMindBlob = new Blob([exported], { type: "application/octet-stream" });
      compiledMindFileName = `${target.id}.library.targets.mind`;
      progress.value = 100;

      setStatus("Saving files to local library...");
      const result = await saveTargetToLibrary({
        library: nextLibrary,
        target,
        targetImage: selectedImageFile,
        overlayVideo: selectedOverlayFile,
        targetsMind: compiledMindBlob
      });

      window.AR_LIBRARY = result.library;
      window.dispatchEvent(new CustomEvent("ar-library-updated"));
      downloadButton.disabled = false;
      const action = existingTarget ? "Updated" : "Saved";
      setStatus(`${action} ${target.name}. Active targets: ${result.activeTargets}. Refresh Creator/Viewer to use the updated library.`);
    } catch (error) {
      console.error(error);
      progress.classList.add("hidden");
      setStatus(`Save failed: ${friendlyError(error)}`);
    } finally {
      updateCompileButton();
    }
  });

  downloadButton.addEventListener("click", async () => {
    if (!compiledMindBlob) return;
    downloadMindBlob(compiledMindBlob, compiledMindFileName);
  });

  function buildTargetEntry(library) {
    const name = nameInput.value.trim() || fileBaseName(selectedImageFile.name);
    const id = editingTargetId || slugify(name || selectedImageFile.name);
    const imageExt = fileExtension(selectedImageFile.name, ".png");
    const overlayExt = ".mp4";
    const existing = (library.targets || []).find((item) => item.id === id);
    const baseOverlay = (existing && existing.overlay) || (library.targets && library.targets[0] && library.targets[0].overlay) || {
      width: 1,
      height: 1,
      position: "0 0 0.01",
      rotation: "0 0 0"
    };

    return {
      id,
      name,
      enabled: true,
      targetIndex: 0,
      imagePath: `./assets/targets/${id}${imageExt}`,
      overlayPath: `./assets/overlays/${id}${overlayExt}`,
      overlayType: "video",
      overlay: {
        width: Number(baseOverlay.width),
        height: Number(baseOverlay.height),
        position: baseOverlay.position,
        rotation: baseOverlay.rotation
      },
      video: {
        autoplay: true,
        loop: true,
        muted: true,
        playsInline: true
      },
      updatedAt: new Date().toISOString()
    };
  }

  function buildNextLibrary(library, target) {
    let foundExisting = false;
    const targets = (library.targets || []).map((item) => {
      if (item.id !== target.id) {
        return item;
      }
      foundExisting = true;
      return target;
    });

    if (!foundExisting) {
      targets.push(target);
    }

    let activeIndex = 0;
    targets.forEach((item) => {
      if (item.enabled) {
        item.targetIndex = activeIndex;
        activeIndex += 1;
      } else {
        item.targetIndex = null;
      }
    });

    return {
      version: 1,
      maxActiveTargets: library.maxActiveTargets || MAX_ACTIVE_TARGETS,
      targetFile: "./assets/targets.mind",
      targets
    };
  }

  async function saveTargetToLibrary({ library, target, targetImage, overlayVideo, targetsMind }) {
    const form = new FormData();
    form.append("library", JSON.stringify(library));
    form.append("targetId", target.id);
    form.append("targetImage", targetImage, targetImage.name);
    form.append("overlayVideo", overlayVideo, overlayVideo.name);
    form.append("targetsMind", targetsMind, "targets.mind");

    const response = await fetch("/api/library/save-target", {
      method: "POST",
      body: form
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "helper save failed");
    }
    return result;
  }

  async function loadCompiler() {
    if (!compilerLoadPromise) {
      compilerLoadPromise = import(COMPILER_MODULE_URL).then((module) => {
        const Compiler = module.Compiler || (window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.Compiler);
        if (typeof Compiler !== "function") {
          throw new Error("MindAR Compiler API was not found in the browser bundle.");
        }
        return Compiler;
      });
    }
    return compilerLoadPromise;
  }

  async function fetchAssetBlob(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Could not load existing target image: ${path}`);
    }
    return response.blob();
  }

  async function createCompileImage(blob) {
    const originalImage = await loadImageFromBlob(blob);
    const size = fitTargetSize(originalImage.naturalWidth, originalImage.naturalHeight);

    if (size.width === originalImage.naturalWidth && size.height === originalImage.naturalHeight) {
      return originalImage;
    }

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(originalImage, 0, 0, size.width, size.height);

    return loadImageFromBlob(await canvasToBlob(canvas));
  }

  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();

      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read a target image."));
      };

      image.src = url;
    });
  }

  function fitTargetSize(width, height) {
    const edgeScale = Math.min(1, MAX_TARGET_EDGE / Math.max(width, height));
    const pixelScale = Math.min(1, Math.sqrt(MAX_TARGET_PIXELS / (width * height)));
    const scale = Math.min(edgeScale, pixelScale);

    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Could not resize a target image."));
        }
      }, "image/png");
    });
  }

  function renderTargetPreview(file) {
    clearTargetPreview();
    targetPreviewUrl = URL.createObjectURL(file);
    const item = document.createElement("div");
    item.className = "target-preview-item";

    const image = document.createElement("img");
    image.src = targetPreviewUrl;
    image.alt = `${file.name} preview`;

    const label = document.createElement("span");
    label.textContent = file.name;

    item.append(image, label);
    previewList.append(item);
    previewList.classList.remove("hidden");
  }

  function clearTargetPreview() {
    if (targetPreviewUrl) {
      URL.revokeObjectURL(targetPreviewUrl);
      targetPreviewUrl = null;
    }
    previewList.replaceChildren();
    previewList.classList.add("hidden");
  }

  function revokeOverlayPreviewUrl() {
    if (overlayPreviewUrl) {
      URL.revokeObjectURL(overlayPreviewUrl);
      overlayPreviewUrl = null;
    }
  }

  function clearCompiledResult() {
    compiledMindBlob = null;
    downloadButton.disabled = true;
    progress.value = 0;
    progress.classList.add("hidden");
  }

  function updateCompileButton() {
    const hasRequiredInput = Boolean(
      selectedImageFile &&
      selectedOverlayFile &&
      nameInput.value.trim()
    );

    compileButton.disabled = !hasRequiredInput;

    const pendingId = pendingTargetId();
    compileButton.textContent =
      editingTargetId || (pendingId && findLibraryTarget(pendingId))
        ? "Update existing target"
        : "Save new target";
  }

  function pendingTargetId() {
    const name = nameInput.value.trim();
    if (!name) return "";
    return slugify(name);
  }

  function findLibraryTarget(targetId) {
    const library = window.AR_LIBRARY;
    const targets =
      library && Array.isArray(library.targets)
        ? library.targets
        : [];

    return targets.find((target) => target.id === targetId) || null;
  }

  function startEditingTarget(targetId) {
    const target = findLibraryTarget(targetId);
    if (!target) {
      setStatus(`Target not found: ${targetId}`);
      return;
    }

    editingTargetId = target.id;
    selectedImageFile = null;
    selectedOverlayFile = null;
    imageInput.value = "";
    overlayInput.value = "";
    nameInput.value = target.name || target.id;
    clearCompiledResult();
    renderExistingTargetPreview(target);
    renderExistingOverlayPreview(target);
    setStatus(
      `Editing existing target: ${target.name}. Current image: ${fileNameFromPath(target.imagePath)}. Choose a new target image only if you want to replace it.`
    );
    overlayStatus.textContent =
      `Current overlay: ${fileNameFromPath(target.overlayPath)}. Choose a new MP4 only if you want to replace it.`;
    updateCompileButton();
  }

  function renderExistingTargetPreview(target) {
    clearTargetPreview();
    const item = document.createElement("div");
    item.className = "target-preview-item";

    const image = document.createElement("img");
    image.src = target.imagePath;
    image.alt = `${target.name} target image`;

    const label = document.createElement("span");
    label.textContent = fileNameFromPath(target.imagePath);

    item.append(image, label);
    previewList.append(item);
    previewList.classList.remove("hidden");
  }

  function renderExistingOverlayPreview(target) {
    revokeOverlayPreviewUrl();
    overlayImagePreview.classList.add("hidden");
    overlayImagePreview.removeAttribute("src");
    overlayVideoPreview.pause();
    overlayVideoPreview.src = target.overlayPath;
    overlayVideoPreview.classList.remove("hidden");
    overlayVideoPreview.load();
  }

  function downloadMindBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function fileBaseName(fileName) {
    return String(fileName).replace(/\.[^.]*$/, "").trim();
  }

  function fileExtension(fileName, fallback) {
    const extension = String(fileName).match(/\.[^.]+$/);
    return extension ? extension[0].toLowerCase() : fallback;
  }

  function fileNameFromPath(path) {
    return String(path || "").split("/").pop() || "none";
  }

  function slugify(value) {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "target";
  }

  function setStatus(message) {
    statusText.textContent = message;
  }

  function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, number));
  }

  function friendlyError(error) {
    if (!navigator.onLine) {
      return "internet connection is required the first time the compiler bundle loads.";
    }
    return error && error.message ? error.message : "unknown error";
  }

  window.CreatorProjectSetup = {
    editTarget: startEditingTarget
  };
})();
