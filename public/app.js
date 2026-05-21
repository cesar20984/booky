const PAUSE_MS = 2000;
const PAGE_SIZE = 20;

const tabApp = document.getElementById("tabApp");
const tabSettings = document.getElementById("tabSettings");
const viewApp = document.getElementById("viewApp");
const viewSettings = document.getElementById("viewSettings");

const projectSelect = document.getElementById("projectSelect");
const createProjectForm = document.getElementById("createProjectForm");
const newProjectInput = document.getElementById("newProjectInput");
const micButton = document.getElementById("micButton");
const statusText = document.getElementById("statusText");
const liveTranscript = document.getElementById("liveTranscript");
const photoInput = document.getElementById("photoInput");
const startCameraButton = document.getElementById("startCameraButton");
const capturePhotoButton = document.getElementById("capturePhotoButton");
const clearPhotosButton = document.getElementById("clearPhotosButton");
const cameraShell = document.getElementById("cameraShell");
const cameraPreview = document.getElementById("cameraPreview");
const photoQueueText = document.getElementById("photoQueueText");
const processPhotosButton = document.getElementById("processPhotosButton");
const photoStatus = document.getElementById("photoStatus");
const processPhotosCta = document.getElementById("processPhotosCta");
const processPhotosCtaText = document.getElementById("processPhotosCtaText");
const processPhotosCtaButton = document.getElementById("processPhotosCtaButton");
const fragmentsList = document.getElementById("fragmentsList");
const fragmentTemplate = document.getElementById("fragmentTemplate");
const inlineSummaryTemplate = document.getElementById("inlineSummaryTemplate");
const prevPageButton = document.getElementById("prevPageButton");
const nextPageButton = document.getElementById("nextPageButton");
const paginationText = document.getElementById("paginationText");

const modelSelect = document.getElementById("modelSelect");
const refreshModelsButton = document.getElementById("refreshModelsButton");
const ideaPromptInput = document.getElementById("ideaPromptInput");
const blockSummaryPromptInput = document.getElementById("blockSummaryPromptInput");
const imageExtractPromptInput = document.getElementById("imageExtractPromptInput");
const saveSettingsButton = document.getElementById("saveSettingsButton");
const settingsStatus = document.getElementById("settingsStatus");

let projects = [];
let selectedProjectId = "";
let fragments = [];
let summariesByBlock = new Map();
let fragmentsTotal = 0;
let currentPage = 1;
let totalPages = 1;
let selectedModel = "";
let settingsPrompts = { ideaPrompt: "", blockSummaryPrompt: "", imageExtractPrompt: "" };

let listening = false;
let recognition = null;
let pauseTimer = null;
let currentBuffer = "";
let interimBuffer = "";
let cameraStream = null;
let photoQueue = [];

let availableModels = [];
const textCache = new Map();

bootstrap();

async function bootstrap() {
  initSpeechRecognition();
  setActiveTab("app");
  await Promise.all([loadProjects(), loadSettings(), loadModels()]);
  updatePhotoQueueLabel();
  updatePhotoActions();
}

tabApp.addEventListener("click", () => setActiveTab("app"));
tabSettings.addEventListener("click", () => setActiveTab("settings"));

projectSelect.addEventListener("change", async () => {
  selectedProjectId = projectSelect.value;
  currentPage = 1;
  micButton.disabled = !selectedProjectId;

  if (!selectedProjectId) {
    stopListening();
    fragments = [];
    summariesByBlock = new Map();
    fragmentsTotal = 0;
    stopCamera();
    updatePhotoActions();
    renderFragments();
    updatePagination();
    setStatus("Selecciona o crea un proyecto para empezar.");
    return;
  }

  setStatus("Proyecto cambiado. Listo para escuchar.");
  await loadFragments();
});

createProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = newProjectInput.value.trim();
  if (!name) return;

  try {
    const payload = await fetchJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });

    newProjectInput.value = "";
    await loadProjects(payload.project.id);
    setStatus(`Proyecto "${payload.project.name}" creado.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

micButton.addEventListener("click", () => {
  if (!recognition) {
    setStatus("Tu navegador no soporta reconocimiento de voz.", true);
    return;
  }
  if (listening) stopListening();
  else startListening();
});

photoInput.addEventListener("change", () => {
  const count = photoInput.files?.length || 0;
  if (count > 0) {
    setPhotoStatus(`${count} archivo(s) listos para procesar.`);
  }
  updatePhotoActions();
});

processPhotosButton.addEventListener("click", async () => {
  const fallbackFiles = photoInput.files ? [...photoInput.files] : [];
  const files = photoQueue.length ? photoQueue : fallbackFiles;
  if (!selectedProjectId) {
    setPhotoStatus("Selecciona un proyecto primero.", true);
    return;
  }
  if (!files || !files.length) {
    setPhotoStatus("Selecciona una o mas fotos.", true);
    return;
  }

  try {
    setPhotoStatus(`Procesando 0/${files.length} foto(s)...`);
    processPhotosButton.disabled = true;
    hideProcessCta();
    stopCamera();

    let createdCount = 0;
    for (let i = 0; i < files.length; i += 1) {
      setPhotoStatus(`Procesando ${i + 1}/${files.length} foto(s)...`);
      const formData = new FormData();
      formData.append("photos", files[i]);

      const response = await fetch(`/api/projects/${selectedProjectId}/photos/analyze`, {
        method: "POST",
        body: formData
      });
      const payload = await safeReadJson(response);
      if (!response.ok) throw new Error(payload?.error || "No se pudieron procesar las fotos.");
      createdCount += Number(payload?.createdCount || 0);
    }

    photoQueue = [];
    updatePhotoQueueLabel();
    hideProcessCta();
    photoInput.value = "";
    setPhotoStatus(
      `Listo. Se agregaron ${createdCount} fragmento(s) desde fotos. Las imagenes no fueron guardadas.`
    );

    textCache.clear();
    currentPage = 1;
    await loadProjects(selectedProjectId);
    await loadFragments();
  } catch (error) {
    setPhotoStatus(error.message, true);
  } finally {
    updatePhotoActions();
  }
});

processPhotosCtaButton.addEventListener("click", async () => {
  processPhotosButton.click();
});

startCameraButton.addEventListener("click", async () => {
  if (cameraStream) {
    stopCamera();
    setPhotoStatus("Camara cerrada.");
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" }
      },
      audio: false
    });
    cameraPreview.srcObject = cameraStream;
    cameraShell.classList.remove("hidden");
    await requestCameraFullscreen();
    await tryLockPortraitOrientation();
    startCameraButton.textContent = "Cerrar camara";
    setPhotoStatus("Camara lista. Toma fotos en orden de pagina.");
  } catch (_error) {
    setPhotoStatus("No se pudo abrir la camara. Revisa permisos.", true);
  } finally {
    updatePhotoActions();
  }
});

capturePhotoButton.addEventListener("click", async () => {
  if (!cameraStream) {
    setPhotoStatus("Primero abre la camara.", true);
    return;
  }
  try {
    const blob = await captureFrameAsJpegBlob(cameraPreview);
    const file = new File([blob], `page-${photoQueue.length + 1}.jpg`, { type: "image/jpeg" });
    photoQueue.push(file);
    updatePhotoQueueLabel();
    showProcessCta();
    photoInput.value = "";
    setPhotoStatus(`Foto ${photoQueue.length} capturada.`);
  } catch (_error) {
    setPhotoStatus("No se pudo capturar la foto.", true);
  } finally {
    updatePhotoActions();
  }
});

clearPhotosButton.addEventListener("click", () => {
  photoQueue = [];
  photoInput.value = "";
  updatePhotoQueueLabel();
  hideProcessCta();
  updatePhotoActions();
  setPhotoStatus("Lote limpiado.");
});

prevPageButton.addEventListener("click", async () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  await loadFragments();
});

nextPageButton.addEventListener("click", async () => {
  if (currentPage >= totalPages) return;
  currentPage += 1;
  await loadFragments();
});

refreshModelsButton.addEventListener("click", async () => {
  await loadModels(true);
});

saveSettingsButton.addEventListener("click", async () => {
  const model = modelSelect.value;
  const ideaPrompt = ideaPromptInput.value.trim();
  const blockSummaryPrompt = blockSummaryPromptInput.value.trim();
  const imageExtractPrompt = imageExtractPromptInput.value.trim();
  if (!model) {
    setSettingsStatus("Selecciona un modelo.", true);
    return;
  }

  try {
    const payload = await fetchJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedModel: model,
        prompts: { ideaPrompt, blockSummaryPrompt, imageExtractPrompt }
      })
    });

    selectedModel = payload.selectedModel;
    settingsPrompts = payload.prompts;
    ideaPromptInput.value = settingsPrompts.ideaPrompt || "";
    blockSummaryPromptInput.value = settingsPrompts.blockSummaryPrompt || "";
    imageExtractPromptInput.value = settingsPrompts.imageExtractPrompt || "";
    renderModelSelection();
    setSettingsStatus("Settings guardados.");
  } catch (error) {
    setSettingsStatus(error.message, true);
  }
});

function setActiveTab(tabName) {
  const isApp = tabName === "app";
  tabApp.classList.toggle("active", isApp);
  tabSettings.classList.toggle("active", !isApp);
  viewApp.classList.toggle("active", isApp);
  viewSettings.classList.toggle("active", !isApp);
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.lang = "es-ES";
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (event) => {
    let finalText = "";
    interimBuffer = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += `${transcript} `;
      else interimBuffer += `${transcript} `;
    }

    if (finalText.trim()) {
      currentBuffer += `${finalText.trim()} `;
      schedulePauseFlush();
    }
    updateLiveTranscript();
  };

  recognition.onerror = (event) => {
    setStatus(`Error de reconocimiento: ${event.error}`, true);
  };

  recognition.onend = () => {
    if (listening) {
      recognition.start();
      return;
    }
    micButton.textContent = "Activar microfono";
  };
}

function startListening() {
  if (!selectedProjectId) {
    setStatus("Selecciona un proyecto primero.", true);
    return;
  }

  listening = true;
  micButton.textContent = "Detener microfono";
  setStatus("Escuchando... pausa mas de 2s para cerrar fragmento.");

  try {
    recognition.start();
  } catch (_error) {
    // Ignore repeated start race conditions.
  }
}

function stopListening() {
  listening = false;
  clearPauseTimer();
  void flushCurrentBuffer();
  interimBuffer = "";
  updateLiveTranscript();

  if (recognition) recognition.stop();
  micButton.textContent = "Activar microfono";
  setStatus("Microfono detenido.");
}

function schedulePauseFlush() {
  clearPauseTimer();
  pauseTimer = setTimeout(() => {
    void flushCurrentBuffer();
  }, PAUSE_MS);
}

function clearPauseTimer() {
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
}

async function flushCurrentBuffer() {
  const text = currentBuffer.trim();
  if (!text || !selectedProjectId) return;

  if (isDeleteCommand(text)) {
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/fragments/last`, {
        method: "DELETE"
      });
      if (response.status === 404) {
        setStatus("Comando 'Borrar' detectado, pero no habia fragmentos.");
      } else if (!response.ok) {
        const payload = await safeReadJson(response);
        throw new Error(payload?.error || "No se pudo borrar el ultimo fragmento.");
      } else {
        setStatus("Comando 'Borrar' detectado: se elimino el fragmento anterior.");
        textCache.clear();
        if (currentPage !== 1) currentPage = 1;
        await loadProjects(selectedProjectId);
        await loadFragments();
      }
    } catch (error) {
      setStatus(error.message, true);
    }

    currentBuffer = "";
    updateLiveTranscript();
    return;
  }

  currentBuffer = "";
  updateLiveTranscript();
  setStatus("Analizando fragmento con IA...");

  try {
    await fetchJson(`/api/projects/${selectedProjectId}/fragments/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    textCache.clear();
    currentPage = 1;
    await loadProjects(selectedProjectId);
    await loadFragments();
    setStatus("Fragmento guardado y analizado.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function updateLiveTranscript() {
  const text = `${currentBuffer}${interimBuffer}`.trim();
  liveTranscript.textContent = text || "...";
}

async function loadProjects(preferredProjectId = "") {
  try {
    const payload = await fetchJson("/api/projects");
    projects = payload.projects || [];
    renderProjectOptions();

    if (preferredProjectId) selectedProjectId = preferredProjectId;
    if (!selectedProjectId && projects.length) selectedProjectId = projects[0].id;
    if (!projects.find((project) => project.id === selectedProjectId)) {
      selectedProjectId = projects.length ? projects[0].id : "";
    }

    projectSelect.value = selectedProjectId;
    micButton.disabled = !selectedProjectId;
    updatePhotoActions();

    if (selectedProjectId) {
      await loadFragments();
      setStatus("Proyecto listo. Puedes activar el microfono.");
    } else {
      fragments = [];
      summariesByBlock = new Map();
      fragmentsTotal = 0;
      renderFragments();
      updatePagination();
      setStatus("Selecciona o crea un proyecto para empezar.");
    }
  } catch (error) {
    projects = [];
    selectedProjectId = "";
    micButton.disabled = true;
    renderProjectOptions();
    fragments = [];
    summariesByBlock = new Map();
    fragmentsTotal = 0;
    renderFragments();
    updatePagination();
    setStatus(error.message, true);
  }
}

async function loadFragments() {
  try {
    if (!selectedProjectId) {
      fragments = [];
      summariesByBlock = new Map();
      fragmentsTotal = 0;
      renderFragments();
      updatePagination();
      return;
    }

    const payload = await fetchJson(
      `/api/projects/${selectedProjectId}/fragments?page=${encodeURIComponent(currentPage)}`
    );

    fragments = payload.fragments || [];
    summariesByBlock = new Map((payload.summaries || []).map((item) => [item.blockNumber, item]));
    fragmentsTotal = payload.total || 0;
    currentPage = payload.page || 1;
    totalPages = payload.totalPages || 1;
    renderFragments();
    updatePagination();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderProjectOptions() {
  projectSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = projects.length ? "Selecciona un proyecto" : "No hay proyectos aun";
  projectSelect.appendChild(placeholder);

  projects.forEach((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.name} (${project.fragmentCount})`;
    projectSelect.appendChild(option);
  });
}

function renderFragments() {
  fragmentsList.innerHTML = "";

  if (!selectedProjectId) {
    fragmentsList.innerHTML = "<p class='status'>Aun no hay proyecto seleccionado.</p>";
    return;
  }

  if (!fragments.length) {
    fragmentsList.innerHTML = "<p class='status'>No hay ideas para esta pagina.</p>";
    return;
  }

  fragments.forEach((fragment, index) => {
    const node = fragmentTemplate.content.cloneNode(true);
    const time = node.querySelector(".fragment-time");
    const idea = node.querySelector(".fragment-idea");
    const toggleButton = node.querySelector(".fragment-toggle");
    const deleteButton = node.querySelector(".fragment-delete");
    const textBox = node.querySelector(".fragment-text-box");
    const textNode = node.querySelector(".fragment-text");

    time.textContent = formatTime(fragment.createdAt);
    idea.textContent = fragment.idea;
    if (fragment.status === "error") idea.classList.add("error");

    toggleButton.addEventListener("click", async () => {
      const isHidden = textBox.classList.contains("hidden");
      if (!isHidden) {
        textBox.classList.add("hidden");
        toggleButton.textContent = "Ver texto";
        return;
      }

      try {
        if (!textCache.has(fragment.id)) {
          textNode.textContent = "Cargando texto...";
          textBox.classList.remove("hidden");
          toggleButton.textContent = "Ocultar texto";
          const response = await fetch(`/api/fragments/${fragment.id}/text`);
          const payload = await safeReadJson(response);
          if (!response.ok) throw new Error(payload?.error || "No se pudo cargar texto.");
          textCache.set(fragment.id, payload.text || "");
        }

        textNode.classList.remove("error");
        textNode.textContent = textCache.get(fragment.id) || "(sin texto)";
        textBox.classList.remove("hidden");
        toggleButton.textContent = "Ocultar texto";
      } catch (error) {
        textNode.textContent = error.message;
        textNode.classList.add("error");
        textBox.classList.remove("hidden");
        toggleButton.textContent = "Ocultar texto";
      }
    });

    deleteButton.addEventListener("click", async () => {
      try {
        const response = await fetch(`/api/fragments/${fragment.id}`, { method: "DELETE" });
        if (!response.ok) {
          const payload = await safeReadJson(response);
          throw new Error(payload?.error || "No se pudo borrar fragmento.");
        }
        textCache.delete(fragment.id);
        await loadProjects(selectedProjectId);
        await loadFragments();
        setStatus("Fragmento borrado.");
      } catch (error) {
        setStatus(error.message, true);
      }
    });

    fragmentsList.appendChild(node);

    const descRank = (currentPage - 1) * PAGE_SIZE + index + 1;
    const ascPosition = fragmentsTotal - descRank + 1;
    if (ascPosition > 0 && ascPosition % 10 === 0) {
      const blockNumber = ascPosition / 10;
      const summary = summariesByBlock.get(blockNumber);
      if (summary) {
        const summaryNode = inlineSummaryTemplate.content.cloneNode(true);
        summaryNode.querySelector(".inline-summary-title").textContent =
          `Resumen de bloque ${blockNumber}`;
        summaryNode.querySelector(".inline-summary-text").textContent = summary.summary;
        fragmentsList.appendChild(summaryNode);
      }
    }
  });
}

function updatePagination() {
  paginationText.textContent = `Pagina ${currentPage} de ${totalPages}`;
  prevPageButton.disabled = currentPage <= 1;
  nextPageButton.disabled = currentPage >= totalPages;
}

async function loadSettings() {
  try {
    const payload = await fetchJson("/api/settings");
    selectedModel = payload.selectedModel || "";
    settingsPrompts = payload.prompts || {
      ideaPrompt: "",
      blockSummaryPrompt: "",
      imageExtractPrompt: ""
    };
    ideaPromptInput.value = settingsPrompts.ideaPrompt || "";
    blockSummaryPromptInput.value = settingsPrompts.blockSummaryPrompt || "";
    imageExtractPromptInput.value = settingsPrompts.imageExtractPrompt || "";
    renderModelSelection();
  } catch (error) {
    setSettingsStatus(error.message, true);
  }
}

async function loadModels(showMessage = false) {
  try {
    if (showMessage) setSettingsStatus("Cargando modelos...");
    const payload = await fetchJson("/api/models");
    availableModels = payload.models || [];
    renderModelSelection();
    if (showMessage) setSettingsStatus("Modelos actualizados.");
  } catch (error) {
    if (showMessage) setSettingsStatus(error.message, true);
    if (!availableModels.length) {
      modelSelect.innerHTML = "<option value=''>No disponible</option>";
    }
  }
}

function renderModelSelection() {
  modelSelect.innerHTML = "";
  if (!availableModels.length) {
    const option = document.createElement("option");
    option.value = selectedModel || "";
    option.textContent = selectedModel || "Sin modelos disponibles";
    modelSelect.appendChild(option);
    return;
  }

  availableModels.forEach((modelId) => {
    const option = document.createElement("option");
    option.value = modelId;
    option.textContent = modelId;
    modelSelect.appendChild(option);
  });

  if (selectedModel && availableModels.includes(selectedModel)) {
    modelSelect.value = selectedModel;
  } else {
    selectedModel = availableModels[0];
    modelSelect.value = selectedModel;
  }
}

function formatTime(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleString("es-CL", {
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function setStatus(text, isError = false) {
  statusText.textContent = text;
  statusText.classList.toggle("error", isError);
}

function setSettingsStatus(text, isError = false) {
  settingsStatus.textContent = text;
  settingsStatus.classList.toggle("error", isError);
}

function setPhotoStatus(text, isError = false) {
  photoStatus.textContent = text;
  photoStatus.classList.toggle("error", isError);
}

function updatePhotoActions() {
  const fallbackCount = photoInput.files?.length || 0;
  const totalQueued = photoQueue.length || fallbackCount;
  processPhotosButton.disabled = !selectedProjectId || totalQueued === 0;
  capturePhotoButton.disabled = !selectedProjectId || !cameraStream;
  clearPhotosButton.disabled = totalQueued === 0;
}

function updatePhotoQueueLabel() {
  photoQueueText.textContent = `${photoQueue.length} foto(s) en lote.`;
}

function stopCamera() {
  if (!cameraStream) return;
  for (const track of cameraStream.getTracks()) {
    track.stop();
  }
  cameraStream = null;
  cameraPreview.srcObject = null;
  cameraShell.classList.add("hidden");
  hideProcessCta();
  void unlockOrientation();
  void exitFullscreenIfAny();
  startCameraButton.textContent = "Abrir camara";
  updatePhotoActions();
}

function captureFrameAsJpegBlob(videoElement) {
  return new Promise((resolve, reject) => {
    const width = videoElement.videoWidth;
    const height = videoElement.videoHeight;
    if (!width || !height) {
      reject(new Error("Camera not ready"));
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Canvas context unavailable"));
      return;
    }
    ctx.drawImage(videoElement, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Blob capture failed"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      0.9
    );
  });
}

function showProcessCta() {
  const queued = photoQueue.length || photoInput.files?.length || 0;
  if (!queued || !cameraStream) return;
  processPhotosCtaText.textContent = `${queued} foto(s) listas. Procesa ahora.`;
  processPhotosCta.classList.remove("hidden");
}

function hideProcessCta() {
  processPhotosCta.classList.add("hidden");
}

async function requestCameraFullscreen() {
  try {
    if (!cameraShell.requestFullscreen) return;
    if (!document.fullscreenElement) {
      await cameraShell.requestFullscreen();
    }
  } catch (_error) {
    // Not all iOS browsers support/allow fullscreen.
  }
}

async function exitFullscreenIfAny() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen();
    }
  } catch (_error) {
    // Ignore unsupported cases.
  }
}

async function tryLockPortraitOrientation() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock("portrait");
    }
  } catch (_error) {
    // iOS Safari usually blocks this; keep layout portrait as fallback.
  }
}

async function unlockOrientation() {
  try {
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }
  } catch (_error) {
    // Ignore unsupported cases.
  }
}

function isDeleteCommand(text) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "");
  return normalized === "borrar";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await safeReadJson(response);
  if (!response.ok) {
    throw new Error(payload?.error || `Error HTTP ${response.status}`);
  }
  return payload || {};
}

async function safeReadJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
      throw new Error(
        "El servidor devolvio HTML en vez de JSON. Reinicia Booky con 'npm run dev' para cargar la version nueva del backend."
      );
    }
    return null;
  }

  try {
    return await response.json();
  } catch (_error) {
    throw new Error("Respuesta JSON invalida del servidor.");
  }
}
