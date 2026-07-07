(function () {
  const config = window.AR_VIEWER_CONFIG;
  const library = window.AR_LIBRARY;
  let enabledTargets = getEnabledTargets(library);
  let activeTarget = enabledTargets[0];
  const scene = document.querySelector("a-scene");
  const shell = document.querySelector("#creatorShell");
  const startButton = document.querySelector("#creatorStartButton");
  const statusBox = document.querySelector("#creatorStatus");
  const panelToggle = document.querySelector("#panelToggle");
  const tabButtons = Array.from(document.querySelectorAll(".creator-tab"));
  const tabPanels = Array.from(document.querySelectorAll(".creator-tab-panel"));
  const controlsRoot = document.querySelector("#overlayControls");
  const snippetBox = document.querySelector("#overlaySnippet");
  const deployConfigButton = document.querySelector("#deployConfigButton");
  const saveConfigButton = document.querySelector("#saveConfigButton");
  const downloadButton = document.querySelector("#downloadSnippetButton");
  const targetSelect = document.querySelector("#overlayTargetSelect");
  const libraryButton = document.querySelector("#libraryButton");
  const libraryPanel = document.querySelector("#libraryPanel");
  const libraryTitle = document.querySelector("#libraryTitle");
  const libraryClearTrashButton = document.querySelector("#libraryClearTrashButton");
  const libraryTrashButton = document.querySelector("#libraryTrashButton");
  const libraryCloseButton = document.querySelector("#libraryCloseButton");
  const libraryStatus = document.querySelector("#libraryStatus");
  const libraryList = document.querySelector("#libraryList");
  const libraryPreviewModal = document.querySelector("#libraryPreviewModal");
  const libraryPreviewTitle = document.querySelector("#libraryPreviewTitle");
  const libraryPreviewCloseButton = document.querySelector("#libraryPreviewCloseButton");
  const libraryPreviewImage = document.querySelector("#libraryPreviewImage");
  const libraryPreviewVideo = document.querySelector("#libraryPreviewVideo");
  let target = document.querySelector("#creatorImageTarget");
  const video = document.querySelector("#creatorArVideo");
  let overlay = target.querySelector("a-video");
  const controlInputs = new Map();
  let libraryMode = "targets";

  if (!activeTarget) {
    statusBox.textContent = "AR_LIBRARY has no enabled targets.";
    startButton.disabled = true;
    return;
  }

  let baseOverlay = overlayStateFromTarget(activeTarget);
  let baseUpdatedAt = activeTarget.updatedAt || "";
  const state = {
    width: baseOverlay.width,
    height: baseOverlay.height,
    position: { ...baseOverlay.position },
    rotation: { ...baseOverlay.rotation }
  };

  const controls = [
    { key: "width", label: "Width", min: 0.1, max: 2.5, step: 0.001 },
    { key: "height", label: "Height", min: 0.1, max: 2.5, step: 0.001 },
    { key: "position.x", label: "Position X", min: -1.5, max: 1.5, step: 0.001 },
    { key: "position.y", label: "Position Y", min: -1.5, max: 1.5, step: 0.001 },
    { key: "position.z", label: "Position Z", min: -0.2, max: 0.4, step: 0.001 },
    { key: "rotation.x", label: "Rotation X", min: -180, max: 180, step: 0.1 },
    { key: "rotation.y", label: "Rotation Y", min: -180, max: 180, step: 0.1 },
    { key: "rotation.z", label: "Rotation Z", min: -180, max: 180, step: 0.1 }
  ];

  let hasStarted = false;

  scene.setAttribute(
    "mindar-image",
    `imageTargetSrc: ${library.targetFile}; autoStart: false; uiScanning: yes; uiLoading: yes; uiError: yes;`
  );

  statusBox.textContent = config.ui.initialText;
  startButton.textContent = config.ui.startButtonText;
  deployConfigButton.textContent = "Save & Deploy Library";

  populateTargetSelect();
  controls.forEach(createControl);
  applySelectedTarget(activeTarget.id, { showStatus: false });
  applyOverlayState();

  startButton.addEventListener("click", async () => {
    try {
      try {
        await video.play();
        video.pause();
        video.currentTime = 0;
      } catch (error) {
        console.warn("Creator video unlock failed", {
          src: video.currentSrc || video.src,
          name: error && error.name,
          message: error && error.message
        });
      }

      const mindarSystem = scene.systems["mindar-image-system"];
      await mindarSystem.start();

      hasStarted = true;
      startButton.classList.add("hidden");
      statusBox.textContent = config.ui.scanningText;
    } catch (error) {
      console.error(error);
      statusBox.textContent = `${config.ui.errorText}: ${error.name || "Error"} ${error.message || error}`;
    }
  });

  panelToggle.addEventListener("click", () => {
    const isCollapsed = shell.classList.toggle("is-collapsed");
    panelToggle.textContent = isCollapsed ? "แผง" : "ยุบ";
    panelToggle.setAttribute("aria-expanded", String(!isCollapsed));
  });

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });

  deployConfigButton.addEventListener("click", deployOverlayConfig);
  saveConfigButton.addEventListener("click", saveOverlayToLibrary);
  targetSelect.addEventListener("change", () => {
    applySelectedTarget(targetSelect.value, { showStatus: true });
  });
  video.addEventListener("error", () => {
    statusBox.textContent = `This browser could not play ${fileNameFromPath(activeTarget.overlayPath)}. Try a browser that supports this overlay format.`;
  });
  video.addEventListener("ended", handlePreviewVideoEnded);
  libraryButton.addEventListener("click", openLibraryPanel);
  libraryTrashButton.addEventListener("click", () => {
    if (libraryMode === "trash") {
      openLibraryPanel();
      return;
    }
    openLibraryTrashPanel();
  });
  libraryClearTrashButton.addEventListener("click", clearDeletedTargets);
  libraryCloseButton.addEventListener("click", closeLibraryPanel);
  libraryPreviewCloseButton.addEventListener("click", closeLibraryPreview);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      if (!libraryPreviewModal.classList.contains("hidden")) {
        trapFocus(libraryPreviewModal, event);
        return;
      }
      if (!libraryPanel.classList.contains("hidden")) {
        trapFocus(libraryPanel, event);
        return;
      }
    }
    if (event.key !== "Escape") return;
    if (!libraryPreviewModal.classList.contains("hidden")) {
      closeLibraryPreview();
      return;
    }
    if (!libraryPanel.classList.contains("hidden")) {
      closeLibraryPanel();
    }
  });
  window.addEventListener("ar-library-updated", () => {
    refreshLibraryState();
    if (!libraryPanel.classList.contains("hidden")) {
      if (libraryMode === "trash") {
        openLibraryTrashPanel();
      } else {
        renderLibraryPanel();
      }
    }
  });

  downloadButton.addEventListener("click", () => {
    const blob = new Blob([buildOverlaySnippet()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "overlay-snippet.js";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  function openLibraryPanel() {
    libraryMode = "targets";
    libraryTitle.textContent = "Target Library";
    libraryClearTrashButton.classList.add("hidden");
    libraryTrashButton.textContent = "Trash";
    libraryTrashButton.setAttribute("aria-label", "Deleted targets");
    renderLibraryPanel();
    libraryPanel.classList.remove("hidden");
    libraryCloseButton.focus();
  }

  async function openLibraryTrashPanel() {
    libraryMode = "trash";
    libraryTitle.textContent = "Deleted Targets";
    libraryClearTrashButton.classList.remove("hidden");
    libraryTrashButton.textContent = "Library";
    libraryTrashButton.setAttribute("aria-label", "Back to target library");
    libraryStatus.textContent = "Loading deleted targets...";
    libraryList.replaceChildren();
    libraryPanel.classList.remove("hidden");
    try {
      const result = await window.CreatorProjectSetup.listDeletedTargets();
      renderDeletedTargets(result.deletedTargets || []);
    } catch (error) {
      console.error(error);
      libraryStatus.textContent = `Could not load deleted targets: ${friendlyHelperError(error)}`;
    }
    libraryCloseButton.focus();
  }

  function closeLibraryPanel() {
    closeLibraryPreview();
    libraryPanel.classList.add("hidden");
    libraryButton.focus();
  }

  function renderLibraryPanel() {
    const targets = getLibraryTargets();
    const enabledCount = targets.filter((item) => item.enabled).length;
    const disabledCount = targets.length - enabledCount;
    libraryStatus.textContent = `${targets.length} targets · ${enabledCount} enabled · ${disabledCount} disabled`;
    libraryList.replaceChildren();

    if (!targets.length) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = "No targets in this library yet.";
      libraryList.append(empty);
      return;
    }

    targets.forEach((targetConfig) => {
      libraryList.append(createLibraryCard(targetConfig));
    });
  }

  function renderDeletedTargets(deletedTargets) {
    libraryStatus.textContent = `${deletedTargets.length} deleted target${deletedTargets.length === 1 ? "" : "s"} available to restore`;
    libraryList.replaceChildren();

    if (!deletedTargets.length) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = "Trash is empty.";
      libraryList.append(empty);
      return;
    }

    deletedTargets.forEach((deletedTarget) => {
      libraryList.append(createDeletedTargetCard(deletedTarget));
    });
  }

  function createLibraryCard(targetConfig) {
    const card = document.createElement("article");
    card.className = "library-card";

    const media = document.createElement("div");
    media.className = "library-card-media";

    const image = document.createElement("img");
    image.src = targetConfig.imagePath;
    image.alt = `${targetConfig.name} target`;
    image.loading = "lazy";
    image.addEventListener("error", () => {
      image.removeAttribute("src");
      image.alt = `${targetConfig.name} target thumbnail unavailable`;
      image.style.background = "#dddddd";
    });

    const videoPreview = document.createElement("video");
    videoPreview.src = targetConfig.overlayPath;
    videoPreview.muted = true;
    videoPreview.controls = true;
    videoPreview.preload = "metadata";
    videoPreview.playsInline = true;
    videoPreview.addEventListener("play", () => pauseOtherLibraryVideos(videoPreview));
    videoPreview.addEventListener("error", () => {
      statusBox.textContent = `This browser could not preview ${fileNameFromPath(targetConfig.overlayPath)}.`;
    });

    media.append(image, videoPreview);

    const body = document.createElement("div");
    body.className = "library-card-body";

    const title = document.createElement("div");
    title.className = "library-card-title";
    const name = document.createElement("h3");
    name.textContent = targetConfig.name;
    const badge = document.createElement("span");
    badge.className = targetConfig.enabled ? "library-badge" : "library-badge is-disabled";
    badge.textContent = targetConfig.enabled ? "Enabled" : "Disabled";
    title.append(name, badge);

    const meta = document.createElement("div");
    meta.className = "library-meta";
    appendMeta(meta, "id", targetConfig.id);
    appendMeta(meta, "targetIndex", targetConfig.targetIndex ?? "none");
    appendMeta(meta, "target image", fileNameFromPath(targetConfig.imagePath));
    appendMeta(meta, "overlay video", fileNameFromPath(targetConfig.overlayPath));
    if (targetConfig.overlayLoopPath) {
      appendMeta(meta, "loop video", fileNameFromPath(targetConfig.overlayLoopPath));
    }
    appendMeta(meta, "updatedAt", targetConfig.updatedAt || "none");

    const actions = document.createElement("div");
    actions.className = "library-card-actions";
    actions.append(
      createLibraryAction("Preview", () => openLibraryPreview(targetConfig)),
      createLibraryAction("Edit", () => editOverlayTarget(targetConfig.id)),
      createLibraryAction("Delete", () => deleteLibraryTarget(targetConfig))
    );

    body.append(title, meta, actions);
    card.append(media, body);
    return card;
  }

  function createDeletedTargetCard(deletedTarget) {
    const targetConfig = deletedTarget.originalTarget || {};
    const card = document.createElement("article");
    card.className = "library-card";

    const media = document.createElement("div");
    media.className = "library-card-media";

    const image = document.createElement("img");
    image.src = deletedTarget.imagePath || "";
    image.alt = `${deletedTarget.targetName} deleted target`;
    image.loading = "lazy";

    const videoPreview = document.createElement("video");
    videoPreview.src = deletedTarget.overlayPath || "";
    videoPreview.muted = true;
    videoPreview.controls = true;
    videoPreview.preload = "metadata";
    videoPreview.playsInline = true;
    videoPreview.addEventListener("play", () => pauseOtherLibraryVideos(videoPreview));
    videoPreview.addEventListener("error", () => {
      statusBox.textContent = `This browser could not preview ${fileNameFromPath(deletedTarget.overlayPath)}.`;
    });
    media.append(image, videoPreview);

    const body = document.createElement("div");
    body.className = "library-card-body";

    const title = document.createElement("div");
    title.className = "library-card-title";
    const name = document.createElement("h3");
    name.textContent = deletedTarget.targetName || deletedTarget.targetId;
    const badge = document.createElement("span");
    badge.className = "library-badge is-disabled";
    badge.textContent = "Deleted";
    title.append(name, badge);

    const meta = document.createElement("div");
    meta.className = "library-meta";
    appendMeta(meta, "id", deletedTarget.targetId);
    appendMeta(meta, "deletedAt", deletedTarget.deletedAt || "none");
    appendMeta(meta, "expires", deletedTarget.expiresAt || "none");
    appendMeta(meta, "target image", fileNameFromPath(targetConfig.imagePath));
    appendMeta(meta, "overlay video", fileNameFromPath(targetConfig.overlayPath));

    const actions = document.createElement("div");
    actions.className = "library-card-actions";
    actions.append(
      createLibraryAction("Preview", () => openDeletedTargetPreview(deletedTarget)),
      createLibraryAction("Restore", () => restoreDeletedTarget(deletedTarget))
    );

    body.append(title, meta, actions);
    card.append(media, body);
    return card;
  }

  function appendMeta(root, label, value) {
    const row = document.createElement("div");
    row.textContent = `${label}: ${value}`;
    root.append(row);
  }

  function createLibraryAction(label, handler, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = Boolean(options.disabled);
    if (options.title) {
      button.title = options.title;
      button.setAttribute("aria-label", `${label}: ${options.title}`);
    }
    button.addEventListener("click", handler);
    return button;
  }

  function openLibraryPreview(targetConfig) {
    pauseOtherLibraryVideos(null);
    libraryPreviewTitle.textContent = `${targetConfig.name} preview`;
    libraryPreviewImage.src = targetConfig.imagePath;
    libraryPreviewImage.alt = `${targetConfig.name} target preview`;
    libraryPreviewVideo.pause();
    libraryPreviewVideo.src = targetConfig.overlayPath;
    libraryPreviewVideo.muted = true;
    libraryPreviewVideo.onerror = () => {
      statusBox.textContent = `This browser could not preview ${fileNameFromPath(targetConfig.overlayPath)}.`;
    };
    libraryPreviewVideo.load();
    libraryPreviewModal.classList.remove("hidden");
    libraryPreviewCloseButton.focus();
  }

  function openDeletedTargetPreview(deletedTarget) {
    pauseOtherLibraryVideos(null);
    libraryPreviewTitle.textContent = `${deletedTarget.targetName || deletedTarget.targetId} preview`;
    libraryPreviewImage.src = deletedTarget.imagePath || "";
    libraryPreviewImage.alt = `${deletedTarget.targetName || deletedTarget.targetId} deleted target preview`;
    libraryPreviewVideo.pause();
    libraryPreviewVideo.src = deletedTarget.overlayPath || "";
    libraryPreviewVideo.muted = true;
    libraryPreviewVideo.onerror = () => {
      statusBox.textContent = `This browser could not preview ${fileNameFromPath(deletedTarget.overlayPath)}.`;
    };
    libraryPreviewVideo.load();
    libraryPreviewModal.classList.remove("hidden");
    libraryPreviewCloseButton.focus();
  }

  function closeLibraryPreview() {
    libraryPreviewModal.classList.add("hidden");
    libraryPreviewVideo.pause();
    libraryPreviewVideo.onerror = null;
    libraryPreviewVideo.removeAttribute("src");
    libraryPreviewVideo.load();
  }

  function editOverlayTarget(targetId) {
    const targetConfig = getLibraryTargets().find((item) => item.id === targetId);
    if (targetConfig && !targetConfig.enabled) {
      statusBox.textContent = `${targetConfig.name} is disabled. Enable it before adjusting overlay preview.`;
      return;
    }
    if (window.CreatorProjectSetup && window.CreatorProjectSetup.editTarget) {
      window.CreatorProjectSetup.editTarget(targetId);
    }
    closeLibraryPanel();
    setActiveTab("adjust");
    applySelectedTarget(targetId, { showStatus: true });
  }

  async function deleteLibraryTarget(targetConfig) {
    if (!window.CreatorProjectSetup || !window.CreatorProjectSetup.deleteTarget) {
      statusBox.textContent = "Delete helper is not ready. Refresh Creator and try again.";
      return;
    }

    const confirmed = window.confirm([
      `Delete ${targetConfig.name}?`,
      "",
      "This will remove it from the active library, move its files to assets/_deleted for 7 days, and recompile the remaining targets.",
      "",
      `Target image: ${targetConfig.imagePath}`,
      `Overlay video: ${targetConfig.overlayPath}`
    ].join("\n"));
    if (!confirmed) {
      statusBox.textContent = `Delete cancelled for ${targetConfig.name}.`;
      return;
    }

    statusBox.textContent = `Deleting ${targetConfig.name} from local library...`;
    try {
      const result = await window.CreatorProjectSetup.deleteTarget(targetConfig.id);
      window.AR_LIBRARY = result.library;
      window.dispatchEvent(new CustomEvent("ar-library-updated"));
      refreshLibraryState();
      renderLibraryPanel();
      statusBox.textContent = `Deleted ${targetConfig.name}. Files moved to assets/_deleted for 7 days.`;
    } catch (error) {
      console.error(error);
      statusBox.textContent = `Delete failed for ${targetConfig.name}: ${error.message}`;
    }
  }

  async function restoreDeletedTarget(deletedTarget) {
    if (!window.CreatorProjectSetup || !window.CreatorProjectSetup.restoreTarget) {
      statusBox.textContent = "Restore helper is not ready. Refresh Creator and try again.";
      return;
    }

    const confirmed = window.confirm([
      `Restore ${deletedTarget.targetName || deletedTarget.targetId}?`,
      "",
      "This will move its files back into assets/targets and assets/overlays, add it to the library, and recompile all enabled targets.",
      "",
      "Continue?"
    ].join("\n"));
    if (!confirmed) {
      statusBox.textContent = `Restore cancelled for ${deletedTarget.targetName || deletedTarget.targetId}.`;
      return;
    }

    statusBox.textContent = `Restoring ${deletedTarget.targetName || deletedTarget.targetId}...`;
    try {
      const result = await window.CreatorProjectSetup.restoreTarget(deletedTarget);
      window.AR_LIBRARY = result.library;
      window.dispatchEvent(new CustomEvent("ar-library-updated"));
      refreshLibraryState();
      await openLibraryTrashPanel();
      statusBox.textContent = `Restored ${deletedTarget.targetName || deletedTarget.targetId}. Active targets: ${result.activeTargets}.`;
    } catch (error) {
      console.error(error);
      statusBox.textContent = `Restore failed for ${deletedTarget.targetName || deletedTarget.targetId}: ${error.message}`;
    }
  }

  async function clearDeletedTargets() {
    if (!window.CreatorProjectSetup || !window.CreatorProjectSetup.clearDeletedTargets) {
      statusBox.textContent = "Clear trash helper is not ready. Refresh Creator and try again.";
      return;
    }

    const typed = window.prompt([
      "This permanently deletes every folder in assets/_deleted.",
      "You will not be able to restore these targets after this.",
      "",
      "Type DELETE to permanently clear the trash."
    ].join("\n"));
    if (typed !== "DELETE") {
      statusBox.textContent = "Clear trash cancelled. Type DELETE exactly to clear permanently.";
      return;
    }

    libraryClearTrashButton.disabled = true;
    statusBox.textContent = "Clearing deleted targets permanently...";
    try {
      const result = await window.CreatorProjectSetup.clearDeletedTargets();
      await openLibraryTrashPanel();
      statusBox.textContent = `Cleared ${result.deletedCount} deleted target folder${result.deletedCount === 1 ? "" : "s"} permanently.`;
    } catch (error) {
      console.error(error);
      statusBox.textContent = `Clear trash failed: ${friendlyHelperError(error)}`;
    } finally {
      libraryClearTrashButton.disabled = false;
    }
  }

  function pauseOtherLibraryVideos(currentVideo) {
    libraryList.querySelectorAll("video").forEach((item) => {
      if (item !== currentVideo) {
        item.pause();
      }
    });
    if (libraryPreviewVideo !== currentVideo) {
      libraryPreviewVideo.pause();
    }
  }

  function trapFocus(root, event) {
    const focusable = Array.from(
      root.querySelectorAll("button, [href], input, select, textarea, video, [tabindex]:not([tabindex='-1'])")
    ).filter((item) => !item.disabled && item.offsetParent !== null);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function refreshLibraryState() {
    const currentTargetId = activeTarget && activeTarget.id;
    enabledTargets = getEnabledTargets(window.AR_LIBRARY);
    const refreshedTarget =
      enabledTargets.find((item) => item.id === currentTargetId) ||
      enabledTargets[0];
    if (!refreshedTarget) return;
    activeTarget = refreshedTarget;
    populateTargetSelect();
    targetSelect.value = activeTarget.id;
    baseUpdatedAt = activeTarget.updatedAt || "";
  }

  async function handleTargetFound() {
    statusBox.textContent = config.ui.foundText;
    const videoConfig = activeTarget.video || {};
    if (!hasStarted || videoConfig.autoplay === false) return;
    try {
      if (activeTarget.overlayLoopPath) {
        resetPreviewVideoSequence();
      }
      await video.play();
    } catch (error) {
      console.warn("Video play was blocked", error);
    }
  }

  function handleTargetLost() {
    statusBox.textContent = config.ui.lostText;
    video.pause();
    if (activeTarget.overlayLoopPath) {
      resetPreviewVideoSequence();
    }
  }

  function populateTargetSelect() {
    targetSelect.replaceChildren();
    enabledTargets.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.name} (${item.id})`;
      targetSelect.append(option);
    });
    targetSelect.value = activeTarget.id;
  }

  async function applySelectedTarget(targetId, { showStatus }) {
    const nextTarget = enabledTargets.find((item) => item.id === targetId);
    if (!nextTarget) return;

    const mindarSystem = scene.systems["mindar-image-system"];
    const shouldRestartTracking = hasStarted && mindarSystem;
    if (shouldRestartTracking) {
      try {
        mindarSystem.stop();
      } catch (error) {
        console.warn("MindAR stop before target switch failed", error);
      }
    }

    activeTarget = nextTarget;
    targetSelect.value = activeTarget.id;
    video.pause();
    video.currentTime = 0;
    applyVideoConfig(activeTarget);
    recreateTargetEntity(activeTarget);
    loadOverlayState(activeTarget);

    if (showStatus) {
      statusBox.textContent = `Adjusting overlay for ${activeTarget.name}.`;
    }

    if (shouldRestartTracking) {
      try {
        await video.play();
        video.pause();
        video.currentTime = 0;
        await mindarSystem.start();
      } catch (error) {
        console.warn("Restart after target switch failed", error);
        statusBox.textContent = `Switch target failed. Refresh Creator and try ${activeTarget.name} again.`;
      }
    }
  }

  function recreateTargetEntity(targetConfig) {
    if (target && target.parentNode) {
      target.remove();
    }

    const nextTarget = document.createElement("a-entity");
    nextTarget.id = "creatorImageTarget";
    nextTarget.setAttribute("mindar-image-target", `targetIndex: ${targetConfig.targetIndex}`);

    const nextOverlay = document.createElement("a-video");
    nextOverlay.setAttribute("src", "#creatorArVideo");
    nextOverlay.setAttribute("material", "transparent: true; alphaTest: 0.01");
    nextTarget.append(nextOverlay);

    nextTarget.addEventListener("targetFound", handleTargetFound);
    nextTarget.addEventListener("targetLost", handleTargetLost);

    scene.append(nextTarget);
    target = nextTarget;
    overlay = nextOverlay;
  }

  function applyVideoConfig(targetConfig) {
    const videoConfig = targetConfig.video || {};
    video.pause();
    video.src = targetConfig.overlayPath;
    video.loop = targetConfig.overlayLoopPath ? false : videoConfig.loop !== undefined ? videoConfig.loop : true;
    video.muted = videoConfig.muted !== undefined ? videoConfig.muted : true;
    video.playsInline = videoConfig.playsInline !== undefined ? videoConfig.playsInline : true;
    video.toggleAttribute("loop", video.loop);
    video.toggleAttribute("muted", video.muted);
    video.toggleAttribute("playsinline", video.playsInline);
    video.toggleAttribute("webkit-playsinline", video.playsInline);
    video.load();
  }

  function handlePreviewVideoEnded() {
    if (!activeTarget || !activeTarget.overlayLoopPath) return;
    video.pause();
    video.src = activeTarget.overlayLoopPath;
    video.loop = true;
    video.toggleAttribute("loop", true);
    video.load();
    video.play().catch((error) => {
      console.warn("Creator loop video play was blocked", error);
    });
  }

  function resetPreviewVideoSequence() {
    if (!activeTarget || !activeTarget.overlayPath || !activeTarget.overlayLoopPath) return;
    const videoConfig = activeTarget.video || {};
    const desiredLoop = activeTarget.overlayLoopPath ? false : videoConfig.loop !== undefined ? videoConfig.loop : true;
    if (!isSameVideoSource(video, activeTarget.overlayPath)) {
      video.src = activeTarget.overlayPath;
      video.load();
    }
    video.loop = desiredLoop;
    video.toggleAttribute("loop", desiredLoop);
    try {
      video.currentTime = 0;
    } catch (error) {
      console.warn("Could not reset Creator video time", error);
    }
  }

  function isSameVideoSource(videoElement, source) {
    const currentSource = videoElement.currentSrc || videoElement.src || "";
    if (!currentSource || !source) return false;
    try {
      return new URL(currentSource, window.location.href).href === new URL(source, window.location.href).href;
    } catch (_error) {
      return currentSource === source;
    }
  }

  function loadOverlayState(targetConfig) {
    baseOverlay = overlayStateFromTarget(targetConfig);
    baseUpdatedAt = targetConfig.updatedAt || "";
    state.width = baseOverlay.width;
    state.height = baseOverlay.height;
    state.position = { ...baseOverlay.position };
    state.rotation = { ...baseOverlay.rotation };
    updateControlValues();
    applyOverlayState();
  }

  function createControl(control) {
    const value = getStateValue(control.key);
    const group = document.createElement("label");
    group.className = "control-group";

    const label = document.createElement("span");
    label.className = "control-label";
    label.textContent = control.label;

    const row = document.createElement("span");
    row.className = "control-row";

    const range = document.createElement("input");
    range.type = "range";
    range.min = control.min;
    range.max = control.max;
    range.step = control.step;
    range.value = value;

    const number = document.createElement("input");
    number.type = "number";
    number.min = control.min;
    number.max = control.max;
    number.step = control.step;
    number.value = value;

    const sync = (event) => {
      const nextValue = Number(event.target.value);
      if (Number.isNaN(nextValue)) return;
      setStateValue(control.key, nextValue);
      range.value = nextValue;
      number.value = nextValue;
      applyOverlayState();
    };

    range.addEventListener("input", sync);
    number.addEventListener("input", sync);
    controlInputs.set(control.key, { range, number });

    row.append(range, number);
    group.append(label, row);
    controlsRoot.append(group);
  }

  function updateControlValues() {
    controls.forEach((control) => {
      const inputs = controlInputs.get(control.key);
      if (!inputs) return;
      const value = getStateValue(control.key);
      inputs.range.value = value;
      inputs.number.value = value;
    });
  }

  function setActiveTab(tabName) {
    tabButtons.forEach((button) => {
      const isActive = button.dataset.tab === tabName;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });

    tabPanels.forEach((panel) => {
      const isActive = panel.id === `${tabName}TabPanel`;
      panel.classList.toggle("hidden", !isActive);
    });
  }

  function applyOverlayState() {
    overlay.setAttribute("width", formatNumber(state.width));
    overlay.setAttribute("height", formatNumber(state.height));
    overlay.setAttribute("position", vectorToString(state.position));
    overlay.setAttribute("rotation", vectorToString(state.rotation));
    snippetBox.value = buildOverlaySnippet();
  }

  function buildOverlaySnippet() {
    return [
      "overlay: {",
      `  width: ${formatNumber(state.width)},`,
      `  height: ${formatNumber(state.height)},`,
      `  position: "${vectorToString(state.position)}",`,
      `  rotation: "${vectorToString(state.rotation)}"`,
      "}"
    ].join("\n");
  }

  async function deployOverlayConfig() {
    deployConfigButton.disabled = true;
    saveConfigButton.disabled = true;
    statusBox.textContent = "Validating library from disk...";

    try {
      const payload = getDeployPayload();
      const result = await requestLibraryPrepare(payload);

      snippetBox.value = buildPrepareDeployReport(result);
      if (!result.ready) {
        statusBox.textContent = "Library is not ready to deploy. See the report below.";
        return;
      }

      if (!confirmDeploy(result)) {
        statusBox.textContent = "Deploy cancelled. No git state was changed.";
        return;
      }

      statusBox.textContent = "Validating and deploying library... This may take up to 2 minutes.";
      const deployResult = await requestLibraryDeploy({
        ...payload,
        confirmedFiles: result.filesToDeploy
      });
      if (!deployResult.deployed) {
        snippetBox.value = buildNoDeployReport(deployResult);
        statusBox.textContent = deployResult.message || "Nothing new to deploy.";
        return;
      }
      snippetBox.value = buildDeploySuccessReport(deployResult);
      statusBox.textContent = `Deploy successful: ${deployResult.shortCommitSha} pushed to ${deployResult.remote}.`;
    } catch (error) {
      console.error(error);
      statusBox.textContent = error.name === "AbortError"
        ? "Request timed out. Check the helper window and git status before trying again."
        : `Deploy failed: ${error.message}`;
    } finally {
      deployConfigButton.disabled = false;
      saveConfigButton.disabled = false;
    }
  }

  function getDeployPayload() {
    return {
      baseLibraryVersion: window.AR_LIBRARY && window.AR_LIBRARY.version,
      baseTargetStates: getBaseTargetStates()
    };
  }

  async function requestLibraryPrepare(payload) {
    const response = await fetch("/api/library/prepare-deploy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Prepare deploy failed.");
    }
    return result;
  }

  async function requestLibraryDeploy(payload) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 180000);

    try {
      const response = await fetch("/api/library/deploy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Library deploy failed.");
      }
      return result;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function confirmDeploy(result) {
    return window.confirm([
      "Library พร้อม deploy:",
      `- ${result.librarySummary.enabledTargets} enabled targets`,
      `- ${result.filesToDeploy.length} files`,
      "- จะ commit และ push ไป origin/main",
      "- unrelated working-tree changes จะไม่ถูกรวม",
      "",
      "กด OK เพื่อ Save & Deploy หรือ Cancel เพื่อยกเลิก"
    ].join("\n"));
  }

  function getBaseTargetStates() {
    const sourceTargets =
      window.AR_LIBRARY && Array.isArray(window.AR_LIBRARY.targets)
        ? window.AR_LIBRARY.targets
        : [];
    return sourceTargets.map((targetConfig) => ({
      id: targetConfig.id,
      updatedAt: targetConfig.updatedAt || ""
    }));
  }

  function buildPrepareDeployReport(result) {
    const lines = [
      result.ready ? "Ready to deploy" : "Not ready to deploy",
      "",
      `Targets: ${result.librarySummary.enabledTargets}/${result.librarySummary.totalTargets} enabled`,
      "",
      "Files to deploy:",
      ...listLines(result.filesToDeploy),
      "",
      "Warnings:",
      ...listLines(result.warnings),
      "",
      "Unrelated working-tree changes:",
      ...listLines(result.unrelatedChanges)
    ];

    if (result.errors && result.errors.length) {
      lines.splice(2, 0, "", "Errors:", ...listLines(result.errors));
    }

    return lines.join("\n");
  }

  function buildDeploySuccessReport(result) {
    return [
      "Deploy successful",
      `Commit: ${result.shortCommitSha}`,
      `Branch: ${result.branch}`,
      `Pushed to: ${result.remote}`,
      `Targets: ${result.librarySummary.enabledTargets}`,
      `Files deployed: ${result.filesDeployed.length}`,
      "Netlify deployment should begin automatically.",
      "",
      "Files deployed:",
      ...listLines(result.filesDeployed)
    ].join("\n");
  }

  function buildNoDeployReport(result) {
    return [
      result.message || "Nothing new to deploy.",
      "",
      "Files checked:",
      ...listLines(result.filesDeployed),
      "",
      `Targets: ${result.librarySummary.enabledTargets}/${result.librarySummary.totalTargets} enabled`
    ].join("\n");
  }

  function listLines(items) {
    if (!items || !items.length) return ["- none"];
    return items.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`);
  }

  async function saveOverlayToLibrary() {
    saveConfigButton.disabled = true;
    try {
      statusBox.textContent = `Saving overlay for ${activeTarget.name}...`;
      const response = await fetch("/api/library/save-overlay", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          targetId: activeTarget.id,
          overlay: getOverlayPayload(),
          baseUpdatedAt
        })
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Save failed.");
      }

      window.AR_LIBRARY = result.library;
      enabledTargets = getEnabledTargets(window.AR_LIBRARY);
      populateTargetSelect();
      const savedTarget = result.library.targets.find((item) => item.id === activeTarget.id);
      if (savedTarget) {
        activeTarget = savedTarget;
        baseUpdatedAt = savedTarget.updatedAt || "";
        targetSelect.value = activeTarget.id;
      }
      window.dispatchEvent(new CustomEvent("ar-library-updated"));
      statusBox.textContent = `Saved overlay for ${activeTarget.name} locally.`;
    } catch (error) {
      console.error(error);
      if (/changed since Creator loaded/i.test(error.message)) {
        statusBox.textContent = `Conflict while saving ${activeTarget.name}. Refresh Creator and try again.`;
        return;
      }
      statusBox.textContent = `Save failed for ${activeTarget.name}: ${error.message}`;
    } finally {
      saveConfigButton.disabled = false;
    }
  }

  function getOverlayPayload() {
    return {
      width: Number(formatNumber(state.width)),
      height: Number(formatNumber(state.height)),
      position: vectorToString(state.position),
      rotation: vectorToString(state.rotation)
    };
  }

  function parseVector(value) {
    const parts = String(value).split(/\s+/).map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }

  function vectorToString(vector) {
    return `${formatNumber(vector.x)} ${formatNumber(vector.y)} ${formatNumber(vector.z)}`;
  }

  function formatNumber(value) {
    return Number(value.toFixed(4)).toString();
  }

  function getStateValue(path) {
    if (!path.includes(".")) return state[path];
    const parts = path.split(".");
    return state[parts[0]][parts[1]];
  }

  function setStateValue(path, value) {
    if (!path.includes(".")) {
      state[path] = value;
      return;
    }
    const parts = path.split(".");
    state[parts[0]][parts[1]] = value;
  }

  function overlayStateFromTarget(targetConfig) {
    const initialPosition = parseVector(targetConfig.overlay.position);
    const initialRotation = parseVector(targetConfig.overlay.rotation);
    return {
      width: Number(targetConfig.overlay.width),
      height: Number(targetConfig.overlay.height),
      position: {
        x: initialPosition[0],
        y: initialPosition[1],
        z: initialPosition[2]
      },
      rotation: {
        x: initialRotation[0],
        y: initialRotation[1],
        z: initialRotation[2]
      }
    };
  }

  function getEnabledTargets(library) {
    if (!library || !Array.isArray(library.targets)) {
      throw new Error("AR_LIBRARY is missing.");
    }
    return library.targets
      .filter((item) => item.enabled)
      .slice(0, library.maxActiveTargets || 15)
      .sort((a, b) => Number(a.targetIndex) - Number(b.targetIndex));
  }

  function getLibraryTargets() {
    const sourceTargets =
      window.AR_LIBRARY && Array.isArray(window.AR_LIBRARY.targets)
        ? window.AR_LIBRARY.targets
        : [];
    return [...sourceTargets].sort((a, b) => {
      const aIndex = Number(a.targetIndex);
      const bIndex = Number(b.targetIndex);
      const aHasIndex = Number.isFinite(aIndex);
      const bHasIndex = Number.isFinite(bIndex);
      if (aHasIndex && bHasIndex) return aIndex - bIndex;
      if (aHasIndex) return -1;
      if (bHasIndex) return 1;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
  }

  function fileNameFromPath(path) {
    return String(path || "").split("/").pop() || "none";
  }

  function friendlyHelperError(error) {
    const message = error && error.message ? error.message : "unknown error";
    if (/unknown endpoint/i.test(message)) {
      return "helper is still running old code. Close the run_creator.bat window, run it again, then reopen creator.html.";
    }
    return message;
  }
})();
