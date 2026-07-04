(function () {
  const COMPILER_MODULE_URL = "https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image.prod.js";
  const MAX_TARGET_EDGE = 1200;
  const MAX_TARGET_PIXELS = 1400000;
  const MAX_TARGET_COUNT = 10;

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

  if (!imageInput || !previewList || !compileButton || !downloadButton || !statusText || !progress) {
    return;
  }

  let selectedFiles = [];
  let previewUrls = [];
  let overlayPreviewUrl = null;
  let compiledMindBlob = null;
  let compiledMindFileName = "targets.mind";
  let compilerLoadPromise = null;

  imageInput.addEventListener("change", () => {
    clearCompiledResult();
    clearTargetPreviews();

    const files = Array.from(imageInput.files || []);
    if (!files.length) {
      selectedFiles = [];
      compileButton.disabled = true;
      setStatus("Choose one or more target images to compile one targets.mind file.");
      return;
    }

    const invalidFile = files.find((file) => !file.type.startsWith("image/"));
    if (invalidFile) {
      selectedFiles = [];
      compileButton.disabled = true;
      setStatus(`Please choose only PNG, JPG, or WebP images. ${invalidFile.name} is not supported.`);
      return;
    }

    if (files.length > MAX_TARGET_COUNT) {
      selectedFiles = [];
      compileButton.disabled = true;
      setStatus(`Please choose ${MAX_TARGET_COUNT} target images or fewer for this prototype.`);
      return;
    }

    selectedFiles = files;
    renderTargetPreviews(files);
    compileButton.disabled = false;
    compiledMindFileName = targetMindFileName(files);
    setStatus(`Ready: ${files.length} target image${files.length === 1 ? "" : "s"}. Output will be ${compiledMindFileName}.`);
  });

  if (overlayInput && overlayImagePreview && overlayVideoPreview && overlayStatus) {
    overlayInput.addEventListener("change", () => {
      revokeOverlayPreviewUrl();
      overlayImagePreview.classList.add("hidden");
      overlayVideoPreview.classList.add("hidden");
      overlayImagePreview.removeAttribute("src");
      overlayVideoPreview.pause();
      overlayVideoPreview.removeAttribute("src");

      const file = overlayInput.files && overlayInput.files[0];
      if (!file) {
        overlayStatus.textContent = "Choose an overlay image or MP4 to preview. This prototype does not deploy it yet.";
        return;
      }

      if (!file.type.startsWith("image/") && file.type !== "video/mp4") {
        overlayStatus.textContent = "Please choose a PNG, JPG, WebP, or MP4 file.";
        return;
      }

      overlayPreviewUrl = URL.createObjectURL(file);
      if (file.type.startsWith("image/")) {
        overlayImagePreview.src = overlayPreviewUrl;
        overlayImagePreview.classList.remove("hidden");
      } else {
        overlayVideoPreview.src = overlayPreviewUrl;
        overlayVideoPreview.classList.remove("hidden");
      }
      overlayStatus.textContent = `Preview ready: ${file.name}`;
    });
  }

  compileButton.addEventListener("click", async () => {
    if (!selectedFiles.length) return;

    clearCompiledResult();
    compileButton.disabled = true;
    downloadButton.disabled = true;
    progress.value = 0;
    progress.classList.remove("hidden");
    setStatus("Loading MindAR compiler...");

    try {
      const Compiler = await loadCompiler();
      const targetImages = [];

      for (let index = 0; index < selectedFiles.length; index++) {
        const file = selectedFiles[index];
        setStatus(`Preparing target ${index + 1} of ${selectedFiles.length}: ${file.name}`);
        targetImages.push(await createCompileImage(file));
      }

      const compiler = new Compiler();

      setStatus(`Compiling ${targetImages.length} target image${targetImages.length === 1 ? "" : "s"}...`);
      await compiler.compileImageTargets(targetImages, (percent) => {
        progress.value = clampPercent(percent);
        setStatus(`Compiling... ${Math.round(progress.value)}%`);
      });

      const exported = compiler.exportData();
      compiledMindBlob = new Blob([exported], { type: "application/octet-stream" });
      progress.value = 100;
      downloadButton.disabled = false;
      setStatus(`Success. ${compiledMindFileName} is ready (${formatBytes(compiledMindBlob.size)}).`);
    } catch (error) {
      console.error(error);
      progress.classList.add("hidden");
      setStatus(`Compile failed: ${friendlyError(error)}`);
    } finally {
      compileButton.disabled = !selectedFiles.length;
    }
  });

  downloadButton.addEventListener("click", async () => {
    if (!compiledMindBlob) return;
    if (window.showSaveFilePicker) {
      try {
        await saveMindWithPicker(compiledMindBlob, compiledMindFileName);
        setStatus(`Saved ${compiledMindFileName}. For the current viewer, place it in assets as targets.mind.`);
        return;
      } catch (error) {
        if (error.name === "AbortError") {
          setStatus("Save cancelled. The compiled targets.mind is still ready.");
          return;
        }
        console.warn("Save picker failed, falling back to download", error);
        setStatus("Save picker failed, downloading with browser default instead.");
      }
    }

    downloadMindBlob(compiledMindBlob, compiledMindFileName);
  });

  async function saveMindWithPicker(blob, fileName) {
    const handle = await window.showSaveFilePicker({
      suggestedName: fileName,
      types: [
        {
          description: "MindAR image target",
          accept: {
            "application/octet-stream": [".mind"]
          }
        }
      ]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  function downloadMindBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
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

  async function createCompileImage(file) {
    const originalImage = await loadImageFromFile(file);
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

  function loadImageFromFile(file) {
    return loadImageFromBlob(file);
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
        reject(new Error("Could not read the selected image."));
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
          reject(new Error("Could not resize the selected image."));
        }
      }, "image/png");
    });
  }

  function clearCompiledResult() {
    compiledMindBlob = null;
    downloadButton.disabled = true;
    progress.value = 0;
    progress.classList.add("hidden");
  }

  function targetMindFileName(files) {
    const names = files.map((file, index) => safeFileBaseName(file.name) || `target-${index + 1}`);
    if (!names.length) return "targets.mind";
    if (names.length === 1) return `${names[0]}.targets.mind`;

    const prefix = names.slice(0, 3).join("-");
    return `${prefix}-${names.length}-targets.mind`;
  }

  function safeFileBaseName(fileName) {
    return fileName
      .replace(/\.[^.]*$/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function renderTargetPreviews(files) {
    clearTargetPreviews();

    files.forEach((file) => {
      const url = URL.createObjectURL(file);
      previewUrls.push(url);

      const item = document.createElement("div");
      item.className = "target-preview-item";

      const image = document.createElement("img");
      image.src = url;
      image.alt = `${file.name} preview`;

      const label = document.createElement("span");
      label.textContent = file.name;

      item.append(image, label);
      previewList.append(item);
    });

    previewList.classList.remove("hidden");
  }

  function clearTargetPreviews() {
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls = [];
    previewList.replaceChildren();
    previewList.classList.add("hidden");
  }

  function revokeOverlayPreviewUrl() {
    if (overlayPreviewUrl) {
      URL.revokeObjectURL(overlayPreviewUrl);
      overlayPreviewUrl = null;
    }
  }

  function setStatus(message) {
    statusText.textContent = message;
  }

  function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, number));
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function friendlyError(error) {
    if (!navigator.onLine) {
      return "internet connection is required the first time the compiler bundle loads.";
    }
    return error && error.message ? error.message : "unknown error";
  }
})();
