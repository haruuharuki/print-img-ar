(function () {
  window.ARLive = {
    init
  };

  function init({ statusBox }) {
    const liveButton = document.querySelector("#liveModeButton");
    const exitButton = document.querySelector("#liveExitButton");
    const deleteButton = document.querySelector("#liveDeleteButton");
    const layer = document.querySelector("#liveStickerLayer");

    if (!liveButton || !exitButton || !deleteButton || !layer) {
      return null;
    }

    let activeTargetState = null;
    let liveTargetState = null;
    let isStarted = false;
    let mode = "attached";
    let isTargetVisible = false;
    let sticker = null;
    let stickerVideo = null;
    let translateX = 0;
    let translateY = 0;
    let scale = 1;
    let rotationDegrees = 0;
    let dragStart = null;
    let resizeStart = null;
    let rotateStart = null;
    let selectionBox = null;
    let resizeHandle = null;
    let rotateHandle = null;
    let isSelectionVisible = false;
    const visibleTargetStates = new Map();
    const pointers = new Map();

    liveButton.addEventListener("click", enterLiveMode);
    exitButton.addEventListener("click", exitLiveMode);
    deleteButton.addEventListener("click", deleteSticker);

    function setStarted(value) {
      isStarted = value;
      updateLiveButton();
    }

    function setTargetVisible(value) {
      isTargetVisible = value;
      if (!value) {
        visibleTargetStates.clear();
      }
      if (mode !== "attached") {
        hideVisibleTargetOverlays();
      }
      updateLiveButton();
    }

    function setActiveTarget(targetState) {
      activeTargetState = targetState;
      if (mode !== "attached") {
        hideTargetOverlay(targetState);
        return;
      }
      updateLiveButton();
    }

    function setTargetVisibility(targetState, isVisible) {
      if (!targetState || !targetState.target) return;
      if (isVisible) {
        visibleTargetStates.set(targetState.target.id, targetState);
      } else {
        visibleTargetStates.delete(targetState.target.id);
      }
      isTargetVisible = visibleTargetStates.size > 0;
      if (mode !== "attached") {
        hideTargetOverlay(targetState);
      }
      updateLiveButton();
    }

    async function enterLiveMode() {
      if (!isStarted || !activeTargetState || mode !== "attached") return;

      mode = "live";
      liveTargetState = activeTargetState;
      translateX = 0;
      translateY = 0;
      scale = 1;
      rotationDegrees = 0;
      isSelectionVisible = true;
      layer.classList.remove("hidden");
      liveButton.classList.add("hidden");
      exitButton.classList.remove("hidden");
      deleteButton.classList.remove("hidden");
      hideVisibleTargetOverlays();

      try {
        await createSticker(liveTargetState);
        addViewportListeners();
        statusBox.textContent = `Live sticker: ${liveTargetState.target.name || liveTargetState.target.id}`;
        await stickerVideo.play();
      } catch (error) {
        console.warn("Live sticker play was blocked", error);
        statusBox.textContent = "Live sticker could not start. Returning to AR viewer.";
        exitLiveMode();
      }
    }

    function exitLiveMode() {
      if (mode === "attached") return;
      syncStickerTimeToAr();
      removeSticker();
      removeViewportListeners();
      mode = "attached";
      liveTargetState = null;
      layer.classList.add("hidden");
      exitButton.classList.add("hidden");
      deleteButton.classList.add("hidden");
      restoreVisibleTargetOverlays();
      updateLiveButton();
      statusBox.textContent = "Back to AR viewer.";
    }

    function deleteSticker() {
      if (mode !== "live") return;
      syncStickerTimeToAr();
      removeSticker();
      mode = "removed";
      deleteButton.classList.add("hidden");
      statusBox.textContent = "Live sticker removed.";
    }

    async function createSticker(targetState) {
      removeSticker();

      sticker = document.createElement("div");
      sticker.className = "live-sticker";
      stickerVideo = document.createElement("video");
      configureStickerVideo(targetState.video);
      stickerVideo.setAttribute("playsinline", "");
      stickerVideo.setAttribute("webkit-playsinline", "");
      stickerVideo.addEventListener("error", () => {
        statusBox.textContent = `This browser could not play ${fileNameFromPath(targetState.target.overlayPath)} as a Live sticker.`;
      });

      sticker.append(stickerVideo);
      layer.append(sticker);
      createSelectionBox();
      await syncArTimeToSticker(targetState.video);
      applyStickerTransform();
      bindStickerGestures(sticker);
      clampStickerPosition();
      updateSelectionBox();
    }

    function removeSticker() {
      unbindStickerGestures();
      removeSelectionBox();
      pointers.clear();
      dragStart = null;
      resizeStart = null;
      rotateStart = null;
      if (stickerVideo) {
        stickerVideo.pause();
        stickerVideo.removeAttribute("src");
        stickerVideo.load();
        stickerVideo = null;
      }
      if (sticker) {
        sticker.remove();
        sticker = null;
      }
    }

    function bindStickerGestures(element) {
      element.addEventListener("pointerdown", onPointerDown);
      element.addEventListener("pointermove", onPointerMove);
      element.addEventListener("pointerup", onPointerEnd);
      element.addEventListener("pointercancel", onPointerEnd);
    }

    function unbindStickerGestures() {
      if (!sticker) return;
      sticker.removeEventListener("pointerdown", onPointerDown);
      sticker.removeEventListener("pointermove", onPointerMove);
      sticker.removeEventListener("pointerup", onPointerEnd);
      sticker.removeEventListener("pointercancel", onPointerEnd);
    }

    function onPointerDown(event) {
      event.preventDefault();
      showSelectionBox();
      try {
        sticker.setPointerCapture(event.pointerId);
      } catch (error) {
        console.warn("Could not capture Live sticker pointer", error);
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size === 1) {
        dragStart = {
          x: event.clientX,
          y: event.clientY,
          translateX,
          translateY
        };
      } else if (pointers.size === 2) {
        dragStart = {
          distance: pointerDistance(),
          scale
        };
      }
    }

    function onPointerMove(event) {
      if (!pointers.has(event.pointerId)) return;
      event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size === 1 && dragStart && dragStart.x !== undefined) {
        translateX = dragStart.translateX + event.clientX - dragStart.x;
        translateY = dragStart.translateY + event.clientY - dragStart.y;
      } else if (pointers.size >= 2 && dragStart && dragStart.distance) {
        const nextDistance = pointerDistance();
        scale = clamp(dragStart.scale * (nextDistance / dragStart.distance), 0.35, 3);
      }

      clampStickerPosition();
      applyStickerTransform();
      updateSelectionBox();
    }

    function onPointerEnd(event) {
      if (sticker && sticker.hasPointerCapture && sticker.hasPointerCapture(event.pointerId)) {
        try {
          sticker.releasePointerCapture(event.pointerId);
        } catch (error) {
          console.warn("Could not release Live sticker pointer", error);
        }
      }
      pointers.delete(event.pointerId);
      if (pointers.size === 1) {
        const point = [...pointers.values()][0];
        dragStart = {
          x: point.x,
          y: point.y,
          translateX,
          translateY
        };
      } else {
        dragStart = null;
      }
    }

    function pointerDistance() {
      const points = [...pointers.values()];
      if (points.length < 2) return 1;
      const dx = points[0].x - points[1].x;
      const dy = points[0].y - points[1].y;
      return Math.hypot(dx, dy) || 1;
    }

    function createSelectionBox() {
      removeSelectionBox();

      selectionBox = document.createElement("div");
      selectionBox.className = "live-selection";

      const connector = document.createElement("div");
      connector.className = "live-selection-rotate-connector";

      rotateHandle = document.createElement("button");
      rotateHandle.className = "live-selection-handle live-selection-rotate";
      rotateHandle.type = "button";
      rotateHandle.setAttribute("aria-label", "Rotate live sticker");

      resizeHandle = document.createElement("button");
      resizeHandle.className = "live-selection-handle live-selection-resize";
      resizeHandle.type = "button";
      resizeHandle.setAttribute("aria-label", "Resize live sticker");

      selectionBox.append(connector, rotateHandle, resizeHandle);
      layer.append(selectionBox);
      bindSelectionGestures();
    }

    function removeSelectionBox() {
      unbindSelectionGestures();
      if (selectionBox) {
        selectionBox.remove();
        selectionBox = null;
      }
      resizeHandle = null;
      rotateHandle = null;
      isSelectionVisible = false;
    }

    function bindSelectionGestures() {
      if (resizeHandle) {
        resizeHandle.addEventListener("pointerdown", onResizePointerDown);
        resizeHandle.addEventListener("pointermove", onResizePointerMove);
        resizeHandle.addEventListener("pointerup", onResizePointerEnd);
        resizeHandle.addEventListener("pointercancel", onResizePointerEnd);
      }
      if (rotateHandle) {
        rotateHandle.addEventListener("pointerdown", onRotatePointerDown);
        rotateHandle.addEventListener("pointermove", onRotatePointerMove);
        rotateHandle.addEventListener("pointerup", onRotatePointerEnd);
        rotateHandle.addEventListener("pointercancel", onRotatePointerEnd);
      }
    }

    function unbindSelectionGestures() {
      if (resizeHandle) {
        resizeHandle.removeEventListener("pointerdown", onResizePointerDown);
        resizeHandle.removeEventListener("pointermove", onResizePointerMove);
        resizeHandle.removeEventListener("pointerup", onResizePointerEnd);
        resizeHandle.removeEventListener("pointercancel", onResizePointerEnd);
      }
      if (rotateHandle) {
        rotateHandle.removeEventListener("pointerdown", onRotatePointerDown);
        rotateHandle.removeEventListener("pointermove", onRotatePointerMove);
        rotateHandle.removeEventListener("pointerup", onRotatePointerEnd);
        rotateHandle.removeEventListener("pointercancel", onRotatePointerEnd);
      }
    }

    function onResizePointerDown(event) {
      event.preventDefault();
      event.stopPropagation();
      showSelectionBox();
      capturePointer(resizeHandle, event.pointerId, "resize");
      const center = getStickerCenter();
      resizeStart = {
        center,
        distance: distanceFromCenter(center, event),
        scale
      };
    }

    function onResizePointerMove(event) {
      if (!resizeStart) return;
      event.preventDefault();
      event.stopPropagation();
      scale = clamp(resizeStart.scale * (distanceFromCenter(resizeStart.center, event) / resizeStart.distance), 0.35, 3);
      clampStickerPosition();
      applyStickerTransform();
      updateSelectionBox();
    }

    function onResizePointerEnd(event) {
      event.preventDefault();
      event.stopPropagation();
      releasePointer(resizeHandle, event.pointerId, "resize");
      resizeStart = null;
    }

    function onRotatePointerDown(event) {
      event.preventDefault();
      event.stopPropagation();
      showSelectionBox();
      capturePointer(rotateHandle, event.pointerId, "rotate");
      const center = getStickerCenter();
      rotateStart = {
        center,
        lastAngle: angleFromCenter(center, event)
      };
    }

    function onRotatePointerMove(event) {
      if (!rotateStart) return;
      event.preventDefault();
      event.stopPropagation();
      const nextAngle = angleFromCenter(rotateStart.center, event);
      const delta = normalizeRadians(nextAngle - rotateStart.lastAngle);
      rotationDegrees += radiansToDegrees(delta);
      rotateStart.lastAngle = nextAngle;
      clampStickerPosition();
      applyStickerTransform();
      updateSelectionBox();
    }

    function onRotatePointerEnd(event) {
      event.preventDefault();
      event.stopPropagation();
      releasePointer(rotateHandle, event.pointerId, "rotate");
      rotateStart = null;
    }

    function capturePointer(element, pointerId, label) {
      if (!element || !element.setPointerCapture) return;
      try {
        element.setPointerCapture(pointerId);
      } catch (error) {
        console.warn(`Could not capture Live sticker ${label} pointer`, error);
      }
    }

    function releasePointer(element, pointerId, label) {
      if (!element || !element.hasPointerCapture || !element.hasPointerCapture(pointerId)) return;
      try {
        element.releasePointerCapture(pointerId);
      } catch (error) {
        console.warn(`Could not release Live sticker ${label} pointer`, error);
      }
    }

    function getStickerCenter() {
      return {
        x: window.innerWidth / 2 + translateX,
        y: window.innerHeight / 2 + translateY
      };
    }

    function distanceFromCenter(center, event) {
      return Math.max(1, Math.hypot(event.clientX - center.x, event.clientY - center.y));
    }

    function angleFromCenter(center, event) {
      return Math.atan2(event.clientY - center.y, event.clientX - center.x);
    }

    function normalizeRadians(value) {
      return Math.atan2(Math.sin(value), Math.cos(value));
    }

    function radiansToDegrees(value) {
      return value * 180 / Math.PI;
    }

    function applyStickerTransform() {
      if (!sticker) return;
      sticker.style.transform = `translate(calc(-50% + ${translateX}px), calc(-50% + ${translateY}px)) rotate(${rotationDegrees}deg) scale(${scale})`;
    }

    function updateSelectionBox() {
      if (!selectionBox || !sticker) return;
      const bounds = getStickerUnrotatedBounds();
      if (!bounds) return;
      selectionBox.style.width = `${bounds.width}px`;
      selectionBox.style.height = `${bounds.height}px`;
      selectionBox.style.transform = `translate(calc(-50% + ${translateX}px), calc(-50% + ${translateY}px)) rotate(${rotationDegrees}deg)`;
      selectionBox.classList.toggle("hidden", !isSelectionVisible);
    }

    function showSelectionBox() {
      isSelectionVisible = true;
      updateSelectionBox();
    }

    function hideSelectionBox() {
      isSelectionVisible = false;
      updateSelectionBox();
    }

    function configureStickerVideo(sourceVideo) {
      const source = sourceVideo.currentSrc || sourceVideo.src;
      stickerVideo.crossOrigin = sourceVideo.crossOrigin || "anonymous";
      stickerVideo.loop = sourceVideo.loop;
      stickerVideo.muted = sourceVideo.muted;
      stickerVideo.playsInline = sourceVideo.playsInline;
      stickerVideo.playbackRate = sourceVideo.playbackRate || 1;
      stickerVideo.autoplay = true;
      stickerVideo.toggleAttribute("loop", sourceVideo.loop);
      stickerVideo.toggleAttribute("muted", sourceVideo.muted);
      stickerVideo.toggleAttribute("playsinline", sourceVideo.playsInline);
      stickerVideo.toggleAttribute("webkit-playsinline", sourceVideo.hasAttribute("webkit-playsinline"));
      stickerVideo.src = source;
    }

    async function syncArTimeToSticker(sourceVideo) {
      if (!sourceVideo || !Number.isFinite(sourceVideo.currentTime)) return;
      try {
        await waitForVideoMetadata(stickerVideo);
        stickerVideo.currentTime = sourceVideo.currentTime;
        sourceVideo.pause();
      } catch (error) {
        console.warn("Could not sync AR video time to Live sticker", error);
      }
    }

    function waitForVideoMetadata(video) {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener("loadedmetadata", handleLoadedMetadata);
          video.removeEventListener("error", handleError);
        };
        const handleLoadedMetadata = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error("Live sticker metadata could not load."));
        };

        video.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
        video.addEventListener("error", handleError, { once: true });
      });
    }

    function syncStickerTimeToAr() {
      if (!stickerVideo || !liveTargetState || !liveTargetState.video || !Number.isFinite(stickerVideo.currentTime)) return;
      try {
        liveTargetState.video.currentTime = stickerVideo.currentTime;
      } catch (error) {
        console.warn("Could not sync Live sticker time back to AR video", error);
      }
    }

    function hideVisibleTargetOverlays() {
      visibleTargetStates.forEach((targetState) => hideTargetOverlay(targetState));
    }

    function hideTargetOverlay(targetState) {
      if (targetState && targetState.overlay && targetState.overlay.object3D) {
        targetState.overlay.object3D.visible = false;
      }
      if (targetState === liveTargetState && targetState.video) {
        targetState.video.pause();
      }
    }

    function restoreVisibleTargetOverlays() {
      visibleTargetStates.forEach((targetState) => {
        if (!targetState.overlay || !targetState.overlay.object3D) return;
        targetState.overlay.object3D.visible = true;
        if (targetState.videoConfig && targetState.videoConfig.autoplay) {
          targetState.video.play().catch((error) => {
            console.warn("AR video play was blocked after Live mode", error);
          });
        }
      });
    }

    function updateLiveButton() {
      const canEnterLive = isStarted && isTargetVisible && !!activeTargetState && mode === "attached";
      liveButton.disabled = !canEnterLive;
      liveButton.classList.toggle("hidden", !canEnterLive);
    }

    function shouldPlayTargetVideo(targetState) {
      return mode === "attached" || targetState !== liveTargetState;
    }

    function clampStickerPosition() {
      const bounds = getStickerBounds();
      if (!bounds) return;
      const minimumVisible = 48;
      const minCenterX = minimumVisible - bounds.width / 2;
      const maxCenterX = window.innerWidth - minimumVisible + bounds.width / 2;
      const minCenterY = minimumVisible - bounds.height / 2;
      const maxCenterY = window.innerHeight - minimumVisible + bounds.height / 2;
      const centerX = clamp(window.innerWidth / 2 + translateX, minCenterX, maxCenterX);
      const centerY = clamp(window.innerHeight / 2 + translateY, minCenterY, maxCenterY);
      translateX = centerX - window.innerWidth / 2;
      translateY = centerY - window.innerHeight / 2;
    }

    function getStickerBounds() {
      const bounds = getStickerUnrotatedBounds();
      if (!bounds) return null;
      const angle = rotationDegrees * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return {
        width: Math.abs(bounds.width * cos) + Math.abs(bounds.height * sin),
        height: Math.abs(bounds.width * sin) + Math.abs(bounds.height * cos)
      };
    }

    function getStickerUnrotatedBounds() {
      if (!sticker) return null;
      const width = sticker.offsetWidth || (stickerVideo && stickerVideo.videoWidth) || 0;
      let height = sticker.offsetHeight || 0;
      if (!height && stickerVideo && stickerVideo.videoWidth && stickerVideo.videoHeight && width) {
        height = width * (stickerVideo.videoHeight / stickerVideo.videoWidth);
      }
      return {
        width: width * scale,
        height: height * scale
      };
    }

    function handleViewportChange() {
      clampStickerPosition();
      applyStickerTransform();
      updateSelectionBox();
    }

    function addViewportListeners() {
      removeViewportListeners();
      window.addEventListener("resize", handleViewportChange);
      window.addEventListener("orientationchange", handleViewportChange);
      document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    }

    function removeViewportListeners() {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    }

    function handleDocumentPointerDown(event) {
      if (mode !== "live" || !sticker || !selectionBox) return;
      const target = event.target;
      if (sticker.contains(target) || selectionBox.contains(target) || exitButton.contains(target) || deleteButton.contains(target)) {
        return;
      }
      hideSelectionBox();
    }

    return {
      setStarted,
      setTargetVisible,
      setTargetVisibility,
      setActiveTarget,
      shouldPlayTargetVideo
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function fileNameFromPath(path) {
    return String(path || "").split("/").pop() || "overlay video";
  }
})();
