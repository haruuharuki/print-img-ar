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
    try {
      await unlockVideos(targetStates);

      const mindarSystem = scene.systems["mindar-image-system"];
      await mindarSystem.start();

      hasStarted = true;
      capture && capture.setStarted(true);
      live && live.setStarted(true);
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
          await targetState.video.play();
        } catch (error) {
          console.warn("Video play was blocked", error);
        }
      }
    });

    targetState.entity.addEventListener("targetLost", () => {
      visibleTargetIds.delete(targetState.target.id);
      targetState.video.pause();
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
    const activeOverlayPath = usesPackedAlpha
      ? target.overlayPackedPath
      : target.overlayPath;
    const videoConfig = {
      autoplay: target.video && target.video.autoplay !== undefined ? target.video.autoplay : true,
      loop: target.video && target.video.loop !== undefined ? target.video.loop : true,
      muted: target.video && target.video.muted !== undefined ? target.video.muted : true,
      playsInline: target.video && target.video.playsInline !== undefined ? target.video.playsInline : true
    };

    video.id = videoId;
    video.preload = "auto";
    video.src = activeOverlayPath;
    video.loop = videoConfig.loop;
    video.muted = videoConfig.muted;
    video.playsInline = videoConfig.playsInline;
    video.crossOrigin = "anonymous";
    video.toggleAttribute("loop", videoConfig.loop);
    video.toggleAttribute("muted", videoConfig.muted);
    video.toggleAttribute("playsinline", videoConfig.playsInline);
    video.toggleAttribute("webkit-playsinline", videoConfig.playsInline);
    video.addEventListener("error", () => {
      statusBox.textContent = `This browser could not play ${fileNameFromPath(activeOverlayPath)}. Try a browser that supports this overlay format.`;
    });
    assetsRoot.append(video);

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
      overlay.setAttribute("material", "transparent: true; alphaTest: 0.01");
    }

    entity.append(overlay);

    return {
      target,
      video,
      videoConfig,
      entity,
      overlay,
      usesPackedAlpha
    };
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
    for (const { video } of states) {
      await video.play();
      video.pause();
      video.currentTime = 0;
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
      `imageTargetSrc: ${library.targetFile}`,
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

  function getEnabledTargets(library) {
    if (!library || !Array.isArray(library.targets)) return [];
    return library.targets
      .filter((target) => target.enabled)
      .slice(0, library.maxActiveTargets || 10)
      .sort((a, b) => Number(a.targetIndex) - Number(b.targetIndex));
  }

  function safeDomId(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  function fileNameFromPath(path) {
    return String(path || "").split("/").pop() || "overlay video";
  }
})();
