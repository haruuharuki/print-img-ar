(function () {
  const MAX_CAPTURE_EDGE = 1920;

  window.ARCapture = {
    init
  };

  function init({ scene, statusBox, overlayElement, overlayVideo }) {
    const captureButton = document.querySelector("#captureButton");
    const preview = document.querySelector("#capturePreview");
    const previewImage = document.querySelector("#captureImage");
    const shareButton = document.querySelector("#shareCaptureButton");
    const downloadButton = document.querySelector("#downloadCaptureButton");
    const closeButton = document.querySelector("#closeCaptureButton");

    let hasStarted = false;
    let hasVisibleTarget = false;
    let captureBlob = null;
    let captureUrl = null;

    captureButton.addEventListener("click", async () => {
      if (!hasVisibleTarget) {
        statusBox.textContent = "ยังไม่เจอ AR overlay สำหรับถ่ายภาพ";
        updateShutterState();
        return;
      }

      captureButton.disabled = true;
      try {
        const blob = await captureScene({ scene, overlayElement, overlayVideo });
        showPreview(blob);
        statusBox.textContent = "ถ่ายภาพแล้ว";
      } catch (error) {
        console.error(error);
        statusBox.textContent = `ถ่ายภาพไม่ได้: ${error.message}`;
      } finally {
        updateShutterState();
      }
    });

    shareButton.addEventListener("click", async () => {
      if (!captureBlob) return;
      const file = new File([captureBlob], captureFileName(), { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({
            files: [file],
            title: "AR capture"
          });
          return;
        } catch (error) {
          if (error.name === "AbortError") return;
          console.warn("Share failed, falling back to download", error);
        }
      }

      downloadBlob(captureBlob);
    });

    downloadButton.addEventListener("click", () => {
      if (captureBlob) downloadBlob(captureBlob);
    });

    closeButton.addEventListener("click", hidePreview);

    function setStarted(value) {
      hasStarted = value;
      captureButton.classList.toggle("hidden", !hasStarted);
      updateShutterState();
    }

    function setTargetVisible(value) {
      hasVisibleTarget = value;
      updateShutterState();
    }

    function updateShutterState() {
      captureButton.disabled = !hasStarted || !hasVisibleTarget;
    }

    function showPreview(blob) {
      revokeCaptureUrl();
      captureBlob = blob;
      captureUrl = URL.createObjectURL(blob);
      previewImage.src = captureUrl;
      preview.classList.remove("hidden");

      const file = new File([blob], captureFileName(), { type: "image/png" });
      const canShareFiles = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
      shareButton.classList.toggle("hidden", !canShareFiles);
    }

    function hidePreview() {
      preview.classList.add("hidden");
      previewImage.removeAttribute("src");
      captureBlob = null;
      revokeCaptureUrl();
    }

    function revokeCaptureUrl() {
      if (captureUrl) {
        URL.revokeObjectURL(captureUrl);
        captureUrl = null;
      }
    }

    return {
      setStarted,
      setTargetVisible
    };
  }

  async function captureScene({ scene, overlayElement, overlayVideo }) {
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

    const scale = captureScale(containerRect);
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = Math.max(1, Math.round(containerRect.width * scale));
    outputCanvas.height = Math.max(1, Math.round(containerRect.height * scale));

    const context = outputCanvas.getContext("2d", { alpha: false });
    context.fillStyle = "#000000";
    context.fillRect(0, 0, outputCanvas.width, outputCanvas.height);

    drawElementCoveringContainer({
      context,
      element: cameraVideo,
      containerRect,
      scale
    });

    drawElementCoveringContainer({
      context,
      element: arCanvas,
      containerRect,
      scale
    });

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

    const blob = await canvasToPngBlob(outputCanvas);
    if (!blob) {
      throw new Error("browser ไม่สามารถสร้าง PNG ได้");
    }
    return blob;
  }

  function captureScale(containerRect) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const longestEdge = Math.max(containerRect.width, containerRect.height);
    return Math.min(dpr, MAX_CAPTURE_EDGE / longestEdge);
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

  function canvasToPngBlob(canvas) {
    if (canvas.toBlob) {
      return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    const dataUrl = canvas.toDataURL("image/png");
    const binary = atob(dataUrl.split(",")[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return Promise.resolve(new Blob([bytes], { type: "image/png" }));
  }

  function downloadBlob(blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = captureFileName();
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function captureFileName() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `ar-capture-${stamp}.png`;
  }
})();
