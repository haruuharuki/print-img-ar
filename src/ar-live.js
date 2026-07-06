(function () {
  window.ARLive = {
    init
  };

  function init({ statusBox }) {
    const liveButton = document.querySelector("#liveModeButton");
    const exitButton = document.querySelector("#liveExitButton");
    const addButton = document.querySelector("#liveAddButton");
    const deleteButton = document.querySelector("#liveDeleteButton");
    const layer = document.querySelector("#liveStickerLayer");

    if (!liveButton || !exitButton || !addButton || !deleteButton || !layer) {
      return null;
    }

    let activeTargetState = null;
    let liveTargetState = null;
    let isStarted = false;
    let mode = "attached";
    let isTargetVisible = false;
    let selectedSticker = null;
    let sticker = null;
    let stickerVideo = null;
    let stickerCanvas = null;
    let packedAlphaRenderer = null;
    let translateX = 0;
    let translateY = 0;
    let scale = 1;
    let rotationDegrees = 0;
    let isFlipped = false;
    let dragStart = null;
    let resizeStart = null;
    let rotateStart = null;
    let selectionBox = null;
    let resizeHandle = null;
    let rotateHandle = null;
    let duplicateHandle = null;
    let flipHandle = null;
    let isSelectionVisible = false;
    let duplicateSequence = 0;
    const visibleTargetStates = new Map();
    const liveStickers = new Map();
    const packedSources = new Map();
    const pointers = new Map();

    liveButton.addEventListener("click", enterLiveMode);
    exitButton.addEventListener("click", exitLiveMode);
    addButton.addEventListener("click", addAnotherTarget);
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
      if (mode === "live") {
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
      restoreTargetOverlay(targetState);
      updateLiveButton();
    }

    function setTargetVisibility(targetState, isVisible) {
      if (!targetState || !targetState.target) return;
      if (isVisible) {
        visibleTargetStates.set(targetState.target.id, targetState);
        if (mode === "attached") {
          restoreTargetOverlay(targetState);
        }
      } else {
        visibleTargetStates.delete(targetState.target.id);
      }
      isTargetVisible = visibleTargetStates.size > 0;
      if (mode === "live") {
        hideTargetOverlay(targetState);
      }
      updateLiveButton();
    }

    async function enterLiveMode() {
      if (!isStarted || mode !== "attached") return;

      const targetStates = visibleTargetStates.size
        ? [...visibleTargetStates.values()]
        : activeTargetState
          ? [activeTargetState]
          : [];
      if (!targetStates.length && !liveStickers.size) return;

      mode = "live";
      isSelectionVisible = true;
      layer.classList.remove("hidden");
      setStickerInteractivity(true);
      liveButton.classList.add("hidden");
      exitButton.classList.remove("hidden");
      addButton.classList.remove("hidden");
      deleteButton.classList.remove("hidden");
      hideVisibleTargetOverlays();

      try {
        let lastSticker = selectedSticker || [...liveStickers.values()][liveStickers.size - 1] || null;
        for (const targetState of targetStates) {
          lastSticker = await ensureSticker(targetState);
        }
        selectSticker(lastSticker);
        addViewportListeners();
        statusBox.textContent = `${liveStickers.size} Live sticker${liveStickers.size === 1 ? "" : "s"} ready.`;
      } catch (error) {
        console.warn("Live sticker play was blocked", error);
        statusBox.textContent = "Live sticker could not start. Returning to AR viewer.";
        exitLiveMode();
      }
    }

    function exitLiveMode() {
      if (mode === "attached") return;
      syncSelectedStickerTimeToAr();
      hideSelectionBox();
      removeViewportListeners();
      mode = "attached";
      layer.classList.toggle("hidden", liveStickers.size === 0);
      setStickerInteractivity(false);
      exitButton.classList.add("hidden");
      addButton.classList.add("hidden");
      deleteButton.classList.add("hidden");
      restoreVisibleTargetOverlays();
      updateLiveButton();
      statusBox.textContent = "Back to AR viewer.";
    }

    function addAnotherTarget() {
      if (mode !== "live") return;
      exitLiveMode();
      statusBox.textContent = "Scan another image, then tap Live to add it.";
    }

    function deleteSticker() {
      if (mode !== "live") return;
      const removedTargetId = selectedSticker && selectedSticker.targetState.target.id;
      removeSelectedSticker();
      if (liveStickers.size) {
        selectSticker([...liveStickers.values()][liveStickers.size - 1]);
        statusBox.textContent = "Live sticker removed.";
        return;
      }

      removeViewportListeners();
      mode = "attached";
      layer.classList.add("hidden");
      setStickerInteractivity(false);
      exitButton.classList.add("hidden");
      addButton.classList.add("hidden");
      deleteButton.classList.add("hidden");
      const removedTarget = removedTargetId && visibleTargetStates.get(removedTargetId);
      if (removedTarget) showTargetOverlay(removedTarget);
      restoreVisibleTargetOverlays();
      updateLiveButton();
      statusBox.textContent = "Live sticker removed. Back to AR viewer.";
    }

    async function ensureSticker(
      targetState,
      {
        allowDuplicate = false,
        sourceRecord = null,
        initialTransform = null
      } = {}
    ) {
      const existing = allowDuplicate
        ? null
        : findStickerForTarget(targetState.target.id);

      if (existing) {
        return existing;
      }

      const nextSticker = document.createElement("div");
      nextSticker.className = "live-sticker";
      nextSticker.style.touchAction = "none";
      nextSticker.style.userSelect = "none";
      nextSticker.style.webkitUserSelect = "none";

      let nextVideo = null;
      let nextCanvas = null;
      let nextRenderer = null;
      let sharedPackedSource = null;

      if (targetState.usesPackedAlpha) {
        sharedPackedSource = await acquirePackedSource(
          targetState,
          sourceRecord
        );
        nextVideo = sharedPackedSource.video;
        nextRenderer = sharedPackedSource.renderer;

        nextCanvas = document.createElement("canvas");
        nextCanvas.style.display = "block";
        nextCanvas.style.width = "100%";
        nextCanvas.style.height = "auto";
        nextCanvas.style.pointerEvents = "none";

        sharedPackedSource.addSubscriber(nextCanvas);
        nextSticker.append(nextCanvas);
      } else {
        nextVideo = document.createElement("video");
        configureStickerVideo(nextVideo, targetState.video);
        nextVideo.setAttribute("playsinline", "");
        nextVideo.setAttribute("webkit-playsinline", "");
        nextVideo.addEventListener("error", () => {
          statusBox.textContent = `This browser could not play ${fileNameFromPath(targetState.target.overlayPath)} as a Live sticker.`;
        });
        nextSticker.append(nextVideo);
      }

      layer.append(nextSticker);

      const stickerKey = allowDuplicate
        ? `${targetState.target.id}::copy::${++duplicateSequence}`
        : targetState.target.id;

      const record = {
        stickerKey,
        targetState,
        element: nextSticker,
        video: nextVideo,
        canvas: nextCanvas,
        renderer: nextRenderer,
        sharedPackedSource,
        translateX: initialTransform ? initialTransform.translateX : 0,
        translateY: initialTransform ? initialTransform.translateY : 0,
        scale: initialTransform ? initialTransform.scale : 1,
        rotationDegrees: initialTransform ? initialTransform.rotationDegrees : 0,
        isFlipped: initialTransform ? !!initialTransform.isFlipped : false
      };

      liveStickers.set(stickerKey, record);
      selectSticker(record);

      if (!targetState.usesPackedAlpha) {
        await syncArTimeToSticker(
          sourceRecord ? sourceRecord.video : targetState.video,
          nextVideo,
          !sourceRecord
        );
      }

      applyStickerTransform();
      bindStickerGestures(nextSticker);
      clampStickerPosition();
      hideTargetOverlay(targetState);

      if (!targetState.usesPackedAlpha) {
        await nextVideo.play();
      }

      return record;
    }

    function removeSelectedSticker() {
      if (!selectedSticker) return;
      syncSelectedStickerTimeToAr();
      unbindStickerGestures();
      removeSelectionBox();
      pointers.clear();
      dragStart = null;
      resizeStart = null;
      rotateStart = null;
      if (selectedSticker.sharedPackedSource) {
        selectedSticker.sharedPackedSource.removeSubscriber(
          selectedSticker.canvas
        );
        releasePackedSource(selectedSticker.targetState.target.id);
      } else if (selectedSticker.video) {
        selectedSticker.video.pause();
        selectedSticker.video.removeAttribute("src");
        selectedSticker.video.load();
      }

      if (selectedSticker.canvas) {
        selectedSticker.canvas.remove();
      }
      if (selectedSticker.element) {
        selectedSticker.element.remove();
      }
      liveStickers.delete(selectedSticker.stickerKey);
      clearSelectedStickerRefs();
    }

    async function acquirePackedSource(targetState, sourceRecord) {
      const targetId = targetState.target.id;
      const existing = packedSources.get(targetId);

      if (existing) {
        existing.refCount += 1;
        return existing;
      }

      const video = document.createElement("video");
      video.style.display = "none";
      configureStickerVideo(video, targetState.video);
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.addEventListener("error", () => {
        statusBox.textContent = `This browser could not play ${fileNameFromPath(targetState.target.overlayPath)} as a Live sticker.`;
      });

      const masterCanvas = document.createElement("canvas");
      const subscribers = new Set();

      const renderer = createPackedAlphaRenderer(
        video,
        masterCanvas,
        subscribers
      );

      const packedSource = {
        targetId,
        video,
        masterCanvas,
        renderer,
        subscribers,
        refCount: 1,
        addSubscriber(canvas) {
          subscribers.add(canvas);
          renderer.drawFrame();
        },
        removeSubscriber(canvas) {
          subscribers.delete(canvas);
        }
      };

      packedSources.set(targetId, packedSource);

      await syncArTimeToSticker(
        sourceRecord ? sourceRecord.video : targetState.video,
        video,
        !sourceRecord
      );

      await video.play();
      renderer.start();

      return packedSource;
    }

    function releasePackedSource(targetId) {
      const packedSource = packedSources.get(targetId);
      if (!packedSource) return;

      packedSource.refCount -= 1;
      if (packedSource.refCount > 0) return;

      packedSource.renderer.dispose();
      packedSource.video.pause();
      packedSource.video.removeAttribute("src");
      packedSource.video.load();
      packedSource.subscribers.clear();
      packedSources.delete(targetId);
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
      const targetSticker = findStickerByElement(event.currentTarget);
      if (targetSticker && targetSticker !== selectedSticker) {
        selectSticker(targetSticker);
      }
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
          angle: pointerAngle(),
          scale,
          rotationDegrees
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
        const nextAngle = pointerAngle();

        scale = clamp(
          dragStart.scale * (nextDistance / dragStart.distance),
          0.35,
          3
        );

        rotationDegrees =
          dragStart.rotationDegrees +
          normalizeAngleDegrees(nextAngle - dragStart.angle);
      }

      saveSelectedStickerTransform();
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

    function pointerAngle() {
      const points = [...pointers.values()];
      if (points.length < 2) return 0;
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      return Math.atan2(dy, dx) * (180 / Math.PI);
    }

    function normalizeAngleDegrees(value) {
      let normalized = value;
      while (normalized > 180) normalized -= 360;
      while (normalized < -180) normalized += 360;
      return normalized;
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

      duplicateHandle = document.createElement("button");
      duplicateHandle.className = "live-selection-handle live-selection-duplicate";
      duplicateHandle.type = "button";
      duplicateHandle.textContent = "\u29C9";
      duplicateHandle.setAttribute("aria-label", "Duplicate live sticker");
      duplicateHandle.setAttribute("title", "Duplicate");

      flipHandle = document.createElement("button");
      flipHandle.className = "live-selection-handle live-selection-flip";
      flipHandle.type = "button";
      flipHandle.textContent = "\u21C6";
      flipHandle.setAttribute("aria-label", "Flip live sticker horizontally");
      flipHandle.setAttribute("title", "Flip left and right");

      selectionBox.append(
        connector,
        rotateHandle,
        resizeHandle,
        duplicateHandle,
        flipHandle
      );
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
      duplicateHandle = null;
      flipHandle = null;
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
      if (duplicateHandle) {
        duplicateHandle.addEventListener("click", duplicateSelectedSticker);
      }
      if (flipHandle) {
        flipHandle.addEventListener("click", flipSelectedSticker);
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
      if (duplicateHandle) {
        duplicateHandle.removeEventListener("click", duplicateSelectedSticker);
      }
      if (flipHandle) {
        flipHandle.removeEventListener("click", flipSelectedSticker);
      }
    }

    function flipSelectedSticker(event) {
      event.preventDefault();
      event.stopPropagation();

      if (mode !== "live" || !selectedSticker) return;

      isFlipped = !isFlipped;
      applyStickerTransform();
      updateSelectionBox();
      statusBox.textContent = isFlipped
        ? "Live sticker flipped."
        : "Live sticker restored.";
    }

    async function duplicateSelectedSticker(event) {
      event.preventDefault();
      event.stopPropagation();

      if (mode !== "live" || !selectedSticker) return;

      saveSelectedStickerTransform();
      const sourceRecord = selectedSticker;

      try {
        const duplicate = await ensureSticker(sourceRecord.targetState, {
          allowDuplicate: true,
          sourceRecord,
          initialTransform: {
            translateX: sourceRecord.translateX + 28,
            translateY: sourceRecord.translateY + 28,
            scale: sourceRecord.scale,
            rotationDegrees: sourceRecord.rotationDegrees,
            isFlipped: sourceRecord.isFlipped
          }
        });

        selectSticker(duplicate);
        clampStickerPosition();
        applyStickerTransform();
        updateSelectionBox();
        statusBox.textContent = "Live sticker duplicated.";
      } catch (error) {
        console.warn("Could not duplicate Live sticker", error);
        statusBox.textContent = "Could not duplicate this Live sticker.";
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
      const horizontalScale = isFlipped ? -scale : scale;
      sticker.style.transform = `translate(calc(-50% + ${translateX}px), calc(-50% + ${translateY}px)) rotate(${rotationDegrees}deg) scale(${horizontalScale}, ${scale})`;
      saveSelectedStickerTransform();
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

    function selectSticker(record) {
      saveSelectedStickerTransform();
      selectedSticker = record || null;
      if (!selectedSticker) {
        clearSelectedStickerRefs();
        removeSelectionBox();
        return;
      }

      liveTargetState = selectedSticker.targetState;
      sticker = selectedSticker.element;
      stickerVideo = selectedSticker.video;
      stickerCanvas = selectedSticker.canvas;
      packedAlphaRenderer = selectedSticker.renderer;
      translateX = selectedSticker.translateX;
      translateY = selectedSticker.translateY;
      scale = selectedSticker.scale;
      rotationDegrees = selectedSticker.rotationDegrees;
      isFlipped = !!selectedSticker.isFlipped;
      createSelectionBox();
      isSelectionVisible = true;
      applyStickerTransform();
      clampStickerPosition();
      updateSelectionBox();
    }

    function saveSelectedStickerTransform() {
      if (!selectedSticker) return;
      selectedSticker.translateX = translateX;
      selectedSticker.translateY = translateY;
      selectedSticker.scale = scale;
      selectedSticker.rotationDegrees = rotationDegrees;
      selectedSticker.isFlipped = isFlipped;
    }

    function clearSelectedStickerRefs() {
      selectedSticker = null;
      liveTargetState = null;
      sticker = null;
      stickerVideo = null;
      stickerCanvas = null;
      packedAlphaRenderer = null;
      translateX = 0;
      translateY = 0;
      scale = 1;
      rotationDegrees = 0;
      isFlipped = false;
    }

    function findStickerByElement(element) {
      for (const record of liveStickers.values()) {
        if (record.element === element) return record;
      }
      return null;
    }

    function findStickerForTarget(targetId) {
      for (const record of liveStickers.values()) {
        if (
          record.targetState &&
          record.targetState.target &&
          record.targetState.target.id === targetId
        ) {
          return record;
        }
      }
      return null;
    }

    function hasStickerForTarget(targetId) {
      return Boolean(findStickerForTarget(targetId));
    }

    function setStickerInteractivity(isInteractive) {
      liveStickers.forEach((record) => {
        if (record.element) {
          record.element.style.pointerEvents = isInteractive ? "auto" : "none";
        }
      });
    }

    function configureStickerVideo(video, sourceVideo) {
      const source = sourceVideo.currentSrc || sourceVideo.src;
      video.crossOrigin = sourceVideo.crossOrigin || "anonymous";
      video.loop = sourceVideo.loop;
      video.muted = sourceVideo.muted;
      video.playsInline = sourceVideo.playsInline;
      video.playbackRate = sourceVideo.playbackRate || 1;
      video.autoplay = true;
      video.toggleAttribute("loop", sourceVideo.loop);
      video.toggleAttribute("muted", sourceVideo.muted);
      video.toggleAttribute("playsinline", sourceVideo.playsInline);
      video.toggleAttribute("webkit-playsinline", sourceVideo.hasAttribute("webkit-playsinline"));
      video.src = source;
    }

    async function syncArTimeToSticker(sourceVideo, video, pauseSource = true) {
      if (!sourceVideo || !Number.isFinite(sourceVideo.currentTime)) return;
      try {
        await waitForVideoMetadata(video);
        video.currentTime = sourceVideo.currentTime;
        if (pauseSource) {
          sourceVideo.pause();
        }
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

    function syncSelectedStickerTimeToAr() {
      if (!selectedSticker || !selectedSticker.video || !selectedSticker.targetState.video || !Number.isFinite(selectedSticker.video.currentTime)) return;
      try {
        selectedSticker.targetState.video.currentTime = selectedSticker.video.currentTime;
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
      if (
        targetState &&
        hasStickerForTarget(targetState.target.id) &&
        targetState.video
      ) {
        targetState.video.pause();
      }
    }

    function showTargetOverlay(targetState) {
      if (!targetState || !targetState.overlay || !targetState.overlay.object3D) return;
      targetState.overlay.object3D.visible = true;
      if (targetState.videoConfig && targetState.videoConfig.autoplay && shouldPlayTargetVideo(targetState)) {
        targetState.video.play().catch((error) => {
          console.warn("AR video play was blocked while restoring target overlay", error);
        });
      }
    }

    function restoreTargetOverlay(targetState) {
      if (
        targetState &&
        hasStickerForTarget(targetState.target.id)
      ) {
        hideTargetOverlay(targetState);
        return;
      }
      showTargetOverlay(targetState);
    }

    function restoreVisibleTargetOverlays() {
      visibleTargetStates.forEach((targetState) => {
        restoreTargetOverlay(targetState);
      });
    }

    function updateLiveButton() {
      const canEnterLive = isStarted && mode === "attached" && ((isTargetVisible && !!activeTargetState) || liveStickers.size > 0);
      liveButton.disabled = !canEnterLive;
      liveButton.classList.toggle("hidden", !canEnterLive);
    }

    function shouldPlayTargetVideo(targetState) {
      return (
        !targetState ||
        !targetState.target ||
        !hasStickerForTarget(targetState.target.id)
      );
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
      return selectedSticker ? getRecordUnrotatedBounds(selectedSticker) : null;
    }

    function getRecordUnrotatedBounds(record) {
      if (!record || !record.element) return null;
      const width = record.element.offsetWidth || (record.video && record.video.videoWidth) || 0;
      let height = record.element.offsetHeight || 0;
      if (!height && record.canvas && record.canvas.width && record.canvas.height && width) {
        height = width * (record.canvas.height / record.canvas.width);
      }
      if (!height && record.video && record.video.videoWidth && record.video.videoHeight && width) {
        const videoHeight = record.targetState.usesPackedAlpha
          ? record.video.videoHeight / 2
          : record.video.videoHeight;
        height = width * (videoHeight / record.video.videoWidth);
      }
      return {
        width: width * record.scale,
        height: height * record.scale
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
      if (
        sticker.contains(target) ||
        selectionBox.contains(target) ||
        exitButton.contains(target) ||
        addButton.contains(target) ||
        deleteButton.contains(target)
      ) {
        return;
      }
      hideSelectionBox();
    }

    function getCaptureState() {
      if (!liveStickers.size) {
        return { active: false };
      }

      saveSelectedStickerTransform();
      const stickers = [...liveStickers.values()]
        .map((record) => {
          const source = record.targetState.usesPackedAlpha ? record.canvas : record.video;
          const bounds = getRecordUnrotatedBounds(record);
          if (!source || !bounds || bounds.width <= 0 || bounds.height <= 0) {
            return null;
          }

          return {
            source,
            centerX: window.innerWidth / 2 + record.translateX,
            centerY: window.innerHeight / 2 + record.translateY,
            width: bounds.width,
            height: bounds.height,
            rotationDegrees: record.rotationDegrees,
            isFlipped: !!record.isFlipped
          };
        })
        .filter(Boolean);

      return {
        active: stickers.length > 0,
        includeArCanvas: mode === "attached",
        stickers
      };
    }

    return {
      setStarted,
      setTargetVisible,
      setTargetVisibility,
      setActiveTarget,
      shouldPlayTargetVideo,
      getCaptureState
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function createPackedAlphaRenderer(
    video,
    canvas,
    subscribers = new Set()
  ) {
    const context = canvas.getContext("2d", {
      willReadFrequently: true
    });
    const maskCanvas = document.createElement("canvas");
    const maskContext = maskCanvas.getContext("2d", {
      willReadFrequently: true
    });
    const isTouchDevice = window.matchMedia &&
      window.matchMedia("(pointer: coarse)").matches;
    const renderScale = isTouchDevice ? 0.7 : 1;
    const fallbackFrameDelay = 1000 / 30;
    let animationFrame = null;
    let videoFrameCallback = null;
    let fallbackTimer = null;
    let isRunning = false;

    function drawFrame() {
      const sourceWidth = video.videoWidth || video.clientWidth;
      const packedHeight = video.videoHeight || video.clientHeight;
      const sourceHeight = Math.floor(packedHeight / 2);
      if (!sourceWidth || !sourceHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }

      const renderWidth = Math.max(1, Math.round(sourceWidth * renderScale));
      const renderHeight = Math.max(1, Math.round(sourceHeight * renderScale));

      if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
        canvas.width = renderWidth;
        canvas.height = renderHeight;
        maskCanvas.width = renderWidth;
        maskCanvas.height = renderHeight;
      }

      context.clearRect(0, 0, renderWidth, renderHeight);
      maskContext.clearRect(0, 0, renderWidth, renderHeight);

      context.drawImage(
        video,
        0,
        0,
        sourceWidth,
        sourceHeight,
        0,
        0,
        renderWidth,
        renderHeight
      );

      maskContext.drawImage(
        video,
        0,
        sourceHeight,
        sourceWidth,
        sourceHeight,
        0,
        0,
        renderWidth,
        renderHeight
      );

      const color = context.getImageData(0, 0, renderWidth, renderHeight);
      const mask = maskContext.getImageData(0, 0, renderWidth, renderHeight);
      const colorPixels = color.data;
      const maskPixels = mask.data;

      for (let i = 0; i < colorPixels.length; i += 4) {
        colorPixels[i + 3] = Math.round(
          (0.299 * maskPixels[i]) +
            (0.587 * maskPixels[i + 1]) +
            (0.114 * maskPixels[i + 2])
        );
      }

      context.putImageData(color, 0, 0);

      for (const subscriber of subscribers) {
        if (
          subscriber.width !== renderWidth ||
          subscriber.height !== renderHeight
        ) {
          subscriber.width = renderWidth;
          subscriber.height = renderHeight;
        }

        const subscriberContext = subscriber.getContext("2d");
        subscriberContext.clearRect(
          0,
          0,
          renderWidth,
          renderHeight
        );
        subscriberContext.drawImage(
          canvas,
          0,
          0,
          renderWidth,
          renderHeight
        );
      }
    }

    function scheduleNextFrame() {
      if (!isRunning) return;

      if (typeof video.requestVideoFrameCallback === "function") {
        videoFrameCallback = video.requestVideoFrameCallback(renderLoop);
        return;
      }

      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = null;
        if (!isRunning) return;
        animationFrame = window.requestAnimationFrame(renderLoop);
      }, fallbackFrameDelay);
    }

    function renderLoop() {
      if (!isRunning) return;

      animationFrame = null;
      videoFrameCallback = null;
      drawFrame();
      scheduleNextFrame();
    }

    return {
      drawFrame,
      start() {
        if (isRunning) return;
        isRunning = true;
        renderLoop();
      },
      dispose() {
        isRunning = false;

        if (
          videoFrameCallback !== null &&
          typeof video.cancelVideoFrameCallback === "function"
        ) {
          video.cancelVideoFrameCallback(videoFrameCallback);
          videoFrameCallback = null;
        }

        if (animationFrame !== null) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }

        if (fallbackTimer !== null) {
          window.clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }

        canvas.width = 0;
        canvas.height = 0;
        maskCanvas.width = 0;
        maskCanvas.height = 0;
      }
    };
  }

  function fileNameFromPath(path) {
    return String(path || "").split("/").pop() || "overlay video";
  }
})();
