(function () {
  registerPackedAlphaVideoComponent();

  const config = window.AR_VIEWER_CONFIG;
  const library = window.AR_LIBRARY;
  const scene = document.querySelector("a-scene");
  const assetsRoot = document.querySelector("#arAssets");
  const startButton = document.querySelector("#startButton");
  const cameraSwitchButton = document.querySelector("#cameraSwitchButton");
  const statusBox = document.querySelector("#status");
  const targets = getEnabledTargets(library);
  const targetStates = targets.map(createTargetState);
  const visibleTargetIds = new Set();
  let activeTargetState = targetStates[0] || null;
  let live = null;
  const capture =
    window.ARCapture &&
    window.ARCapture.init({
      scene,
      statusBox,
      overlayElement: activeTargetState && activeTargetState.overlay,
      overlayVideo: activeTargetState && activeTargetState.video,
      overlayUsesPackedAlpha: activeTargetState && activeTargetState.usesPackedAlpha,
      getLiveCaptureState: () => live && live.getCaptureState ? live.getCaptureState() : null
    });
  live =
    window.ARLive &&
    window.ARLive.init({
      statusBox
    });

  let hasStarted = false;
  let currentFacingMode = "environment";
  let isSwitchingCamera = false;
  const restoreGetUserMedia = installFacingModeOverride(() => currentFacingMode);

  if (!targets.length) {
    statusBox.textContent = config.ui.errorText;
    startButton.disabled = true;
    return;
  }

  scene.setAttribute("mindar-image", buildMindARAttribute(config, library));
  targetStates.forEach(({ entity }) => scene.append(entity));

  statusBox.textContent = config.ui.initialText;
  startButton.textContent = config.ui.startButtonText;

  startButton.addEventListener("click", async () => {
    logViewerDiagnostic("start-click");
    try {
      const mindarSystem = scene.systems["mindar-image-system"];
      logViewerDiagnostic("camera-start-begin");
      await mindarSystem.start();
      logViewerDiagnostic("camera-start-success");

      hasStarted = true;
      capture && capture.setStarted(true);
      live && live.setStarted(true);
      cameraSwitchButton.classList.remove("hidden");
      cameraSwitchButton.disabled = false;
      startButton.classList.add("hidden");
      statusBox.textContent = config.ui.scanningText;
      unlockVideos(targetStates).catch((error) => {
        logViewerDiagnostic("video-unlock-warning", {
          name: error && error.name,
          message: error && error.message
        });
      });
    } catch (error) {
      logViewerDiagnostic("start-error", {
        name: error && error.name,
        message: error && error.message
      });
      console.error(error);
      statusBox.textContent = `${config.ui.errorText}: ${error.name || "Error"} ${error.message || error}`;
    }
  });

  cameraSwitchButton.addEventListener("click", async () => {
    if (!hasStarted || isSwitchingCamera) return;

    const previousFacingMode = currentFacingMode;
    const nextFacingMode = currentFacingMode === "environment" ? "user" : "environment";

    isSwitchingCamera = true;
    cameraSwitchButton.disabled = true;
    visibleTargetIds.clear();
    setActiveTarget(null);
    targetStates.forEach(({ entity, video }) => {
      entity.object3D.visible = false;
      video.pause();
    });
    capture && capture.setTargetVisible(false);
    live && live.setTargetVisible(false);
    statusBox.textContent = nextFacingMode === "environment" ? "เธเธณเธฅเธฑเธเธชเธฅเธฑเธเนเธเธเธฅเนเธญเธเธซเธฅเธฑเธ..." : "เธเธณเธฅเธฑเธเธชเธฅเธฑเธเนเธเธเธฅเนเธญเธเธซเธเนเธฒ...";

    try {
      await restartMindARWithFacingMode(nextFacingMode);
      currentFacingMode = nextFacingMode;
      statusBox.textContent = config.ui.scanningText;
    } catch (error) {
      console.error(error);
      statusBox.textContent = "เธชเธฅเธฑเธเธเธฅเนเธญเธเนเธกเนเนเธ”เน เธเธณเธฅเธฑเธเธเธฅเธฑเธเนเธเธเธฅเนเธญเธเน€เธ”เธดเธก";
      currentFacingMode = previousFacingMode;

      try {
        await restartMindARWithFacingMode(previousFacingMode);
        statusBox.textContent = config.ui.scanningText;
      } catch (fallbackError) {
        console.error(fallbackError);
        statusBox.textContent = "เธเธฅเนเธญเธเน€เธฃเธดเนเธกเนเธซเธกเนเนเธกเนเนเธ”เน เธฅเธญเธ refresh เธซเธเนเธฒเน€เธงเนเธ";
      }
    } finally {
      isSwitchingCamera = false;
      cameraSwitchButton.disabled = false;
    }
  });

  targetStates.forEach((targetState) => {
    targetState.entity.addEventListener("targetFound", async () => {
      visibleTargetIds.add(targetState.target.id);
      setActiveTarget(targetState);
      live && live.setActiveTarget(targetState);
      live && live.setTargetVisibility(targetState, true);
      statusBox.textContent = config.ui.foundText;
      if (!hasStarted) return;
      capture && capture.setTargetVisible(true);
      if (targetState.videoConfig.autoplay && (!live || live.shouldPlayTargetVideo(targetState))) {
        try {
          logViewerDiagnostic("target-found-play-begin", {
            targetId: targetState.target.id,
            phase: targetState.videoPhase
          });
          await resetTargetVideoSequence(targetState);
          await playTargetVideo(targetState, "target-found");
          logViewerDiagnostic("target-found-play-success", {
            targetId: targetState.target.id,
            phase: targetState.videoPhase
          });
        } catch (error) {
          console.warn("Video play was blocked", error);
        }
      }
    });

    targetState.entity.addEventListener("targetLost", () => {
      visibleTargetIds.delete(targetState.target.id);
      targetState.video.pause();
      resetTargetVideoSequence(targetState);
      live && live.setTargetVisibility(targetState, false);
      statusBox.textContent = config.ui.lostText;

      if (!visibleTargetIds.size) {
        setActiveTarget(null);
        live && live.setActiveTarget(null);
        capture && capture.setTargetVisible(false);
        live && live.setTargetVisible(false);
        return;
      }

      const nextTargetState = targetStates.find((state) => visibleTargetIds.has(state.target.id));
      setActiveTarget(nextTargetState || null);
      live && live.setActiveTarget(nextTargetState || null);
      capture && capture.setTargetVisible(!!nextTargetState);
    });
  });

  window.addEventListener("pagehide", restoreGetUserMedia);

  function registerPackedAlphaVideoComponent() {
    if (!window.AFRAME || !window.THREE) {
      throw new Error("A-Frame and Three.js are required for packed alpha video.");
    }

    if (AFRAME.components["packed-alpha-video"]) {
      return;
    }

    AFRAME.registerComponent("packed-alpha-video", {
      schema: {
        video: { type: "selector" }
      },

      init() {
        this.videoTexture = null;
        this.shaderMaterial = null;
        this.applyMaterial = this.applyMaterial.bind(this);

        this.el.addEventListener("object3dset", this.applyMaterial);
        this.applyMaterial();
      },

      applyMaterial() {
        const video = this.data.video;
        const mesh = this.el.getObject3D("mesh");

        if (!video || !mesh || this.shaderMaterial) {
          return;
        }

        this.videoTexture = new THREE.VideoTexture(video);
        this.videoTexture.minFilter = THREE.LinearFilter;
        this.videoTexture.magFilter = THREE.LinearFilter;
        this.videoTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.videoTexture.wrapT = THREE.ClampToEdgeWrapping;
        this.videoTexture.generateMipmaps = false;
        this.videoTexture.flipY = false;

        this.shaderMaterial = new THREE.ShaderMaterial({
          uniforms: {
            packedMap: { value: this.videoTexture }
          },
          vertexShader: [
            "varying vec2 vUv;",
            "void main() {",
            "  vUv = vec2(uv.x, 1.0 - uv.y);",
            "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
            "}"
          ].join("\n"),
          fragmentShader: [
            "precision mediump float;",
            "uniform sampler2D packedMap;",
            "varying vec2 vUv;",
            "void main() {",
            "  vec2 colorUV = vec2(vUv.x, vUv.y * 0.5);",
            "  vec2 alphaUV = vec2(vUv.x, 0.5 + (vUv.y * 0.5));",
            "  vec4 colorSample = texture2D(packedMap, colorUV);",
            "  vec4 alphaSample = texture2D(packedMap, alphaUV);",
            "  gl_FragColor = vec4(colorSample.rgb, alphaSample.r);",
            "}"
          ].join("\n"),
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide
        });

        mesh.material = this.shaderMaterial;
      },

      remove() {
        this.el.removeEventListener("object3dset", this.applyMaterial);

        if (this.shaderMaterial) {
          this.shaderMaterial.dispose();
        }

        if (this.videoTexture) {
          this.videoTexture.dispose();
        }

        this.shaderMaterial = null;
        this.videoTexture = null;
      }
    });
  }

  function createTargetState(target) {
    const safeId = safeDomId(target.id);
    const videoId = `arVideo-${safeId}`;
    const video = document.createElement("video");
    const usesPackedAlpha =
      Boolean(target.overlayPackedPath) &&
      ["auto-alpha", "packed-alpha"].includes(target.overlayMode);
    const videoSources = getTargetVideoSources(target, usesPackedAlpha);
    const hasVideoSequence = Boolean(videoSources.loop);
    const activeOverlayPath = videoSources.intro;
    const videoConfig = {
      autoplay: target.video && target.video.autoplay !== undefined ? target.video.autoplay : true,
      loop: target.video && target.video.loop !== undefined ? target.video.loop : true,
      muted: target.video && target.video.muted !== undefined ? target.video.muted : true,
      playsInline: target.video && target.video.playsInline !== undefined ? target.video.playsInline : true
    };

    video.id = videoId;
    configureTargetVideoElement(video, videoConfig, hasVideoSequence ? false : videoConfig.loop);
    video.addEventListener("error", () => {
      logViewerDiagnostic("target-video-error", getTargetVideoDiagnostic(targetState));
      statusBox.textContent = `This browser could not play ${fileNameFromPath(video.currentSrc || video.src || activeOverlayPath)}. Try a browser that supports this overlay format.`;
    });

    const entity = document.createElement("a-entity");
    entity.id = `imageTarget-${safeId}`;
    entity.setAttribute("mindar-image-target", `targetIndex: ${target.targetIndex}`);

    const overlay = document.createElement(usesPackedAlpha ? "a-plane" : "a-video");
    overlay.setAttribute("width", target.overlay.width);
    overlay.setAttribute("height", target.overlay.height);
    overlay.setAttribute("position", target.overlay.position);
    overlay.setAttribute("rotation", target.overlay.rotation);

    if (usesPackedAlpha) {
      overlay.setAttribute("packed-alpha-video", `video: #${videoId}`);
    } else {
      overlay.setAttribute("src", `#${videoId}`);
      overlay.setAttribute("material", videoMaterialForTarget(target));
    }

    entity.append(overlay);

    const targetState = {
      target,
      video,
      videoConfig,
      videoSources,
      hasVideoSequence,
      videoPhase: hasVideoSequence ? "intro" : "single",
      entity,
      overlay,
      usesPackedAlpha,
      videoSourceToken: 0,
      videoReadyPromise: null
    };
    assetsRoot.append(video);
    video.src = activeOverlayPath;
    video.load();
    waitForTargetVideoReady(targetState, activeOverlayPath);
    video.addEventListener("ended", () => handleTargetVideoEnded(targetState));
    return targetState;
  }

  function setActiveTarget(targetState) {
    activeTargetState = targetState;
    if (capture && capture.setActiveOverlay && targetState) {
      capture.setActiveOverlay({
        overlayElement: targetState.overlay,
        overlayVideo: targetState.video,
        overlayUsesPackedAlpha: targetState.usesPackedAlpha
      });
    }
  }

  async function unlockVideos(states) {
    logViewerDiagnostic("video-unlock-begin");
    try {
      for (const state of states) {
        const sources = state.hasVideoSequence
          ? [state.videoSources.intro, state.videoSources.loop]
          : [state.videoSources.intro];
        for (const source of sources.filter(Boolean)) {
          try {
            await unlockVideoSource(source);
          } catch (error) {
            logViewerDiagnostic("detached-unlock-warning", {
              src: source,
              name: error && error.name,
              message: error && error.message
            });
          }
        }
        resetTargetVideoSequence(state);
      }
    } catch (error) {
      logViewerDiagnostic("video-unlock-warning", {
        name: error && error.name,
        message: error && error.message
      });
    }
    logViewerDiagnostic("video-unlock-complete");
  }

  async function unlockVideoSource(source) {
    if (!source) return;
    logViewerDiagnostic("detached-unlock-begin", { src: source });
    const video = document.createElement("video");
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.src = source;

    try {
      video.load();
      await video.play();
      video.pause();
    } finally {
      video.pause();
      video.removeAttribute("src");
      try {
        video.load();
      } catch (_error) {
        // Some WebKit builds throw when loading after src cleanup.
      }
      video.remove();
      logViewerDiagnostic("detached-unlock-complete", { src: source });
    }
  }

  function getTargetVideoSources(target, usesPackedAlpha) {
    return {
      intro: versionedRemoteMediaUrl(
        usesPackedAlpha ? target.overlayPackedPath : target.overlayPath,
        target
      ),
      loop: versionedRemoteMediaUrl(
        usesPackedAlpha
          ? target.overlayLoopPackedPath || null
          : target.overlayLoopPath || null,
        target
      )
    };
  }

  function videoMaterialForTarget(target) {
    return target.overlayMode === "opaque" || target.overlayBackgroundMode === "opaque"
      ? "shader: flat; transparent: false"
      : "transparent: true; alphaTest: 0.01";
  }

  function configureTargetVideoElement(video, videoConfig, shouldLoop) {
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = videoConfig.muted;
    video.defaultMuted = videoConfig.muted;
    video.playsInline = videoConfig.playsInline;
    video.loop = shouldLoop;
    video.toggleAttribute("playsinline", videoConfig.playsInline);
    video.toggleAttribute("webkit-playsinline", videoConfig.playsInline);
    video.toggleAttribute("muted", videoConfig.muted);
    video.toggleAttribute("loop", shouldLoop);
  }

  function resetTargetVideoSequence(targetState) {
    if (!targetState || !targetState.video) return;
    if (!targetState.hasVideoSequence) {
      targetState.videoPhase = "single";
      return;
    }
    return setTargetVideoPhase(targetState, "intro", 0);
  }

  async function handleTargetVideoEnded(targetState) {
    if (!targetState || !targetState.hasVideoSequence || targetState.videoPhase !== "intro") return;
    const isReady = await setTargetVideoPhase(targetState, "loop", 0);
    if (isReady) {
      await playTargetVideo(targetState, "loop");
    }
  }

  async function setTargetVideoPhase(targetState, phase, currentTime) {
    const source = phase === "loop" ? targetState.videoSources.loop : targetState.videoSources.intro;
    if (!source) return false;
    const video = targetState.video;
    targetState.videoPhase = phase;
    video.loop = phase === "loop" ? true : targetState.hasVideoSequence ? false : targetState.videoConfig.loop;
    video.toggleAttribute("loop", video.loop);
    if (!isSameVideoSource(video, source)) {
      video.pause();
      video.crossOrigin = "anonymous";
      video.src = source;
      video.load();
      targetState.videoReadyPromise = waitForTargetVideoReady(targetState, source);
    }
    const isReady = await targetState.videoReadyPromise;
    if (!isReady || !isSameVideoSource(video, source)) return false;
    if (Number.isFinite(currentTime)) {
      try {
        video.currentTime = currentTime;
      } catch (error) {
        console.warn("Could not set AR video time", error);
      }
    }
    return true;
  }

  function waitForTargetVideoReady(targetState, source) {
    const video = targetState.video;
    const token = (targetState.videoSourceToken || 0) + 1;
    targetState.videoSourceToken = token;

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && hasVideoDimensions(video)) {
      logViewerDiagnostic("target-video-ready", getTargetVideoDiagnostic(targetState));
      return Promise.resolve(true);
    }

    const readyPromise = new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("canplay", onCanPlay);
        video.removeEventListener("error", onError);
      };
      const isStale = () => targetState.videoSourceToken !== token || !isSameVideoSource(video, source);
      const maybeResolve = (eventName) => {
        if (isStale()) {
          cleanup();
          resolve(false);
          return;
        }
        logViewerDiagnostic(eventName, getTargetVideoDiagnostic(targetState));
        if (hasVideoDimensions(video)) {
          cleanup();
          resolve(true);
        }
      };
      const onLoadedMetadata = () => maybeResolve("target-video-loadedmetadata");
      const onCanPlay = () => maybeResolve("target-video-canplay");
      const onError = () => {
        if (isStale()) {
          cleanup();
          resolve(false);
          return;
        }
        cleanup();
        reject(new Error("Target video failed to load"));
      };

      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("canplay", onCanPlay);
      video.addEventListener("error", onError);
    }).catch((error) => {
      logViewerDiagnostic("target-video-ready-error", {
        ...getTargetVideoDiagnostic(targetState),
        name: error && error.name,
        message: error && error.message
      });
      return false;
    });

    targetState.videoReadyPromise = readyPromise;
    return readyPromise;
  }

  function hasVideoDimensions(video) {
    return video.videoWidth > 0 && video.videoHeight > 0;
  }

  async function playTargetVideo(targetState, reason) {
    try {
      await targetState.videoReadyPromise;
      await targetState.video.play();
    } catch (error) {
      logViewerDiagnostic("target-video-play-warning", {
        ...getTargetVideoDiagnostic(targetState),
        reason,
        name: error && error.name,
        message: error && error.message
      });
      console.warn("Video play was blocked", error);
    }
  }

  function getTargetVideoDiagnostic(targetState) {
    const video = targetState && targetState.video;
    const mediaError = video && video.error;
    return {
      "target.id": targetState && targetState.target && targetState.target.id,
      targetId: targetState && targetState.target && targetState.target.id,
      currentSrc: video ? video.currentSrc || video.src || "" : "",
      readyState: video ? video.readyState : undefined,
      networkState: video ? video.networkState : undefined,
      videoWidth: video ? video.videoWidth : undefined,
      videoHeight: video ? video.videoHeight : undefined,
      "MediaError.code": mediaError ? mediaError.code : undefined,
      "MediaError.message": mediaError ? mediaError.message : undefined,
      mediaErrorCode: mediaError ? mediaError.code : undefined,
      mediaErrorMessage: mediaError ? mediaError.message : undefined
    };
  }

  function isSameVideoSource(video, source) {
    const currentSource = video.currentSrc || video.src || "";
    if (!currentSource || !source) return false;
    try {
      return new URL(currentSource, window.location.href).href === new URL(source, window.location.href).href;
    } catch (_error) {
      return currentSource === source;
    }
  }

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

  function logViewerDiagnostic(event, details = {}) {
    console.info(`[ar-viewer] ${event}`, details);
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

  function buildMindARAttribute(config, library) {
    const parts = [
      `imageTargetSrc: ${versionedAssetUrl(library.targetFile)}`,
      "autoStart: false",
      `maxTrack: ${targets.length}`,
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

  function versionedAssetUrl(url) {
    const deployVersion = window.AR_DEPLOY_VERSION;
    if (!deployVersion || !url || /[?&]v=/.test(url)) {
      return url;
    }

    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${encodeURIComponent(deployVersion)}`;
  }

  function versionedRemoteMediaUrl(url, target) {
    if (!isRemoteUrl(url)) return url;

    const version = window.AR_DEPLOY_VERSION || (target && target.updatedAt);
    if (!version) return url;

    try {
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.set("v", version);
      return parsedUrl.href;
    } catch (_error) {
      return url;
    }
  }

  function isRemoteUrl(url) {
    return /^https?:\/\//i.test(String(url || ""));
  }

  function getEnabledTargets(library) {
    if (!library || !Array.isArray(library.targets)) return [];
    return library.targets
      .filter((target) => target.enabled)
      .slice(0, library.maxActiveTargets || 15)
      .sort((a, b) => Number(a.targetIndex) - Number(b.targetIndex));
  }

  function safeDomId(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  function fileNameFromPath(path) {
    return String(path || "").split("/").pop() || "overlay video";
  }
})();
