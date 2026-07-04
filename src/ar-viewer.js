(function () {
  const config = window.AR_VIEWER_CONFIG;
  const scene = document.querySelector("a-scene");
  const startButton = document.querySelector("#startButton");
  const cameraSwitchButton = document.querySelector("#cameraSwitchButton");
  const statusBox = document.querySelector("#status");
  const target = document.querySelector("#imageTarget");
  const video = document.querySelector("#arVideo");
  const overlay = target.querySelector("a-video");
  const capture =
    window.ARCapture &&
    window.ARCapture.init({
      scene,
      statusBox,
      overlayElement: overlay,
      overlayVideo: video
    });

  let hasStarted = false;
  let currentFacingMode = "environment";
  let isSwitchingCamera = false;
  const restoreGetUserMedia = installFacingModeOverride(() => currentFacingMode);

  scene.setAttribute("mindar-image", buildMindARAttribute(config));
  target.setAttribute("mindar-image-target", `targetIndex: ${config.target.index}`);

  video.src = config.video.src;
  video.loop = config.video.loop;
  video.muted = config.video.muted;
  video.playsInline = config.video.playsInline;
  video.toggleAttribute("loop", config.video.loop);
  video.toggleAttribute("muted", config.video.muted);
  video.toggleAttribute("playsinline", config.video.playsInline);
  video.toggleAttribute("webkit-playsinline", config.video.playsInline);

  overlay.setAttribute("width", config.overlay.width);
  overlay.setAttribute("height", config.overlay.height);
  overlay.setAttribute("position", config.overlay.position);
  overlay.setAttribute("rotation", config.overlay.rotation);

  statusBox.textContent = config.ui.initialText;
  startButton.textContent = config.ui.startButtonText;

  startButton.addEventListener("click", async () => {
    try {
      // iOS/Safari often requires a user gesture before media playback.
      await video.play();
      video.pause();
      video.currentTime = 0;

      const mindarSystem = scene.systems["mindar-image-system"];
      await mindarSystem.start();

      hasStarted = true;
      capture && capture.setStarted(true);
      cameraSwitchButton.classList.remove("hidden");
      cameraSwitchButton.disabled = false;
      startButton.classList.add("hidden");
      statusBox.textContent = config.ui.scanningText;
    } catch (error) {
      console.error(error);
      statusBox.textContent = config.ui.errorText;
    }
  });

  cameraSwitchButton.addEventListener("click", async () => {
    if (!hasStarted || isSwitchingCamera) return;

    const previousFacingMode = currentFacingMode;
    const nextFacingMode = currentFacingMode === "environment" ? "user" : "environment";

    isSwitchingCamera = true;
    cameraSwitchButton.disabled = true;
    capture && capture.setTargetVisible(false);
    target.object3D.visible = false;
    video.pause();
    statusBox.textContent = nextFacingMode === "environment" ? "กำลังสลับไปกล้องหลัง..." : "กำลังสลับไปกล้องหน้า...";

    try {
      await restartMindARWithFacingMode(nextFacingMode);
      currentFacingMode = nextFacingMode;
      statusBox.textContent = config.ui.scanningText;
    } catch (error) {
      console.error(error);
      statusBox.textContent = "สลับกล้องไม่ได้ กำลังกลับไปกล้องเดิม";
      currentFacingMode = previousFacingMode;

      try {
        await restartMindARWithFacingMode(previousFacingMode);
        statusBox.textContent = config.ui.scanningText;
      } catch (fallbackError) {
        console.error(fallbackError);
        statusBox.textContent = "กล้องเริ่มใหม่ไม่ได้ ลอง refresh หน้าเว็บ";
      }
    } finally {
      isSwitchingCamera = false;
      cameraSwitchButton.disabled = false;
    }
  });

  target.addEventListener("targetFound", async () => {
    statusBox.textContent = config.ui.foundText;
    if (!hasStarted) return;
    capture && capture.setTargetVisible(true);
    if (config.video.autoplay) {
      try {
        await video.play();
      } catch (error) {
        console.warn("Video play was blocked", error);
      }
    }
  });

  target.addEventListener("targetLost", () => {
    statusBox.textContent = config.ui.lostText;
    capture && capture.setTargetVisible(false);
    video.pause();
  });

  window.addEventListener("pagehide", restoreGetUserMedia);

  async function restartMindARWithFacingMode(facingMode) {
    const mindarSystem = scene.systems["mindar-image-system"];
    currentFacingMode = facingMode;

    try {
      mindarSystem.stop();
    } catch (error) {
      console.warn("MindAR stop failed during camera switch", error);
    }

    await mindarSystem.start();
  }

  function installFacingModeOverride(getFacingMode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return () => {};
    }

    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = (constraints) => {
      const nextConstraints = cloneConstraints(constraints);
      if (nextConstraints.video && typeof nextConstraints.video === "object") {
        nextConstraints.video.facingMode = getFacingMode();
      }
      return originalGetUserMedia(nextConstraints);
    };

    return () => {
      navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    };
  }

  function cloneConstraints(constraints) {
    if (!constraints || typeof constraints !== "object") {
      return constraints;
    }
    return {
      ...constraints,
      video:
        constraints.video && typeof constraints.video === "object"
          ? { ...constraints.video }
          : constraints.video
    };
  }

  function buildMindARAttribute(config) {
    const parts = [
      `imageTargetSrc: ${config.target.src}`,
      "autoStart: false",
      "uiScanning: yes",
      "uiLoading: yes",
      "uiError: yes"
    ];

    const smoothing = config.tracking && config.tracking.smoothing;
    if (smoothing && smoothing.enabled) {
      parts.push(`filterMinCF: ${smoothing.filterMinCF}`);
      parts.push(`filterBeta: ${smoothing.filterBeta}`);
      parts.push(`warmupTolerance: ${smoothing.warmupTolerance}`);
      parts.push(`missTolerance: ${smoothing.missTolerance}`);
    }

    return `${parts.join("; ")};`;
  }
})();
