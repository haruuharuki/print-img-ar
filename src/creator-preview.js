(function () {
  const config = window.AR_VIEWER_CONFIG;
  const scene = document.querySelector("a-scene");
  const shell = document.querySelector("#creatorShell");
  const startButton = document.querySelector("#creatorStartButton");
  const statusBox = document.querySelector("#creatorStatus");
  const panelToggle = document.querySelector("#panelToggle");
  const controlsRoot = document.querySelector("#overlayControls");
  const snippetBox = document.querySelector("#overlaySnippet");
  const deployConfigButton = document.querySelector("#deployConfigButton");
  const saveConfigButton = document.querySelector("#saveConfigButton");
  const downloadButton = document.querySelector("#downloadSnippetButton");
  const target = document.querySelector("#creatorImageTarget");
  const video = document.querySelector("#creatorArVideo");
  const overlay = target.querySelector("a-video");

  const initialPosition = parseVector(config.overlay.position);
  const initialRotation = parseVector(config.overlay.rotation);
  const baseOverlay = {
    width: Number(config.overlay.width),
    height: Number(config.overlay.height),
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
    `imageTargetSrc: ${config.target.src}; autoStart: false; uiScanning: yes; uiLoading: yes; uiError: yes;`
  );
  target.setAttribute("mindar-image-target", `targetIndex: ${config.target.index}`);

  video.src = config.video.src;
  video.loop = config.video.loop;
  video.muted = config.video.muted;
  video.playsInline = config.video.playsInline;
  video.toggleAttribute("loop", config.video.loop);
  video.toggleAttribute("muted", config.video.muted);
  video.toggleAttribute("playsinline", config.video.playsInline);
  video.toggleAttribute("webkit-playsinline", config.video.playsInline);

  statusBox.textContent = config.ui.initialText;
  startButton.textContent = config.ui.startButtonText;

  controls.forEach(createControl);
  applyOverlayState();

  startButton.addEventListener("click", async () => {
    try {
      await video.play();
      video.pause();
      video.currentTime = 0;

      const mindarSystem = scene.systems["mindar-image-system"];
      await mindarSystem.start();

      hasStarted = true;
      startButton.classList.add("hidden");
      statusBox.textContent = config.ui.scanningText;
    } catch (error) {
      console.error(error);
      statusBox.textContent = config.ui.errorText;
    }
  });

  panelToggle.addEventListener("click", () => {
    const isCollapsed = shell.classList.toggle("is-collapsed");
    panelToggle.textContent = isCollapsed ? "แผง" : "ยุบ";
    panelToggle.setAttribute("aria-expanded", String(!isCollapsed));
  });

  deployConfigButton.addEventListener("click", deployOverlayConfig);
  saveConfigButton.addEventListener("click", saveOverlayToConfigFile);

  downloadButton.addEventListener("click", () => {
    const blob = new Blob([buildOverlaySnippet()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "overlay-snippet.js";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  target.addEventListener("targetFound", async () => {
    statusBox.textContent = config.ui.foundText;
    if (!hasStarted || !config.video.autoplay) return;
    try {
      await video.play();
    } catch (error) {
      console.warn("Video play was blocked", error);
    }
  });

  target.addEventListener("targetLost", () => {
    statusBox.textContent = config.ui.lostText;
    video.pause();
  });

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

    row.append(range, number);
    group.append(label, row);
    controlsRoot.append(group);
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
    statusBox.textContent = "กำลัง Save & Deploy...";

    try {
      const response = await fetch("/api/deploy-overlay", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          overlay: getOverlayPayload(),
          baseOverlay,
          dryRun: false
        })
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Deploy failed.");
      }

      if (!result.changed) {
        statusBox.textContent = "ไม่มีค่าใหม่ให้ deploy";
        return;
      }

      statusBox.textContent = `Deploy แล้ว: ${result.commitSha.slice(0, 7)} Netlify กำลัง deploy`;
    } catch (error) {
      console.error(error);
      statusBox.textContent = `Deploy ไม่สำเร็จ: ${error.message}`;
    } finally {
      deployConfigButton.disabled = false;
      saveConfigButton.disabled = false;
    }
  }

  async function saveOverlayToConfigFile() {
    if (!window.showOpenFilePicker) {
      statusBox.textContent = "บราวเซอร์นี้ยัง Save ลงไฟล์ไม่ได้ ใช้ Chrome desktop หรือ Download แทน";
      return;
    }

    try {
      statusBox.textContent = "เลือกไฟล์ src/ar-config.js";
      const [fileHandle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "AR config JavaScript",
            accept: {
              "text/javascript": [".js"],
              "application/javascript": [".js"]
            }
          }
        ]
      });

      if (fileHandle.name !== "ar-config.js") {
        statusBox.textContent = "ยังไม่ได้บันทึก: กรุณาเลือกไฟล์ src/ar-config.js";
        return;
      }

      const file = await fileHandle.getFile();
      const configText = await file.text();
      const nextConfigText = replaceOverlayBlock(configText);
      const writable = await fileHandle.createWritable();
      await writable.write(nextConfigText);
      await writable.close();

      statusBox.textContent = "บันทึกลง ar-config.js แล้ว เปิดหน้า / เพื่อทดสอบค่าใหม่";
    } catch (error) {
      if (error.name === "AbortError") {
        statusBox.textContent = "ยกเลิกการเลือกไฟล์";
        return;
      }

      console.error(error);
      statusBox.textContent = "Save ไม่สำเร็จ: ใช้ Download แทนก่อน";
    }
  }

  function replaceOverlayBlock(configText) {
    const overlayPattern = /(\n)(\s*)overlay:\s*\{\s*\n[\s\S]*?\n\s*\}(\s*,)/;
    const match = configText.match(overlayPattern);

    if (!match) {
      throw new Error("Cannot find overlay block in config file.");
    }

    const indent = match[2];
    const nextOverlayBlock = [
      `${indent}overlay: {`,
      `${indent}  width: ${formatNumber(state.width)},`,
      `${indent}  height: ${formatNumber(state.height)},`,
      `${indent}  position: "${vectorToString(state.position)}",`,
      `${indent}  rotation: "${vectorToString(state.rotation)}"`,
      `${indent}}`
    ].join("\n");

    return configText.replace(overlayPattern, `$1${nextOverlayBlock}$3`);
  }

  function getOverlayPayload() {
    return {
      width: Number(formatNumber(state.width)),
      height: Number(formatNumber(state.height)),
      position: {
        x: Number(formatNumber(state.position.x)),
        y: Number(formatNumber(state.position.y)),
        z: Number(formatNumber(state.position.z))
      },
      rotation: {
        x: Number(formatNumber(state.rotation.x)),
        y: Number(formatNumber(state.rotation.y)),
        z: Number(formatNumber(state.rotation.z))
      }
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
})();
