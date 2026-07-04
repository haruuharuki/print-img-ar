(function () {
  const MAX_CAPTURE_EDGE = 1920;
  const VIDEO_MAX_EDGE = 1280;
  const RECORDING_FPS = 24;
  const MAX_RECORDING_MS = 15000;

  const VIDEO_MIME_CANDIDATES = [
    "video/mp4;codecs=h264",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];

  window.ARCapture = {
    init
  };

  function init({ scene, statusBox, overlayElement, overlayVideo }) {
    const captureButton = document.querySelector("#captureButton");
    const modeSwitch = document.querySelector("#cameraModeSwitch");
    const photoModeButton = document.querySelector("#photoModeButton");
    const videoModeButton = document.querySelector("#videoModeButton");
    const timer = document.querySelector("#recordingTimer");
    const preview = document.querySelector("#capturePreview");
    const previewImage = document.querySelector("#captureImage");
    const previewVideo = document.querySelector("#captureVideo");
    const previewHelp = document.querySelector("#captureHelp");
    const retakeButton = document.querySelector("#retakeCaptureButton");
    const shareButton = document.querySelector("#shareCaptureButton");
    const downloadButton = document.querySelector("#downloadCaptureButton");
    const closeButton = document.querySelector("#closeCaptureButton");

    let mode = "photo";
    let hasStarted = false;
    let hasVisibleTarget = false;
    let isPreviewOpen = false;
    let previewBlob = null;
    let previewUrl = null;
    let previewName = "";
    let previewMimeType = "image/png";
    let recorderState = null;

    captureButton.addEventListener("click", async () => {
      if (isPreviewOpen) return;
      if (!hasVisibleTarget) {
        statusBox.textContent = "ยังไม่เจอ AR overlay สำหรับถ่ายภาพ";
        updateControls();
        return;
      }

      if (mode === "video") {
        if (recorderState) {
          await stopVideoRecording();
        } else {
          await startVideoRecording();
        }
        return;
      }

      captureButton.disabled = true;
      try {
        const blob = await capturePhoto({ scene, overlayElement, overlayVideo });
        showPreview({ blob, mimeType: "image/png", fileName: mediaFileName("photo", "png") });
        statusBox.textContent = "ถ่ายภาพแล้ว เลือก Share หรือ Download ได้เลย";
      } catch (error) {
        console.error(error);
        statusBox.textContent = friendlyCaptureError(error, "photo");
      } finally {
        updateControls();
      }
    });

    photoModeButton.addEventListener("click", () => setMode("photo"));
    videoModeButton.addEventListener("click", () => setMode("video"));

    shareButton.addEventListener("click", async () => {
      if (!previewBlob) return;
      const file = new File([previewBlob], previewName, { type: previewMimeType });

      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({
            files: [file],
            title: previewMimeType.startsWith("video/") ? "AR video" : "AR photo"
          });
          setPreviewHelp("แชร์แล้ว ถ้าต้องการเก็บในเครื่องให้เลือก Save จาก Share Sheet");
          return;
        } catch (error) {
          if (error.name === "AbortError") return;
          console.warn("Share failed, falling back to download", error);
          setPreviewHelp("Share ไม่สำเร็จ เลยดาวน์โหลดไฟล์ให้แทน");
        }
      } else {
        setPreviewHelp("เครื่องนี้ยังแชร์ไฟล์ตรง ๆ ไม่ได้ เลยดาวน์โหลดไฟล์ให้แทน");
      }

      downloadBlob(previewBlob, previewName);
    });

    downloadButton.addEventListener("click", () => {
      if (previewBlob) downloadBlob(previewBlob, previewName);
    });

    retakeButton.addEventListener("click", hidePreview);
    closeButton.addEventListener("click", hidePreview);

    function setStarted(value) {
      hasStarted = value;
      captureButton.classList.toggle("hidden", !hasStarted);
      modeSwitch.classList.toggle("hidden", !hasStarted);
      updateControls();
    }

    function setTargetVisible(value) {
      hasVisibleTarget = value;
      if (!value && recorderState) {
        stopVideoRecording({ reason: "targetLost" });
      }
      updateControls();
    }

    function setMode(nextMode) {
      if (recorderState || isPreviewOpen || mode === nextMode) return;
      mode = nextMode;
      photoModeButton.classList.toggle("is-active", mode === "photo");
      videoModeButton.classList.toggle("is-active", mode === "video");
      statusBox.textContent = mode === "photo" ? "โหมด Photo พร้อมถ่าย" : "โหมด Video จำกัด 15 วินาที";
      updateControls();
    }

    async function startVideoRecording() {
      const mimeType = chooseVideoMimeType();
      if (!mimeType) {
        statusBox.textContent = "อัดวิดีโอไม่ได้: browser นี้ยังไม่รองรับ MediaRecorder video";
        return;
      }

      captureButton.disabled = true;
      try {
        const compositor = createCompositor({ scene, overlayElement, overlayVideo, maxEdge: VIDEO_MAX_EDGE });
        compositor.drawFrame();

        const stream = compositor.canvas.captureStream(RECORDING_FPS);
        const recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 2500000
        });
        const chunks = [];

        recorderState = {
          recorder,
          compositor,
          chunks,
          mimeType,
          startedAt: Date.now(),
          animationFrame: null,
          timerInterval: null,
          stopTimeout: null
        };

        recorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        });
        recorder.addEventListener("stop", () => finishVideoRecording());
        recorder.start(250);

        runRecordingLoop();
        recorderState.timerInterval = window.setInterval(updateTimer, 250);
        recorderState.stopTimeout = window.setTimeout(() => stopVideoRecording({ reason: "limit" }), MAX_RECORDING_MS);
        updateTimer();
        timer.classList.remove("hidden");
        captureButton.classList.add("is-recording");
        statusBox.textContent = "กำลังอัดวิดีโอ...";
      } catch (error) {
        console.error(error);
        cleanupRecorderState();
        statusBox.textContent = friendlyCaptureError(error, "video");
      } finally {
        updateControls();
      }
    }

    async function stopVideoRecording({ reason } = {}) {
      if (!recorderState) return;
      if (reason === "targetLost") {
        statusBox.textContent = "target หลุด หยุดอัดวิดีโอแล้ว";
      }
      if (recorderState.recorder.state !== "inactive") {
        recorderState.recorder.stop();
      }
    }

    function finishVideoRecording() {
      if (!recorderState) return;
      const { chunks, mimeType } = recorderState;
      cleanupRecorderState();

      if (!chunks.length) {
        statusBox.textContent = "อัดวิดีโอไม่ได้: ไม่มีข้อมูลวิดีโอ";
        updateControls();
        return;
      }

      const extension = mimeType.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunks, { type: mimeType });
      showPreview({
        blob,
        mimeType,
        fileName: mediaFileName("video", extension)
      });
      statusBox.textContent = "อัดวิดีโอแล้ว เลือก Share หรือ Download ได้เลย";
      updateControls();
    }

    function runRecordingLoop() {
      if (!recorderState) return;
      recorderState.compositor.drawFrame();
      recorderState.animationFrame = window.requestAnimationFrame(runRecordingLoop);
    }

    function cleanupRecorderState() {
      if (!recorderState) return;
      window.cancelAnimationFrame(recorderState.animationFrame);
      window.clearInterval(recorderState.timerInterval);
      window.clearTimeout(recorderState.stopTimeout);
      recorderState.compositor.dispose();
      recorderState = null;
      timer.classList.add("hidden");
      timer.textContent = "00:00";
      captureButton.classList.remove("is-recording");
    }

    function updateTimer() {
      if (!recorderState) return;
      const elapsedSeconds = Math.min(MAX_RECORDING_MS / 1000, Math.floor((Date.now() - recorderState.startedAt) / 1000));
      timer.textContent = formatDuration(elapsedSeconds);
    }

    function updateControls() {
      captureButton.disabled = isPreviewOpen || !hasStarted || !hasVisibleTarget || false;
      photoModeButton.disabled = !!recorderState || isPreviewOpen;
      videoModeButton.disabled = !!recorderState || isPreviewOpen;
    }

    function showPreview({ blob, mimeType, fileName }) {
      revokePreviewUrl();
      previewBlob = blob;
      previewMimeType = mimeType;
      previewName = fileName;
      previewUrl = URL.createObjectURL(blob);
      isPreviewOpen = true;

      if (mimeType.startsWith("video/")) {
        previewImage.classList.add("hidden");
        previewImage.removeAttribute("src");
        previewVideo.src = previewUrl;
        previewVideo.classList.remove("hidden");
      } else {
        previewVideo.classList.add("hidden");
        previewVideo.removeAttribute("src");
        previewImage.src = previewUrl;
        previewImage.classList.remove("hidden");
      }

      preview.classList.remove("hidden");
      setPreviewHelp(defaultPreviewHelp(blob, mimeType, fileName));
      updateControls();
    }

    function hidePreview() {
      preview.classList.add("hidden");
      previewImage.removeAttribute("src");
      previewVideo.pause();
      previewVideo.removeAttribute("src");
      previewBlob = null;
      previewMimeType = "image/png";
      previewName = "";
      isPreviewOpen = false;
      revokePreviewUrl();
      updateControls();
    }

    function revokePreviewUrl() {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = null;
      }
    }

    return {
      setStarted,
      setTargetVisible
    };

    function setPreviewHelp(message) {
      previewHelp.textContent = message;
    }

    function defaultPreviewHelp(blob, mimeType, fileName) {
      const file = new File([blob], fileName, { type: mimeType });
      const canShareFiles = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
      if (canShareFiles) {
        return mimeType.startsWith("video/")
          ? "บนมือถือ กด Share แล้วเลือก Save Video ได้ หรือส่งต่อไปยังแอปอื่น"
          : "บนมือถือ กด Share แล้วเลือก Save Image ได้ หรือส่งต่อไปยังแอปอื่น";
      }
      return mimeType.startsWith("video/") ? "กด Download เพื่อบันทึกวิดีโอ" : "กด Download เพื่อบันทึกภาพ PNG";
    }
  }

  async function capturePhoto({ scene, overlayElement, overlayVideo }) {
    const compositor = createCompositor({ scene, overlayElement, overlayVideo, maxEdge: MAX_CAPTURE_EDGE });
    try {
      compositor.drawFrame();
      const blob = await canvasToBlob(compositor.canvas, "image/png");
      if (!blob) throw new Error("browser ไม่สามารถสร้าง PNG ได้");
      return blob;
    } finally {
      compositor.dispose();
    }
  }

  function createCompositor({ scene, overlayElement, overlayVideo, maxEdge }) {
    const mindarSystem = scene.systems["mindar-image-system"];
    const cameraVideo = mindarSystem && mindarSystem.video;
    const arCanvas = scene.renderer && scene.renderer.domElement;

    if (!cameraVideo || cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      throw new Error("camera ยังไม่พร้อม");
    }
    if (!arCanvas) {
      throw new Error("AR canvas ยังไม่พร้อม");
    }

    const container = scene.parentElement || scene;
    const containerRect = container.getBoundingClientRect();
    if (containerRect.width <= 0 || containerRect.height <= 0) {
      throw new Error("ขนาดหน้าจอไม่พร้อม");
    }

    const scale = captureScale(containerRect, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(containerRect.width * scale));
    canvas.height = Math.max(1, Math.round(containerRect.height * scale));

    const context = canvas.getContext("2d", { alpha: false });

    return {
      canvas,
      drawFrame() {
        context.fillStyle = "#000000";
        context.fillRect(0, 0, canvas.width, canvas.height);

        drawElementCoveringContainer({ context, element: cameraVideo, containerRect, scale });
        drawElementCoveringContainer({ context, element: arCanvas, containerRect, scale });

        if (!canvasHasVisiblePixels(arCanvas)) {
          drawProjectedOverlayVideo({
            context,
            scene,
            overlayElement,
            overlayVideo,
            containerRect,
            scale
          });
        }
      },
      dispose() {}
    };
  }

  function chooseVideoMimeType() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    return VIDEO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function captureScale(containerRect, maxEdge) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const longestEdge = Math.max(containerRect.width, containerRect.height);
    return Math.min(dpr, maxEdge / longestEdge);
  }

  function drawElementCoveringContainer({ context, element, containerRect, scale }) {
    const rect = element.getBoundingClientRect();
    const dx = (rect.left - containerRect.left) * scale;
    const dy = (rect.top - containerRect.top) * scale;
    const dw = rect.width * scale;
    const dh = rect.height * scale;

    context.drawImage(element, dx, dy, dw, dh);
  }

  function canvasHasVisiblePixels(canvas) {
    const sample = document.createElement("canvas");
    sample.width = 64;
    sample.height = 64;
    const context = sample.getContext("2d");

    try {
      context.drawImage(canvas, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 8 && (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8)) {
          return true;
        }
      }
    } catch (error) {
      console.warn("Could not sample AR canvas; using projected overlay fallback", error);
    }

    return false;
  }

  function drawProjectedOverlayVideo({ context, scene, overlayElement, overlayVideo, containerRect, scale }) {
    if (!overlayElement || !overlayVideo || overlayVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }
    if (!window.THREE || !scene.camera) {
      return;
    }

    const width = Number(overlayElement.getAttribute("width"));
    const height = Number(overlayElement.getAttribute("height"));
    if (!width || !height) return;

    const object3D = overlayElement.object3D;
    object3D.updateWorldMatrix(true, false);
    scene.camera.updateMatrixWorld();
    scene.camera.updateProjectionMatrix();

    const corners = [
      projectCorner({ x: -width / 2, y: height / 2, object3D, camera: scene.camera, containerRect, scale }),
      projectCorner({ x: width / 2, y: height / 2, object3D, camera: scene.camera, containerRect, scale }),
      projectCorner({ x: -width / 2, y: -height / 2, object3D, camera: scene.camera, containerRect, scale })
    ];

    if (corners.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return;
    }

    const sourceWidth = overlayVideo.videoWidth || overlayVideo.clientWidth;
    const sourceHeight = overlayVideo.videoHeight || overlayVideo.clientHeight;
    if (!sourceWidth || !sourceHeight) return;

    context.save();
    context.setTransform(
      (corners[1].x - corners[0].x) / sourceWidth,
      (corners[1].y - corners[0].y) / sourceWidth,
      (corners[2].x - corners[0].x) / sourceHeight,
      (corners[2].y - corners[0].y) / sourceHeight,
      corners[0].x,
      corners[0].y
    );
    context.drawImage(overlayVideo, 0, 0, sourceWidth, sourceHeight);
    context.restore();
  }

  function projectCorner({ x, y, object3D, camera, containerRect, scale }) {
    const point = new window.THREE.Vector3(x, y, 0);
    point.applyMatrix4(object3D.matrixWorld);
    point.project(camera);

    return {
      x: ((point.x + 1) / 2) * containerRect.width * scale,
      y: ((-point.y + 1) / 2) * containerRect.height * scale
    };
  }

  function canvasToBlob(canvas, mimeType) {
    if (canvas.toBlob) {
      return new Promise((resolve) => canvas.toBlob(resolve, mimeType));
    }

    const dataUrl = canvas.toDataURL(mimeType);
    const binary = atob(dataUrl.split(",")[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return Promise.resolve(new Blob([bytes], { type: mimeType }));
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function mediaFileName(kind, extension) {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      pad2(now.getMonth() + 1),
      pad2(now.getDate()),
      "-",
      pad2(now.getHours()),
      pad2(now.getMinutes()),
      pad2(now.getSeconds())
    ].join("");
    return `ar-${kind}-${stamp}.${extension}`;
  }

  function formatDuration(seconds) {
    return `00:${pad2(seconds)}`;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function friendlyCaptureError(error, mode) {
    const message = error && error.message ? error.message : "ไม่ทราบสาเหตุ";
    const action = mode === "video" ? "อัดวิดีโอ" : "ถ่ายภาพ";
    return `${action}ไม่ได้: ${message} ลองขยับกล้องให้เห็น target ชัด ๆ แล้วลองใหม่`;
  }
})();
